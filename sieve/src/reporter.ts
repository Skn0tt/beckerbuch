/**
 * Playwright reporter that speaks the sieve result-stream protocol.
 *
 * Never talks to the scheduler. Appends one NDJSON `test_result` line
 * per finished test to `$SIEVE_RESULTS_FILE` (see protocol.ts).
 *
 * When `$SIEVE_TEST_IDS` is a JSON array of test ids, preprocess keeps
 * only those tests (and orders them) via sort-reporter helpers.
 */

import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  FullConfig,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import {
  hitLinesFromIstanbul,
  sanitizeTestId,
} from "../../tests/coverage-select.ts";
import { applyOrderedSelection } from "../../tests/sort-reporter.ts";
import {
  formatResultLine,
  RESULTS_FILE_ENV,
  TEST_IDS_ENV,
  TEST_RESULT_TYPE,
} from "./protocol.ts";

export default class SieveReporter implements Reporter {
  private resultsFile: string | undefined;
  private repoRoot = process.cwd();

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
    const raw = process.env[TEST_IDS_ENV];
    if (!raw) return;

    let orderedIds: string[];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        !Array.isArray(parsed) ||
        !parsed.every((x) => typeof x === "string")
      ) {
        throw new Error("expected JSON string array");
      }
      orderedIds = parsed;
    } catch (err) {
      console.warn(
        `[sieve-reporter] invalid ${TEST_IDS_ENV} (${String(err)}); running full suite`,
      );
      return;
    }

    if (orderedIds.length === 0) {
      for (const test of suite.allTests()) {
        testRun.exclude(test);
      }
      console.error("[sieve-reporter] SIEVE_TEST_IDS empty; excluded all tests");
      return;
    }

    applyOrderedSelection(suite, testRun, orderedIds);
    console.error(
      `[sieve-reporter] keeping ${orderedIds.length} test id(s) from ${TEST_IDS_ENV}`,
    );
  }

  onBegin(_config: FullConfig) {
    this.resultsFile = process.env[RESULTS_FILE_ENV];
    if (!this.resultsFile) {
      console.warn(
        `[sieve-reporter] ${RESULTS_FILE_ENV} unset; results will not be forwarded`,
      );
    }
  }

  async onTestEnd(test: TestCase, result: TestResult) {
    if (!this.resultsFile) return;

    const hitLines = await this.loadHitLines(test);
    const source = path
      .relative(this.repoRoot, test.location.file)
      .split(path.sep)
      .join("/");
    const titlePath = test.titlePath().join(" › ");

    await appendFile(
      this.resultsFile,
      formatResultLine({
        type: TEST_RESULT_TYPE,
        testId: test.id,
        source,
        titlePath,
        status: result.status,
        durationMs: result.duration,
        hitLines,
      }) + "\n",
      "utf8",
    );
  }

  private async loadHitLines(test: TestCase): Promise<string[]> {
    const last = test.results[test.results.length - 1];
    const parallelIndex = last?.parallelIndex ?? 0;
    const safeId = sanitizeTestId(test.id);
    const coveragePath = path.join(
      this.repoRoot,
      ".playwright-data",
      "coverage",
      `${parallelIndex}-${safeId}`,
      "coverage.json",
    );
    try {
      const raw = JSON.parse(
        await readFile(coveragePath, "utf8"),
      ) as Parameters<typeof hitLinesFromIstanbul>[0];
      return [...hitLinesFromIstanbul(raw)];
    } catch {
      return [];
    }
  }
}
