/**
 * CLI helpers. Jobs are arbitrary bash commands; Playwright is only one
 * way to produce the NDJSON result stream.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SchedulerClient } from "./client.ts";
import { playwrightCommand } from "./commands.ts";

export {
  playwrightCommand,
  playwrightShardCommand,
  shellQuote,
} from "./commands.ts";

const SIEVE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const REPO_ROOT = path.resolve(SIEVE_ROOT, "..");

export async function listSpecFiles(filter?: string[]): Promise<string[]> {
  if (filter && filter.length > 0) {
    return [...new Set(filter.map((f) => f.replace(/^\.\//, "")))];
  }
  return listViaPlaywright();
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

  const files = new Set<string>();
  try {
    const parsed = JSON.parse(raw) as {
      suites?: Array<{ file?: string; suites?: unknown[] }>;
    };
    const walk = (
      suites: Array<{ file?: string; suites?: unknown[] }> | undefined,
    ) => {
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

function parseFlag(
  args: string[],
  name: string,
): { value: string | undefined; rest: string[] } {
  const out: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === name) {
      value = args[++i];
      continue;
    }
    if (a.startsWith(`${name}=`)) {
      value = a.slice(name.length + 1);
      continue;
    }
    out.push(a);
  }
  return { value, rest: out };
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const schedulerUrl =
    process.env.SIEVE_SCHEDULER_URL ?? "http://127.0.0.1:9101";
  const client = new SchedulerClient(schedulerUrl);

  if (cmd === "list-specs") {
    const files = await listSpecFiles(args.length ? args : undefined);
    for (const f of files) console.log(f);
    return;
  }

  if (cmd === "create-run") {
    const dash = args.indexOf("--");
    if (dash < 0) {
      console.error(
        "usage: cli create-run <label> -- <bash-command> [<bash-command>...]",
      );
      process.exit(1);
    }
    const label = args.slice(0, dash)[0] ?? `run-${new Date().toISOString()}`;
    const commands = args.slice(dash + 1).filter(Boolean);
    if (commands.length === 0) {
      console.error("no commands after --");
      process.exit(1);
    }
    const created = await client.createRun(label, commands);
    console.log(JSON.stringify(created, null, 2));
    return;
  }

  if (cmd === "create-run-playwright") {
    const label = args[0] ?? `run-${new Date().toISOString()}`;
    const specs = await listSpecFiles(args.slice(1));
    if (specs.length === 0) {
      console.error("no spec files");
      process.exit(1);
    }
    const commands = specs.map(playwrightCommand);
    const created = await client.createRun(label, commands);
    console.log(JSON.stringify(created, null, 2));
    return;
  }

  if (cmd === "create-run-diff") {
    let rest = args;
    const diffParsed = parseFlag(rest, "--diff");
    rest = diffParsed.rest;
    const budgetParsed = parseFlag(rest, "--budget");
    rest = budgetParsed.rest;
    const baselineParsed = parseFlag(rest, "--baseline");
    rest = baselineParsed.rest;
    const shardsParsed = parseFlag(rest, "--shards");
    rest = shardsParsed.rest;

    const label = rest[0] ?? `run-${new Date().toISOString()}`;
    if (!diffParsed.value || !budgetParsed.value) {
      console.error(
        "usage: cli create-run-diff <label> --diff <path> --budget <ms> [--baseline <runId>] [--shards N]",
      );
      process.exit(1);
    }
    const budgetMs = Number(budgetParsed.value);
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
      console.error("budget must be a positive number");
      process.exit(1);
    }
    const shardCount = shardsParsed.value
      ? Number(shardsParsed.value)
      : undefined;
    if (
      shardCount !== undefined &&
      (!Number.isFinite(shardCount) || shardCount < 1)
    ) {
      console.error("shards must be a positive integer");
      process.exit(1);
    }

    const diff = await readFile(diffParsed.value, "utf8");
    const pwWorkersRaw = process.env.SIEVE_PW_WORKERS;
    const pwWorkers =
      pwWorkersRaw && Number.isFinite(Number(pwWorkersRaw))
        ? Number(pwWorkersRaw)
        : undefined;

    const created = await client.createDiffRun({
      label,
      diff,
      budgetMs,
      shardCount,
      baselineRunId: baselineParsed.value,
      pwWorkers,
    });
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

  console.error(
    "usage: cli <list-specs|create-run|create-run-playwright|create-run-diff|status> ...",
  );
  process.exit(1);
}

if (process.argv[1]?.endsWith("cli.ts")) {
  void main();
}
