import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import {
  buildIndex,
  orderAndFilterTestIds,
  sanitizeTestId,
  selectTests,
} from "./coverage-select";

const DEFAULT_DURATION_FILE = path.join(".playwright-data", "duration.json");
const DEFAULT_COVERAGE_DIR = path.join(".playwright-data", "coverage");

/**
 * Records per-test durations and optionally selects a budgeted subset
 * from prior coverage via `coverage-select`.
 *
 * Env (selection — all required together except coverage/duration paths):
 * - PLAYWRIGHT_DIFF_FILE — unified diff path
 * - PLAYWRIGHT_DURATION_BUDGET_MS — integer ms budget
 * - PLAYWRIGHT_COVERAGE_DIR — default .playwright-data/coverage
 * - PLAYWRIGHT_DURATION_FILE — default .playwright-data/duration.json
 *
 * Paths live outside Playwright's `test-results/` outputDir so a prior
 * run's artifacts survive the wipe that happens before preprocess.
 *
 * Without diff+budget: sorts suite entries by `test.id` ascending.
 */
export default class SortReporter implements Reporter {
  private durations: Record<string, number> = {};

  printsToStdio() {
    return false;
  }

  async preprocess({
    suite,
    testRun,
  }: {
    suite: Suite;
    testRun: {
      exclude(test: TestCase | Suite): void;
    };
  }) {
    const diffFile = process.env.PLAYWRIGHT_DIFF_FILE;
    const budgetRaw = process.env.PLAYWRIGHT_DURATION_BUDGET_MS;

    if (diffFile && budgetRaw) {
      const applied = await tryApplyCoverageSelection({
        suite,
        testRun,
        diffFile,
        budgetRaw,
      });
      if (applied) return;
    }

    sortSuiteByTestId(suite);
  }

  onTestEnd(test: TestCase, result: TestResult) {
    this.durations[test.id] = result.duration;
  }

  async onEnd(_result: FullResult) {
    const file =
      process.env.PLAYWRIGHT_DURATION_FILE ?? DEFAULT_DURATION_FILE;
    await mkdir(path.dirname(file), { recursive: true });
    // Merge with prior run so a partial suite (e.g. unit-only) does not
    // wipe timings needed for budgeted selection.
    let prior: Record<string, number> = {};
    try {
      prior = JSON.parse(await readFile(file, "utf8")) as Record<
        string,
        number
      >;
    } catch {
      // first run
    }
    const merged = { ...prior, ...this.durations };
    await writeFile(file, JSON.stringify(merged, null, 2) + "\n");
  }
}

export async function tryApplyCoverageSelection(opts: {
  suite: Suite;
  testRun: { exclude(test: TestCase | Suite): void };
  diffFile: string;
  budgetRaw: string;
}): Promise<boolean> {
  const budgetMs = Number(opts.budgetRaw);
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    console.warn(
      `[sort-reporter] invalid PLAYWRIGHT_DURATION_BUDGET_MS=${opts.budgetRaw}; falling back to id sort`,
    );
    sortSuiteByTestId(opts.suite);
    return true;
  }

  const durationFile =
    process.env.PLAYWRIGHT_DURATION_FILE ?? DEFAULT_DURATION_FILE;
  let durations: Record<string, number>;
  try {
    durations = JSON.parse(await readFile(durationFile, "utf8")) as Record<
      string,
      number
    >;
  } catch (err) {
    console.warn(
      `[sort-reporter] could not read durations from ${durationFile} (${String(err)}); falling back to id sort`,
    );
    sortSuiteByTestId(opts.suite);
    return true;
  }

  let diff: string;
  try {
    diff = await readFile(opts.diffFile, "utf8");
  } catch (err) {
    console.warn(
      `[sort-reporter] could not read diff from ${opts.diffFile} (${String(err)}); falling back to id sort`,
    );
    sortSuiteByTestId(opts.suite);
    return true;
  }

  const coverageDir =
    process.env.PLAYWRIGHT_COVERAGE_DIR ?? DEFAULT_COVERAGE_DIR;
  const index = await buildIndex(coverageDir);
  const orderedIds = selectTests({ index, durations, diff, budgetMs });

  if (orderedIds.length === 0) {
    console.warn(
      "[sort-reporter] coverage select returned no tests; falling back to id sort",
    );
    sortSuiteByTestId(opts.suite);
    return true;
  }

  applyOrderedSelection(opts.suite, opts.testRun, orderedIds);
  console.error(
    `[sort-reporter] selected ${orderedIds.length} test(s) under ${budgetMs}ms budget`,
  );
  return true;
}

/** Exclude non-selected tests and reorder remaining to match `orderedIds`. */
export function applyOrderedSelection(
  suite: Suite,
  testRun: { exclude(test: TestCase | Suite): void },
  orderedIds: string[],
): void {
  const allTests = suite.allTests();
  const { keep, exclude } = orderAndFilterTestIds(
    allTests.map((t) => t.id),
    orderedIds,
  );
  const bySanitized = new Map(
    allTests.map((t) => [sanitizeTestId(t.id), t] as const),
  );

  for (const id of exclude) {
    const test = bySanitized.get(sanitizeTestId(id));
    if (test) testRun.exclude(test);
  }

  const keepTests = keep
    .map((id) => bySanitized.get(sanitizeTestId(id)))
    .filter((t): t is TestCase => t !== undefined);

  reorderSuiteToMatch(suite, keepTests);
}

export function sortSuiteByTestId(suite: Suite) {
  for (const project of suite.suites) {
    for (const file of project.suites) flattenFileSuiteSortedById(file);
    project
      .entries()
      .sort((a, b) => minTestId(a).localeCompare(minTestId(b)));
  }
  suite.entries().sort((a, b) => minTestId(a).localeCompare(minTestId(b)));
}

/**
 * Place kept tests into file suites in `keepTests` order. File suites are
 * flattened; project/root entry order follows first appearance in keepTests.
 */
function reorderSuiteToMatch(suite: Suite, keepTests: TestCase[]) {
  const byFile = new Map<Suite, TestCase[]>();
  for (const test of keepTests) {
    const fileSuite = fileSuiteOf(test);
    if (!fileSuite) continue;
    let list = byFile.get(fileSuite);
    if (!list) {
      list = [];
      byFile.set(fileSuite, list);
    }
    list.push(test);
  }

  for (const [fileSuite, tests] of byFile) {
    const entries = fileSuite.entries();
    entries.splice(0, entries.length, ...tests);
    for (const test of tests) {
      (test as { parent: Suite }).parent = fileSuite;
    }
  }

  // Order project entries (file suites) by first kept test order.
  for (const project of suite.suites) {
    const order = new Map<Suite, number>();
    let i = 0;
    for (const test of keepTests) {
      const file = fileSuiteOf(test);
      if (!file || file.parent !== project) continue;
      if (!order.has(file)) order.set(file, i++);
    }
    project.entries().sort((a, b) => {
      const ai = order.get(a as Suite) ?? Number.MAX_SAFE_INTEGER;
      const bi = order.get(b as Suite) ?? Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });
  }

  suite.entries().sort((a, b) => {
    const aMin = minKeepOrder(a, keepTests);
    const bMin = minKeepOrder(b, keepTests);
    return aMin - bMin;
  });
}

function fileSuiteOf(test: TestCase): Suite | null {
  let s: Suite | undefined = test.parent;
  while (s && s.type !== "file" && s.parent) s = s.parent;
  return s && s.type === "file" ? s : test.parent;
}

function minKeepOrder(entry: TestCase | Suite, keepTests: TestCase[]): number {
  if (entry.type === "test") {
    const idx = keepTests.indexOf(entry);
    return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER;
  }
  let min = Number.MAX_SAFE_INTEGER;
  for (const t of entry.allTests()) {
    const idx = keepTests.indexOf(t);
    if (idx >= 0 && idx < min) min = idx;
  }
  return min;
}

function flattenFileSuiteSortedById(fileSuite: Suite) {
  const tests = [...fileSuite.allTests()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const entries = fileSuite.entries();
  entries.splice(0, entries.length, ...tests);
  for (const test of tests) {
    (test as { parent: Suite }).parent = fileSuite;
  }
}

function minTestId(entry: TestCase | Suite): string {
  if (entry.type === "test") return entry.id;
  const ids = entry.allTests().map((t) => t.id);
  ids.sort((a, b) => a.localeCompare(b));
  return ids[0] ?? entry.title;
}
