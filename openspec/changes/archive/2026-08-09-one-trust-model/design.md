# one-trust-model — design

## Context

Today: hub auth is a stateless HMAC-signed cookie (`src/hub/auth.ts`) — verifiable offline, revocable never; `--local` mode bypasses auth entirely on loopback and is what UatuCode Desktop supervises as an embedded child process (URL-on-stdout, stdin-EOF backstop, login-shell environment probe); `uatu serve` is both the public quick-start command and the hub's internal session child. PR #201 added client-side revocation guards to the desktop precisely because the server cannot revoke. The future Apple client forces the question: an iOS app can only ever be a remote-hub client, so the hub is the product's front door regardless — this change makes the codebase agree.

User base is single-digit and has explicitly accepted breaking changes without migration code.

## Goals / Non-Goals

**Goals:**
- One authentication system with two transports (cookie for browsers, bearer for native), backed by one server-side session store with real revocation.
- Zero trust-mode conditionals: no `--local`, no implicit identity, login on every interface.
- Desktop as a pure client — no process supervision, no embedded binary.
- Public `serve` marked deprecated without breaking dev/e2e/internal use.

**Non-Goals:**
- Hub service-installation UX (launchd/brew-services) — separate change.
- Version handshake / cache discipline — separate change (`cache-discipline`).
- The native SwiftUI client itself, per-user OS isolation, or multi-tenancy hardening beyond the existing documented trust model.
- Renaming `uatu hub` to `uatu` (command-surface reshaping can follow once serve's deprecation has soaked).

## Decisions

1. **Session store: a JSON file per hub state dir, owner-only, keyed by opaque random ids.** Records: `{id, user, issuedAt, deviceLabel, revokedAt?}`. Verification = lookup + not revoked + lifetime check; the HMAC key and signed-blob format are deleted. A file (not SQLite) matches the registry's existing persistence style and the fleet size (tens of sessions). Write-through on issue/revoke; compaction drops expired records. Alternative — keep signed cookies plus a denylist — rejected: two verification paths, and the denylist grows forever while the store stays small.
2. **One id, two transports.** Browsers: the existing cookie name/attributes carry the session id; SameSite/CSRF behavior unchanged. Native: `Authorization: Bearer <id>` on every request; login (the existing JSON body, no Origin) returns the id in the response body alongside setting the cookie. Bearer requests skip CSRF checks — they carry no ambient credential a cross-site page could ride. The child-token brokering seam is untouched.
3. **Sign-out = revoke, everywhere.** `/logout` marks the presented session revoked and clears the cookie; a sessions API (`GET` list for the dashboard, `POST` revoke by id) lets any signed-in device kill any other. The dashboard renders the list with device labels and issue times. Desktop's #201 guards reduce to: send bearer, on 401 drop to sign-in; the generation-tracking machinery is deleted because the server is now the source of truth.
4. **`--local` deletion is total, not gated.** Flag, config branches, implicit `local` identity, absent-route conditionals (`showsSignOut`, 404 `/login` in local mode), loopback-only validation — all removed. Personal state rows owned by `local` are dropped; the desktop's former local workspaces re-register against whatever hub the user connects to. Localhost users create a one-user config once; the hub's first-run error message tells them exactly how.
5. **Desktop becomes connect-only in the existing SwiftUI shell.** Deleted: binary embedding, process supervision, stdout URL parsing, environment probing, quit-time session warnings, the "This Mac" splash card and recents import. The splash lists configured hubs (which may include `http://localhost:<port>` — the loopback-HTTP allowance stays); folder-adding happens in each hub's dashboard, which the splash already defers to. Window lifecycle states become splash / connecting / open / failed(connection-or-auth). Alternative — keep an optional embedded mode behind a flag — rejected: that's the second trust model wearing a trenchcoat.
6. **Serve deprecation is a stderr warning, not a behavior change.** Bare `uatu serve`/`uatu watch` prints one line: deprecated as a public command, use `uatu hub`, removal in a future release. Suppressed for hub-spawned children via the existing internal spawn arguments (the hub controls the argv), so logs stay clean. Dev script and e2e harness invoke the internal path and are exempt.

## Risks / Trade-offs

- [Session file corruption locks everyone out] → Write atomically (temp+rename, like the registry); a missing/corrupt file means "no sessions", and login recreates it. Worst case is a re-login.
- [Bearer ids in native logs/memory] → Same exposure class as the current cookie value; ids are random, revocable, and never appear in URLs.
- [Desktop UX regression: no more double-click-and-serve] → Accepted deliberately; the follow-up service-install change restores "always available" via launchd. Until then, `uatu hub` in a terminal is the documented path, and the desktop's first-run copy says so.
- [Two changes modify hub-auth's gate requirement (`hub-pwa-manifest` return-to)] → Archive-order note in both; second-to-archive rebases the requirement text.
- [E2E/dev flows accidentally hit the deprecation warning or the removed local mode] → Tasks include auditing `tests/e2e/server.ts`, `bun run dev`, and hub integration tests; hub tests get a config-file fixture instead of `--local`.
- [Dropping `local` personal state silently loses someone's pane layout] → Single-digit users, layout-grade data; called out in release notes.

## Migration Plan

Single release, ordered inside one branch: session store lands first (hub-only, web re-login), then `--local` deletion, then desktop connect-only, then the deprecation line. Every user re-logs-in once; desktop users add their hub (localhost or remote) on first run. Rollback = revert the release; old cookies are gone either way, which only costs another login.

## Open Questions

- Device label source: user-agent-derived default with optional label at login, or dashboard-editable after the fact? Default proposal: derive at login, editable later via the sessions API. Decidable at apply time.
- Whether `hub --port 0` + URL-on-stdout survives for tooling once the desktop no longer needs it (e2e may still want it). Keep unless it blocks cleanup.
