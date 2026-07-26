# Tasks — add-desktop-git-init

## 1. Git helper (probe + init)

- [x] 1.1 Add a git helper to the desktop target (e.g. `GitPreflight.swift` alongside `UatuServer.swift`) with an async `isInsideGitWorktree(_ folder: URL, environment:) -> Bool?` that runs `git rev-parse --show-toplevel` via Process off the main actor, mirroring the `loginEnvironment` pattern (captured output, `waitUntilExit`, exit-code check); return `nil` when the git executable cannot be launched
- [x] 1.2 Add `initializeRepository(at folder: URL, environment:) -> Result<Void, GitInitError>` running `git init` with `currentDirectoryURL = folder`, capturing stderr for the failure message
- [x] 1.3 Reuse the resolved login-shell environment from `UatuServer` for both calls (expose it or accept it as a parameter) so git resolves from the user's real `PATH`

## 2. ContentView interception

- [x] 2.1 In `ContentView.open(_:)`, run the worktree probe before recording recents / starting the server; on `true` or `nil` (git unlaunchable) keep today's behavior unchanged
- [x] 2.2 Add `@State` for the pending non-git folder and present a confirmation dialog ("This folder isn't a git repository. Initialize one to start a new project?") when the probe returns `false`
- [x] 2.3 On confirm: run `git init`; on success record the recent entry and call `server.start(folder:)`; on failure route the git stderr into the window's `.failed` state so the existing "Try Again" / "Choose Folder…" actions apply
- [x] 2.4 On cancel: clear the pending state and return to the launcher without spawning a server or recording a recent entry
- [x] 2.5 Confirm every open entry point funnels through the preflight (picker, recents list, menu "Choose Folder…", "Open Recent" submenu, failed-state "Choose Folder…")

## 3. Verification

- [x] 3.1 Build the app locally (`bun run build` then the Xcode project, which embeds `dist/uatu`) and verify: non-git folder → dialog → confirm → repo created and session loads; decline → launcher, no recent entry; existing repo and repo-subdirectory → no dialog
- [x] 3.2 Verify the failure paths: `git init` in an unwritable folder shows the failed state with git's error; with git masked from PATH the app skips the dialog and shows today's CLI failure
- [x] 3.3 Run the desktop CI checks locally as applicable (`desktop-ci.yml` path filter covers this change); no `src/` or unit/e2e suite impact expected
