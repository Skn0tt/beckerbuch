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
  });
  child.stdout?.on("data", (c: Buffer) => process.stdout.write(`[${name}] ${c}`));
  child.stderr?.on("data", (c: Buffer) => process.stderr.write(`[${name}] ${c}`));
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
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `missing ${FIXTURE} — run \`npm run run-full\` once (with serve-ui up) to dump a local corpus`,
      );
    }
    throw err;
  }

  const baseline = await pool.query<{ id: string; n: string }>(
    `SELECT r.id, count(tr.id)::text AS n
     FROM runs r
     JOIN test_results tr ON tr.run_id = r.id
     WHERE r.status = 'done'
     GROUP BY r.id
     ORDER BY r.finished_at DESC NULLS LAST
     LIMIT 1`,
  );
  if (!baseline.rowCount) {
    throw new Error("fixture loaded but no done run with results");
  }
  console.log(
    `[serve-ui] baseline ${baseline.rows[0]!.id} (${baseline.rows[0]!.n} results)`,
  );
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
