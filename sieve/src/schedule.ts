/**
 * Parse schedule.json from a job dir and insert jobs + deps into a run.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { SCHEDULE_FILENAME, jobDir } from "./artifacts.ts";

export type ScheduleJob = {
  name: string;
  command: string;
  kind?: string;
  needs?: string[];
  priority?: number;
  shardIndex?: number;
};

export type ScheduleManifest = {
  jobs: ScheduleJob[];
};

export function parseScheduleJson(raw: string): ScheduleManifest {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("schedule.json: expected object");
  }
  const jobs = (parsed as { jobs?: unknown }).jobs;
  if (!Array.isArray(jobs)) {
    throw new Error("schedule.json: expected jobs array");
  }
  const out: ScheduleJob[] = [];
  for (const item of jobs) {
    if (item === null || typeof item !== "object") {
      throw new Error("schedule.json: job entry must be object");
    }
    const j = item as Record<string, unknown>;
    if (typeof j.name !== "string" || !j.name) {
      throw new Error("schedule.json: job name required");
    }
    if (typeof j.command !== "string" || !j.command) {
      throw new Error("schedule.json: job command required");
    }
    const entry: ScheduleJob = {
      name: j.name,
      command: j.command,
    };
    if (typeof j.kind === "string") entry.kind = j.kind;
    if (Array.isArray(j.needs)) {
      entry.needs = j.needs.filter((x): x is string => typeof x === "string");
    }
    if (typeof j.priority === "number" && Number.isFinite(j.priority)) {
      entry.priority = j.priority;
    }
    if (typeof j.shardIndex === "number" && Number.isFinite(j.shardIndex)) {
      entry.shardIndex = j.shardIndex;
    }
    out.push(entry);
  }
  return { jobs: out };
}

/**
 * Read schedule.json from the completing job's artifact dir and insert
 * jobs. Caller must be inside an open transaction. Returns number of
 * jobs inserted, or 0 if no manifest.
 */
export async function applyScheduleFromJobDir(
  client: pg.PoolClient,
  opts: { runId: string; jobId: string },
): Promise<number> {
  const schedulePath = path.join(
    jobDir(opts.runId, opts.jobId),
    SCHEDULE_FILENAME,
  );
  let raw: string;
  try {
    raw = await readFile(schedulePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return 0;
    throw err;
  }

  const manifest = parseScheduleJson(raw);
  if (manifest.jobs.length === 0) return 0;

  const nameToId = new Map<string, string>();
  const existingIds = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM jobs WHERE run_id = $1::uuid AND name IS NOT NULL`,
    [opts.runId],
  );
  for (const row of existingIds.rows) {
    nameToId.set(row.name, row.id);
  }

  for (const job of manifest.jobs) {
    if (nameToId.has(job.name)) {
      throw new Error(`schedule.json: duplicate job name ${job.name}`);
    }
  }

  // Insert jobs first (blocked if needs non-empty), then wire deps.
  for (const job of manifest.jobs) {
    const needs = job.needs ?? [];
    const status = needs.length > 0 ? "blocked" : "queued";
    const priority =
      job.priority ??
      (typeof job.shardIndex === "number" ? job.shardIndex : 0);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO jobs
         (run_id, command, status, name, kind, priority, shard_index)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        opts.runId,
        job.command,
        status,
        job.name,
        job.kind ?? null,
        priority,
        job.shardIndex ?? null,
      ],
    );
    nameToId.set(job.name, inserted.rows[0]!.id);
  }

  for (const job of manifest.jobs) {
    const jobId = nameToId.get(job.name)!;
    for (const need of job.needs ?? []) {
      const depId = nameToId.get(need);
      if (!depId) {
        throw new Error(
          `schedule.json: job ${job.name} needs unknown name ${need}`,
        );
      }
      await client.query(
        `INSERT INTO job_deps (job_id, depends_on_job_id) VALUES ($1::uuid, $2::uuid)`,
        [jobId, depId],
      );
    }
  }

  return manifest.jobs.length;
}
