/**
 * Playwright reporter that speaks the sieve result-stream protocol.
 *
 * Never talks to the scheduler. Appends one NDJSON `test_result` line
 * per finished test to `$SIEVE_RESULTS_FILE` (see protocol.ts).
 */

import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  FullConfig,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import {
  hitLinesFromIstanbul,
  sanitizeTestId,
} from "../../tests/coverage-select.ts";
import {
  formatResultLine,
  RESULTS_FILE_ENV,
  TEST_RESULT_TYPE,
} from "./protocol.ts";

export default class SieveReporter implements Reporter {
  private resultsFile: string | undefined;
  private repoRoot = process.cwd();

  printsToStdio() {
    return false;
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

    await appendFile(
      this.resultsFile,
      formatResultLine({
        type: TEST_RESULT_TYPE,
        testId: test.id,
        source,
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
