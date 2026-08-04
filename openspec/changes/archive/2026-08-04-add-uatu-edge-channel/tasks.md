# Tasks: add-uatu-edge-channel

## 1. Build-script version override

- [x] 1.1 Add a `--version <string>` flag to `scripts/build.ts` that overrides `BuildInfo.version` (default: `package.json` version, behavior otherwise unchanged), and thread it through the `__UATU_BUILD__` injection

## 2. Formula generator refactor

- [x] 2.1 Refactor `scripts/generate-formula.ts` to mirror `generate-cask.ts`: export `generateFormula(version, sums, {name, tag})` (reusing/sharing `parseSums`), keep the CLI wrapper, add `--name` / `--tag` flags; derive the Ruby class name from the formula name (`uatu` → `Uatu`, `uatu-edge` → `UatuEdge`)
- [x] 2.2 Emit reciprocal `conflicts_with formula:` lines — stable conflicts with `uatu-edge`, edge conflicts with `uatu` — and point edge URLs at the `edge` release tag
- [x] 2.3 Add `scripts/generate-formula.test.ts` covering both channels (asset URLs per tag, sha256 wiring, class names, conflicts, missing-sum failure), following `generate-cask.test.ts`

## 3. Edge workflow

- [x] 3.1 Rename `.github/workflows/desktop-edge.yml` → `edge.yml` (workflow name "Edge", concurrency group `edge`) and update the header comment for the two-product scope
- [x] 3.2 Move the version computation before compilation and compile all four CLI targets (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`) with `--version` set to the edge version
- [x] 3.3 Smoke-test the host-runnable binary (`bun run smoke` with `UATU_SMOKE_BINARY=dist/darwin-arm64/uatu`, Playwright Chromium installed) before the desktop build
- [x] 3.4 Package CLI archives under the stable naming contract (zip for darwin, tar.gz for linux, single `uatu` at archive root) into `dist/release`, include them in SHA256SUMS, attest them, and download their Sigstore bundles alongside the desktop ones
- [x] 3.5 Upload the CLI archives and bundles to the `edge` release and extend the skip guard's required-asset list with the four CLI archives and their four `.sigstore.json` bundles
- [x] 3.6 Extend the `update-tap` job to also generate `Formula/uatu-edge.rb` (`--name uatu-edge --tag edge`, unconditional — no exit-2 skip path) and commit it together with the cask

## 4. Docs and verification

- [x] 4.1 Update `README.md`: CLI edge install instructions (`brew install tjakobsson/tap/uatu-edge`, switch-back command) next to the desktop edge section
- [x] 4.2 Run `bun test` (including the new generator tests), `bunx tsc --noEmit`, and `actionlint` if available; verify a local `bun run scripts/build.ts --version 0.0.0-edge.test` binary reports the override in `--version`

After merge: trigger the Edge workflow manually (`workflow_dispatch`) and confirm the `edge` release carries the full asset set, the smoke gate ran, and `tjakobsson/homebrew-tap` gained `Formula/uatu-edge.rb`; then `brew install tjakobsson/tap/uatu-edge` on a test machine and check `uatu --version` reports the edge version. Note the stable formula only gains its `conflicts_with` line at the next stable release, when the tap regenerates `Formula/uatu.rb`.
