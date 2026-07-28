/**
 * Worker registration + snapshot for the UI / WebSocket hub.
 */

import type pg from "pg";

const LEASE_SECONDS = Number(process.env.SIEVE_LEASE_SECONDS ?? 30);
/** Drop workers from the board after this (2× the stale threshold). */
const PRUNE_AFTER_SECONDS = 4 * LEASE_SECONDS;

export type WorkerView = {
  id: string;
  hostname: string | null;
  lastSeenAt: string;
  ageMs: number;
  stale: boolean;
  state: "idle" | "running" | "stale";
  jobId?: string;
  runId?: string;
  shardIndex?: number | null;
  testIds?: string[] | null;
};

export async function pruneGoneWorkers(pool: pg.Pool): Promise<number> {
  const result = await pool.query(
    `DELETE FROM workers
     WHERE last_seen_at < now() - make_interval(secs => $1)
       AND NOT EXISTS (
         SELECT 1 FROM jobs
         WHERE worker_id = workers.id AND status = 'running'
       )`,
    [PRUNE_AFTER_SECONDS],
  );
  return result.rowCount ?? 0;
}

export async function workerHello(
  pool: pg.Pool,
  opts: { workerId: string; hostname?: string },
): Promise<WorkerView> {
  await pool.query(
    `INSERT INTO workers (id, hostname, last_seen_at)
     VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE
       SET last_seen_at = now(),
           hostname = COALESCE(EXCLUDED.hostname, workers.hostname)`,
    [opts.workerId, opts.hostname ?? null],
  );
  const views = await listWorkers(pool);
  const view = views.find((w) => w.id === opts.workerId);
  if (view) return view;
  // Fresh hello can race with prune only if clocks are wrong; synthesize.
  return {
    id: opts.workerId,
    hostname: opts.hostname ?? null,
    lastSeenAt: new Date().toISOString(),
    ageMs: 0,
    stale: false,
    state: "idle",
  };
}

export async function listWorkers(pool: pg.Pool): Promise<WorkerView[]> {
  await pruneGoneWorkers(pool);

  const rows = await pool.query<{
    id: string;
    hostname: string | null;
    last_seen_at: Date;
    job_id: string | null;
    run_id: string | null;
    shard_index: number | null;
    test_ids: string[] | null;
  }>(
    `SELECT w.id, w.hostname, w.last_seen_at,
            j.id AS job_id, j.run_id, j.shard_index, j.test_ids
     FROM workers w
     LEFT JOIN LATERAL (
       SELECT id, run_id, shard_index, test_ids
       FROM jobs
       WHERE worker_id = w.id AND status = 'running'
       ORDER BY claimed_at DESC NULLS LAST
       LIMIT 1
     ) j ON true
     ORDER BY w.id`,
  );

  const now = Date.now();
  const staleAfter = 2 * LEASE_SECONDS * 1000;

  return rows.rows.map((r) => {
    const lastSeenAt = new Date(r.last_seen_at).toISOString();
    const ageMs = Math.max(0, now - new Date(r.last_seen_at).getTime());
    const stale = ageMs > staleAfter;
    let state: WorkerView["state"] = "idle";
    if (stale) state = "stale";
    else if (r.job_id) state = "running";
    return {
      id: r.id,
      hostname: r.hostname,
      lastSeenAt,
      ageMs,
      stale,
      state,
      jobId: r.job_id ?? undefined,
      runId: r.run_id ?? undefined,
      shardIndex: r.shard_index,
      testIds: r.test_ids,
    };
  });
}
