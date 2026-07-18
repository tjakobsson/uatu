# Delta: desktop-distribution — nightly edge channel

## ADDED Requirements

### Requirement: A nightly edge workflow builds signed desktop apps from main
A scheduled workflow (nightly cron plus manual `workflow_dispatch`) SHALL build UatuCode Desktop from `main` for both architectures using the same embed/sign/notarize/staple pipeline as releases, and SHALL exit early without building when `main` has not moved since the last published edge build. When Developer ID signing secrets are unavailable the workflow MUST skip publishing entirely — unsigned edge builds are never distributed.

#### Scenario: main moved overnight

- **WHEN** the nightly run finds `main` ahead of the commit recorded on the edge release
- **THEN** it builds, signs, notarizes, and publishes both app archives

#### Scenario: main unchanged

- **WHEN** the nightly run finds the edge release already points at `main`'s HEAD
- **THEN** it exits early without building or notarizing

#### Scenario: signing secrets missing

- **WHEN** any Developer ID or notary secret is absent
- **THEN** the workflow publishes nothing and surfaces a warning

### Requirement: Edge builds publish to a rolling prerelease with monotonic versions
Edge builds SHALL publish to a single GitHub prerelease with the fixed tag `edge`: the tag moves to the built commit, assets (`UatuCode-Desktop-arm64.zip`, `UatuCode-Desktop-x64.zip`, `SHA256SUMS`) are replaced in place, and the release records the source commit. The stamped version SHALL be `<base>-edge.<YYYYMMDD>.<shortsha>` (base from `package.json`) so successive edge builds compare as increasing versions and the next stable release compares higher than any of its edge builds.

#### Scenario: Assets replaced in place

- **WHEN** a new edge build publishes
- **THEN** the `edge` release contains exactly one archive per architecture plus SHA256SUMS, all from the same commit

#### Scenario: Version ordering

- **WHEN** an edge user later installs the next stable release
- **THEN** the stable version compares higher and the upgrade proceeds

### Requirement: The tap offers an opt-in uatu-desktop@edge cask
The tap automation SHALL generate `Casks/uatu-desktop@edge.rb` in `tjakobsson/homebrew-tap` from the edge release's SHA256SUMS, pointing at the `edge` tag's assets with the edge version string. The edge cask SHALL declare a conflict with the stable `uatu-desktop` cask, and the stable cask MUST remain unaffected by edge publishing.

#### Scenario: Opting into edge

- **WHEN** a user runs `brew install --cask tjakobsson/tap/uatu-desktop@edge`
- **THEN** the latest edge build installs, and a later `brew upgrade` after a new edge build moves them forward

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
