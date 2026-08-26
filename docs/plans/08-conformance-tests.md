# Phase 8 — Conformance audit (remaining node-resque tests)

**Status:** not-started  
**Depends on:** Phases 1–7 (harness and CI already exist; most tests already landed with their phase)

## Goal

**This is not when we start testing.** CI and `specHelper` ship in Phase 1. Connection / Queue / Worker / Scheduler / plugin / MultiWorker tests ship in Phases 2–7 and must already be green on `test.yaml`.

This phase is the **audit**: every **relevant** node-resque test exists under the same `describe`/`test` name, skip reasons are complete, extra Postgres tests exist, and a title-diff against upstream is clean. Redis-only tests stay skipped with a reason. No silent assertion weakening.

Source of truth: [actionhero/node-resque](https://github.com/actionhero/node-resque) `__tests__/` on `main` (currently 9.7.x). When auditing, pin a commit SHA in this file.

## What already exists (do not redo)

| Landed in | Tests |
| --- | --- |
| Phase 1 | `specHelper` skeleton, smoke `SELECT 1`, `test.yaml` (lint / build / Postgres / complete) |
| Phase 2 | connection + connectionError (+ illegal schema, BYO pool, migrate) |
| Phase 3 | `__tests__/core/queue.ts` (minus live-worker slices deferred to 4) |
| Phase 4 | `__tests__/core/worker.ts`, remaining queue worker-status, multi-process + priority extras |
| Phase 5 | `__tests__/core/scheduler.ts`, automigrate + sweeper extras |
| Phase 6 | `__tests__/plugins/*` |
| Phase 7 | `__tests__/core/multiWorker.ts` |

If a row above is missing when you start this phase, that is a **bug in an earlier phase** — go back and fix that plan/PR. Do not dump the entire suite into one late PR.

## Tooling (already specified in Phase 1; complete here if gaps remain)

| node-resque | pgboss-queue |
| --- | --- |
| Jest + ts-jest | `bun:test` (`bun test --concurrency=1`) |
| `ioredis` specHelper | `__tests__/utils/specHelper.ts` |
| `REDIS_HOST` | `DATABASE_URL` (CI injects it) |
| `afterAll` disconnect redis | `afterAll` end pool + truncate or `DROP SCHEMA` |

`specHelper` exports (Phase 2+ must have these; Phase 1 had stubs):

```ts
connectionDetails: ConnectionOptions
timeout: number
queue: string
schema: string
connect / disconnect / cleanup
popFromQueue(): Promise<string | null>
```

**Isolation:** truncate + migrate once in `beforeAll` for speed, or per-file schema. Keep `--concurrency=1` until proven otherwise.

## Matrix

Legend: **Port** = must exist and pass (ideally already, from Phases 2–7). **Skip** = Redis-only; `test.skip` with `// redis-only: …` **or** omit the file and keep the row here.

Use this table as a **checklist in this phase's PR**: tick what is already green, add anything missing.

### `__tests__/core/connection.ts`

| Test | Verdict | Notes |
| --- | --- | --- |
| should start with no redis keys in the namespace | **Adapt** | After cleanup, no `job` rows and no `pgrq_*` rows |
| it has loaded Lua commands | **Skip** | No Lua |
| getKeys returns appropriate keys | **Skip** | Redis SCAN |
| keys built with the default namespace | **Skip** | Redis key prefix |
| ioredis transparent key prefix… | **Skip** | |
| keys built with a custom namespace | **Adapt** | `schema` option sets pg-boss schema; `migrate` sees that schema |
| keys built with a array namespace | **Skip** | array namespace not supported |
| will properly build namespace strings dynamically | **Skip** | |
| will select redis db from options | **Adapt** | `database` string selects Postgres database (integration: skip if we cannot create DBs; then skip with reason) |
| removes empty namespace from generated key | **Skip** | empty schema illegal; we reject |
| removes the redis event listeners when end | **Adapt** | pool / boss error listeners removed on `end()` |

### `__tests__/core/connectionError.ts`

**Port** — connecting to a bad host emits error / rejects. Point at `127.0.0.1:1` or invalid user.

### `__tests__/core/queue.ts`

**Port all** (names from current main):

- can connect
- can add a normal job
- can add delayed job (enqueueAt) + string timestamp variant
- will not enqueue a delayed job at the same time with matching params with error
- … with error suppressed
- can add delayed job (enqueueIn) + string time variant
- can get the number of jobs currently enqueued
- can get the jobs in the queue
- can find previously scheduled jobs
- will not match previously scheduled jobs with different args
- can delete an enqueued job
- can delete all enqueued jobs of a particular function/class
- can delete a delayed job (+ delayed queue empty)
- single arguments without explicit array
- omitting arguments when enqueuing / deleting / delayed add / delayed delete
- can determine who the leader is
- can load stats
- locks: can get locks, can remove locks
- failed: count, body content, remove by payload, re-enqueue, error when not in failed
- delayed status: timestamps, delayedAt, allDelayed
- worker status: list workers, idle workingOn, active workingOn, remove stuck + re-enqueue, not remove within time limit, forceClean payload, forceClean removes keys, retryStuckJobs

Adapt any `specHelper.redis.rpop(namespace+":failed")` to `queue.failed(0,-1)`.

### `__tests__/core/worker.ts`

**Port all** (see Phase 4 list). Stub `connection.redis.set` → stub `ping` SQL / `pool.query`.

### `__tests__/core/scheduler.ts`

**Port all**. Leader failover, delayed move, stuck workers. Stub `redis.set` → stub `tryLeader`.

### `__tests__/core/multiWorker.ts`

**Port all**.

### `__tests__/plugins/*`

**Port all six files.**

### `__tests__/integration/ioredis.ts`

**Skip** (Redis client). Replace with `__tests__/integration/pg.ts`: shared `pool` passed into Queue and Worker, `end()` does not close the pool, both still work.

### `__tests__/integration/ioredis-mock.ts`

**Skip**. No in-memory pg-boss mock required for v1.

### `__tests__/utils/*`

`specHelper` and `custom-plugin.ts` as needed; not user-facing.

## Extra tests (required, not in node-resque)

These should already exist from Phases 2–5; verify here:

1. **Multi-process dequeue** — 4 workers, 100 jobs, 100 unique successes
2. **Priority queues** — `queues: ["high","low"]` works high first
3. **automigrate leader-only**
4. **Sweeper** — completed gone after retention; failed retained; non-leader does not sweep
5. **Illegal schema rejected**
6. **BYO pool** — Connection `end` does not `pool.end()`

## Semantic-diff log

If an assertion cannot be identical, add a row (may already have rows from earlier phases):

| Test name | node-resque assertion | Ours | Why |
| --- | --- | --- | --- |
| *(none yet)* | | | |

PRs that add rows must explain. "Postgres is different" is not enough if the Queue API can still match.

## Running against upstream

`scripts/check-conformance.ts` (Bun): collect node-resque test titles vs ours, fail CI if a **Port** title is missing. Required before 1.0; add the script to `test.yaml` in this phase (still no publish workflow).

## Acceptance criteria

- `bun test` green on CI (`complete` job)
- This matrix checked off; every Port row is an existing passing test
- Skip list is complete (no forgotten files)
- `check-conformance` runs in CI
- CI Postgres service is the only backend

## Next

Docs site can describe a real API. Phase 10 can trust tests that have been running since Phase 1.

## Lessons learned

- 2026-08-26 (plan): This phase is an audit, not the first test suite. Tests ship with Phases 1–7; CI has been running since Phase 1.
