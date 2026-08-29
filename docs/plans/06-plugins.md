# Phase 6 — Plugins

**Status:** not-started  
**Depends on:** Phase 4 (Queue enqueue hooks already in Phase 3)

## Goal

Ship the plugin runner (if not done) and the five built-in plugins with Postgres locks instead of Redis keys. Custom user plugins that extend `Plugin` must work unchanged aside from touching `connection.redis` (they should use `queueObject` APIs).

## Plugin base

Port `src/core/plugin.ts` and `pluginRunner.ts`.

Hooks:

| Hook | Return | When |
| --- | --- | --- |
| `beforeEnqueue` | `true` continue / `false` skip enqueue | Queue.enqueue and delayed-eligibility transfer |
| `afterEnqueue` | ignored | after successful send |
| `beforePerform` | `true` run / `false` skip perform (complete without success path like node-resque) | Worker.perform |
| `afterPerform` | ignored | after perform or after throw; may clear `worker.error` |

`this.options` comes from `job.pluginOptions[PluginName]`.

## Built-ins (port `src/plugins/*`)

Lock storage: `Connection.setLockNx` / `getLock` / `delLock` / `expireLock` on `pgrq_locks`. **Key strings must match node-resque** so `queue.locks()` tests and plugin tests that inspect keys still work:

- QueueLock: `lock:{func}:{queue}:{jsonArgs}` (node-resque used `connection.key("lock", func, queue, flattenedArgs)` which prefixed namespace — we use `schema` separately, so the **row key** is `lock:{func}:{queue}:{args}` without schema prefix)
- JobLock: `workerslock:{func}:{queue}:{jsonArgs}`
- Retry: `resque-retry:{func}:{argsKey}` and `failure-resque-retry:{func}:{argsKey}`

### `QueueLock`

If the same name+queue+args is already queued, skip enqueue (`beforeEnqueue` → false). `SETNX` + expiry (`lockTimeout` default 3600s). `beforePerform` deletes the lock.

### `JobLock`

If the same name+queue+args is already **running**, `beforePerform` returns false and optionally `enqueueIn(enqueueTimeout)` (`reEnqueue` default true). `afterPerform` deletes lock. `lockTimeout` default 3600s, `enqueueTimeout` default 1001ms.

### `DelayQueueLock`

If the same name+queue+args is already in **delayed**, skip enqueue.

### `Retry`

On failure: increment attempt, if remaining, `enqueueIn` with `retryDelay` / `backoffStrategy`, emit `reEnqueue`, clear `worker.error` so the job is not placed in failed, decr processed / incr failed stats (port exactly). After limit, cleanup keys and throw. Default `retryLimit: 1`, `retryDelay: 5000`.

The store performs no automatic retry; the plugin is the only retry owner.

### `Noop`

Port as in node-resque (error swallowing helper).

## Custom plugins

Port `__tests__/plugins/custom_plugins.ts` and `examples/customPluginExample.ts`. Users must not need Redis.

If a plugin was written against `this.queueObject.connection.redis`, that is **unsupported**. Document `connection.setLockNx` as the lock API. Do not provide a fake `redis` object.

## Tests

Port all of `__tests__/plugins/` **in this PR**:

- `custom_plugins.ts`
- `delayedQueueLock.ts`
- `jobLock.ts`
- `noop.ts`
- `queueLock.ts`
- `retry.ts`

Same names, same timings as much as CI allows (retry/jobLock are timing-sensitive; keep timeouts).

Also port `__tests__/core/queue.ts` `describe("locks")` if not already green.

**CI:** `test.yaml` green with these files. Do not wait for Phase 8.

## Acceptance criteria

- All five plugins exported as `Plugins.JobLock` etc. (port `src/plugins/index.ts`)
- Plugin tests green
- `queue.locks()` / `delLock()` work
- Retry does not double-retry at the storage layer
- **CI green** on this PR

## Next

Phase 7 is independent. Phase 8 includes these tests in the matrix.

## Lessons learned

- 2026-08-29: The owned job store has no automatic retry behavior, preserving the Retry plugin as the single source of retry policy.
