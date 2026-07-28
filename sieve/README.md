# Sieve — test-focused CI control plane (PoC)

Local proof-of-concept for a scheduler that stores **per-test durations**
and **line coverage**, plus workers that claim jobs and run **arbitrary
bash**. Test runners (e.g. Playwright) are just one kind of job command.

## Design (short)

- **Postgres** is the source of truth (queue, leases, results).
- **One scheduler** HTTP frontend (stateless — a second process can be
  added later without redesign).
- **N workers** claim jobs (`FOR UPDATE SKIP LOCKED`), each job is a
  bash command; the worker tails a standard NDJSON result stream.
- **Protocol, not Playwright**: the job process appends NDJSON to
  `$SIEVE_RESULTS_FILE`. The Playwright reporter happens to implement
  that protocol; any other producer works the same way.
- **Dead workers**: lease expiry + reaper (no explicit liveness protocol).
- **Zombie fencing**: every heartbeat / result / complete must present
  the current `lease_token` or get `409`.
- **Diff-aware scheduling**: `POST /runs` with `diff` + `budgetMs` loads
  coverage/durations from a **single baseline run**, runs `selectTests`,
  and packs selected test ids into **N contiguous shard jobs** (one bash
  job per shard; each gets `SIEVE_TEST_IDS`).
- **HTML UI**: scheduler serves `/` + `GET /api/bootstrap` / `POST /api/plan`;
  live workers/results push over WebSocket `/ws`.

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

`source`, `titlePath`, and `hitLines` are optional. Unknown `type` values are ignored.
See [`src/protocol.ts`](src/protocol.ts).

Minimal bash producer (no Playwright):

```bash
echo '{"type":"test_result","testId":"t1","status":"passed","durationMs":1,"source":"manual"}' \
  >> "$SIEVE_RESULTS_FILE"
```

## Prerequisites

- Node ≥ 22.16
- Docker (Testcontainers for the scheduler DB; also needed if your job
  command runs this repo's Playwright `globalSetup`)
- Repo root `npm install` (if demoing with Playwright)
- `cd sieve && npm install`

## Quick start

```bash
cd sieve && npm run claim-race
cd sieve && npm run diff-schedule
cd sieve && npm run ui-smoke

# Demo: bash jobs that wrap Playwright specs + the protocol reporter
cd sieve && npm run demo
```

Defaults for `npm run demo`:

| Env | Default | Meaning |
|-----|---------|---------|
| `SIEVE_SPECS` | `tests/coverage-select.unit.spec.ts` | Specs turned into Playwright bash jobs |
| `SIEVE_WORKERS` | `2` | Worker processes |
| `SIEVE_PORT` | `9101` | Scheduler listen port |
| `SIEVE_DEMO_TIMEOUT_MS` | `1800000` | Overall wait for the run |

```bash
SIEVE_SPECS=tests/coverage-select.unit.spec.ts,tests/smoke.spec.ts \
SIEVE_WORKERS=2 \
npm run demo
```

## Diff-aware create-run

Seed a baseline (any run that posts `test_results` with `hit_lines` +
durations), then schedule a budgeted subset against a unified diff:

```bash
# After a baseline run has finished and stored results:
SIEVE_SCHEDULER_URL=http://127.0.0.1:9101 npm run cli -- create-run-diff my-pr \
  --diff /tmp/d.diff \
  --budget 60000 \
  --baseline <baselineRunId> \
  --shards 2
```

| Field | Meaning |
|-------|---------|
| `diff` | Unified diff text (added `app/` lines only matter) |
| `budgetMs` | Duration budget for `selectTests` |
| `shardCount` | Number of shard jobs (default 2); empty shards omitted |
| `baselineRunId` | Corpus run; if omitted, most recent `done` run with results |
| `SIEVE_PW_WORKERS` | Optional Playwright `--workers` per shard (omit for PW default) |

Each shard job runs `npx playwright test` (no spec-file args) with
`SIEVE_TEST_IDS='["…"]'`. The sieve reporter’s `preprocess` keeps only
those ids. Spec paths are irrelevant at enqueue time.

If nothing in the baseline corpus covers the diff, the new run is created
with **0 jobs** and status `done` (no “run everything” fallback).

Corpus is **never** stitched across runs — line keys stay coherent
because they all came from one baseline execution.

Drill (synthetic DB, no Playwright):

```bash
cd sieve && npm run diff-schedule
```

## HTML dashboard (live UI)

The scheduler serves a light-mode dashboard at `http://127.0.0.1:9101/`.

- **HTTP** for bootstrap (`GET /api/bootstrap`), plan preview (`POST /api/plan`),
  and create-run (`POST /runs`).
- **WebSocket** `ws://host/ws` for live worker cards, heartbeats, job claims,
  and per-test result icons (no polling).
- Workers are started **outside** the UI; each idle poll calls
  `POST /workers/hello` so cards appear before the first claim.
- Worker cards show a heartbeat lamp (pulses on each hello/heartbeat;
  green within `2 × SIEVE_LEASE_SECONDS`, red when stale). Cards disappear
  after `4 × SIEVE_LEASE_SECONDS` with no hello.
- **Budget** feeds `selectTests`; **Latency** sets shard count
  `N = ceil(selectedDuration / latencyMs)` with contiguous packing.
- Needs a **baseline** run with `test_results` (same as CLI diff-aware create).

```bash
# Terminal A — scheduler (opens UI on /)
SIEVE_DATABASE_URL=postgres://... SIEVE_PORT=9101 npm run scheduler

# Terminal B/C — independent workers (appear on the right via WS)
SIEVE_SCHEDULER_URL=http://127.0.0.1:9101 SIEVE_WORKER_ID=w1 npm run worker
SIEVE_SCHEDULER_URL=http://127.0.0.1:9101 SIEVE_WORKER_ID=w2 npm run worker

# Browser
open http://127.0.0.1:9101/
```

Repo root for git diff / Playwright cwd: `SIEVE_REPO_ROOT` or parent of `sieve/`.

## Manual processes

```bash
# Terminal A — scheduler
SIEVE_DATABASE_URL=postgres://... SIEVE_PORT=9101 npm run scheduler

# Terminal B — create a run of arbitrary bash jobs
SIEVE_SCHEDULER_URL=http://127.0.0.1:9101 npm run cli -- create-run demo -- \
  'echo "{\"type\":\"test_result\",\"testId\":\"t1\",\"status\":\"passed\",\"durationMs\":1}" >> "$SIEVE_RESULTS_FILE"'

# Or wrap Playwright specs into protocol-emitting commands:
SIEVE_SCHEDULER_URL=http://127.0.0.1:9101 npm run cli -- create-run-playwright demo \
  tests/coverage-select.unit.spec.ts

# Terminal C — workers
SIEVE_SCHEDULER_URL=http://127.0.0.1:9101 \
SIEVE_WORKER_ID=w1 \
SIEVE_RUN_ID=<runId> \
npm run worker
```

## Chaos drills

1. **Double claim** — `npm run claim-race` must print equal `claimed` and
   `unique` counts (direct SQL and HTTP).
2. **Kill a worker mid-job** — stop a worker while a job is `running`.
   After `SIEVE_LEASE_SECONDS` (default 30), the reaper requeues; another
   worker claims with a **new** lease token.
3. **Kill the scheduler** — workers stall until it restarts; leases still
   expire in Postgres.
4. **Zombie worker** — stale `lease_token` after reassign → `409`; worker
   abandons the bash child.
5. **Incomplete result forward** — failed `postResult` (non-fencing)
   skips `/complete` so the lease expires and the job is requeued.

## Layout

```
sieve/
  public/           # HTML dashboard (served at /)
  src/
    protocol.ts     # NDJSON result-stream contract
    schema.sql
    scheduler.ts
    hub.ts          # WebSocket fanout for the UI
    plan.ts         # planDiffRun (select + contiguous pack)
    pack.ts         # contiguous duration-balanced shards
    workers.ts      # hello + worker snapshot
    git.ts          # bootstrap diff helpers
    commands.ts     # Playwright bash command builders
    worker.ts       # claim loop, bash -c, IPC forward
    reporter.ts     # Playwright producer + SIEVE_TEST_IDS filter
    client.ts
    cli.ts
  scripts/
    demo.ts
    claim-race.ts
    diff-schedule.ts
```

## Non-goals

- Spawning workers from the UI
- Multiple scheduler frontends / Redis pubsub fanout
- Sharing the app-under-test Postgres across workers
- Auth / TLS / replacing GitHub Actions
- Cross-run corpus merge, git SHA tracking, or remapping `hit_lines`
  across commits
