# Tasks — unify-desktop-on-hub

Suggested landing order: groups 1–5 (hub side) are independently green and can go as a first PR; groups 6–9 (desktop) build on a released-in-repo hub; group 10 closes out docs. Every checkbox is completable in-branch.

## 1. Hub workspace model (registry + config)

- [x] 1.1 Remove `workspacesDir` from `src/hub/config.ts` (schema, defaults, validation) and make an explicit startup error name the removed key when present in `hub.json`
- [x] 1.2 Remove the workspaces-root-inside-git startup check from `src/hub/main.ts`
- [x] 1.3 `src/hub/registry.ts`: accept arbitrary absolute paths in `registerWorkspace` (validate absolute + existing directory), delete the startup prune; keep slug derivation and atomic persistence unchanged
- [x] 1.4 Rewrite registry/config tests that assumed the workspaces root; add tests for arbitrary-path registration, relative/missing path rejection, and the removed-key startup error

## 2. Hub directory browser + registration API

- [x] 2.1 Replace `GET /api/hub/folders` with `GET /api/hub/browse?path=<abs>` in `src/hub/server.ts` (`{path, parent, dirs: [{name, git, registeredId}]}`; dirs only, dotfiles hidden, `~` default)
- [x] 2.2 Change `POST /api/hub/workspaces` to take `{path, init?}` (absolute), keeping the `409 {needsInit: true}` handshake; add `dest` to `POST /api/hub/clone`
- [x] 2.3 Rework the dashboard create pane in `src/hub/pages.ts` into the drill-down Add Folder browser (registered folders marked, add action, clone with browsed destination)
- [x] 2.4 Update hub server/dashboard tests for the new endpoints; cover browse listing, add, needs-init decline, clone-with-dest, and git failure reporting

## 3. Hub local mode

- [x] 3.1 Add `--local` to hub CLI parsing (`src/cli/parse.ts` + `src/hub/main.ts`): no config required, loopback-only enforcement, `--port 0` support, base URL printed as first stdout line
- [x] 3.2 `src/hub/auth.ts` / `server.ts`: implicit local identity in local mode; `/login` and `/logout` return 404; rate limiter inert; assert non-local gating is untouched by the new path
- [x] 3.3 Integration test: `--local` hub serves dashboard/state/proxy without credentials; non-loopback `--local` fails startup; a configured hub still 401s

## 4. Hub stdin backstop

- [x] 4.1 Add `--exit-on-stdin-close` to the hub (same semantics as `serve`: EOF → SIGTERM-equivalent shutdown)
- [x] 4.2 Integration test: stdin EOF stops running session children and exits the hub

## 5. Hub version surfacing

- [x] 5.1 Add `version` (from `src/shared/version`) to `GET /api/hub/state`
- [x] 5.2 Render the version on the dashboard for signed-in users; test that the login page contains no version string

## 6. Desktop: local hub supervision

- [x] 6.1 Replace per-window `UatuServer` with an app-singleton `LocalHubController` spawning `hub --local --port 0 --exit-on-stdin-close` under the login-shell environment; parse the stdout URL; SIGTERM on quit with the stdin-pipe backstop
- [x] 6.2 Hub-exit detection → native failure state with output tail and relaunch action in affected windows
- [x] 6.3 Introduce the per-window `HubSession` page model (splash / dashboard / workspace session) and route WKWebView navigation through it; window lifecycle states per the modified spec
- [x] 6.4 Route Choose Folder… through `POST /api/hub/workspaces` with the `409 needsInit` dialog handshake (remove the app's own `git rev-parse`/`git init` paths); one-time recents import into the local registry

## 7. Desktop: hub roster + native auth

- [x] 7.1 Hub roster storage: entries in UserDefaults, password + cookie in Keychain; add/rename/remove flows with Keychain cleanup; HTTPS-only for non-loopback URLs
- [x] 7.2 Native login: JSON `POST /login` via URLSession (no Origin header), cookie capture; Add Hub sheet verifies before saving and distinguishes unreachable vs rejected
- [x] 7.3 Cookie injection into `WKHTTPCookieStore` before every navigation to a hub origin; native layer as single cookie writer
- [x] 7.4 Per-hub auth state machine (connected / signed out / unreachable) with at most one silent re-login per 401 transition; system TLS trust only, no exception UI

## 8. Desktop: splash

- [x] 8.1 Rebuild the launcher as the hub splash: folder picker, "This Mac" card with the runs-while-open caption, remote cards with name/host, state, running summary, and hub version
- [x] 8.2 Workspace rows on cards: open running sessions, start-then-open stopped ones; card click opens the hub dashboard
- [x] 8.3 Poll `/api/hub/state` per hub only while a splash is visible; Add Hub… entry point
- [x] 8.4 Update the menu bar: Open Recent lists local hub workspaces; Open in Browser / Reload / Split Browser enablement follows the new page model

## 9. Desktop: quit interception

- [x] 9.1 Intercept app termination; query the local hub's state and apply the decision table (silent when no local shells; otherwise confirmation listing workspaces + shell counts, noting remote sessions are unaffected)
- [x] 9.2 Confirmed quit tears down: hub SIGTERM → children stopped → app exits; cancel aborts termination cleanly

## 10. Docs and release notes

- [x] 10.1 Update `ARCHITECTURE.md`: wrapper↔CLI contract is now hub-based (single local hub, stdout URL, stdin backstop); hub section reflects the path-based workspace model
- [x] 10.2 Update the self-hosting runbook: config schema without `workspacesDir`, directory-browser trust-model note, self-signed-cert guidance for the desktop client (install CA in macOS keychain)

PR conventions: conventional-commit titles describing the change (e.g. `feat(hub): trusted local mode and path-based workspaces`, `feat(desktop): hub splash and remote hub connect`); reference issues as full links. The 0.5.0 CHANGELOG entry is generated by Release Please from these commit subjects — there is no hand-written entry. Post-merge, verify the edge build's desktop app end-to-end against a TLS hub (Tailscale cert) — including the terminal WebSocket through WKWebView — before cutting 0.5.0.
