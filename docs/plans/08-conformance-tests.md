# Phase 8 — Conformance tests (100% of relevant node-resque suite)

**Status:** not-started  
**Depends on:** Phases 3–7 (tests should land *with* those phases; this phase is the gate)

## Goal

Every **relevant** node-resque test exists in this repo under the same `describe`/`test` name and passes against Postgres. Redis-only tests are listed as skipped with a reason. No silent assertion weakening.

Source of truth: [actionhero/node-resque](https://github.com/actionhero/node-resque) `__tests__/` on `main` (currently 9.7.x). When porting, pin a commit SHA in this file.

## Tooling

| node-resque | pgboss-queue |
| --- | --- |
| Jest + ts-jest | `bun:test` |
| `ioredis` specHelper | Postgres specHelper |
| `REDIS_HOST` | `DATABASE_URL` |
| `afterAll` disconnect redis | `afterAll` end pool + `DROP SCHEMA … CASCADE` or truncate `pgrq_*` + `job` |

`__tests__/utils/specHelper.ts` should expose:

```ts
connectionDetails: ConnectionOptions
timeout: number
queue: string  // default queue name
namespace: string // schema name, unique per test file if parallel
connect / disconnect / cleanup
popFromQueue(): Promise<string | null>  // fetch + serialize like Redis LPOP did
```

**Isolation:** each test file uses a schema like `pgrq_test_{hash}` **or** a single schema with `cleanup()` truncating tables. Prefer truncate + migrate once in `beforeAll` for speed; unique schema if bun parallelizes files.

node-resque runs tests serially enough that one Redis DB works. Start **serial** (`bun test` default files can be concurrent — set a mutex or `--concurrency=1` for v1). Document in `package.json` `"test": "bun test --concurrency=1"`.

## Matrix

Legend: **Port** = must exist and pass. **Skip** = file/test not relevant; add `test.skip` with comment `// redis-only: …` **or** omit the file and list it here. Omitting requires a row in this table so coverage is auditable.

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

Port `specHelper` and `custom-plugin.ts` as needed; not user-facing.

## Extra tests (required, not in node-resque)

These do not count as "instead of" ports; they are additive:

1. **Multi-process dequeue** — 4 workers, 100 jobs, 100 unique successes
2. **Priority queues** — `queues: ["high","low"]` works high first
3. **automigrate leader-only**
4. **Sweeper** — completed gone after retention; failed retained; non-leader does not sweep
5. **Illegal schema rejected**
6. **BYO pool** — Connection `end` does not `pool.end()`

## Semantic-diff log

If an assertion cannot be identical, add a row:

| Test name | node-resque assertion | Ours | Why |
| --- | --- | --- | --- |
| *(none yet)* | | | |

PRs that add rows must explain. "Postgres is different" is not enough if the Queue API can still match.

## Running against upstream

Optional script `scripts/check-conformance.ts` (Bun): clone node-resque test titles via regex, clone ours, fail CI if a **Port** title is missing. Nice-to-have in this phase; required before 1.0.

## Acceptance criteria

- `bun test` green with `--concurrency=1`
- This matrix checked off in the PR that closes Phase 8
- Skip list is complete (no forgotten files)
- CI Postgres service is the only backend

## Next

Docs site can describe a real API. Publish workflow can trust tests.

## Lessons learned

_None yet._
