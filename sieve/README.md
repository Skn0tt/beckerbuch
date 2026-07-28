# Sieve — test-focused CI control plane (PoC)

Local proof-of-concept for a scheduler that stores **per-test durations**
and an **inverted line-coverage index**, plus workers that claim jobs and
run bash commands that emit a standard NDJSON result stream (Playwright
is one producer).

## Design (short)

- **Postgres** is the source of truth (queue, leases, results).
- **One scheduler** HTTP frontend.
- **N workers** claim jobs (`FOR UPDATE SKIP LOCKED`); each job is bash.
- **Diff-aware scheduling**: budgeted `selectTests` from a single baseline
  run’s coverage, packed into contiguous shard jobs.
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
| `SIEVE_WORKERS` | `2` | Idle workers for the sidebar |
| `SIEVE_PORT` | `9101` | Scheduler listen port |

`serve-ui` boots Postgres (Testcontainers), applies [`src/schema.sql`](src/schema.sql),
loads `fixtures/baseline.sql`, then opens the dashboard.
Plan/Run read **uncommitted** changes via `git diff HEAD` (staged + unstaged).
Override with `SIEVE_BOOTSTRAP_DIFF_FILE` / `SIEVE_BOOTSTRAP_DIFF` if needed.

### Build a real corpus (`run-full`)

First boot can use an empty DB if you skip the fixture — or enqueue **one**
full Playwright suite (with the sieve reporter), wait for results, and dump
the SQL fixture for later `serve-ui` cold starts:

```bash
cd sieve && npm run serve-ui   # in one shell (scheduler + workers)
cd sieve && npm run run-full   # dumps fixtures/baseline.sql (gitignored)
# optional: SIEVE_PW_WORKERS=4 npm run run-full
# optional: npm run run-full -- --dump /tmp/baseline.sql
# optional: npm run run-full -- --no-wait
```

Uses `sieve/.database-url` written by `serve-ui` (or `SIEVE_DATABASE_URL`).
Restart `serve-ui` after the dump to reload the corpus (or refresh —
bootstrap picks the latest done run with results).

### Dashboard knobs

- **CPU time** → `selectTests` (diff-affected list; beyond-budget rows dimmed)
- **Wall time** → shard count `N = ceil(selectedDuration / latencyMs)`
- **Run** → diff-aware `POST /runs`; icons + worker cards update over WebSocket
- Empty / uncovered diffs → empty list (no unrelated corpus filler)

Workers are started by `serve-ui` (or manually with `npm run worker`).
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
| `--baseline` | Corpus run; if omitted, most recent `done` run with results |
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
`coverage_hits (run_id, test_id, file_path, line)`; diff-aware planning
queries only the lines in the diff instead of loading full per-test
arrays.

## Layout

```
sieve/
  public/              # HTML dashboard (served at /)
  fixtures/            # local baseline.sql (gitignored; from run-full)
  src/
    schema.sql
    scheduler.ts
    hub.ts
    plan.ts
    pack.ts
    workers.ts
    worker.ts
    cli.ts             # run-full | create-run-diff | status
    dump-baseline.ts
    coverage-hits.ts   # inverted index write + diff-scoped load
    commands.ts        # playwrightFullCommand + shard command
  scripts/
    serve-ui.ts        # demo boot (fixture → UI)
    demo.ts            # opaque Playwright bash demo
    diff-schedule.ts
```

## Non-goals

- Spawning workers from the UI
- Auth / TLS / replacing GitHub Actions
- Cross-run corpus merge or remapping `coverage_hits` across commits
