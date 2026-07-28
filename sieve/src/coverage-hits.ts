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
 * Sparse coverage index: only lines present in `diff` (and the tests that
 * hit them). Pass `corpusSize` into `selectTests` separately.
 */
export async function loadDiffCoverageIndex(
  client: pg.PoolClient,
  runId: string,
  diff: string,
): Promise<CoverageIndex> {
  const diffLines = parseDiffLines(diff);
  if (diffLines.size === 0) {
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

  const hits = await client.query<{
    file_path: string;
    line: number;
    test_id: string;
  }>(
    `SELECT ch.file_path, ch.line, ch.test_id
     FROM coverage_hits ch
     JOIN unnest($2::text[], $3::int[]) AS d(file_path, line)
       ON ch.file_path = d.file_path AND ch.line = d.line
     WHERE ch.run_id = $1::uuid
       -- Only tests still represented by a done/failed attempt in this run
       -- (ignore hits left behind by superseded attempts).
       AND EXISTS (
         SELECT 1
         FROM test_results tr
         JOIN job_attempts ja ON ja.id = tr.attempt_id
           AND ja.status IN ('done', 'failed')
         WHERE tr.run_id = ch.run_id AND tr.test_id = ch.test_id
       )`,
    [runId, files, lines],
  );

  // Group by test → line keys (only diff-overlapping hits).
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
