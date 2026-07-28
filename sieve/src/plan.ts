/**
 * Diff-aware plan: latest-run test set + last-green coverage → selectTests
 * → contiguous packShards.
 */

import type pg from "pg";
import { parseDiffLines, selectTests } from "../../tests/coverage-select.ts";
import { loadDiffCoverageIndex } from "./coverage-hits.ts";
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
};

export type PlanTestRow = {
  testId: string;
  source: string;
  titlePath: string;
  durationMs: number;
  /** Set when included in the budgeted selection; null when greyed out. */
  shardIndex: number | null;
  selected: boolean;
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

  const latest = await client.query<{ id: string }>(
    `SELECT r.id
     FROM runs r
     WHERE r.status IN ('done', 'failed')
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

  const corpusSize = rows.length;
  const selectedTestIds = selectTests({
    index,
    durations,
    diff: opts.diff,
    budgetMs: opts.budgetMs,
    corpusSize,
  });
  const packed = packShards(selectedTestIds, durations, shardCount);

  const shardOf = new Map<string, number>();
  const shards: PlanDiffResult["shards"] = [];
  for (let i = 0; i < packed.length; i++) {
    const testIds = packed[i]!;
    let durationMs = 0;
    for (const id of testIds) {
      shardOf.set(id, i);
      durationMs += durations[id] ?? 1;
    }
    shards.push({ shardIndex: i, testIds, durationMs });
  }

  const rowFor = (
    testId: string,
    selected: boolean,
    shardIndex: number | null,
  ): PlanTestRow => ({
    testId,
    source: sourceById[testId] ?? "",
    titlePath: titlePathById[testId] ?? "",
    durationMs: durations[testId] ?? 1,
    shardIndex,
    selected,
  });

  const selectedSet = new Set(selectedTestIds);
  const selected: PlanTestRow[] = selectedTestIds.map((testId) =>
    rowFor(testId, true, shardOf.get(testId) ?? 0),
  );

  // Diff-affected only: greedy rank under an unlimited budget. Budget then
  // flips `selected` / shardIndex — no unrelated corpus filler rows.
  const totalDur = rows.reduce((s, r) => s + (r.durationMs > 0 ? r.durationMs : 1), 0);
  const rankedRelevant = selectTests({
    index,
    durations,
    diff: opts.diff,
    budgetMs: Math.max(totalDur, opts.budgetMs) + 1,
    corpusSize,
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
  };
}
