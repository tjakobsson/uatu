## Context

uatu currently releases from a manually pushed `v*` tag. The tag workflow validates `package.json`, builds and smoke-tests four binaries, creates the GitHub Release, attests and uploads assets, then updates the Homebrew tap. Version selection, the package bump, tag creation, and release-note quality remain manual.

Release Please can own version selection, `package.json`, `CHANGELOG.md`, the release PR, tag, and GitHub Release. Two constraints shape the integration:

- Resources created with the default `GITHUB_TOKEN` do not trigger subsequent workflow runs, including validation on a generated release PR and the existing tag workflow.
- Release Please creates the tag and GitHub Release before downstream binary publication, so failed publication must not expose a release as complete.

The published baseline is `v0.1.1`. The current changelog predates the release pipeline and contains one large, stale `Unreleased` section rather than trustworthy release boundaries.

## Goals / Non-Goals

**Goals:**

- Derive release versions and user-facing notes from Conventional Commits.
- Put every version bump and changelog update through a normal reviewed release PR.
- Preserve the existing reproducible binary, smoke, checksum, attestation, and Homebrew guarantees.
- Keep failed or incomplete releases out of the public release list.
- Make both everyday contribution practices and release operations discoverable to humans.

**Non-Goals:**

- Publish uatu to npm.
- Maintain prerelease, nightly, or multiple release branches.
- Reconstruct a complete historical changelog from every pre-`v0.1.1` commit.
- Move detailed contributor process into the user-facing README.

## Decisions

### Use the Node strategy in manifest mode

Release Please will use its `node` strategy because `package.json` is uatu's version source even though Bun is the runtime. A root `release-please-config.json` and `.release-please-manifest.json` will initialize the component at `0.1.1`, use `v`-prefixed tags, and define changelog sections that include user-facing `feat`, `fix`, and `perf` entries while omitting routine `chore`, `ci`, `test`, and internal documentation work.

Manifest mode makes the baseline and changelog policy explicit and reviewable. Simple action inputs were considered but provide less durable configuration and are harder to extend safely.

### Keep the latest released version on main between releases

After `v0.1.1`, `package.json` remains `0.1.1` while ordinary development commits accumulate. The open release PR represents the proposed next version. This avoids prematurely guessing patch versus minor and matches the existing distinction between release identifiers (`vX.Y.Z · sha`) and development identifiers (`branch@sha`).

### Use a dedicated fine-grained Release Please token

The Release Please action will use a repository-scoped secret named `RELEASE_PLEASE_TOKEN`, with only the repository contents, pull-request, and issue permissions needed to create and label release PRs, tags, and releases. Unlike the default `GITHUB_TOKEN`, events created with this token trigger required PR validation and the tag-driven distribution workflow.

The action reference will be pinned to an immutable commit SHA and maintained by Renovate, consistent with the repository's workflow policy. Reusing `HOMEBREW_TAP_TOKEN` is rejected because it is intentionally scoped to a different repository.

### Separate release orchestration from artifact publication

A Release Please workflow runs on pushes to `main`. It creates or updates the release PR. When that PR is merged, it creates the version tag and a draft GitHub Release.

The existing `v*` tag workflow remains the artifact-publication boundary. Because Release Please uses the dedicated token, its tag triggers this workflow normally. The publication workflow validates tag/package agreement, builds, smoke-tests, packages, attests, uploads assets to the existing draft release, and only then publishes the draft. The Homebrew job runs after publication.

This separation keeps expensive builds conditional on an actual release and makes publication independently rerunnable. Combining everything behind `release_created` output in the Release Please workflow was considered, but rerunning after a partial failure is awkward because Release Please may no longer emit `release_created` once the tag/release exists.

### Bootstrap rather than reconstruct the changelog

`CHANGELOG.md` will be replaced with a concise curated baseline containing released `0.1.0` and `0.1.1` sections and comparison links. The manifest starts at `0.1.1`, so Release Please only generates entries from commits after that tag. The old pre-release development diary will not be represented as pending future work.

### Split contributor guidance from the release runbook

`CONTRIBUTING.md` will document setup, branches and PRs, squash-merge Conventional Commit expectations, OpenSpec usage, and validation. `docs/RELEASING.md` will document version semantics, release-note inclusion rules, the Release Please lifecycle, required secret/settings, verification, reruns, and recovery from draft release or tap failures. README remains focused on users and links to the contributor guide.

## Risks / Trade-offs

- [A fine-grained token is an additional credential] -> Scope it to this repository and only required permissions; document rotation and failure symptoms.
- [Release Please creates a tag before artifact validation] -> Create a draft release and publish it only after artifact validation succeeds; document tag/draft cleanup for irrecoverable failures.
- [A malformed squash title produces a wrong bump or changelog entry] -> Document and enforce Conventional Commit PR titles through review and, if practical, automated title validation.
- [Historical changelog detail is discarded] -> Preserve detailed history in Git commits, merged PRs, and archived OpenSpec artifacts while keeping the public changelog concise.
- [Two workflows require token-trigger behavior to remain configured] -> Document the token requirement and add workflow-level tests/static validation for the release wiring.

## Migration Plan

1. Curate `CHANGELOG.md` through `v0.1.1` and add Release Please configuration initialized at `0.1.1`.
2. Add contributor and release-runbook documentation, including repository setting and secret prerequisites.
3. Add the pinned Release Please workflow and adapt the tag workflow to upload to and publish its draft release.
4. Configure `RELEASE_PLEASE_TOKEN` and ensure GitHub Actions may create pull requests before merging the change.
5. Merge the adoption PR and verify Release Please either opens no release PR until a releasable commit exists or opens one containing only post-`v0.1.1` work.
6. Use the next release PR as the end-to-end production verification; retain the prior manual process in git history for rollback.

## Open Questions

- Whether to add an automated Conventional Commit title check in this change or rely on documented review initially.
- Whether `docs` changes should ever appear in public release notes; default policy is to omit them unless deliberately represented as a user-facing `fix` or `feat`.
