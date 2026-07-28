/**
 * CLI against a live scheduler: run-full, create-run-diff, status.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { SchedulerClient } from "./client.ts";
import { playwrightFullCommand } from "./commands.ts";
import {
  resolveDatabaseUrl,
  writeCorpusBackups,
} from "./dump-baseline.ts";
import { loadGitDiff, repoRootFromEnv } from "./git.ts";

const SIEVE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

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

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const schedulerUrl =
    process.env.SIEVE_SCHEDULER_URL ?? "http://127.0.0.1:9101";
  const client = new SchedulerClient(schedulerUrl);

  if (cmd === "run-full") {
    // usage: run-full [--dump [path]] [--no-wait]
    const dumpFlag = hasFlag(args, "--dump");
    const noWait = hasFlag(args, "--no-wait");
    let rest = args.filter((a) => a !== "--dump" && a !== "--no-wait");
    let dumpPath: string | undefined;
    if (dumpFlag) {
      const dumpEq = args.find((a) => a.startsWith("--dump="));
      if (dumpEq) {
        dumpPath = dumpEq.slice("--dump=".length);
        rest = rest.filter((a) => a !== dumpEq);
      } else if (rest[0]?.endsWith(".sql")) {
        dumpPath = rest.shift();
      } else {
        dumpPath = path.join(SIEVE_ROOT, "fixtures", "baseline.sql");
      }
    } else {
      dumpPath = path.join(SIEVE_ROOT, "fixtures", "baseline.sql");
    }
    if (rest.length) {
      console.error("usage: cli run-full [--dump [path]] [--no-wait]");
      process.exit(1);
    }

    if (!(await client.health())) {
      console.error(
        `scheduler not healthy at ${schedulerUrl} — start npm run serve-ui first`,
      );
      process.exit(1);
    }

    const pwWorkersRaw = process.env.SIEVE_PW_WORKERS;
    const pwWorkers =
      pwWorkersRaw && Number.isFinite(Number(pwWorkersRaw))
        ? Number(pwWorkersRaw)
        : undefined;
    const command = playwrightFullCommand({ pwWorkers });
    console.log(`[run-full] enqueue 1 job: ${command}`);

    const created = await client.createRun(
      `full-${new Date().toISOString()}`,
      [command],
    );
    console.log(
      `[run-full] run ${created.runId} (${created.jobCount} job(s))`,
    );

    if (noWait) {
      console.log(`[run-full] --no-wait; poll with: npm run cli -- status ${created.runId}`);
      return;
    }

    const deadline =
      Date.now() + Number(process.env.SIEVE_RUN_TIMEOUT_MS ?? 3_600_000);
    let summary: Awaited<ReturnType<SchedulerClient["getRun"]>> | undefined;
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error("run-full timed out waiting for run to finish");
      }
      summary = await client.getRun(created.runId);
      const doneJobs = summary.jobs.filter(
        (j) => j.status === "done" || j.status === "failed",
      ).length;
      console.log(
        `[run-full] status=${summary.run.status} jobs=${doneJobs}/${summary.jobs.length} results=${summary.results.length}`,
      );
      if (
        summary.run.status === "done" ||
        summary.run.status === "failed"
      ) {
        break;
      }
      await sleep(5_000);
    }

    console.log(
      `[run-full] finished ${summary!.run.status} with ${summary!.results.length} test result(s)`,
    );
    if (summary!.results.length === 0) {
      console.error("[run-full] 0 results — not dumping fixture");
      process.exitCode = 1;
      return;
    }
    if (summary!.run.status !== "done") {
      console.warn(
        `[run-full] run status=${summary!.run.status} (Playwright exit ≠ 0) — dumping partial corpus anyway`,
      );
      process.exitCode = 1;
    }

    const dbUrl = await resolveDatabaseUrl();
    if (!dbUrl) {
      console.warn(
        "[run-full] no SIEVE_DATABASE_URL / sieve/.database-url — skip fixture dump",
      );
      return;
    }
    if (!dumpPath) return;
    // Always dump the full corpus history (all mainline runs) so flake
    // signal survives restore — not only this run's roster.
    const backup = await writeCorpusBackups(dbUrl, {
      fixturePath: dumpPath,
    });
    console.log(
      `[run-full] wrote corpus dump ${backup.fixturePath} (${backup.runCount} run(s), ${backup.resultCount} results)`,
    );
    console.log(`[run-full] backup ${backup.stampedPath}`);
    console.log(`[run-full] backup ${backup.latestPath}`);
    return;
  }

  if (cmd === "dump-corpus") {
    // usage: dump-corpus [out.sql]
    const out =
      args[0] ?? path.join(SIEVE_ROOT, "fixtures", "baseline.sql");
    const dbUrl = await resolveDatabaseUrl();
    if (!dbUrl) {
      console.error("no SIEVE_DATABASE_URL / sieve/.database-url");
      process.exit(1);
    }
    const backup = await writeCorpusBackups(dbUrl, { fixturePath: out });
    console.log(
      `[dump-corpus] ${backup.fixturePath} (${backup.runCount} run(s), ${backup.resultCount} results)`,
    );
    console.log(`[dump-corpus] ${backup.stampedPath}`);
    console.log(`[dump-corpus] ${backup.latestPath}`);
    return;
  }

  if (cmd === "create-run-diff") {
    let rest = args;
    const cpuParsed = parseFlag(rest, "--cpu-time");
    rest = cpuParsed.rest;
    const wallParsed = parseFlag(rest, "--wall-time");
    rest = wallParsed.rest;
    const baselineParsed = parseFlag(rest, "--baseline");
    rest = baselineParsed.rest;
    const shardsParsed = parseFlag(rest, "--shards");
    rest = shardsParsed.rest;

    const label = rest[0] ?? `run-${new Date().toISOString()}`;
    if (!cpuParsed.value) {
      console.error(
        "usage: cli create-run-diff [<label>] --cpu-time <ms> [--wall-time <ms>] [--baseline <runId>] [--shards N]",
      );
      process.exit(1);
    }
    const budgetMs = Number(cpuParsed.value);
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
      console.error("cpu-time must be a positive number (ms)");
      process.exit(1);
    }
    const latencyMs = wallParsed.value
      ? Number(wallParsed.value)
      : undefined;
    if (
      latencyMs !== undefined &&
      (!Number.isFinite(latencyMs) || latencyMs <= 0)
    ) {
      console.error("wall-time must be a positive number (ms)");
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

    const repoRoot = repoRootFromEnv();
    const { diffText, diffLineCount, refLabel } = await loadGitDiff(repoRoot);
    console.log(
      `[create-run-diff] ${refLabel} · ${diffLineCount} covered line(s) under ${repoRoot}`,
    );

    const pwWorkersRaw = process.env.SIEVE_PW_WORKERS;
    const pwWorkers =
      pwWorkersRaw && Number.isFinite(Number(pwWorkersRaw))
        ? Number(pwWorkersRaw)
        : undefined;

    const created = await client.createDiffRun({
      label,
      diff: diffText,
      budgetMs,
      latencyMs,
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

  console.error("usage: cli <run-full|dump-corpus|create-run-diff|status> ...");
  process.exit(1);
}

if (process.argv[1]?.endsWith("cli.ts")) {
  void main();
}
