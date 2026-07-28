/**
 * After the corpus `run-full` batch finishes, apply two small product
 * changes in turn, run a budgeted diff-aware suite for each, then restore
 * the files. Writes a failure report under ~/Documents/beckerbuch-sieve/.
 *
 *   npx tsx scripts/product-change-experiments.ts
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SchedulerClient } from "../src/client.ts";
import { loadGitDiff } from "../src/git.ts";
import { writeCorpusBackups, resolveDatabaseUrl } from "../src/dump-baseline.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const BATCH_LOG = "/tmp/sieve-batch.log";
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
    id: "home-search-ux",
    title: "Home: snappier search debounce + clearer placeholder",
    file: path.join(REPO_ROOT, "app/routes/home.tsx"),
    apply: (src) =>
      src
        .replace(", 250);", ", 180);")
        .replace(
          'placeholder="Search recipes…"',
          'placeholder="Search by name or ingredient…"',
        ),
  },
  {
    id: "login-autofill",
    title: "Login: clearer invalid-credentials copy + username autofill tweak",
    file: path.join(REPO_ROOT, "app/routes/login.tsx"),
    apply: (src) =>
      src
        .replace('autoComplete="username"', 'autoComplete="email"')
        .replace(
          'return { error: "Invalid email or password." };',
          'return { error: "Invalid email or password. Try again." };',
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

async function waitForCorpusBatch() {
  await log(`waiting for corpus batch DONE in ${BATCH_LOG}`);
  for (;;) {
    try {
      const text = await readFile(BATCH_LOG, "utf8");
      if (text.includes("[batch] DONE")) {
        await log("corpus batch finished");
        return;
      }
    } catch {
      // log not ready yet
    }
    await sleep(15_000);
  }
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

  await waitForCorpusBatch();

  const dbUrl = await resolveDatabaseUrl();
  if (dbUrl) {
    const backup = await writeCorpusBackups(dbUrl);
    await log(
      `pre-experiment corpus backup: ${backup.runCount} runs → ${backup.stampedPath}`,
    );
  }

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
      "Diff-aware (non-corpus) runs for staged product changes. Failures are candidates for 'fails often outside main' — often intermittent DEMO FLAKE noise correlated with the suite each change selected.",
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
  await log("all product-change experiments finished");
}

void main().catch(async (err) => {
  console.error(err);
  await writeFile(EXP_LOG, `[exp] FATAL ${String(err)}\n`, { flag: "a" });
  process.exit(1);
});
