export type RunStatus = "queued" | "running" | "done" | "failed";
export type JobStatus = "queued" | "running" | "done" | "failed";
export type AttemptStatus = "running" | "done" | "failed" | "superseded";

export type ClaimedJob = {
  jobId: string;
  attemptId: string;
  runId: string;
  specFile: string;
  leaseToken: string;
  attempt: number;
};

export type TestResultEvent = {
  type: "test_result";
  testId: string;
  specFile: string;
  status: string;
  durationMs: number;
  hitLines: string[];
};

export type ClaimBody = {
  workerId: string;
  runId?: string;
};

export type HeartbeatBody = {
  jobId: string;
  leaseToken: string;
  workerId?: string;
};

export type ResultBody = {
  jobId: string;
  leaseToken: string;
  attemptId: string;
  testId: string;
  specFile: string;
  status: string;
  durationMs: number;
  hitLines: string[];
};

export type CompleteBody = {
  jobId: string;
  leaseToken: string;
  attemptId: string;
  ok: boolean;
};
