# Phase 9 — Documentation website (VitePress)

**Status:** not-started  
**Depends on:** Phases 0, 3–7 (API must exist to document accurately). A stub site may ship earlier.

## Goal

A markdown-driven docs site, same family as [keryx's VitePress](https://github.com/actionhero/keryx/tree/main/docs): guide + reference, local search, GitHub Pages.

node-resque today uses TypeDoc → `node-resque.actionherojs.com`. We still generate API pages from JSDoc, but the **narrative** lives in markdown (user request), not TypeDoc-only.

## Layout

```
docs/
  .vitepress/config.mts
  index.md                 # landing
  guide/
    index.md               # getting started
    concepts.md            # queues, workers, scheduler factory
    connection.md          # connectionString vs Redis, schema, pool
    queue.md
    worker.md
    scheduler.md           # leader, automigrate, sweeper, stuck workers
    plugins.md
    multiworker.md
    delayed.md
    failed.md
    migrating-from-node-resque.md
  reference/
    index.md               # how to read API docs
    queue.md               # can be generated or hand-written from JSDoc
    worker.md
    scheduler.md
    connection.md
    plugins.md
  changelog.md
  plans/                   # these files; link from Contributing only
```

## VitePress config (keryx patterns to copy)

From keryx `docs/.vitepress/config.mts` / `docs.yaml`:

- `appearance: "dark"`
- `lastUpdated: true`
- local search
- `editLink` → `https://github.com/actionhero/pgboss-queue/edit/main/docs/:path`
- nav: Guide, Reference, Changelog, GitHub, version from `package.json`
- sidebar grouped by task (getting started → concepts → operations), not by folder internals
- `vitepress-plugin-llms` + per-page `.md` alternate links (keryx does this; do it unless it slows us down — then defer, do not block)
- footer Apache-2.0, copyright Evan Tahler / Actionhero

`docs/package.json` as a workspace **or** root scripts:

```json
"docs:dev": "vitepress dev docs",
"docs:build": "vitepress build docs",
"docs:preview": "vitepress preview docs"
```

Single-package repo: put VitePress in root `devDependencies` to avoid a mini-monorepo unless we want `docs/` private workspace like keryx. **Prefer root scripts** for a single library.

## Page requirements

### Getting started

Copy the README boot example. Show:

1. Postgres up
2. `automigrate` via a Scheduler
3. enqueue + worker
4. `enqueueIn`

### Connection

Explicit Redis → Postgres table. Warn: `database` is a name. Show BYO `pool`. Show `schema`.

### Scheduler

State clearly:

- Run at least one scheduler in production
- Only the leader migrates when `automigrate: true`
- Only the leader sweeps completed jobs (`completeJobRetentionMs`, default 24h)
- Failed jobs are not swept
- `scheduler.leader` for CRON (port the node-resque `scheduledJobs` snippet)

### Migrating from node-resque

- Swap import
- Swap connection object
- Remove ioredis
- Plugins that used `connection.redis` must use lock helpers
- No Resque Redis UI; SQL / later admin package

### Reference

Either:

1. Hand-maintain markdown mirroring Queue/Worker/Scheduler JSDoc (keryx style), or
2. `typedoc --plugin typedoc-plugin-markdown` into `docs/reference/generated/` 

Prefer (1) for the small public surface, with a checklist: every public method has a heading.

## Deploy

`.github/workflows/docs.yaml` (copy keryx `docs.yaml`):

- on push `main` + `workflow_dispatch`
- bun install
- `bun run docs:build`
- `actions/upload-pages-artifact` from `docs/.vitepress/dist`
- `actions/deploy-pages`

Permissions: `pages: write`, `id-token: write`.

Custom domain optional (`CNAME`); default `https://actionhero.github.io/pgboss-queue/` until DNS exists.

## Tests

keryx runs `bun test` inside `docs/` after build. Minimum: `docs:build` job in CI (Phase 10) must succeed. Add `docs/__tests__/build.test.ts` that asserts `docs/.vitepress/dist/index.html` exists after build if we want parity.

## Editorial

Short sentences. No "simply". Code samples TypeScript. Mirror node-resque event names so existing blog posts still make sense.

## Acceptance criteria

- `bun run docs:dev` works
- `bun run docs:build` works in CI
- Guide covers connection, worker, scheduler (migrate + sweeper), plugins, multiworker, migration from node-resque
- Plans are not the homepage

## Next

Phase 10 wires docs deploy next to npm publish.
