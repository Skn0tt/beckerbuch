/**
 * Full-DB inventory of popular + flaky tests for the Signals UI tab.
 */

import type pg from "pg";
import { loadFlakeStats } from "./flakiness.ts";
import {
  loadBaselineCorpus,
  resolveBaselineRunId,
  type CorpusRow,
} from "./plan.ts";
import { loadPopularStats } from "./popular.ts";
import { SchedulerRequestError } from "./errors.ts";

export type SignalPopularRow = {
  testId: string;
  titlePath: string;
  source: string;
  durationMs: number;
  popularFails: number;
  attempts: number;
};

export type SignalFlakyRow = {
  testId: string;
  titlePath: string;
  source: string;
  durationMs: number;
  passes: number;
  fails: number;
  flips: number;
  flipRate: number;
  flakeScore: number;
  attempts: number;
};

export type SignalsResult = {
  popular: SignalPopularRow[];
  flaky: SignalFlakyRow[];
};

function rosterById(rows: CorpusRow[]): Map<string, CorpusRow> {
  const map = new Map<string, CorpusRow>();
  for (const r of rows) map.set(r.testId, r);
  return map;
}

function labelKey(titlePath: string, source: string, testId: string): string {
  return (titlePath || source || testId).toLowerCase();
}

/**
 * Popular (DB fail, excluding corpus flakes) + flaky (corpus pass+fail),
 * with labels/durations from the latest finished corpus run when available.
 */
export async function loadSignals(
  client: pg.PoolClient,
): Promise<SignalsResult> {
  let roster = new Map<string, CorpusRow>();
  try {
    const baselineRunId = await resolveBaselineRunId(client, undefined);
    const { rows } = await loadBaselineCorpus(client, baselineRunId);
    roster = rosterById(rows);
  } catch (err) {
    if (
      !(err instanceof SchedulerRequestError) ||
      (err.code !== "no_baseline_run" && err.code !== "baseline_run_empty")
    ) {
      throw err;
    }
  }

  // Flakes first so popular can exclude them without a second flake query.
  const flakeById = await loadFlakeStats(client);
  const popularById = await loadPopularStats(client, undefined, flakeById);

  const popular: SignalPopularRow[] = [];
  for (const [testId, stats] of popularById) {
    if (!stats.popular) continue;
    const meta = roster.get(testId);
    popular.push({
      testId,
      titlePath: meta?.titlePath ?? "",
      source: meta?.source ?? "",
      durationMs: meta?.durationMs ?? 0,
      popularFails: stats.fails,
      attempts: stats.attempts,
    });
  }
  popular.sort((a, b) => {
    if (b.popularFails !== a.popularFails) return b.popularFails - a.popularFails;
    return labelKey(a.titlePath, a.source, a.testId).localeCompare(
      labelKey(b.titlePath, b.source, b.testId),
    );
  });

  const flaky: SignalFlakyRow[] = [];
  for (const [testId, stats] of flakeById) {
    if (!stats.flaky) continue;
    const meta = roster.get(testId);
    flaky.push({
      testId,
      titlePath: meta?.titlePath ?? "",
      source: meta?.source ?? "",
      durationMs: meta?.durationMs ?? 0,
      passes: stats.passes,
      fails: stats.fails,
      flips: stats.flips,
      flipRate: stats.flipRate,
      flakeScore: stats.flakeScore,
      attempts: stats.attempts,
    });
  }
  flaky.sort((a, b) => {
    if (b.flakeScore !== a.flakeScore) return b.flakeScore - a.flakeScore;
    return labelKey(a.titlePath, a.source, a.testId).localeCompare(
      labelKey(b.titlePath, b.source, b.testId),
    );
  });

  return { popular, flaky };
}
