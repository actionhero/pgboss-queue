# Phase 4 — Worker

**Status:** not-started  
**Depends on:** Phase 3

## Goal

Implement `Worker` as a node-resque worker: one job at a time, ordered queues as priority, heartbeats, the same events, `performInline`. Multiple Worker processes must dequeue without overlap (`SKIP LOCKED`).

## Constructor defaults (from node-resque)

```ts
name = os.hostname() + ":" + process.pid
id = 1
queues = "*"
timeout = 5000
looping = true
```

`jobs` hash: functions are wrapped to `{ perform }`.

## Lifecycle

```
connect() → start() → init() → poll() loop
end() waits if working, then untrack, clear timers, queue.end()
```

Port `src/core/worker.ts` method-for-method.

### `init` / track / ping / untrack

Write `pgrq_workers`:

- `track`: upsert `name`, `queues` (comma-joined), `started_at`
- `ping` every `timeout` ms: `ping_at = now()`, emit `ping` with unix seconds
- `working_on`: set when a job is fetched; clear on complete
- `untrack`: delete row; delete per-worker stats keys (`processed:{name}`, `failed:{name}`)

`working_on` JSON matches `ParsedWorkerPayload`:

```ts
{ run_at: new Date().toString(), queue, worker: name, payload: ParsedJob }
```

### Queue selection and priority

- If `queues` is a non-empty array, poll in **array order**. First queue with a ready job wins. This is priority.
- If `queues` is `"*"` or empty: `checkQueues()` loads `queue.queues()`, sorts names (node-resque uses Redis `smembers` + `.sort()`), re-tracks.
- After a full empty pass, `pause()` (emit `pause`, `setTimeout(timeout)`, poll again).
- When using `"*"`, re-`checkQueues()` at the end of a pass so new queues appear (test: `will notice new job queues when started with queues=*`).

Do **not** rely on pg-boss `work()` localConcurrency to implement this. Walk queues in JS.

### `getJob` (dequeue)

For the current queue name:

```ts
const [job] = await boss.fetch(queue, { batchSize: 1 });
```

If pg-boss fetch API differs in the pinned version, use equivalent SQL:

```sql
SELECT id, name, data FROM {schema}.job
WHERE name = $1
  AND state = 'created'  -- or 'retry'
  AND start_after <= now()
ORDER BY priority DESC, created_on
FOR UPDATE SKIP LOCKED
LIMIT 1
```

then mark `active`. Prefer the public `fetch` API.

On fetch: set `pgrq_workers.working_on`. Return `data` as `ParsedJob`.

Exactly-once: two workers must never receive the same `id`. Add a test: enqueue 100 jobs, start 4 workers, `success` count is 100, no duplicates.

### `perform`

Port plugin `beforePerform` / `afterPerform`, frozen args, missing job class → failure `"No job defined for class …"`. Emit `job` before perform. `completeJob` → `succeed` or `fail`. Duration in ms on success/failure events.

**succeed:** `boss.complete(id)`, incr `processed` + `processed:{workerName}`, emit `success`.

**fail:** `boss.fail(id, error)` (so row is `failed`), incr `failed` counters, emit `failure`. Store output so `queue.failed()` can rebuild the resque error payload. If pg-boss `fail` output is the error object, that is enough.

Clear `working_on`. If `looping`, poll again.

### `performInline`

Port exactly: throws if `started`; no Postgres writes; still runs perform plugins.

### Events and error handling

Unhandled fetch/ping errors emit `error`, never become unhandled rejections (port the shutdown tests: stub the lock/ping update to throw).

`end()` while `working === true` waits `timeout` then retries (graceful drain).

### `checkQueues`

Port. `"*"` untrack → list queues → set `this.queues` → track.

## Tests

Port `__tests__/core/worker.ts` entirely:

- connect, boot/stop
- performInline success/fail/plugin
- determine queue names from `*`
- wildcard notices new queues
- failure / success / simple function jobs / missing class / failed queue contents
- ping while slow job runs
- ping failure emits `error`

Add (not in node-resque, but required for "multi-worker"):

- two Worker instances, 20 jobs, both succeed, no double-processing
- priority: enqueue `low` then `high`; worker `queues: ["high","low"]` processes high first (even if low was enqueued earlier)

## Acceptance criteria

- Worker event names and payloads match node-resque (duration included)
- Heartbeats visible via `queue.allWorkingOn()` / `queue.workers()`
- Multi-process safety demonstrated
- `performInline` does not touch Postgres

## Next phase needs

Worker rows, pings, `forceCleanWorker`, fetch/complete/fail.
