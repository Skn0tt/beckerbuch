# ci-poc — test-focused CI control plane (PoC)

Local proof-of-concept for a scheduler that stores **per-test durations**
and **line coverage**, plus workers that claim jobs and run this repo's
Playwright suite.

## Design (short)

- **Postgres** is the source of truth (queue, leases, results).
- **One scheduler** HTTP frontend (stateless — a second process can be
  added later without redesign).
- **N workers** claim file-level jobs (`FOR UPDATE SKIP LOCKED`), run
  `playwright test <file>`, and forward results.
- **Reporter → worker → scheduler**: the Playwright reporter only
  appends NDJSON to a local IPC file; the worker owns the lease token,
  heartbeats, and scheduler HTTP calls.
- **Dead workers**: lease expiry + reaper (no explicit liveness protocol).
- **Zombie fencing**: every heartbeat / result / complete must present
  the current `lease_token` or get `409`.

## Prerequisites

- Node ≥ 22.16
- Docker (Testcontainers for the scheduler DB **and** for Playwright's
  existing `globalSetup`)
- Repo root `npm install` (Playwright + app deps)
- `cd ci-poc && npm install`

## Quick start

```bash
# From repo root — proves SKIP LOCKED under concurrent claimers
cd ci-poc && npm run claim-race

# Full demo: Postgres + 1 scheduler + N workers + real Playwright specs
cd ci-poc && npm run demo
```

Defaults for `npm run demo`:

| Env | Default | Meaning |
|-----|---------|---------|
| `CI_POC_SPECS` | `tests/coverage-select.unit.spec.ts` | Comma-separated spec files to schedule |
| `CI_POC_WORKERS` | `2` | Worker processes |
| `CI_POC_PORT` | `9101` | Scheduler listen port |
| `CI_POC_DEMO_TIMEOUT_MS` | `1800000` | Overall wait for the run |

Example with two real suite files (heavy — each worker process runs
Playwright `globalSetup` independently):

```bash
CI_POC_SPECS=tests/coverage-select.unit.spec.ts,tests/smoke.spec.ts \
CI_POC_WORKERS=2 \
npm run demo
```

## Manual processes

```bash
# Terminal A — scheduler (needs CI_POC_DATABASE_URL)
CI_POC_DATABASE_URL=postgres://... CI_POC_PORT=9101 npm run scheduler

# Terminal B — create a run
CI_POC_SCHEDULER_URL=http://127.0.0.1:9101 npm run cli -- create-run demo \
  tests/coverage-select.unit.spec.ts

# Terminal C/D — workers
CI_POC_SCHEDULER_URL=http://127.0.0.1:9101 \
CI_POC_WORKER_ID=w1 \
CI_POC_RUN_ID=<runId> \
npm run worker
```

## Chaos drills

These are the distributed-systems behaviours the PoC is meant to show:

1. **Double claim** — `npm run claim-race` must print equal `claimed` and
   `unique` counts (direct SQL and HTTP).
2. **Kill a worker mid-job** — stop a worker process while a job is
   `running`. After `CI_POC_LEASE_SECONDS` (default 30), the reaper
   requeues the job; another worker claims it with a **new** lease token.
3. **Kill the scheduler** — workers cannot progress until it restarts.
   Leases still expire in Postgres; after restart, reaper + claims resume.
4. **Zombie worker** — if a worker is paused long enough to lose its
   lease and another worker takes the job, the paused worker's
   heartbeat/result/complete calls receive `409 lost_lease` and it
   abandons the child Playwright process.
5. **Incomplete result forward** — if `postResult` fails for a reason
   other than fencing, the worker does **not** call `/complete`; it
   stops heartbeats so the lease expires and the job is requeued.

## Layout

```
ci-poc/
  src/
    schema.sql      # runs, jobs, job_attempts, test_results, workers
    scheduler.ts    # HTTP API + reaper
    worker.ts       # claim loop, Playwright spawn, IPC forward
    reporter.ts     # Playwright reporter → NDJSON IPC only
    client.ts       # worker/CLI → scheduler HTTP
    cli.ts          # list-specs / create-run / status
  scripts/
    demo.ts         # orchestrated local demo
    claim-race.ts   # concurrent claim uniqueness check
```

## Non-goals

- Multiple scheduler frontends in the demo (schema/protocol stay compatible)
- Diff-aware scheduling from the DB (reuse `tests/coverage-select.ts` later)
- Sharing the app-under-test Postgres across workers
- Auth / TLS / replacing GitHub Actions
