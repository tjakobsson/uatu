# desktop-distribution delta — add-uatu-edge-channel

## MODIFIED Requirements

### Requirement: A nightly edge workflow builds signed desktop apps from main
A scheduled workflow (nightly cron plus manual `workflow_dispatch`) SHALL build, from `main`, both the UatuCode Desktop apps — using the same embed/sign/notarize/staple pipeline as releases — and the four cross-compiled uatu CLI archives under the stable release naming contract, and SHALL exit early without building when `main` has not moved since the last fully published edge build — "fully published" meaning the `edge` tag points at `main`'s HEAD AND the release carries the complete asset set (desktop app archives, CLI archives, every archive's provenance bundle, SHA256SUMS, VERSION). Before anything publishes, the CLI binary the runner can execute SHALL pass the smoke test (`bun run smoke` against the freshly compiled host-platform binary), mirroring the stable release's pre-publication gate. When Developer ID signing secrets are unavailable the workflow MUST fail without publishing anything — unsigned edge builds are never distributed, and the failure is loud so a bad secret rotation cannot silently stop the channel.

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
Edge builds SHALL publish to a single GitHub prerelease with the fixed tag `edge`: the tag moves to the built commit, assets (`UatuCode-Desktop-arm64.zip`, `UatuCode-Desktop-x64.zip`, `uatu-darwin-arm64.zip`, `uatu-darwin-x64.zip`, `uatu-linux-x64.tar.gz`, `uatu-linux-arm64.tar.gz`, each archive's `<archive>.sigstore.json` Sigstore provenance bundle, `SHA256SUMS`, and `VERSION`) are replaced in place, and the release records the source commit. The CLI archives SHALL follow the stable release asset contract — zip for darwin, tar.gz for linux, each holding a single `uatu` binary at archive root — and SHA256SUMS SHALL cover every archive, desktop and CLI alike. Each archive SHALL carry a GitHub build-provenance attestation (via `actions/attest-build-provenance`), and its Sigstore bundle SHALL be retrieved from the attestation store (`gh attestation download`) and uploaded as a sibling release asset, mirroring the versioned-release contract, so edge provenance is discoverable from the release page and verifiable without GitHub-specific tooling. The workflow's "already fully published" check SHALL count the CLI archives and all provenance bundles among the required assets, so a run that uploaded archives but failed before attaching bundles is completed by the next run rather than skipped. The stamped version SHALL be `<base>-edge.<utc-timestamp>.<shortsha>` (base from `package.json`, timestamp with second precision) so successive edge builds — including several on the same day — compare as increasing versions and the next stable release compares higher than any of its edge builds.

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
