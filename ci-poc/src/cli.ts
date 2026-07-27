/**
 * CLI: create-run, status, list-specs helpers.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SchedulerClient } from "./client.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export async function listSpecFiles(filter?: string[]): Promise<string[]> {
  // Prefer an explicit filter (demo subset) so we don't need a full --list
  // parse when the caller already knows the files.
  if (filter && filter.length > 0) {
    return [...new Set(filter.map((f) => f.replace(/^\.\//, "")))];
  }

  const files = await listViaPlaywright();
  return files;
}

async function listViaPlaywright(): Promise<string[]> {
  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      "npx",
      ["playwright", "test", "--list", "--reporter=json"],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, PLAYWRIGHT_FORCE_ASYNC_LOADER: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `playwright --list failed (${code}): ${stderr.slice(-2000)}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });

  // JSON reporter with --list prints a suite tree; fall back to line parse.
  const files = new Set<string>();
  try {
    const parsed = JSON.parse(raw) as {
      suites?: Array<{ file?: string; suites?: unknown[] }>;
    };
    const walk = (suites: Array<{ file?: string; suites?: unknown[] }> | undefined) => {
      for (const s of suites ?? []) {
        if (s.file) {
          files.add(
            path.relative(REPO_ROOT, s.file).split(path.sep).join("/"),
          );
        }
        walk(s.suites as typeof suites);
      }
    };
    walk(parsed.suites);
  } catch {
    for (const line of raw.split("\n")) {
      const m = line.match(/tests\/[\w./-]+\.spec\.ts/);
      if (m) files.add(m[0]);
    }
  }
  return [...files].sort();
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const schedulerUrl =
    process.env.CI_POC_SCHEDULER_URL ?? "http://127.0.0.1:9101";
  const client = new SchedulerClient(schedulerUrl);

  if (cmd === "list-specs") {
    const files = await listSpecFiles(args.length ? args : undefined);
    for (const f of files) console.log(f);
    return;
  }

  if (cmd === "create-run") {
    const label = args[0] ?? `run-${new Date().toISOString()}`;
    const specs = args.slice(1);
    const files = await listSpecFiles(specs.length ? specs : undefined);
    if (files.length === 0) {
      console.error("no spec files");
      process.exit(1);
    }
    const created = await client.createRun(label, files);
    console.log(JSON.stringify(created, null, 2));
    return;
  }

  if (cmd === "status") {
    const runId = args[0];
    if (!runId) {
      console.error("usage: cli status <runId>");
      process.exit(1);
    }
    const summary = await client.getRun(runId);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.error("usage: cli <list-specs|create-run|status> ...");
  process.exit(1);
}

if (process.argv[1]?.endsWith("cli.ts")) {
  void main();
}
