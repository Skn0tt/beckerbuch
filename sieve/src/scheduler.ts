/**
 * Scheduler HTTP frontend. All correctness lives in Postgres:
 * SKIP LOCKED claims, lease tokens, heartbeats, reaper.
 * Also serves the HTML UI + WebSocket live hub.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { playwrightShardCommand } from "./commands.ts";
import { parseHitLines, replaceCoverageHits } from "./coverage-hits.ts";
import { createPool, migrate, withClient } from "./db.ts";
import { SchedulerRequestError } from "./errors.ts";
import { loadGitDiff, repoLabel, repoRootFromEnv } from "./git.ts";
import { attachHub, type EventHub } from "./hub.ts";
import { watchRepo } from "./watch-repo.ts";
import { planDiffRun, resolveBaselineRunId } from "./plan.ts";
import type {
  ClaimBody,
  ClaimedJob,
  CompleteBody,
  HeartbeatBody,
  ResultBody,
} from "./types.ts";
import { listWorkers, pruneGoneWorkers, workerHello } from "./workers.ts";

export { SchedulerRequestError } from "./errors.ts";

const LEASE_SECONDS = Number(process.env.SIEVE_LEASE_SECONDS ?? 30);
const REAPER_MS = Number(process.env.SIEVE_REAPER_MS ?? 5000);
const MAX_ATTEMPTS = Number(process.env.SIEVE_MAX_ATTEMPTS ?? 5);
const PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../public",
);

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

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function tryServeStatic(
  res: ServerResponse,
  urlPath: string,
): Promise<boolean> {
  let rel = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  if (rel === "/" || rel === "") rel = "/index.html";
  if (rel.includes("..")) return false;
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) return false;
  try {
    const st = await stat(filePath);
    if (!st.isFile()) return false;
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "content-length": data.length,
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
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
      const runId = run.rows[0]!.id;
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

export type CreateDiffRunOpts = {
  label: string;
  diff: string;
  budgetMs: number;
  shardCount?: number;
  baselineRunId?: string;
  pwWorkers?: number;
  deprioritizeFlakes?: boolean;
  preferPopular?: boolean;
};

export type CreateDiffRunResult = {
  runId: string;
  jobCount: number;
  baselineRunId: string;
  selectedTestIds: string[];
  shards: Array<{ shardIndex: number; testIds: string[] }>;
};

export async function createDiffAwareRun(
  pool: pg.Pool,
  opts: CreateDiffRunOpts,
): Promise<CreateDiffRunResult> {
  const shardCount =
    opts.shardCount === undefined ? 2 : Math.floor(opts.shardCount);

  return withClient(pool, async (client) => {
    await client.query("BEGIN");
    try {
      const plan = await planDiffRun(client, {
        diff: opts.diff,
        budgetMs: opts.budgetMs,
        shardCount,
        baselineRunId: opts.baselineRunId,
        deprioritizeFlakes: opts.deprioritizeFlakes,
        preferPopular: opts.preferPopular,
      });

      const runStatus = plan.shards.length === 0 ? "done" : "queued";
      const run = await client.query<{ id: string }>(
        `INSERT INTO runs (label, status, baseline_run_id, finished_at)
         VALUES ($1, $2, $3::uuid, CASE WHEN $2 = 'done' THEN now() ELSE NULL END)
         RETURNING id`,
        [opts.label, runStatus, plan.baselineRunId],
      );
      const runId = run.rows[0]!.id;

      const shards: CreateDiffRunResult["shards"] = [];
      for (const shard of plan.shards) {
        const command = playwrightShardCommand(shard.testIds, opts.pwWorkers);
        await client.query(
          `INSERT INTO jobs
             (run_id, command, status, shard_index, test_ids, priority)
           VALUES ($1, $2, 'queued', $3, $4::text[], $3)`,
          [runId, command, shard.shardIndex, shard.testIds],
        );
        shards.push({ shardIndex: shard.shardIndex, testIds: shard.testIds });
      }

      await client.query("COMMIT");
      return {
        runId,
        jobCount: plan.shards.length,
        baselineRunId: plan.baselineRunId,
        selectedTestIds: plan.selectedTestIds,
        shards,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });
}

export async function claimJob(
  pool: pg.Pool,
  opts: { workerId: string; runId?: string },
): Promise<ClaimedJob & { shardIndex?: number | null; testIds?: string[] | null } | null> {
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
        shard_index: number | null;
        test_ids: string[] | null;
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
          ORDER BY priority ASC, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING id, run_id, command, attempt, lease_token, shard_index, test_ids
        `,
        params,
      );

      if (updated.rowCount === 0) {
        await client.query("COMMIT");
        return null;
      }

      const job = updated.rows[0]!;

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
        attemptId: attempt.rows[0]!.id,
        runId: job.run_id,
        command: job.command,
        leaseToken: job.lease_token,
        attempt: job.attempt,
        shardIndex: job.shard_index,
        testIds: job.test_ids,
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
): Promise<"ok" | "lost_lease" | { ok: true; runId: string }> {
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

      const runId = job.rows[0]!.run_id;
      await client.query(
        `INSERT INTO test_results
           (attempt_id, run_id, test_id, source, title_path, status, duration_ms)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
         ON CONFLICT (attempt_id, test_id) DO UPDATE SET
           source = EXCLUDED.source,
           title_path = EXCLUDED.title_path,
           status = EXCLUDED.status,
           duration_ms = EXCLUDED.duration_ms,
           received_at = now()`,
        [
          body.attemptId,
          runId,
          body.testId,
          body.source,
          body.titlePath ?? "",
          body.status,
          body.durationMs,
        ],
      );
      // onTestBegin posts status=running with empty hitLines — don't wipe
      // coverage that a prior attempt or retry may already have written.
      if (body.status !== "running") {
        await replaceCoverageHits(client, {
          runId,
          testId: body.testId,
          hits: parseHitLines(body.hitLines ?? []),
        });
      }
      await client.query("COMMIT");
      return { ok: true, runId };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });
}

export async function completeJob(
  pool: pg.Pool,
  body: CompleteBody,
): Promise<"ok" | "lost_lease" | { ok: true; runId: string; runStatus: string }> {
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

      const runId = job.rows[0]!.run_id;
      await maybeFinishRun(client, runId);
      const run = await client.query<{ status: string }>(
        `SELECT status FROM runs WHERE id = $1::uuid`,
        [runId],
      );
      await client.query("COMMIT");
      return { ok: true, runId, runStatus: run.rows[0]!.status };
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
      const expired = await client.query<{
        id: string;
        attempt: number;
        run_id: string;
      }>(
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
    `SELECT id, label, status, baseline_run_id, created_at, finished_at
     FROM runs WHERE id = $1::uuid`,
    [runId],
  );
  if (run.rowCount === 0) return null;

  const jobs = await pool.query(
    `SELECT id, command, status, attempt, worker_id, finished_at,
            shard_index, test_ids, priority
     FROM jobs WHERE run_id = $1::uuid ORDER BY priority ASC, id`,
    [runId],
  );

  // Include running (live UI) and failed attempts — Playwright exit≠0 still
  // produced per-test rows we want for status / corpus dumps.
  const results = await pool.query(
    `SELECT tr.test_id, tr.source, tr.title_path, tr.status, tr.duration_ms,
            (SELECT count(*)::int FROM coverage_hits ch
             WHERE ch.run_id = tr.run_id AND ch.test_id = tr.test_id
            ) AS hit_line_count,
            ja.attempt_no, ja.status AS attempt_status
     FROM test_results tr
     JOIN job_attempts ja ON ja.id = tr.attempt_id
     WHERE tr.run_id = $1::uuid
       AND ja.status IN ('done', 'running', 'failed')
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
  let hub: EventHub | undefined;

  const server = createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";
      const pathOnly = url.split("?")[0] ?? url;

      if (method === "GET" && pathOnly === "/health") {
        send(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && pathOnly === "/api/bootstrap") {
        const root = repoRootFromEnv();
        const diff = await loadGitDiff(root);
        let baselineRunId: string | null = null;
        try {
          await withClient(pool, async (client) => {
            baselineRunId = await resolveBaselineRunId(client, undefined);
          });
        } catch {
          baselineRunId = null;
        }
        send(res, 200, {
          repoLabel: repoLabel(root),
          refLabel: diff.refLabel,
          diffStat: { lineCount: diff.diffLineCount },
          diffText: diff.diffText,
          baselineRunId,
          hasBaseline: baselineRunId !== null,
          // Same policy as workers.ts: stale when age > 2 * lease.
          leaseSeconds: LEASE_SECONDS,
          staleAfterMs: 2 * LEASE_SECONDS * 1000,
          pruneAfterMs: 4 * LEASE_SECONDS * 1000,
        });
        return;
      }

      if (method === "POST" && pathOnly === "/api/plan") {
        const body = await readJson<{
          budgetMs?: number;
          latencyMs?: number;
          baselineRunId?: string;
          diff?: string;
          shardCount?: number;
          deprioritizeFlakes?: boolean;
          preferPopular?: boolean;
        }>(req);
        const budgetMs = Number(body.budgetMs);
        if (!(budgetMs > 0)) {
          send(res, 400, { error: "invalid_budget" });
          return;
        }
        let diffText = body.diff;
        if (!diffText) {
          diffText = (await loadGitDiff(repoRootFromEnv())).diffText;
        }
        try {
          const planned = await withClient(pool, async (client) => {
            const latencyMs = Number(body.latencyMs ?? 30_000);
            const explicitShards =
              body.shardCount !== undefined
                ? Math.floor(Number(body.shardCount))
                : undefined;
            const deprioritizeFlakes = body.deprioritizeFlakes === true;
            const preferPopular = body.preferPopular === true;
            // Plan once at shardCount=1 to learn selected duration, then pack.
            const preliminary = await planDiffRun(client, {
              diff: diffText!,
              budgetMs,
              shardCount: 1,
              baselineRunId: body.baselineRunId,
              deprioritizeFlakes,
              preferPopular,
            });
            const selectedDur = preliminary.selected.reduce(
              (s, t) => s + t.durationMs,
              0,
            );
            const n =
              explicitShards !== undefined && explicitShards >= 1
                ? explicitShards
                : Math.max(1, Math.ceil(selectedDur / Math.max(latencyMs, 1)));
            if (n === 1) return { ...preliminary, shardCount: 1 };
            return {
              ...(await planDiffRun(client, {
                diff: diffText!,
                budgetMs,
                shardCount: n,
                baselineRunId: body.baselineRunId,
                deprioritizeFlakes,
                preferPopular,
              })),
              shardCount: n,
            };
          });
          send(res, 200, planned);
        } catch (err) {
          if (err instanceof SchedulerRequestError) {
            send(res, err.status, { error: err.code });
            return;
          }
          throw err;
        }
        return;
      }

      if (method === "POST" && pathOnly === "/workers/hello") {
        const body = await readJson<{ workerId?: string; hostname?: string }>(
          req,
        );
        if (!body.workerId) {
          send(res, 400, { error: "workerId required" });
          return;
        }
        const worker = await workerHello(pool, {
          workerId: body.workerId,
          hostname: body.hostname,
        });
        hub?.emit({ type: "worker", worker });
        send(res, 200, { worker });
        return;
      }

      if (method === "POST" && url === "/runs") {
        const body = await readJson<{
          label?: string;
          commands?: string[];
          diff?: string;
          budgetMs?: number;
          shardCount?: number;
          baselineRunId?: string;
          pwWorkers?: number;
          latencyMs?: number;
          deprioritizeFlakes?: boolean;
          preferPopular?: boolean;
        }>(req);

        if (!body.label) {
          send(res, 400, { error: "label required" });
          return;
        }

        const isDiff =
          typeof body.diff === "string" &&
          body.budgetMs !== undefined &&
          body.budgetMs !== null;
        const isCommands =
          Array.isArray(body.commands) && body.commands.length > 0;

        if (isDiff && isCommands) {
          send(res, 400, { error: "commands and diff are mutually exclusive" });
          return;
        }

        if (isDiff) {
          try {
            let shardCount = body.shardCount;
            if (shardCount === undefined && body.latencyMs !== undefined) {
              const latencyMs = Number(body.latencyMs);
              const prelim = await withClient(pool, (client) =>
                planDiffRun(client, {
                  diff: body.diff!,
                  budgetMs: Number(body.budgetMs),
                  shardCount: 1,
                  baselineRunId: body.baselineRunId,
                  deprioritizeFlakes: body.deprioritizeFlakes === true,
                  preferPopular: body.preferPopular === true,
                }),
              );
              const selectedDur = prelim.selected.reduce(
                (s, t) => s + t.durationMs,
                0,
              );
              shardCount = Math.max(
                1,
                Math.ceil(selectedDur / Math.max(latencyMs, 1)),
              );
            }
            const created = await createDiffAwareRun(pool, {
              label: body.label,
              diff: body.diff!,
              budgetMs: Number(body.budgetMs),
              shardCount,
              baselineRunId: body.baselineRunId,
              pwWorkers: body.pwWorkers,
              deprioritizeFlakes: body.deprioritizeFlakes === true,
              preferPopular: body.preferPopular === true,
            });
            hub?.emit({
              type: "run",
              run: {
                id: created.runId,
                status: created.jobCount === 0 ? "done" : "queued",
              },
            });
            send(res, 201, created);
          } catch (err) {
            if (err instanceof SchedulerRequestError) {
              send(res, err.status, { error: err.code });
              return;
            }
            throw err;
          }
          return;
        }

        if (!isCommands) {
          send(res, 400, {
            error:
              "label and non-empty commands required, or diff + budgetMs",
          });
          return;
        }

        const created = await createRun(pool, {
          label: body.label,
          commands: body.commands!,
        });
        send(res, 201, created);
        return;
      }

      const runMatch = matchPath(url, /^\/runs\/([^/]+)$/);
      if (method === "GET" && runMatch) {
        const summary = await getRunSummary(pool, runMatch[1]!);
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
        if (job) {
          const workers = await listWorkers(pool);
          const worker = workers.find((w) => w.id === body.workerId);
          if (worker) hub?.emit({ type: "worker", worker });
          hub?.emit({
            type: "job",
            job: {
              id: job.jobId,
              runId: job.runId,
              status: "running",
              workerId: body.workerId,
              shardIndex: job.shardIndex ?? null,
              testIds: job.testIds ?? null,
            },
          });
          hub?.emit({ type: "run", run: { id: job.runId, status: "running" } });
        }
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
        if (body.workerId) {
          const workers = await listWorkers(pool);
          const worker = workers.find((w) => w.id === body.workerId);
          if (worker) hub?.emit({ type: "worker", worker });
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
          titlePath: body.titlePath ?? "",
        });
        if (result === "lost_lease") {
          send(res, 409, { error: "lost_lease" });
          return;
        }
        if (typeof result === "object" && result.ok) {
          hub?.emit({
            type: "result",
            runId: result.runId,
            testId: body.testId,
            status: body.status ?? "unknown",
            durationMs: body.durationMs ?? 0,
            source: body.source,
            titlePath: body.titlePath,
          });
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
        if (typeof result === "object" && result.ok) {
          hub?.emit({
            type: "job",
            job: {
              id: body.jobId,
              runId: result.runId,
              status: body.ok ? "done" : "failed",
            },
          });
          hub?.emit({
            type: "run",
            run: { id: result.runId, status: result.runStatus },
          });
          const workers = await listWorkers(pool);
          for (const w of workers) hub?.emit({ type: "worker", worker: w });
        }
        send(res, 200, { ok: true });
        return;
      }

      if (method === "GET") {
        if (await tryServeStatic(res, pathOnly)) return;
      }

      notFound(res);
    } catch (err) {
      console.error("[scheduler] request error", err);
      send(res, 500, { error: String(err) });
    }
  });

  hub = attachHub(server, {
    getSnapshot: async () => {
      const workers = await listWorkers(pool);
      return { workers };
    },
  });

  const stopWatch = watchRepo(repoRootFromEnv(), () => {
    hub?.emit({ type: "diff" });
  });

  const reaper = setInterval(() => {
    void reapExpiredLeases(pool)
      .then((n) => {
        if (n > 0) console.log(`[scheduler] reaped ${n} expired lease(s)`);
      })
      .catch((err) => console.error("[scheduler] reaper error", err));
    void pruneGoneWorkers(pool).catch((err) =>
      console.error("[scheduler] worker prune error", err),
    );
  }, REAPER_MS);
  reaper.unref();

  server.listen(port, () => {
    console.log(`[scheduler] listening on http://127.0.0.1:${port}`);
  });
  server.on("error", (err) => {
    console.error("[scheduler] server error", err);
  });

  return {
    server,
    hub,
    close: async () => {
      stopWatch();
      clearInterval(reaper);
      hub?.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function main() {
  process.on("uncaughtException", (err) => {
    console.error("[scheduler] uncaughtException", err);
  });
  process.on("unhandledRejection", (err) => {
    console.error("[scheduler] unhandledRejection", err);
  });

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
