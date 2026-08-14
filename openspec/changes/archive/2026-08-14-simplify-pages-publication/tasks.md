## 1. Replace the publication workflow

- [x] 1.1 Rewrite `.github/workflows/pages.yml` as a single `deploy` job: triggers `push` (branches `[main]`) and `workflow_dispatch`; workflow-level `permissions: {}`; `concurrency: { group: github-pages, cancel-in-progress: false }`; job-level `permissions: { pages: write, id-token: write, contents: read }`; `environment: github-pages`; guarded `if: github.ref == 'refs/heads/main'` so a dispatch cannot publish an unmerged ref
- [x] 1.2 Give that job the step sequence: checkout (`persist-credentials: false`, no `ref:`) → `oven-sh/setup-bun` at `1.3.14` → `bun install --frozen-lockfile` → `bun run api:validate && bun run scripts/api-contract/structural.ts` → `bunx astro build --root site` (with `GITHUB_SHA` in env) → `bun run site:check` → `configure-pages` → `upload-pages-artifact` with `path: site/dist` → `deploy-pages`. Keep every action pinned to its existing 40-character SHA
- [x] 1.3 Remove the `Upload exact validated edge site` step from the `contract-integration` job in `.github/workflows/ci.yml`

## 2. Serve the contract at `/api/`

- [x] 2.1 In `scripts/assemble-api-site.ts`, write artifacts to `join(outputPath, "api")` instead of `join(outputPath, "api", "edge")`, and rename `assembleEdgeArtifacts` to `assembleApiArtifacts`
- [x] 2.2 Update `site/astro.config.mjs` for the rename: the import, the call, and the `uatu-edge-artifacts` integration name
- [x] 2.3 Update the four `sitePath("api/edge/...")` references in `site/src/pages/index.astro`, `site/src/pages/docs/api/index.astro`, `site/src/layouts/SiteLayout.astro`, and the `api/edge/` prefix in `site/src/lib/guides.ts`
- [x] 2.4 Update the eight `api/edge/` assertions in `site/site.test.ts`
- [x] 2.5 Update the four artifact links in `api/agent.md` and rewrite its channel-selection line (currently "Use `edge` for development…, `latest` for release discovery, and `/api/revisions/<revision-id>/`…") to describe the single published contract
- [x] 2.6 Rewrite `api/guides/compatibility.md` lines that reference immutable revision artifacts and the edge/latest/snapshot channels; keep the revision-pair comparison guidance, which is unchanged
- [x] 2.7 Rewrite `llms.txt`: point at `/uatu/api/*` and delete the "Release channels" block advertising `/api/latest/` and `/api/revisions/`

## 3. Delete the release-publication machinery

- [x] 3.1 Delete `.github/workflows/api-release.yml` and `.github/workflows/api-release-retry.yml`
- [x] 3.2 Delete `scripts/api-contract/publish.ts`, `scripts/api-contract/publication.test.ts`, and `scripts/api-contract/release-bundle.ts`
- [x] 3.3 Confirm no orphan imports remain (`grep -rn "publish\|release-bundle" scripts/api-contract/`); `compatibility.ts` and `structural.ts` must survive untouched, since `ci.yml` still invokes both

## 4. Enforce the new workflow shape in tests

- [x] 4.1 Trim `scripts/api-contract/workflows.test.ts` to the assertions that still hold: every non-local `uses:` pinned to a 40-character SHA, workflow-level `permissions` granting no write scopes, and `persist-credentials: false` on every checkout — dropping the `pushesBack` exemption, since no checkout pushes anymore
- [x] 4.2 Delete the assertions covering `pages-history`, the staleness guard, the retry workflow, the shared `github-pages` concurrency groups, the `workflow_run` fork-lookalike guards, and the release-site selection logic
- [x] 4.3 Add a test enforcing the new `security-posture` requirement: no workflow in `.github/workflows/` declares `workflow_run` or `pull_request_target`, and no `actions/checkout` step has a `ref:` containing `github.event.`
- [x] 4.4 Keep the `test:api` coverage assertion, updating it if it names a deleted path

## 5. Update the publication documentation

- [x] 5.1 Rewrite `docs/API-PUBLICATION.md`: the published URLs, the single build-and-deploy path, and the one repository setting required. Delete the `pages-history`, first-release, and rollback/recovery sections

## 6. Verify

- [x] 6.1 Run `bun test` and confirm the unit suite passes
- [x] 6.2 Run `bunx astro build --root site && bun run site:check`, then confirm `site/dist/api/` holds the nine artifacts with no `edge/` subdirectory and that `site/dist/llms.txt` links resolve
- [x] 6.3 Run `bunx @fission-ai/openspec validate --all --strict`
- [x] 6.4 Confirm `grep -rn "workflow_run\|pull_request_target" .github/workflows/` returns nothing

## Post-merge (not in-branch work)

The change cannot deploy until GitHub Pages is enabled: **Settings → Pages → Build and deployment → Source = GitHub Actions**. Until then `pages.yml` fails at `configure-pages`, which is the intended loud failure. Enabling Pages auto-creates the `github-pages` environment; no orphan branch, branch protection, or pre-provisioned environment is needed.

After enabling, dispatch the `Pages` workflow on `main` and verify `https://tjakobsson.github.io/uatu/` and `https://tjakobsson.github.io/uatu/api/openapi.yaml`. Then confirm the next Scorecard run on `main` reports `Dangerous-Workflow: 10` and the aggregate returns to 8.1.

**Release notes**: the API publication feature is unreleased — latest stable is `v0.5.1` and the `0.6.0` Release Please PR is still open — so this correction must not surface as its own changelog entry. The PR keeps a truthful title and carries a Release Please override in its body so the `0.6.0` notes describe the feature as it finally ships. If the override is added after merge, rerun the Release Please workflow so it rereads the merged body.
