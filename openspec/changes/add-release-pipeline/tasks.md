# Tasks — add-release-pipeline

Tasks marked **[MANUAL — Tobias]** need a human (GitHub UI access, PAT minting, or a physical Mac); everything else is implementable in the repo.

## 1. Build script cross-compilation

- [x] 1.1 Add `--target=<bun-target>` and `--outfile=<path>` argument parsing to `scripts/build.ts`; no-arg behavior stays a host build to `dist/uatu`; build info (version + commit) embeds identically for every target
- [x] 1.2 Verify locally: `bun run build` (host, unchanged) and `bun run scripts/build.ts --target=bun-darwin-arm64 --outfile=dist/uatu-darwin-arm64` both produce binaries; run `bun run smoke` against the host build

## 2. Release workflow

- [x] 2.1 Create `.github/workflows/release.yml` triggered on `v*` tag push, with pinned Bun 1.3.14 and pinned action SHAs (repo convention), and workflow-level permissions `contents: write`, `id-token: write`, `attestations: write`
- [x] 2.2 Add the tag-guard step: fail before building if the tag ≠ `v` + `package.json` version
- [x] 2.3 Add the build job: install deps, cross-compile all four targets (`bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`, `bun-linux-arm64`)
- [x] 2.4 Smoke-test the linux-x64 binary via `bun run smoke` (pointing the smoke script at that binary via `UATU_SMOKE_BINARY`) — must run before anything is published
- [x] 2.5 Package assets per the naming contract: `uatu-darwin-{arm64,x64}.zip`, `uatu-linux-{x64,arm64}.tar.gz`, each containing the single `uatu` binary at archive root; generate `SHA256SUMS` over the four archives
- [x] 2.6 Add provenance attestation via `actions/attest-build-provenance` (pinned SHA) covering the four archives
- [x] 2.7 Create the GitHub Release with `gh release create` — auto-generated notes, the four archives + `SHA256SUMS` attached

## 3. Homebrew tap

- [ ] 3.1 **[MANUAL — Tobias]** Create the public GitHub repo `tjakobsson/homebrew-tap`, initialized with a README so the default branch (`main`) exists — the first release run populates `Formula/uatu.rb` automatically
- [ ] 3.2 **[MANUAL — Tobias]** Mint a fine-grained PAT scoped to `tjakobsson/homebrew-tap` only, permission contents: read+write; add it to the `uatu` repo as actions secret `HOMEBREW_TAP_TOKEN`
- [x] 3.3 Add `scripts/generate-formula.ts` emitting the complete `Formula/uatu.rb` from a version + `SHA256SUMS`: `on_macos`/`on_linux` × `on_arm`/`on_intel` blocks with release-asset URLs + sha256 pins, `bin.install "uatu"`, `test do` asserting `uatu --version` (design D8 refined: the formula is always generated, never hand-written)
- [x] 3.4 Add the tap-bump job to `release.yml`: after the release publishes, regenerate `Formula/uatu.rb` from the published release's `SHA256SUMS`, commit and push to the tap repo using `HOMEBREW_TAP_TOKEN`; job is re-runnable and cannot affect the already-published release on failure

## 4. Documentation

- [ ] 4.1 Add an Install section to `README.md`: Homebrew first (`brew install tjakobsson/tap/uatu`, `brew upgrade uatu`), manual download from Releases second — including the macOS quarantine note (`xattr -d com.apple.quarantine ./uatu` or System Settings → Privacy & Security) and a pointer to `gh attestation verify <asset> --repo tjakobsson/uatu`
- [ ] 4.2 Land everything on `main` via PR; CI green

## 5. Cut v0.1.0 and verify

- [ ] 5.1 **[MANUAL — Tobias]** Push the release tag: `git tag v0.1.0 && git push origin v0.1.0`; watch the release workflow through to green (release published, tap formula updated with real hashes)
- [ ] 5.2 **[MANUAL — Tobias]** On the Mac: `curl -LO` the `uatu-darwin-arm64.zip` asset, unzip, run `./uatu --version`; confirm it executes and `codesign -dv ./uatu` shows `Signature=adhoc`
- [ ] 5.3 **[MANUAL — Tobias]** Verify provenance: `gh attestation verify uatu-darwin-arm64.zip --repo tjakobsson/uatu` succeeds; spot-check one hash against `SHA256SUMS`
- [ ] 5.4 **[MANUAL — Tobias]** End-to-end Homebrew check: `brew install tjakobsson/tap/uatu`, run `uatu --version`, then `brew test uatu`
- [ ] 5.5 If any verification fails: delete the release and tag, fix, re-tag v0.1.0
