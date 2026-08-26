# Phase 7 — MultiWorker

**Status:** not-started  
**Depends on:** Phase 4

## Goal

Port `MultiWorker`: an in-process pool of `Worker` instances that scales between `minTaskProcessors` and `maxTaskProcessors` based on event-loop delay and utilization.

This is **in addition to** multi-process workers (already required in Phase 4). Keryx's `taskProcessors` / `maxEventLoopDelay` / `checkTimeout` map onto this class.

## Port

Copy `src/core/multiWorker.ts` and `src/utils/eventLoopDelay.ts` with these substitutions:

- No `redis.setMaxListeners` bump — if we share a `pool`, optionally `pool` max connections must be `>= maxTaskProcessors + scheduler`. Document: raise `pool` `max` when using MultiWorker.
- Worker `name`: `options.name + ":" + process.pid + "+" + id` (node-resque rule: `hostname:pid+unique_id`)
- Forward all worker events with `workerId`
- `multiWorkerAction(verb, delay)` verbs: `+` spawn, `-` retire, `--` stop all, `x` hold

Options defaults: min 1, max 10, timeout 5000, checkTimeout 500, maxEventLoopDelay 10.

`start()` / `stop()` / `end()`.

## Tests

Port `__tests__/core/multiWorker.ts` **in this PR**:

- never zero workers while running (at least min)
- scales to max on slow *sleep* (I/O) jobs
- stays at min on blocking CPU jobs
- failure events bubble

These tests are CPU-noisy; keep a `jest.retryTimes` equivalent (`test.todo` is not acceptable). Prefer rerunning the file in CI over weakening assertions.

**CI:** green on `test.yaml` before merge.

## Example

Port `examples/multiWorker.ts` to Postgres connection details.

## Acceptance criteria

- Public class exported
- Tests green (allow retries)
- README snippet matches node-resque's MultiWorker section with connection strings swapped
- **CI green** on this PR

## Note

pg-boss `localConcurrency` is **not** a substitute. MultiWorker must spawn real `Worker` objects so plugins, names, and heartbeats stay per-worker.

## Lessons learned

- 2026-08-26: Phase 1 runs tests with `node:test`, not `bun:test`. Do not assume Bun-only retry APIs when this phase is implemented.
- 2026-08-26: Phase 1 reverted to `bun:test`. Bun retry APIs are available again; Node is only the compiled-package import check.

