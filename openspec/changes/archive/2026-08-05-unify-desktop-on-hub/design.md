# Design — unify-desktop-on-hub

## Context

UatuCode Desktop is a SwiftUI shell where each window owns a `UatuServer` that spawns the bundled `uatu serve <folder> --no-open --exit-on-stdin-close`, parses the tokened URL from stdout, and loads it into a WKWebView. `uatu hub` (`src/hub/`) is a separate, unreleased session server: signed-cookie auth (`uatu_hub`, 30-day, HMAC over `{user, iat}`), a JSON API (`/api/hub/state`, `/api/hub/folders`, start/stop/forget), a reverse proxy at `/s/<id>/` that brokers child tokens server-side, and a server-rendered dashboard that renders from the JSON API.

Key existing facts the design leans on:

- `POST /login` already accepts JSON `{name, password}` and sets the cookie (`src/hub/server.ts`).
- Requests without an `Origin` header pass all CSRF checks by design — native clients need no CSRF token.
- Unauthenticated non-HTML/API requests get `401 {"error":"authentication required"}` — a clean cookie-validity probe.
- The hub refuses non-loopback bind without TLS, so every remote hub is HTTPS.
- `GET /api/hub/state` includes per-session shell summaries (`shells: [{attached, label}]`) fetched from children.
- The registry (`src/hub/registry.ts`) currently constrains workspaces to live directly under `workspacesDir` and prunes out-of-root entries at startup.

The hub has never shipped in a release; 0.5.0 is the first release that includes it, so its config and workspace model can change without migration support.

## Goals / Non-Goals

**Goals:**

- One session-lifecycle code path: desktop windows are hub clients; the desktop supervises exactly one local hub process.
- Remote hubs are first-class in the desktop app: add by URL, native login, Keychain credentials, workspaces visible from the splash.
- Hub workspace model matches the desktop's "open any folder" UX: registration by absolute path, with a directory browser for browser-only users.
- The local/remote session-lifetime asymmetry is communicated, not discovered: splash captioning plus a quit-time confirmation when something real would be lost.

**Non-Goals:**

- Container/remote `SessionBackend` implementations (seam stays as-is).
- Detached/LaunchAgent local hub. This is the known future answer that dissolves the quit asymmetry entirely (the desktop is already just a client; who owns the hub process is a deployment detail), but daemon lifecycle/upgrade UX is its own change.
- Windows/Linux desktop shells.
- Multi-user local mode, hub user management UI, or any bearer-token auth scheme.
- Idle-session reaping (the hub still never stops a session on its own).

## Decisions

### D1 — Workspace registration by absolute path; `workspacesDir` removed

`RegistryEntry` keeps `{id, path, backend}` but `path` may be any absolute directory. `registerWorkspace` validates the path exists and is a directory; the startup prune is deleted. Slug derivation (basename → kebab, `-2` suffixing) is unchanged, so `/s/<id>/` URLs and the proxy are untouched. `hub.json` drops `workspacesDir`; the "must not be inside a git repo" startup check goes with it.

*Why:* the desktop's native folder picker produces arbitrary paths, and the desktop UX ("open any folder") is the model we prefer. The root constraint mainly served the clone-into and browse flows, which D2 replaces. *Alternative considered:* keeping `workspacesDir` as a default browse root only — rejected as residual config with no enforcement meaning; the directory browser can default to `~`.

### D2 — Server-side directory browser replaces the folders listing

`GET /api/hub/folders` is replaced by `GET /api/hub/browse?path=<abs>` returning `{path, parent, dirs: [{name, git, registeredId}]}` (directories only, dotfiles hidden, `~` default, symlinks not followed out of caution but not a security boundary). The dashboard's create-workspace pane becomes a drill-down browser ending in "Add this folder"; `POST /api/hub/workspaces` takes `{path, init?}` (absolute path) instead of `{name}`, keeping the `409 {needsInit: true}` → re-POST with `init: true` handshake for non-git folders. Clone (`POST /api/hub/clone`) gains a `dest` field chosen with the same browser.

*Why not restrict browsing:* hub users already have full shell access through the embedded terminal — the trust boundary is login, and pretending the browser adds exposure would be security theater. This is stated in the trust-model docs.

### D2b — Hub version in `/api/hub/state`

The state payload gains a top-level `version` (from `src/shared/version`). The dashboard renders it in the header for signed-in users; the desktop splash shows it on each hub card. Authenticated-only by construction (the state route is behind the gate), so it leaks nothing to the login page.

### D3 — `uatu hub --local`: trusted loopback mode

`--local` implies: bind `127.0.0.1`, no TLS, `users` not required (and ignored if present), the auth gate short-circuits to an implicit `local` identity, login/logout routes respond 404, and rate limiting is inert. Refused if combined with a non-loopback `host`. The desktop always spawns the hub this way; a config file is not required to exist.

*Why:* the desktop shouldn't force users to invent a password for their own machine; precedent is `uatu serve`'s tokened-URL loopback trust. *Alternative considered:* desktop auto-generates a credential into the Keychain and logs in normally — rejected: extra moving parts, first-run keychain prompts, and no security gained on loopback (any local process can already reach a `serve` child).

### D4 — Hub gains `--exit-on-stdin-close`

Same contract as `serve`: supervisor holds a pipe to the hub's stdin; EOF triggers the same graceful shutdown as SIGTERM (stop children, exit). Signals remain the primary path; stdin-EOF is the crash/force-quit backstop.

### D5 — Desktop: one app-owned hub; windows become hub clients

`UatuServer` (per-window serve supervisor) is replaced by two pieces:

- **`LocalHubController`** (app singleton): spawns bundled `uatu hub --local --port 0 --exit-on-stdin-close` at app launch under the resolved login-shell environment, parses the URL line from stdout, SIGTERMs on quit, stdin-pipe backstop. States: `starting → running(URL) | failed`.
- **`HubSession` per window/tab**: `(hub, page)` where `page` is the hub dashboard or a workspace at `/s/<id>/`. No child process. The WKWebView just navigates; "window lifecycle state" is now derived from hub reachability plus the session's running state.

"Choose Folder…" runs the native panel, keeps the existing git preflight (offer `git init` — mapped onto the `409 needsInit` handshake), `POST /api/hub/workspaces` against the local hub, `POST .../start`, then navigates the tab to `/s/<id>/`. Recents migrate one-time into local-hub registrations (best-effort; missing paths skipped) via `POST /api/hub/workspaces` with `start: false` — the endpoint's register-without-starting variant, added so imported folders appear registered but not running.

*Why replace rather than dual-path:* two lifecycle implementations is precisely the problem this change removes; keeping serve-per-window "just in case" reintroduces it.

### D6 — Remote hub connect: native cookie ownership, injected into WKWebView

The native layer owns auth. Roster entries `{id, name, url, username}` live in UserDefaults; the password and the current `uatu_hub` cookie value live in the Keychain per hub. Login is a native sheet → `URLSession` `POST /login` (JSON, no `Origin` header) → capture `Set-Cookie`. Before any WKWebView navigation to that hub, the cookie is written into `WKHTTPCookieStore` (per-hub cookie domain/path). Probe/summary calls (`GET /api/hub/state`) run over `URLSession` with the same cookie.

Auth state machine per remote hub:

```
 unreachable ⟵ network error ── probe ── 200 ⟶ connected(summary)
                                  │
                                 401 ⟶ signedOut ── password in Keychain?
                                          │ yes: one silent re-login attempt
                                          │      (never auto-retried — 5-fail/60s
                                          │       rate limit on the hub)
                                          │ no / failed: "Sign in…" card state
```

TLS: system trust only in 0.5.0. Tailscale certs and public CAs work; self-signed certs require installing the CA in the macOS keychain (documented in the runbook). Per-hub fingerprint pinning is deliberately deferred — it doubles the connect UI surface and WKWebView makes exception-handling messy.

### D7 — Splash = hub cards only; the dashboard is the sole workspace surface

The launcher's idle state becomes: Choose Folder… (unchanged prominence), then one card per hub. "This Mac" card first, captioned *"runs while UatuCode is open"*; remote cards show name/host and live state from the auth machine (running-session count, version, sign-in needed, unreachable). Cards do NOT list workspaces — clicking a card opens the hub's dashboard in the tab, and all workspace listing, navigation, and management (open, stop, forget, add-from-browser, clone) happens there. Dogfooding an earlier build that expanded cards into native workspace rows showed exactly the duplication this decision exists to avoid: two competing dashboards, one of which goes stale whenever the web one improves.

Because the local hub's add-folder story is native (D5's Choose Folder picker), the local-mode dashboard omits the Add Folder browser and clone form — a web directory browser for a filesystem the native picker already covers is a worse duplicate. Remote dashboards keep the browser: there is no native picker for a remote filesystem. The Open Recent menu still lists local workspaces natively (a menu convenience, not a dashboard).

*Why:* the irreducible native surface is multi-hub aggregation and credentials; everything single-hub is already the dashboard's job, and keeping it there means dashboard improvements reach desktop automatically. Splash polls `/api/hub/state` (~5s, same cadence as the dashboard itself) only while visible, rendering only the summary line.

### D8 — Quit confirmation keyed on live shells

App termination is intercepted (`NSApplication` delegate `applicationShouldTerminate`). Decision table from the local hub's `/api/hub/state`:

- No running local sessions, or none with shells → quit silently.
- Otherwise → alert listing each session and its terminal count, closing with "Remote sessions are unaffected." Cancel aborts termination; Quit proceeds (SIGTERM hub → hub stops children).

*Why shells, not sessions:* the preview server is stateless and cheap to restart; live terminal processes are the only real loss. This mirrors Terminal.app's quit behavior, which is the mental model macOS users already have.

## Risks / Trade-offs

- [Hub becomes a hard dependency of the desktop experience — dashboard polish, error states, and upgrade behavior are now the first screen of every tab] → treat the dashboard as desktop UI: the tasks include a dashboard pass for the Add Folder browser; hub `failed` state gets a native retry surface equivalent to today's serve-failure screen.
- [Local hub is a single point of failure: if it dies, every local tab dies] → `LocalHubController` detects exit, surfaces a native "hub stopped" state with relaunch; sessions were children of the hub and restart on demand via the dashboard/splash.
- [Cookie lives in two stores (URLSession/Keychain and WKHTTPCookieStore) and can desync] → native layer is the single writer: inject before every navigation to a hub origin, and on 401 from either surface re-run the auth machine rather than trusting either store.
- [Silent re-login could trip the hub rate limiter (5/60s) and lock the user out] → at most one silent attempt per 401 transition; further attempts are user-initiated from the sign-in sheet.
- [WKWebView WS upgrades send an `Origin`; the hub 403s Origin/Host mismatches] → Origin here is the hub's own origin (the page's), which matches Host — no change needed; covered by an integration test against a TLS hub.
- [Removing `workspacesDir` invalidates the existing hub runbook/tests and any experimental edge-build config] → hub is unreleased; runbook and tests are updated in this change, and startup rejects the removed key with an error naming it.
- [Recents migration registers stale paths] → registration validates the path exists; missing recents are dropped silently.
- [Directory browser on a remote hub exposes filesystem layout to any hub user] → documented as inherent to the trust model (terminal already grants shell); no per-user scoping attempted.

## Migration Plan

Pre-release change: no data migration. `hub.json` files written by edge builds fail validation if they contain `workspacesDir` — startup error names the removed key. Desktop recents (`recentFolders` UserDefaults) are imported into the local hub registry on first launch of the new version, then left in place (rollback to an old build still finds them). Rollback story: reinstall the previous edge build; the hub registry file is additive JSON the old code ignores entries of only if out-of-root — acceptable for edge.

## Deferred UX follow-ups (found while dogfooding, out of scope here)

- **Sign-out inside the desktop strands the tab on the hub's web login.** Signing out from a remote hub's dashboard/switcher lands on the hub's login page in the WebView instead of returning to the native splash. The native layer should observe the sign-out (cookie gone → 401), flip the roster card to signed-out, and take the window back to the splash / native sign-in sheet.
- **Double-splash disorientation.** Native splash → hub dashboard are two visually similar landing pages in a row. Candidates: restyle/slim the dashboard when embedded in the desktop, or let a hub card jump deeper (e.g. straight to the last-used workspace).
- **Stopped-session pages reconnect forever.** A session page whose server was stopped shows "Reconnecting" indefinitely; the SPA could recognize the hub's stopped-session response and offer resume in place.
- **Split-browser tabs lack JS dialog handlers** (pre-existing, unrelated to the hub): external pages calling `confirm()` in the split pane silently get "Cancel"; same fix as WebViewHost's panels.

## Open Questions

- Does 0.5.0 keep `uatu serve` as a public subcommand (still used by the hub as the child process and by CLI users), with the desktop simply no longer calling it directly? Assumed yes — `serve` is unaffected by this change.
- ~~Splash card expansion (inline workspace list) vs. cards-only for v1~~ — resolved by dogfooding: cards-only; inline rows duplicated the dashboard (see D7).
- Should Cmd+T default the new tab to the focused window's hub or always show the splash? Assumed: always splash (cheap, consistent).
