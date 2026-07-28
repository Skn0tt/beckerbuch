/**
 * Diff-aware plan: latest-run test set + last-green coverage → selectTests
 * → contiguous packShards.
 */

import type pg from "pg";
import { parseDiffLines, selectTests } from "../../tests/coverage-select.ts";
import { loadDiffCoverageIndex } from "./coverage-hits.ts";
import { loadFlakeStats } from "./flakiness.ts";
import { loadPopularStats, POPULAR_BOOST } from "./popular.ts";
import { packShards } from "./pack.ts";
import { SchedulerRequestError } from "./errors.ts";

export type CorpusRow = {
  testId: string;
  source: string;
  titlePath: string;
  durationMs: number;
};

export type PlanDiffOpts = {
  diff: string;
  budgetMs: number;
  shardCount: number;
  baselineRunId?: string;
  /** When true, lower selection density for historically flaky tests. */
  deprioritizeFlakes?: boolean;
  /** When true, strongly boost non-flaky tests that failed in the DB. */
  preferPopular?: boolean;
};

export type PlanTestRow = {
  testId: string;
  source: string;
  titlePath: string;
  durationMs: number;
  /** Set when included in the budgeted selection; null when greyed out. */
  shardIndex: number | null;
  selected: boolean;
  /** Observed pass+fail across finished corpus runs. */
  flaky: boolean;
  /** Flip rate among corpus outcomes; drives deprioritize when flaky. */
  flakeScore: number;
  failRate: number;
  flipRate: number;
  flips: number;
  passes: number;
  fails: number;
  attempts: number;
  /** Failed in DB history and not a corpus flake. */
  popular: boolean;
  /** Fail count across the whole DB (popular window). */
  popularFails: number;
};

export type PlanDiffResult = {
  baselineRunId: string;
  diffLineCount: number;
  selectedTestIds: string[];
  /** Budgeted selection (same order as selectTests). */
  selected: PlanTestRow[];
  /**
   * Diff-affected tests only (greedy rank order). Budget flips `selected`;
   * beyond-budget rows stay in the list dimmed. Unrelated corpus tests omitted.
   */
  tests: PlanTestRow[];
  shards: Array<{ shardIndex: number; testIds: string[]; durationMs: number }>;
  deprioritizeFlakes: boolean;
  preferPopular: boolean;
};

export async function resolveBaselineRunId(
  client: pg.PoolClient,
  baselineRunId: string | undefined,
): Promise<string> {
  if (baselineRunId) {
    const exists = await client.query(`SELECT 1 FROM runs WHERE id = $1::uuid`, [
      baselineRunId,
    ]);
    if (!exists.rowCount) {
      throw new SchedulerRequestError(404, "baseline_run_not_found");
    }
    return baselineRunId;
  }

  // Corpus runs only: diff-aware UI/shard runs set baseline_run_id and are
  // a selected subset — using them as the roster shrinks planning to that
  // subset on the next plan.
  const latest = await client.query<{ id: string }>(
    `SELECT r.id
     FROM runs r
     WHERE r.status IN ('done', 'failed')
       AND r.baseline_run_id IS NULL
       AND EXISTS (SELECT 1 FROM test_results tr WHERE tr.run_id = r.id)
     ORDER BY r.finished_at DESC NULLS LAST, r.created_at DESC
     LIMIT 1`,
    [],
  );
  if (!latest.rowCount) {
    throw new SchedulerRequestError(400, "no_baseline_run");
  }
  return latest.rows[0]!.id;
}

export async function loadBaselineCorpus(
  client: pg.PoolClient,
  baselineRunId: string,
): Promise<{ rows: CorpusRow[] }> {
  const corpus = await client.query<{
    test_id: string;
    source: string;
    title_path: string;
    duration_ms: number;
  }>(
    `SELECT DISTINCT ON (test_id)
       test_id, source, title_path, duration_ms
     FROM test_results tr
     JOIN job_attempts ja ON ja.id = tr.attempt_id
       AND ja.status IN ('done', 'failed')
     WHERE tr.run_id = $1::uuid
     ORDER BY test_id, tr.received_at DESC`,
    [baselineRunId],
  );
  if (corpus.rowCount === 0) {
    throw new SchedulerRequestError(400, "baseline_run_empty");
  }
  return {
    rows: corpus.rows.map((r) => ({
      testId: r.test_id,
      source: r.source ?? "",
      titlePath: r.title_path ?? "",
      durationMs: r.duration_ms,
    })),
  };
}

export async function planDiffRun(
  client: pg.PoolClient,
  opts: PlanDiffOpts,
): Promise<PlanDiffResult> {
  if (!(opts.budgetMs > 0)) {
    throw new SchedulerRequestError(400, "invalid_budget");
  }
  const shardCount = Math.floor(opts.shardCount);
  if (!(shardCount >= 1)) {
    throw new SchedulerRequestError(400, "invalid_shard_count");
  }

  const baselineRunId = await resolveBaselineRunId(client, opts.baselineRunId);
  // Test roster + durations from the baseline (latest) run; coverage lines
  // come from each test's last green result across history.
  const { rows } = await loadBaselineCorpus(client, baselineRunId);
  const index = await loadDiffCoverageIndex(client, {
    corpusTestIds: rows.map((r) => r.testId),
    diff: opts.diff,
  });
  const durations: Record<string, number> = {};
  const sourceById: Record<string, string> = {};
  const titlePathById: Record<string, string> = {};
  for (const r of rows) {
    durations[r.testId] = r.durationMs;
    sourceById[r.testId] = r.source;
    titlePathById[r.testId] = r.titlePath;
  }

  const testIds = rows.map((r) => r.testId);
  const flakeById = await loadFlakeStats(client, testIds);
  const flakeScores: Record<string, number> = {};
  for (const [id, stats] of flakeById) {
    flakeScores[id] = stats.flakeScore;
  }

  const popularById = await loadPopularStats(client, testIds, flakeById);
  const popularTestIds = new Set<string>();
  for (const [id, stats] of popularById) {
    if (stats.popular) popularTestIds.add(id);
  }

  const deprioritizeFlakes = opts.deprioritizeFlakes === true;
  const preferPopular = opts.preferPopular === true;
  const corpusSize = rows.length;
  const selectOpts = {
    index,
    durations,
    diff: opts.diff,
    corpusSize,
    flakeScores,
    deprioritizeFlakes,
    popularTestIds,
    preferPopular,
    popularBoost: POPULAR_BOOST,
  };
  const selectedTestIds = selectTests({
    ...selectOpts,
    budgetMs: opts.budgetMs,
  });
  const packed = packShards(selectedTestIds, durations, shardCount);

  const shardOf = new Map<string, number>();
  const shards: PlanDiffResult["shards"] = [];
  for (let i = 0; i < packed.length; i++) {
    const testIdsShard = packed[i]!;
    let durationMs = 0;
    for (const id of testIdsShard) {
      shardOf.set(id, i);
      durationMs += durations[id] ?? 1;
    }
    shards.push({ shardIndex: i, testIds: testIdsShard, durationMs });
  }

  const rowFor = (
    testId: string,
    selected: boolean,
    shardIndex: number | null,
  ): PlanTestRow => {
    const flake = flakeById.get(testId);
    const popular = popularById.get(testId);
    return {
      testId,
      source: sourceById[testId] ?? "",
      titlePath: titlePathById[testId] ?? "",
      durationMs: durations[testId] ?? 1,
      shardIndex,
      selected,
      flaky: flake?.flaky ?? false,
      flakeScore: flake?.flakeScore ?? 0,
      failRate: flake?.failRate ?? 0,
      flipRate: flake?.flipRate ?? 0,
      flips: flake?.flips ?? 0,
      passes: flake?.passes ?? 0,
      fails: flake?.fails ?? 0,
      attempts: flake?.attempts ?? 0,
      popular: popular?.popular ?? false,
      popularFails: popular?.fails ?? 0,
    };
  };

  const selectedSet = new Set(selectedTestIds);
  const selected: PlanTestRow[] = selectedTestIds.map((testId) =>
    rowFor(testId, true, shardOf.get(testId) ?? 0),
  );

  // Diff-affected only: greedy rank under an unlimited budget. Budget then
  // flips `selected` / shardIndex — no unrelated corpus filler rows.
  const totalDur = rows.reduce((s, r) => s + (r.durationMs > 0 ? r.durationMs : 1), 0);
  const rankedRelevant = selectTests({
    ...selectOpts,
    budgetMs: Math.max(totalDur, opts.budgetMs) + 1,
  });
  const tests: PlanTestRow[] = rankedRelevant.map((testId) => {
    const inBudget = selectedSet.has(testId);
    return rowFor(
      testId,
      inBudget,
      inBudget ? (shardOf.get(testId) ?? 0) : null,
    );
  });

  return {
    baselineRunId,
    diffLineCount: parseDiffLines(opts.diff).size,
    selectedTestIds,
    selected,
    tests,
    shards,
    deprioritizeFlakes,
    preferPopular,
  };
}
