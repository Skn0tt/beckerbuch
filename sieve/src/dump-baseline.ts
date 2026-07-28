/**
 * Dump corpus run(s) as data-only SQL (for fixtures/baseline.sql + backups).
 *
 * Prefer {@link dumpCorpusSql}: every finished corpus run
 * (`baseline_run_id IS NULL`) so flake history survives restore.
 * {@link dumpBaselineSql} remains for a single-run dump.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { createPool } from "./db.ts";

function sqlStr(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlNullableTs(value: Date | string | null): string {
  if (value == null) return "NULL";
  const d = value instanceof Date ? value : new Date(value);
  return sqlStr(d.toISOString());
}

function sqlNullableUuid(value: string | null): string {
  if (value == null) return "NULL";
  return `${sqlStr(value)}::uuid`;
}

function sqlValuesChunk<T>(
  rows: T[],
  format: (row: T, isLast: boolean) => string,
): string {
  return rows.map((row, i) => format(row, i === rows.length - 1)).join("\n");
}

type RunRow = {
  id: string;
  label: string;
  status: string;
  baseline_run_id: string | null;
  created_at: Date;
  finished_at: Date | null;
};

async function appendRunDump(
  pool: pg.Pool,
  runId: string,
  lines: string[],
): Promise<{ resultCount: number; hitCount: number; label: string; status: string }> {
  const run = await pool.query<RunRow>(
    `SELECT id, label, status, baseline_run_id, created_at, finished_at
     FROM runs WHERE id = $1::uuid`,
    [runId],
  );
  if (!run.rowCount) throw new Error(`run not found: ${runId}`);
  const r = run.rows[0]!;
  if (r.status !== "done" && r.status !== "failed") {
    throw new Error(`run ${runId} status=${r.status}; need done or failed`);
  }

  const jobs = await pool.query<{
    id: string;
    run_id: string;
    command: string;
    status: string;
    attempt: number;
    finished_at: Date | null;
    priority: number;
  }>(
    `SELECT id, run_id, command, status, attempt, finished_at, priority
     FROM jobs WHERE run_id = $1::uuid ORDER BY priority, id`,
    [runId],
  );

  const attempts = await pool.query<{
    id: string;
    job_id: string;
    attempt_no: number;
    worker_id: string;
    lease_token: string;
    status: string;
    started_at: Date;
    finished_at: Date | null;
  }>(
    `SELECT ja.id, ja.job_id, ja.attempt_no, ja.worker_id, ja.lease_token::text,
            ja.status, ja.started_at, ja.finished_at
     FROM job_attempts ja
     JOIN jobs j ON j.id = ja.job_id
     WHERE j.run_id = $1::uuid
     ORDER BY ja.job_id, ja.attempt_no`,
    [runId],
  );

  const results = await pool.query<{
    id: string;
    attempt_id: string;
    run_id: string;
    test_id: string;
    source: string;
    title_path: string;
    status: string;
    duration_ms: number;
    received_at: Date;
  }>(
    `SELECT id, attempt_id, run_id, test_id, source, title_path, status,
            duration_ms, received_at
     FROM test_results WHERE run_id = $1::uuid
     ORDER BY received_at, test_id`,
    [runId],
  );

  if (results.rowCount === 0) {
    throw new Error(`run ${runId} has 0 test_results`);
  }

  const hits = await pool.query<{
    run_id: string;
    test_id: string;
    file_path: string;
    line: number;
  }>(
    `SELECT run_id, test_id, file_path, line
     FROM coverage_hits WHERE run_id = $1::uuid
     ORDER BY test_id, file_path, line`,
    [runId],
  );

  // Keep real run status (done/failed) so flake history + baseline policy match live DB.
  lines.push(`-- corpus run ${r.id} (${r.label}, status=${r.status})`);
  lines.push(
    `INSERT INTO runs (id, label, status, baseline_run_id, created_at, finished_at) VALUES`,
  );
  lines.push(
    `  (${sqlStr(r.id)}, ${sqlStr(r.label)}, ${sqlStr(r.status)}, ${sqlNullableUuid(r.baseline_run_id)}, ${sqlNullableTs(r.created_at)}, ${sqlNullableTs(r.finished_at)});`,
  );
  lines.push(``);

  if (jobs.rowCount) {
    lines.push(
      `INSERT INTO jobs (id, run_id, command, status, attempt, finished_at, priority) VALUES`,
    );
    lines.push(
      jobs.rows
        .map(
          (j, i) =>
            `  (${sqlStr(j.id)}, ${sqlStr(j.run_id)}, ${sqlStr(j.command)}, ${sqlStr(j.status)}, ${j.attempt}, ${sqlNullableTs(j.finished_at)}, ${j.priority})${i === jobs.rows.length - 1 ? ";" : ","}`,
        )
        .join("\n"),
    );
    lines.push(``);
  }

  if (attempts.rowCount) {
    lines.push(
      `INSERT INTO job_attempts (id, job_id, attempt_no, worker_id, lease_token, status, started_at, finished_at) VALUES`,
    );
    lines.push(
      attempts.rows
        .map(
          (a, i) =>
            `  (${sqlStr(a.id)}, ${sqlStr(a.job_id)}, ${a.attempt_no}, ${sqlStr(a.worker_id)}, ${sqlStr(a.lease_token)}::uuid, ${sqlStr(a.status)}, ${sqlNullableTs(a.started_at)}, ${sqlNullableTs(a.finished_at)})${i === attempts.rows.length - 1 ? ";" : ","}`,
        )
        .join("\n"),
    );
    lines.push(``);
  }

  lines.push(`INSERT INTO test_results`);
  lines.push(
    `  (id, attempt_id, run_id, test_id, source, title_path, status, duration_ms, received_at)`,
  );
  lines.push(`VALUES`);
  lines.push(
    sqlValuesChunk(results.rows, (tr, isLast) =>
      `  (${sqlStr(tr.id)}, ${sqlStr(tr.attempt_id)}, ${sqlStr(tr.run_id)}, ${sqlStr(tr.test_id)}, ${sqlStr(tr.source)}, ${sqlStr(tr.title_path)}, ${sqlStr(tr.status)}, ${tr.duration_ms}, ${sqlNullableTs(tr.received_at)})${isLast ? ";" : ","}`,
    ),
  );
  lines.push(``);

  if (hits.rowCount) {
    const CHUNK = 500;
    for (let offset = 0; offset < hits.rows.length; offset += CHUNK) {
      const slice = hits.rows.slice(offset, offset + CHUNK);
      lines.push(
        `INSERT INTO coverage_hits (run_id, test_id, file_path, line) VALUES`,
      );
      lines.push(
        sqlValuesChunk(slice, (h, isLast) =>
          `  (${sqlStr(h.run_id)}, ${sqlStr(h.test_id)}, ${sqlStr(h.file_path)}, ${h.line})${isLast ? ";" : ","}`,
        ),
      );
      lines.push(``);
    }
  }

  return {
    resultCount: results.rowCount ?? 0,
    hitCount: hits.rowCount ?? 0,
    label: r.label,
    status: r.status,
  };
}

/** Dump one finished run (legacy single-fixture path). */
export async function dumpBaselineSql(
  databaseUrl: string,
  runId: string,
  outPath: string,
): Promise<{ resultCount: number }> {
  const pool = createPool(databaseUrl);
  try {
    const lines: string[] = [
      `-- Data-only seed for the HTML UI demo (single run).`,
      `-- Generated by dumpBaselineSql (run ${runId}).`,
      `-- Apply after schema.sql migrate.`,
      ``,
      `BEGIN;`,
      ``,
    ];
    const { resultCount } = await appendRunDump(pool, runId, lines);
    lines.push(`COMMIT;`);
    lines.push(``);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, lines.join("\n"), "utf8");
    return { resultCount };
  } finally {
    await pool.end();
  }
}

/**
 * Dump every finished corpus run (`baseline_run_id IS NULL`) so restore
 * keeps flake history — not just the latest roster.
 */
export async function dumpCorpusSql(
  databaseUrl: string,
  outPath: string,
): Promise<{ runCount: number; resultCount: number }> {
  const pool = createPool(databaseUrl);
  try {
    const runs = await pool.query<{ id: string }>(
      `SELECT r.id
       FROM runs r
       WHERE r.baseline_run_id IS NULL
         AND r.status IN ('done', 'failed')
         AND EXISTS (SELECT 1 FROM test_results tr WHERE tr.run_id = r.id)
       ORDER BY r.finished_at ASC NULLS LAST, r.created_at ASC`,
    );
    if (!runs.rowCount) {
      throw new Error("no finished corpus runs with results to dump");
    }

    const lines: string[] = [
      `-- Data-only seed: ALL corpus runs (baseline_run_id IS NULL).`,
      `-- Generated by dumpCorpusSql (${runs.rowCount} run(s)).`,
      `-- Apply after schema.sql migrate. Preserves flake history.`,
      `-- Diff-aware UI shards are omitted on purpose.`,
      ``,
      `BEGIN;`,
      ``,
    ];

    let resultCount = 0;
    for (const row of runs.rows) {
      const dumped = await appendRunDump(pool, row.id, lines);
      resultCount += dumped.resultCount;
      lines.push(
        `-- ${dumped.label}: ${dumped.resultCount} results, ${dumped.hitCount} coverage hits (${dumped.status})`,
      );
      lines.push(``);
    }

    lines.push(`COMMIT;`);
    lines.push(``);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, lines.join("\n"), "utf8");
    return { runCount: runs.rowCount, resultCount };
  } finally {
    await pool.end();
  }
}

/** Default durable backup dir (outside the repo / Testcontainers wipe radius). */
export function defaultBackupDir(): string {
  return path.join(
    process.env.HOME ?? "/tmp",
    "Documents",
    "beckerbuch-sieve",
  );
}

export async function writeCorpusBackups(
  databaseUrl: string,
  opts?: { fixturePath?: string; backupDir?: string },
): Promise<{
  fixturePath: string;
  stampedPath: string;
  latestPath: string;
  runCount: number;
  resultCount: number;
}> {
  const { fileURLToPath } = await import("node:url");
  const { copyFile } = await import("node:fs/promises");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const fixturePath =
    opts?.fixturePath ?? path.join(root, "fixtures", "baseline.sql");
  const backupDir = opts?.backupDir ?? defaultBackupDir();
  await mkdir(backupDir, { recursive: true });

  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const stampedPath = path.join(backupDir, `corpus-${stamp}.sql`);
  const latestPath = path.join(backupDir, "corpus-latest.sql");

  const { runCount, resultCount } = await dumpCorpusSql(databaseUrl, fixturePath);
  await copyFile(fixturePath, stampedPath);
  await copyFile(fixturePath, latestPath);

  return { fixturePath, stampedPath, latestPath, runCount, resultCount };
}

export async function resolveDatabaseUrl(): Promise<string | null> {
  if (process.env.SIEVE_DATABASE_URL) return process.env.SIEVE_DATABASE_URL;
  try {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const sieveRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    const raw = (
      await readFile(path.join(sieveRoot, ".database-url"), "utf8")
    ).trim();
    return raw || null;
  } catch {
    return null;
  }
}
