# Phase 1 — Repo scaffold and tooling

**Status:** not-started  
**Depends on:** Phase 0

## Goal

Turn this empty repository into a Bun + TypeScript library skeleton that later phases can fill. No job behavior yet — but `bun test`, lint, and a local Postgres are real.

## Why

node-resque uses npm + Jest + Prettier. Keryx uses Bun + bun:test + Biome. This repo follows **Keryx's toolchain** (user rule: Bun + TypeScript for new work) and **node-resque's package shape** (single publishable library, `src/` → `dist/`).

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
  - `scripts`: `build`, `test`, `lint`, `format`, `docs:dev`, `docs:build` (docs scripts can stub until Phase 9)
  - `dependencies`: `pg-boss`, `pg` (add when Phase 2 starts if you want the skeleton compile-only in Phase 1)
  - `devDependencies`: `typescript`, `@types/node`, `@types/pg`, `@biomejs/biome`, `@types/bun`
- `tsconfig.json` — `strict`, `ES2022`, `moduleResolution: bundler` or `nodenext`, `declaration`, `outDir: dist`, `rootDir: src`
- `biome.json` — match keryx reasonably (indent 2, no unused imports)
- `.gitignore` — `node_modules`, `dist`, `.env`, `docs/.vitepress/dist`, `*.log`
- `LICENSE` — Apache-2.0
- `.nvmrc` or `.node-version` — `20` (CI also runs 22/24 later)
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

### Tests stub

`__tests__/smoke.test.ts` — `expect(true).toBe(true)` so `bun test` is wired. Replace in Phase 2.

### CI (minimal)

`.github/workflows/test.yaml` (expand in Phase 10):

- bun install
- biome check
- bun test with `services: postgres` (same image/env as compose)
- `DATABASE_URL` injected

Do **not** add publish or docs deploy yet.

### README / CLAUDE.md

Already written at repo root. Update the Development section if script names differ. Do not rewrite the architecture.

## Acceptance criteria

- `bun install` works
- `bun run build` emits `dist/` (even if index is empty)
- `bun run lint` is clean
- `docker compose up -d postgres` + `bun test` is green in CI
- No runtime exports claimed that do not exist

## Next phase needs

A compiling package, CI, and a running Postgres. Phase 2 adds `Connection` and schema.
