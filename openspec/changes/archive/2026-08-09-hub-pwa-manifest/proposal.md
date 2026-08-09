# hub-pwa-manifest

## Why

Installing uatu as a webapp on iOS/iPadOS from the hub breaks after sign-in: Safari shows the in-app browser chrome (X button, URL pill, bottom toolbar) on the dashboard and every session, because standalone web apps display that chrome whenever navigation leaves the manifest's scope. Today the hub's own pages (login, dashboard) serve no manifest at all, and session pages served through the hub rewrite the manifest scope down to `/s/<id>/` — so the dashboard, the login flow, and every sibling workspace are out of scope for an installed app. The hub is the product's front door on touch devices; it should be the installable thing.

## What Changes

- The hub serves its own web-app manifest ("UatuCode Hub", `scope: "/"`, `start_url: "/"`, standalone display) and links it from the login and dashboard pages, making the hub installable as a webapp whose scope covers the whole origin — dashboard, login, and all `/s/<id>/` sessions.
- Sessions served through a hub stop narrowing manifest scope to their base path: `scope` becomes the origin root while `start_url` keeps pointing at the session. Standalone `uatu serve` and generic `--base-path` mounts keep the current path-scoped rewrite (a generic mount must not claim an origin it doesn't own).
- The hub login flow gains return-to: an unauthenticated request to a gated path redirects to `/login` carrying the originally requested same-origin path, and a successful sign-in redirects back to it instead of always landing on the dashboard. Open-redirect-safe: only same-origin absolute paths are honored; anything else falls back to `/`.
- **BREAKING (behavioral):** the pass-through service worker is removed — `src/assets/sw.js`, `registerServiceWorker()`, and the `Service-Worker-Allowed` header plumbing — after verifying that current Chromium/Edge surface the install affordance from a valid manifest alone. uatu has nothing useful to do offline; the worker existed only for an outdated install heuristic and has repeatedly complicated E2E testing (request interception and caching workarounds). If verification fails, the fallback is a single hub-scoped pass-through worker, and the deletion scope shrinks accordingly.

## Capabilities

### New Capabilities

_None — this reshapes existing installability and login behavior._

### Modified Capabilities

- `pwa-install`: manifest scope policy changes (hub manifest at origin scope; hub-served sessions inherit origin scope); the "minimal service worker is registered" requirement is removed and replaced by a requirement that installability does not depend on a service worker.
- `hub-dashboard`: login and dashboard pages link the hub manifest and standalone metadata so the hub is installable from those pages.
- `hub-auth`: unauthenticated redirects carry a return-to target; successful login redirects to the validated same-origin path instead of unconditionally to `/`.

## Impact

- `src/hub/pages.ts` (head metadata + manifest link), `src/hub/server.ts` (manifest route, login redirect handling, return-to validation).
- `src/server/routes.ts` (manifest scope rewrite becomes mode-aware: hub-served vs. generic base path), `src/shell/pwa.ts` (service-worker registration removed; manifest link injection stays).
- `src/assets/sw.js` deleted; E2E helpers that exist to defeat the service worker (CDP cache bypass in terminal-switcher tests) can be simplified afterwards but are not required to change here.
- Installed web clips capture the manifest at install time: existing home-screen installs must be re-added once to pick up the new scope. No data migration.
- Specs: `pwa-install`, `hub-dashboard`, `hub-auth` deltas; `base-path-serving` is unaffected at the requirement level (the session's own URLs still resolve under its base path).
