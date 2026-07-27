/**
 * Scheduler HTTP frontend. All correctness lives in Postgres:
 * SKIP LOCKED claims, lease tokens, heartbeats, reaper.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { createPool, migrate, withClient } from "./db.ts";
import type {
  ClaimBody,
  ClaimedJob,
  CompleteBody,
  HeartbeatBody,
  ResultBody,
} from "./types.ts";

const LEASE_SECONDS = Number(process.env.SIEVE_LEASE_SECONDS ?? 30);
const REAPER_MS = Number(process.env.SIEVE_REAPER_MS ?? 5000);
const MAX_ATTEMPTS = Number(process.env.SIEVE_MAX_ATTEMPTS ?? 5);

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

function send(res: ServerResponse, status: number, body: Json): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function notFound(res: ServerResponse): void {
  send(res, 404, { error: "not_found" });
}

export async function createRun(
  pool: pg.Pool,
  opts: { label: string; commands: string[] },
): Promise<{ runId: string; jobCount: number }> {
  return withClient(pool, async (client) => {
    await client.query("BEGIN");
    try {
      const run = await client.query<{ id: string }>(
        `INSERT INTO runs (label, status) VALUES ($1, 'queued') RETURNING id`,
        [opts.label],
      );
      const runId = run.rows[0].id;
      for (const command of opts.commands) {
        await client.query(
          `INSERT INTO jobs (run_id, command, status) VALUES ($1, $2, 'queued')`,
          [runId, command],
        );
      }
      await client.query("COMMIT");
      return { runId, jobCount: opts.commands.length };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });
}

export async function claimJob(
  pool: pg.Pool,
  opts: { workerId: string; runId?: string },
): Promise<ClaimedJob | null> {
  return withClient(pool, async (client) => {
    await client.query("BEGIN");
    try {
      const leaseToken = randomUUID();
      const params: unknown[] = [opts.workerId, leaseToken, LEASE_SECONDS];
      let runFilter = "";
      if (opts.runId) {
        params.push(opts.runId);
        runFilter = `AND run_id = $${params.length}`;
      }

      const updated = await client.query<{
        id: string;
        run_id: string;
        command: string;
        attempt: number;
        lease_token: string;
      }>(
        `
        UPDATE jobs
        SET status = 'running',
            worker_id = $1,
            lease_token = $2::uuid,
            lease_expires_at = now() + make_interval(secs => $3),
            attempt = attempt + 1,
            claimed_at = now(),
            finished_at = NULL
        WHERE id = (
          SELECT id FROM jobs
          WHERE status = 'queued' ${runFilter}
          ORDER BY id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING id, run_id, command, attempt, lease_token
        `,
        params,
      );

      if (updated.rowCount === 0) {
        await client.query("COMMIT");
        return null;
      }

      const job = updated.rows[0];

      // Supersede any prior running attempt for this job.
      await client.query(
        `UPDATE job_attempts
         SET status = 'superseded', finished_at = now()
         WHERE job_id = $1 AND status = 'running'`,
        [job.id],
      );

      const attempt = await client.query<{ id: string }>(
        `INSERT INTO job_attempts (job_id, attempt_no, worker_id, lease_token, status)
         VALUES ($1, $2, $3, $4::uuid, 'running')
         RETURNING id`,
        [job.id, job.attempt, opts.workerId, job.lease_token],
      );

      await client.query(
        `UPDATE runs SET status = 'running' WHERE id = $1 AND status = 'queued'`,
        [job.run_id],
      );

      await client.query(
        `INSERT INTO workers (id, hostname, last_seen_at)
         VALUES ($1, $2, now())
         ON CONFLICT (id) DO UPDATE SET last_seen_at = now(), hostname = EXCLUDED.hostname`,
        [opts.workerId, process.env.HOSTNAME ?? "unknown"],
      );

      await client.query("COMMIT");
      return {
        jobId: job.id,
        attemptId: attempt.rows[0].id,
        runId: job.run_id,
        command: job.command,
        leaseToken: job.lease_token,
        attempt: job.attempt,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });
}

export async function heartbeat(
  pool: pg.Pool,
  opts: HeartbeatBody,
): Promise<"ok" | "lost_lease"> {
  const result = await pool.query(
    `UPDATE jobs
     SET lease_expires_at = now() + make_interval(secs => $3)
     WHERE id = $1::uuid
       AND lease_token = $2::uuid
       AND status = 'running'`,
    [opts.jobId, opts.leaseToken, LEASE_SECONDS],
  );
  if (result.rowCount === 0) return "lost_lease";
  if (opts.workerId) {
    await pool.query(
      `UPDATE workers SET last_seen_at = now() WHERE id = $1`,
      [opts.workerId],
    );
  }
  return "ok";
}

export async function ingestResult(
  pool: pg.Pool,
  body: ResultBody,
): Promise<"ok" | "lost_lease"> {
  return withClient(pool, async (client) => {
    await client.query("BEGIN");
    try {
      const job = await client.query<{ run_id: string }>(
        `SELECT run_id FROM jobs
         WHERE id = $1::uuid
           AND lease_token = $2::uuid
           AND status = 'running'`,
        [body.jobId, body.leaseToken],
      );
      if (job.rowCount === 0) {
        await client.query("ROLLBACK");
        return "lost_lease";
      }

      const attempt = await client.query(
        `SELECT 1 FROM job_attempts
         WHERE id = $1::uuid
           AND job_id = $2::uuid
           AND lease_token = $3::uuid
           AND status = 'running'`,
        [body.attemptId, body.jobId, body.leaseToken],
      );
      if (attempt.rowCount === 0) {
        await client.query("ROLLBACK");
        return "lost_lease";
      }

      await client.query(
        `INSERT INTO test_results
           (attempt_id, run_id, test_id, source, status, duration_ms, hit_lines)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::text[])
         ON CONFLICT (attempt_id, test_id) DO UPDATE SET
           source = EXCLUDED.source,
           status = EXCLUDED.status,
           duration_ms = EXCLUDED.duration_ms,
           hit_lines = EXCLUDED.hit_lines,
           received_at = now()`,
        [
          body.attemptId,
          job.rows[0].run_id,
          body.testId,
          body.source,
          body.status,
          body.durationMs,
          body.hitLines,
        ],
      );
      await client.query("COMMIT");
      return "ok";
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });
}

export async function completeJob(
  pool: pg.Pool,
  body: CompleteBody,
): Promise<"ok" | "lost_lease"> {
  return withClient(pool, async (client) => {
    await client.query("BEGIN");
    try {
      const status = body.ok ? "done" : "failed";
      const job = await client.query<{ run_id: string }>(
        `UPDATE jobs
         SET status = $3,
             finished_at = now(),
             lease_expires_at = NULL
         WHERE id = $1::uuid
           AND lease_token = $2::uuid
           AND status = 'running'
         RETURNING run_id`,
        [body.jobId, body.leaseToken, status],
      );
      if (job.rowCount === 0) {
        await client.query("ROLLBACK");
        return "lost_lease";
      }

      await client.query(
        `UPDATE job_attempts
         SET status = $2, finished_at = now()
         WHERE id = $1::uuid AND lease_token = $3::uuid AND status = 'running'`,
        [body.attemptId, status, body.leaseToken],
      );

      await maybeFinishRun(client, job.rows[0].run_id);
      await client.query("COMMIT");
      return "ok";
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });
}

async function maybeFinishRun(client: pg.PoolClient, runId: string): Promise<void> {
  const open = await client.query(
    `SELECT 1 FROM jobs
     WHERE run_id = $1::uuid AND status IN ('queued', 'running')
     LIMIT 1`,
    [runId],
  );
  if (open.rowCount && open.rowCount > 0) return;

  const failed = await client.query(
    `SELECT 1 FROM jobs WHERE run_id = $1::uuid AND status = 'failed' LIMIT 1`,
    [runId],
  );
  const status = failed.rowCount && failed.rowCount > 0 ? "failed" : "done";
  await client.query(
    `UPDATE runs SET status = $2, finished_at = now() WHERE id = $1::uuid`,
    [runId, status],
  );
}

export async function reapExpiredLeases(pool: pg.Pool): Promise<number> {
  return withClient(pool, async (client) => {
    await client.query("BEGIN");
    try {
      const expired = await client.query<{ id: string; attempt: number; run_id: string }>(
        `SELECT id, attempt, run_id FROM jobs
         WHERE status = 'running'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at < now()
         FOR UPDATE SKIP LOCKED`,
      );

      let requeued = 0;
      for (const job of expired.rows) {
        await client.query(
          `UPDATE job_attempts
           SET status = 'superseded', finished_at = now()
           WHERE job_id = $1 AND status = 'running'`,
          [job.id],
        );

        if (job.attempt >= MAX_ATTEMPTS) {
          await client.query(
            `UPDATE jobs
             SET status = 'failed',
                 worker_id = NULL,
                 lease_token = NULL,
                 lease_expires_at = NULL,
                 finished_at = now()
             WHERE id = $1`,
            [job.id],
          );
          await maybeFinishRun(client, job.run_id);
        } else {
          await client.query(
            `UPDATE jobs
             SET status = 'queued',
                 worker_id = NULL,
                 lease_token = NULL,
                 lease_expires_at = NULL,
                 claimed_at = NULL
             WHERE id = $1`,
            [job.id],
          );
          requeued += 1;
        }
      }
      await client.query("COMMIT");
      return requeued;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });
}

export async function getRunSummary(pool: pg.Pool, runId: string) {
  const run = await pool.query(
    `SELECT id, label, status, created_at, finished_at FROM runs WHERE id = $1::uuid`,
    [runId],
  );
  if (run.rowCount === 0) return null;

  const jobs = await pool.query(
    `SELECT id, command, status, attempt, worker_id, finished_at
     FROM jobs WHERE run_id = $1::uuid ORDER BY id`,
    [runId],
  );

  const results = await pool.query(
    `SELECT tr.test_id, tr.source, tr.status, tr.duration_ms,
            cardinality(tr.hit_lines) AS hit_line_count,
            ja.attempt_no, ja.status AS attempt_status
     FROM test_results tr
     JOIN job_attempts ja ON ja.id = tr.attempt_id
     WHERE tr.run_id = $1::uuid
       AND ja.status = 'done'
     ORDER BY tr.source, tr.test_id`,
    [runId],
  );

  return {
    run: run.rows[0],
    jobs: jobs.rows,
    results: results.rows,
  };
}

function matchPath(
  url: string,
  pattern: RegExp,
): RegExpMatchArray | null {
  const pathOnly = url.split("?")[0] ?? url;
  return pathOnly.match(pattern);
}

export function startSchedulerServer(pool: pg.Pool, port: number) {
  const server = createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";

      if (method === "GET" && url === "/health") {
        send(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && url === "/runs") {
        const body = await readJson<{ label?: string; commands?: string[] }>(req);
        if (!body.label || !Array.isArray(body.commands) || body.commands.length === 0) {
          send(res, 400, { error: "label and non-empty commands required" });
          return;
        }
        const created = await createRun(pool, {
          label: body.label,
          commands: body.commands,
        });
        send(res, 201, created);
        return;
      }

      const runMatch = matchPath(url, /^\/runs\/([^/]+)$/);
      if (method === "GET" && runMatch) {
        const summary = await getRunSummary(pool, runMatch[1]);
        if (!summary) {
          notFound(res);
          return;
        }
        send(res, 200, summary);
        return;
      }

      if (method === "POST" && url === "/claim") {
        const body = await readJson<ClaimBody>(req);
        if (!body.workerId) {
          send(res, 400, { error: "workerId required" });
          return;
        }
        const job = await claimJob(pool, {
          workerId: body.workerId,
          runId: body.runId,
        });
        send(res, 200, { job });
        return;
      }

      if (method === "POST" && url === "/heartbeat") {
        const body = await readJson<HeartbeatBody>(req);
        if (!body.jobId || !body.leaseToken) {
          send(res, 400, { error: "jobId and leaseToken required" });
          return;
        }
        const result = await heartbeat(pool, body);
        if (result === "lost_lease") {
          send(res, 409, { error: "lost_lease" });
          return;
        }
        send(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && url === "/results") {
        const body = await readJson<ResultBody>(req);
        if (
          !body.jobId ||
          !body.leaseToken ||
          !body.attemptId ||
          !body.testId
        ) {
          send(res, 400, { error: "missing required fields" });
          return;
        }
        const result = await ingestResult(pool, {
          ...body,
          hitLines: body.hitLines ?? [],
          durationMs: body.durationMs ?? 0,
          status: body.status ?? "unknown",
          source: body.source ?? "",
        });
        if (result === "lost_lease") {
          send(res, 409, { error: "lost_lease" });
          return;
        }
        send(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && url === "/complete") {
        const body = await readJson<CompleteBody>(req);
        if (!body.jobId || !body.leaseToken || !body.attemptId) {
          send(res, 400, { error: "jobId, leaseToken, attemptId required" });
          return;
        }
        const result = await completeJob(pool, {
          ...body,
          ok: Boolean(body.ok),
        });
        if (result === "lost_lease") {
          send(res, 409, { error: "lost_lease" });
          return;
        }
        send(res, 200, { ok: true });
        return;
      }

      notFound(res);
    } catch (err) {
      console.error("[scheduler] request error", err);
      send(res, 500, { error: String(err) });
    }
  });

  const reaper = setInterval(() => {
    void reapExpiredLeases(pool)
      .then((n) => {
        if (n > 0) console.log(`[scheduler] reaped ${n} expired lease(s)`);
      })
      .catch((err) => console.error("[scheduler] reaper error", err));
  }, REAPER_MS);
  reaper.unref();

  server.listen(port, () => {
    console.log(`[scheduler] listening on http://127.0.0.1:${port}`);
  });

  return {
    server,
    close: async () => {
      clearInterval(reaper);
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function main() {
  const databaseUrl = process.env.SIEVE_DATABASE_URL;
  if (!databaseUrl) {
    console.error("SIEVE_DATABASE_URL is required");
    process.exit(1);
  }
  const port = Number(process.env.SIEVE_PORT ?? 9101);
  const pool = createPool(databaseUrl);
  await migrate(pool);
  startSchedulerServer(pool, port);
}

if (process.argv[1]?.endsWith("scheduler.ts")) {
  void main();
}
