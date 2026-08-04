# Design: add-uatu-edge-channel

## Context

The nightly edge pipeline (`.github/workflows/desktop-edge.yml`) already does most of the work: it compiles `darwin-arm64` and `darwin-x64` CLI binaries (to embed in the desktop app), computes the monotonic edge version `<base>-edge.<utc-timestamp>.<shortsha>`, publishes to the rolling `edge` prerelease with attestation + Sigstore bundles, and reconciles the `uatu-desktop@edge` cask in the tap. The stable release workflow (`release.yml`) defines the CLI asset contract: `uatu-darwin-*.zip` / `uatu-linux-*.tar.gz`, each holding a single `uatu` binary at archive root, listed in `SHA256SUMS`, with `<archive>.sigstore.json` siblings. `scripts/generate-formula.ts` emits the stable formula but is a non-parameterized script (unlike `scripts/generate-cask.ts`, which already exports a testable `generateCask(version, sums, {name, tag})` used by both channels).

One version wrinkle: the formula's `test do` asserts `version.to_s` appears in `uatu --version` output, and the binary's version is baked in at compile time from `package.json` (`scripts/build.ts` → `__UATU_BUILD__`). An edge formula versioned `0.x.y-edge.…` would fail its own test against a binary reporting plain `0.x.y` — and users couldn't tell an edge binary from stable anyway.

## Goals / Non-Goals

**Goals:**
- `brew install tjakobsson/tap/uatu-edge` installs last night's `main` on macOS and Linux.
- Edge CLI archives carry the same integrity artifacts as stable ones (SHA256SUMS entries, attestation, Sigstore bundles on the release).
- `uatu --version` on an edge binary reports the edge version string.
- The channel self-heals: partial publishes are completed by the next nightly, transient tap failures reconcile without a rebuild.

**Non-Goals:**
- No separate edge release cadence or trigger — the CLI rides the existing nightly.
- No changes to stable releases, `Formula/uatu.rb`, or Release Please.
- No npm/other distribution channels; Homebrew tap + GitHub release assets only, matching stable.
- No product-code changes in `src/`.

## Decisions

### One nightly workflow, one rolling release

Extend the existing nightly workflow rather than adding a second one, and publish CLI archives to the same `edge` prerelease the desktop apps use. This mirrors stable (one release carries both products), keeps a single skip guard / version stamp / tag move (so CLI and desktop edge assets are always from the same commit), and reuses the existing macos-26 job, which must build the darwin CLI binaries anyway. The file is renamed `desktop-edge.yml` → `edge.yml` (workflow name "Edge", concurrency group `edge`) since it no longer covers only the desktop app.

*Alternative considered:* a separate `cli-edge.yml` on a Linux runner (cheaper per-minute, mirrors `release.yml`'s runner choice). Rejected: two guards racing over one release/tag invites skew — a nightly where CLI assets are from a different commit than the desktop apps — and Bun cross-compiles all four targets from any host, so runner choice is not a constraint.

### CLI assets keep the stable naming contract

The edge release gains `uatu-darwin-arm64.zip`, `uatu-darwin-x64.zip`, `uatu-linux-x64.tar.gz`, `uatu-linux-arm64.tar.gz` plus one `.sigstore.json` per archive, and the CLI entries join the release's `SHA256SUMS`. Same names as stable — the channel is distinguished by the release tag (`edge` vs `v*`), exactly as the desktop cask already does. The skip guard's required-asset list grows by these eight names, so a partial publish is retried rather than skipped.

### Version override in the build script

`scripts/build.ts` gains a `--version <string>` flag that overrides `BuildInfo.version` (default unchanged: `package.json`). The edge workflow computes the edge version *before* compiling and passes it to every target build, so binaries self-identify (`uatu --version` → `v0.x.y-edge.… · <sha>`) and the generated formula's `test do` passes unmodified. Compile therefore moves after the version step in the workflow.

*Alternative considered:* leaving binaries stamped with the base version and weakening the edge formula's test to match only the base. Rejected: an edge binary indistinguishable from stable is a support trap, and channel-conditional test logic in the generator is more complexity than a build flag.

### `generate-formula.ts` mirrors `generate-cask.ts`

Refactor to export `parseSums` (or import the cask's) and `generateFormula(version, sums, {name, tag})`, keeping the CLI wrapper. `--name uatu-edge --tag edge` produces `Formula/uatu-edge.rb`: class name `UatuEdge` (a dash token — Homebrew's filename→class rule only rewrites `@` before a digit, so an `@edge` formula could never load; cask tokens have no such rule, which is why the desktop channel keeps `uatu-desktop@edge`), URLs pointing at the `edge` tag, and `conflicts_with formula: "uatu"` / the stable formula generated with `conflicts_with formula: "uatu-edge"` — both channels install the same `bin/uatu`, so exactly one may be installed, mirroring the cask pair. A colocated `scripts/generate-formula.test.ts` covers both channels, following `generate-cask.test.ts`.

Note: adding `conflicts_with` to the stable formula's output means the next *stable* release also updates `Formula/uatu.rb` — acceptable, since the tap regenerates it wholesale each release anyway.

### Smoke test before publishing

Stable releases smoke-test the binary that the runner can execute before anything publishes; edge follows suit. The macos-26 (arm64) runner runs `bun run smoke` with `UATU_SMOKE_BINARY=dist/darwin-arm64/uatu` after compiling, before the desktop build. A broken nightly binary fails the run red — nothing publishes, the previous night's assets stay in place.

### Tap job generates the formula alongside the cask

The existing `update-tap` reconciliation job additionally runs the formula generator with `--name uatu-edge --tag edge` and commits `Formula/uatu-edge.rb` in the same push. It keeps the reconcile-on-every-run semantics: a skipped-build nightly still repairs a previously failed tap update. Unlike the cask (which is skipped when SHA256SUMS lacks app archives, exit 2), the formula generation is unconditional — CLI archives are always on a complete edge release; a missing entry is a real error.

## Risks / Trade-offs

- [Guard asset list drifts as products are added] → The list now lives in one workflow step covering both products; the spec scenario enumerates the full set so drift is caught at review time.
- [`--version` flag misuse could stamp a lying stable release] → The stable release workflow doesn't pass the flag, and its existing tag-vs-package.json and binary-reports-version guards would catch a mismatch anyway.
- [Cross-compiled linux binaries aren't executed on the macos runner] → Same exposure as stable (which only smoke-tests linux-x64); Bun's cross-compilation is byte-identical bundling, and the darwin smoke covers the bundle. Accepted.
- [Longer nightly wall-clock (two more compiles + smoke + Playwright Chromium install)] → Minutes on a scheduled job; timeout raised only if it proves tight.
- [Workflow file rename loses GitHub Actions run history association] → Cosmetic only; the schedule, concurrency group, and permissions carry over. Any external links to the old file name (none known beyond docs) are updated.

## Open Questions

None.
