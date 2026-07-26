# Design — add-desktop-git-init

## Context

The CLI's `serve` startup has a git preflight (`serve-cli-startup`): every watched root MUST be inside a git worktree, otherwise `uatu serve` throws `"<paths> not inside a git repository… Use --force to serve non-git paths anyway."` and exits. The desktop app (`desktop/macos/UatuCodeDesktop`) does no detection of its own — `ContentView.open(_:)` (ContentView.swift:316-323) records the recent entry and calls `server.start(folder:)` unconditionally, so a non-git folder always ends in the `.failed` state with the tail of the CLI's stderr (UatuServer.swift:190-194 even has a comment naming "non-git folder" as a known cause).

The app already resolves the user's login-shell environment once per run (`UatuServer.loginEnvironment`, UatuServer.swift:124-154) using a Process pattern that captures output, waits, and checks the exit code — the exact shape a git probe and `git init` runner need.

## Goals / Non-Goals

**Goals:**
- Detect non-git folders in the desktop app before spawning the server.
- Offer to run `git init` so the user can begin a new project from any folder, then serve it.
- Replace the raw CLI-error dead end with a clear, native decision point.

**Non-Goals:**
- No CLI changes: the `serve` git preflight and `--force` stay exactly as specified; the app never passes `--force`.
- No initial commit, no `.gitignore` scaffolding, no branch-name configuration — plain `git init` only.
- No git detection for the web/PWA flow (`uatu serve` run manually keeps its current behavior).
- No bundling of git.

## Decisions

### D1: Preflight in the app, not `--force` or CLI changes

Alternatives: (a) pass `--force` and rely on the CLI's degraded non-git mode, (b) add an init affordance to the CLI/SPA, (c) detect in Swift before spawning. Chosen: (c). `--force` produces a permanently degraded session (review-load emits `status: "non-git"`, diff/git-log no-op) — the user wanted a *project*, not a degraded viewer. CLI changes would push a GUI concern into a shared surface and break the "wrapper satisfies the preflight" symmetry. Detecting in Swift keeps the CLI contract untouched and the UX native.

### D2: Detection via `git rev-parse --show-toplevel` in the folder

Run `git -C <folder> rev-parse --show-toplevel` with the resolved login environment; exit 0 → repo (possibly a parent — that's fine, same rule the CLI applies), non-zero → not a repo. This mirrors the CLI's own check (`src/server/roots.ts:88-99`) so app and CLI can't disagree. If `git` itself cannot be launched, treat it as "cannot init" — proceed to spawn the server anyway and let the existing failure state explain (we can't init without git either, so blocking would help nobody).

### D3: Intercept in `open(_:)` with a SwiftUI confirmation dialog

`open(_:)` is the single funnel for the picker, recents list, and menu commands, so one interception covers every entry point. Present a `.confirmationDialog`/`.alert` ("This folder isn't a git repository. Initialize one to start a new project?") driven by new `@State` holding the pending folder URL, following the app's existing boolean-presentation idiom (`isPickingFolder`). Alternative considered: reactively parsing the CLI's error string in the `.failed` state and offering an "Initialize" button — rejected as string-matching on error text, and it wastes a spawn/fail cycle.

- **Confirm** → run `git init` (Process, `currentDirectoryURL = folder`, login environment, mirroring `loginEnvironment`'s pattern) off the main actor; on exit 0, proceed to `server.start(folder:)`.
- **Cancel** → return to the launcher; do not spawn (it would only fail). The folder is still recorded in recents only if the serve actually starts, so declined folders don't pollute the list.
- **`git init` fails** → surface stderr through the existing `.failed` state machinery (reuse `ServerStatus.failed` with the git output) so there's one error surface, not two.

### D4: The probe and init run off the main actor

Both are blocking `waitUntilExit()` calls; run them the same way `loginEnvironment` is resolved (detached/background) so the UI never beachballs on a slow filesystem or network mount. The dialog state transition happens back on the main actor.

## Risks / Trade-offs

- [git missing (no Xcode CLT, exotic setups)] → detection treats "git unlaunchable" as pass-through: spawn the server and let the existing failed state report, same as today. No new dead end.
- [Race: folder becomes a repo (or vanishes) between probe and init] → `git init` is idempotent on existing repos and fails cleanly on missing paths; failure routes to the existing `.failed` surface.
- [Blocking probe adds latency to every folder open] → the probe is a single fast local git invocation run off-main with the UI already showing the starting state only after it passes; measured cost is negligible next to server spawn.
- [User declines but wanted the old degraded `--force` behavior] → out of scope; power users can run `uatu serve --force` from a terminal. The dialog copy stays neutral ("Cancel" simply returns to the launcher).

## Open Questions

None — resolved during design (no `--force` path in the app, plain `git init` without scaffolding).
