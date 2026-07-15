# desktop-distribution Specification (delta)

## ADDED Requirements

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
- **AND** `brew install --cask tjakobsson/tap/uatu-desktop` installs the app

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
