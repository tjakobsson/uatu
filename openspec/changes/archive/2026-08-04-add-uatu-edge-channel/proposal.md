# Proposal: add-uatu-edge-channel

## Why

The desktop app has a nightly edge channel — `desktop-edge.yml` publishes signed builds of `main` to the rolling `edge` prerelease, installable via `brew install --cask tjakobsson/tap/uatu-desktop@edge` — but the uatu CLI itself has no such channel: CLI binaries only ship on stable tagged releases. Anyone who wants to run the latest `main` of uatu (including on Linux, where the desktop app doesn't exist) has to build from source. The edge pipeline already compiles the darwin CLI binaries every night to embed in the desktop app; it just throws them away instead of publishing them.

## What Changes

- The nightly edge workflow additionally cross-compiles all four CLI targets (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`), packages them under the same asset-naming contract as stable releases (`uatu-<target>.zip` / `.tar.gz`), attests them, and uploads them — with per-archive Sigstore provenance bundles — to the same rolling `edge` prerelease alongside the desktop app archives.
- Edge CLI binaries are stamped with the edge version (`<base>-edge.<utc-timestamp>.<shortsha>`) so `uatu --version` identifies an edge build; `scripts/build.ts` gains a version-override flag to support this.
- The edge CLI build is smoke-tested on the runner before publishing, mirroring the stable release's pre-publication smoke test.
- The workflow's "already fully published" skip guard counts the CLI archives and their provenance bundles among the required assets.
- The tap automation additionally generates `Formula/uatu@edge.rb` in `tjakobsson/homebrew-tap`, a channel-parameterized variant of the stable formula that conflicts with it; `scripts/generate-formula.ts` is refactored to support name/tag parameters like `generate-cask.ts` already does.
- The workflow is renamed from `desktop-edge.yml` to `edge.yml` ("Edge") since it now covers both products.
- README documents the CLI edge install path next to the desktop one.

## Capabilities

### New Capabilities

None — both affected areas already have specs.

### Modified Capabilities

- `desktop-distribution`: the nightly edge workflow's publication contract widens — the rolling `edge` prerelease carries the four CLI archives (with provenance bundles and SHA256SUMS entries) in addition to the desktop app archives, the skip guard counts them, and the edge CLI build must pass a smoke test before anything publishes.
- `release-distribution`: new requirements — uatu is installable from the edge channel via `Formula/uatu@edge.rb` (conflicting with the stable formula, self-healing tap reconciliation), edge CLI binaries report the edge version string, and the build script supports overriding the stamped version.

## Impact

- `.github/workflows/desktop-edge.yml` → renamed/extended to `.github/workflows/edge.yml` (CLI compile + package + smoke + attest + upload; guard asset list; tap job generates the edge formula).
- `scripts/build.ts` — new `--version` override flag feeding the injected `BuildInfo`.
- `scripts/generate-formula.ts` — refactored to export a testable generator with `--name` / `--tag` options and cross-channel `conflicts_with`, mirroring `scripts/generate-cask.ts`; new colocated test file.
- `tjakobsson/homebrew-tap` — gains `Formula/uatu@edge.rb` (generated, no manual action needed).
- `README.md` — CLI edge install instructions.
- No product-code (`src/`) changes; no impact on stable releases.
