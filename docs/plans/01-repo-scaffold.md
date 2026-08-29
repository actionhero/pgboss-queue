# Phase 1 — Repo scaffold, test harness, and CI

**Status:** done  
**Depends on:** Phase 0

## Goal

Stand up the package **and** a CI gate that talks to Postgres on every PR. Later phases add behavior; they do not invent testing. If CI is red, the phase is not done.

## Why

node-resque uses npm + Jest + Prettier. Keryx uses Bun + bun:test + Biome. This repo follows **Keryx's toolchain** and **node-resque's package shape**.

CI must exist **before** Queue/Worker code. An empty `expect(true)` that never opens Postgres will not catch a broken `DATABASE_URL` or a missing service. The first test proves the pipeline: install, lint, typecheck, and `SELECT 1` against Postgres.

## Deliverables

### Package

- `package.json`
  - `name`: `pg-queue`
  - `version`: `0.0.1`
  - `type`: `"module"`
  - `main` / `types`: `dist/index.js` / `dist/index.d.ts`
  - `exports` with `import` + types
  - `engines.node`: `>=26`
  - `license`: `Apache-2.0`
  - `scripts`: `"test": "bun test --max-concurrency=1"`, `"test:node-package": "node scripts/assert-node-package.mjs"`, `build`, `lint`, `format` (docs scripts wait for Phase 9)
  - `devDependencies`: `typescript`, `@types/node`, `@types/pg`, `@biomejs/biome`, `@types/bun`
  - `dependencies`: `pg` (smoke test and queue storage use it).
- `tsconfig.json` — `strict`, `noImplicitAny: true`, `ES2022`, `moduleResolution: bundler` or `nodenext`, `declaration`, `outDir: dist`, `rootDir: src`. `tsconfig.test.json` typechecks `__tests__` with `noEmit` (so implicit `any` in tests fails `build` too).
- `biome.json` — match keryx reasonably (indent 2, no unused imports). `suspicious/noExplicitAny` is `error` so `: any` and `as any` fail `lint`.
- `.gitignore` — `node_modules`, `dist`, `.env`, `docs/.vitepress/dist`, `*.log`
- `LICENSE` — Apache-2.0
- `.nvmrc` or `.node-version` — `26`
- `.env.example` — `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/pgqueue_test`

### Source stub

```ts
// src/index.ts — empty exports that later phases fill
export {};
```

Keep the file compiling. Do not fake Queue/Worker yet.

### Local Postgres

No `docker-compose.yml`. CI starts Postgres as a GitHub Actions service. Locally, point `DATABASE_URL` at any Postgres 13+ you already run (homebrew, apt, a shared dev database, etc.). Tests must never target production.

`.env.example` is the only local-DB contract:

```
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/pgqueue_test
```

### Test harness (not a dummy assert)

`__tests__/utils/specHelper.ts` — the same helper later phases grow. In this phase it must:

- Read `DATABASE_URL` (fail the suite with a clear message if unset)
- Export `connectionDetails`, `timeout` (e.g. 500), `queue` (a default queue name), `schema` (default `pgqueue_test`)
- `connect()` / `disconnect()` against `pg.Pool`
- `cleanup()` — no-op or `SELECT 1` until Phase 2 adds truncate/migrate
- `popFromQueue()` — throw `"not implemented"` until Phase 3 (do not silently return null)

`__tests__/smoke.test.ts`:

- `DATABASE_URL` is defined
- `SELECT 1` returns `1` through specHelper's pool
- `bun run build` artifacts exist *or* that check lives in CI only (prefer CI `bun run build`)

Do **not** ship only `expect(true).toBe(true)`. Tests use `bun:test`. Node compatibility is `scripts/assert-node-package.mjs`: after `bun run build`, Node 26 imports `package.json` `exports["."].import` (`dist/index.js`) and asserts `process.versions.bun` is unset. Later phases should import real public APIs in that script (do not re-run the Bun suite on Node).

### CI — full test workflow now

`.github/workflows/test.yaml` is the product gate from this PR onward. Jobs: `lint`, `build`, `test` (Postgres 16 service, **Bun `bun:test`**), `node-package` (Node 26 imports the compiled package), `complete`.

- `test`: `bun run test` with `DATABASE_URL=postgres://postgres:postgres@localhost:5432/pgqueue_test`
- `node-package`: `actions/setup-node` from `.nvmrc` (26), `bun run build`, then **`node scripts/assert-node-package.mjs`** (not `bun run`; no Postgres)

See the workflow file for the YAML. Do not duplicate a second test pipeline in Phase 10.

Rules:

- Do **not** wait for Phase 10 to add this file. Phase 10 is npm publish + GitHub Pages only.
- Do **not** add a `docs` job yet (VitePress does not exist). Phase 9 appends it.
- `complete` must fail the workflow if lint, build, or test failed.
- Branch protection (maintainer UI; this agent cannot set it): require `complete` and `Cursor Bugbot`.

### README / CLAUDE.md

`README.md` is **user-facing only**. Do not add plan links. Optionally a Test badge pointing at this workflow once it exists on `main`.

## Acceptance criteria

- `bun install` works locally
- `bun run build` emits `dist/`
- `bun run lint` is clean
- `DATABASE_URL` pointing at a local Postgres + `bun test` is green
- `bun run build` + `node scripts/assert-node-package.mjs` is green on Node 26
- **GitHub Actions on this PR is green** (lint, build, Bun Postgres tests, Node package import, `complete`)
- Smoke test fails if Postgres is down or `DATABASE_URL` is missing
- No runtime exports claimed that do not exist

## Next phase needs

A compiling package, a shared `specHelper`, and CI that will run every subsequent test file automatically. Phase 2 fills `migrate()` / `cleanup()` and ports connection tests.

## Lessons learned

- 2026-08-26 (plan): Test CI and a real Postgres smoke test (`SELECT 1`) belong here, not in Phase 10. Later phases must stay green on this workflow.
- 2026-08-26: Pin Node to Current 26 (`engines.node` `>=26`, `.nvmrc` `26`) instead of the original `>=20` pin. `@types/node` already tracks 26.
- 2026-08-26: `bun test --concurrency=1` is not a Bun flag (`bun test --help` has `--concurrent` and `--max-concurrency`, not `--concurrency`). Bun still accepted the unknown flag and ran anyway. Use `--max-concurrency=1` on Bun and `--test-concurrency=1` on `node --test`. Tests are sequential by default unless `--concurrent` / `--parallel` is set.
- 2026-08-26: Dropped `docker-compose.yml`. CI Postgres is a GitHub Actions service; locally `DATABASE_URL` is enough. Compose would only wrap a database this repo does not otherwise orchestrate.
- 2026-08-26: Test matrix runs the same `node:test` files on Bun and Node 26. `bun:test` cannot run on Node, so the suite is `node:test` + `node:assert/strict` rather than `bun:test`.
- 2026-08-26: Ban `any` in the whole tree: `noImplicitAny` in `tsconfig.json` (explicit even though `strict` already implies it), `tsc --noEmit -p tsconfig.test.json` so tests are included, and Biome `noExplicitAny` as an error. `tsc` has no `noExplicitAny` flag.
- 2026-08-26: Reverted the suite to `bun:test`. Node coverage is `scripts/assert-node-package.mjs` (import compiled `exports` on Node 26, not a second copy of the Postgres tests).
- 2026-08-26: The `node-package` CI step must invoke `node` directly. `bun run test:node-package` can still shell out to `node`, but the workflow should not go through Bun for that check.
- 2026-08-26: `noImplicitAny` is set on both `tsconfig.json` and `tsconfig.test.json` so relaxing `strict` later still bans implicit `any` in src and tests.
- 2026-08-26: Required checks on `main` should be `complete` and `Cursor Bugbot`. The cloud agent GitHub token is not a repo admin (403 on branch protection and rulesets), so a maintainer must set that in the GitHub UI.
- 2026-08-26: Phase 2 filled `specHelper.cleanup()` / `migrate()` / `dropSchema()` and added `pg-boss`. Smoke test remains valid; connection suite uses `*.test.ts` filenames because Bun will not discover bare `connection.ts`.
- 2026-08-29: The project was renamed to `pg-queue` and pg-boss was removed. `pg` is now the only runtime dependency; bundled SQL migrations are included in package files.
