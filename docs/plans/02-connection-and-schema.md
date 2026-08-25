# Phase 2 — Connection, schema, and automigrate primitives

**Status:** not-started  
**Depends on:** Phase 1

## Goal

Callers can connect to Postgres the way they connected to Redis in node-resque, and the library can install (1) pg-boss's schema and (2) our metadata tables. Migration is a function the **scheduler leader** will invoke; this phase only implements the primitive.

## Connection options

Replace node-resque's `ConnectionOptions` (`pkg`, `host`, `port`, `database: number`, `namespace`, `redis`).

```ts
export interface ConnectionOptions {
  /** postgres:// URL. Preferred. Parsed by `pg`. */
  connectionString?: string;
  host?: string;       // default 127.0.0.1
  port?: number;       // default 5432
  database?: string;   // database name (string, not Redis index)
  user?: string;
  password?: string;
  ssl?: boolean | object;
  /**
   * Existing node-postgres Pool. When set, we do not create or end a pool.
   * Analogous to passing `redis: ioredisInstance`.
   */
  pool?: import("pg").Pool;
  /**
   * pg-boss schema AND our metadata schema. Default `pgboss_queue`.
   * Must match `^[a-zA-Z_][a-zA-Z0-9_]*$` (reject otherwise).
   */
  schema?: string;
  application_name?: string; // default `pgboss-queue`
}

export interface QueueOptions {
  connection?: ConnectionOptions;
}

export interface WorkerOptions extends QueueOptions {
  name?: string;
  queues?: string[] | string;
  timeout?: number;
  looping?: boolean;
  id?: number;
}

export interface SchedulerOptions extends QueueOptions {
  name?: string;
  timeout?: number;
  leaderLockTimeout?: number; // seconds, default 180
  stuckWorkerTimeout?: number | false;
  retryStuckJobs?: boolean;
  /** Leader runs pg-boss migrate + metadata DDL. Default true. */
  automigrate?: boolean;
  /** Leader deletes completed/cancelled jobs older than this. Default 24h. `false` disables. */
  completeJobRetentionMs?: number | false;
}

export interface MultiWorkerOptions extends WorkerOptions {
  minTaskProcessors?: number;
  maxTaskProcessors?: number;
  checkTimeout?: number;
  maxEventLoopDelay?: number;
}
```

`Queue` / `Worker` / `Scheduler` still take `{ connection: ConnectionOptions, ... }` to match node-resque call sites.

### Mapping help (document in JSDoc + README)

| node-resque | pgboss-queue |
| --- | --- |
| `{ host, port, password, database: 0 }` | `{ connectionString }` or `{ host, port, user, password, database: "myapp" }` |
| `{ redis: ioredis }` | `{ pool: pg.Pool }` |
| `{ namespace: "resque" }` | `{ schema: "resque" }` (legal SQL identifier only) |
| `{ namespace: ["a","b"] }` | not supported; use one schema name |

## `Connection` class

Port `src/core/connection.ts` *behavior*, not Redis:

- `connect()` — create pool unless `pool` was provided; construct a `PgBoss` instance with `{ connectionString | host…, schema, migrate: false, supervise: false, schedule: false }`. Call `boss.start()` so the client is usable **without** migrating (pg-boss allows this when schema already exists; if it does not, start() may try to install — **disable migrate** and catch "schema missing" until `migrate()` runs). Verify against pg-boss version actually used: if `start()` always migrates, use the constructor `migrate: false` (documented: throws if schema absent). Tests that only connect after migrate are fine.
- `end()` — `boss.stop({ graceful: true })`; `pool.end()` only if we created the pool.
- `connected` boolean
- Event `error` forwarded from pool and pg-boss
- `key(...parts)` — **keep** as a helper for lock key strings (`["lock", func, queue, args].join(":")`) stored in `locks.key`. Do not prefix Redis-style. Tests that assert `resque-test-0:thing` are Redis-only (Phase 8 skip).

Expose:

- `connection.boss: PgBoss`
- `connection.pool: pg.Pool` (from boss or provided)
- `connection.schema: string`
- `connection.query<T>(text, values)` — parameterized, always-quoted schema interpolation only via validated identifier

```ts
async migrate(): Promise<void>
```

`migrate()` is idempotent:

1. `CREATE SCHEMA IF NOT EXISTS {schema}`
2. pg-boss migrate (instantiate a short-lived PgBoss with `migrate: true` **or** `boss.start()` on a migrator instance). Prefer the pg-boss CLI-equivalent API used in-process.
3. Apply our metadata DDL (`CREATE TABLE IF NOT EXISTS`).

Workers never call this. Scheduler leader will. `specHelper` will call it in `beforeAll`.

## Metadata DDL (ours)

All in `schema` (same as pg-boss), tables prefixed `pgrq_` so they never collide with pg-boss's `job`, `queue`, `schedule`, `version`, etc.

```sql
-- Leader election (Redis SET NX EX analogue)
CREATE TABLE IF NOT EXISTS {schema}.pgrq_leader (
  slot        text PRIMARY KEY DEFAULT 'default',
  name        text NOT NULL,
  expires_at  timestamptz NOT NULL
);

-- Registered workers + heartbeat + in-flight payload
CREATE TABLE IF NOT EXISTS {schema}.pgrq_workers (
  name        text PRIMARY KEY,
  queues      text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ping_at     timestamptz NOT NULL DEFAULT now(),
  working_on  jsonb
);

-- Plugin locks (JobLock / QueueLock / DelayQueueLock / Retry counters)
CREATE TABLE IF NOT EXISTS {schema}.pgrq_locks (
  key         text PRIMARY KEY,
  value       text,
  expires_at  timestamptz NOT NULL
);

-- Counters
CREATE TABLE IF NOT EXISTS {schema}.pgrq_stats (
  name        text PRIMARY KEY,
  value       bigint NOT NULL DEFAULT 0
);
```

Indexes:

- `pgrq_workers (ping_at)`
- `pgrq_locks (expires_at)`

Lock helpers on `Connection` (used by plugins and leader):

```ts
setLockNx(key: string, value: string, ttlSeconds: number): Promise<boolean>
getLock(key: string): Promise<string | null>
delLock(key: string): Promise<number>
expireLock(key: string, ttlSeconds: number): Promise<void>
incrStat(name: string, by?: number): Promise<void>
decrStat(name: string, by?: number): Promise<void>
getStats(): Promise<Record<string, number>>
```

Expired lock rows are treated as absent (`DELETE` where `expires_at < now()` on read, and by the scheduler sweeper).

Leader helpers:

```ts
tryLeader(name: string, ttlSeconds: number): Promise<boolean>
  -- INSERT … ON CONFLICT (slot) DO UPDATE SET name, expires_at
  -- WHERE pgrq_leader.expires_at < now() OR pgrq_leader.name = EXCLUDED.name
  -- RETURNING name
releaseLeader(name: string): Promise<boolean>
currentLeader(): Promise<string | null>
```

Use a single transaction. This is the Redis `SET NX EX` + refresh-if-mine pattern from `scheduler.tryForLeader`.

## pg-boss constructor flags (every instance)

| Flag | Worker / Queue | Scheduler (non-leader) | Scheduler (leader) |
| --- | --- | --- | --- |
| `migrate` | false | false | true iff `automigrate` |
| `supervise` | false | false | false (we sweep) |
| `schedule` | false | false | false (no pg-boss cron) |

We do not want two maintenance systems. pg-boss's built-in delete/archive would race our retention policy and might drop failed jobs.

## Tests (this phase)

Port-inspired, not full queue tests yet:

- connect with `connectionString`
- connect with discrete `host/port/user/password/database`
- connect with shared `pool` (ending Connection does not end the pool)
- reject illegal `schema` (`pgboss-queue`, `public; drop`, empty)
- `migrate()` creates pg-boss `job` table and `pgrq_*` tables
- second `migrate()` is a no-op
- `tryLeader` : only one of two connections wins; after expiry the other wins
- `setLockNx` / expire / `delLock`

## Acceptance criteria

- Connection API compiles and is documented
- Schema install is idempotent
- No job enqueue yet (that is Phase 3)
- CI uses `DATABASE_URL`

## Next phase needs

`Connection.connect`, `query`, `boss`, `migrate`, lock/stat/leader helpers.
