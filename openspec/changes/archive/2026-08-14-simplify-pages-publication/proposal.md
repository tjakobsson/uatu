## Why

The API publication pipeline shipped in #240 was built to serve three contract channels — `edge`, `latest`, and immutable per-release revisions — from one atomically-deployed GitHub Pages site. Two independent writers (every push to `main`, every `v*` tag) sharing one whole-site deploy forced a `pages-history` branch as shared mutable state, and everything downstream of that: cross-workflow concurrency locks, byte-hash immutability guards, a staleness guard, an attempt-bounded retry workflow, and two `workflow_run` privilege hops.

It has never successfully published. Pages was never enabled, the `pages-history` branch was never created, and the `github-pages` environment does not exist, so every edge publication fails at an opaque `git failed with exit code 1` — five times per push, once the retry budget is spent. The two `workflow_run` hops also scored OpenSSF Scorecard's `Dangerous-Workflow` check at 0, dropping the published score from 8.1 to 7.1 for a supply-chain risk the project does not actually carry.

The intended deliverable is narrower than what was built: a documentation site an LLM can fetch. `bunx astro build --root site` already produces that site in full — homepage, seven guides, API reference, `llms.txt`, and every machine-readable contract artifact. All 1037 lines of publication machinery exist only to decorate that directory with release history before uploading it.

## What Changes

- **BREAKING** (unreleased): Remove the `latest` and immutable revision channels. The site publishes one contract, built from `main`, with no release-derived history. These paths have never been deployed and have no consumers.
- **BREAKING** (unreleased): Move raw contract artifacts from `/api/edge/*` to `/api/*`. With one channel, `edge` names a distinction that no longer exists, and `/uatu/api/openapi.yaml` is the URL to hand an agent.
- Replace `pages.yml` with a single self-contained workflow triggered by `push` to `main`: validate the contract, build the site, check the built output, deploy it. No `workflow_run`, no cross-run artifact handoff, no shared mutable state.
- Delete `api-release.yml`, `api-release-retry.yml`, `scripts/api-contract/publish.ts`, `scripts/api-contract/release-bundle.ts`, and their tests. Drop the `uatu-api-contract-v*.tar.gz` release asset that only the deleted workflow produced.
- Remove the `pages-history` branch requirement entirely, along with the immutability, rollback, and staleness guards that defended it. Bootstrapping reduces to one repository setting.
- Retain every contract *quality* gate in CI unchanged: `validate-api.ts`, `api:lint`, `structural.ts`, `compatibility.ts`, route coverage, and `test:api`. This change removes delivery apparatus, not verification.
- Lock the `workflow_run` removal into the security posture spec so a future pipeline cannot silently reintroduce the pattern.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `api-contract-publication`: Remove the requirement for edge/latest/immutable-revision identities. Change the published artifact paths from `/api/edge/*` to `/api/*`. Change how publication is gated on validation — the publishing workflow validates the contract it builds, rather than consuming an artifact attested by a separate validated run.
- `security-posture`: Add a requirement that no workflow checks out a ref derived from event data under a privileged trigger, so the `Dangerous-Workflow` regression cannot recur.

## Impact

**Deleted** (~1037 lines → ~80):

- `.github/workflows/api-release.yml` (232), `.github/workflows/api-release-retry.yml` (51)
- `scripts/api-contract/publish.ts` (198), `scripts/api-contract/publication.test.ts` (155), `scripts/api-contract/release-bundle.ts` (48)

**Rewritten:**

- `.github/workflows/pages.yml` (106 → ~35), `scripts/api-contract/workflows.test.ts` (212 → ~40), `docs/API-PUBLICATION.md` (35 → ~12)

**Path updates** for `/api/edge/` → `/api/`: `scripts/assemble-api-site.ts`, `site/site.test.ts`, `site/src/pages/index.astro`, `site/src/pages/docs/api/index.astro`, `site/src/layouts/SiteLayout.astro`, `site/src/lib/guides.ts`, `api/agent.md`, `llms.txt`.

`llms.txt` and `api/agent.md` additionally drop their `latest` and `revisions` guidance, which describes channels that will now never exist.

**`ci.yml`**: drop the `Upload exact validated edge site` step — nothing consumes the artifact by run-id anymore.

**Unaffected**: `scripts/api-contract/compatibility.ts`, `structural.ts`, `scripts/validate-api.ts`, `api/contract.test.ts`, `api/route-coverage.test.ts`, `src/shared/api-revisions.ts`. Contract revision numbers stay in `contract.json` as product metadata; only the *published snapshot directories* keyed by them go away. `release.yml` is untouched.

**Repository settings**: enable Settings → Pages → Source = GitHub Actions. This is the only remaining manual prerequisite; the orphan branch, its protection rules, and the pre-provisioned environment are all no longer needed.

**Scorecard**: zero `workflow_run` triggers remain in the repository, so `Dangerous-Workflow` cannot fire — 0 → 10, aggregate 7.1 → 8.1.

**Release notes**: the publication feature is unreleased (latest stable is `v0.5.1`; the `0.6.0` Release Please PR is still open), so this needs a Release Please override in the PR body rather than a visible `refactor` entry — the changelog should describe the feature as it finally ships.
