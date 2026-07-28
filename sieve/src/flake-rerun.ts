/**
 * Flake-rerun job: merge failures.json from SIEVE_DEP_DIRS, rerun those
 * tests once, write flake-verdict.json, exit non-zero if any still fail.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { FAILURES_FILENAME, type DepDir } from "./artifacts.ts";
import { REPORTER_PATH } from "./commands.ts";
import { DEP_DIRS_ENV, JOB_DIR_ENV, TEST_IDS_ENV } from "./protocol.ts";

type FailureRow = {
  testId: string;
  source?: string;
  titlePath?: string;
};

async function main() {
  const jobDir = process.env[JOB_DIR_ENV];
  if (!jobDir) {
    console.error(`[flake-rerun] ${JOB_DIR_ENV} is required`);
    process.exit(1);
  }

  const depRaw = process.env[DEP_DIRS_ENV] ?? "[]";
  const depDirs = JSON.parse(depRaw) as DepDir[];
  const byId = new Map<string, FailureRow>();

  for (const dep of depDirs) {
    const failuresPath = path.join(dep.path, FAILURES_FILENAME);
    let rows: FailureRow[] = [];
    try {
      const parsed = JSON.parse(await readFile(failuresPath, "utf8")) as unknown;
      if (Array.isArray(parsed)) {
        rows = parsed.filter(
          (x): x is FailureRow =>
            x !== null &&
            typeof x === "object" &&
            typeof (x as FailureRow).testId === "string",
        );
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
      // Missing on a queued flake means unlock already decided outputs were OK.
      rows = [];
    }
    for (const row of rows) {
      byId.set(row.testId, row);
    }
  }

  const failures = [...byId.values()];
  const files = [
    ...new Set(
      failures
        .map((f) => f.source)
        .filter((s): s is string => typeof s === "string" && s.length > 0),
    ),
  ];

  if (failures.length === 0) {
    await writeFile(
      path.join(jobDir, "flake-verdict.json"),
      JSON.stringify({ flakes: [], realFailures: [] }, null, 2),
      "utf8",
    );
    console.error("[flake-rerun] no failures to rerun");
    process.exit(0);
  }

  const testIds = failures.map((f) => f.testId);
  const args = [
    "playwright",
    "test",
    ...files,
    `--reporter=${REPORTER_PATH}`,
  ];
  const child = spawn("npx", args, {
    stdio: "inherit",
    env: {
      ...process.env,
      [TEST_IDS_ENV]: JSON.stringify(testIds),
    },
  });
  const code: number = await new Promise((resolve) => {
    child.on("exit", (c, signal) => resolve(c ?? (signal ? 1 : 0)));
  });

  // Classify from this job's failures.json written by the reporter.
  let stillFailed: FailureRow[] = [];
  try {
    const parsed = JSON.parse(
      await readFile(path.join(jobDir, FAILURES_FILENAME), "utf8"),
    ) as unknown;
    if (Array.isArray(parsed)) {
      stillFailed = parsed.filter(
        (x): x is FailureRow =>
          x !== null &&
          typeof x === "object" &&
          typeof (x as FailureRow).testId === "string",
      );
    }
  } catch {
    stillFailed = code === 0 ? [] : failures;
  }

  const stillIds = new Set(stillFailed.map((f) => f.testId));
  const flakes = failures.filter((f) => !stillIds.has(f.testId));
  const realFailures = failures.filter((f) => stillIds.has(f.testId));

  await writeFile(
    path.join(jobDir, "flake-verdict.json"),
    JSON.stringify({ flakes, realFailures }, null, 2),
    "utf8",
  );

  console.error(
    `[flake-rerun] flakes=${flakes.length} realFailures=${realFailures.length}`,
  );
  process.exit(realFailures.length > 0 ? 1 : 0);
}

if (process.argv[1]?.endsWith("flake-rerun.ts")) {
  void main().catch((err) => {
    console.error("[flake-rerun]", err);
    process.exit(1);
  });
}
