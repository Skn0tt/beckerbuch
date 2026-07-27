/**
 * Proves two concurrent claimers never receive the same job
 * (FOR UPDATE SKIP LOCKED), and that fencing tokens reject stale completes.
 */

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createPool, migrate } from "../src/db.ts";
import {
  claimJob,
  completeJob,
  createRun,
  reapExpiredLeases,
  startSchedulerServer,
} from "../src/scheduler.ts";
import { SchedulerClient } from "../src/client.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
    .withDatabase("cipoc")
    .withUsername("cipoc")
    .withPassword("cipoc")
    .withReuse()
    .start();
  const databaseUrl = container.getConnectionUri();
  const pool = createPool(databaseUrl);
  await migrate(pool);

  // Direct DB race (no HTTP) — strongest proof of SKIP LOCKED.
  const files = Array.from({ length: 20 }, (_, i) => `tests/fake-${i}.spec.ts`);
  const { runId } = await createRun(pool, {
    label: "claim-race",
    specFiles: files,
  });

  const workers = Array.from({ length: 8 }, (_, i) => `race-worker-${i}`);
  const claims = await Promise.all(
    workers.map((workerId) =>
      Promise.all(
        Array.from({ length: 3 }, () => claimJob(pool, { workerId, runId })),
      ),
    ),
  );

  const flat = claims.flat().filter(Boolean) as Array<{ jobId: string }>;
  const ids = flat.map((j) => j.jobId);
  const unique = new Set(ids);
  console.log(
    `[claim-race] direct: claimed=${ids.length} unique=${unique.size}`,
  );
  if (ids.length !== unique.size) {
    throw new Error("SKIP LOCKED violated: duplicate job ids in direct claims");
  }

  // Also race through the HTTP scheduler frontend.
  const port = 9102;
  const { close } = startSchedulerServer(pool, port);
  const client = new SchedulerClient(`http://127.0.0.1:${port}`);
  const { runId: runId2 } = await client.createRun(
    "claim-race-http",
    files.map((f) => f.replace("fake-", "http-fake-")),
  );

  await sleep(100);
  const httpClaims = await Promise.all(
    workers.map((workerId) =>
      Promise.all(
        Array.from({ length: 3 }, () => client.claim(workerId, runId2)),
      ),
    ),
  );
  const httpFlat = httpClaims.flat().filter(Boolean) as Array<{ jobId: string }>;
  const httpIds = httpFlat.map((j) => j.jobId);
  const httpUnique = new Set(httpIds);
  console.log(
    `[claim-race] http: claimed=${httpIds.length} unique=${httpUnique.size}`,
  );
  if (httpIds.length !== httpUnique.size) {
    throw new Error("SKIP LOCKED violated: duplicate job ids via HTTP");
  }

  // Fencing: complete with a stale lease_token must fail after reclaim.
  const { runId: fenceRun } = await createRun(pool, {
    label: "fence",
    specFiles: ["tests/fence.spec.ts"],
  });
  const first = await claimJob(pool, { workerId: "fence-a", runId: fenceRun });
  if (!first) throw new Error("expected first claim");
  await pool.query(
    `UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [first.jobId],
  );
  await reapExpiredLeases(pool);
  const second = await claimJob(pool, { workerId: "fence-b", runId: fenceRun });
  if (!second) throw new Error("expected reclaim after expiry");
  const stale = await completeJob(pool, {
    jobId: first.jobId,
    leaseToken: first.leaseToken,
    attemptId: first.attemptId,
    ok: true,
  });
  if (stale !== "lost_lease") {
    throw new Error(`expected stale complete to be lost_lease, got ${stale}`);
  }
  const fresh = await completeJob(pool, {
    jobId: second.jobId,
    leaseToken: second.leaseToken,
    attemptId: second.attemptId,
    ok: true,
  });
  if (fresh !== "ok") throw new Error(`expected fresh complete ok, got ${fresh}`);
  console.log("[claim-race] fencing: stale complete rejected, fresh accepted");

  await close();
  await pool.end();
  console.log("[claim-race] ok");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
