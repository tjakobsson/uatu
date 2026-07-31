# release-distribution Specification

## Purpose
Define how uatu is released and distributed: a tag-triggered GitHub release pipeline that cross-compiles the CLI for macOS and Linux, publishes verifiable archives with a stable naming contract, smoke-tests before publishing, keeps a Homebrew tap formula current automatically, and documents installation in the README.
## Requirements
### Requirement: Release Please maintains a reviewable release proposal
The repository SHALL use Release Please with the Node release strategy and a version manifest initialized to the latest published release. Release Please SHALL derive the next semantic version and user-facing changelog entries from Conventional Commits merged after the latest release tag, and SHALL maintain a release pull request that updates `package.json` and `CHANGELOG.md`. Routine maintenance commit types such as `chore`, `ci`, and `test` MUST NOT appear as user-facing changelog entries by default. Between releases, `package.json` on the main branch SHALL continue to identify the latest released version until the release pull request is merged.

#### Scenario: A user-facing fix lands after the latest release
- **WHEN** a `fix` Conventional Commit is merged to the main branch after the latest release tag
- **THEN** Release Please creates or updates a release pull request proposing at least a patch version increment
- **AND** the release pull request includes the fix in `CHANGELOG.md`

#### Scenario: Maintenance-only commits land after the latest release
- **WHEN** only non-releasable maintenance commits such as `chore`, `ci`, or `test` have landed since the latest release tag
- **THEN** those commits do not independently require a release
- **AND** they are omitted from user-facing changelog sections by default

#### Scenario: Development continues before the release pull request is merged
- **WHEN** unreleased commits exist on the main branch
- **THEN** `package.json` continues to contain the latest published version
- **AND** development builds remain distinguishable by their branch and commit identifier

### Requirement: Release automation uses a credential that preserves downstream workflows
Release Please SHALL authenticate with a dedicated repository-scoped credential whose events can trigger required pull-request validation and tag workflows. The credential MUST be limited to the repository and permissions needed to manage release pull requests, tags, labels, and GitHub Releases. The Release Please action MUST be pinned to an immutable commit reference.

#### Scenario: Release Please opens or updates a release pull request
- **WHEN** Release Please creates or updates its release pull request
- **THEN** the repository's required pull-request validation workflows run normally
- **AND** branch protection can require those checks before merge

#### Scenario: Release Please creates a version tag
- **WHEN** a release pull request is merged and Release Please creates its version tag
- **THEN** the tag event triggers the artifact-publication workflow

### Requirement: A version tag produces a GitHub Release with cross-compiled binaries
The repository SHALL define Release Please automation that creates a `v*` version tag and draft GitHub Release when a release pull request is merged. A tag-triggered publication workflow MUST cross-compile the CLI from a single Linux runner for exactly four targets — `bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`, `bun-linux-arm64` — via `bun build --compile --target=...`, and MUST upload the four platform archives to the matching draft GitHub Release before publishing it. The publication workflow MUST fail before building if the pushed tag does not equal `v` followed by the `version` field in `package.json`. The workflows MUST use a pinned Bun version and pinned GitHub Action references, and MUST declare only the permissions each job needs.

#### Scenario: Merging a release pull request publishes a release
- **WHEN** a validated Release Please release pull request is merged
- **THEN** Release Please creates the matching version tag and draft GitHub Release
- **AND** the tag triggers a workflow that builds all four target binaries on one Linux runner
- **AND** the draft is published only after the release assets and integrity artifacts are ready

#### Scenario: A tag that disagrees with package.json fails fast
- **WHEN** a tag `v0.2.0` is pushed while `package.json` declares another version
- **THEN** the publication workflow fails before compiling any binaries
- **AND** no incomplete draft release is published

### Requirement: Release assets follow a stable naming and layout contract
Release archives SHALL be named `uatu-darwin-arm64.zip`, `uatu-darwin-x64.zip`, `uatu-linux-x64.tar.gz`, and `uatu-linux-arm64.tar.gz` — zip for darwin targets, tar.gz for linux targets. Each archive MUST contain exactly one entry: an executable named `uatu` at the archive root, with no wrapping directory. This contract is load-bearing for the Homebrew formula and future installers; renaming assets or restructuring archives is a breaking change to distribution.

#### Scenario: An installer extracts a binary from any asset
- **WHEN** any of the four release archives is downloaded and extracted
- **THEN** extraction yields a single executable file named `uatu` in the extraction directory
- **AND** no intermediate directory is created

### Requirement: The build script supports cross-compilation targets
`scripts/build.ts` SHALL accept an optional target argument selecting a Bun compile target (e.g. `--target=bun-darwin-arm64`) and an optional output path. When invoked without arguments its behavior MUST remain a host-platform build to `dist/uatu`. Compiled binaries MUST embed the same build info (version and git commit) regardless of target.

#### Scenario: Cross-compiling a single target
- **WHEN** the build script is invoked with `--target=bun-darwin-arm64`
- **THEN** it produces a darwin-arm64 binary with version and commit build info embedded

#### Scenario: Default invocation is unchanged
- **WHEN** the build script is invoked with no arguments
- **THEN** it builds for the host platform to `dist/uatu`, as before

### Requirement: Releases ship verifiable integrity artifacts
The release workflow SHALL upload a `SHA256SUMS` file covering all four archives as a release asset, and SHALL generate GitHub build-provenance attestations (via `actions/attest-build-provenance`) for all four archives, such that `gh attestation verify <asset> --repo tjakobsson/uatu` succeeds for every published archive. The workflow SHALL additionally publish each archive's provenance as a Sigstore bundle release asset (`<asset>.sigstore.json`, retrieved via `gh attestation download`), so provenance is discoverable from the release page by third-party scanners and verifiable without GitHub-specific tooling.

#### Scenario: A user verifies a downloaded asset
- **WHEN** a user downloads `uatu-darwin-arm64.zip` from a release and runs `gh attestation verify uatu-darwin-arm64.zip --repo tjakobsson/uatu`
- **THEN** verification succeeds, attesting the asset was built by this repository's release workflow

#### Scenario: Checksums cover every archive
- **WHEN** a user downloads `SHA256SUMS` from a release
- **THEN** it contains a SHA-256 entry for each of the four platform archives
- **AND** each entry matches the corresponding published asset

#### Scenario: Provenance is discoverable as a release asset
- **WHEN** a user or scanner lists the assets of a published release
- **THEN** each platform archive has a corresponding `<asset>.sigstore.json` provenance bundle asset
- **AND** the bundle verifies against the archive using standard Sigstore tooling

### Requirement: A release is smoke-tested before it is published
The publication workflow SHALL execute the compiled linux-x64 binary via the repository's binary smoke test before publishing the draft GitHub Release. A smoke failure MUST prevent the draft from being published and MUST prevent all asset publication and Homebrew updates from being presented as a completed release.

#### Scenario: A broken binary blocks publication
- **WHEN** the linux-x64 binary fails the smoke test during a release run
- **THEN** the publication workflow fails
- **AND** the GitHub Release remains unpublished
- **AND** no Homebrew tap update is performed

### Requirement: uatu is installable and upgradable via a Homebrew tap
A Homebrew formula for uatu SHALL be published in the `tjakobsson/homebrew-tap` repository at `Formula/uatu.rb`, such that `brew install tjakobsson/tap/uatu` installs the released binary on macOS (arm64 and x64) and Linux (arm64 and x64). The formula MUST select the matching release asset per platform and architecture, MUST pin each asset's SHA-256 checksum, and MUST include a test block that verifies the installed binary reports its version.

#### Scenario: Installing via the tap
- **WHEN** a user on an Apple Silicon Mac runs `brew install tjakobsson/tap/uatu`
- **THEN** Homebrew downloads `uatu-darwin-arm64.zip` from the matching GitHub Release, verifies its checksum, and installs `uatu` onto the PATH

#### Scenario: The formula self-tests
- **WHEN** `brew test uatu` runs
- **THEN** the installed binary's `--version` output matches the formula version

### Requirement: Releases keep the Homebrew formula current automatically
The release workflow SHALL, after publishing the GitHub Release, update `Formula/uatu.rb` in the `tjakobsson/homebrew-tap` repository with the released version and the four asset checksums, using a fine-grained personal access token scoped to write access on the tap repository only, stored as a repository secret. A failure in the tap update MUST NOT retract or invalidate the already-published release, and the update MUST be safe to re-run independently from Release Please.

#### Scenario: A new release updates the tap
- **WHEN** the artifact-publication workflow publishes version `X.Y.Z`
- **THEN** the tap's `Formula/uatu.rb` is updated to version `X.Y.Z` with the four checksums from that release's `SHA256SUMS`
- **AND** `brew upgrade uatu` on a user machine installs `X.Y.Z`

#### Scenario: A failed tap update leaves the release intact
- **WHEN** the tap-update job fails after the GitHub Release is published
- **THEN** the release and its assets remain available
- **AND** re-running the tap update from the same release produces the correct formula

### Requirement: The README documents installation
The repository README SHALL document how to install uatu, listing Homebrew (`brew install tjakobsson/tap/uatu`) as the primary method and manual download from GitHub Releases as the secondary method. The manual-download instructions MUST note that macOS browser downloads are quarantined and give the remedy (`xattr -d com.apple.quarantine ./uatu` or approval via System Settings).

#### Scenario: A new user finds install instructions
- **WHEN** a user reads the README's install section
- **THEN** they find the Homebrew one-liner first and manual download instructions second
- **AND** the macOS quarantine workaround is documented alongside the manual method
