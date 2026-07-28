import type {
  ClaimedJob,
  CompleteBody,
  HeartbeatBody,
  ResultBody,
} from "./types.ts";

export class LostLeaseError extends Error {
  constructor(message = "lost_lease") {
    super(message);
    this.name = "LostLeaseError";
  }
}

export class SchedulerClient {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: T }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as T;
    return { status: res.status, json };
  }

  async createRun(label: string, commands: string[]): Promise<{
    runId: string;
    jobCount: number;
  }> {
    const { status, json } = await this.request<{
      runId: string;
      jobCount: number;
      error?: string;
    }>("POST", "/runs", { label, commands });
    if (status >= 400) {
      throw new Error(json.error ?? `createRun failed (${status})`);
    }
    return json;
  }

  async createDiffRun(opts: {
    label: string;
    diff: string;
    budgetMs: number;
    /** Target wall-clock per shard; used when shardCount is omitted. */
    latencyMs?: number;
    shardCount?: number;
    baselineRunId?: string;
    pwWorkers?: number;
  }): Promise<{
    runId: string;
    jobCount: number;
    baselineRunId: string;
    selectedTestIds: string[];
    shards: Array<{ shardIndex: number; testIds: string[] }>;
  }> {
    const { status, json } = await this.request<{
      runId: string;
      jobCount: number;
      baselineRunId: string;
      selectedTestIds: string[];
      shards: Array<{ shardIndex: number; testIds: string[] }>;
      error?: string;
    }>("POST", "/runs", opts);
    if (status >= 400) {
      throw new Error(json.error ?? `createDiffRun failed (${status})`);
    }
    return json;
  }

  async getRun(runId: string): Promise<{
    run: {
      id: string;
      label: string;
      status: string;
      baseline_run_id?: string | null;
    };
    jobs: Array<Record<string, unknown>>;
    results: Array<Record<string, unknown>>;
  }> {
    const { status, json } = await this.request<{
      run: {
        id: string;
        label: string;
        status: string;
        baseline_run_id?: string | null;
      };
      jobs: Array<Record<string, unknown>>;
      results: Array<Record<string, unknown>>;
      error?: string;
    }>("GET", `/runs/${runId}`);
    if (status >= 400) {
      throw new Error(json.error ?? `getRun failed (${status})`);
    }
    return json;
  }

  async hello(workerId: string, hostname?: string): Promise<void> {
    const { status, json } = await this.request<{ error?: string }>(
      "POST",
      "/workers/hello",
      { workerId, hostname },
    );
    if (status >= 400) {
      throw new Error(json.error ?? `hello failed (${status})`);
    }
  }

  async claim(workerId: string, runId?: string): Promise<ClaimedJob | null> {
    const { status, json } = await this.request<{
      job: ClaimedJob | null;
      error?: string;
    }>("POST", "/claim", { workerId, runId });
    if (status >= 400) {
      throw new Error(json.error ?? `claim failed (${status})`);
    }
    return json.job;
  }

  async heartbeat(body: HeartbeatBody): Promise<void> {
    const { status, json } = await this.request<{ error?: string }>(
      "POST",
      "/heartbeat",
      body,
    );
    if (status === 409) throw new LostLeaseError();
    if (status >= 400) {
      throw new Error(json.error ?? `heartbeat failed (${status})`);
    }
  }

  async postResult(body: ResultBody): Promise<void> {
    const { status, json } = await this.request<{ error?: string }>(
      "POST",
      "/results",
      body,
    );
    if (status === 409) throw new LostLeaseError();
    if (status >= 400) {
      throw new Error(json.error ?? `postResult failed (${status})`);
    }
  }

  async complete(body: CompleteBody): Promise<void> {
    const { status, json } = await this.request<{ error?: string }>(
      "POST",
      "/complete",
      body,
    );
    if (status === 409) throw new LostLeaseError();
    if (status >= 400) {
      throw new Error(json.error ?? `complete failed (${status})`);
    }
  }

  async health(): Promise<boolean> {
    try {
      const { status } = await this.request<{ ok: boolean }>("GET", "/health");
      return status === 200;
    } catch {
      return false;
    }
  }
}
