/**
 * Diff-aware test selection from per-test Istanbul coverage.
 *
 * - `buildIndex` scans coverageDir/<worker>-<testId>/coverage.json into an
 *   in-memory line-to-test inverted index (no durations).
 * - `selectTests` greedily spends a duration budget with diminishing
 *   returns so leftover budget reinforces already-covered diff lines.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Matches `coverageArtifactDir` sanitization in coverage-remap.ts. */
export function sanitizeTestId(testId: string): string {
  return testId.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

/** `app/routes/login.tsx:10` */
export type LineKey = string;

export type CoverageIndex = {
  /** Lines each test hit (statement hits remapped to source lines). */
  testLines: Map<string, Set<LineKey>>;
  /** Tests that hit each line. */
  lineTests: Map<LineKey, Set<string>>;
};

type IstanbulStatementMeta = {
  start: { line: number; column?: number };
  end: { line: number; column?: number };
};

type IstanbulFileCoverage = {
  path?: string;
  statementMap?: Record<string, IstanbulStatementMeta>;
  s?: Record<string, number>;
};

/**
 * Directory names are `${worker}-${safeId}` (see coverageArtifactDir).
 * Worker index is numeric; everything after the first `-` is the id.
 */
export function testIdFromCoverageDirName(dirName: string): string | null {
  const dash = dirName.indexOf("-");
  if (dash < 0 || dash === dirName.length - 1) return null;
  const worker = dirName.slice(0, dash);
  if (!/^\d+$/.test(worker)) return null;
  return dirName.slice(dash + 1);
}

export function lineKey(file: string, line: number): LineKey {
  return `${file}:${line}`;
}

/** Collect source line keys hit by an Istanbul coverage map. */
export function hitLinesFromIstanbul(
  coverage: Record<string, IstanbulFileCoverage>,
): Set<LineKey> {
  const lines = new Set<LineKey>();
  for (const [filePath, fileCov] of Object.entries(coverage)) {
    const statementMap = fileCov.statementMap ?? {};
    const hits = fileCov.s ?? {};
    for (const [stmtId, meta] of Object.entries(statementMap)) {
      if ((hits[stmtId] ?? 0) <= 0) continue;
      const start = meta.start?.line;
      const end = meta.end?.line ?? start;
      if (typeof start !== "number" || typeof end !== "number") continue;
      const file = fileCov.path ?? filePath;
      for (let line = start; line <= end; line++) {
        lines.add(lineKey(file, line));
      }
    }
  }
  return lines;
}

export async function buildIndex(coverageDir: string): Promise<CoverageIndex> {
  const testLines = new Map<string, Set<LineKey>>();
  const lineTests = new Map<LineKey, Set<string>>();

  let entries: string[];
  try {
    entries = await readdir(coverageDir);
  } catch {
    return { testLines, lineTests };
  }

  for (const name of entries) {
    const testId = testIdFromCoverageDirName(name);
    if (!testId) continue;
    const coveragePath = path.join(coverageDir, name, "coverage.json");
    let raw: string;
    try {
      raw = await readFile(coveragePath, "utf8");
    } catch {
      continue;
    }
    let parsed: Record<string, IstanbulFileCoverage>;
    try {
      parsed = JSON.parse(raw) as Record<string, IstanbulFileCoverage>;
    } catch {
      continue;
    }

    const lines = hitLinesFromIstanbul(parsed);
    // Last writer wins if the same test ran on multiple workers.
    testLines.set(testId, lines);
  }

  for (const [testId, lines] of testLines) {
    for (const line of lines) {
      let set = lineTests.get(line);
      if (!set) {
        set = new Set();
        lineTests.set(line, set);
      }
      set.add(testId);
    }
  }

  return { testLines, lineTests };
}

/**
 * Build a coverage index from stored per-test hit-line lists (e.g. sieve
 * `test_results.hit_lines`). Last row wins if the same `testId` appears twice.
 */
export function buildIndexFromHitLines(
  rows: Array<{ testId: string; hitLines: Iterable<string> }>,
): CoverageIndex {
  const testLines = new Map<string, Set<LineKey>>();
  const lineTests = new Map<LineKey, Set<string>>();

  for (const row of rows) {
    testLines.set(row.testId, new Set(row.hitLines));
  }

  for (const [testId, lines] of testLines) {
    for (const line of lines) {
      let set = lineTests.get(line);
      if (!set) {
        set = new Set();
        lineTests.set(line, set);
      }
      set.add(testId);
    }
  }

  return { testLines, lineTests };
}

/**
 * Parse a unified diff into `app/...:line` keys for **added** new-side
 * lines only. Deleted-only hunks contribute nothing.
 */
export function parseDiffLines(diff: string): Set<LineKey> {
  const lines = new Set<LineKey>();
  let currentFile: string | null = null;
  let newLine = 0;

  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith("+++ ")) {
      const pathPart = raw.slice(4).trim();
      // `+++ b/app/foo.ts` or `+++ app/foo.ts`
      const file = pathPart.replace(/^[ab]\//, "");
      if (file === "/dev/null") {
        currentFile = null;
        continue;
      }
      currentFile = file.startsWith("app/") ? file : null;
      continue;
    }

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }

    if (!currentFile) continue;

    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      lines.add(lineKey(currentFile, newLine));
      newLine += 1;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      // deleted line: new-side counter does not advance
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file"
    } else {
      // context line (including empty) advances both sides; we only track new
      newLine += 1;
    }
  }

  return lines;
}

function durationMs(
  durations: Record<string, number>,
  testId: string,
): number {
  // Durations are keyed by raw Playwright test.id; coverage dirs use
  // sanitizeTestId. Accept either form.
  const raw = durations[testId];
  if (typeof raw === "number" && raw > 0) return raw;
  const sanitized = sanitizeTestId(testId);
  if (sanitized !== testId) {
    const viaSan = durations[sanitized];
    if (typeof viaSan === "number" && viaSan > 0) return viaSan;
  }
  for (const [id, ms] of Object.entries(durations)) {
    if (sanitizeTestId(id) === sanitized && ms > 0) return ms;
  }
  return 1;
}

/**
 * Robertson–Sparck Jones IDF with +1 smoothing (BM25-style).
 * Rare lines (low df) score much higher than ubiquitous imports.
 */
export function lineIdf(opts: {
  corpusSize: number;
  docFreq: number;
}): number {
  const N = Math.max(opts.corpusSize, 1);
  const df = Math.max(opts.docFreq, 0);
  return Math.log(1 + (N - df + 0.5) / (df + 0.5));
}

/**
 * Greedy diminishing-returns selection under a duration budget.
 *
 * Marginal value of one more hit on line L after k selected hits:
 *   idf(L) / (k + 1)
 *
 * IDF is over the whole coverage corpus so ubiquitous import lines
 * contribute little vs rare feature lines.
 */
export function selectTests(opts: {
  index: CoverageIndex;
  durations: Record<string, number>;
  diff: string;
  budgetMs: number;
}): string[] {
  const { index, durations, budgetMs } = opts;
  if (!(budgetMs > 0)) return [];

  const diffLines = parseDiffLines(opts.diff);
  const target = new Set<LineKey>();
  for (const line of diffLines) {
    if (index.lineTests.has(line)) target.add(line);
  }
  if (target.size === 0) return [];

  const corpusSize = Math.max(index.testLines.size, 1);
  const idf = new Map<LineKey, number>();
  for (const line of target) {
    idf.set(
      line,
      lineIdf({
        corpusSize,
        docFreq: index.lineTests.get(line)?.size ?? 0,
      }),
    );
  }

  const pool = new Set<string>();
  for (const line of target) {
    for (const testId of index.lineTests.get(line) ?? []) {
      pool.add(testId);
    }
  }

  const hits = new Map<LineKey, number>();
  for (const line of target) hits.set(line, 0);

  const selected: string[] = [];
  let remaining = budgetMs;

  while (pool.size > 0) {
    let bestId: string | null = null;
    let bestDensity = -Infinity;
    let bestDuration = 0;

    for (const testId of pool) {
      const dur = durationMs(durations, testId);
      if (dur > remaining) continue;

      const covered = index.testLines.get(testId);
      if (!covered) continue;

      let value = 0;
      for (const line of target) {
        if (!covered.has(line)) continue;
        const k = hits.get(line) ?? 0;
        value += (idf.get(line) ?? 0) / (k + 1);
      }
      if (value <= 0) continue;

      const density = value / dur;
      if (
        density > bestDensity ||
        (density === bestDensity &&
          bestId !== null &&
          testId.localeCompare(bestId) < 0)
      ) {
        bestDensity = density;
        bestId = testId;
        bestDuration = dur;
      }
    }

    if (bestId === null) break;

    selected.push(bestId);
    remaining -= bestDuration;
    pool.delete(bestId);

    const covered = index.testLines.get(bestId);
    if (covered) {
      for (const line of target) {
        if (!covered.has(line)) continue;
        hits.set(line, (hits.get(line) ?? 0) + 1);
      }
    }
  }

  return selected;
}

/**
 * Apply an ordered keep-list to discovered test ids.
 * Matching is by `sanitizeTestId` so coverage-dir ids line up with
 * Playwright `test.id` values that may contain other characters.
 */
export function orderAndFilterTestIds(
  allIds: string[],
  orderedKeep: string[],
): { keep: string[]; exclude: string[] } {
  const bySanitized = new Map(
    allIds.map((id) => [sanitizeTestId(id), id] as const),
  );
  const keep: string[] = [];
  const keptSanitized = new Set<string>();
  for (const id of orderedKeep) {
    const key = sanitizeTestId(id);
    const raw = bySanitized.get(key);
    if (raw === undefined || keptSanitized.has(key)) continue;
    keep.push(raw);
    keptSanitized.add(key);
  }
  const exclude = allIds.filter(
    (id) => !keptSanitized.has(sanitizeTestId(id)),
  );
  return { keep, exclude };
}
