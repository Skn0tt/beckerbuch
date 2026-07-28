/**
 * Bash command builders for Playwright sieve jobs.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { SHARD_SPEC_ENV, TEST_IDS_ENV } from "./protocol.ts";

const SIEVE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const REPORTER_PATH = path.join(SIEVE_ROOT, "src/reporter.ts");
const PLANNER_PATH = path.join(SIEVE_ROOT, "src/planner.ts");
const FLAKE_RERUN_PATH = path.join(SIEVE_ROOT, "src/flake-rerun.ts");
const RUN_SHARD_PATH = path.join(SIEVE_ROOT, "src/run-shard.ts");

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * `npx playwright test` [files…] with the sieve reporter.
 * Omit `files` for the full suite; Playwright discovers specs itself.
 */
export function playwrightFullCommand(
  opts?: { pwWorkers?: number; files?: string[] },
): string {
  const parts = ["npx playwright test"];
  for (const file of opts?.files ?? []) {
    parts.push(shellQuote(file));
  }
  if (typeof opts?.pwWorkers === "number" && opts.pwWorkers > 0) {
    parts.push(`--workers=${opts.pwWorkers}`);
  }
  parts.push(`--reporter=${shellQuote(REPORTER_PATH)}`);
  return parts.join(" ");
}

/**
 * Diff-aware shard: discover the shard’s source files (when known), filtered
 * to `testIds` via SIEVE_TEST_IDS + the sieve reporter preprocess.
 */
export function playwrightShardCommand(
  testIds: string[],
  pwWorkers?: number,
  files?: string[],
): string {
  const parts = [
    `${TEST_IDS_ENV}=${shellQuote(JSON.stringify(testIds))}`,
    "npx playwright test",
  ];
  for (const file of files ?? []) {
    parts.push(shellQuote(file));
  }
  if (typeof pwWorkers === "number" && pwWorkers > 0) {
    parts.push(`--workers=${pwWorkers}`);
  }
  parts.push(`--reporter=${shellQuote(REPORTER_PATH)}`);
  return parts.join(" ");
}

/**
 * Shard that loads `{ testIds, files? }` from a planner artifact path.
 */
export function playwrightShardFromSpecCommand(
  specPath: string,
  pwWorkers?: number,
): string {
  const parts = [
    `${SHARD_SPEC_ENV}=${shellQuote(specPath)}`,
    `npx tsx ${shellQuote(RUN_SHARD_PATH)}`,
  ];
  if (typeof pwWorkers === "number" && pwWorkers > 0) {
    parts.push(`--workers=${pwWorkers}`);
  }
  return parts.join(" ");
}

export function plannerCommand(): string {
  return `npx tsx ${shellQuote(PLANNER_PATH)}`;
}

export function flakeRerunCommand(): string {
  return `npx tsx ${shellQuote(FLAKE_RERUN_PATH)}`;
}
