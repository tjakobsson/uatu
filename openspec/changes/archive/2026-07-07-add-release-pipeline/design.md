# Design — add-release-pipeline

## Context

uatu compiles to a single-file binary via `bun build --compile` (`scripts/build.ts`), but the build only targets the host platform and nothing publishes it. CI (`.github/workflows/ci.yml`) already validates the repo with pinned Bun and pinned action SHAs; there is no release workflow, no tags, and no distribution channel. `package.json` is at `0.1.0`, which will be the first public release — no version bump is part of this change.

Key enabling fact: uatu has zero native modules (the terminal PTY is pure `Bun.spawn(..., { terminal })`), so Bun's `--compile --target=bun-<os>-<arch>` cross-compilation works from a single Linux runner. This is the same approach opencode uses to ship its multi-platform CLI from one Ubuntu job.

## Goals / Non-Goals

**Goals:**
- One-command release: push a `v*` tag, get a GitHub Release with four platform binaries, checksums, provenance attestations, and auto-generated notes.
- One-line install and update for users: `brew install tjakobsson/tap/uatu`, `brew upgrade uatu`.
- Verifiable supply chain from day one: `gh attestation verify <asset> --repo tjakobsson/uatu` passes.
- A stable asset-naming contract that future installers (curl script, npm wrapper) can build on.

**Non-Goals:**
- Windows binaries (Bun's PTY `terminal` option on Windows is unverified; the embedded terminal is a core feature).
- musl/Alpine variants and `-baseline` CPU variants.
- Code signing / notarization. The ad-hoc signature `bun build --compile` produces is sufficient: brew and curl installs never set the quarantine attribute, so Gatekeeper is never consulted (verified empirically against opencode's shipped binaries, which are ad-hoc signed with no Team ID). Browser downloads get a documented `xattr -d com.apple.quarantine` workaround in the README.
- npm publishing (phase 2, builds on these release assets).
- Changelog curation — GitHub auto-generated notes are enough given conventional commits.

## Decisions

### D1: Cross-compile all targets on one Ubuntu runner
`bun build --compile --target=bun-{darwin,linux}-{arm64,x64}` embeds a prebuilt Bun runtime per target; no macOS runner, no matrix. Alternative — an OS matrix with native builds — costs more, is slower, and buys nothing since there are no native deps. The darwin binaries produced this way carry a valid ad-hoc (linker) signature, which Apple Silicon requires; post-release verification on a real Mac confirms it (`codesign -dv` → `Signature=adhoc`).

### D2: Tag push as the release trigger
`on: push: tags: ['v*']`. Simplest flow for a solo maintainer; the version lives in git. A guard step fails the workflow if the tag does not equal `v` + `package.json` version, preventing tag/manifest drift. Alternative — opencode-style `workflow_dispatch` with a bump input — automates the bump but adds a version-mutation commit flow; it can be layered on later without reworking anything.

### D3: `scripts/build.ts` grows a `--target` flag rather than a parallel release script
The existing script already assembles `BuildInfo` (version + git commit) and shells out to `bun build --compile`. Adding optional `--target=<bun-target>` and `--outfile=<path>` arguments keeps one build path shared by dev, CI smoke, and release (per repo convention: one source of truth, no forked scripts). Default behavior without flags is unchanged (host build to `dist/uatu`).

### D4: Asset naming and archive layout are a public contract
`uatu-darwin-arm64.zip`, `uatu-darwin-x64.zip`, `uatu-linux-x64.tar.gz`, `uatu-linux-arm64.tar.gz` — zip for darwin, tar.gz for linux (matches ecosystem convention, e.g. opencode). Each archive contains exactly one file, `uatu`, at the archive root — no nested directory — so the Homebrew formula is a bare `bin.install "uatu"` and a future curl installer is a one-line extract. Changing names or layout later breaks installers and is treated as a breaking change.

### D5: Integrity = SHA256SUMS + GitHub artifact attestations; no signing keys
A `SHA256SUMS` file (over the four archives) is uploaded as a fifth asset — the tap bump job also reads hashes from it. Provenance comes from `actions/attest-build-provenance` (Sigstore-backed, keyless, needs `id-token: write` + `attestations: write`), attesting the four archives. Alternative — self-managed GPG or cosign keys — adds key-management burden for no additional trust in a single-maintainer project.

### D6: Smoke-test before publishing
The runner is linux-x64, so the linux-x64 binary is executed via the existing `bun run smoke` (`scripts/smoke-binary.ts`) before any release is created. The other three targets can't execute on the runner; their guard is D1's deterministic cross-compilation plus post-release manual verification on macOS. Publishing happens only after the smoke passes — a broken release never goes live.

### D7: Homebrew formula in a personal tap, not homebrew-core, and not a cask
New repo `tjakobsson/homebrew-tap` (generic name → `brew install tjakobsson/tap/uatu`; future tools share the repo). A formula (not cask) because casks are macOS-only and the formula serves linuxbrew too. The formula pins per-platform/per-arch `url` + `sha256` (`on_macos`/`on_linux` × `on_arm`/`on_intel`), installs the single binary, and has a `test do` block asserting `uatu --version` output. homebrew-core is out: it requires source builds on their CI and notability thresholds.

### D8: Tap auto-bump as the final release job
After the release is published, a job regenerates `Formula/uatu.rb` wholesale via `scripts/generate-formula.ts` (version + four sha256 values read back from the *published release's* `SHA256SUMS`, not the build directory) and pushes to `tjakobsson/homebrew-tap`. The default `GITHUB_TOKEN` cannot write to another repo, so this uses a fine-grained PAT scoped to contents:write on the tap repo only, stored as a repo secret (`HOMEBREW_TAP_TOKEN`) — the only new credential in the whole pipeline. Because the formula is generated, not edited, no hand-written first formula exists: the v0.1.0 release run populates the tap, the job is a no-op when nothing changed, and a failed run can be re-run from any published release. The tap repo only needs to exist with an initialized default branch.

### D9: Workflow hygiene follows existing repo convention
Pinned action SHAs, pinned Bun version (1.3.14, matching CI), least-privilege permissions declared at workflow level (`contents: write`, `id-token: write`, `attestations: write` — only the release workflow gets these; CI stays read-only). This mirrors the `repository-workflows` spec's reproducibility and least-privilege requirements.

## Risks / Trade-offs

- **[Cross-compiled darwin binaries misbehave in ways the linux smoke can't catch]** → Post-release manual verification task on Tobias's Mac: curl the darwin-arm64 asset, run it, check `codesign -dv` shows `Signature=adhoc`, `gh attestation verify` passes, and `brew install tjakobsson/tap/uatu` works end-to-end. If broken, delete the release and tag, fix, re-tag.
- **[Browser downloads hit Gatekeeper (quarantine + ad-hoc signature)]** → Accepted deliberately; README documents `xattr -d com.apple.quarantine ./uatu` / System Settings approval. Revisit notarization if a browser-download audience materializes.
- **[Tag pushed with mismatched package.json version]** → Guard step (D2) fails the workflow before building.
- **[Tap bump job fails after the release is live]** → Release assets are already valid; the formula bump can be re-run or done by hand. The job is idempotent (rewrites the whole formula from the release's SHA256SUMS).
- **[PAT expiry silently breaks future bumps]** → Failure is loud (red release workflow); the PAT is single-purpose and documented in tasks so re-minting is a five-minute fix.
- **[Bun target strings or compile behavior change across Bun versions]** → Bun version is pinned in the workflow; upgrades happen deliberately with Renovate and are validated by the next release's smoke + manual verification.

## Open Questions

- None blocking. Deferred by design: Windows support (pending Bun PTY-on-Windows verification), musl variants, npm packaging, notarization.
