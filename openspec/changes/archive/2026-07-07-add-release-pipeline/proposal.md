# Add Release Pipeline

## Why

uatu builds a single-file binary but has never cut a public release — there is no way for anyone to install it without cloning the repo and running Bun. A tag-driven release pipeline that publishes cross-compiled binaries to GitHub Releases, with checksums and build provenance, plus a Homebrew tap, gives users a one-line install (`brew install tjakobsson/tap/uatu`) and a frictionless update path (`brew upgrade`).

## What Changes

- New `.github/workflows/release.yml` triggered by pushing a `v*` tag: cross-compiles four targets from a single Ubuntu runner, archives them, generates `SHA256SUMS`, attests build provenance, and creates the GitHub Release with auto-generated notes.
- `scripts/build.ts` grows cross-compile target support (`bun build --compile --target=bun-<os>-<arch>`) instead of only building for the host platform.
- Four release assets with a stable naming contract: `uatu-darwin-arm64.zip`, `uatu-darwin-x64.zip`, `uatu-linux-x64.tar.gz`, `uatu-linux-arm64.tar.gz` — each archive contains a single `uatu` binary at its root.
- Build provenance attestations via `actions/attest-build-provenance` so users can run `gh attestation verify <asset> --repo tjakobsson/uatu`.
- The release workflow smoke-tests the linux-x64 binary (reusing `bun run smoke`) before publishing.
- New external repo `tjakobsson/homebrew-tap` with `Formula/uatu.rb` mapping platform/arch to release assets with sha256 pins.
- A final release-workflow job auto-bumps the tap formula (version + four hashes) using a fine-grained PAT scoped to the tap repo.
- README gains an install section: Homebrew first, manual download second with the macOS quarantine note (`xattr -d com.apple.quarantine`).
- Explicitly out of scope: Windows targets (Bun PTY support unverified), musl variants, code signing / notarization (ad-hoc signature from `bun build --compile` is sufficient for brew/curl install paths), and npm publishing (phase 2).

## Capabilities

### New Capabilities

- `release-distribution`: how uatu releases are built, verified, published, and distributed — the tag-triggered release workflow, the four-target asset matrix and naming contract, integrity artifacts (SHA256SUMS + provenance attestations), the Homebrew tap formula and its auto-bump, and the README install documentation.

### Modified Capabilities

<!-- none — existing repository-workflows requirements (CI validation, README usage docs) are unchanged; the install section is a new requirement owned by release-distribution -->

## Impact

- **New files**: `.github/workflows/release.yml`.
- **Modified files**: `scripts/build.ts` (target support), `README.md` (install section).
- **External**: new GitHub repo `tjakobsson/homebrew-tap` (manual creation), one new repo secret (fine-grained PAT with contents:write on the tap repo only).
- **Permissions**: release workflow needs `contents: write`, `id-token: write`, `attestations: write` — a strict superset of CI's current `contents: read`, confined to the new workflow.
- **Public contract**: asset names and archive layout become load-bearing for the tap formula (and any future curl installer / npm wrapper); changing them later is a breaking change for installers.
- **Version**: first public release is v0.1.0 — `package.json` already carries 0.1.0, so no version bump is part of this change.
