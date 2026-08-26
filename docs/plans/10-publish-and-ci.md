# Phase 10 — Docs deploy and npm publish

**Status:** not-started  
**Depends on:** Phase 1 (test CI already running), Phase 8 (conformance audit green), Phase 9 (docs build)

## Goal

Ship **release automation**. Test CI is **not** this phase — `.github/workflows/test.yaml` has been green since Phase 1. Here we add:

1. `main`: deploy VitePress to GitHub Pages (if Phase 9 did not already)
2. `main`: publish to npm when `package.json` version changes (OIDC), then GitHub Release

Match **keryx** publish/docs workflows, not node-resque's TypeDoc scripts.

## Do not recreate test CI

Do not replace or duplicate `test.yaml`. If something is missing (Node consumer matrix, `docs:build` on PRs), patch **Phase 1's workflow** (and Phase 9 for the docs job) rather than inventing a second test pipeline here.

Phase 9 should already have appended a `docs` job to `test.yaml` and a `docs.yaml` Pages deploy. If those are missing, add them in this PR and note it under Lessons learned on Phases 9 and 10.

## Docs deploy

`.github/workflows/docs.yaml` — copy [keryx docs.yaml](https://github.com/actionhero/keryx/blob/main/.github/workflows/docs.yaml):

- `permissions: contents: read, pages: write, id-token: write`
- concurrency group `pages`
- build with bun + `vitepress build`
- `actions/deploy-pages@v4`

Enable GitHub Pages (Actions source) on the repo when this merges.

## Publish (keryx `publish.yaml` pattern)

Keryx:

1. On push to `main` when package.json version changes
2. Compare `require(package.json).version` to `npm view {name} version` (missing → `0.0.0`)
3. If different: `npm publish --access public --provenance`
4. `gh release create v$VERSION --generate-notes`
5. `id-token: write` + `contents: write`
6. `actions/setup-node` with `registry-url: https://registry.npmjs.org`
7. `npm install -g npm@latest` (OIDC / provenance)

**Intended setup:** npm **trusted publishing** (OIDC) so no long-lived `NPM_TOKEN`. Configure the npm package to trust GitHub Actions on `actionhero/pgboss-queue`. Fallback: `NPM_TOKEN`. Document both in this phase's PR.

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

Optional later: Node 20/22/24 matrix for compiled `dist/` consumers. Add to `test.yaml` (Phase 1 file), not here.

## Versioning policy (CLAUDE.md)

Every user-facing PR bumps `version`. Patch = fix, minor = feature. First real release: `0.1.0` when Phase 8 is done. `0.0.x` while scaffolding.

Do not publish `0.0.1` empty stubs. First intentional bump to `0.1.0` is the first npm release.

## Examples and docker

Port node-resque `examples/` in Phases 4–7. This phase can add a compose-based example command if missing:

```bash
docker compose up -d postgres
bun examples/example.ts
```

Optional: `examples/docker` like node-resque — not required for v1.

## Badges

README (user-facing): GitHub Test workflow badge (the Phase 1 workflow), npm version, license.

## Acceptance criteria

- `test.yaml` still gates PRs (do not regress Phase 1)
- Docs publish from `main`
- Changing version on `main` publishes npm + GitHub Release
- Trusted publishing documented for maintainers
- Empty-package accident: `files` field + `0.1.0` gate

## After 1.0

- Keryx consumes `pgboss-queue` instead of in-tree `PgBossBackend`
- Optional admin UI package (resque-admin against SQL)
- `LISTEN/NOTIFY` as an opt-in latency flag (`useListenNotify`)

## Lessons learned

- 2026-08-26 (plan): Test CI is Phase 1. This phase is only Pages + npm publish.
