/**
 * Drill: seed a baseline run with synthetic test_results, then create a
 * diff-aware run scoped to that baseline and assert selection + packing.
 */

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createPool, migrate, withClient } from "../src/db.ts";
import { packShards } from "../src/pack.ts";
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
    assert(packed.length === 2, "expected 2 non-empty shards");
    const heavyShard = packed.find((s) => s.includes("c"));
    const lightShard = packed.find((s) => s.includes("a"));
    assert(heavyShard != null && lightShard != null, "missing shards");
    assert(
      heavyShard!.includes("c") && !heavyShard!.includes("a"),
      `heavy should be alone, got ${JSON.stringify(heavyShard)}`,
    );
    assert(
      lightShard!.includes("a") && lightShard!.includes("b"),
      `same-file lights together, got ${JSON.stringify(lightShard)}`,
    );
    console.log("[diff-schedule] packShards file-aware ok", packed);
  }

  {
    const packed = packShards(
      ["cheap", "other"],
      { cheap: 10, other: 10 },
      2,
      { cheap: "tests/a.spec.ts", other: "tests/b.spec.ts" },
    );
    assert(packed.length === 2, "expected 2 shards");
    assert(
      packed.some((s) => s[0] === "cheap") &&
        packed.some((s) => s[0] === "other"),
      "each file on its own shard",
    );
    console.log("[diff-schedule] packShards two-files ok", packed);
  }

  // Separate DB from serve-ui's reused `sieve` so drills don't wipe the
  // demo corpus (migrate() is drop-and-recreate).
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
    .withDatabase("sieve_drill")
    .withUsername("sieve")
    .withPassword("sieve")
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
  const small = await createDiffAwareRun(pool, {
    label: "diff-small",
    diff,
    budgetMs: 10,
    shardCount: 2,
    baselineRunId,
  });
  assert(small.baselineRunId === baselineRunId, "baseline echoed");
  assert(
    JSON.stringify(small.selectedTestIds) === JSON.stringify(["cheap"]),
    `expected [cheap], got ${JSON.stringify(small.selectedTestIds)}`,
  );
  assert(small.jobCount === 1, "one non-empty shard");
  assert(small.shards[0]!.testIds[0] === "cheap", "shard holds cheap");
  console.log("[diff-schedule] small budget ok", small);

  // Budget 20 → cheap + other, packed across 2 shards.
  const mid = await createDiffAwareRun(pool, {
    label: "diff-mid",
    diff,
    budgetMs: 20,
    shardCount: 2,
    baselineRunId,
  });
  assert(mid.jobCount === 2, `expected 2 shards, got ${mid.jobCount}`);
  assert(
    mid.selectedTestIds[0] === "cheap" && mid.selectedTestIds.includes("other"),
    `unexpected selection ${JSON.stringify(mid.selectedTestIds)}`,
  );
  const midFlat = mid.shards.flatMap((s) => s.testIds).sort();
  assert(
    JSON.stringify(midFlat) === JSON.stringify(["cheap", "other"].sort()),
    `shard contents ${JSON.stringify(midFlat)}`,
  );
  console.log("[diff-schedule] mid budget / 2 shards ok", mid);

  // Empty selection → 0 jobs, run done.
  const emptyDiff = `
--- a/app/never.ts
+++ b/app/never.ts
@@ -1,1 +1,2 @@
+nope
`.trim();
  const empty = await createDiffAwareRun(pool, {
    label: "diff-empty",
    diff: emptyDiff,
    budgetMs: 1000,
    baselineRunId,
  });
  assert(empty.jobCount === 0, "empty selection → 0 jobs");
  assert(empty.selectedTestIds.length === 0, "no selected ids");
  const emptyStatus = await pool.query<{ status: string }>(
    `SELECT status FROM runs WHERE id = $1::uuid`,
    [empty.runId],
  );
  assert(emptyStatus.rows[0]!.status === "done", "empty run marked done");
  console.log("[diff-schedule] empty selection ok", empty);

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
    // Poison "other" baseline with a test that would change selection if merged.
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

  const scoped = await createDiffAwareRun(pool, {
    label: "diff-scoped",
    diff,
    budgetMs: 10,
    baselineRunId, // original, not poisoned
  });
  assert(
    !scoped.selectedTestIds.includes("poison"),
    "must not see poison from other run",
  );
  assert(
    JSON.stringify(scoped.selectedTestIds) === JSON.stringify(["cheap"]),
    `scoped selection ${JSON.stringify(scoped.selectedTestIds)}`,
  );
  console.log("[diff-schedule] baseline scoping ok");

  await pool.end();
  console.log("[diff-schedule] all checks passed");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
