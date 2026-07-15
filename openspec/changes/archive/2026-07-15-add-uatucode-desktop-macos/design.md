# Design: add-uatucode-desktop-macos

## Context

A working SwiftUI prototype (`~/Developer/yugatabe`, bundle id `se.coll8.uatucode`,
macOS 26 deployment target) validates the wrapper model: spawn `uatu serve <folder>
--no-open` as a child process, parse the tokened URL from stdout, load it in the
new SwiftUI `WebPage`/`WebView`. The uatu side already cooperates well:

- When stdout is not a TTY, `uatu serve` prints exactly one line — the tokened URL
  (spec-backed in `serve-cli-startup`). The wrapper's pipe is never a TTY, so URL
  parsing is a stable contract, not banner-scraping.
- `uatu` handles SIGTERM cleanly (`src/cli.ts` shutdown path), so clean app quit
  already works. Crash-orphaning is the remaining gap.

The release pipeline (`release.yml`) cross-compiles `bun-darwin-arm64` /
`bun-darwin-x64` / two Linux targets from one Linux runner, publishes zips +
SHA256SUMS, and an `update-tap` job regenerates `Formula/uatu.rb` in
`tjakobsson/homebrew-tap` via `scripts/generate-formula.ts`.

Constraint: Apple Developer Program enrollment is **in progress but not complete**.
Signing and notarization credentials do not exist yet; the pipeline must be
buildable and testable before they do.

## Goals / Non-Goals

**Goals:**

- UatuCode Desktop lives in-tree and rides the existing release train.
- `brew install --cask tjakobsson/tap/uatu-desktop` works once signing is live.
- Everything except sign/notarize/cask-publish works before Apple enrollment
  completes (ad-hoc builds locally and as CI artifacts).
- Wrappers on any OS can supervise uatu without orphan risk
  (`--exit-on-stdin-close` is cross-platform).

**Non-Goals:**

- No uatu server or web-UI changes; the browser stays a first-class client.
- No Linux/Windows wrapper in this change (the `desktop/` layout leaves room).
- No App Store distribution (the app spawns processes and PTYs; sandboxing is
  incompatible). Developer ID + notarization only.
- No new IPC/API between app and server beyond the existing URL-on-stdout
  contract.

## Decisions

### D1: In-repo under `desktop/macos/`, not a separate repo

The app bundles the `uatu` binary built in the same release run. In-repo means one
release train (release-please versions both together), no cross-repo version
matrix, and the app job simply downloads the darwin binaries built earlier in the
same workflow. Alternative — separate repo — keeps Xcode out of uatu CI but costs
a synchronized-release process for zero user benefit.

### D2: Naming and identity

- App / product name: **UatuCode Desktop** (menu bar, About box, `.app` name
  `UatuCode Desktop.app`).
- Bundle id: `se.coll8.uatucode.desktop` (prototype used `se.coll8.uatucode`;
  add `.desktop` so a future iOS/other variant isn't squatted on).
- Cask token: `uatu-desktop`. Release asset naming follows the existing contract
  style: `UatuCode-Desktop-<arch>.zip`.
- All Swift target/scheme names say `UatuCodeDesktop`; the `yugatabe` codename
  does not survive the import.

### D3: Execute the bundled binary directly; drop the login shell

The prototype ran `zsh -l -c "uatu serve ..."` to find a PATH-installed uatu and
inherit user PATH. In-tree builds always embed the binary at
`Contents/Resources/uatu`, so the app calls `Process` with
`executableURL = <bundled uatu>` directly: faster startup, no rc-file side
effects, no shell-quoting surface. Spawn arguments: `serve <folder> --no-open
--exit-on-stdin-close`.

**Amendment (found in manual testing):** uatu's PTY spawns the terminal shell
as an interactive *non-login* shell (`src/terminal/server.ts` — no `-l`), so it
inherits uatu's environment. Under the GUI app that environment is
launchd-minimal and user rc files break (`starship`/`mise` not on PATH). Fix at
the app layer, VS Code-style: capture the user's login-shell environment once
per app run (`$SHELL -l -c "/usr/bin/env -0"`, cached, resolved off the main
actor) and launch every uatu child with it, with a static fallback PATH
extension if the probe fails. uatu's own PTY semantics stay unchanged for CLI
users.

### D4: `--exit-on-stdin-close` as an explicit opt-in flag

The server watches stdin for EOF and runs the existing shutdown path when it
closes. Explicit flag rather than automatic-when-piped: `uatu serve | tee log`
and CI invocations legitimately pipe stdout/stdin without wanting
lifetime-coupling. Implementation lives in `src/cli.ts` next to the SIGINT/SIGTERM
wiring and reuses the same `shutdown` function; `src/cli/parse.ts` gains the flag
and usage text. The wrapper keeps `willTerminateNotification` → SIGTERM for clean
quits; stdin EOF is the crash backstop.

### D5: Release job shape — two single-arch apps, credential-gated signing

- New `desktop-macos` job in `release.yml` on a macOS runner, after the binary
  build job; downloads `uatu-darwin-arm64` / `uatu-darwin-x64`, builds the app
  twice (`ARCHS=arm64` / `x86_64`), embedding the matching binary. Bun cannot emit
  universal binaries and lipo-ing Bun output is unproven, so two apps +
  `on_arm`/`on_intel` blocks in the cask (boring, reliable).
- **Secrets present** (`MACOS_CERT_P12`, `MACOS_CERT_PASSWORD`,
  `NOTARY_KEY_ID`/`NOTARY_ISSUER`/`NOTARY_KEY`): import cert into a throwaway
  keychain, codesign nested binary + app with hardened runtime, `notarytool
  submit --wait`, staple, zip (`ditto -c -k --keepParent`), upload to the release,
  append to SHA256SUMS.
- **Secrets absent**: build ad-hoc-signed (`codesign -s -`), upload as a
  *workflow artifact* only with a step-summary warning. Unsigned apps are never
  attached to the GitHub release — a quarantined unsigned .app is a support trap.
- `update-tap` generates `Casks/uatu-desktop.rb` only when the release contains
  the signed app archives; formula generation is unchanged. Cask generation is a
  sibling script (`scripts/generate-cask.ts`) sharing the SHA256SUMS parsing.

### D6: Entitlements for the embedded Bun binary

Bun-compiled binaries use JavaScriptCore, which JITs. Under hardened runtime the
nested `Resources/uatu` binary gets its own codesign pass with
`com.apple.security.cs.allow-jit`. The app binary itself needs no JIT
entitlement.

**Spike result (task 1.1, ad-hoc `codesign --options runtime`, Bun 1.3.14,
macOS 26):** uatu serves, indexes, renders markdown, and spawns terminal PTYs
both with only `allow-jit` and with **zero entitlements** (JSC falls back to
non-JIT execution when MAP_JIT is unavailable). Neither
`allow-unsigned-executable-memory` nor `disable-library-validation` is needed.
Ship with `allow-jit` only — it keeps full JIT performance and is uncontroversial
for notarization.

### D7: Local development loop

`desktop/macos/` builds standalone in Xcode. A build phase (or
`scripts/embed-uatu.sh`) copies the binary from an `UATU_BINARY` env/xcconfig
setting, defaulting to `../../dist/uatu` (produced by `bun run build`). If the
binary is missing the build fails with a clear message rather than producing an
app that silently falls back to PATH lookup — there is no PATH fallback anymore
(D3).

### D8: CI coverage for the Swift code

`ci.yml` gains a path-filtered job (`desktop/macos/**`) that runs
`xcodebuild build` (and unit tests if present) on a macOS runner for PRs touching
the desktop tree. Path-filtering keeps expensive macOS minutes off unrelated PRs.

## Risks / Trade-offs

- **[Bun binary rejected by hardened runtime / notarization]** → Task 0 spike
  before any pipeline work; fallback is entitlement tuning
  (`allow-unsigned-executable-memory`, `disable-library-validation`) which
  notarization accepts.
- **[macOS 26 deployment target excludes older machines]** → The SwiftUI
  `WebPage` API is new; accept the high floor for v1 (this is a companion app,
  the browser UI still works everywhere) and note it in the README.
- **[Secrets-absent path rots once signing goes live]** → The gate is one `if:` on
  the signing steps; keep the ad-hoc path exercised by the PR-triggered CI job
  (D8) so it stays green.
- **[Release job runs on macOS runners: slower, pricier]** → Only on tag pushes;
  PR CI is path-filtered.
- **[stdin EOF flag misused interactively]** → Opt-in flag (D4); usage text says
  it is intended for supervising wrapper processes.
- **[Xcode project file merge conflicts]** → Single-target project, low churn;
  revisit XcodeGen/Tuist only if it becomes a real problem.

## Migration Plan

1. Ship the app + flag + unsigned pipeline (works immediately; ad-hoc artifacts
   dogfoodable).
2. When Apple enrollment completes: add the five secrets, re-run the release
   workflow (or cut the next release) — signing steps activate, cask publishes.
3. Rollback: delete the cask from the tap; the desktop job is additive and cannot
   break formula users.

**Status (2026-07-15):** Apple enrollment completed (team `H6T3Q25453`) and the
full signed path was rehearsed locally end to end: Developer ID signing of the
embedded binary (JIT entitlement) and app, `notarytool submit` → **Accepted**,
staple, and `spctl` assessment `accepted — source=Notarized Developer ID`. All
five repository secrets (`MACOS_CERT_P12`, `MACOS_CERT_PASSWORD`,
`NOTARY_KEY_ID`, `NOTARY_ISSUER`, `NOTARY_KEY`) are set, and the p12 was
verified to import in a CI-style throwaway keychain. Local credential copies
live in `~/Developer/uatu-signing/` (mode 700). Remaining from step 2: cut a
release and verify `brew install --cask` on a clean machine.

## Open Questions

- Cask asset format: plain zip (matches existing contract) vs dmg (nicer install
  UX). Starting with zip; dmg is a cosmetic follow-up.
- Whether `WebPage`'s default website data store persists uatu localStorage
  (pane sizes, view modes) across relaunches — verify during import; switch to an
  explicitly persistent store if not.
