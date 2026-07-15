# Tasks: add-uatucode-desktop-macos

## 1. Spike: Bun binary under hardened runtime

- [x] 1.1 Ad-hoc codesign `dist/uatu` with `--options runtime` plus a
      `com.apple.security.cs.allow-jit` entitlements plist; run `uatu serve` on a
      test folder and confirm indexing, rendering, and the embedded terminal work.
      Record which entitlements are actually required (try dropping
      `allow-unsigned-executable-memory` etc.) in design.md's D6.

## 2. uatu CLI: --exit-on-stdin-close

- [x] 2.1 Add `--exit-on-stdin-close` to `src/cli/parse.ts` (flag parsing + usage
      text describing the supervising-wrapper purpose) with parse tests.
- [x] 2.2 In `src/cli.ts`, when the flag is set, watch stdin for EOF and invoke
      the existing `shutdown` path; ensure no stdin consumption happens without
      the flag. Unit-test the EOF→shutdown wiring where feasible.
- [x] 2.3 Integration check: spawn the built binary with a piped stdin, close the
      pipe, assert clean exit 0; and without the flag, assert the server survives
      stdin close.

## 3. Import the app under desktop/macos

- [x] 3.1 Create `desktop/macos/` with a fresh Xcode project named
      `UatuCodeDesktop` (product "UatuCode Desktop", bundle id
      `se.coll8.uatucode.desktop`); port `UatuServer.swift`, `ContentView.swift`,
      and the app entry from the prototype, renaming all `yugatabe` identifiers.
- [x] 3.2 Replace the `zsh -l` launch with direct `Process` execution of the
      bundled binary, passing `serve <folder> --no-open --exit-on-stdin-close`,
      and keep stdin held open by the app (the pipe is the lifetime tether).
- [x] 3.3 Add the embed-binary build phase: copy from `UATU_BINARY` (default
      `../../dist/uatu`) into Resources; fail the build with a clear message when
      missing. Remove every PATH-fallback code path.
- [x] 3.4 Port/recreate the app icon and launcher logo assets under the
      UatuCode Desktop name.
- [x] 3.5 Verify `WebPage` persists uatu localStorage across relaunch; if not,
      configure a persistent website data store (design.md open question).
- [x] 3.6 Manual pass on the failure states: kill the child server externally and
      confirm the window lands in the failed state with output tail, retry works.

## 4. CI for the desktop tree

- [x] 4.1 Add a path-filtered `desktop-macos` job to `ci.yml`: macOS runner,
      `bun run build` for the binary, `xcodebuild build` (ad-hoc signing), runs
      only when `desktop/macos/**` changes.

## 5. Release pipeline

- [x] 5.1 Add the `desktop-macos` job to `release.yml`: download
      `uatu-darwin-{arm64,x64}` from the build job, build the app per arch,
      produce `UatuCode-Desktop-<arch>.zip` via `ditto`.
- [x] 5.2 Implement the signing gate: with `MACOS_CERT_P12`/`MACOS_CERT_PASSWORD`
      and `NOTARY_KEY_ID`/`NOTARY_ISSUER`/`NOTARY_KEY` present — throwaway
      keychain, codesign nested binary (hardened runtime + spike-proven
      entitlements) then the app, `notarytool submit --wait`, staple, attach zips
      to the release, extend SHA256SUMS. Without secrets — ad-hoc sign, upload as
      workflow artifacts, warn in the step summary, attach nothing to the release.
- [x] 5.3 Add `scripts/generate-cask.ts` emitting `Casks/uatu-desktop.rb`
      (`on_arm`/`on_intel` URLs + sha256 from SHA256SUMS, `app` stanza, version);
      wire it into the `update-tap` job, skipping when the release lacks signed
      app archives. Cover the generator with unit tests like the formula
      generator.

## 6. Docs and follow-ups

- [x] 6.1 README: add the cask install command and a short UatuCode Desktop
      section (macOS version floor, relationship to the CLI).
- [x] 6.2 CLAUDE.md + ARCHITECTURE.md: document the `desktop/` tree and the
      wrapper↔CLI contract (URL on stdout, SIGTERM, `--exit-on-stdin-close`).
- [x] 6.3 Once Apple Developer enrollment completes: add the five signing
      secrets and rehearse the signed path locally (sign → notarize → staple →
      Gatekeeper `accepted`). Done 2026-07-15; see design.md Migration Plan
      status note.
