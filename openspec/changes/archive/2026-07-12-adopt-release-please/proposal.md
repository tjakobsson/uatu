## Why

The current release process requires a maintainer to bump `package.json` directly on `main`, push a matching tag, and rely on GitHub's generic generated notes, while the hand-maintained `CHANGELOG.md` has drifted out of phase with published releases. This does not fit protected-branch workflows and obscures user-facing changes among repository maintenance.

## What Changes

- Adopt Release Please to derive the next semantic version and user-facing changelog entries from Conventional Commits.
- Have Release Please maintain a reviewable release PR that updates `package.json` and `CHANGELOG.md`; merging that PR creates the version tag and GitHub Release.
- Adapt the existing binary build, smoke test, provenance attestation, asset upload, and Homebrew tap update to publish into the Release Please-created release without relying on a second workflow being triggered by its tag.
- Bootstrap Release Please at the published `v0.1.1` baseline and replace the stale pre-release changelog content with concise historical `0.1.0` and `0.1.1` entries.
- Add canonical contributor documentation for everyday branch, PR, Conventional Commit, OpenSpec, and validation practices.
- Add a maintainer release runbook covering version semantics, the release PR lifecycle, verification, and failure recovery.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `release-distribution`: Replace manually pushed release tags and generic generated notes with a Release Please-managed release PR, changelog, tag, and GitHub Release while preserving the existing binary and Homebrew publication guarantees.
- `repository-workflows`: Move canonical contributor workflow guidance out of the user-facing README and require dedicated contributor and release-runbook documentation.

## Impact

- GitHub Actions release workflow and permissions.
- New Release Please configuration and version manifest files.
- `CHANGELOG.md`, `CONTRIBUTING.md`, and `docs/RELEASING.md`.
- Release ownership for `package.json`, version tags, and GitHub Releases.
- Maintainer workflow and Conventional Commit discipline; no end-user CLI or runtime behavior changes.
