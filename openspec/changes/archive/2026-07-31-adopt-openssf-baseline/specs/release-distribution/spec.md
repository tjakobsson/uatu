# release-distribution Delta Specification

## MODIFIED Requirements

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
