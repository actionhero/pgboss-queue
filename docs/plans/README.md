# Implementation plans

These documents are the **living** implementation spec for `pgboss-queue`. Execute them in order. Each phase lists **goal**, **why**, **deliverables**, **acceptance criteria**, **what the next phase needs**, and **Lessons learned**.

When you implement or change something a phase covers, update that file in the same PR and append to **Lessons learned**. Do not leave plans stale. See `CLAUDE.md` → *Keep the phase plans current*.

| # | File | Depends on | Ships |
| --- | --- | --- | --- |
| 0 | [00-overview.md](./00-overview.md) | — | Architecture, API map, keryx lessons, non-goals |
| 1 | [01-repo-scaffold.md](./01-repo-scaffold.md) | 0 | Package, Bun, Biome, compose, empty exports |
| 2 | [02-connection-and-schema.md](./02-connection-and-schema.md) | 1 | `Connection`, pg-boss boot, metadata DDL, migrate helper |
| 3 | [03-queue.md](./03-queue.md) | 2 | `Queue` enqueue + introspection + failed jobs |
| 4 | [04-worker.md](./04-worker.md) | 3 | `Worker` poll/perform/events/heartbeats |
| 5 | [05-scheduler.md](./05-scheduler.md) | 4 | Leader, automigrate, delayed eligibility, stuck workers, sweeper |
| 6 | [06-plugins.md](./06-plugins.md) | 4 | Plugin runner + five built-in plugins |
| 7 | [07-multiworker.md](./07-multiworker.md) | 4 | `MultiWorker` pool |
| 8 | [08-conformance-tests.md](./08-conformance-tests.md) | 3–7 | Full relevant node-resque suite green |
| 9 | [09-docs-site.md](./09-docs-site.md) | 0, 3–7 | VitePress site |
| 10 | [10-publish-and-ci.md](./10-publish-and-ci.md) | 1, 8, 9 | Test/docs/publish workflows |

Phases 6 and 7 can proceed in parallel after Phase 4. Phase 8 is the integration gate: it may add tests during 3–7, but is not *done* until the matrix in `08` is complete. Phase 9 may start a stub site earlier; it is not done until the guide matches the shipped API.

## Status legend

Each phase file starts with a status line:

- `not-started` — no implementation
- `in-progress` — branch open
- `done` — merged, acceptance criteria met

## Lessons learned

Every phase file ends with an empty `## Lessons learned` section. Fill it as you go: surprises, pg-boss API mismatches, tests we had to adapt, decisions that diverged from the original plan. Newest entry last. Never delete old bullets.
