/**
 * End-to-end local demo:
 *   Postgres → 1 scheduler → N workers running bash jobs.
 * Default jobs wrap Playwright specs that emit the result-stream protocol.
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { SchedulerClient } from "../src/client.ts";
import { playwrightFullCommand } from "../src/commands.ts";

const SIEVE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const REPO_ROOT = path.resolve(SIEVE_ROOT, "..");
const SCHEDULER_PORT = Number(process.env.SIEVE_PORT ?? 9101);
const SCHEDULER_URL = `http://127.0.0.1:${SCHEDULER_PORT}`;

/** Optional comma-separated paths; omit for full suite discovery. */
function resolveFiles(): string[] | undefined {
  const specArg = process.env.SIEVE_SPECS;
  if (!specArg) return ["tests/coverage-select.unit.spec.ts"];
  if (specArg.trim() === "*" || specArg.trim() === "all") return undefined;
  return specArg
    .split(",")
    .map((s) => s.trim().replace(/^\.\//, ""))
    .filter(Boolean);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnTsx(
  scriptRel: string,
  env: Record<string, string | undefined>,
  name: string,
): ChildProcess {
  const tsxBin = path.join(SIEVE_ROOT, "node_modules/.bin/tsx");
  const { PLAYWRIGHT_BROWSERS_PATH: _drop, ...baseEnv } = process.env;
  const child = spawn(tsxBin, [path.join(SIEVE_ROOT, scriptRel)], {
    cwd: REPO_ROOT,
    env: { ...baseEnv, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (c: Buffer) => {
    process.stdout.write(`[${name}] ${c.toString("utf8")}`);
  });
  child.stderr?.on("data", (c: Buffer) => {
    process.stderr.write(`[${name}] ${c.toString("utf8")}`);
  });
  return child;
}

function killChild(child: ChildProcess | undefined): void {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
}

async function waitForHealth(client: SchedulerClient, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.health()) return;
    await sleep(200);
  }
  throw new Error("scheduler did not become healthy");
}

async function main() {
  const workerCount = Number(process.env.SIEVE_WORKERS ?? 2);
  const files = resolveFiles();
  const command = playwrightFullCommand({ files });
  const commands = [command];

  console.log(`[demo] jobs (bash):`);
  for (const c of commands) console.log(`  - ${c}`);
  console.log(`[demo] workers: ${workerCount}`);

  console.log("[demo] starting Postgres (testcontainers)...");
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
    .withDatabase("sieve")
    .withUsername("sieve")
    .withPassword("sieve")
    .withReuse()
    .start();
  const databaseUrl = container.getConnectionUri();
  console.log(`[demo] Postgres at ${databaseUrl}`);

  const children: ChildProcess[] = [];
  const scheduler = spawnTsx(
    "src/scheduler.ts",
    {
      SIEVE_DATABASE_URL: databaseUrl,
      SIEVE_PORT: String(SCHEDULER_PORT),
      SIEVE_LEASE_SECONDS: process.env.SIEVE_LEASE_SECONDS ?? "30",
      SIEVE_REAPER_MS: process.env.SIEVE_REAPER_MS ?? "5000",
    },
    "scheduler",
  );
  children.push(scheduler);

  const client = new SchedulerClient(SCHEDULER_URL);
  try {
    await waitForHealth(client, 30_000);

    const created = await client.createRun(
      `demo-${new Date().toISOString()}`,
      commands,
    );
    console.log(
      `[demo] created run ${created.runId} with ${created.jobCount} job(s)`,
    );

    for (let i = 0; i < workerCount; i++) {
      children.push(
        spawnTsx(
          "src/worker.ts",
          {
            SIEVE_SCHEDULER_URL: SCHEDULER_URL,
            SIEVE_WORKER_ID: `demo-worker-${i}`,
            SIEVE_RUN_ID: created.runId,
            SIEVE_ONCE: "0",
            SIEVE_IDLE_POLL_MS: "500",
            SIEVE_WORKDIR: REPO_ROOT,
            PLAYWRIGHT_FORCE_ASYNC_LOADER: "1",
          },
          `worker-${i}`,
        ),
      );
    }

    const deadline =
      Date.now() + Number(process.env.SIEVE_DEMO_TIMEOUT_MS ?? 1_800_000);
    let summary: Awaited<ReturnType<SchedulerClient["getRun"]>> | undefined;
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error("demo timed out waiting for run to finish");
      }
      summary = await client.getRun(created.runId);
      const status = summary.run.status;
      console.log(
        `[demo] run status=${status} jobs=${summary.jobs
          .map(
            (j) =>
              `${String(j.status)}:${String(j.command).slice(0, 40).replace(/\s+/g, " ")}`,
          )
          .join(" | ")}`,
      );
      if (status === "done" || status === "failed") break;
      await sleep(5_000);
    }

    console.log("\n========== DEMO SUMMARY ==========");
    console.log(`run: ${summary!.run.id} (${summary!.run.status})`);
    for (const job of summary!.jobs) {
      console.log(
        `  job status=${String(job.status)} attempt=${String(job.attempt)} worker=${String(job.worker_id ?? "-")}`,
      );
      console.log(`       cmd: ${String(job.command)}`);
    }
    console.log(`test results (${summary!.results.length}):`);
    for (const r of summary!.results) {
      console.log(
        `  ${String(r.source)} ${String(r.test_id)} status=${String(r.status)} duration_ms=${String(r.duration_ms)} hit_lines=${String(r.hit_line_count)}`,
      );
    }
    console.log("==================================\n");

    if (summary!.run.status !== "done") {
      process.exitCode = 1;
    }
  } finally {
    for (const child of children) killChild(child);
  }
}

void main().catch((err) => {
  console.error("[demo] failed", err);
  process.exit(1);
});
