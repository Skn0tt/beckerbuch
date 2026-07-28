/**
 * Apply small product changes in turn, run a budgeted diff-aware suite for
 * each, restore the files, then dump the full DB (corpus + diff runs).
 *
 *   npx tsx scripts/product-change-experiments.ts
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SchedulerClient } from "../src/client.ts";
import { loadGitDiff } from "../src/git.ts";
import {
  writeDatabaseBackups,
  resolveDatabaseUrl,
} from "../src/dump-baseline.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const EXP_LOG = "/tmp/sieve-product-experiments.log";
const BACKUP_DIR = path.join(
  process.env.HOME ?? "/tmp",
  "Documents",
  "beckerbuch-sieve",
);

type Experiment = {
  id: string;
  title: string;
  file: string;
  apply: (original: string) => string;
};

const experiments: Experiment[] = [
  {
    id: "home-search-copy",
    title: "Home: friendlier search placeholder + slightly snappier debounce",
    file: path.join(REPO_ROOT, "app/routes/home.tsx"),
    apply: (src) =>
      src
        .replace(", 250);", ", 200);")
        .replace(
          'placeholder="Search recipes…"',
          'placeholder="Find a recipe…"',
        )
        .replace(
          'aria-label="Search recipes"',
          'aria-label="Find a recipe"',
        ),
  },
  {
    id: "login-error-copy",
    title: "Login: clearer invalid-credentials copy + email autofill hint",
    file: path.join(REPO_ROOT, "app/routes/login.tsx"),
    apply: (src) =>
      src
        .replace('autoComplete="username"', 'autoComplete="email"')
        .replace(
          'return { error: "Invalid email or password." };',
          'return { error: "That email or password didn\'t work." };',
        ),
  },
  {
    id: "kitchen-filter-placeholder",
    title: "Kitchen: clearer planned-ingredients filter placeholder",
    file: path.join(REPO_ROOT, "app/routes/kitchen.tsx"),
    apply: (src) =>
      src
        .replace('placeholder="Filter…"', 'placeholder="Filter ingredients…"')
        .replace(
          'aria-label="Filter planned ingredients"',
          'aria-label="Filter ingredients list"',
        ),
  },
];

async function log(line: string) {
  const msg = `[exp] ${line}`;
  console.log(msg);
  await writeFile(EXP_LOG, msg + "\n", { flag: "a" }).catch(() => undefined);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForRun(
  client: SchedulerClient,
  runId: string,
  timeoutMs = 3_600_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${runId}`);
    const summary = await client.getRun(runId);
    const done =
      summary.run.status === "done" || summary.run.status === "failed";
    await log(
      `run ${runId.slice(0, 8)}… status=${summary.run.status} results=${summary.results.length}`,
    );
    if (done) return summary;
    await sleep(8_000);
  }
}

function resultFields(row: Record<string, unknown>) {
  return {
    testId: String(row.test_id ?? row.testId ?? ""),
    titlePath: String(row.title_path ?? row.titlePath ?? row.source ?? ""),
    status: String(row.status ?? ""),
  };
}

async function main() {
  await writeFile(EXP_LOG, "", "utf8");
  await mkdir(BACKUP_DIR, { recursive: true });

  const schedulerUrl =
    process.env.SIEVE_SCHEDULER_URL ?? "http://127.0.0.1:9101";
  const client = new SchedulerClient(schedulerUrl);
  if (!(await client.health())) {
    throw new Error(`scheduler not healthy at ${schedulerUrl}`);
  }
  await log(`scheduler healthy at ${schedulerUrl}`);

  const reports: Array<{
    id: string;
    title: string;
    runId: string;
    selected: number;
    passed: number;
    failed: Array<{ testId: string; titlePath: string; status: string }>;
  }> = [];

  for (const exp of experiments) {
    const abs = exp.file;
    const original = await readFile(abs, "utf8");
    const next = exp.apply(original);
    if (next === original) {
      throw new Error(`experiment ${exp.id} produced no file change`);
    }
    await writeFile(abs, next, "utf8");
    await log(`applied ${exp.id}: ${exp.title}`);

    try {
      const { diffText, diffLineCount } = await loadGitDiff(REPO_ROOT);
      await log(`${exp.id} diff covers ${diffLineCount} app/ line(s)`);
      const created = await client.createDiffRun({
        label: `product-${exp.id}-${new Date().toISOString()}`,
        diff: diffText,
        budgetMs: 180_000,
        latencyMs: 60_000,
        pwWorkers: 4,
      });
      await log(
        `${exp.id} enqueued run ${created.runId} (${created.selectedTestIds.length} tests, ${created.jobCount} shard(s))`,
      );
      const summary = await waitForRun(client, created.runId);
      const parsed = summary.results.map(resultFields);
      const failed = parsed.filter(
        (r) =>
          r.status === "failed" ||
          r.status === "timedOut" ||
          r.status === "unexpected",
      );
      const passed = parsed.filter((r) => r.status === "passed").length;
      reports.push({
        id: exp.id,
        title: exp.title,
        runId: created.runId,
        selected: created.selectedTestIds.length,
        passed,
        failed,
      });
      await log(
        `${exp.id} done: passed=${passed} failed=${failed.length} (run status=${summary.run.status})`,
      );
    } finally {
      await writeFile(abs, original, "utf8");
      await log(`restored ${path.relative(REPO_ROOT, abs)}`);
    }
  }

  const byTest = new Map<
    string,
    { titlePath: string; experiments: string[]; statuses: string[] }
  >();
  for (const rep of reports) {
    for (const f of rep.failed) {
      const cur = byTest.get(f.testId) ?? {
        titlePath: f.titlePath,
        experiments: [],
        statuses: [],
      };
      cur.experiments.push(rep.id);
      cur.statuses.push(f.status);
      byTest.set(f.testId, cur);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    note:
      "Diff-aware (non-corpus) runs for staged product changes. Failures feed the popular-failure signal when they are not corpus flakes.",
    experiments: reports,
    failProneness: [...byTest.entries()]
      .map(([testId, v]) => ({
        testId,
        titlePath: v.titlePath,
        failWindows: v.experiments.length,
        experiments: v.experiments,
        statuses: v.statuses,
      }))
      .sort(
        (a, b) =>
          b.failWindows - a.failWindows ||
          a.titlePath.localeCompare(b.titlePath),
      ),
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(BACKUP_DIR, `product-change-failures-${stamp}.json`);
  const latestReport = path.join(
    BACKUP_DIR,
    "product-change-failures-latest.json",
  );
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(latestReport, JSON.stringify(report, null, 2) + "\n", "utf8");
  await log(`wrote ${reportPath}`);
  await log(`wrote ${latestReport}`);

  const dbUrl = await resolveDatabaseUrl();
  if (!dbUrl) {
    await log("no database URL — skip full dump");
  } else {
    const backup = await writeDatabaseBackups(dbUrl);
    await log(
      `full dump ${backup.runCount} run(s), ${backup.resultCount} results → ${backup.fixturePath}`,
    );
    await log(`backup ${backup.stampedPath}`);
    await log(`backup ${backup.latestPath}`);
  }

  await log("all product-change experiments finished");
}

void main().catch(async (err) => {
  console.error(err);
  await writeFile(EXP_LOG, `[exp] FATAL ${String(err)}\n`, { flag: "a" });
  process.exit(1);
});
