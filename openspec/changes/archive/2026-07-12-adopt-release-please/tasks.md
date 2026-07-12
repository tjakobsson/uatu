## 1. Release Please Baseline

- [x] 1.1 Add `release-please-config.json` for a root Node-strategy component with `v`-prefixed tags, draft releases, and user-facing changelog sections.
- [x] 1.2 Add `.release-please-manifest.json` initialized to the published `0.1.1` version.
- [x] 1.3 Replace the stale changelog with a concise released baseline for `0.1.0` and `0.1.1`, including stable comparison links for future generated sections.

## 2. Release Automation

- [x] 2.1 Add a main-branch Release Please workflow using an immutable action SHA and the dedicated `RELEASE_PLEASE_TOKEN` secret.
- [x] 2.2 Adapt the tag-triggered publication workflow to upload assets to the matching draft release and publish it only after version validation, build, smoke test, packaging, and attestation succeed.
- [x] 2.3 Preserve the independently rerunnable post-publication Homebrew tap update and its separately scoped token.
- [x] 2.4 Add focused automated checks for the Release Please baseline, changelog policy, tag/package guard, draft publication gate, and workflow trigger wiring.

## 3. Maintainer Documentation

- [x] 3.1 Add `CONTRIBUTING.md` covering setup, branch and PR flow, squash-merge Conventional Commit titles, OpenSpec usage, and required validation.
- [x] 3.2 Add `docs/RELEASING.md` covering version semantics, release-note categories, token and repository prerequisites, the release PR lifecycle, verification, reruns, and failure recovery.
- [x] 3.3 Keep README user-focused while linking prospective contributors to `CONTRIBUTING.md`.

## 4. Verification And Activation

- [x] 4.1 Run workflow/config-focused tests, the unit suite, license audit, build, and strict OpenSpec validation.
- [x] 4.2 Before merge, configure the repository-scoped `RELEASE_PLEASE_TOKEN` secret and verify GitHub Actions is allowed to create pull requests.

Post-merge verification: confirm Release Please processes only commits after
`v0.1.1` and that the generated release PR has the expected version, changelog
content, and required CI checks. This operational check is documented in
`docs/RELEASING.md`; it is not an implementation task that can be completed in
the change itself.
