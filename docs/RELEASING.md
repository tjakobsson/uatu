# Releasing uatu

This is the maintainer runbook for preparing, publishing, verifying, and
recovering uatu releases. Contributor conventions that feed this process live
in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Version semantics

`package.json` contains the latest published version between releases. It does
not predict the next version while development is in progress. Development
builds identify themselves as `<branch>@<sha>`; released binaries identify
themselves as `v<version> · <sha>`.

Release Please derives the next version from squash-merged Conventional
Commits after the latest version tag:

| Commit | Result |
| --- | --- |
| `fix` or `perf` | Patch release |
| `feat` | Minor release |
| `!` or `BREAKING CHANGE:` | Major release |
| `chore`, `ci`, `test`, `build`, `refactor`, `docs` | No release by itself |

Only Features, Bug Fixes, and Performance are visible in public release notes
by default. Routine dependency, CI, test, documentation, and repository
maintenance remain in git history without clouding the user-facing changelog.
Use a `Release-As: X.Y.Z` commit footer only when intentionally overriding the
derived version.

## Repository prerequisites

Release Please uses the `RELEASE_PLEASE_TOKEN` Actions secret. It must be a
fine-grained personal access token restricted to `tjakobsson/uatu` with:

- Contents: read and write
- Issues: read and write
- Pull requests: read and write

This dedicated token is required because pull requests and tags created with
the default `GITHUB_TOKEN` do not trigger downstream Actions workflows. Do not
reuse `HOMEBREW_TAP_TOKEN`; that credential is deliberately restricted to the
tap repository.

Under repository **Settings → Actions → General → Workflow permissions**,
allow GitHub Actions to create pull requests. Branch protection on `main`
should require the normal CI checks on the generated release PR.

## Release lifecycle

1. User-facing Conventional Commits land on `main` through squash-merged PRs.
2. `.github/workflows/release-please.yml` creates or updates the release PR.
3. Review the proposed `package.json` version and `CHANGELOG.md`; wait for all
   required checks.
4. Merge the release PR when its contents represent the intended release.
5. Release Please creates `vX.Y.Z` and a draft GitHub Release.
6. The tag triggers `.github/workflows/release.yml`, which validates that the
   tag matches `package.json`, cross-compiles four binaries, smoke-tests the
   linux-x64 artifact, verifies its version, packages archives, writes
   `SHA256SUMS`, and creates provenance attestations.
7. The workflow uploads all assets and publishes the draft release.
8. The dependent tap job regenerates and pushes `Formula/uatu.rb` using
   `HOMEBREW_TAP_TOKEN`.

Do not manually bump `package.json`, manually maintain future changelog
sections, or manually create the normal release tag.

### First activation check

After the Release Please adoption change merges, inspect its first workflow run
and generated release PR. Confirm it considers only commits after `v0.1.1`,
proposes the expected semantic version and changelog entries, and receives the
same required CI checks as an ordinary pull request.

## Verification

After publication:

```bash
gh release view vX.Y.Z
gh release download vX.Y.Z --pattern SHA256SUMS
brew update
brew upgrade uatu
uatu --version
```

Verify that:

- Four platform archives and `SHA256SUMS` are attached.
- The release is public rather than draft.
- The release notes contain user-facing changes without routine chores.
- `gh attestation verify <archive> --repo tjakobsson/uatu` succeeds.
- `tjakobsson/homebrew-tap` contains the matching formula version and hashes.
- `brew test uatu` succeeds where Homebrew verification is available.

## Failure recovery

### Release Please workflow fails

Check that `RELEASE_PLEASE_TOKEN` exists, has not expired, has the documented
repository permissions, and that Actions may create pull requests. Correct the
credential or setting, then rerun the failed workflow.

### Release PR has the wrong version or notes

Do not hand-edit generated version metadata as the primary fix. Correct the
offending squash commit through Release Please's documented commit override,
or add a deliberate `Release-As: X.Y.Z` commit when the version itself must be
forced, then rerun Release Please. Confirm the manifest remains aligned with
the latest published tag.

### Artifact publication fails while the release is a draft

The draft is intentionally not public. Fix transient infrastructure or code
issues and rerun the failed tag workflow; uploads use `--clobber`, so reruns
replace partial assets safely. If the tagged source itself is invalid, delete
the draft release and tag, fix the problem through a normal PR, and let Release
Please create a corrected release. Never move an already published version
tag to different source.

### Homebrew tap update fails

The GitHub Release remains valid. Fix `HOMEBREW_TAP_TOKEN` or the tap issue and
rerun the failed `update-tap` job. It downloads `SHA256SUMS` from the published
release and is idempotent.

### A published artifact is invalid

Do not replace assets silently or retarget the version tag. Publish a new patch
release through the normal release PR lifecycle and document the correction.
