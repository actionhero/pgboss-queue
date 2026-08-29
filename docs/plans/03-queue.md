# Phase 3 — Queue

**Status:** done  
**Depends on:** Phase 2

## Goal

Implement `Queue` so programs can enqueue work, inspect it, delete it, and manage failures — the node-resque Queue methods, backed by pg-boss `job` rows plus our metadata tables.

Workers are not required yet. Tests enqueue and SQL-inspect (or use a test helper `popFromQueue` that `fetch`es a job).

## Job encoding

node-resque:

```ts
encode(q, func, args) => JSON.stringify({ class: func, queue: q, args })
```

Store that object as pg-boss `data`. Queue name is pg-boss job `name` (one pg-boss queue per resque queue).

```ts
await boss.send(q, { class: func, queue: q, args }, {
  retryLimit: 0,          // Retry plugin owns retries
  startAfter?: Date,      // enqueueAt / enqueueIn
});
```

`createQueue(q)` before first send if needed (keryx `ensureQueue`). Default queue options:

- `retryLimit: 0`
- `deleteAfterSeconds`: large (e.g. 30 days) so pg-boss will not delete out from under us; **our sweeper** is the real retention (Phase 5). Alternatively omit delete policy if pg-boss leaves rows until we `deleteJob`.

## Methods (port `src/core/queue.ts`)

Implement every public method. Behavior notes where Postgres differs:

### Enqueue

- `enqueue(q, func, args=[])` — `arrayify(args)`; run `beforeEnqueue` plugins; `send`; `afterEnqueue`. Return `true`/`false` like node-resque (`toRun`).
- `enqueueAt(timestampMs, q, func, args=[], suppressDuplicateTaskError=false)` — **do not** run enqueue plugins (node-resque comment: scheduler runs them at transfer time). If a job with the same encode already has the same `start_after` second, throw `Job already enqueued at this time with same arguments` unless suppress. Implementation: unique lookup on `(name, data, date_trunc('second', start_after))` for delayed rows, or store a hash in `pgrq_locks` keyed like node-resque `timestamps:{item}`. Prefer matching node-resque: one delayed job per (payload, timestamp-second).
- `enqueueIn(ms, q, func, args, suppress)` — `enqueueAt(now+ms, …)`.

### Queue admin

- `queues()` — union of pg-boss `getQueues()` names and distinct `job.name`.
- `delQueue(q)` — delete all jobs in that queue (any state except maybe `active` — document: active jobs are not deleted; match "delete the list" as best-effort). Drop from known queues.
- `length(q)` — count `created`/`retry` with `start_after <= now()` (ready, not delayed).
- `queued(q, start, stop)` — same filter, `ORDER BY created_on`, offset/limit. Map to `ParsedJob`.
- `del(q, func, args=[], count=0)` — delete matching ready jobs. `count=0` means all matches (Redis `LREM` 0). Compare `data` to encoded job.
- `delByFunction(q, func, start=0, stop=-1)` — delete ready jobs whose `data.class = func` in the slice.

### Delayed

Treat delayed as `state IN ('created','retry') AND start_after > now()`.

- `delDelayed(q, func, args=[])` — delete matches; return timestamps (unix **seconds**, node-resque returns seconds from the key).
- `scheduledAt(q, func, args=[])` — those timestamps.
- `timestamps()` — distinct `start_after` of delayed jobs, as ms (node-resque multiplies seconds by 1000).
- `delayedAt(timestampMs)` — jobs whose `start_after` second equals `round(ts/1000)`; return `{ tasks, rTimestamp }`.
- `allDelayed()` — hash of timestamp-ms → tasks. Document: can be heavy (same as node-resque).

### Locks / stats / leader

- `locks()` — all `pgrq_locks` rows (strip expired). Keys should look like `lock:…` / `workerslock:…` so plugin tests pass.
- `delLock(key)`
- `stats()` — `pgrq_stats` plus optionally pg-boss state counts under extra keys (keep `processed` / `failed` names).
- `leader()` / `leaderKey()` — `pgrq_leader.name` (leaderKey can return the slot name for tests that only check non-empty).

### Workers (tables filled in Phase 4; methods exist now)

- `workers()` — `{ [name]: queuesString }`
- `workingOn(workerName, queues)` — JSON of `working_on` (node-resque returned a JSON string)
- `allWorkingOn()` — hash; idle workers are the string `"started"`
- `forceCleanWorker(workerName)` — if `working_on` set, insert a failed job payload (`Worker Timeout (killed manually)`, backtrace includes `queue#forceCleanWorker`); delete worker row; incr failed stat; return `ErrorPayload`
- `cleanOldWorkers(ageMs)` — workers whose `working_on.run_at` is older than age
- `retryStuckJobs(upperLimit)` — failed jobs whose backtrace contains `queue#forceCleanWorker`

Return types must match `ParsedWorkerPayload` / `ErrorPayload`.

### Failed jobs

pg-boss `failed` rows → `ParsedFailedJobPayload`:

```ts
{
  worker: string,          // from data or output; "" if unknown
  queue: data.queue ?? name,
  payload: { class, queue, args },
  exception: output.name ?? "Error",
  error: output.message ?? String(output),
  backtrace: output.stack?.split("\n").slice(1) ?? [],
  failed_at: completed_on.toString(), // Date#toString() style if tests compare loosely
}
```

node-resque `failed(start,stop)` uses list indices; we `ORDER BY completed_on` offset/limit. `failed(0,-1)` means all.

- `failedCount()`
- `failed(start, stop)`
- `removeFailed(failedJob)` — delete that row. Matching: prefer `failedJob` identity. If tests pass the whole payload, match on `payload` + `failed_at` or store `id` on our mapped object as an extra enumerable field (keryx added `id`). Adding `id?: string` to the payload type is allowed if tests still pass; include it.
- `retryAndRemoveFailed(failedJob)` — `boss.retry(queue, id)` or re-`enqueue` + delete. Throw `This job is not in failed queue` if nothing matched.

## Plugin runner

Port `pluginRunner.ts` now so `enqueue` hooks work. `beforePerform` is unused until Phase 4.

## Tests

Port `__tests__/core/queue.ts` **in this PR** (see plan 08 for the name list). Helper `specHelper.popFromQueue()` should `fetch` one job from the default queue and return the encoded JSON string **or** parsed job — adapt the helper, keep assertions on `class` / `args`.

Skip only tests that poke Redis keys directly if any remain inside queue.ts (there should be none except stats/locks which we emulate).

**CI:** this phase is not done until `test.yaml` is green with the new queue tests. Do not leave queue coverage for Phase 8.

## Acceptance criteria

- All Queue methods exist with JSDoc copied/adapted from node-resque
- `__tests__/core/queue.ts` port is green on CI (worker-status tests that start a Worker wait for Phase 4 — split those into a `describe` marked pending **or** implement after Phase 4; prefer implementing worker methods against empty tables so idle tests pass, and mark `active workingOn` pending)

Recommended split:

- Phase 3: enqueue, delayed, delete, failed (inject failed rows via SQL/`fail`), locks, stats, leader (null), idle workers
- Phase 4: active `workingOn`, `forceCleanWorker` with a live worker

## Next phase needs

`enqueue` / `queued` / `length` / failed helpers / worker table accessors.

## Lessons learned

- 2026-08-26: Bun requires `*.test.ts` filenames for discovery; Phase 3 ports should use `__tests__/core/queue.test.ts` (not bare `queue.ts`) while keeping node-resque describe/test titles.
- 2026-08-29: pg-boss v12 queues are explicit configuration rows/partitions, so Queue lazily calls `getQueue`/`createQueue` before `send`. Queue defaults are `retryLimit: 0` and `deleteAfterSeconds: 0` (pg-boss defines `0` as never auto-delete); scheduler retention remains authoritative.
- 2026-08-29: Delayed duplicate identity is reserved in `pgrq_locks` under a private `timestamps:{payload}:delayed:{second}` key until the scheduled second passes. This makes concurrent duplicate checks atomic without modifying pg-boss's partitioned `job` schema; `locks()` intentionally exposes only plugin `lock:*` and `workerslock:*` rows.
- 2026-08-29: Upstream queue tests schedule at Unix millisecond `10000`, but pg-boss correctly treats 1970 timestamps as immediately runnable. The PostgreSQL port uses future rounded timestamps while retaining the same test titles and timestamp-unit assertions.
- 2026-08-29: Phase 3 completed with 36 Queue tests passing against PostgreSQL (plus six live-Worker titles explicitly deferred to Phase 4). The full suite, Biome, TypeScript build, and Node package import are green.
- 2026-08-29: `pgrq_stats` stores numeric counters, but `Queue.stats()` stringifies them to retain node-resque's Redis `MGET` response shape (`{ processed: "2", failed: "1" }`).
- 2026-08-29: Bugbot: an in-process `knownQueues` cache survived `delQueue` on another `Queue` instance, so later `send` skipped `createQueue`. `ensureQueue` now always checks pg-boss and retries once on `Queue does not exist`.
- 2026-08-29: Bugbot: `delQueue` only skipped `delete_queue` when `active` rows remained, so a concurrent `created` insert could be dropped. It now locks the pg-boss queue row, deletes non-active jobs, and drops the queue only when no rows remain.
- 2026-08-29: Bugbot: `forceCleanWorker` inserted a second `failed` row and left the original job `active`. It now updates the in-flight job to `failed` (by id when recorded, otherwise by matching `data`) and only inserts if no active row exists.
- 2026-08-29: Bugbot: the data-only fallback could fail every identical `active` payload. The update now selects a single matching row (`LIMIT 1 … FOR UPDATE`).
- 2026-08-29: Bugbot: `delayedAt` omitted `start_after > now()`, so a timestamp whose second had arrived still listed jobs that `length`/`queued` already treated as ready. It now uses the same delayed filter as `timestamps` / `scheduledAt` / `delDelayed`.
