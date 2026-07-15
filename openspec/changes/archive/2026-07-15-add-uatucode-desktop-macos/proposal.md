# Proposal: add-uatucode-desktop-macos

## Why

uatu installs as a CLI via a Homebrew formula but lives in a browser tab; a native
macOS app makes it a first-class desktop citizen — dock presence, its own windows,
menu bar, recents — installable as `brew install --cask tjakobsson/tap/uatu-desktop`.
A working SwiftUI prototype (`~/Developer/yugatabe`) already proves the model:
spawn the bundled `uatu serve` binary, load its tokened URL in a WebView. This
change brings it in-tree as **UatuCode Desktop** and wires it into the existing
release train.

## What Changes

- Import the prototype into the repo under `desktop/macos/` as "UatuCode Desktop"
  (SwiftUI app: launcher with recents, per-window server supervision, WebView,
  menu-bar commands, failure states).
- Execute the bundled `uatu` binary directly instead of via a `zsh -l` login shell
  (the login-shell indirection existed only to find a PATH-installed uatu; in-tree
  builds always bundle the binary).
- Add a `--exit-on-stdin-close` flag to `uatu serve`: the server exits when its
  standard input reaches EOF, so a crashed wrapper can never orphan the server.
  Cross-platform — any future Linux/Windows wrapper gets the same guarantee.
- Extend `release.yml` with a macOS-runner job that builds the app for arm64 and
  x64, embeds the matching `uatu` binary, and — **gated on Developer ID secrets
  that do not exist yet** — codesigns, notarizes, and staples. Without secrets the
  job builds ad-hoc-signed apps as workflow artifacts and warns; it does not
  attach unsigned apps to the release.
- Extend the tap-update step to also generate `Casks/uatu-desktop.rb` when signed
  app archives are present on the release.
- Early spike task: verify a Bun-compiled binary survives hardened-runtime
  codesigning (JavaScriptCore JIT likely requires the
  `com.apple.security.cs.allow-jit` entitlement on the nested binary).

## Capabilities

### New Capabilities

- `desktop-macos-shell`: the UatuCode Desktop app itself — launching and
  supervising the bundled `uatu serve` child per window, the folder
  launcher/recents surface, WebView hosting of the served UI, menu-bar commands,
  and failure/recovery states.
- `desktop-distribution`: how the desktop app is built and shipped — repo layout
  under `desktop/`, binary embedding, the release-workflow job, signing and
  notarization gating on credential availability, and the Homebrew cask in the tap.

### Modified Capabilities

- `serve-cli-startup`: gains the `--exit-on-stdin-close` flag (exit cleanly on
  stdin EOF so supervising wrappers cannot orphan the server).

## Impact

- **New code**: `desktop/macos/` (Xcode project, Swift sources, app assets).
- **Modified code**: `src/cli/parse.ts` (new flag + usage text), `src/cli.ts`
  (stdin EOF watcher wired to the existing shutdown path).
- **CI/CD**: `.github/workflows/release.yml` gains a macOS job; tap generation
  script(s) gain cask output; new repository secrets once Apple Developer
  enrollment completes (Developer ID Application cert, notarytool API key).
- **Docs**: README install section gains the cask; `CLAUDE.md`/`ARCHITECTURE.md`
  note the `desktop/` tree.
- **Out of scope**: no uatu server/UI architecture changes (the browser remains a
  first-class client), no Linux/Windows wrapper yet, no App Store distribution.
