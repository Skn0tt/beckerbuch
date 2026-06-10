// Lightweight, env-gated performance instrumentation.
//
// Everything here is a no-op unless `PERF_LOG=1` (or `true`) is set in the
// environment. It is intended to be enabled only on the throwaway perf
// playground deploy, never in production. It emits structured `[perf] ...`
// lines to stdout, which surface in `netlify logs:function`.
//
// We deliberately keep this at the database/connection layer plus a few
// boot markers so it captures the things that differ between "fast locally"
// and "slow in prod": serverless cold starts, Neon connection/wake cost, and
// per-query network round-trips.

const RAW = process.env.PERF_LOG;
export const PERF_ENABLED = RAW === "1" || RAW === "true";

// Captured the first time this module is evaluated. On a serverless platform
// a small "since boot" on the very first request means the function instance
// just cold-started.
export const PROCESS_BOOT_MS = Date.now();

let queryCount = 0;
let connectCount = 0;
let firstQueryDone = false;

function sinceBoot(): string {
  return `+${Date.now() - PROCESS_BOOT_MS}ms`;
}

export function perfLog(event: string, detail: Record<string, unknown> = {}): void {
  if (!PERF_ENABLED) return;
  const parts = Object.entries(detail).map(([k, v]) => `${k}=${v}`);
  console.log(`[perf] ${event} ${parts.join(" ")}`.trimEnd());
}

// Logged once when the pool is first created: which host/database this
// instance is actually talking to. Non-secret (no user/password). Doubles as
// the safety-gate fingerprint proving the playground hits a *branch* DB, not
// prod.
export function perfFingerprint(detail: Record<string, unknown>): void {
  perfLog("db-fingerprint", { ...detail, at: sinceBoot() });
}

export function noteConnect(): void {
  if (!PERF_ENABLED) return;
  connectCount += 1;
  console.log(`[perf] pg-connect #${connectCount} at=${sinceBoot()}`);
}

export function recordQuery(ms: number, sql: string): void {
  if (!PERF_ENABLED) return;
  queryCount += 1;
  const cold = !firstQueryDone;
  firstQueryDone = true;
  const text = sql.replace(/\s+/g, " ").trim().slice(0, 80);
  console.log(
    `[perf] q#${queryCount} dur=${ms.toFixed(1)}ms${cold ? " COLD-FIRST" : ""} at=${sinceBoot()} :: ${text}`,
  );
}
