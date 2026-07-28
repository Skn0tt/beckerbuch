/**
 * Long-running local serve for the HTML UI:
 *   Postgres → scheduler → real Playwright baseline → idle workers.
 *
 * Opens http://127.0.0.1:9101/ against a corpus of real cookbook tests
 * (not synthetic seed rows). When git has no app/ diff, writes a
 * bootstrap diff from baseline hit_lines so plan preview has something
 * to select.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { listSpecFiles } from "../src/cli.ts";
import { playwrightCommand } from "../src/commands.ts";
import { SchedulerClient } from "../src/client.ts";
import { createPool, migrate } from "../src/db.ts";

const SIEVE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(SIEVE_ROOT, "..");
const PORT = Number(process.env.SIEVE_PORT ?? 9101);
const WORKERS = Number(process.env.SIEVE_WORKERS ?? 2);
const DIFF_FILE = path.join(SIEVE_ROOT, ".bootstrap-diff.patch");
const DEFAULT_SPECS = ["tests/smoke.spec.ts"];

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnTsx(
  scriptRel: string,
  env: Record<string, string | undefined>,
  name: string,
): ChildProcess {
  const tsxBin = path.join(SIEVE_ROOT, "node_modules/.bin/tsx");
  const child = spawn(tsxBin, [path.join(SIEVE_ROOT, scriptRel)], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (c: Buffer) => process.stdout.write(`[${name}] ${c}`));
  child.stderr?.on("data", (c: Buffer) => process.stderr.write(`[${name}] ${c}`));
  return child;
}

/** Build a unified diff whose added app/ lines match baseline coverage keys. */
function diffFromHitLines(hitLines: string[], maxLines = 40): string {
  const byFile = new Map<string, number[]>();
  for (const key of hitLines) {
    const i = key.lastIndexOf(":");
    if (i < 0) continue;
    const file = key.slice(0, i);
    const line = Number(key.slice(i + 1));
    if (!file.startsWith("app/") || !Number.isFinite(line) || line < 1) continue;
    const arr = byFile.get(file) ?? [];
    arr.push(line);
    byFile.set(file, arr);
  }

  const parts: string[] = [];
  let remaining = maxLines;
  for (const [file, lines] of byFile) {
    if (remaining <= 0) break;
    const uniq = [...new Set(lines)].sort((a, b) => a - b).slice(0, remaining);
    if (uniq.length === 0) continue;
    remaining -= uniq.length;
    parts.push(`--- a/${file}`);
    parts.push(`+++ b/${file}`);
    for (const ln of uniq) {
      parts.push(`@@ -${ln},0 +${ln},1 @@`);
      parts.push(`+touched by serve-ui bootstrap`);
    }
  }
  return parts.join("\n") + (parts.length ? "\n" : "");
}

async function main() {
  const specArg = process.env.SIEVE_SPECS;
  const specs = await listSpecFiles(
    specArg
      ? specArg
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : DEFAULT_SPECS,
  );
  const commands = specs.map(playwrightCommand);
  console.log(`[serve-ui] baseline specs: ${specs.join(", ")}`);

  const container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
    .withDatabase("sieve")
    .withUsername("sieve")
    .withPassword("sieve")
    .withReuse()
    .start();
  const databaseUrl = container.getConnectionUri();

  {
    const warm = createPool(databaseUrl);
    await migrate(warm);
    await warm.end();
  }

  const children: ChildProcess[] = [];
  const scheduler = spawnTsx(
    "src/scheduler.ts",
    {
      SIEVE_DATABASE_URL: databaseUrl,
      SIEVE_PORT: String(PORT),
      SIEVE_REPO_ROOT: REPO_ROOT,
      SIEVE_BOOTSTRAP_DIFF_FILE: DIFF_FILE,
    },
    "scheduler",
  );
  children.push(scheduler);

  const client = new SchedulerClient(`http://127.0.0.1:${PORT}`);
  for (let i = 0; i < 50; i++) {
    if (await client.health()) break;
    await sleep(200);
  }
  if (!(await client.health())) throw new Error("scheduler not healthy");

  console.log("[serve-ui] creating Playwright baseline run…");
  const created = await client.createRun(
    `ui-baseline-${new Date().toISOString()}`,
    commands,
  );
  console.log(
    `[serve-ui] baseline run ${created.runId} (${created.jobCount} job(s))`,
  );

  for (let i = 0; i < WORKERS; i++) {
    children.push(
      spawnTsx(
        "src/worker.ts",
        {
          SIEVE_SCHEDULER_URL: `http://127.0.0.1:${PORT}`,
          SIEVE_WORKER_ID: `w${i + 1}`,
          SIEVE_RUN_ID: created.runId,
          SIEVE_WORKDIR: REPO_ROOT,
          PLAYWRIGHT_FORCE_ASYNC_LOADER: "1",
        },
        `worker-w${i + 1}`,
      ),
    );
  }

  const deadline =
    Date.now() + Number(process.env.SIEVE_DEMO_TIMEOUT_MS ?? 1_800_000);
  let summary: Awaited<ReturnType<SchedulerClient["getRun"]>> | undefined;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error("baseline timed out");
    }
    summary = await client.getRun(created.runId);
    const status = summary.run.status;
    console.log(
      `[serve-ui] baseline status=${status} results=${summary.results.length}`,
    );
    if (status === "done" || status === "failed") break;
    await sleep(5_000);
  }

  if (summary!.run.status !== "done") {
    throw new Error(
      `baseline run ${summary!.run.status} — need a successful run for corpus (attempt status=done)`,
    );
  }
  if (summary!.results.length === 0) {
    throw new Error("baseline run done but has 0 results");
  }
  console.log(
    `[serve-ui] baseline ready: ${summary!.results.length} real test result(s)`,
  );
  for (const r of summary!.results.slice(0, 12)) {
    console.log(
      `  ${String(r.source)} ${String(r.test_id).slice(0, 24)}… hits=${String(r.hit_line_count)}`,
    );
  }

  // Prefer real git diff; if empty (common on a clean worktree), synthesize
  // from coverage so the UI plan lists real cookbook tests.
  const pool = createPool(databaseUrl);
  const hits = await pool.query<{ hit_lines: string[] }>(
    `SELECT hit_lines FROM test_results
     WHERE run_id = $1::uuid AND cardinality(hit_lines) > 0`,
    [created.runId],
  );
  await pool.end();

  const allHits = hits.rows.flatMap((r) => r.hit_lines ?? []);
  const synthesized = diffFromHitLines(allHits);
  if (!synthesized.trim()) {
    console.warn(
      "[serve-ui] baseline has no app/ hit_lines — plan preview may be empty",
    );
  } else {
    await writeFile(DIFF_FILE, synthesized, "utf8");
    console.log(
      `[serve-ui] wrote ${DIFF_FILE} (${allHits.length} coverage keys → bootstrap diff)`,
    );
  }

  // Drop run-scoped workers; spawn idle ones for the UI to observe.
  for (const c of children.slice(1)) {
    try {
      c.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  children.length = 1;
  await sleep(500);

  for (let i = 1; i <= WORKERS; i++) {
    children.push(
      spawnTsx(
        "src/worker.ts",
        {
          SIEVE_SCHEDULER_URL: `http://127.0.0.1:${PORT}`,
          SIEVE_WORKER_ID: `w${i}`,
          SIEVE_WORKDIR: REPO_ROOT,
          PLAYWRIGHT_FORCE_ASYNC_LOADER: "1",
        },
        `worker-w${i}`,
      ),
    );
  }

  console.log(`[serve-ui] open http://127.0.0.1:${PORT}/  (Ctrl+C to stop)`);

  const shutdown = () => {
    for (const c of children) {
      try {
        c.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => undefined);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
