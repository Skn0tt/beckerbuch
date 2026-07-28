/**
 * Long-running local serve for the HTML UI:
 *   Postgres → load fixtures/baseline.sql → scheduler → idle workers.
 *
 * Opens http://127.0.0.1:9101/. Plan/Run use uncommitted git changes
 * (`git diff HEAD`) from the repo root — no synthetic bootstrap diff.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { SchedulerClient } from "../src/client.ts";
import { createPool, migrate } from "../src/db.ts";

const SIEVE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(SIEVE_ROOT, "..");
const PORT = Number(process.env.SIEVE_PORT ?? 9101);
const WORKERS = Number(process.env.SIEVE_WORKERS ?? 2);
const FIXTURE = path.join(SIEVE_ROOT, "fixtures", "baseline.sql");
const DATABASE_URL_FILE = path.join(SIEVE_ROOT, ".database-url");

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnTsx(
  scriptRel: string,
  env: Record<string, string | undefined>,
  name: string,
): ChildProcess {
  const tsxBin = path.join(SIEVE_ROOT, "node_modules/.bin/tsx");
  // Drop Cursor sandbox browser cache — workers need the real Playwright install.
  const { PLAYWRIGHT_BROWSERS_PATH: _drop, ...baseEnv } = process.env;
  const child = spawn(tsxBin, [path.join(SIEVE_ROOT, scriptRel)], {
    cwd: REPO_ROOT,
    env: { ...baseEnv, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    // Survive parent exit / SIGHUP when the controlling shell goes away.
    detached: true,
  });
  child.stdout?.on("data", (c: Buffer) => process.stdout.write(`[${name}] ${c}`));
  child.stderr?.on("data", (c: Buffer) => process.stderr.write(`[${name}] ${c}`));
  child.unref();
  return child;
}

async function main() {
  // Cursor sandbox sets this to a cache without browsers; drop it for workers.
  delete process.env.PLAYWRIGHT_BROWSERS_PATH;

  console.log("[serve-ui] starting Postgres…");
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
    .withDatabase("sieve")
    .withUsername("sieve")
    .withPassword("sieve")
    .withReuse()
    .start();
  const databaseUrl = container.getConnectionUri();
  await writeFile(DATABASE_URL_FILE, databaseUrl + "\n", "utf8");
  console.log(`[serve-ui] wrote ${DATABASE_URL_FILE}`);

  const pool = createPool(databaseUrl);
  await migrate(pool);
  try {
    console.log(`[serve-ui] loading ${FIXTURE}`);
    const sql = await readFile(FIXTURE, "utf8");
    await pool.query(sql);
    const baseline = await pool.query<{ id: string; n: string }>(
      `SELECT r.id, count(tr.id)::text AS n
       FROM runs r
       JOIN test_results tr ON tr.run_id = r.id
       WHERE r.status IN ('done', 'failed')
         AND r.baseline_run_id IS NULL
       GROUP BY r.id
       ORDER BY r.finished_at DESC NULLS LAST
       LIMIT 1`,
    );
    if (baseline.rowCount) {
      console.log(
        `[serve-ui] baseline ${baseline.rows[0]!.id} (${baseline.rows[0]!.n} results)`,
      );
    } else {
      console.warn(
        "[serve-ui] fixture loaded but no done run with results — UI plan needs a run-full first",
      );
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      console.warn(
        `[serve-ui] no ${FIXTURE} — empty DB; run \`npm run run-full\` to build a corpus`,
      );
    } else {
      throw err;
    }
  }
  await pool.end();

  const children: ChildProcess[] = [];
  const scheduler = spawnTsx(
    "src/scheduler.ts",
    {
      SIEVE_DATABASE_URL: databaseUrl,
      SIEVE_PORT: String(PORT),
      SIEVE_REPO_ROOT: REPO_ROOT,
      // Fixture already applied; skip drop-and-recreate on scheduler boot.
      SIEVE_SKIP_MIGRATE: "1",
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

  console.log(
    `[serve-ui] open http://127.0.0.1:${PORT}/  (Ctrl+C to stop)`,
  );
  console.log(
    "[serve-ui] plan/Run use git diff HEAD (uncommitted) under",
    REPO_ROOT,
  );

  // Ctrl+C stops the stack. SIGTERM (agent/shell teardown) must NOT —
  // children are detached so they keep serving after this parent exits.
  const shutdownChildren = () => {
    for (const c of children) {
      try {
        if (c.pid) process.kill(-c.pid, "SIGTERM");
      } catch {
        try {
          c.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdownChildren);
  process.on("SIGTERM", () => {
    console.log(
      "[serve-ui] parent exiting; scheduler/workers stay up (detached). Ctrl+C to stop them via a fresh serve-ui, or pkill -f sieve/src/scheduler.ts",
    );
    process.exit(0);
  });

  await new Promise(() => undefined);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
