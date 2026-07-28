/**
 * Unlock blocked jobs when their dependencies become terminal.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { FAILURES_FILENAME, jobDir } from "./artifacts.ts";

const TERMINAL = new Set(["done", "failed", "skipped"]);

type DepRow = {
  depends_on_job_id: string;
  status: string;
  name: string | null;
};

export async function unlockDependents(
  client: pg.PoolClient,
  runId: string,
): Promise<void> {
  const blocked = await client.query<{ id: string; kind: string | null }>(
    `SELECT id, kind FROM jobs
     WHERE run_id = $1::uuid AND status = 'blocked'
     ORDER BY priority ASC, id`,
    [runId],
  );

  for (const job of blocked.rows) {
    const deps = await client.query<DepRow>(
      `SELECT d.depends_on_job_id, dep.status, dep.name
       FROM job_deps d
       JOIN jobs dep ON dep.id = d.depends_on_job_id
       WHERE d.job_id = $1::uuid`,
      [job.id],
    );
    if (deps.rows.length === 0) {
      await client.query(
        `UPDATE jobs SET status = 'queued' WHERE id = $1::uuid AND status = 'blocked'`,
        [job.id],
      );
      continue;
    }
    if (!deps.rows.every((d) => TERMINAL.has(d.status))) continue;

    if (job.kind === "flake_rerun") {
      await unlockFlakeRerun(client, runId, job.id, deps.rows);
    } else {
      await client.query(
        `UPDATE jobs SET status = 'queued' WHERE id = $1::uuid AND status = 'blocked'`,
        [job.id],
      );
    }
  }
}

async function unlockFlakeRerun(
  client: pg.PoolClient,
  runId: string,
  flakeJobId: string,
  deps: DepRow[],
): Promise<void> {
  const merged: Array<{ testId: string; source: string; titlePath: string }> =
    [];
  const seen = new Set<string>();

  for (const dep of deps) {
    const failuresPath = path.join(
      jobDir(runId, dep.depends_on_job_id),
      FAILURES_FILENAME,
    );
    let raw: string | null = null;
    try {
      raw = await readFile(failuresPath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }

    if (raw === null) {
      if (dep.status === "failed") {
        await client.query(
          `UPDATE jobs
           SET status = 'failed', finished_at = now()
           WHERE id = $1::uuid AND status = 'blocked'`,
          [flakeJobId],
        );
        return;
      }
      // done/skipped + missing → []
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      if (dep.status === "failed") {
        await client.query(
          `UPDATE jobs
           SET status = 'failed', finished_at = now()
           WHERE id = $1::uuid AND status = 'blocked'`,
          [flakeJobId],
        );
        return;
      }
      continue;
    }

    if (!Array.isArray(parsed)) continue;
    for (const item of parsed) {
      if (
        item === null ||
        typeof item !== "object" ||
        typeof (item as { testId?: unknown }).testId !== "string"
      ) {
        continue;
      }
      const row = item as {
        testId: string;
        source?: string;
        titlePath?: string;
      };
      if (seen.has(row.testId)) continue;
      seen.add(row.testId);
      merged.push({
        testId: row.testId,
        source: typeof row.source === "string" ? row.source : "",
        titlePath: typeof row.titlePath === "string" ? row.titlePath : "",
      });
    }
  }

  if (merged.length === 0) {
    await client.query(
      `UPDATE jobs
       SET status = 'skipped', finished_at = now()
       WHERE id = $1::uuid AND status = 'blocked'`,
      [flakeJobId],
    );
    return;
  }

  await client.query(
    `UPDATE jobs SET status = 'queued' WHERE id = $1::uuid AND status = 'blocked'`,
    [flakeJobId],
  );
}
