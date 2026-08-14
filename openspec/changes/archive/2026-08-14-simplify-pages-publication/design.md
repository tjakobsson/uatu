## Context

See `proposal.md` — Why. Three facts shape the approach:

1. **`bunx astro build --root site` already emits the complete deliverable.** `site/dist` contains `index.html`, `docs/guides/*` (seven guides), `docs/api/index.html`, `llms.txt`, `fonts/`, and every machine-readable contract artifact. Nothing needs to be assembled on top of it. The `astro:build:done` hook in `site/astro.config.mjs` calls `assembleEdgeArtifacts()`, which writes the raw artifacts, injects `sourceCommit` from `GITHUB_SHA`, and copies `llms.txt` and the Hack font.
2. **Nothing has ever been deployed.** `GET /repos/tjakobsson/uatu/pages` returns 404, `/environments` returns `total_count: 0`, `/deployments` returns 0. No published URL can break, which is why the `/api/edge/` → `/api/` move is free now and would not be later.
3. **The `/api/edge/` references are enumerable.** Eight assertions in `site/site.test.ts`, three `sitePath()` calls across `site/src/`, one prefix in `site/src/lib/guides.ts`, four links in `api/agent.md`, and `llms.txt`. `scripts/generate-formula.test.ts` and `scripts/generate-cask.test.ts` also match `/edge/`, but those are the Homebrew edge *release channel* and must not be touched.

## Goals / Non-Goals

**Goals:**

- One workflow, self-contained: validate → build → check → deploy.
- Bootstrapping reduces to a single repository setting.
- Zero `workflow_run` triggers repository-wide.
- Every contract *quality* gate in CI survives untouched.

**Non-Goals:**

- Deriving `latest`/`revisions` from published GitHub Releases. This was the previously-explored alternative to the `pages-history` branch; it preserves the three-channel surface without shared mutable state. It is deliberately not built, because the channels have no consumer. Recorded here so the option is not rediscovered from scratch — see the removed requirement's **Migration** note.
- Changing what the contract *contains*. `hubApiRevision` / `workspaceApiRevision` stay in `contract.json` as product metadata; only the published snapshot directories keyed by them go away.
- Touching `release.yml`, the Homebrew edge channel, or `src/shared/api-revisions.ts`.

## Decisions

### The publishing workflow validates its own input rather than consuming another run's attested artifact

The old design proved "Pages reflects validated sources" by downloading a CI artifact by `run-id` and verifying `contract.json.sourceCommit` matched `workflow_run.head_sha`. That cross-run attestation is precisely what required the `workflow_run` trigger.

The new `pages.yml` runs `bun run api:validate`, `bun run scripts/api-contract/structural.ts`, builds, then `bun run site:check` — all in one run, on one checkout. Same guarantee, no privilege hop, and the deployed bytes are the bytes that were just checked.

*Alternative considered:* make the deploy a gated job inside `ci.yml` (`if: github.event_name == 'push' && github.ref == 'refs/heads/main'`, `needs: contract-integration`). This also removes `workflow_run` and avoids rebuilding the site. Rejected: it entangles publication with a 30-minute validation workflow that also runs Playwright on fork PRs, and it means every CI re-run redeploys. A standalone ~35-line workflow is easier to read, re-run, and reason about. The duplicated build costs roughly a minute.

*Note:* the heavy suites (`test:api`, e2e, license audit, build) stay in `ci.yml` only. They gate merges to `main`; they are not preconditions for rendering documentation that is already on `main`.

### `cancel-in-progress: true` is now correct

Every deployment is the complete build output of one commit with no carried-over state, so a superseded run loses nothing — the newer run publishes a strictly newer complete site. Under the old design the same setting would have been a data-loss bug, which is why `github-pages` was a non-cancelling group shared across two workflows. That whole apparatus goes.

### `/api/edge/` → `/api/` is a single-source change

`assembleEdgeArtifacts()` writes to `join(outputPath, "api", "edge")`. Dropping the `"edge"` segment is the only functional edit; everything else is a link or an assertion following it. The function and its export are renamed to drop `Edge` from the name so the code stops describing a channel that no longer exists.

### Removal is verified by a test, not by inspection

`scripts/api-contract/workflows.test.ts` shrinks but does not disappear. It keeps the assertions that still hold repository-wide — every action pinned to a 40-character SHA, workflow-level `permissions` granting no write scopes, `persist-credentials: false` on every checkout — and gains one that enforces the new `security-posture` requirement: **no workflow declares `workflow_run` or `pull_request_target`, and no checkout step's `ref` references event payload data.** That test is what makes the Scorecard fix durable rather than incidental.

The `persist-credentials` assertion loses its `pushesBack` exemption: with `pages-history` gone, no checkout in the repository pushes back, so the rule becomes unconditional.

### Deletion boundary

`release-bundle.ts` is reachable only from `publish.ts`, `publication.test.ts`, and `api-release.yml`; all four are removed together with no orphan imports. `compatibility.ts` is imported by `publish.ts` (for `revisions()`) **and** by `ci.yml`'s compatibility gate — it stays.

## Risks / Trade-offs

- **Publication is no longer gated on the full CI suite.** A commit whose e2e tests fail can still publish documentation. → Acceptable and arguably correct: the contract validation that governs the published artifacts runs in the publishing workflow itself, and the branch ruleset already requires CI `validate` to pass before anything reaches `main`.
- **The site rebuilds on every push to `main`, including docs-only and unrelated changes.** → ~1 minute of runner time. `ci.yml`'s change-classification logic could be borrowed later if it becomes noise; not worth the complexity now.
- **Losing immutable revision snapshots removes a future compatibility-analysis affordance.** → No consumer exists, `contract.json` still reports the revision pair, and the Non-Goals note records how to reintroduce channels without shared mutable state.
- **Dropping the `uatu-api-contract-v*.tar.gz` release asset.** → It has never been produced (the workflow that creates it has never succeeded), so no release loses an asset it previously had. Scorecard's `Signed-Releases` is unaffected — it counts attested binaries, which `release.yml` still produces.
- **A stale `pages-edge-*` artifact and the exhausted retry budget.** → Both disappear with the workflows that created them. No cleanup needed beyond deleting the files.

## Migration Plan

1. Land the change. `pages.yml` will not deploy successfully until step 2 — the workflow will fail at `configure-pages`, which is the correct loud failure.
2. Enable **Settings → Pages → Build and deployment → Source = GitHub Actions**. This auto-creates the `github-pages` environment.
3. Re-run the `Pages` workflow on `main` (`workflow_dispatch`), then verify `https://tjakobsson.github.io/uatu/` and `https://tjakobsson.github.io/uatu/api/openapi.yaml`.
4. Confirm the next Scorecard run reports `Dangerous-Workflow: 10`.

No `pages-history` branch is created at any point. There is nothing to roll back to, because nothing was ever published; rollback is redeploying an earlier commit via `workflow_dispatch`.

## Open Questions

None. The two scope decisions — `/api/` over `/api/edge/`, and dropping the release bundle asset — were settled before planning.
