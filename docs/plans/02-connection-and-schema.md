# Phase 2 — Connection, schema, and automigrate primitives

**Status:** done  
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
  queue?: string | string[]; // node-resque constructor compatibility
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

`Queue` / `Worker` / `Scheduler` still take `{ connection: ConnectionOptions, ... }` to match node-resque call sites. Option interfaces are exported from `src/core/connection.ts` / `src/index.ts` now so later phases do not redefine them.

### Mapping help (document in JSDoc + README)

| node-resque | pgboss-queue |
| --- | --- |
| `{ host, port, password, database: 0 }` | `{ connectionString }` or `{ host, port, user, password, database: "myapp" }` |
| `{ redis: ioredis }` | `{ pool: pg.Pool }` |
| `{ namespace: "resque" }` | `{ schema: "resque" }` (legal SQL identifier only) |
| `{ namespace: ["a","b"] }` | not supported; use one schema name |

Runtime rejection: `pkg`, `redis`, and numeric `database` throw from the `Connection` constructor.

## `Connection` class

Port `src/core/connection.ts` *behavior*, not Redis:

- `connect()` — create pool unless `pool` was provided; always wrap the pool as pg-boss `db.executeSql` so `connection.pool` is a real `pg.Pool`. Construct `PgBoss` with `{ db, schema, migrate: false, supervise: false, schedule: false, application_name }`. Call `boss.start()` when the schema is installed; if pg-boss reports "not installed", leave the pool connected so `migrate()` can run, then start boss after migrate.
- `end()` — `boss.stop({ graceful: true, close: false })` (we own / borrow the pool); `pool.end()` only if we created the pool; remove forwarded `error` listeners.
- `connected` boolean
- Event `error` forwarded from pool and pg-boss
- `key(...parts)` — **keep** as a helper for lock key strings (`["lock", func, queue, args].join(":")`) stored in `locks.key`. Do not prefix Redis-style. Tests that assert `resque-test-0:thing` are Redis-only (Phase 8 skip).

Expose:

- `connection.boss: PgBoss`
- `connection.pool: pg.Pool` (owned or provided)
- `connection.schema: string`
- `connection.query<T>(text, values)` — parameterized; schema identifiers are validated once and interpolated only after `assertSchema`

```ts
async migrate(): Promise<void>
```

`migrate()` is idempotent:

1. `CREATE SCHEMA IF NOT EXISTS {schema}`
2. Short-lived `PgBoss` with `{ db, schema, migrate: true, supervise: false, schedule: false }` → `start()` / `stop({ close: false })`
3. Apply our metadata DDL (`CREATE TABLE IF NOT EXISTS` + indexes)
4. `boss.start()` on the long-lived instance if it was waiting on install

Workers never call this. Scheduler leader will. `specHelper.migrate()` calls it in `beforeAll`.

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

- `pgrq_workers_ping_at_idx` on `pgrq_workers (ping_at)`
- `pgrq_locks_expires_at_idx` on `pgrq_locks (expires_at)`

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

Expired lock rows are treated as absent (`DELETE` where `expires_at < now()` on read; `setLockNx` may take over an expired row via `ON CONFLICT … WHERE expires_at < now()`).

Leader helpers:

```ts
tryLeader(name: string, ttlSeconds: number): Promise<boolean>
  -- INSERT … ON CONFLICT (slot) DO UPDATE SET name, expires_at
  -- WHERE pgrq_leader.expires_at < now() OR pgrq_leader.name = EXCLUDED.name
  -- RETURNING name
releaseLeader(name: string): Promise<boolean>
currentLeader(): Promise<string | null>
```

`tryLeader` uses a single transaction. This is the Redis `SET NX EX` + refresh-if-mine pattern from `scheduler.tryForLeader`.

## pg-boss constructor flags (every instance)

| Flag | Worker / Queue | Scheduler (non-leader) | Scheduler (leader) |
| --- | --- | --- | --- |
| `migrate` | false | false | true iff `automigrate` |
| `supervise` | false | false | false (we sweep) |
| `schedule` | false | false | false (no pg-boss cron) |

We do not want two maintenance systems. pg-boss's built-in delete/archive would race our retention policy and might drop failed jobs.

Dependency: `pg-boss` (installed in this phase; currently `^12`).

## Tests (this phase)

Port in **this PR** (Phase 8 matrix: `connection.test.ts` + `connectionError.test.ts`). CI from Phase 1 must stay green.

Bun's test runner only discovers `*.test.ts` / `*.spec.ts` (and `_test_` / `_spec_` variants). Files live at `__tests__/core/connection.test.ts` and `__tests__/core/connectionError.test.ts` so `bun test` picks them up; **describe/test titles** still match node-resque.

Port-inspired plus the Adapt rows from Phase 8:

- connect with `connectionString`
- connect with discrete `host/port/user/password/database`
- connect with shared `pool` (ending Connection does not end the pool)
- reject illegal `schema` (`pgboss-queue`, `public; drop`, empty)
- reject Redis options (`pkg`, `redis`, numeric `database`)
- `migrate()` creates pg-boss `job` table and `pgrq_*` tables
- second `migrate()` is a no-op
- `tryLeader` : only one of two connections wins; after expiry the other wins
- `setLockNx` / expire / `delLock` (+ stats smoke)
- connectionError (bad host / port `127.0.0.1:1`)
- `specHelper.cleanup()` truncates `pgrq_*` and `job` (CASCADE); `specHelper.migrate()` / `dropSchema()` available

Do not defer these to Phase 8.

## Acceptance criteria

- Connection API compiles and is documented
- Schema install is idempotent
- No job enqueue yet (that is Phase 3)
- **`test.yaml` is green on the PR** (Postgres job runs the new files)
- `specHelper.cleanup()` leaves no leftover rows
- `node scripts/assert-node-package.mjs` imports `Connection` from compiled `dist`

## Next phase needs

`Connection.connect`, `query`, `boss`, `migrate`, lock/stat/leader helpers.

## Lessons learned

- 2026-08-26: Bun only discovers test files whose names contain `.test` / `.spec` / `_test_` / `_spec_`. Porting node-resque's `__tests__/core/connection.ts` verbatim meant `bun test` silently ran only `smoke.test.ts`. Use `connection.test.ts` / `connectionError.test.ts` and keep the upstream `describe`/`test` titles; document the path rename in Phase 8.
- 2026-08-26: Always pass a `pg.Pool` into pg-boss via `db: { executeSql }`. That keeps `connection.pool` typed as `Pool`, makes BYO-pool `end()` semantics obvious, and requires `boss.stop({ close: false })` so we do not double-close the pool.
- 2026-08-26: With `migrate: false`, `boss.start()` throws `pg-boss is not installed` before migrate. `connect()` treats that as "pool ready, boss deferred" so `migrate()` can install, then starts the long-lived boss.
- 2026-08-26: pg-boss is a named ESM export (`import { PgBoss } from "pg-boss"`), not a default export. Migrator instances use `migrate: true` + `supervise: false` + `schedule: false`.
- 2026-08-26: Version bumped `0.0.1` → `0.1.0` (first user-facing API: `Connection`).
- 2026-08-26: Node ESM (`"type": "module"`) requires relative import specifiers with `.js` extensions in emitted `dist/` (e.g. `from "./core/connection.js"`). Without them, `node scripts/assert-node-package.mjs` fails with `ERR_MODULE_NOT_FOUND` even though `tsc` and Bun tests pass.
- 2026-08-29: Phase 3 restored node-resque's optional `QueueOptions.queue` field. Queue methods still take an explicit queue name, but retaining the constructor field lets existing typed call sites migrate without an excess-property error.
