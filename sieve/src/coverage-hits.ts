/**
 * Inverted coverage index helpers (`coverage_hits`).
 *
 * Selection only needs tests that hit the (usually tiny) diff line set —
 * never the full per-test hit lists.
 */

import type pg from "pg";
import {
  buildIndexFromHitLines,
  lineKey,
  parseDiffLines,
  parseLineKey,
  type CoverageIndex,
} from "../../tests/coverage-select.ts";

export type ParsedHit = { file: string; line: number };

/** Parse protocol `hitLines` (`file:line`) into file/line pairs; drop junk. */
export function parseHitLines(hitLines: Iterable<string>): ParsedHit[] {
  const out: ParsedHit[] = [];
  for (const raw of hitLines) {
    const parsed = parseLineKey(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Replace all coverage rows for one (run, test). Empty `hits` clears.
 * Call inside an open transaction with the matching `test_results` upsert.
 */
export async function replaceCoverageHits(
  client: pg.PoolClient,
  opts: {
    runId: string;
    testId: string;
    hits: ParsedHit[];
  },
): Promise<void> {
  await client.query(
    `DELETE FROM coverage_hits WHERE run_id = $1::uuid AND test_id = $2`,
    [opts.runId, opts.testId],
  );
  if (opts.hits.length === 0) return;

  const files = opts.hits.map((h) => h.file);
  const lines = opts.hits.map((h) => h.line);
  await client.query(
    `INSERT INTO coverage_hits (run_id, test_id, file_path, line)
     SELECT $1::uuid, $2, f, l
     FROM unnest($3::text[], $4::int[]) AS t(f, l)
     ON CONFLICT DO NOTHING`,
    [opts.runId, opts.testId, files, lines],
  );
}

/**
 * Sparse coverage index for a corpus of test ids: only lines present in
 * `diff`, sourced from each test's **last passed** run (falls back to the
 * latest finished attempt if a test has never passed).
 *
 * Pass `corpusSize` into `selectTests` separately (typically
 * `corpusTestIds.length`).
 */
export async function loadDiffCoverageIndex(
  client: pg.PoolClient,
  opts: { corpusTestIds: string[]; diff: string },
): Promise<CoverageIndex> {
  const { corpusTestIds, diff } = opts;
  const diffLines = parseDiffLines(diff);
  if (diffLines.size === 0 || corpusTestIds.length === 0) {
    return buildIndexFromHitLines([]);
  }

  const files: string[] = [];
  const lines: number[] = [];
  for (const key of diffLines) {
    const parsed = parseLineKey(key);
    if (!parsed) continue;
    files.push(parsed.file);
    lines.push(parsed.line);
  }
  if (files.length === 0) {
    return buildIndexFromHitLines([]);
  }

  // Per corpus test: prefer last passed run that still has coverage rows;
  // else last finished attempt (may yield empty hits for brand-new failures).
  const hits = await client.query<{
    file_path: string;
    line: number;
    test_id: string;
  }>(
    `WITH last_green AS (
       SELECT DISTINCT ON (tr.test_id)
         tr.test_id, tr.run_id
       FROM test_results tr
       JOIN job_attempts ja ON ja.id = tr.attempt_id
         AND ja.status IN ('done', 'failed')
       WHERE tr.test_id = ANY ($1::text[])
         AND tr.status = 'passed'
         AND EXISTS (
           SELECT 1 FROM coverage_hits ch
           WHERE ch.run_id = tr.run_id AND ch.test_id = tr.test_id
         )
       ORDER BY tr.test_id, tr.received_at DESC
     ),
     last_any AS (
       SELECT DISTINCT ON (tr.test_id)
         tr.test_id, tr.run_id
       FROM test_results tr
       JOIN job_attempts ja ON ja.id = tr.attempt_id
         AND ja.status IN ('done', 'failed')
       WHERE tr.test_id = ANY ($1::text[])
         AND tr.status <> 'running'
         AND NOT EXISTS (
           SELECT 1 FROM last_green g WHERE g.test_id = tr.test_id
         )
       ORDER BY tr.test_id, tr.received_at DESC
     ),
     source AS (
       SELECT test_id, run_id FROM last_green
       UNION ALL
       SELECT test_id, run_id FROM last_any
     )
     SELECT ch.file_path, ch.line, ch.test_id
     FROM coverage_hits ch
     JOIN source s ON s.test_id = ch.test_id AND s.run_id = ch.run_id
     JOIN unnest($2::text[], $3::int[]) AS d(file_path, line)
       ON ch.file_path = d.file_path AND ch.line = d.line`,
    [corpusTestIds, files, lines],
  );

  const byTest = new Map<string, string[]>();
  for (const row of hits.rows) {
    const key = lineKey(row.file_path, row.line);
    const list = byTest.get(row.test_id);
    if (list) list.push(key);
    else byTest.set(row.test_id, [key]);
  }

  return buildIndexFromHitLines(
    [...byTest.entries()].map(([testId, hitLines]) => ({ testId, hitLines })),
  );
}
