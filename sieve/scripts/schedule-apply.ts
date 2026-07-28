/**
 * Synthetic drill: apply schedule.json on complete, unlock flake, skip when
 * failures empty / fail flake when dep failed without failures.json.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import {
  ensureJobDir,
  FAILURES_FILENAME,
  SCHEDULE_FILENAME,
} from "../src/artifacts.ts";
import { createPool, migrate, withClient } from "../src/db.ts";
import { claimJob, completeJob, createRun } from "../src/scheduler.ts";
import { unlockDependents } from "../src/unlock.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
    .withReuse()
    .start();
  const pool = createPool(container.getConnectionUri());
  await migrate(pool);

  // --- schedule apply on planner complete ---
  {
    const { runId } = await createRun(pool, {
      label: "sched-apply",
      commands: ["echo planner-placeholder"],
    });
    await pool.query(
      `UPDATE jobs SET name = 'planner', kind = 'planner' WHERE run_id = $1::uuid`,
      [runId],
    );
    const jobRow = await pool.query<{ id: string }>(
      `SELECT id FROM jobs WHERE run_id = $1::uuid`,
      [runId],
    );
    const plannerId = jobRow.rows[0]!.id;
    const dir = await ensureJobDir(runId, plannerId);
    await writeFile(
      path.join(dir, SCHEDULE_FILENAME),
      JSON.stringify({
        jobs: [
          { name: "shard-0", kind: "shard", command: "echo s0" },
          { name: "shard-1", kind: "shard", command: "echo s1" },
          {
            name: "flake-rerun",
            kind: "flake_rerun",
            command: "echo flake",
            needs: ["shard-0", "shard-1"],
          },
        ],
      }),
      "utf8",
    );

    const claimed = await claimJob(pool, { workerId: "w1", runId });
    assert(claimed?.jobId === plannerId, "claimed planner");
    const done = await completeJob(pool, {
      jobId: claimed!.jobId,
      leaseToken: claimed!.leaseToken,
      attemptId: claimed!.attemptId,
      ok: true,
    });
    assert(typeof done === "object" && done.ok, "complete ok");
    assert(
      typeof done === "object" && done.jobStatus === "done",
      "planner done after apply",
    );

    const jobs = await pool.query<{ name: string; status: string }>(
      `SELECT name, status FROM jobs WHERE run_id = $1::uuid ORDER BY name`,
      [runId],
    );
    const byName = Object.fromEntries(jobs.rows.map((j) => [j.name, j.status]));
    assert(byName["planner"] === "done", "planner done");
    assert(byName["shard-0"] === "queued", "shard-0 queued");
    assert(byName["shard-1"] === "queued", "shard-1 queued");
    assert(byName["flake-rerun"] === "blocked", "flake blocked");
    console.log("[schedule-apply] apply on complete ok");
  }

  // --- unlock flake → skipped when failures empty ---
  {
    const { runId } = await createRun(pool, {
      label: "flake-skip",
      commands: ["echo a", "echo b"],
    });
    const ids = await pool.query<{ id: string }>(
      `SELECT id FROM jobs WHERE run_id = $1::uuid ORDER BY id`,
      [runId],
    );
    const s0 = ids.rows[0]!.id;
    const s1 = ids.rows[1]!.id;
    await pool.query(`UPDATE jobs SET name = 'shard-0', kind = 'shard' WHERE id = $1`, [
      s0,
    ]);
    await pool.query(`UPDATE jobs SET name = 'shard-1', kind = 'shard' WHERE id = $1`, [
      s1,
    ]);
    const flake = await pool.query<{ id: string }>(
      `INSERT INTO jobs (run_id, command, status, name, kind)
       VALUES ($1::uuid, 'echo flake', 'blocked', 'flake-rerun', 'flake_rerun')
       RETURNING id`,
      [runId],
    );
    const flakeId = flake.rows[0]!.id;
    await pool.query(
      `INSERT INTO job_deps (job_id, depends_on_job_id) VALUES
         ($1::uuid, $2::uuid), ($1::uuid, $3::uuid)`,
      [flakeId, s0, s1],
    );

    for (const id of [s0, s1]) {
      const dir = await ensureJobDir(runId, id);
      await writeFile(path.join(dir, FAILURES_FILENAME), "[]\n", "utf8");
      await pool.query(
        `UPDATE jobs SET status = 'done', finished_at = now() WHERE id = $1`,
        [id],
      );
    }
    await withClient(pool, async (client) => {
      await unlockDependents(client, runId);
    });
    const st = await pool.query<{ status: string }>(
      `SELECT status FROM jobs WHERE id = $1::uuid`,
      [flakeId],
    );
    assert(st.rows[0]!.status === "skipped", "flake skipped on empty failures");
    console.log("[schedule-apply] flake skip on empty ok");
  }

  // --- unlock flake → failed when dep failed without failures.json ---
  {
    const { runId } = await createRun(pool, {
      label: "flake-incomplete",
      commands: ["echo a"],
    });
    const s0 = (
      await pool.query<{ id: string }>(
        `SELECT id FROM jobs WHERE run_id = $1::uuid`,
        [runId],
      )
    ).rows[0]!.id;
    await pool.query(
      `UPDATE jobs SET name = 'shard-0', kind = 'shard', status = 'failed', finished_at = now()
       WHERE id = $1`,
      [s0],
    );
    await ensureJobDir(runId, s0); // dir exists, no failures.json

    const flake = await pool.query<{ id: string }>(
      `INSERT INTO jobs (run_id, command, status, name, kind)
       VALUES ($1::uuid, 'echo flake', 'blocked', 'flake-rerun', 'flake_rerun')
       RETURNING id`,
      [runId],
    );
    await pool.query(
      `INSERT INTO job_deps (job_id, depends_on_job_id) VALUES ($1::uuid, $2::uuid)`,
      [flake.rows[0]!.id, s0],
    );
    await withClient(pool, async (client) => {
      await unlockDependents(client, runId);
    });
    const st = await pool.query<{ status: string }>(
      `SELECT status FROM jobs WHERE id = $1::uuid`,
      [flake.rows[0]!.id],
    );
    assert(st.rows[0]!.status === "failed", "flake failed on incomplete outputs");
    console.log("[schedule-apply] flake incomplete → failed ok");
  }

  await pool.end();
  console.log("[schedule-apply] all checks passed");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
