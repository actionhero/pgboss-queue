# Phase 0 — Overview and architecture

**Status:** done (this document *is* the phase)

## Goal

Define the product so later phases do not have to re-litigate it: a node-resque-compatible job runtime whose queues live in Postgres.

## Product

`pgboss-queue` is a library, not a framework. Callers construct `Queue`, `Worker`, and `Scheduler` (and optionally `MultiWorker`), pass a Postgres connection, register a `jobs` hash, and run.

It is the storage/runtime Keryx should eventually sit on top of, instead of either Redis node-resque or a one-off `PgBossBackend` that drops half the resque API.

### The factory (from the node-resque README)

- **Queues** are conveyor belts: regular work, delayed work, and failed work.
- **Workers** each run one job at a time. They pull from assigned queues (left-to-right = priority), succeed or write to failed, then pull again.
- **Scheduler** is a specialized worker that does not run jobs. Many instances run; **one is leader**. The leader:
  1. Makes delayed jobs eligible when their time comes (node-resque: move from delayed keys onto the work list; we: rely on pg-boss `startAfter` and emit compatible events).
  2. Cleans stuck workers (heartbeat older than `stuckWorkerTimeout`).
  3. **New:** runs schema automigrate when `automigrate: true`.
  4. **New:** sweeps completed jobs older than `completeJobRetentionMs` (default 24h).

Workers and schedulers are safe to run as many processes, many machines. Dequeue is exactly-once via `SELECT … FOR UPDATE SKIP LOCKED`.

## Why pg-boss, why not "just SQL"

Keryx PR [#519](https://github.com/actionhero/keryx/pull/519) compared embeddable Postgres queues and chose pg-boss for:

- Maturity and downloads
- Verified `SKIP LOCKED` dequeue
- Owned, versioned schema (`start()` / `migrate`)
- Delayed jobs (`startAfter`)
- Retry / fail states
- Optional `LISTEN/NOTIFY` later (not required for v1)

We wrap pg-boss rather than vendoring a job table because we do not want to maintain partition/index/migration machinery. We **do not** wrap pg-boss's `work()` as the public Worker: that helper registers one handler per queue and hides poll/plugin/event semantics. We use pg-boss as a **store**: `send`, `fetch`, `complete`, `fail`, `cancel`, plus SQL against `"schema".job` for introspection (the pattern `PgBossBackend` already used).

## Mapping: node-resque → pgboss-queue

| node-resque (Redis) | pgboss-queue (Postgres) |
| --- | --- |
| `connection.host/port/database/password` (Redis) | `connectionString` **or** `host/port/database/user/password/ssl` **or** `pool` |
| `namespace` / keyPrefix | `schema` (default `pgboss_queue`) |
| List `queue:{name}` (`RPUSH`/`LPOP`) | pg-boss `job` rows, `state IN ('created','retry')`, `start_after <= now()` |
| `delayed:{ts}` + `delayed_queue_schedule` zset | `job.start_after` in the future, same `name` (queue) |
| `failed` list | `job.state = 'failed'` (payload mapped to `ParsedFailedJobPayload`) |
| Lua `popAndStoreJob` | `boss.fetch` / `SKIP LOCKED`; worker row in **our** `workers` table |
| `SET NX EX` leader lock | `leader` row with `expires_at` (same NX/expiry semantics) |
| `worker:ping:{name}` | `workers.ping_at` |
| `lock:*` / `workerslock:*` | `locks` table (`key`, `expires_at`) |
| `stat:processed` / `stat:failed` | `stats` table |
| `smembers queues` | pg-boss `getQueues()` plus any queue we created |
| Scheduler promotes delayed → list | Job becomes fetchable when `start_after <= now()`; leader still polls and emits `workingTimestamp` / `transferredJob` for compatibility |
| pg-boss `supervise` deleting jobs | **Off** on workers. Leader sweeper deletes `completed`/`cancelled` older than retention. **Failed jobs are kept** until `removeFailed` / retry (resque behavior). |

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
2. **Schema isolation.** Default `keryx_tasks` there; we default `pgboss_queue`. Validate identifier safety (`^[a-zA-Z_][a-zA-Z0-9_]*$`).
3. **SQL introspection.** `queued`, `del`, `delDelayed`, `scheduledAt`, `failed*` are parameterized SQL on `"schema".job`, not missing pg-boss API methods.
4. **Payload shape.** Store `{ class, queue, args }` (resque encode) inside pg-boss `data`. Keryx used `_actionName` + inputs object because actions aren't resque jobs. We store the node-resque JSON: `{ class, queue, args }`.
5. **createQueue lazily.** Track `knownQueues`; `createQueue` on first enqueue. Optional `partition` is out of scope for v1.
6. **Workers vs CLI.** pg-boss `supervise` / `schedule` should be false on processes that only enqueue. Our Scheduler leader is the one process allowed to mutate schema and delete old rows.
7. **Recurring uniqueness.** pg-boss `short` policy + `singletonKey` = one *pending* job. We do not need this for v1 core (node-resque has no built-in CRON), but expose `singletonKey` / document `short` queues as an escape hatch and as the path Keryx will use. Leader + `scheduler.leader` remains the node-resque way to run CRON (see `examples/scheduledJobs.ts`).
8. **Retention.** keryx used `deleteAfterSeconds` default 7 days. We default **24 hours** for *completed* jobs, leader-driven, not pg-boss supervise on every instance.
9. **RetryLimit 0 by default.** node-resque does not retry unless the Retry plugin is attached. Do not enable pg-boss retries globally or we will double-retry with the plugin.

## Lessons from keryx#519 (do not copy)

- Replacing `Worker` with `boss.work(queue, { localConcurrency })` — loses one-job-at-a-time-per-Worker, plugin `beforePerform`, queue priority walk, and events.
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

Only the **elected scheduler** applies migrations (pg-boss `migrate` + our metadata DDL). Workers and extra schedulers start with `migrate: false`. If no scheduler is running, tests/scripts call `Connection.migrate()` explicitly (specHelper will). Production docs: run ≥1 scheduler with `automigrate: true`.

### 3. `completeJobRetentionMs` (default `24 * 60 * 60 * 1000`)

Leader sweeper deletes pg-boss jobs in `completed` or `cancelled` whose completion timestamp is older than this. Failed jobs are not auto-deleted. `0` means delete completed jobs as soon as the sweeper sees them. `false` / `Infinity` disables the sweeper.

## Recommended repo layout (Phase 1 creates this)

```
pgboss-queue/
  src/
    index.ts
    core/          connection, queue, worker, scheduler, multiWorker, plugin, pluginRunner
    plugins/       JobLock, QueueLock, DelayQueueLock, Retry, Noop
    types/         options, job, jobs, errorPayload
  __tests__/       port of node-resque tests (core, plugins, utils)
  examples/
  docs/            VitePress (Phase 9) + plans/ (this folder)
  .github/workflows/
```

## Non-goals (v1)

- Compatible wire protocol with Ruby Resque / Sidekiq (node-resque aimed at that via Redis keys; we will not write Redis keys)
- Cockroach / PGLite backends (pg-boss supports them; we test Postgres only)
- Built-in HTTP dashboard
- Exactly matching Redis performance characteristics
- Wrapping graphile-worker or PGMQ

## Success metric

Phase 8's matrix is green: every **relevant** node-resque test exists under the same name and passes against Postgres. Docs site builds. `npm publish` workflow is in place. A Keryx follow-up can replace `PgBossBackend` with this package without changing `api.actions.enqueue*`.

## Lessons learned

_None yet._
