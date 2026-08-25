# pgboss-queue

**node-resque's Worker / Scheduler / Queue API, stored in Postgres.**

`pgboss-queue` is a background-job library for Node.js and Bun. It keeps the public surface of [node-resque](https://github.com/actionhero/node-resque) — `Queue`, `Worker`, `Scheduler`, `MultiWorker`, and `Plugins` — and stores jobs in PostgreSQL via [pg-boss](https://github.com/timgit/pg-boss) (`SKIP LOCKED`, delayed jobs, retries, schema ownership).

You write jobs the same way you would with node-resque. You pass a Postgres connection string instead of a Redis one. You run many workers. You run many schedulers; one is elected leader. The leader migrates the schema (when `automigrate` is on) and sweeps completed jobs (default: keep for 24 hours).

```ts
import { Queue, Worker, Scheduler, Plugins } from "pgboss-queue";

const connection = {
  connectionString: process.env.DATABASE_URL, // not a Redis URL
  schema: "pgboss_queue",
};

const jobs = {
  add: {
    plugins: [Plugins.JobLock],
    perform: async (a: number, b: number) => a + b,
  },
};

const queue = new Queue({ connection }, jobs);
const worker = new Worker({ connection, queues: ["math", "low"] }, jobs);
const scheduler = new Scheduler({
  connection,
  automigrate: true,
  completeJobRetentionMs: 24 * 60 * 60 * 1000,
});

await queue.connect();
await worker.connect();
await scheduler.connect();

worker.start();
scheduler.start();

await queue.enqueue("math", "add", [1, 2]);
await queue.enqueueIn(5_000, "math", "add", [3, 4]);
```

Queue order on the worker is priority: `"math"` is drained before `"low"`. Use `queues: "*"` to pick up every queue.

## Status

This repository is in the **planning** stage. The implementation phases, API mapping, test-conformance matrix, docs-site plan, and publish pipeline live in [`docs/plans/`](./docs/plans/).

| Phase | Doc | Goal |
| --- | --- | --- |
| 0 | [Overview](./docs/plans/00-overview.md) | Architecture, mapping, keryx lessons, non-goals |
| 1 | [Repo scaffold](./docs/plans/01-repo-scaffold.md) | Bun + TypeScript package, lint, local Postgres |
| 2 | [Connection & schema](./docs/plans/02-connection-and-schema.md) | Connection strings, metadata tables, automigrate |
| 3 | [Queue](./docs/plans/03-queue.md) | Enqueue, delayed, failed, introspection |
| 4 | [Worker](./docs/plans/04-worker.md) | Poll, perform, events, heartbeats, multi-process |
| 5 | [Scheduler](./docs/plans/05-scheduler.md) | Leader election, migrate, promote, stuck workers, sweeper |
| 6 | [Plugins](./docs/plans/06-plugins.md) | JobLock, QueueLock, DelayQueueLock, Retry, Noop |
| 7 | [MultiWorker](./docs/plans/07-multiworker.md) | In-process autoscaling pool |
| 8 | [Conformance tests](./docs/plans/08-conformance-tests.md) | 100% of the *relevant* node-resque suite |
| 9 | [Docs site](./docs/plans/09-docs-site.md) | VitePress + markdown |
| 10 | [Publish & CI](./docs/plans/10-publish-and-ci.md) | Tests, GitHub Pages, npm OIDC publish |

## Why this exists

[node-resque](https://github.com/actionhero/node-resque) is a mature Redis-backed Resque/Sidekiq-style job system: priority queues, delayed jobs, a leader-elected scheduler, plugins, failed-job management, and `MultiWorker`. Many Actionhero / Keryx deployments already depend on that shape.

[Keryx PR #519](https://github.com/actionhero/keryx/pull/519) proved that pg-boss is a solid Postgres job store (`SKIP LOCKED`, owned schema, delayed `startAfter`, failed-job SQL). That PR also showed what is *lost* if you drop the node-resque runtime: leader election, worker heartbeats, plugin locks, queue-priority polling, and the admin-style introspection API (`queued`, `failed`, `workingOn`, `cleanOldWorkers`, …).

This package keeps the runtime and swaps the store.

## Feature set (target)

Parity with node-resque, unless a test is Redis-specific (see [conformance](./docs/plans/08-conformance-tests.md)):

- **Queue** — `enqueue`, `enqueueAt`, `enqueueIn`, `queued`, `length`, `del`, `delByFunction`, `delQueue`, delayed inspection (`timestamps`, `delayedAt`, `allDelayed`, `scheduledAt`, `delDelayed`), failed-job CRUD, worker/lock/stats introspection
- **Worker** — named workers, ordered/priority queues, `"*"` wildcard, poll/perform/complete, events (`start`, `poll`, `job`, `success`, `failure`, `reEnqueue`, `pause`, `ping`, …), heartbeats, `performInline`
- **Scheduler** — multi-instance, one leader; delayed-job eligibility; stuck-worker cleanup; **schema automigrate**; **completed-job sweeper** (default 24h)
- **Plugins** — `beforeEnqueue` / `afterEnqueue` / `beforePerform` / `afterPerform`; built-ins `JobLock`, `QueueLock`, `DelayQueueLock`, `Retry`, `Noop`
- **MultiWorker** — min/max processors, event-loop delay scaling

Postgres-specific additions:

- `connectionString` (or `host` / `port` / `database` / `user` / `password` / `ssl`, or a brought-in `pg.Pool`)
- `schema` (replaces Redis `namespace`)
- `automigrate` (leader-only)
- `completeJobRetentionMs` (leader sweeper; default 24 hours)

## Requirements

- Node.js 20+ or Bun
- PostgreSQL 13+ (pg-boss requires `SKIP LOCKED`)

## Development

See [`CLAUDE.md`](./CLAUDE.md) for commands and conventions. After Phase 1 lands:

```bash
bun install
docker compose up -d postgres
bun test
```

## License

Apache-2.0, same as node-resque.
