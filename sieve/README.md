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
  "hitLines": ["app/foo.ts:10"]
}
```

`source` and `hitLines` are optional. Unknown `type` values are ignored.
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
  src/
    protocol.ts     # NDJSON result-stream contract
    schema.sql
    scheduler.ts
    worker.ts       # claim loop, bash -c, IPC forward
    reporter.ts     # Playwright producer of the protocol
    client.ts
    cli.ts
  scripts/
    demo.ts
    claim-race.ts
```

## Non-goals

- Multiple scheduler frontends in the demo
- Diff-aware scheduling from the DB
- Sharing the app-under-test Postgres across workers
- Auth / TLS / replacing GitHub Actions
