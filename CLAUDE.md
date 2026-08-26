# CLAUDE.md

Guidance for Claude Code and other agents working in this repository.

## Project

`pgboss-queue` is a TypeScript background-job library. The public API is the node-resque trio — `Queue`, `Worker`, `Scheduler` — plus `MultiWorker` and `Plugins`. Storage is PostgreSQL via [pg-boss](https://github.com/timgit/pg-boss), not Redis.

This is an Actionhero project (sibling of [node-resque](https://github.com/actionhero/node-resque) and [keryx](https://github.com/actionhero/keryx)). It exists so Keryx and other apps can keep the resque worker/scheduler pattern without a Redis dependency for jobs.

**Read the plans before writing code.** Implementation is specified in [`docs/plans/`](./docs/plans/). Do not invent a different API or skip a phase's acceptance criteria.

| If you are… | Start here |
| --- | --- |
| Orienting | [`docs/plans/00-overview.md`](./docs/plans/00-overview.md) |
| Scaffolding the package | [`docs/plans/01-repo-scaffold.md`](./docs/plans/01-repo-scaffold.md) |
| Touching connections / SQL | [`docs/plans/02-connection-and-schema.md`](./docs/plans/02-connection-and-schema.md) |
| Enqueue / inspect / fail | [`docs/plans/03-queue.md`](./docs/plans/03-queue.md) |
| Running jobs | [`docs/plans/04-worker.md`](./docs/plans/04-worker.md) |
| Leader, migrate, sweep | [`docs/plans/05-scheduler.md`](./docs/plans/05-scheduler.md) |
| Locks / retry | [`docs/plans/06-plugins.md`](./docs/plans/06-plugins.md) |
| In-process pool | [`docs/plans/07-multiworker.md`](./docs/plans/07-multiworker.md) |
| Porting tests | [`docs/plans/08-conformance-tests.md`](./docs/plans/08-conformance-tests.md) |
| Docs site | [`docs/plans/09-docs-site.md`](./docs/plans/09-docs-site.md) |
| CI / npm | [`docs/plans/10-publish-and-ci.md`](./docs/plans/10-publish-and-ci.md) |

## Current state

User-facing docs live in `README.md` (and later the VitePress site). Do not put implementation-plan links, phase tables, or "status: planning" notes in the README.

The implementation spec is `docs/plans/*` plus this file. Library source, tests, VitePress, and CI land in later phases. When a phase is complete, update that plan's **Status** line to `done` and move on.

## Keep the phase plans current (required)

`docs/plans/` is a living spec, not a frozen brief. **Every PR that implements or changes behavior covered by a phase must update that phase file in the same PR.** This is mandatory — a code-only PR that leaves a stale plan is incomplete.

When you touch code, tests, CI, or docs that belong to a phase (or that invalidate something that phase assumed):

1. **Edit the phase doc** so it still describes what we actually ship: APIs, table names, option defaults, test names, skip reasons, workflow filenames, etc. If the plan was wrong, change the plan and say why — do not silently implement a shortcut.
2. **Append to `## Lessons learned`** on every affected phase. That section starts empty on purpose. Add dated, concrete bullets (what we tried, what broke, what we decided). Do not rewrite history; do not delete old entries.
3. **Update Status** (`not-started` → `in-progress` → `done`) when that is true.
4. If work spans phases (e.g. a Queue bug found while writing Worker tests), update **all** relevant phase files, each with its own lessons-learned note.

A PR with no `docs/plans/` diff is only OK when the change is truly unrelated (typo in README prose, lockfile-only, etc.). If you are unsure, update the phase.

## Tooling (once Phase 1 exists)

This is a **Bun + TypeScript** project. Use `bun`, never `npm` or `npx`, for install/test/run. Use `bunx` if you need a package runner.

```bash
bun install                 # install
bun test                    # bun:test, needs Postgres
bun run lint                # biome check
bun run format              # biome write
bun run build               # tsc / bun build of src → dist
bun docs:dev                # VitePress (Phase 9)
```

Local Postgres (Phase 1 `docker-compose.yml`):

```bash
docker compose up -d postgres
# DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/pgboss_queue_test
```

Tests create and tear down the configured schema per file (see `specHelper`). Never point tests at a production database.

## Architecture (do not violate)

1. **node-resque is the runtime model.** Classes, events, plugin hooks, worker names (`hostname:pid[+id]`), queue priority (array order), leader-elected scheduler. Port behavior; do not "simplify" it into pg-boss's `work()` helper.
2. **pg-boss is the job store.** Jobs live in pg-boss's `job` table. Dequeue with `fetch` + `SKIP LOCKED` (or equivalent SQL), not `LPOP`. Delayed jobs use `startAfter`. Do not reimplement a job table next to pg-boss.
3. **We own metadata pg-boss does not.** Workers, heartbeats, leader lock, plugin locks, and processed/failed counters live in *our* tables in the same schema (or a documented adjacent schema). See Phase 2.
4. **The elected scheduler is the only migrator and sweeper.** `automigrate` and completed-job deletion run on the leader, never on every worker. Workers start pg-boss with `migrate: false` and `supervise: false`.
5. **Keryx PR #519 is research, not a copy target.** Steal: connection strings, schema isolation, SQL introspection on `job`, `short` policy for singleton pending jobs, `deleteAfterSeconds` thinking. Do not steal: dropping worker heartbeats, dropping plugins, replacing `Worker` with a single `boss.work` handler, removing the scheduler.

## Public API

Export from `src/index.ts` (names match node-resque):

```ts
export { Connection } from "./core/connection";
export { Queue, type ParsedJob, type ParsedWorkerPayload, type ParsedFailedJobPayload } from "./core/queue";
export { Scheduler } from "./core/scheduler";
export { Worker } from "./core/worker";
export { MultiWorker } from "./core/multiWorker";
export { Plugin } from "./core/plugin";
export { default as Plugins } from "./plugins";
```

Jobs:

```ts
const jobs = {
  add: {
    plugins: [Plugins.JobLock],
    pluginOptions: { JobLock: { reEnqueue: true } },
    perform: async (a: number, b: number) => a + b,
  },
  subtract: async (a: number, b: number) => a - b, // function form is allowed
};
```

Connection (Postgres, not Redis):

```ts
type ConnectionOptions = {
  connectionString?: string;          // preferred
  host?: string;                      // default 127.0.0.1
  port?: number;                      // default 5432
  database?: string;                  // database *name*, not Redis logical DB index
  user?: string;
  password?: string;
  ssl?: boolean | object;
  pool?: import("pg").Pool;           // bring-your-own (maps to pg-boss `db`)
  schema?: string;                    // default "pgboss_queue" (was Redis namespace)
};

type SchedulerOptions = ConnectionOptions & {
  connection?: ConnectionOptions;
  name?: string;
  timeout?: number;                   // poll interval, default 5000
  leaderLockTimeout?: number;         // seconds, default 180
  stuckWorkerTimeout?: number | false;
  retryStuckJobs?: boolean;
  automigrate?: boolean;              // default true; leader-only
  completeJobRetentionMs?: number;    // default 24h; leader sweeper
};
```

Do **not** accept `pkg: "ioredis"`, `redis: Redis`, or `database: number`. Those are node-resque Redis options. Document the mapping in the README and in Phase 2.

## Coding conventions

- **TypeScript strict.** No `as any`. Use `@ts-expect-error` with a comment when the type system cannot express something.
- **JSDoc on every public class, method, and exported type.** `@param` for each parameter (including edge cases), `@returns` when non-obvious, `@throws` when applicable. Match node-resque's documented Queue methods.
- **No Python.** New scripts, CLIs, and tooling are Bun + TypeScript.
- **Biome** for format/lint (keryx-style), not Prettier.
- **Tests use `bun:test`**, not Jest. Port node-resque tests faithfully: same `describe` / `test` names, same assertions, Postgres `specHelper` instead of Redis.
- **Every behavior change ships with tests.** A PR with no test changes is a red flag unless it is docs-only.
- **Do not add dependencies** unless a phase plan names them. Expected runtime deps: `pg-boss`, `pg`. Dev: `typescript`, `@types/pg`, `biome`, `bun` types.

## Testing rules

Target: **100% conformance to the relevant node-resque test suite.** "Relevant" is defined in Phase 8. Redis-only tests (ioredis mock, Lua `popAndStoreJob`, keyPrefix, `KEYS`/`SCAN`) are skipped and listed. Everything else must pass with the same assertions.

When porting a test:

1. Copy the test name and intent.
2. Swap `specHelper.redis.*` for helper methods that speak SQL / Queue API.
3. If a test stubs `connection.redis.set`, stub the equivalent Postgres/leader-lock function.
4. If you must change an assertion because Postgres is not Redis, add a row to the Phase 8 **semantic-diff table** and a comment on the test. Do not silently weaken it.

## Documentation

User-facing docs are Markdown in `docs/`, built with VitePress (Phase 9). Implementation plans stay in `docs/plans/` and may be linked from a Contributing page but are not the product docs.

When you change a public method, update:

1. JSDoc
2. The matching guide page under `docs/guide/` (once Phase 9 exists)
3. Tests

## Publishing

Follow keryx: bump `version` in `package.json` on every user-facing PR (patch for fixes, minor for features). CI publishes to npm when `main`'s version differs from the registry (OIDC trusted publishing + GitHub Release). See Phase 10. Do not `npm publish` from a laptop.

## Pull requests

- One phase per PR when possible. Do not combine "invent MultiWorker" with "stand up VitePress".
- Link the plan file in the PR body (`Implements docs/plans/0X-….md`).
- Update the phase document(s) and **`## Lessons learned`** in the same PR (see **Keep the phase plans current** above). Do not leave plans stale.

## Upstream references (read, don't vendor)

- node-resque README + `src/core/*` + `__tests__/*` — source of truth for behavior
- node-resque examples (`example.ts`, `multiWorker.ts`, `scheduledJobs.ts`, `retry.ts`, `stuckWorker.ts`, `cluster.ts`)
- [keryx#519](https://github.com/actionhero/keryx/pull/519) — `PgBossBackend.ts`, `TaskBackend.ts`, `config/tasks.ts`
- pg-boss docs — constructor options (`connectionString`, `schema`, `migrate`, `supervise`, `schedule`), `send` / `fetch` / `complete` / `fail`, `startAfter`, `deleteAfterSeconds`
