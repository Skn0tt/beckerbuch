-- Scheduler control-plane schema. Postgres is the source of truth for
-- the job queue, leases, and per-test results.
--
-- PoC: drop-and-recreate so schema iterations stay simple under
-- Testcontainers reuse.

DROP TABLE IF EXISTS test_results CASCADE;
DROP TABLE IF EXISTS job_attempts CASCADE;
DROP TABLE IF EXISTS jobs CASCADE;
DROP TABLE IF EXISTS workers CASCADE;
DROP TABLE IF EXISTS runs CASCADE;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label         text NOT NULL,
  status        text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'done', 'failed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

CREATE TABLE jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  command           text NOT NULL,
  status            text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'done', 'failed')),
  worker_id         text,
  lease_token       uuid,
  lease_expires_at  timestamptz,
  attempt           int NOT NULL DEFAULT 0,
  claimed_at        timestamptz,
  finished_at       timestamptz
);

CREATE INDEX jobs_run_status_idx ON jobs (run_id, status);
CREATE INDEX jobs_lease_expiry_idx
  ON jobs (lease_expires_at)
  WHERE status = 'running';

CREATE TABLE job_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_no    int NOT NULL,
  worker_id     text NOT NULL,
  lease_token   uuid NOT NULL,
  status        text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'done', 'failed', 'superseded')),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  UNIQUE (job_id, attempt_no)
);

CREATE TABLE test_results (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id    uuid NOT NULL REFERENCES job_attempts(id) ON DELETE CASCADE,
  run_id        uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  test_id       text NOT NULL,
  source        text NOT NULL DEFAULT '',
  status        text NOT NULL,
  duration_ms   double precision NOT NULL,
  hit_lines     text[] NOT NULL DEFAULT '{}',
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, test_id)
);

CREATE TABLE workers (
  id            text PRIMARY KEY,
  hostname      text,
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);
