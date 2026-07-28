/**
 * Diff-aware planner job: plan against the scheduler DB via HTTP, write
 * shard specs + schedule.json into SIEVE_JOB_DIR, exit 0.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  flakeRerunCommand,
  playwrightShardFromSpecCommand,
} from "./commands.ts";
import { PLAN_REQUEST_FILENAME, SCHEDULE_FILENAME } from "./artifacts.ts";
import { shardSourceFiles } from "./pack.ts";
import { JOB_DIR_ENV } from "./protocol.ts";
import type { ScheduleJob } from "./schedule.ts";

export type PlanRequest = {
  diff: string;
  budgetMs: number;
  shardCount?: number;
  latencyMs?: number;
  baselineRunId?: string;
  pwWorkers?: number;
  deprioritizeFlakes?: boolean;
  preferPopular?: boolean;
};

async function main() {
  const jobDir = process.env[JOB_DIR_ENV];
  if (!jobDir) {
    console.error(`[planner] ${JOB_DIR_ENV} is required`);
    process.exit(1);
  }
  const schedulerUrl =
    process.env.SIEVE_SCHEDULER_URL ?? "http://127.0.0.1:9101";

  const reqPath = path.join(jobDir, PLAN_REQUEST_FILENAME);
  const req = JSON.parse(await readFile(reqPath, "utf8")) as PlanRequest;

  let shardCount = req.shardCount;
  if (shardCount === undefined && req.latencyMs !== undefined) {
    // Match /api/plan: plan at 1 shard to learn duration, then pack.
    const prelim = await postPlan(schedulerUrl, { ...req, shardCount: 1 });
    const selectedDur = (prelim.selected as Array<{ durationMs: number }>).reduce(
      (s, t) => s + t.durationMs,
      0,
    );
    shardCount = Math.max(
      1,
      Math.ceil(selectedDur / Math.max(Number(req.latencyMs), 1)),
    );
  }
  if (shardCount === undefined) shardCount = 2;

  const planned = await postPlan(schedulerUrl, { ...req, shardCount });
  const sourceById: Record<string, string> = {};
  for (const t of planned.selected as Array<{ testId: string; source: string }>) {
    sourceById[t.testId] = t.source;
  }

  const shardNames: string[] = [];
  const jobs: ScheduleJob[] = [];

  for (const shard of planned.shards as Array<{
    shardIndex: number;
    testIds: string[];
  }>) {
    const name = `shard-${shard.shardIndex}`;
    const specPath = path.join(jobDir, `${name}.json`);
    const files = shardSourceFiles(shard.testIds, sourceById);
    await writeFile(
      specPath,
      JSON.stringify({ testIds: shard.testIds, files }, null, 2),
      "utf8",
    );
    jobs.push({
      name,
      kind: "shard",
      command: playwrightShardFromSpecCommand(specPath, req.pwWorkers),
      shardIndex: shard.shardIndex,
      priority: shard.shardIndex,
    });
    shardNames.push(name);
  }

  if (jobs.length > 0) {
    jobs.push({
      name: "flake-rerun",
      kind: "flake_rerun",
      command: flakeRerunCommand(),
      needs: shardNames,
    });
    await writeFile(
      path.join(jobDir, SCHEDULE_FILENAME),
      JSON.stringify({ jobs }, null, 2),
      "utf8",
    );
    console.error(
      `[planner] scheduled ${shardNames.length} shard(s) + flake-rerun`,
    );
  } else {
    console.error("[planner] empty selection; no schedule.json");
  }
}

async function postPlan(
  schedulerUrl: string,
  req: PlanRequest & { shardCount: number },
): Promise<{
  selected: Array<{ testId: string; source: string; durationMs: number }>;
  shards: Array<{ shardIndex: number; testIds: string[] }>;
}> {
  const res = await fetch(`${schedulerUrl}/api/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      diff: req.diff,
      budgetMs: req.budgetMs,
      shardCount: req.shardCount,
      baselineRunId: req.baselineRunId,
      deprioritizeFlakes: req.deprioritizeFlakes,
      preferPopular: req.preferPopular,
    }),
  });
  const json = (await res.json()) as {
    error?: string;
    selected?: Array<{ testId: string; source: string; durationMs: number }>;
    shards?: Array<{ shardIndex: number; testIds: string[] }>;
  };
  if (res.status >= 400) {
    throw new Error(json.error ?? `plan failed (${res.status})`);
  }
  return {
    selected: json.selected ?? [],
    shards: json.shards ?? [],
  };
}

if (process.argv[1]?.endsWith("planner.ts")) {
  void main().catch((err) => {
    console.error("[planner]", err);
    process.exit(1);
  });
}
