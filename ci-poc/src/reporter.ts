/**
 * Playwright reporter for ci-poc.
 *
 * Never talks to the scheduler. Emits one NDJSON line per finished test
 * to the IPC file the worker created (CI_POC_RESULTS_FILE).
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

export default class CiPocReporter implements Reporter {
  private resultsFile: string | undefined;
  private repoRoot = process.cwd();

  printsToStdio() {
    return false;
  }

  onBegin(_config: FullConfig) {
    this.resultsFile = process.env.CI_POC_RESULTS_FILE;
    if (!this.resultsFile) {
      console.warn(
        "[ci-poc-reporter] CI_POC_RESULTS_FILE unset; results will not be forwarded",
      );
    }
  }

  async onTestEnd(test: TestCase, result: TestResult) {
    if (!this.resultsFile) return;

    const hitLines = await this.loadHitLines(test);
    const specFile = path.relative(
      this.repoRoot,
      test.location.file,
    ).split(path.sep).join("/");

    const event = {
      type: "test_result",
      testId: test.id,
      specFile,
      status: result.status,
      durationMs: result.duration,
      hitLines: [...hitLines],
    };

    await appendFile(this.resultsFile, JSON.stringify(event) + "\n", "utf8");
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
