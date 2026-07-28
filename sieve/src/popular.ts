/**
 * “Popular” tests: failed at least once anywhere in the live sieve DB
 * (corpus + diff-aware), excluding corpus flakes.
 *
 * Flaky tests (pass+fail on corpus) are owned by the flakiness signal so
 * intermittent noise does not look like a reliable failure hotspot.
 */

import type pg from "pg";
import { loadFlakeStats, type FlakeStats } from "./flakiness.ts";

export type PopularStats = {
  attempts: number;
  fails: number;
  popular: boolean;
};

/** Density multiplier when Prefer popular is on. */
export const POPULAR_BOOST = 10;

export function popularFromCounts(opts: {
  fails: number;
  attempts?: number;
  /** When true, never mark popular — flakes are a separate signal. */
  flaky?: boolean;
}): PopularStats {
  const fails = Math.max(0, opts.fails);
  const attempts = opts.attempts ?? fails;
  const flaky = opts.flaky === true;
  return {
    attempts,
    fails,
    popular: fails > 0 && !flaky,
  };
}

/**
 * Load popular stats from all finished runs (no baseline_run_id filter).
 * Corpus-flaky tests are excluded from `popular` (see `flaky` on flake stats).
 *
 * Pass `flakeById` when the caller already loaded flake stats to avoid a
 * second query; otherwise flakes are loaded here.
 */
export async function loadPopularStats(
  client: pg.PoolClient,
  testIds?: string[],
  flakeById?: Map<string, Pick<FlakeStats, "flaky">>,
): Promise<Map<string, PopularStats>> {
  const params: unknown[] = [];
  let testFilter = "";
  if (testIds && testIds.length > 0) {
    params.push(testIds);
    testFilter = `AND tr.test_id = ANY ($1::text[])`;
  }

  const rows = await client.query<{
    test_id: string;
    attempts: string;
    fails: string;
  }>(
    `SELECT tr.test_id,
       count(*)::text AS attempts,
       count(*) FILTER (
         WHERE tr.status IN ('failed', 'timedOut')
       )::text AS fails
     FROM test_results tr
     JOIN runs r ON r.id = tr.run_id
       AND r.status IN ('done', 'failed')
     JOIN job_attempts ja ON ja.id = tr.attempt_id
       AND ja.status IN ('done', 'failed')
     WHERE tr.status IN ('passed', 'failed', 'timedOut')
       ${testFilter}
     GROUP BY tr.test_id`,
    params,
  );

  const flakes = flakeById ?? (await loadFlakeStats(client, testIds));

  const out = new Map<string, PopularStats>();
  for (const row of rows.rows) {
    out.set(
      row.test_id,
      popularFromCounts({
        attempts: Number(row.attempts),
        fails: Number(row.fails),
        flaky: flakes.get(row.test_id)?.flaky ?? false,
      }),
    );
  }
  return out;
}
