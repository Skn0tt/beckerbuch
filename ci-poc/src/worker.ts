/**
 * Worker: claims jobs from the scheduler, runs Playwright on one spec
 * file, forwards reporter IPC events (with lease token), heartbeats.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { open, rm, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LostLeaseError, SchedulerClient } from "./client.ts";
import type { ClaimedJob, TestResultEvent } from "./types.ts";

const HEARTBEAT_MS = Number(process.env.CI_POC_HEARTBEAT_MS ?? 10_000);
const IDLE_POLL_MS = Number(process.env.CI_POC_IDLE_POLL_MS ?? 2_000);
const IPC_DRAIN_TIMEOUT_MS = Number(
  process.env.CI_POC_IPC_DRAIN_TIMEOUT_MS ?? 30_000,
);
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const REPORTER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "reporter.ts",
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type TailHandle = {
  /** Resolves when the tail loop has exited. */
  done: Promise<void>;
  /** Stop polling after the current read/handler finishes. */
  stop: () => void;
  /**
   * Wait until the file cursor is at EOF, the partial-line buffer is
   * empty, and every onEvent handler has settled (or timeout).
   */
  drain: (timeoutMs: number) => Promise<void>;
};

/**
 * Polling NDJSON tail. `onEvent` is awaited serially so drain() can
 * wait for in-flight forwards to finish.
 */
function startNdjsonTail(
  filePath: string,
  onEvent: (ev: TestResultEvent) => Promise<void>,
): TailHandle {
  let stopped = false;
  let position = 0;
  let pending = "";
  let inFlight = 0;
  let wake: (() => void) | undefined;

  const poke = () => {
    wake?.();
    wake = undefined;
  };

  const waitTick = () =>
    new Promise<void>((resolve) => {
      wake = resolve;
      setTimeout(resolve, 50).unref?.();
    });

  const done = (async () => {
    const handle = await open(filePath, "a");
    await handle.close();

    while (!stopped) {
      try {
        const fh = await open(filePath, "r");
        try {
          const st = await fh.stat();
          if (st.size > position) {
            const length = st.size - position;
            const buf = Buffer.alloc(length);
            const { bytesRead } = await fh.read(buf, 0, length, position);
            position += bytesRead;
            pending += buf.subarray(0, bytesRead).toString("utf8");
            for (;;) {
              const nl = pending.indexOf("\n");
              if (nl < 0) break;
              const line = pending.slice(0, nl).trim();
              pending = pending.slice(nl + 1);
              if (!line) continue;
              try {
                const parsed = JSON.parse(line) as TestResultEvent;
                if (parsed.type !== "test_result") continue;
                inFlight += 1;
                try {
                  await onEvent(parsed);
                } finally {
                  inFlight -= 1;
                  poke();
                }
              } catch (err) {
                console.error("[worker] bad IPC line", err);
              }
            }
            poke();
          }
        } finally {
          await fh.close();
        }
      } catch (err) {
        if (!stopped) console.error("[worker] IPC tail error", err);
      }
      if (stopped) break;
      await waitTick();
    }
  })();

  return {
    done,
    stop() {
      stopped = true;
      poke();
    },
    async drain(timeoutMs: number) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let size = 0;
        try {
          size = (await stat(filePath)).size;
        } catch {
          // file gone — nothing left to read
          if (inFlight === 0 && pending.length === 0) return;
        }
        const caughtUp = position >= size && pending.length === 0 && inFlight === 0;
        if (caughtUp) return;
        if (Date.now() >= deadline) {
          throw new Error(
            `IPC drain timed out (pos=${position} size=${size} pending=${pending.length} inFlight=${inFlight})`,
          );
        }
        await sleep(20);
      }
    },
  };
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

async function runPlaywrightJob(
  client: SchedulerClient,
  workerId: string,
  job: ClaimedJob,
): Promise<boolean> {
  const ipcDir = path.join(os.tmpdir(), "ci-poc-ipc");
  await mkdir(ipcDir, { recursive: true });
  const resultsFile = path.join(ipcDir, `${job.jobId}.ndjson`);
  await rm(resultsFile, { force: true });
  await (await open(resultsFile, "w")).close();

  let lostLease = false;
  /** True if a result could not be persisted (non-fencing error). */
  let forwardFailed = false;
  let child: ChildProcess | undefined;

  const markLostLease = (why: string) => {
    if (lostLease) return;
    lostLease = true;
    console.warn(`[worker ${workerId}] ${why}`);
    if (child) killTree(child);
  };

  // Keep heartbeats running until after complete (or abandon) so the
  // lease cannot expire during IPC drain / final RPCs.
  const heartbeat = setInterval(() => {
    void client
      .heartbeat({
        jobId: job.jobId,
        leaseToken: job.leaseToken,
        workerId,
      })
      .catch((err) => {
        // Any heartbeat failure means we are no longer extending the
        // lease — treat as lost so we don't race a reaper reclaim.
        if (err instanceof LostLeaseError) {
          markLostLease("lost lease on heartbeat (409)");
        } else {
          markLostLease(`heartbeat failed; abandoning lease: ${String(err)}`);
        }
      });
  }, HEARTBEAT_MS);

  const tail = startNdjsonTail(resultsFile, async (ev) => {
    if (lostLease) return;
    try {
      await client.postResult({
        jobId: job.jobId,
        leaseToken: job.leaseToken,
        attemptId: job.attemptId,
        testId: ev.testId,
        specFile: ev.specFile,
        status: ev.status,
        durationMs: ev.durationMs,
        hitLines: ev.hitLines,
      });
      console.log(
        `[worker ${workerId}] forwarded ${ev.testId} (${ev.status}, ${ev.durationMs}ms, ${ev.hitLines.length} lines)`,
      );
    } catch (err) {
      if (err instanceof LostLeaseError) {
        markLostLease("lost lease posting result");
        return;
      }
      forwardFailed = true;
      console.error(`[worker ${workerId}] postResult error`, err);
    }
  });

  child = spawn(
    "npx",
    [
      "playwright",
      "test",
      job.specFile,
      "--workers=1",
      `--reporter=${REPORTER_PATH}`,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CI_POC_RESULTS_FILE: resultsFile,
        PLAYWRIGHT_FORCE_ASYNC_LOADER: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[pw ${workerId}] ${chunk.toString("utf8")}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[pw ${workerId}] ${chunk.toString("utf8")}`);
  });

  const exitCode: number = await new Promise((resolve) => {
    child!.on("exit", (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
  });

  // Drain IPC while heartbeats are still alive, then stop the tail.
  try {
    await tail.drain(IPC_DRAIN_TIMEOUT_MS);
  } catch (err) {
    forwardFailed = true;
    console.error(`[worker ${workerId}] IPC drain failed`, err);
  }
  tail.stop();
  await tail.done.catch(() => undefined);

  const abandonWithoutComplete = async (reason: string) => {
    clearInterval(heartbeat);
    console.warn(
      `[worker ${workerId}] abandoning job ${job.specFile} (${reason}); lease will expire for requeue`,
    );
    await rm(resultsFile, { force: true }).catch(() => undefined);
    return false;
  };

  if (lostLease) {
    return abandonWithoutComplete("lost lease");
  }

  // Results were dropped — do not mark the job done; stop heartbeats so
  // the reaper requeues and another attempt can persist the full set.
  if (forwardFailed) {
    return abandonWithoutComplete("incomplete result forward");
  }

  try {
    await client.complete({
      jobId: job.jobId,
      leaseToken: job.leaseToken,
      attemptId: job.attemptId,
      ok: exitCode === 0,
    });
    console.log(
      `[worker ${workerId}] completed ${job.specFile} exit=${exitCode}`,
    );
  } catch (err) {
    clearInterval(heartbeat);
    if (err instanceof LostLeaseError) {
      console.warn(`[worker ${workerId}] lost lease on complete`);
      await rm(resultsFile, { force: true }).catch(() => undefined);
      return false;
    }
    throw err;
  }

  clearInterval(heartbeat);
  await rm(resultsFile, { force: true }).catch(() => undefined);
  return exitCode === 0;
}

export async function workerLoop(opts: {
  schedulerUrl: string;
  workerId: string;
  runId?: string;
  once?: boolean;
}): Promise<void> {
  const client = new SchedulerClient(opts.schedulerUrl);
  console.log(
    `[worker ${opts.workerId}] starting against ${opts.schedulerUrl}` +
      (opts.runId ? ` run=${opts.runId}` : ""),
  );

  for (;;) {
    const job = await client.claim(opts.workerId, opts.runId);
    if (!job) {
      if (opts.once) {
        console.log(`[worker ${opts.workerId}] no job; exiting`);
        return;
      }
      await sleep(IDLE_POLL_MS);
      continue;
    }

    console.log(
      `[worker ${opts.workerId}] claimed ${job.specFile} attempt=${job.attempt}`,
    );
    await runPlaywrightJob(client, opts.workerId, job);
    if (opts.once) return;
  }
}

async function main() {
  const schedulerUrl =
    process.env.CI_POC_SCHEDULER_URL ?? "http://127.0.0.1:9101";
  const workerId =
    process.env.CI_POC_WORKER_ID ?? `worker-${process.pid}@${os.hostname()}`;
  const runId = process.env.CI_POC_RUN_ID;
  const once = process.env.CI_POC_ONCE === "1";
  await workerLoop({ schedulerUrl, workerId, runId, once });
}

if (process.argv[1]?.endsWith("worker.ts")) {
  void main();
}
