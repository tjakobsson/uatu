# release-distribution delta — add-uatu-edge-channel

## ADDED Requirements

### Requirement: uatu is installable from the edge channel via the tap
The tap automation SHALL generate `Formula/uatu@edge.rb` in `tjakobsson/homebrew-tap` from the edge release's SHA256SUMS, pointing at the `edge` tag's CLI archives with the edge version string, on every successful edge workflow run — including runs whose build was skipped — so a transiently failed tap update self-heals from the published release without a rebuild. The edge formula SHALL declare `conflicts_with` the stable `uatu` formula and the stable formula SHALL declare the reciprocal conflict (both install `bin/uatu`, so exactly one may be installed at a time), and the stable formula's version and URLs MUST remain unaffected by edge publishing. Both formulas SHALL be emitted by the same generator (`scripts/generate-formula.ts`), parameterized by formula name and release tag the way the cask generator already is, with unit tests covering both channels.

#### Scenario: Opting into the CLI edge channel

- **WHEN** a user runs `brew install tjakobsson/tap/uatu@edge` on macOS or Linux
- **THEN** the latest nightly `main` build of uatu installs, and a later `brew upgrade` after a new edge build moves them forward

#### Scenario: Channels are mutually exclusive

- **WHEN** a user with the stable `uatu` formula installed attempts to install `uatu@edge` (or vice versa)
- **THEN** Homebrew reports the conflict instead of shadowing one binary with the other

#### Scenario: Tap update self-heals after a transient failure

- **WHEN** an edge run published CLI archives but its tap update failed transiently
- **THEN** the next run regenerates `Formula/uatu@edge.rb` from the published release without rebuilding

#### Scenario: Stable formula version untouched by edge

- **WHEN** an edge build publishes
- **THEN** `Formula/uatu.rb` still points at the latest stable release's tag and checksums

### Requirement: Edge CLI binaries report the edge version
Binaries published to the edge channel SHALL be stamped with the edge version string (`<base>-edge.<utc-timestamp>.<shortsha>`), so `uatu --version` identifies an edge build and the edge formula's self-test (`assert_match version.to_s` against `uatu --version`) passes unmodified.

#### Scenario: An edge binary self-identifies

- **WHEN** a user runs `uatu --version` on an edge-channel install
- **THEN** the output contains the full edge version string, distinguishing it from a stable build of the same base version

#### Scenario: The edge formula self-tests

- **WHEN** `brew test uatu@edge` runs
- **THEN** the installed binary's `--version` output matches the formula's version

### Requirement: The build script supports version overrides
`scripts/build.ts` SHALL accept a `--version <string>` flag that overrides the version embedded in the compiled binary's build info, defaulting to the `package.json` version when absent, so channel builds can stamp channel-qualified versions without touching `package.json`.

#### Scenario: Edge build stamps the edge version

- **WHEN** the edge workflow invokes the build script with `--version <base>-edge.<timestamp>.<shortsha>`
- **THEN** the compiled binary's `--version` output reports that string alongside the commit

#### Scenario: Default invocation is unchanged

- **WHEN** the build script runs without `--version`
- **THEN** the binary reports the `package.json` version exactly as before
