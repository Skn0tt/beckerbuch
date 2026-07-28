/**
 * Playwright reporter that speaks the sieve result-stream protocol.
 *
 * Never talks to the scheduler. Appends one NDJSON `test_result` line
 * per finished test to `$SIEVE_RESULTS_FILE` (see protocol.ts).
 *
 * When `$SIEVE_TEST_IDS` is a JSON array of test ids (or `$SIEVE_SHARD_SPEC`
 * points at `{ testIds }`), preprocess keeps only those tests.
 * Writes `$SIEVE_JOB_DIR/failures.json` on end.
 */

import { appendFile, readFile, writeFile } from "node:fs/promises";
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
import { FAILURES_FILENAME } from "./artifacts.ts";
import {
  formatResultLine,
  JOB_DIR_ENV,
  RESULTS_FILE_ENV,
  SHARD_SPEC_ENV,
  TEST_IDS_ENV,
  TEST_RESULT_TYPE,
} from "./protocol.ts";

type FailureRow = {
  testId: string;
  source: string;
  titlePath: string;
};

export default class SieveReporter implements Reporter {
  private resultsFile: string | undefined;
  private repoRoot = process.cwd();
  private failures: FailureRow[] = [];

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
    const orderedIds = await loadOrderedTestIds();
    if (!orderedIds) return;

    if (orderedIds.length === 0) {
      for (const test of suite.allTests()) {
        testRun.exclude(test);
      }
      console.error("[sieve-reporter] test id list empty; excluded all tests");
      return;
    }

    applyOrderedSelection(suite, testRun, orderedIds);
    console.error(
      `[sieve-reporter] keeping ${orderedIds.length} test id(s)`,
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

  async onTestBegin(test: TestCase) {
    if (!this.resultsFile) return;
    await this.appendResult(test, {
      status: "running",
      durationMs: 0,
      hitLines: [],
    });
  }

  async onTestEnd(test: TestCase, result: TestResult) {
    const source = path
      .relative(this.repoRoot, test.location.file)
      .split(path.sep)
      .join("/");
    const titlePath = test
      .titlePath()
      .map((s) => s.trim())
      .filter(Boolean)
      .join(" › ");

    if (result.status === "failed" || result.status === "timedOut") {
      this.failures.push({ testId: test.id, source, titlePath });
    }

    if (!this.resultsFile) return;
    const hitLines = await this.loadHitLines(test);
    await this.appendResult(test, {
      status: result.status,
      durationMs: result.duration,
      hitLines,
      source,
      titlePath,
    });
  }

  async onEnd() {
    const jobDir = process.env[JOB_DIR_ENV];
    if (!jobDir) return;
    try {
      await writeFile(
        path.join(jobDir, FAILURES_FILENAME),
        JSON.stringify(this.failures, null, 2),
        "utf8",
      );
    } catch (err) {
      console.error("[sieve-reporter] failed to write failures.json", err);
    }
  }

  private async appendResult(
    test: TestCase,
    opts: {
      status: string;
      durationMs: number;
      hitLines: string[];
      source?: string;
      titlePath?: string;
    },
  ) {
    if (!this.resultsFile) return;
    const source =
      opts.source ??
      path
        .relative(this.repoRoot, test.location.file)
        .split(path.sep)
        .join("/");
    const titlePath =
      opts.titlePath ??
      test
        .titlePath()
        .map((s) => s.trim())
        .filter(Boolean)
        .join(" › ");

    await appendFile(
      this.resultsFile,
      formatResultLine({
        type: TEST_RESULT_TYPE,
        testId: test.id,
        source,
        titlePath,
        status: opts.status,
        durationMs: opts.durationMs,
        hitLines: opts.hitLines,
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

async function loadOrderedTestIds(): Promise<string[] | null> {
  const raw = process.env[TEST_IDS_ENV];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        !Array.isArray(parsed) ||
        !parsed.every((x) => typeof x === "string")
      ) {
        throw new Error("expected JSON string array");
      }
      return parsed;
    } catch (err) {
      console.warn(
        `[sieve-reporter] invalid ${TEST_IDS_ENV} (${String(err)}); running full suite`,
      );
      return null;
    }
  }

  const specPath = process.env[SHARD_SPEC_ENV];
  if (!specPath) return null;
  try {
    const parsed = JSON.parse(await readFile(specPath, "utf8")) as {
      testIds?: unknown;
    };
    if (
      !Array.isArray(parsed.testIds) ||
      !parsed.testIds.every((x) => typeof x === "string")
    ) {
      throw new Error("spec.testIds must be a string array");
    }
    return parsed.testIds;
  } catch (err) {
    console.warn(
      `[sieve-reporter] invalid ${SHARD_SPEC_ENV} (${String(err)}); running full suite`,
    );
    return null;
  }
}
