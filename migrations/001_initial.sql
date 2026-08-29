CREATE TABLE IF NOT EXISTS {{schema}}.pgrq_queues (
  name        text PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS {{schema}}.pgrq_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL REFERENCES {{schema}}.pgrq_queues(name),
  data          jsonb NOT NULL,
  state         text NOT NULL DEFAULT 'created'
                CHECK (state IN ('created', 'retry', 'active', 'completed', 'cancelled', 'failed')),
  priority      integer NOT NULL DEFAULT 0,
  created_on    timestamptz NOT NULL DEFAULT now(),
  start_after   timestamptz NOT NULL DEFAULT now(),
  started_on    timestamptz,
  completed_on  timestamptz,
  output        jsonb
);

CREATE INDEX IF NOT EXISTS pgrq_jobs_fetch_idx
  ON {{schema}}.pgrq_jobs (name, state, start_after, priority DESC, created_on, id);

CREATE INDEX IF NOT EXISTS pgrq_jobs_delayed_idx
  ON {{schema}}.pgrq_jobs (start_after, created_on)
  WHERE state IN ('created', 'retry');

CREATE INDEX IF NOT EXISTS pgrq_jobs_failed_idx
  ON {{schema}}.pgrq_jobs (completed_on, created_on, id)
  WHERE state = 'failed';

CREATE TABLE IF NOT EXISTS {{schema}}.pgrq_leader (
  slot        text PRIMARY KEY DEFAULT 'default',
  name        text NOT NULL,
  expires_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS {{schema}}.pgrq_workers (
  name        text PRIMARY KEY,
  queues      text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ping_at     timestamptz NOT NULL DEFAULT now(),
  working_on  jsonb
);

CREATE TABLE IF NOT EXISTS {{schema}}.pgrq_locks (
  key         text PRIMARY KEY,
  value       text,
  expires_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS {{schema}}.pgrq_stats (
  name        text PRIMARY KEY,
  value       bigint NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS pgrq_workers_ping_at_idx
  ON {{schema}}.pgrq_workers (ping_at);

CREATE INDEX IF NOT EXISTS pgrq_locks_expires_at_idx
  ON {{schema}}.pgrq_locks (expires_at);
