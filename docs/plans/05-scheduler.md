# Phase 5 — Scheduler (leader, migrate, delayed, stuck workers, sweeper)

**Status:** not-started  
**Depends on:** Phase 4

## Goal

Implement `Scheduler` as the cluster coordinator. Many instances run; one leader does work. The leader **migrates**, **watches delayed eligibility**, **cleans stuck workers**, and **sweeps completed jobs**.

This is the node-resque scheduler plus the two Postgres duties called out in the product brief.

## Defaults (node-resque + ours)

```ts
timeout = 5000                          // poll interval ms
stuckWorkerTimeout = 60 * 60 * 1000     // 1 hour; `false` disables
leaderLockTimeout = 180                 // seconds
name = os.hostname() + ":" + process.pid
retryStuckJobs = false
automigrate = true
completeJobRetentionMs = 24 * 60 * 60 * 1000
```

## Leader election

Port `tryForLeader` / `releaseLeaderLock` onto `Connection.tryLeader` (Phase 2).

- On each `poll`, try for leadership.
- If not leader: `this.leader = false`, `pollAgainLater()`, do **not** migrate, sweep, or clean workers.
- If newly leader: `this.leader = true`, emit `leader`.
- If already leader: refresh TTL (`tryLeader` updates `expires_at` when `name` matches).
- `end()`: `releaseLeader` then `queue.end()`.
- `queue.leader()` returns the leader name after a successful poll (test: `queues can see who the leader is`).
- Failover test: two schedulers, stop the leader, the other becomes leader within ~2 timeouts.

If `poll` throws, emit `error` (no unhandled rejection).

## What the leader does each `poll`

Order:

1. **Automigrate** (once per leadership, not every poll). If `automigrate` and not yet migrated this term: `connection.migrate()`, set a flag. If migrate throws, emit `error`, stay leader if possible (or release — prefer emit + retry next poll).
2. Emit `poll`.
3. **Delayed eligibility** (see below). If work remains, recurse `poll()` like node-resque (drain the timestamp) without waiting `timeout`.
4. **`checkStuckWorkers`**
5. **Sweeper** (can be every poll or every N polls / at most once per minute — document; tests will call a public `sweepCompletedJobs()`).
6. `pollAgainLater()`.

Non-leaders skip 1, 3–5.

### Delayed jobs

pg-boss already hides future `start_after` from `fetch`. Workers will pick them up without a transfer. For **API and event compatibility**:

On leader poll, select delayed jobs with `start_after <= now()` that have not yet been "announced" **or** simply:

- Compute distinct timestamps (unix seconds) of jobs that *became* ready since last poll, **or**
- Query ready jobs that workers have not fetched yet — that is indistinguishable from normal queued jobs.

node-resque tests:

1. `enqueueAt(1000 * 10, …)` (10 seconds *from epoch*, i.e. the past) → `scheduler.poll()` → `popFromQueue()` returns the job.
2. `enqueueAt(now+10000)` → poll → pop is falsy.

With `startAfter`, test (1) is: after poll, `length`/`popFromQueue` sees the job because `start_after` is in the past. Test (2) stays invisible to fetch.

Emit:

- `workingTimestamp` with that timestamp when we inspect a ready delayed batch
- `transferredJob` for each job we observe becoming eligible

Implementation options (pick one, document in JSDoc):

**A (preferred).** No row movement. Leader queries `created` jobs with `start_after <= now()` that were delayed (e.g. `start_after > created_on + interval '0.5s'`). Emit events. Workers fetch them normally.

**B.** Leader updates a column `announced_at` to make events exactly-once.

Do not copy jobs into a second table.

Plugins: node-resque runs `beforeEnqueue` at **transfer** time, not at `enqueueAt`. If we never re-enqueue, those hooks would not run for delayed jobs. **Required:** when a delayed job becomes eligible, run `beforeEnqueue`/`afterEnqueue` on the leader (same as transfer). If `beforeEnqueue` returns false, `cancel`/`delete` the job (do not work it).

### Stuck workers

Port `checkStuckWorkers`:

- Load `pgrq_workers`
- If `now - ping_at > stuckWorkerTimeout` (compare in seconds like node-resque), `forceCleanWorker(name)`
- Emit `cleanStuckWorker(workerName, errorPayload, deltaSeconds)`
- If `retryStuckJobs`, `queue.retryStuckJobs()`

`stuckWorkerTimeout: false` skips this.

Port the test that clears `pingTimer` inside `perform` so the worker looks dead.

### Sweeper (new)

```ts
async sweepCompletedJobs(): Promise<number>
```

Leader only:

```sql
DELETE FROM {schema}.job
WHERE state IN ('completed', 'cancelled')
  AND completed_on < now() - make_interval(secs => $retentionSeconds)
RETURNING id
```

Use pg-boss `deleteJob` if that is required for partition integrity; otherwise SQL delete is what keryx used for management.

- Default retention 24h
- Do **not** delete `failed` or `active` or `created`
- Also delete expired `pgrq_locks` and expired `pgrq_leader` rows if unowned
- Return deleted count; emit nothing required (optional `debug` later)
- `completeJobRetentionMs: false` → skip
- `0` → delete all completed/cancelled immediately

Tests:

- Insert/complete a job, set `completeJobRetentionMs: 0`, poll as leader, row gone
- Failed job remains
- Non-leader scheduler does not delete
- Default 24h: a just-completed job survives one poll

## `start` / `end` / `poll` / `pollAgainLater`

Port control flow from `src/core/scheduler.ts` (processing flag, recursive end if busy).

## Tests

Port `__tests__/core/scheduler.ts`:

- connect, start/stop
- error emit on poll failure
- one leader + failover
- `queue.leader()`
- delayed past vs future
- stuck worker → failed payload

Add:

- automigrate: empty DB, worker with `migrate: false` cannot work until scheduler leader starts with `automigrate: true`
- automigrate false: leader does not create tables (specHelper must not pre-migrate this file)
- sweeper cases above

## Acceptance criteria

- Multi-scheduler, single leader
- Leader-only migrate and sweep
- Delayed jobs become worker-visible at the right time
- Stuck workers fail like node-resque
- Failed jobs survive the sweeper

## Next phase needs

Stable leader + worker cleaning. Plugins can land in parallel with leftover scheduler polish.
