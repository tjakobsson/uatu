# hub-pwa-manifest — tasks

## 1. Verify the service-worker assumption

- [x] 1.1 On a branch, disable `registerServiceWorker()` and unregister any existing worker, then confirm the install affordance still appears for `uatu serve` in current Chrome and Edge (manifest + icons only). Record the browser versions in the task notes.
- [x] 1.2 Decide the branch: verification passed → full deletion (tasks 2.x); failed → keep a single hub-origin pass-through worker and note which browser required it, shrinking 2.x to the per-session registration removal.

**Verification record (task 1.1, 2026-08-09):** CDP `Page.getInstallabilityErrors` against this branch's SW-less build — Chromium 151.0.7922.34: zero errors, zero SW registrations (installable). Google Chrome 151.0.7922.76: only `in-incognito` (automation-profile artifact; no manifest- or SW-related errors). Verification passed → full deletion branch taken.

## 2. Remove the service worker

- [x] 2.1 Delete `src/assets/sw.js` and `registerServiceWorker()` in `src/shell/pwa.ts`, plus its call site in boot.
- [x] 2.2 Remove the `Service-Worker-Allowed` header and `/sw.js` route from `src/server/routes.ts`; update `shared/app-url-discipline.test.ts` allowlist if it references the SW path.
- [x] 2.3 Update unit and E2E coverage: drop SW-registration assertions, add the no-registration scenario from the pwa-install delta; confirm the terminal-switcher E2E CDP cache workarounds still pass (simplification of those helpers is optional follow-up, not part of this change).

## 3. Hub manifest

- [x] 3.1 Serve `/manifest.webmanifest` from the hub (ungated, `application/manifest+json`): "UatuCode Hub" branding, `scope: "/"`, `start_url: "/"`, `display: standalone`, theme/background colors matching the pages, icons referencing the hub's 192/512 PNG routes (add ungated icon routes if the hub doesn't already expose them).
- [x] 3.2 Link the manifest and standalone metadata from the shared page head in `src/hub/pages.ts` (login + dashboard).
- [x] 3.3 Unit tests: manifest reachable without a cookie, well-typed JSON, pages contain the `<link rel="manifest">`.

## 4. Session manifest scope under a hub

- [x] 4.1 Add a `manifestScope: "base-path" | "origin"` dep to `buildRoutes` (default `"base-path"`); in `"origin"` mode the manifest rewrite keeps `start_url`/icon relocation but sets `scope: "/"`.
- [x] 4.2 Have the hub's session spawner pass `"origin"`; leave `cli.ts` standalone/`--base-path` and the E2E server on the default.
- [x] 4.3 Unit tests for both rewrite modes (origin scope with relocated start_url; base-path scope unchanged).

## 5. Login return-to

- [x] 5.1 Gate redirect: unauthenticated navigations redirect to `/login?next=<original path>`; login page renders `next` into a hidden form field.
- [x] 5.2 Successful login redirects to the validated `next` (same-origin absolute path only: single leading `/`, no scheme/authority, reject `//` and backslash variants), else `/`.
- [x] 5.3 Unit tests: round-trip through a gated session URL, plus the malicious-target table (absolute URL, `//host`, `/\` variant, empty).

## 6. Acceptance on device

- [x] 6.1 On iOS/iPadOS: remove the old home-screen install, re-add from the hub dashboard, then walk launch-signed-out → login → dashboard → open session and confirm no in-app browser bars anywhere.
- [x] 6.2 Install from a hub-served session page and confirm dashboard/sibling-session navigation also stays standalone.
