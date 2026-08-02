# desktop-distribution delta — add-edge-provenance-bundles

## MODIFIED Requirements

### Requirement: Signing and notarization are gated on credential availability
When Developer ID signing secrets are configured, the release job MUST codesign
the embedded `uatu` binary (hardened runtime, JIT entitlement) and the app
bundle, submit for notarization, staple the ticket, attach the signed archives to
the GitHub release, and include them in the published checksums. It SHALL also
generate a GitHub build-provenance attestation for each signed archive and
attach the archive's Sigstore bundle (retrieved from the attestation store) to
the release as `<archive>.sigstore.json`, matching the bundle assets the four
`uatu-*` archives already ship. When the secrets
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
- **AND** each app archive has a sibling `<archive>.sigstore.json` provenance bundle asset that verifies against it with standard Sigstore tooling

#### Scenario: Notarized app passes Gatekeeper
- **WHEN** a user downloads a signed release archive and launches the app
- **THEN** Gatekeeper accepts the app without an override
- **AND** the embedded uatu binary starts and serves normally under the hardened runtime

### Requirement: Edge builds publish to a rolling prerelease with monotonic versions
Edge builds SHALL publish to a single GitHub prerelease with the fixed tag `edge`: the tag moves to the built commit, assets (`UatuCode-Desktop-arm64.zip`, `UatuCode-Desktop-x64.zip`, each archive's `<archive>.sigstore.json` Sigstore provenance bundle, `SHA256SUMS`, and `VERSION`) are replaced in place, and the release records the source commit. Each archive SHALL carry a GitHub build-provenance attestation (via `actions/attest-build-provenance`), and its Sigstore bundle SHALL be retrieved from the attestation store (`gh attestation download`) and uploaded as a sibling release asset, mirroring the versioned-release contract, so edge provenance is discoverable from the release page and verifiable without GitHub-specific tooling. The workflow's "already fully published" check SHALL count the provenance bundles among the required assets, so a run that uploaded archives but failed before attaching bundles is completed by the next run rather than skipped. The stamped version SHALL be `<base>-edge.<utc-timestamp>.<shortsha>` (base from `package.json`, timestamp with second precision) so successive edge builds — including several on the same day — compare as increasing versions and the next stable release compares higher than any of its edge builds.

#### Scenario: Assets replaced in place

- **WHEN** a new edge build publishes
- **THEN** the `edge` release contains exactly one archive per architecture, one `.sigstore.json` bundle per archive, SHA256SUMS, and VERSION, all from the same commit

#### Scenario: Edge provenance is verifiable from release assets

- **WHEN** a user or scanner downloads `UatuCode-Desktop-arm64.zip` and its `UatuCode-Desktop-arm64.zip.sigstore.json` from the edge release
- **THEN** the bundle verifies against the archive using standard Sigstore tooling, and `gh attestation verify` attests the archive was built by this repository's edge workflow

#### Scenario: Incomplete publish is completed, not skipped

- **WHEN** a prior run moved the `edge` tag and uploaded archives but failed before attaching the provenance bundles
- **THEN** the next run does not exit early on the "already published" check and publishes a complete asset set

#### Scenario: Version ordering

- **WHEN** an edge user later installs the next stable release
- **THEN** the stable version compares higher and the upgrade proceeds
