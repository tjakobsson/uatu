# API contract publication

The public documentation root is <https://tjakobsson.github.io/uatu/>. Raw contract channels are:

- `https://tjakobsson.github.io/uatu/api/edge/` for the validated `main` commit
- `https://tjakobsson.github.io/uatu/api/latest/` for the latest released bundle
- `https://tjakobsson.github.io/uatu/api/revisions/hub-N_workspace-M/` for an immutable revision pair

Each channel contains `contract.json`, `openapi.yaml`, `streaming.yaml`, `agent.md`, `CHANGELOG.md`, and release channels also contain `SHA256SUMS.json`. Consumers should read `contract.json` first, compare both domain revisions, then follow migration guidance in the API changelog.

## Repository settings

Configure **Settings > Pages > Build and deployment > Source** to **GitHub Actions**. The `github-pages` environment may require reviewer approval. Do not grant repository-wide workflow write permissions: the workflows declare empty top-level permissions, and only deployment jobs receive `pages: write` and `id-token: write`.

Create an orphan `pages-history` branch before the first deployment with empty `api/latest/` and `api/revisions/` directories retained by placeholder files. Protect the branch from force pushes and deletion. It is publication input, not the Pages source; GitHub Actions deploys the assembled artifact.

## Publication paths

Successful CI on `main` uploads an exact, short-lived site artifact named for the validated source commit. `.github/workflows/pages.yml` downloads that artifact by workflow run, verifies `api/edge/contract.json` names the same full commit SHA, restores `latest` and revision history byte-for-byte, and deploys. The edge path cannot initialize or advance `latest`.

A `v*` tag runs `.github/workflows/api-release.yml`. It validates the tagged source, creates a release bundle, attaches the bundle to the GitHub Release, creates `api/revisions/hub-N_workspace-M/` if it does not already exist, and atomically replaces `api/latest/` with that same bundle. An existing revision pair with different bytes is rejected.

The release workflow persists the assembled output to `pages-history` before deployment. Protect that environment and branch so this tagged release path is the only automated writer. Never regenerate old revision directories from current source.

## First release

1. Confirm CI and the edge Pages deployment pass for the release commit.
2. Confirm the `pages-history` branch exists and has no released revision yet.
3. Push the release tag and verify the attached `uatu-api-contract-v*.tar.gz` hashes and `sourceCommit`.
4. Verify `/api/latest/contract.json` and the new immutable revision metadata name the tagged commit.
5. Record the deployed `api/latest/` and `api/revisions/` directories on `pages-history`.

## Rollback and recovery

Rollback redeploys a known-good assembled Pages artifact; it does not delete revision history. If an artifact is no longer retained, reconstruct the site shell from its source commit, restore every immutable directory from the contract bundles attached to GitHub Releases, select the intended known-good bundle for `api/latest/`, and run the publication dry-run tests before deployment. Keep the revision directory name derived from the bundle's Hub/workspace pair and verify `SHA256SUMS.json` before restoring it.
