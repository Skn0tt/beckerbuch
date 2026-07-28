/**
 * Smoke: bootstrap + plan + hello + WS snapshot + bash run with results.
 */
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import WebSocket from "ws";
import { createPool, migrate } from "../src/db.ts";
import {
  createDiffAwareRun,
  createRun,
  startSchedulerServer,
} from "../src/scheduler.ts";
import { withClient } from "../src/db.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function seedBaseline(pool: ReturnType<typeof createPool>): Promise<string> {
  const { runId } = await createRun(pool, {
    label: "ui-smoke-baseline",
    commands: ["echo baseline"],
  });
  await withClient(pool, async (client) => {
    await client.query("BEGIN");
    try {
      const job = await client.query<{ id: string }>(
        `SELECT id FROM jobs WHERE run_id = $1::uuid LIMIT 1`,
        [runId],
      );
      const jobId = job.rows[0]!.id;
      await client.query(
        `UPDATE jobs SET status = 'done', finished_at = now(), attempt = 1 WHERE id = $1`,
        [jobId],
      );
      const attempt = await client.query<{ id: string }>(
        `INSERT INTO job_attempts (job_id, attempt_no, worker_id, lease_token, status, finished_at)
         VALUES ($1, 1, 'seed', gen_random_uuid(), 'done', now()) RETURNING id`,
        [jobId],
      );
      await client.query(
        `INSERT INTO test_results
           (attempt_id, run_id, test_id, source, status, duration_ms, hit_lines)
         VALUES ($1::uuid, $2::uuid, 'cheap', 'seed', 'passed', 10, ARRAY['app/x.ts:1'])`,
        [attempt.rows[0]!.id, runId],
      );
      await client.query(
        `UPDATE runs SET status = 'done', finished_at = now() WHERE id = $1::uuid`,
        [runId],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });
  return runId;
}

async function main() {
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
    .withDatabase("sieve")
    .withUsername("sieve")
    .withPassword("sieve")
    .withReuse()
    .start();
  const pool = createPool(container.getConnectionUri());
  await migrate(pool);
  const baseline = await seedBaseline(pool);

  const port = 9103;
  const { close } = startSchedulerServer(pool, port);
  const base = `http://127.0.0.1:${port}`;

  // Static UI
  const html = await fetch(`${base}/`);
  assert(html.status === 200, `GET / ${html.status}`);
  const htmlText = await html.text();
  assert(htmlText.includes("Sieve"), "index should say Sieve");
  assert(htmlText.includes("/app.js"), "index should load app.js");

  const js = await fetch(`${base}/app.js`);
  assert(js.status === 200, `GET /app.js ${js.status}`);

  const boot = await (await fetch(`${base}/api/bootstrap`)).json();
  assert(boot.hasBaseline === true, "bootstrap hasBaseline");
  assert(boot.baselineRunId === baseline, "bootstrap baseline");
  assert(typeof boot.diffText === "string", "diffText");

  const plan = await (
    await fetch(`${base}/api/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        budgetMs: 60_000,
        latencyMs: 30_000,
        baselineRunId: baseline,
        diff: `
--- a/app/x.ts
+++ b/app/x.ts
@@ -1,1 +1,2 @@
+line1
`.trim(),
      }),
    })
  ).json();
  assert(plan.selected?.length === 1, `plan selected ${JSON.stringify(plan)}`);
  assert(plan.shards?.length === 1, "one shard");

  // Hello before claim
  const hello = await (
    await fetch(`${base}/workers/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: "smoke-w1", hostname: "smoke" }),
    })
  ).json();
  assert(hello.worker?.id === "smoke-w1", "hello worker");
  assert(hello.worker?.state === "idle", "idle before claim");

  // WS snapshot includes worker
  const snap = await new Promise<{ type: string; workers: unknown[] }>(
    (resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const t = setTimeout(() => reject(new Error("ws timeout")), 5000);
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === "snapshot") {
          clearTimeout(t);
          ws.close();
          resolve(msg);
        }
      });
      ws.on("error", reject);
    },
  );
  assert(
    snap.workers.some((w: any) => w.id === "smoke-w1"),
    "snapshot has smoke-w1",
  );
  console.log("[ui-smoke] bootstrap/plan/hello/ws ok");

  // End-to-end bash job via create + claim path (not Playwright)
  const created = await createDiffAwareRun(pool, {
    label: "ui-smoke-run",
    diff: `
--- a/app/x.ts
+++ b/app/x.ts
@@ -1,1 +1,2 @@
+line1
`.trim(),
    budgetMs: 60_000,
    shardCount: 1,
    baselineRunId: baseline,
  });
  assert(created.jobCount === 1, "diff run has 1 job");
  // Replace command with instant bash producer for smoke
  await pool.query(
    `UPDATE jobs SET command = $2 WHERE run_id = $1::uuid`,
    [
      created.runId,
      `echo '{"type":"test_result","testId":"cheap","status":"passed","durationMs":1,"source":"smoke","hitLines":[]}' >> "$SIEVE_RESULTS_FILE"`,
    ],
  );

  const { workerLoop } = await import("../src/worker.ts");
  await workerLoop({
    schedulerUrl: base,
    workerId: "smoke-w1",
    runId: created.runId,
    once: true,
  });

  const summary = await (await fetch(`${base}/runs/${created.runId}`)).json();
  assert(summary.run.status === "done", `run status ${summary.run.status}`);
  assert(summary.results.length >= 1, "got results");
  console.log("[ui-smoke] run+worker+results ok", summary.results[0]);

  await close();
  await pool.end();
  console.log("[ui-smoke] all checks passed");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
