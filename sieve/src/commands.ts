/**
 * Bash command builders for Playwright sieve jobs.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_IDS_ENV } from "./protocol.ts";

const SIEVE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const REPORTER_PATH = path.join(SIEVE_ROOT, "src/reporter.ts");

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Bash command that runs one Playwright file and emits protocol NDJSON. */
export function playwrightCommand(specFile: string): string {
  return [
    "npx playwright test",
    shellQuote(specFile),
    "--workers=1",
    `--reporter=${shellQuote(REPORTER_PATH)}`,
  ].join(" ");
}

/**
 * Bash command for a diff-aware shard: full suite discovery, filtered to
 * `testIds` via SIEVE_TEST_IDS + the sieve reporter preprocess.
 * Only passes `--workers` when `pwWorkers` is a positive number.
 */
export function playwrightShardCommand(
  testIds: string[],
  pwWorkers?: number,
): string {
  const parts = [
    `${TEST_IDS_ENV}=${shellQuote(JSON.stringify(testIds))}`,
    "npx playwright test",
  ];
  if (typeof pwWorkers === "number" && pwWorkers > 0) {
    parts.push(`--workers=${pwWorkers}`);
  }
  parts.push(`--reporter=${shellQuote(REPORTER_PATH)}`);
  return parts.join(" ");
}
