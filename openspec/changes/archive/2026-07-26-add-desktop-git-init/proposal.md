# Add desktop git init

## Why

When a user picks a folder that is not inside a git repository, UatuCode Desktop today launches `uatu serve`, the CLI's git preflight rejects the folder, and the window lands in the failed state showing raw CLI error text ("not inside a git repository… Use --force…"). There is no path forward inside the app — the user cannot start a brand-new project from an empty or freshly created folder without dropping to a terminal.

## What Changes

- The desktop app detects, at folder-open time, whether the selected folder is inside a git worktree (running `git rev-parse --show-toplevel` via the same login-shell environment the server spawn already resolves).
- When the folder is not a git repository, the app presents a confirmation dialog offering to initialize a new repository there so the user can begin a new project.
- On confirmation the app runs `git init` in the folder and then starts the server as usual; on decline it returns to the launcher without starting the server (avoiding the guaranteed CLI failure).
- If `git` is unavailable or `git init` fails, the app surfaces the error in the existing failed-state UI instead of a raw CLI dump.
- No CLI changes: the `serve` git preflight and `--force` behavior in `serve-cli-startup` stay as-is; the desktop app satisfies the preflight by creating the repository before spawning.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `desktop-macos-shell`: folder opening gains a git-repository preflight — non-git folders trigger an offer to initialize a repository (with init-then-serve on confirm, return-to-launcher on decline, and error surfacing on git failure) instead of unconditionally spawning a server that will fail.

## Impact

- **Code**: `desktop/macos/UatuCodeDesktop/ContentView.swift` (intercept in `open(_:)`, new confirmation dialog state), `desktop/macos/UatuCodeDesktop/UatuServer.swift` or a new small helper (git detection + `git init` runner following the existing `loginEnvironment` Process pattern).
- **Dependencies**: relies on `git` from the user's login `PATH` (or `/usr/bin/git` via Xcode CLT); git is not bundled.
- **Specs**: delta on `desktop-macos-shell`; `serve-cli-startup` is referenced but unchanged.
- **CI**: desktop-only change — covered by the path-filtered `desktop-ci.yml` workflow; no `src/` or test-suite impact.
