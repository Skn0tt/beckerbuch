-- Scheduler control-plane schema. Postgres is the source of truth for
-- the job queue, leases, and per-test results.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label         text NOT NULL,
  status        text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'done', 'failed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

CREATE TABLE IF NOT EXISTS jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  spec_file         text NOT NULL,
  status            text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'done', 'failed')),
  worker_id         text,
  lease_token       uuid,
  lease_expires_at  timestamptz,
  attempt           int NOT NULL DEFAULT 0,
  claimed_at        timestamptz,
  finished_at       timestamptz
);

CREATE INDEX IF NOT EXISTS jobs_run_status_idx ON jobs (run_id, status);
CREATE INDEX IF NOT EXISTS jobs_lease_expiry_idx
  ON jobs (lease_expires_at)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS job_attempts (
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

CREATE TABLE IF NOT EXISTS test_results (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id    uuid NOT NULL REFERENCES job_attempts(id) ON DELETE CASCADE,
  run_id        uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  test_id       text NOT NULL,
  spec_file     text NOT NULL,
  status        text NOT NULL,
  duration_ms   double precision NOT NULL,
  hit_lines     text[] NOT NULL DEFAULT '{}',
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, test_id)
);

CREATE TABLE IF NOT EXISTS workers (
  id            text PRIMARY KEY,
  hostname      text,
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);
