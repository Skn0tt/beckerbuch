/**
 * Run a Playwright shard from SIEVE_SHARD_SPEC JSON
 * (`{ testIds: string[], files?: string[] }`).
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { REPORTER_PATH } from "./commands.ts";
import { SHARD_SPEC_ENV, TEST_IDS_ENV } from "./protocol.ts";

async function main() {
  const specPath = process.env[SHARD_SPEC_ENV];
  if (!specPath) {
    console.error(`[run-shard] ${SHARD_SPEC_ENV} is required`);
    process.exit(1);
  }
  const raw = JSON.parse(await readFile(specPath, "utf8")) as {
    testIds?: unknown;
    files?: unknown;
  };
  if (!Array.isArray(raw.testIds) || !raw.testIds.every((x) => typeof x === "string")) {
    console.error("[run-shard] spec.testIds must be a string array");
    process.exit(1);
  }
  const files = Array.isArray(raw.files)
    ? raw.files.filter((x): x is string => typeof x === "string")
    : [];

  const extra = process.argv.slice(2).filter((a) => a.startsWith("-"));
  const args = ["playwright", "test", ...files, ...extra, `--reporter=${REPORTER_PATH}`];
  const child = spawn("npx", args, {
    stdio: "inherit",
    env: {
      ...process.env,
      [TEST_IDS_ENV]: JSON.stringify(raw.testIds),
      [SHARD_SPEC_ENV]: specPath,
    },
  });
  const code: number = await new Promise((resolve) => {
    child.on("exit", (c, signal) => resolve(c ?? (signal ? 1 : 0)));
  });
  process.exit(code);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
