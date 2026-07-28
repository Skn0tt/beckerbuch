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
 * Diff-aware shard: full suite discovery, filtered to `testIds` via
 * SIEVE_TEST_IDS + the sieve reporter preprocess.
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
