# Phase 0 — Overview and architecture

**Status:** done (this document *is* the phase)

## Goal

Define the product so later phases do not have to re-litigate it: a node-resque-compatible job runtime whose queues live in Postgres.

## Product

`pg-queue` is a library, not a framework. Callers construct `Queue`, `Worker`, and `Scheduler` (and optionally `MultiWorker`), pass a Postgres connection, register a `jobs` hash, and run.

It is the storage/runtime Keryx should eventually sit on top of, instead of either Redis node-resque or a one-off `PgBossBackend` that drops half the resque API.

### The factory (from the node-resque README)

- **Queues** are conveyor belts: regular work, delayed work, and failed work.
- **Workers** each run one job at a time. They pull from assigned queues (left-to-right = priority), succeed or write to failed, then pull again.
- **Scheduler** is a specialized worker that does not run jobs. Many instances run; **one is leader**. The leader:
  1. Makes delayed jobs eligible when their `start_after` time arrives and emits compatible events.
  2. Cleans stuck workers (heartbeat older than `stuckWorkerTimeout`).
  3. **New:** runs schema automigrate when `automigrate: true`.
  4. **New:** sweeps completed jobs older than `completeJobRetentionMs` (default 24h).

Workers and schedulers are safe to run as many processes, many machines. Dequeue is exactly-once via `SELECT … FOR UPDATE SKIP LOCKED`.

## Why an owned PostgreSQL store

Keryx PR [#519](https://github.com/actionhero/keryx/pull/519) established PostgreSQL and `SKIP LOCKED` as the right storage model. Initial phases used pg-boss as a store, but Phase 3 demonstrated that nearly every node-resque inspection and administration operation still required direct SQL while pg-boss's worker, scheduler, retry, and retention systems were disabled.

We therefore own a deliberately small, versioned schema: `pgrq_queues`, `pgrq_jobs`, and the existing metadata tables. This is not a general pg-boss replacement. It implements only the resque lifecycle we expose: enqueue, delayed eligibility, atomic claim, complete/fail/cancel, inspection, and leader-driven retention.

## Mapping: node-resque → pg-queue

| node-resque (Redis) | pg-queue (Postgres) |
| --- | --- |
| `connection.host/port/database/password` (Redis) | `connectionString` **or** `host/port/database/user/password/ssl` **or** `pool` |
| `namespace` / keyPrefix | `schema` (default `pgqueue`) |
| List `queue:{name}` (`RPUSH`/`LPOP`) | `pgrq_jobs`, `state IN ('created','retry')`, `start_after <= now()` |
| `delayed:{ts}` + `delayed_queue_schedule` zset | `pgrq_jobs.start_after` in the future |
| `failed` list | `pgrq_jobs.state = 'failed'` (payload mapped to `ParsedFailedJobPayload`) |
| Lua `popAndStoreJob` | Atomic update selected with `FOR UPDATE SKIP LOCKED`; worker row in `pgrq_workers` |
| `SET NX EX` leader lock | `leader` row with `expires_at` (same NX/expiry semantics) |
| `worker:ping:{name}` | `workers.ping_at` |
| `lock:*` / `workerslock:*` | `locks` table (`key`, `expires_at`) |
| `stat:processed` / `stat:failed` | `stats` table |
| `smembers queues` | `pgrq_queues` |
| Scheduler promotes delayed → list | Job becomes fetchable when `start_after <= now()`; leader still polls and emits `workingTimestamp` / `transferredJob` for compatibility |
| Redis cleanup | Leader sweeper deletes `completed`/`cancelled` older than retention. **Failed jobs are kept** until `removeFailed` / retry. |

### Classes (public, names frozen)

Same as `node-resque/src/index.ts`:

- `Connection`
- `Queue` + `ParsedJob`, `ParsedWorkerPayload`, `ParsedFailedJobPayload`
- `Scheduler`
- `Worker`
- `MultiWorker`
- `Plugin`
- `Plugins` (`JobLock`, `QueueLock`, `DelayQueueLock`, `Retry`, `Noop`)

### Events (must emit)

**Worker:** `start`, `end`, `cleaning_worker`, `poll`, `ping`, `job`, `reEnqueue`, `success`, `failure`, `error`, `pause`

**Scheduler:** `start`, `end`, `poll`, `leader`, `cleanStuckWorker`, `error`, `workingTimestamp`, `transferredJob`

**Queue:** `error`

**MultiWorker:** all worker events prefixed with `workerId`, plus `multiWorkerAction`

## Lessons from keryx#519 (use)

1. **Connection strings, not Redis hashes.** `config.database.connectionString` / `new PgBoss({ connectionString, schema })`.
2. **Schema isolation.** Default `keryx_tasks` there; we default `pgqueue`. Validate identifier safety (`^[a-zA-Z_][a-zA-Z0-9_]*$`) and reject PostgreSQL's reserved `pg_` prefix.
3. **SQL introspection.** `queued`, `del`, `delDelayed`, `scheduledAt`, and `failed*` are parameterized SQL on `pgrq_jobs`.
4. **Payload shape.** Store `{ class, queue, args }` (resque encode) in `data`.
5. **Create queues lazily.** Insert `pgrq_queues` with `ON CONFLICT DO NOTHING` before enqueue.
6. **One maintenance owner.** The Scheduler leader is the one process allowed to migrate and delete old rows.
7. **Recurring uniqueness.** It is not part of node-resque v1. Leader + `scheduler.leader` remains the supported way to gate CRON.
8. **Retention.** keryx used `deleteAfterSeconds` default 7 days. We default **24 hours** for *completed* jobs, leader-driven, not pg-boss supervise on every instance.
9. **No store-level retry.** node-resque does not retry unless the Retry plugin is attached.

## Lessons from keryx#519 (do not copy)

- Replacing `Worker` with a generic handler registration — loses one-job-at-a-time-per-Worker, plugin `beforePerform`, queue priority walk, and events.
- No leader — loses `queue.leader()`, CRON gating, single migrator, single sweeper.
- Dropping `locks`, `delLock`, `timestamps`, `delayedAt`, `allDelayed`, `workingOn`, `cleanOldWorkers`, `delByFunction`, `delQueue` — those are in the node-resque test suite and in resque-admin.
- Removing the plugin system.
- Mixing framework concerns (Actions, fan-out tables) into this library. Fan-out stays in Keryx.

## node-resque feature inventory (from README + examples + tests)

Covered in later phases; listed here so nothing is "forgotten":

- Connection: connect/end, shared client, error listeners, schema/namespace
- Queue: enqueue / enqueueAt / enqueueIn (duplicate delayed error + suppress flag), queues, delQueue, length, del, delByFunction, delDelayed, scheduledAt, timestamps, delayedAt, queued, allDelayed, locks, delLock, workers, workingOn, allWorkingOn, forceCleanWorker, cleanOldWorkers, failedCount, failed, removeFailed, retryAndRemoveFailed, retryStuckJobs, leader, stats
- Worker: queues array or `"*"`, looping, timeout, name `hostname:pid[+n]`, init/track/ping/untrack, getJob, perform, complete, succeed/fail, pause, performInline (not on a started worker, no IO)
- Scheduler: timeout, stuckWorkerTimeout (`false` disables), leaderLockTimeout, retryStuckJobs, tryForLeader / release, nextDelayedTimestamp, transfer, checkStuckWorkers
- Plugins: four hooks, `toRun` boolean on befores, `this.worker.error` mutation, five built-ins
- MultiWorker: min/max, checkTimeout, maxEventLoopDelay, event forwarding
- Examples to port as `examples/*.ts`: `example.ts`, `errorExample.ts`, `retry.ts`, `scheduledJobs.ts`, `stuckWorker.ts`, `multiWorker.ts`, `performInline.ts`, `customPluginExample.ts`, `cluster.ts`

Explicitly **not** in node-resque (and not in v1 unless noted):

- Built-in CRON (users bring `node-schedule` / `node-cron` and gate on `scheduler.leader`)
- Web UI (ah-resque-ui / keryx resque-admin) — later package
- Redis pub/sub

## Postgres-only options (required)

### 1. Database connection (not Redis)

Preferred:

```ts
{ connectionString: "postgres://user:pass@host:5432/dbname" }
```

Also:

```ts
{ host, port, database, user, password, ssl }
{ pool: existingPgPool }
```

`database` is a **string name**, never a Redis integer. Passing `{ database: 0 }` is a TypeScript error.

### 2. `automigrate: boolean` (default `true`)

Only the **elected scheduler** applies bundled, versioned migrations. If no scheduler is running, tests/deploy scripts call `Connection.migrate()` explicitly. Production docs: run ≥1 scheduler with `automigrate: true`.

### 3. `completeJobRetentionMs` (default `24 * 60 * 60 * 1000`)

Leader sweeper deletes `pgrq_jobs` in `completed` or `cancelled` whose completion timestamp is older than this. Failed jobs are not auto-deleted. `0` means delete completed jobs as soon as the sweeper sees them. `false` / `Infinity` disables the sweeper.

## Recommended repo layout (Phase 1 creates this)

```
pg-queue/
  src/
    index.ts
    core/          connection, queue, worker, scheduler, multiWorker, plugin, pluginRunner
    plugins/       JobLock, QueueLock, DelayQueueLock, Retry, Noop
    types/         options, job, jobs, errorPayload
  __tests__/       port of node-resque tests (core, plugins, utils)
  examples/
  docs/            VitePress (Phase 9) + plans/ (this folder)
  .github/workflows/   test.yaml from Phase 1 (lint, build, Postgres)
```

## Non-goals (v1)

- Compatible wire protocol with Ruby Resque / Sidekiq (node-resque aimed at that via Redis keys; we will not write Redis keys)
- Cockroach / PGLite backends (we test PostgreSQL only)
- Built-in HTTP dashboard
- Exactly matching Redis performance characteristics
- Wrapping graphile-worker or PGMQ

## Success metric

Phase 8's matrix is green: every **relevant** node-resque test exists under the same name and passes against Postgres. Those tests have been running in CI since the phase that introduced the API. Docs site builds. `npm publish` workflow is in place. A Keryx follow-up can replace `PgBossBackend` with this package without changing `api.actions.enqueue*`.

## Lessons learned

- 2026-08-29: Phase 3 showed pg-boss was only supplying schema migrations and a handful of job state methods; node-resque compatibility still required direct SQL for most Queue behavior while pg-boss workers, scheduling, retries, and supervision were disabled. We replaced it before Worker landed with a focused, owned schema and atomic `SKIP LOCKED` claim.
