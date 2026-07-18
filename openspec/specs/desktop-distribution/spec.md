# desktop-distribution Specification

## Purpose

Define how UatuCode Desktop is built and shipped: where the app source lives in the uatu repository, how release builds produce per-architecture app archives embedding the matching `uatu` binary, how signing and notarization are gated on credential availability, how the Homebrew tap publishes a `uatu-desktop` cask for signed releases, and how desktop changes are validated in CI.

## Requirements

### Requirement: Desktop app source lives in-tree under desktop/macos
The UatuCode Desktop Xcode project and Swift sources SHALL live in the uatu
repository under `desktop/macos/`, using `UatuCodeDesktop` target/scheme names,
product name "UatuCode Desktop", and bundle identifier
`se.coll8.uatucode.desktop`. A local build MUST embed a `uatu` binary resolved
from a configurable location defaulting to the repo's `dist/uatu`, and MUST fail
with a clear message when no binary is present — the app has no PATH-installed
fallback.

#### Scenario: Local development build
- **WHEN** a developer runs `bun run build` and then builds the Xcode project
- **THEN** the resulting app bundle contains the freshly built `uatu` binary in its resources

#### Scenario: Missing binary fails the build
- **WHEN** the Xcode project is built with no `uatu` binary at the configured location
- **THEN** the build fails with a message telling the developer to build or point at one

### Requirement: Release workflow builds per-architecture desktop apps
The tag-triggered release workflow SHALL include a macOS job that builds the
desktop app twice — once per architecture (`arm64`, `x64`) — each embedding the
matching `uatu-darwin-<arch>` binary produced earlier in the same workflow run.
App archives SHALL be zips named `UatuCode-Desktop-<arch>.zip`.

#### Scenario: Tag push builds both app variants
- **WHEN** a release tag is pushed
- **THEN** the workflow produces an arm64 app embedding `uatu-darwin-arm64` and an x64 app embedding `uatu-darwin-x64`

### Requirement: Signing and notarization are gated on credential availability
When Developer ID signing secrets are configured, the release job MUST codesign
the embedded `uatu` binary (hardened runtime, JIT entitlement) and the app
bundle, submit for notarization, staple the ticket, attach the signed archives to
the GitHub release, and include them in the published checksums. When the secrets
are absent, the job MUST still build ad-hoc-signed apps and upload them as
workflow artifacts with a visible warning, and MUST NOT attach unsigned apps to
the GitHub release.

#### Scenario: Secrets absent (pre-enrollment)
- **WHEN** the release workflow runs without signing secrets configured
- **THEN** ad-hoc-signed apps are uploaded as workflow artifacts with a warning
- **AND** no app archive is attached to the GitHub release

#### Scenario: Secrets present
- **WHEN** the release workflow runs with signing secrets configured
- **THEN** signed, notarized, stapled app archives are attached to the GitHub release
- **AND** their checksums are included in the release checksum file

#### Scenario: Notarized app passes Gatekeeper
- **WHEN** a user downloads a signed release archive and launches the app
- **THEN** Gatekeeper accepts the app without an override
- **AND** the embedded uatu binary starts and serves normally under the hardened runtime

### Requirement: Homebrew tap publishes a uatu-desktop cask for signed releases
The tap-update automation SHALL generate `Casks/uatu-desktop.rb` in
`tjakobsson/homebrew-tap` pointing at the release's signed app archives with
per-architecture (`on_arm`/`on_intel`) URLs and checksums. When a release
contains no signed app archives, the cask MUST NOT be created or updated for
that release, while formula generation proceeds unchanged.

#### Scenario: Signed release updates the cask
- **WHEN** a release containing signed app archives is published
- **THEN** the tap gains/updates `Casks/uatu-desktop.rb` referencing that version's archives and checksums
- **AND** `brew install tjakobsson/tap/uatu-desktop` installs the app

#### Scenario: Unsigned release leaves the cask untouched
- **WHEN** a release without signed app archives is published
- **THEN** the formula is updated as usual and the cask is left at its previous version

### Requirement: Desktop changes are validated in CI
The repository's PR validation SHALL build the desktop app (ad-hoc signed) on a
macOS runner when files under `desktop/macos/` change, and SHALL skip that job
otherwise.

#### Scenario: PR touching desktop sources
- **WHEN** a pull request modifies files under `desktop/macos/`
- **THEN** CI builds the desktop app and fails the PR on build errors

#### Scenario: PR not touching desktop sources
- **WHEN** a pull request modifies only files outside `desktop/macos/`
- **THEN** the desktop build job does not run

### Requirement: A nightly edge workflow builds signed desktop apps from main
A scheduled workflow (nightly cron plus manual `workflow_dispatch`) SHALL build UatuCode Desktop from `main` for both architectures using the same embed/sign/notarize/staple pipeline as releases, and SHALL exit early without building when `main` has not moved since the last published edge build. When Developer ID signing secrets are unavailable the workflow MUST fail without publishing anything — unsigned edge builds are never distributed, and the failure is loud so a bad secret rotation cannot silently stop the channel.

#### Scenario: main moved overnight

- **WHEN** the nightly run finds `main` ahead of the commit recorded on the edge release
- **THEN** it builds, signs, notarizes, and publishes both app archives

#### Scenario: main unchanged

- **WHEN** the nightly run finds the edge release already points at `main`'s HEAD
- **THEN** it exits early without building or notarizing

#### Scenario: signing secrets missing

- **WHEN** any Developer ID or notary secret is absent
- **THEN** the run fails with an error and publishes nothing

### Requirement: Edge builds publish to a rolling prerelease with monotonic versions
Edge builds SHALL publish to a single GitHub prerelease with the fixed tag `edge`: the tag moves to the built commit, assets (`UatuCode-Desktop-arm64.zip`, `UatuCode-Desktop-x64.zip`, `SHA256SUMS`) are replaced in place, and the release records the source commit. The stamped version SHALL be `<base>-edge.<utc-timestamp>.<shortsha>` (base from `package.json`, timestamp with second precision) so successive edge builds — including several on the same day — compare as increasing versions and the next stable release compares higher than any of its edge builds.

#### Scenario: Assets replaced in place

- **WHEN** a new edge build publishes
- **THEN** the `edge` release contains exactly one archive per architecture plus SHA256SUMS, all from the same commit

#### Scenario: Version ordering

- **WHEN** an edge user later installs the next stable release
- **THEN** the stable version compares higher and the upgrade proceeds

### Requirement: The tap offers an opt-in uatu-desktop@edge cask
The tap automation SHALL generate `Casks/uatu-desktop@edge.rb` in `tjakobsson/homebrew-tap` from the edge release's SHA256SUMS, pointing at the `edge` tag's assets with the edge version string. It SHALL run on every successful workflow run — including runs whose build was skipped — reconciling the cask with the currently published release so a transiently failed tap update self-heals without a rebuild. The edge cask SHALL declare a conflict with the stable `uatu-desktop` cask, and the stable cask MUST remain unaffected by edge publishing.

#### Scenario: Opting into edge

- **WHEN** a user runs `brew install --cask tjakobsson/tap/uatu-desktop@edge`
- **THEN** the latest edge build installs, and a later `brew upgrade` after a new edge build moves them forward

#### Scenario: Tap update self-heals after a transient failure

- **WHEN** a run published assets but its tap update failed transiently
- **THEN** the next run regenerates the cask from the published release without rebuilding the app

#### Scenario: Stable users unaffected

- **WHEN** an edge build publishes
- **THEN** `Casks/uatu-desktop.rb` is unchanged

### Requirement: A local install script builds and installs the working tree
A macOS script at `scripts/install-desktop-local.sh` SHALL build the CLI (`bun run build`), build a Release app embedding it with a `<base>-local.<shortsha>` version, and install it into `/Applications`, refusing to replace a currently running copy.

#### Scenario: Local dogfood install

- **WHEN** the developer runs the script on a clean working tree
- **THEN** `/Applications/UatuCode Desktop.app` contains a Release build of the current tree

#### Scenario: App is running

- **WHEN** the installed app is running during install
- **THEN** the script aborts with a message instead of replacing it
