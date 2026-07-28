/**
 * Per-job artifact directories. Shared filesystem today; same layout is the
 * S3 key prefix later: {root}/{runId}/{jobId}/...
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.artifacts",
);

export const SCHEDULE_FILENAME = "schedule.json";
export const FAILURES_FILENAME = "failures.json";
export const PLAN_REQUEST_FILENAME = "plan-request.json";

export function artifactsRoot(): string {
  return process.env.SIEVE_ARTIFACTS_DIR?.trim() || DEFAULT_ROOT;
}

export function jobDir(runId: string, jobId: string): string {
  return path.join(artifactsRoot(), runId, jobId);
}

export async function ensureJobDir(runId: string, jobId: string): Promise<string> {
  const dir = jobDir(runId, jobId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export type DepDir = {
  name: string;
  jobId: string;
  path: string;
};
