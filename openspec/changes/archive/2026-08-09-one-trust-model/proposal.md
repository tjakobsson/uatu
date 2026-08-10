# one-trust-model

## Why

The hub's introduction left uatu with two trust models (configured users vs. trusted loopback), three client postures (browser, desktop-as-hub-supervisor, desktop-as-hub-client), and an auth token that cannot be revoked server-side — the gap the desktop's client-side guards (PR #201) exist to compensate for. Every increment pays interest on this split, and the planned native Apple client would inherit and double it: an iOS app cannot spawn a backend, so the hub is necessarily its server. This change consolidates on one model — **the hub is the only front door, and every client authenticates the same way** — as the heart of the 0.5.0 debt paydown and the precondition for native clients.

## What Changes

- **BREAKING: server-side sessions replace the stateless signed cookie.** The hub keeps a session store in its state directory: opaque session ids mapped to user, issue time, revocation state, and a device label. Browsers carry the id in the existing cookie (CSRF protections unchanged); native clients carry the same kind of id as an `Authorization: Bearer` token. Sign-out revokes server-side — a signed-out session is dead everywhere immediately. The dashboard lists active sessions per device and can revoke them individually. All current cookies invalidate once (everyone re-logs-in); there is no dual-verify compatibility path.
- **BREAKING: `hub --local` trusted-loopback mode is deleted.** Localhost is just another address: login is required on every interface, the implicit `local` identity and the absent-`/login`/`/logout` conditionals disappear, and personal workspace state owned by the `local` identity is dropped without migration.
- **BREAKING: UatuCode Desktop stops embedding and supervising a hub.** The bundled `dist/uatu` binary, the spawn lifecycle, the login-shell environment probe, and the URL-on-stdout contract are deleted. The desktop becomes a pure connect-to-hub client: bearer token in the Keychain, 401 → sign-in, and the #201 generation-guard machinery collapses against real server-side revocation. Quit never stops sessions, because the app owns none.
- **`uatu serve` is deprecated as a public command.** The bare CLI keeps working but prints a deprecation warning naming `uatu hub` as the way to run uatu; serve remains the internal session child the hub spawns, and `bun run dev` plus the E2E harness are unaffected.

## Capabilities

### New Capabilities

_None — one model replaces two; all changes land as modifications/removals in existing capabilities._

### Modified Capabilities

- `hub-auth`: sessions become server-side records (revocable, dual transport); the local-mode bypass requirement is removed; native-client auth is stated as bearer; sign-out revokes server-side; CSRF requirement notes bearer requests carry no ambient credential; the documented trust model adds "login on every interface".
- `hub-service`: the trusted-local-mode requirement is removed.
- `hub-dashboard`: gains a device-session list with per-session revocation.
- `desktop-hub-connect`: native auth holds a bearer token (Keychain) instead of owning a cookie jar; the local-vs-remote session-lifetime distinction is removed.
- `desktop-macos-shell`: the local-hub supervision and quit-warning requirements are removed; the splash and window-lifecycle requirements are restated for a connect-only app.
- `desktop-distribution`: builds no longer embed the `uatu` binary.
- `serve-cli-startup`: bare invocation prints a deprecation warning (additive).

## Impact

- Hub: `src/hub/auth.ts` (session store, bearer parsing), `src/hub/state-dir.ts` (sessions file), `src/hub/server.ts` (gate, login/logout, sessions API), `src/hub/main.ts`/`config.ts` (`--local` removal), `src/hub/pages.ts` (device list UI), `src/hub/personal-state.ts` (`local` identity removal), `src/shell/hub-nav.ts` (`showsSignOut` conditional dies).
- Desktop: `desktop/macos/` loses process supervision, environment probing, and local-hub splash card; HubAPI moves to bearer; roster/keychain semantics simplify.
- CLI: deprecation warning in `src/cli/` output for bare `serve`; internal spawn path unchanged.
- Out of scope, deliberately: the hub-as-launchd/background-service install story (separate concern), the client/server version handshake (`cache-discipline` change), and any new native client.
- Interaction: `hub-pwa-manifest` also modifies hub-auth's gate requirement (return-to); whichever change archives second rebases that requirement's text on the other's.
- Docs: ARCHITECTURE.md's wrapper↔CLI contract section is deleted; the self-hosting runbook gains the single-front-door statement; release notes carry the re-login and desktop behavior changes.
