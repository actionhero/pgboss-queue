# Implementation plans

These documents are the **living** implementation spec for `pgboss-queue`. Execute them in order. Each phase lists **goal**, **why**, **deliverables**, **acceptance criteria**, **what the next phase needs**, and **Lessons learned**.

When you implement or change something a phase covers, update that file in the same PR and append to **Lessons learned**. Do not leave plans stale. See `CLAUDE.md` → *Keep the phase plans current*.

| # | File | Depends on | Ships |
| --- | --- | --- | --- |
| 0 | [00-overview.md](./00-overview.md) | — | Architecture, API map, keryx lessons, non-goals |
| 1 | [01-repo-scaffold.md](./01-repo-scaffold.md) | 0 | Package, Bun, Biome, compose, **specHelper, Postgres CI** |
| 2 | [02-connection-and-schema.md](./02-connection-and-schema.md) | 1 | `Connection`, migrate, metadata DDL **+ connection tests in CI** |
| 3 | [03-queue.md](./03-queue.md) | 2 | `Queue` **+ `__tests__/core/queue.ts` in CI** |
| 4 | [04-worker.md](./04-worker.md) | 3 | `Worker` **+ worker tests in CI** |
| 5 | [05-scheduler.md](./05-scheduler.md) | 4 | Scheduler **+ scheduler tests in CI** |
| 6 | [06-plugins.md](./06-plugins.md) | 4 | Plugins **+ plugin tests in CI** |
| 7 | [07-multiworker.md](./07-multiworker.md) | 4 | `MultiWorker` **+ multiWorker tests in CI** |
| 8 | [08-conformance-tests.md](./08-conformance-tests.md) | 1–7 | **Audit** remaining matrix + `check-conformance` (not first tests) |
| 9 | [09-docs-site.md](./09-docs-site.md) | 0, 3–7 | VitePress site + `docs:build` CI job |
| 10 | [10-publish-and-ci.md](./10-publish-and-ci.md) | 1, 8, 9 | Pages deploy + npm publish (**not** test CI) |

**Tests and CI come first.** Phase 1 ships `.github/workflows/test.yaml` (lint, build, Postgres, `complete`). Every later phase ports its node-resque tests in the **same PR** as the code; that PR is not done until CI is green. Phase 8 only fills gaps and freezes the skip list. Phase 10 does not recreate test CI.

Phases 6 and 7 can proceed in parallel after Phase 4. Phase 9 may start a stub site earlier; it is not done until the guide matches the shipped API.

## Status legend

Each phase file starts with a status line:

- `not-started` — no implementation
- `in-progress` — branch open
- `done` — merged, acceptance criteria met

## Lessons learned

Every phase file ends with an empty `## Lessons learned` section. Fill it as you go: surprises, pg-boss API mismatches, tests we had to adapt, decisions that diverged from the original plan. Newest entry last. Never delete old bullets.
