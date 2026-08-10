# one-trust-model — tasks

## 1. Server-side session store

- [x] 1.1 Add the session store to `src/hub/state-dir.ts`/`src/hub/auth.ts`: `{id, user, issuedAt, deviceLabel, revokedAt?}` records in an owner-only JSON file, atomic writes (temp+rename), expired-record compaction, unguessable ids.
- [x] 1.2 Replace signed-cookie issue/verify with store lookup: login creates a record and sets the cookie to the id; the gate resolves cookie or `Authorization: Bearer` through one verification path (unknown/revoked/expired/user-removed → absent). Delete the HMAC signing key machinery.
- [x] 1.3 JSON login returns the session id in the response body; bearer requests skip the Origin/CSRF check; cookie requests keep it.
- [x] 1.4 `/logout` marks the presented session revoked (all transports die immediately); add the sessions API (list for the current user, revoke by id, POST-guarded).
- [x] 1.5 Dashboard sessions pane: device label, issue time, current-session marker, per-session revoke; revoking current behaves as sign-out.
- [x] 1.6 Unit + integration tests: store atomicity/corruption fallback, dual-transport resolution, revocation reach, restart survival, removed-user invalidation.

## 2. Delete --local

- [x] 2.1 Remove the `--local` flag, loopback validation, implicit `local` identity, and every local-mode conditional in `src/hub/` (server routes, pages, config) and `src/shell/hub-nav.ts` (`showsSignOut` always true).
- [x] 2.2 No-users startup error explains how to create the initial user config.
- [x] 2.3 Drop `local`-identity personal-state handling; convert hub integration tests from `--local` fixtures to a single-user config fixture.
- [x] 2.4 Update the self-hosting runbook: login on every interface, server-side revocation, unchanged OS-user trust statement.

## 3. Desktop becomes connect-only

- [x] 3.1 Delete hub supervision from `desktop/macos/`: embedded binary build phase, spawn/terminate lifecycle, stdout URL parsing, stdin-EOF wiring, login-shell environment probe, unexpected-exit recovery UI.
- [x] 3.2 Splash: remove the "This Mac" card, folder picker registration, and recents import; add the no-hubs first-run explainer; window lifecycle states become splash/connecting/open/failed.
- [x] 3.3 HubAPI moves to bearer: Keychain stores the session id (and password for silent re-login); 401 → one silent re-login then sign-in prompt; replace the #201 generation-guard machinery with the server-revocation flow; web views get the id written as the hub cookie before navigation.
- [x] 3.4 Remove quit interception/warnings; update `scripts/install-desktop-local.sh` and both CI/release workflows to build without the CLI.
- [x] 3.5 Manual acceptance: remote hub + localhost hub in the roster, sign-out revokes across windows and native polls, revoke-from-dashboard bounces the desktop to sign-in.

## 4. Deprecate public serve

- [x] 4.1 Print the one-line stderr deprecation on user-invoked `serve`/`watch`; suppress via the hub's child argv; verify `bun run dev` and `tests/e2e/server.ts` stay quiet.
- [x] 4.2 README/docs: `uatu hub` is the way to run uatu; serve documented as deprecated.

## 5. Cross-cutting verification

- [x] 5.1 Full `bun test` + `bun test:e2e` green; hub TLS/proxy/personal-state integration suites updated and green.
- [x] 5.2 Update `ARCHITECTURE.md` (wrapper↔CLI contract section deleted; auth section rewritten) and `CLAUDE.md` (desktop description, hub folder notes).
- [x] 5.3 Release-note prep: visible entries for server-side revocation + device list, `--local` removal, desktop connect-only, serve deprecation; note the one-time re-login. Check archive ordering with `hub-pwa-manifest` on the shared hub-auth gate requirement.
