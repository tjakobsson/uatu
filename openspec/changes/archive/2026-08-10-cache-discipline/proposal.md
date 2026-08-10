# cache-discipline

## Why

Stale clients have repeatedly burned development: fixes were "re-fixed" because a browser was still running the previous build. The defenses that exist are partial and unpinned — the SPA shell sends `no-cache` but hub pages send no cache headers at all; Bun emits hashed chunk names and some paths get `immutable`, but nothing specifies or tests the invariant; the server-side shell cache never invalidates within a process lifetime; and nothing anywhere detects a client/server build mismatch. With native clients coming, version skew stops being a dev annoyance and becomes a product failure mode — the contract belongs in place now, while the API is still allowed to break.

## What Changes

- **Freshness invariants become specified and tested** (new capability `client-freshness`):
  - Every SPA bundle asset (JS/CSS/fonts emitted by the bundler) is served under a content-hashed URL with `Cache-Control: public, max-age=31536000, immutable`; a new build can never be served from an old cache entry.
  - Every HTML entry point — the SPA shell at any base path *and* the hub's login/dashboard pages — is served with `Cache-Control: no-cache` (or stricter) so navigations always revalidate.
  - The server-side shell cache is keyed by build identity, so a process serving a new bundle can never hand out a previous build's relocated shell.
- **Version handshake:** the server exposes its build identity (`{version, commit}` — already available in `shared/version.ts` — plus an `apiRevision` integer) to authenticated clients; the web client embeds its own build identity at bundle time and compares on boot and on reconnect. On mismatch the web client reloads itself once (loop-guarded); a second mismatch surfaces a visible stale-client notice instead of reload-looping. This is the same contract future native clients check, worded transport-neutrally.
- **Diagnosis closure:** audit and fix the remaining reproducible stale path in the dev/hub flow (the recorded suspects: HTML headers — since partially addressed — and the never-invalidating shell cache; the service worker was ruled out and is deleted by `hub-pwa-manifest` regardless).
- **Deletion rider:** the stale-content hint machinery (`src/shell/stale-hint.ts`, `stale-hint-mount.ts` and call sites) is removed. Since Modes were removed it is vestigial — `nextStaleHint` can never create a hint — and its spec requirement still describes the deleted Review mode. **BREAKING** only in the spec sense; no observable behavior exists to lose.

## Capabilities

### New Capabilities

- `client-freshness`: the freshness invariants (hashed immutable bundle assets, never-cached HTML entry points, build-keyed server shell cache) and the client/server version handshake with its stale-client behavior.

### Modified Capabilities

- `document-rendering`: the stale-content-hint requirement is removed (vestigial; references the removed Review mode).

## Impact

- Server: `src/server/navigation.ts` (shell cache keying, header pinning), `src/server/routes.ts` (asset routes' cache headers stay as-is for fixed-name icons/manifest; bundle-asset paths pinned immutable), `src/hub/pages.ts`/`server.ts` (no-cache on HTML), state payload or dedicated endpoint carrying build identity + `apiRevision`.
- Client: build identity embedded at bundle time; boot/reconnect comparison in `src/shell/` with single-reload guard and stale notice; `stale-hint*.ts` deleted with their `follow.ts`/`events.ts`/`history.ts`/`state.ts` touchpoints.
- Tests: unit coverage for headers and handshake; the invariant "no unhashed bundle asset URL escapes" gets a static check; e2e benefits noted — hashed URLs sidestep Chromium's same-URL GET merging that forced CDP workarounds in terminal-switcher tests (those workarounds are not removed here).
- Interactions: independent of the other 0.5.0-debt changes; `one-trust-model` gates the handshake data behind auth like the rest of the state payload (the hub-dashboard version display requirement already exists and is untouched).
- `apiRevision` starts at 1 and is bumped manually by changes that break the client/server contract; documented in ARCHITECTURE.md.
