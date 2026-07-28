# Sieve — test-focused CI control plane (PoC)

Local proof-of-concept for a scheduler that stores **per-test durations**
and an **inverted line-coverage index**, plus workers that claim jobs and
run bash commands that emit a standard NDJSON result stream (Playwright
is one producer).

## Design (short)

- **Postgres** is the source of truth (queue, leases, results).
- **One scheduler** HTTP frontend.
- **N workers** claim jobs (`FOR UPDATE SKIP LOCKED`); each job is bash.
- **Per-job artifact dirs** under `SIEVE_ARTIFACTS_DIR` (default
  `sieve/.artifacts/{runId}/{jobId}/`) — shared disk now, S3 prefix later.
- **Diff-aware runs** enqueue a **planner** job only. The planner calls
  `/api/plan`, writes `shard-N.json` specs + `schedule.json`, and exits.
  On planner `complete(ok)`, the scheduler parses `schedule.json` and
  inserts shard jobs plus a blocked **flake-rerun** that `needs` all shards.
- **Flake-rerun** unlocks when every shard is terminal, merges each shard’s
  `failures.json`, reruns failures, and decides the run status (shard exit
  codes alone do not fail the run when a flake job exists).
- **HTML UI**: `/` + bootstrap/plan HTTP; live workers/results over `/ws`.

## Demo UI (start here)

Needs a local SQL corpus at `fixtures/baseline.sql` (gitignored — generate
once with `run-full` below). Then:

```bash
cd sieve && npm install
npm run serve-ui
# open http://127.0.0.1:9101/
```

| Env | Default | Meaning |
|-----|---------|---------|
| `SIEVE_WORKERS` | `2` | How many worker commands `serve-ui` prints |
| `SIEVE_PORT` | `9101` | Scheduler listen port |
| `SIEVE_ARTIFACTS_DIR` | `sieve/.artifacts` | Shared job artifact root |

`serve-ui` boots Postgres (Testcontainers), applies [`src/schema.sql`](src/schema.sql),
loads `fixtures/baseline.sql`, starts the scheduler, then prints copy-paste
`npm run worker` commands (it does **not** start workers itself).
Plan/Run read **uncommitted** changes via `git diff HEAD` (staged + unstaged).
Override with `SIEVE_BOOTSTRAP_DIFF_FILE` / `SIEVE_BOOTSTRAP_DIFF` if needed.

### Build a real corpus (`run-full`)

First boot can use an empty DB if you skip the fixture — or enqueue **one**
full Playwright suite (with the sieve reporter), wait for results, and dump
the SQL fixture for later `serve-ui` cold starts:

```bash
cd sieve && npm run serve-ui   # in one shell (scheduler + workers)
cd sieve && npm run run-full   # dumps ALL finished runs → fixtures/baseline.sql
                               # + ~/Documents/beckerbuch-sieve/dump-*.sql
# optional: SIEVE_PW_WORKERS=4 npm run run-full
# optional: npm run run-full -- --dump /tmp/baseline.sql
# optional: npm run run-full -- --no-wait
# optional: npm run cli -- dump   # backup without running tests
```

Uses `sieve/.database-url` written by `serve-ui` (or `SIEVE_DATABASE_URL`).
Each dump is **naive**: every finished run with results (corpus **and**
diff-aware / PR shards), so restore does not drop product-change history.
Also writes stamped copies under `~/Documents/beckerbuch-sieve/`
(`dump-latest.sql` + timestamped; `corpus-latest.sql` kept as a copy).
Restart `serve-ui` after the dump to reload (or refresh — bootstrap still
picks the latest finished **corpus** run with results —
`baseline_run_id IS NULL`, including `failed` full runs — for the roster).

### Dashboard knobs

- **Plan / Signals tabs** → Plan is the diff-aware runner; Signals lists
  all **Popular failures** (red ★, DB fail and not a corpus flake) and
  **Flaky** (👻, corpus pass+fail) tests from full history via `GET /api/signals`
- **CPU time** → `selectTests` (diff-affected list; beyond-budget rows dimmed)
- **Wall time** → shard count `N = ceil(selectedDuration / latencyMs)`;
  tests are packed by **source file** (same-file together), splitting a file
  only when it exceeds the per-shard duration target, then LPT-balanced
  across shards
- **Deprioritize flakes** → density × `(1 - 0.9 × flipRate)` for tests that
  both passed and failed on **corpus** runs (`baseline_run_id IS NULL`).
  Flip rate = status changes between consecutive corpus outcomes /
  transitions. 👻 badge; hover for pass/fail + flip rate
- **Prefer popular failures** → density × `10` for tests that failed in the
  sieve DB but are **not** corpus flakes (flakes stay on the flaky signal).
  Red ★ badge; hover for fail counts
- **Run** → enqueues a planner job (`POST /runs`); shards + flake-rerun appear
  after the planner completes (`schedule.json`); icons + worker cards update
  over WebSocket (job cards show name/kind; per-shard `test_ids` live in
  planner artifact files, not the jobs row)
- Empty / uncovered diffs → Plan tab empty list; Run still starts a planner
  that writes no `schedule.json` and the run finishes clean

Start workers in other terminals with the commands `serve-ui` prints (or
`npm run worker` with `SIEVE_SCHEDULER_URL` / `SIEVE_WORKER_ID`).
`PLAYWRIGHT_BROWSERS_PATH` is cleared automatically (Cursor sandbox cache
breaks Chromium); you do not need to unset it by hand.

## Prerequisites

- Node ≥ 22.16
- Docker (Testcontainers)
- `cd sieve && npm install`
- Repo-root Playwright install (for `run-full`)

## Diff-aware CLI

Against a running scheduler with a baseline already loaded:

```bash
SIEVE_SCHEDULER_URL=http://127.0.0.1:9101 npm run cli -- create-run-diff my-pr \
  --cpu-time 60000 \
  --wall-time 30000 \
  --baseline <baselineRunId>

SIEVE_SCHEDULER_URL=http://127.0.0.1:9101 npm run cli -- status <runId>
```

Uses the same uncommitted diff as the UI (`git diff HEAD` = staged + unstaged).

| Flag / field | Meaning |
|--------------|---------|
| `--cpu-time <ms>` | CPU-time budget for `selectTests` (API: `budgetMs`) |
| `--wall-time <ms>` | Target wall time per shard → derives shard count (API: `latencyMs`) |
| `--shards N` | Explicit shard count (overrides `--wall-time`) |
| `--baseline` | Corpus run; if omitted, most recent finished corpus run (`baseline_run_id IS NULL`, `done` or `failed`) |
| `SIEVE_PW_WORKERS` | Optional Playwright `--workers` per shard |

Packing drill (synthetic DB, no UI):

```bash
cd sieve && npm run diff-schedule
```

## Result-stream protocol

The worker sets `SIEVE_RESULTS_FILE` before starting bash. Producers
append one JSON object per line:

```json
{
  "type": "test_result",
  "testId": "suite-or-id",
  "status": "passed",
  "durationMs": 12.5,
  "source": "optional/path/or/label",
  "titlePath": "optional › playwright › title",
  "hitLines": ["app/foo.ts:10"]
}
```

See [`src/protocol.ts`](src/protocol.ts). Coverage hits are written into
`coverage_hits (run_id, test_id, file_path, line)`. Diff-aware planning
uses the latest finished **corpus** run for the test roster, then for each test id
loads hit lines from that test’s last `passed` result (so a flaky red
latest full run still has green coverage to select against). Diff-aware
UI runs are not used as the roster (they point at a corpus via
`baseline_run_id`).

## Layout

```
sieve/
  public/              # HTML dashboard (served at /)
  fixtures/            # local baseline.sql (gitignored; from run-full)
  .artifacts/          # per-job dirs (gitignored; SIEVE_ARTIFACTS_DIR)
  src/
    schema.sql
    scheduler.ts
    artifacts.ts       # job dir helpers + schedule/failures filenames
    schedule.ts        # parse + apply schedule.json on complete
    unlock.ts          # blocked → queued/skipped/failed
    planner.ts         # planner job: plan → specs + schedule.json
    run-shard.ts       # shard from SIEVE_SHARD_SPEC
    flake-rerun.ts     # merge failures.json + rerun
    hub.ts
    plan.ts
    pack.ts            # file-group LPT shard packing
    workers.ts
    worker.ts
    cli.ts             # run-full | dump | create-run-diff | status
    dump-baseline.ts   # naive full-DB SQL dump + Documents backup
    coverage-hits.ts   # inverted index write + diff-scoped load
    flakiness.ts       # corpus pass+fail → flaky / flipRate flakeScore
    popular.ts         # DB fail − corpus flakes → popular (+ Prefer popular boost)
    signals.ts         # GET /api/signals popular + flaky inventory
    commands.ts        # playwright + planner/flake command builders
  scripts/
    serve-ui.ts        # demo boot (fixture → UI)
    demo.ts            # opaque Playwright bash demo
    diff-schedule.ts
    schedule-apply.ts  # schedule.json + unlock drill
```

## Non-goals

- Spawning workers from the UI
- Auth / TLS / replacing GitHub Actions
- Cross-run corpus merge or remapping `coverage_hits` across commits

## Follow-ups

- **Compress `coverage_hits`**: one row per `(run, test, file, line)` will
  not scale (fixture ≈ 1.6M rows / hundreds of MB with indexes for a small
  suite). Replace with int dictionaries + roaring (or plain RLE) bitmaps —
  inverted `(file, line) → tests` for planning, optional forward
  `(test, file) → lines`. Exact, OR-mergeable; keep sketches out of
  selection. Cross-commit remap / statement-keyed ids stay a later step
  (see Non-goals).
