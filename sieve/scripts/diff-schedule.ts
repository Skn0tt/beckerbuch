/**
 * Drill: seed a baseline run with synthetic test_results, then plan and
 * create a diff-aware (planner) run scoped to that baseline.
 */

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createPool, migrate, withClient } from "../src/db.ts";
import { packShards } from "../src/pack.ts";
import { planDiffRun } from "../src/plan.ts";
import {
  createDiffAwareRun,
  createRun,
  SchedulerRequestError,
} from "../src/scheduler.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function seedBaseline(pool: ReturnType<typeof createPool>): Promise<string> {
  const { runId } = await createRun(pool, {
    label: "baseline-seed",
    commands: ["echo baseline-seed"],
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
         VALUES ($1, 1, 'seed', gen_random_uuid(), 'done', now())
         RETURNING id`,
        [jobId],
      );
      const attemptId = attempt.rows[0]!.id;

      const rows: Array<{
        testId: string;
        durationMs: number;
        hitLines: string[];
      }> = [
        {
          testId: "cheap",
          durationMs: 10,
          hitLines: ["app/x.ts:1", "app/x.ts:2"],
        },
        {
          testId: "expensive",
          durationMs: 100,
          hitLines: ["app/x.ts:1"],
        },
        {
          testId: "other",
          durationMs: 10,
          hitLines: ["app/x.ts:2"],
        },
        {
          testId: "unrelated",
          durationMs: 5,
          hitLines: ["app/other.ts:1"],
        },
      ];

      for (const r of rows) {
        await client.query(
          `INSERT INTO test_results
             (attempt_id, run_id, test_id, source, status, duration_ms)
           VALUES ($1::uuid, $2::uuid, $3, 'seed', 'passed', $4)`,
          [attemptId, runId, r.testId, r.durationMs],
        );
        const files: string[] = [];
        const lines: number[] = [];
        for (const key of r.hitLines) {
          const i = key.lastIndexOf(":");
          files.push(key.slice(0, i));
          lines.push(Number(key.slice(i + 1)));
        }
        await client.query(
          `INSERT INTO coverage_hits (run_id, test_id, file_path, line)
           SELECT $1::uuid, $2, f, l
           FROM unnest($3::text[], $4::int[]) AS t(f, l)`,
          [runId, r.testId, files, lines],
        );
      }

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
  // Pure pack unit checks (no DB) — file-aware LPT.
  {
    const packed = packShards(
      ["a", "b", "c"],
      { a: 10, b: 10, c: 100 },
      2,
      {
        a: "tests/light.spec.ts",
        b: "tests/light.spec.ts",
        c: "tests/heavy.spec.ts",
      },
    );
    assert(packed.length === 2, "pack yields 2 shards");
    console.log("[diff-schedule] packShards smoke ok");
  }

  const container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
    .withReuse()
    .start();
  const pool = createPool(container.getConnectionUri());
  await migrate(pool);

  const baselineRunId = await seedBaseline(pool);
  console.log(`[diff-schedule] baseline=${baselineRunId}`);

  const diff = `
--- a/app/x.ts
+++ b/app/x.ts
@@ -1,2 +1,2 @@
+line1
+line2
`.trim();

  // Budget 10 → only "cheap" (covers both lines).
  const smallPlan = await withClient(pool, (client) =>
    planDiffRun(client, {
      diff,
      budgetMs: 10,
      shardCount: 2,
      baselineRunId,
    }),
  );
  assert(
    JSON.stringify(smallPlan.selectedTestIds) === JSON.stringify(["cheap"]),
    `expected [cheap], got ${JSON.stringify(smallPlan.selectedTestIds)}`,
  );
  assert(smallPlan.shards.length === 1, "one non-empty shard");
  assert(smallPlan.shards[0]!.testIds[0] === "cheap", "shard holds cheap");
  console.log("[diff-schedule] small budget plan ok");

  const small = await createDiffAwareRun(pool, {
    label: "diff-small",
    diff,
    budgetMs: 10,
    shardCount: 2,
    baselineRunId,
  });
  assert(small.baselineRunId === baselineRunId, "baseline echoed");
  assert(small.jobCount === 1, "async create enqueues planner only");
  const smallJobs = await pool.query<{ name: string | null; kind: string | null }>(
    `SELECT name, kind FROM jobs WHERE run_id = $1::uuid`,
    [small.runId],
  );
  assert(smallJobs.rows.length === 1, "only planner job at create");
  assert(smallJobs.rows[0]!.kind === "planner", "kind=planner");
  console.log("[diff-schedule] small create (planner) ok", small);

  // Budget 20 → cheap + other, packed across 2 shards.
  const midPlan = await withClient(pool, (client) =>
    planDiffRun(client, {
      diff,
      budgetMs: 20,
      shardCount: 2,
      baselineRunId,
    }),
  );
  assert(midPlan.shards.length === 2, `expected 2 shards, got ${midPlan.shards.length}`);
  assert(
    midPlan.selectedTestIds[0] === "cheap" &&
      midPlan.selectedTestIds.includes("other"),
    `unexpected selection ${JSON.stringify(midPlan.selectedTestIds)}`,
  );
  const midFlat = midPlan.shards.flatMap((s) => s.testIds).sort();
  assert(
    JSON.stringify(midFlat) === JSON.stringify(["cheap", "other"].sort()),
    `shard contents ${JSON.stringify(midFlat)}`,
  );
  console.log("[diff-schedule] mid budget / 2 shards plan ok");

  // Empty selection → planner still enqueued (jobCount 1); planner writes no schedule.
  const emptyDiff = `
--- a/app/never.ts
+++ b/app/never.ts
@@ -1,1 +1,2 @@
+nope
`.trim();
  const emptyPlan = await withClient(pool, (client) =>
    planDiffRun(client, {
      diff: emptyDiff,
      budgetMs: 1000,
      shardCount: 2,
      baselineRunId,
    }),
  );
  assert(emptyPlan.selectedTestIds.length === 0, "no selected ids");
  assert(emptyPlan.shards.length === 0, "empty selection → 0 shards");
  const empty = await createDiffAwareRun(pool, {
    label: "diff-empty",
    diff: emptyDiff,
    budgetMs: 1000,
    baselineRunId,
  });
  assert(empty.jobCount === 1, "planner still queued for empty plan");
  console.log("[diff-schedule] empty selection create ok", empty);

  // Missing baseline → error.
  try {
    await createDiffAwareRun(pool, {
      label: "bad",
      diff,
      budgetMs: 10,
      baselineRunId: "00000000-0000-0000-0000-000000000000",
    });
    throw new Error("expected baseline_run_not_found");
  } catch (err) {
    assert(
      err instanceof SchedulerRequestError && err.code === "baseline_run_not_found",
      `unexpected error ${String(err)}`,
    );
    console.log("[diff-schedule] missing baseline ok");
  }

  // Default baseline = most recent finished *corpus* run (baseline_run_id IS NULL).
  const defaulted = await createDiffAwareRun(pool, {
    label: "diff-default-baseline",
    diff,
    budgetMs: 10,
  });
  assert(
    defaulted.baselineRunId === baselineRunId,
    `default baseline ${defaulted.baselineRunId} !== ${baselineRunId}`,
  );
  console.log("[diff-schedule] default baseline ok", defaulted.baselineRunId);

  // Corpus must not stitch a second run's rows when baseline is explicit.
  const otherBaseline = await seedBaseline(pool);
  await withClient(pool, async (client) => {
    const attempt = await client.query<{ id: string }>(
      `SELECT ja.id
       FROM job_attempts ja
       JOIN jobs j ON j.id = ja.job_id
       WHERE j.run_id = $1::uuid AND ja.status = 'done'
       LIMIT 1`,
      [otherBaseline],
    );
    await client.query(
      `DELETE FROM coverage_hits WHERE run_id = $1::uuid`,
      [otherBaseline],
    );
    await client.query(
      `INSERT INTO test_results
         (attempt_id, run_id, test_id, source, status, duration_ms)
       VALUES ($1::uuid, $2::uuid, 'poison', 'seed', 'passed', 1)
       ON CONFLICT DO NOTHING`,
      [attempt.rows[0]!.id, otherBaseline],
    );
    await client.query(
      `INSERT INTO coverage_hits (run_id, test_id, file_path, line) VALUES
         ($1::uuid, 'poison', 'app/x.ts', 1),
         ($1::uuid, 'poison', 'app/x.ts', 2)
       ON CONFLICT DO NOTHING`,
      [otherBaseline],
    );
  });

  const scopedPlan = await withClient(pool, (client) =>
    planDiffRun(client, {
      diff,
      budgetMs: 10,
      shardCount: 2,
      baselineRunId,
    }),
  );
  assert(
    !scopedPlan.selectedTestIds.includes("poison"),
    "must not see poison from other run",
  );
  assert(
    JSON.stringify(scopedPlan.selectedTestIds) === JSON.stringify(["cheap"]),
    `scoped selection ${JSON.stringify(scopedPlan.selectedTestIds)}`,
  );
  console.log("[diff-schedule] baseline scoping ok");

  await pool.end();
  console.log("[diff-schedule] all checks passed");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
