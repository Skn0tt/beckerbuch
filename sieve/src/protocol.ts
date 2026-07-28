/**
 * Result-stream protocol between a job process and the worker.
 *
 * The worker sets `SIEVE_RESULTS_FILE` to a path. While the job's
 * bash command runs, any process may append NDJSON lines to that file.
 * The worker tails the file and forwards recognized events to the
 * scheduler. Playwright's reporter is one producer; anything else that
 * speaks this format works the same way.
 *
 * Line format (one JSON object per line):
 *
 *   {
 *     "type": "test_result",
 *     "testId": "string",
 *     "status": "passed" | "failed" | "timedOut" | "skipped" | ...,
 *     "durationMs": 12.5,
 *     "source": "optional/path/or/label",
 *     "titlePath": "optional › playwright › title path",
 *     "hitLines": ["app/foo.ts:10", "..."]   // optional
 *   }
 *
 * Unknown `type` values are ignored. Malformed lines are logged and skipped.
 */

export const RESULTS_FILE_ENV = "SIEVE_RESULTS_FILE";

/** JSON array of Playwright test.id values this shard should keep. */
export const TEST_IDS_ENV = "SIEVE_TEST_IDS";

export const TEST_RESULT_TYPE = "test_result" as const;

export type TestResultEvent = {
  type: typeof TEST_RESULT_TYPE;
  testId: string;
  status: string;
  durationMs: number;
  /** Optional locator (file path, suite name, …). */
  source?: string;
  /** Optional Playwright title path (`suite › test`). */
  titlePath?: string;
  /** Optional coverage hit keys (`file:line`). */
  hitLines?: string[];
};

export function isTestResultEvent(value: unknown): value is TestResultEvent {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.type !== TEST_RESULT_TYPE) return false;
  if (typeof v.testId !== "string" || v.testId.length === 0) return false;
  if (typeof v.status !== "string") return false;
  if (typeof v.durationMs !== "number" || !Number.isFinite(v.durationMs)) {
    return false;
  }
  if (v.source !== undefined && typeof v.source !== "string") return false;
  if (v.titlePath !== undefined && typeof v.titlePath !== "string") return false;
  if (v.hitLines !== undefined) {
    if (!Array.isArray(v.hitLines)) return false;
    if (!v.hitLines.every((x) => typeof x === "string")) return false;
  }
  return true;
}

/** Parse one NDJSON line. Returns null for blank, unknown type, or invalid. */
export function parseResultLine(line: string): TestResultEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isTestResultEvent(parsed)) return null;
  return {
    type: TEST_RESULT_TYPE,
    testId: parsed.testId,
    status: parsed.status,
    durationMs: parsed.durationMs,
    source: parsed.source,
    titlePath: parsed.titlePath,
    hitLines: parsed.hitLines ? [...parsed.hitLines] : undefined,
  };
}

export function formatResultLine(event: TestResultEvent): string {
  const body: TestResultEvent = {
    type: TEST_RESULT_TYPE,
    testId: event.testId,
    status: event.status,
    durationMs: event.durationMs,
  };
  if (event.source !== undefined) body.source = event.source;
  if (event.titlePath !== undefined) body.titlePath = event.titlePath;
  if (event.hitLines !== undefined) body.hitLines = event.hitLines;
  return JSON.stringify(body);
}
