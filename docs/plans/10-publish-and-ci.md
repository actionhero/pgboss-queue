# Phase 10 — CI, GitHub Pages, and auto-publish

**Status:** not-started  
**Depends on:** Phase 1 (workflow stub), Phase 8 (tests mean something), Phase 9 (docs build)

## Goal

Match **keryx** operations, not node-resque's npm+TypeDoc scripts:

1. PR CI: lint + tests against Postgres
2. `main`: deploy VitePress to GitHub Pages
3. `main`: publish to npm when `package.json` version changes (OIDC), then GitHub Release

## Test workflow

`.github/workflows/test.yaml`

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

  docs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run docs:build

  complete:
    if: always()
    needs: [lint, test, docs]
    runs-on: ubuntu-latest
    steps:
      - run: |
          if [[ "${{ contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') }}" == "true" ]]; then
            exit 1
          fi
```

Optional later: Node 20/22/24 matrix via `bun` isn't required; if we also support Node consumers, add a `node` job that `bun run build && node --test` or runs the compiled tests. v1: bun test is enough if `dist/` is what we publish.

Also run `bun run build` in CI so broken `tsc` cannot publish.

## Docs deploy

`.github/workflows/docs.yaml` — copy [keryx docs.yaml](https://github.com/actionhero/keryx/blob/main/.github/workflows/docs.yaml):

- `permissions: contents: read, pages: write, id-token: write`
- concurrency group `pages`
- build with bun + `vitepress build`
- `actions/deploy-pages@v4`

Enable GitHub Pages (Actions source) on the repo when this merges.

## Publish (keryx `publish.yaml` pattern)

Keryx:

1. On push to `main` when `packages/*/package.json` changes
2. Matrix of packages
3. Compare `require(package.json).version` to `npm view {name} version` (missing → `0.0.0`)
4. If different: `npm publish --access public --provenance`
5. `gh release create v$VERSION --generate-notes` for the main package
6. `id-token: write` + `contents: write`
7. `actions/setup-node` with `registry-url: https://registry.npmjs.org`
8. `npm install -g npm@latest` (OIDC / provenance)
9. They still pass `NODE_AUTH_TOKEN` in some revisions; the **intended** setup is npm **trusted publishing** (OIDC) so no long-lived `NPM_TOKEN` is required. Prefer OIDC: configure the npm package to trust GitHub Actions on `actionhero/pgboss-queue`. If trusted publishing is not set up yet, `NPM_TOKEN` is the fallback — document both in this phase's PR.

Our single-package version:

```yaml
name: Publish
on:
  push:
    branches: [main]
    paths:
      - package.json

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
          registry-url: https://registry.npmjs.org
      - run: npm install -g npm@latest
      - run: bun install
      - run: bun run build
      - name: Check if version changed
        id: version
        run: |
          LOCAL=$(node -p "require('./package.json').version")
          REMOTE=$(npm view pgboss-queue version 2>/dev/null || echo "0.0.0")
          echo "local=$LOCAL" >> "$GITHUB_OUTPUT"
          echo "remote=$REMOTE" >> "$GITHUB_OUTPUT"
          if [ "$LOCAL" != "$REMOTE" ]; then
            echo "changed=true" >> "$GITHUB_OUTPUT"
          else
            echo "changed=false" >> "$GITHUB_OUTPUT"
          fi
      - name: Publish to npm
        if: steps.version.outputs.changed == 'true'
        run: npm publish --access public --provenance
      - name: Create GitHub Release
        if: steps.version.outputs.changed == 'true'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release create "v${{ steps.version.outputs.local }}" \
            --title "v${{ steps.version.outputs.local }}" \
            --generate-notes
```

`package.json` must include `"files": ["dist", "README.md", "LICENSE"]` so we do not publish tests or plans.

## Versioning policy (CLAUDE.md)

Every user-facing PR bumps `version`. Patch = fix, minor = feature. First real release: `0.1.0` when Phase 8 is done. `0.0.x` while scaffolding.

Do not publish `0.0.1` empty stubs. Gate: publish job can exist, but first intentional bump to `0.1.0` is the first npm release.

## Examples and docker

Port node-resque `examples/` to this repo (Phase 4–7). Phase 10 adds a compose-based example README command:

```bash
docker compose up -d postgres
bun examples/example.ts
```

Optional: `examples/docker` like node-resque — not required for v1.

## Badges

README: GitHub Test workflow badge, npm version, license.

## Acceptance criteria

- PRs cannot merge red (complete job)
- Docs publish from `main`
- Changing version on `main` publishes npm + GitHub Release
- Trusted publishing documented for maintainers (npm UI steps)
- Empty-package accident: `files` field + `0.1.0` gate

## After 1.0

- Keryx consumes `pgboss-queue` instead of in-tree `PgBossBackend`
- Optional admin UI package (resque-admin against SQL)
- `LISTEN/NOTIFY` as an opt-in latency flag (`useListenNotify`)

## Lessons learned

_None yet._
