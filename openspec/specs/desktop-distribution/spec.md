# desktop-distribution Specification

## Purpose

Define how UatuCode Desktop is built and shipped: where the app source lives in the uatu repository, how release builds produce per-architecture app archives embedding the matching `uatu` binary, how signing and notarization are gated on credential availability, how the Homebrew tap publishes a `uatu-desktop` cask for signed releases, and how desktop changes are validated in CI.
## Requirements
### Requirement: Release workflow builds per-architecture desktop apps
The tag-triggered release workflow SHALL include a macOS job that builds the desktop app twice — once per architecture (`arm64`, `x64`) — with no embedded `uatu` binary. App archives SHALL be zips named `UatuCode-Desktop-<arch>.zip`.

#### Scenario: Tag push builds both app variants
- **WHEN** a release tag is pushed
- **THEN** the workflow produces arm64 and x64 apps, neither containing an embedded `uatu` binary

### Requirement: Signing and notarization are gated on credential availability
When Developer ID signing secrets are configured, the release job MUST codesign
the app bundle (hardened runtime; there is no embedded binary to nested-sign),
submit for notarization, staple the ticket, attach the signed archives to
the GitHub release, and include them in the published checksums.

#### Scenario: Signed desktop archives carry release provenance
- **WHEN** the release job produces signed app archives
- **THEN** it SHALL generate a GitHub build-provenance attestation for each signed archive
- **AND** it SHALL attach the archive's Sigstore bundle, retrieved from the attestation store, to the release as `<archive>.sigstore.json`, matching the bundle assets the four `uatu-*` archives already ship

#### Scenario: Missing credentials restrict apps to workflow artifacts
- **WHEN** Developer ID signing secrets are absent
- **THEN** the job MUST still build ad-hoc-signed apps and upload them as workflow artifacts with a visible warning
- **AND** it MUST NOT attach unsigned apps to the GitHub release

#### Scenario: Secrets absent (pre-enrollment)
- **WHEN** the release workflow runs without signing secrets configured
- **THEN** ad-hoc-signed apps are uploaded as workflow artifacts with a warning
- **AND** no app archive is attached to the GitHub release

#### Scenario: Secrets present
- **WHEN** the release workflow runs with signing secrets configured
- **THEN** signed, notarized, stapled app archives are attached to the GitHub release
- **AND** their checksums are included in the release checksum file
- **AND** each app archive has a sibling `<archive>.sigstore.json` provenance bundle asset that verifies against it with standard Sigstore tooling

#### Scenario: Notarized app passes Gatekeeper
- **WHEN** a user downloads a signed release archive and launches the app
- **THEN** Gatekeeper accepts the app without an override and it runs normally under the hardened runtime

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
A scheduled workflow (nightly cron plus manual `workflow_dispatch`) SHALL build, from `main`, both UatuCode Desktop apps using the same embed/sign/notarize/staple pipeline as releases and the four cross-compiled uatu CLI archives under the stable release naming contract. It SHALL skip fully published unchanged builds and gate publication on smoke testing and signing credentials.

#### Scenario: Unchanged main is skipped only after complete publication
- **WHEN** the nightly workflow checks whether `main` has moved since the last fully published edge build
- **THEN** it SHALL exit early without building only when the `edge` tag points at `main`'s HEAD AND the release carries the complete asset set: desktop app archives, CLI archives, every archive's provenance bundle, SHA256SUMS, and VERSION

#### Scenario: Smoke testing and signing gate every edge publication
- **WHEN** an edge run prepares to publish
- **THEN** the freshly compiled host-platform CLI binary the runner can execute SHALL first pass `bun run smoke`, mirroring the stable release's pre-publication gate
- **AND** unavailable Developer ID signing secrets MUST fail the workflow loudly without publishing anything; unsigned edge builds are never distributed, so bad secret rotation cannot silently stop the channel

#### Scenario: main moved overnight

- **WHEN** the nightly run finds `main` ahead of the commit recorded on the edge release
- **THEN** it builds, signs, notarizes, and publishes both app archives and the four CLI archives

#### Scenario: main unchanged

- **WHEN** the nightly run finds the edge release already points at `main`'s HEAD with the complete asset set present
- **THEN** it exits early without building or notarizing

#### Scenario: signing secrets missing

- **WHEN** any Developer ID or notary secret is absent
- **THEN** the run fails with an error and publishes nothing

#### Scenario: broken CLI binary blocks the nightly

- **WHEN** the smoke test fails against the freshly compiled binary
- **THEN** the run fails and neither CLI nor desktop assets publish — the previous night's assets remain in place

### Requirement: Edge builds publish to a rolling prerelease with monotonic versions
Edge builds SHALL publish to a single GitHub prerelease with the fixed tag `edge`, moving the tag to the built commit, replacing the complete asset set in place, and recording the source commit. Archives SHALL follow the stable packaging and provenance contracts, with monotonic edge versions below the next stable release.

#### Scenario: An edge publish replaces the complete named asset set
- **WHEN** an edge build publishes
- **THEN** it SHALL replace `UatuCode-Desktop-arm64.zip`, `UatuCode-Desktop-x64.zip`, `uatu-darwin-arm64.zip`, `uatu-darwin-x64.zip`, `uatu-linux-x64.tar.gz`, `uatu-linux-arm64.tar.gz`, each archive's `<archive>.sigstore.json` Sigstore provenance bundle, `SHA256SUMS`, and `VERSION` in place
- **AND** CLI archives SHALL be zip for darwin and tar.gz for linux, each holding a single `uatu` binary at archive root, and SHA256SUMS SHALL cover every archive, desktop and CLI alike

#### Scenario: Edge provenance survives interrupted publication
- **WHEN** the workflow prepares archives or checks whether an edge build is already fully published
- **THEN** each archive SHALL carry a GitHub build-provenance attestation via `actions/attest-build-provenance`
- **AND** its Sigstore bundle SHALL be retrieved from the attestation store with `gh attestation download` and uploaded as a sibling release asset, mirroring the versioned-release contract so provenance is discoverable from the release page and verifiable without GitHub-specific tooling
- **AND** the completeness check SHALL require CLI archives and all provenance bundles, so a run that uploaded archives but failed before attaching bundles is completed by the next run rather than skipped

#### Scenario: Successive edge builds receive increasing versions
- **WHEN** an edge version is stamped
- **THEN** it SHALL be `<base>-edge.<utc-timestamp>.<shortsha>`, with base from `package.json` and timestamp with second precision
- **AND** successive builds, including several on the same day, SHALL compare as increasing versions, while the next stable release compares higher than any of its edge builds

#### Scenario: Assets replaced in place

- **WHEN** a new edge build publishes
- **THEN** the `edge` release contains exactly one desktop archive per architecture, one CLI archive per supported target, one `.sigstore.json` bundle per archive, SHA256SUMS, and VERSION, all from the same commit

#### Scenario: Edge provenance is verifiable from release assets

- **WHEN** a user or scanner downloads any archive and its `<archive>.sigstore.json` from the edge release
- **THEN** the bundle verifies against the archive using standard Sigstore tooling, and `gh attestation verify` attests the archive was built by this repository's edge workflow

#### Scenario: Incomplete publish is completed, not skipped

- **WHEN** a prior run moved the `edge` tag and uploaded archives but failed before attaching the provenance bundles or the CLI archives
- **THEN** the next run does not exit early on the "already published" check and publishes a complete asset set

#### Scenario: Version ordering

- **WHEN** an edge user later installs the next stable release
- **THEN** the stable version compares higher and the upgrade proceeds

### Requirement: The tap offers an opt-in uatu-desktop@edge cask
The tap automation SHALL generate `Casks/uatu-desktop@edge.rb` in `tjakobsson/homebrew-tap` from the edge release's SHA256SUMS, pointing at the `edge` tag's assets with the edge version string. The edge cask SHALL conflict with stable `uatu-desktop`; edge publishing MUST leave the stable cask unaffected. Every successful workflow run, including a skipped build, SHALL reconcile the edge cask with the published release.

#### Scenario: Every successful edge run reconciles the opt-in cask
- **WHEN** a workflow run succeeds, including when its build was skipped
- **THEN** tap automation SHALL run and reconcile the cask with the currently published release so a transient tap-update failure self-heals without a rebuild

#### Scenario: The generated cask declares its install conflict
- **WHEN** the published `Casks/uatu-desktop@edge.rb` is inspected independently of a workflow run
- **THEN** it declares a conflict with the stable `uatu-desktop` cask

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
A macOS script at `scripts/install-desktop-local.sh` SHALL build a Release app from the working tree with a `<base>-local.<shortsha>` version and install it into `/Applications`, refusing to replace a currently running copy. The script SHALL NOT build or embed the CLI.

#### Scenario: Local dogfood install

- **WHEN** the developer runs the script on a clean working tree
- **THEN** `/Applications/UatuCode Desktop.app` contains a Release build of the current tree

#### Scenario: App is running

- **WHEN** the installed app is running during install
- **THEN** the script aborts with a message instead of replacing it

### Requirement: Desktop app source lives in-tree and builds without the CLI
The UatuCode Desktop Xcode project and Swift sources SHALL live in the uatu repository under `desktop/macos/`, using `UatuCodeDesktop` target/scheme names, product name "UatuCode Desktop", and bundle identifier `se.coll8.uatucode.desktop`. The app SHALL NOT embed a `uatu` binary: it is a pure hub client, and its build SHALL NOT depend on the CLI build.

#### Scenario: Local development build
- **WHEN** a developer builds the Xcode project without having run `bun run build`
- **THEN** the build succeeds and the resulting app bundle contains no `uatu` binary
