# Phase 1 — Repo scaffold, test harness, and CI

**Status:** not-started  
**Depends on:** Phase 0

## Goal

Stand up the package **and** a CI gate that talks to Postgres on every PR. Later phases add behavior; they do not invent testing. If CI is red, the phase is not done.

## Why

node-resque uses npm + Jest + Prettier. Keryx uses Bun + bun:test + Biome. This repo follows **Keryx's toolchain** and **node-resque's package shape**.

CI must exist **before** Queue/Worker code. An empty `expect(true)` that never opens Postgres will not catch a broken `DATABASE_URL` or a missing service. The first test proves the pipeline: install, lint, typecheck, and `SELECT 1` against Postgres.

## Deliverables

### Package

- `package.json`
  - `name`: `pgboss-queue`
  - `version`: `0.0.1`
  - `type`: `"module"`
  - `main` / `types`: `dist/index.js` / `dist/index.d.ts`
  - `exports` with `import` + types
  - `engines.node`: `>=20`
  - `license`: `Apache-2.0`
  - `scripts`: `"test": "bun test --concurrency=1"`, `build`, `lint`, `format` (docs scripts wait for Phase 9)
  - `devDependencies`: `typescript`, `@types/node`, `@types/pg`, `@biomejs/biome`, `@types/bun`
  - `dependencies`: `pg` now (smoke test uses it). Add `pg-boss` in Phase 2 if you want to keep this PR smaller — either is fine as long as CI is green.
- `tsconfig.json` — `strict`, `ES2022`, `moduleResolution: bundler` or `nodenext`, `declaration`, `outDir: dist`, `rootDir: src`
- `biome.json` — match keryx reasonably (indent 2, no unused imports)
- `.gitignore` — `node_modules`, `dist`, `.env`, `docs/.vitepress/dist`, `*.log`
- `LICENSE` — Apache-2.0
- `.nvmrc` or `.node-version` — `20`
- `.env.example` — `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/pgboss_queue_test`

### Source stub

```ts
// src/index.ts — empty exports that later phases fill
export {};
```

Keep the file compiling. Do not fake Queue/Worker yet.

### Local Postgres

`docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: pgboss_queue_test
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 10
```

### Test harness (not a dummy assert)

`__tests__/utils/specHelper.ts` — the same helper later phases grow. In this phase it must:

- Read `DATABASE_URL` (fail the suite with a clear message if unset)
- Export `connectionDetails`, `timeout` (e.g. 500), `queue` (a default queue name), `schema` (default `pgboss_queue_test`)
- `connect()` / `disconnect()` against `pg.Pool`
- `cleanup()` — no-op or `SELECT 1` until Phase 2 adds truncate/migrate
- `popFromQueue()` — throw `"not implemented"` until Phase 3 (do not silently return null)

`__tests__/smoke.test.ts`:

- `DATABASE_URL` is defined
- `SELECT 1` returns `1` through specHelper's pool
- `bun run build` artifacts exist *or* that check lives in CI only (prefer CI `bun run build`)

Do **not** ship only `expect(true).toBe(true)`.

### CI — full test workflow now

`.github/workflows/test.yaml` is the product gate from this PR onward. Copy this shape (keryx `test.yaml` + node-resque's Postgres-instead-of-Redis):

```yaml
name: Test
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run lint

  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run build

  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: pgboss_queue_test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun test
        env:
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/pgboss_queue_test

  complete:
    if: always()
    needs: [lint, build, test]
    runs-on: ubuntu-latest
    steps:
      - run: |
          if [[ "${{ contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') }}" == "true" ]]; then
            exit 1
          fi
```

Rules:

- Do **not** wait for Phase 10 to add this file. Phase 10 is npm publish + GitHub Pages only.
- Do **not** add a `docs` job yet (VitePress does not exist). Phase 9 appends it.
- `complete` must fail the workflow if lint, build, or test failed.
- Branch protection (when maintainers can set it): require `complete`.

### README / CLAUDE.md

`README.md` is **user-facing only**. Do not add plan links. Optionally a Test badge pointing at this workflow once it exists on `main`.

## Acceptance criteria

- `bun install` works locally
- `bun run build` emits `dist/`
- `bun run lint` is clean
- `docker compose up -d postgres` + `bun test` is green locally
- **GitHub Actions on this PR is green** (lint, build, Postgres test job, `complete`)
- Smoke test fails if Postgres is down or `DATABASE_URL` is missing
- No runtime exports claimed that do not exist

## Next phase needs

A compiling package, a shared `specHelper`, and CI that will run every subsequent test file automatically. Phase 2 fills `migrate()` / `cleanup()` and ports connection tests.

## Lessons learned

- 2026-08-26 (plan): Test CI and a real Postgres smoke test (`SELECT 1`) belong here, not in Phase 10. Later phases must stay green on this workflow.
