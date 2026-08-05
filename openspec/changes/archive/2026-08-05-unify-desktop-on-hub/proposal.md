# Unify UatuCode Desktop on the hub

## Why

UatuCode Desktop currently spawns a bundled `uatu serve` child per window, while `uatu hub` (merged in [#162](https://github.com/tjakobsson/uatu/issues/162), not yet released) provides the same session management with a proxy, dashboard, and auth — two parallel session-lifecycle implementations with no way for the desktop app to reach a remote hub. Unifying the desktop on the hub gives one code path (desktop windows are hub clients), makes remote hubs first-class in the desktop app, and lets hub dashboard improvements reach desktop users automatically. The hub is unreleased, so its workspace model can still change freely before the 0.5.0 release.

## What Changes

- The hub's workspace model inverts from "folders under one `workspacesDir` root" to "any absolute path registered explicitly". `workspacesDir`, the registration-time root constraint, and the startup prune of out-of-root entries are removed. (The hub has never shipped in a release, so this is a free change — a startup error names the removed key for anyone with an experimental edge-build config.)
- The hub dashboard's "create workspace" flow becomes **Add Folder**: a server-side directory browser for picking any folder to register (replacing the workspaces-root folder listing). Clone keeps working by picking a destination directory the same way.
- The hub gains a `--local` mode: loopback-only bind, no configured users, authentication bypassed — the trusted single-user mode the desktop app runs.
- The hub gains an `--exit-on-stdin-close` orphan backstop (same contract `uatu serve` already has) so a crashed supervisor never leaves a headless hub running.
- UatuCode Desktop stops spawning `uatu serve` per window and instead supervises **one app-owned local hub** (`uatu hub --local`); every window/tab is a WKWebView pointed at a hub — local or remote.
- The desktop launcher becomes a **hub splash**: a card per hub ("This Mac" plus configured remote hubs) with reachability/auth/running-summary state, Choose Folder… (registers into the local hub), and Add Hub….
- The desktop gains **remote hub connect**: add a hub by URL, native login against `POST /login` (JSON), credentials in the Keychain, the `uatu_hub` cookie held natively and injected into the WKWebView cookie store, silent re-login on cookie expiry.
- The hub reports its uatu version to authenticated clients: `/api/hub/state` carries it and the dashboard displays it, so both browser users and the desktop splash can see what a hub is running.
- Quit-time UX for the local/remote session asymmetry: quitting warns when local sessions have live terminal shells ("sessions on This Mac will stop; remote sessions are unaffected"); the local hub card is captioned as running only while the app is open.

## Capabilities

### New Capabilities

- `desktop-hub-connect`: the desktop app's hub roster — adding/removing remote hubs, native login and credential storage, cookie lifecycle and WKWebView injection, per-hub reachability/auth state on the splash, and the local/remote session-lifetime asymmetry signaling (quit confirmation).

### Modified Capabilities

- `hub-service`: workspace registration accepts arbitrary absolute paths (drop `workspacesDir` constraint and startup prune); new `--local` mode requirement; new stdin-close exit backstop requirement; new directory-listing API for the Add Folder browser.
- `hub-auth`: local mode (loopback, no users configured) bypasses authentication; all other modes keep the existing user/cookie requirements.
- `hub-dashboard`: "creates workspaces from the workspaces root" is replaced by "adds folders via a server-side directory browser"; clone targets a browsed destination; the dashboard shows the hub's uatu version to signed-in users.
- `desktop-macos-shell`: the per-window bundled-server requirement becomes single app-owned local hub supervision; the launcher requirement becomes the hub splash; window lifecycle states reflect hub/session state; quit interception with the running-shells confirmation.

## Impact

- **Hub (TypeScript):** `src/hub/config.ts` (remove `workspacesDir`, add local mode), `registry.ts` (drop root constraint/prune), `main.ts` + `src/cli/parse.ts` (`--local`, `--exit-on-stdin-close`), `server.ts`/`pages.ts` (directory-browser API + Add Folder UI, folders endpoint rework), `auth.ts` (local-mode gate bypass). Existing hub tests touching `workspacesDir` are rewritten.
- **Desktop (Swift):** `UatuServer.swift` refactors from per-window serve supervisor to app-level hub supervisor plus a remote-hub client; `ContentView.swift` launcher → splash; new hub roster storage (UserDefaults + Keychain), login sheet, cookie injection, quit interception (`applicationShouldTerminate`-equivalent).
- **Docs:** `ARCHITECTURE.md` wrapper↔CLI contract (now hub-based), hub self-hosting runbook (config schema change), CHANGELOG entry for 0.5.0.
- **Out of scope (deferred):** container `SessionBackend`, LaunchAgent/detached local hub (would dissolve the quit asymmetry; noted in design as the future direction), and the dogfooding-found UX follow-ups listed at the end of `design.md` (native handling of remote sign-out, double-splash streamlining, stopped-session resume-in-place).
