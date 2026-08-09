# desktop-distribution — delta

## MODIFIED Requirements

### Requirement: Release workflow builds per-architecture desktop apps
The tag-triggered release workflow SHALL include a macOS job that builds the desktop app twice — once per architecture (`arm64`, `x64`) — with no embedded `uatu` binary. App archives SHALL be zips named `UatuCode-Desktop-<arch>.zip`.

#### Scenario: Tag push builds both app variants
- **WHEN** a release tag is pushed
- **THEN** the workflow produces arm64 and x64 apps, neither containing an embedded `uatu` binary

### Requirement: A local install script builds and installs the working tree
A macOS script at `scripts/install-desktop-local.sh` SHALL build a Release app from the working tree with a `<base>-local.<shortsha>` version and install it into `/Applications`, refusing to replace a currently running copy. The script SHALL NOT build or embed the CLI.

#### Scenario: Local dogfood install

- **WHEN** the developer runs the script on a clean working tree
- **THEN** `/Applications/UatuCode Desktop.app` contains a Release build of the current tree

#### Scenario: App is running

- **WHEN** the installed app is running during install
- **THEN** the script aborts with a message instead of replacing it

## ADDED Requirements

### Requirement: Desktop app source lives in-tree and builds without the CLI
The UatuCode Desktop Xcode project and Swift sources SHALL live in the uatu repository under `desktop/macos/`, using `UatuCodeDesktop` target/scheme names, product name "UatuCode Desktop", and bundle identifier `se.coll8.uatucode.desktop`. The app SHALL NOT embed a `uatu` binary: it is a pure hub client, and its build SHALL NOT depend on the CLI build.

#### Scenario: Local development build
- **WHEN** a developer builds the Xcode project without having run `bun run build`
- **THEN** the build succeeds and the resulting app bundle contains no `uatu` binary

## REMOVED Requirements

### Requirement: Desktop app source lives in-tree under desktop/macos
**Reason**: Restated as "Desktop app source lives in-tree and builds without the CLI": the embed-the-binary build phase (and its missing-binary build failure) is deleted with the supervised local hub.
**Migration**: None — `xcodebuild` alone builds the app.
