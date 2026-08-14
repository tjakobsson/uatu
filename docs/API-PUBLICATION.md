# API contract publication

The public documentation root is <https://tjakobsson.github.io/uatu/>. The machine-readable contract is served directly under `/api/`:

- `contract.json`, `contract.schema.json`, `openapi.yaml`, `streaming.yaml`, `operations.yaml`, `exclusions.yaml`, `agent.md`, `CHANGELOG.md`, and `SHA256SUMS.json`

Consumers should read `contract.json` first — it reports the API revision pair, stability, and the `sourceCommit` it was built from — then follow migration guidance in the API changelog. `llms.txt` at the site root links every artifact.

## How it publishes

`.github/workflows/pages.yml` runs on every push to `main` (and on `workflow_dispatch`). It validates the contract, builds the site with Astro, checks the built output's content and links, and deploys `site/dist` to GitHub Pages. There is exactly one publication path and one contract: the site is the complete build output of one commit, so no deployment depends on state left behind by an earlier one.

Releases do not publish contract channels. `release.yml` is unaffected by this workflow.

## Repository settings

Configure **Settings > Pages > Build and deployment > Source** to **GitHub Actions**. This is the only prerequisite; it also creates the `github-pages` environment the deploy job targets. Until it is set, the workflow fails at the `Configure Pages` step.

Do not grant repository-wide workflow write permissions: the workflow declares empty top-level permissions and grants `pages: write` and `id-token: write` to the deploy job alone. `scripts/api-contract/workflows.test.ts` enforces that, along with the rule that no workflow may check out a ref derived from event payload data.

## Recovery

Redeploy by dispatching the `Pages` workflow on `main`. The deploy job is guarded to `refs/heads/main` and skips on any other ref, so an unmerged branch cannot be published: `contract-fast` and `contract-integration` gate at the merge layer, and a branch that never merged has never had to pass them.

Because every deployment rebuilds the whole site from source, there is no publication history to repair and no rollback state to restore. To roll back, revert on `main` — the next deployment reflects it.
