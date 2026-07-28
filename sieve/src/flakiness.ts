/**
 * Per-test flakiness from **corpus** result outcomes.
 *
 * Only runs with `baseline_run_id IS NULL` count (full `run-full` / corpus
 * jobs). Diff-aware UI shards are omitted — they are a selected subset and
 * would paint every re-selected failure as flaky.
 *
 * A test is **flaky** when it both passed and failed in that history.
 * `flakeScore` is the fail share (0..1) among resolved outcomes, used to
 * deprioritize when the toggle is on.
 */

import type pg from "pg";

export type FlakeStats = {
  attempts: number;
  passes: number;
  fails: number;
  flips: number;
  /** True when both pass and fail were observed. */
  flaky: boolean;
  /** Fail share fails/(passes+fails); 0 when never failed. */
  failRate: number;
  /**
   * Score used for density deprioritization: failRate when flaky, else 0.
   */
  flakeScore: number;
};

/** How hard deprioritization multiplies density: weight = 1 - penalty * score. */
export const FLAKE_PENALTY = 0.9;

export function flakeScoreFromCounts(opts: {
  passes: number;
  fails: number;
  flips?: number;
  attempts?: number;
}): FlakeStats {
  const passes = Math.max(0, opts.passes);
  const fails = Math.max(0, opts.fails);
  const attempts = opts.attempts ?? passes + fails;
  const flips = opts.flips ?? 0;
  const resolved = passes + fails;
  const flaky = passes > 0 && fails > 0;
  const failRate = resolved > 0 ? fails / resolved : 0;
  const flakeScore = flaky ? failRate : 0;
  return {
    attempts,
    passes,
    fails,
    flips,
    flaky,
    failRate,
    flakeScore,
  };
}

/** Density weight in (1 - FLAKE_PENALTY) .. 1 when deprioritizing. */
export function flakeDensityWeight(flakeScore: number): number {
  const score = Math.min(1, Math.max(0, flakeScore));
  return 1 - FLAKE_PENALTY * score;
}

/**
 * Load historical flake stats from finished corpus runs only.
 */
export async function loadFlakeStats(
  client: pg.PoolClient,
  testIds?: string[],
): Promise<Map<string, FlakeStats>> {
  const params: unknown[] = [];
  let testFilter = "";
  if (testIds && testIds.length > 0) {
    params.push(testIds);
    testFilter = `AND tr.test_id = ANY ($1::text[])`;
  }

  const rows = await client.query<{
    test_id: string;
    attempts: string;
    passes: string;
    fails: string;
    flips: string;
  }>(
    `WITH outcomes AS (
       SELECT tr.test_id, tr.status, r.finished_at, tr.received_at
       FROM test_results tr
       JOIN runs r ON r.id = tr.run_id
         AND r.status IN ('done', 'failed')
         -- Corpus / mainline only — not diff-aware UI shards.
         AND r.baseline_run_id IS NULL
       JOIN job_attempts ja ON ja.id = tr.attempt_id
         AND ja.status IN ('done', 'failed')
       WHERE tr.status IN ('passed', 'failed', 'timedOut')
         ${testFilter}
     ),
     ordered AS (
       SELECT test_id, status,
         lag(status) OVER (
           PARTITION BY test_id
           ORDER BY finished_at NULLS LAST, received_at
         ) AS prev
       FROM outcomes
     )
     SELECT test_id,
       count(*)::text AS attempts,
       count(*) FILTER (WHERE status = 'passed')::text AS passes,
       count(*) FILTER (WHERE status IN ('failed', 'timedOut'))::text AS fails,
       count(*) FILTER (
         WHERE prev IS NOT NULL AND prev IS DISTINCT FROM status
       )::text AS flips
     FROM ordered
     GROUP BY test_id`,
    params,
  );

  const out = new Map<string, FlakeStats>();
  for (const row of rows.rows) {
    out.set(
      row.test_id,
      flakeScoreFromCounts({
        attempts: Number(row.attempts),
        passes: Number(row.passes),
        fails: Number(row.fails),
        flips: Number(row.flips),
      }),
    );
  }
  return out;
}
