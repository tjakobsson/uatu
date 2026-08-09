# hub-pwa-manifest — design

## Context

iOS/iPadOS displays in-app browser chrome (X, URL pill, bottom toolbar) whenever a standalone web app navigates outside its manifest scope. Today:

- Hub pages (`/login`, `/`) serve no manifest; a home-screen install from them gets iOS's inferred behavior, and post-login navigation shows the chrome.
- Session pages inject `<link rel="manifest" href="<base>/manifest.webmanifest" crossorigin="use-credentials">` (`src/shell/pwa.ts`), and `src/server/routes.ts` rewrites `start_url`/`scope`/icon paths to the base path — under a hub, scope becomes `/s/<id>/`, so the dashboard, login, and sibling sessions are all out of scope.
- A pass-through service worker (`src/assets/sw.js`) is registered per session solely to satisfy Chromium's historical install heuristic. It caches nothing by design, but has caused real cost: E2E request interception is defeated by it (the terminal-switcher tests needed CDP-level cache bypass), and every staleness investigation has to rule it out first.
- Login flow: the auth gate 303-redirects gated paths to `/login` (`src/hub/server.ts:346`) and successful login 303-redirects to `/` unconditionally (`src/hub/server.ts:92`).

Constraint: `uatu serve --base-path /docs/` behind a shared reverse proxy must NOT claim scope `/` on an origin it doesn't own. Only the hub knows it owns its origin root.

## Goals / Non-Goals

**Goals:**
- Installing from the hub's login/dashboard pages yields a standalone app whose scope covers the whole hub origin — no browser chrome anywhere post-login.
- Installing from a hub-served session page yields the same origin-wide scope (start_url stays the session).
- Sign-in returns the user to the page they asked for.
- Remove the service worker if (verification task) modern Chromium installs from manifest alone.

**Non-Goals:**
- No offline support — uatu requires a running server; that's why deleting the SW is safe.
- No per-user install preferences, no push notifications, no icon redesign.
- No change to `--base-path` semantics for non-hub deployments.
- Not touching the hub auth model itself (session store / revocation is a separate change).

## Decisions

1. **Hub manifest is a dedicated route, not a static file reuse.** `GET /manifest.webmanifest` at the hub origin serves a hub-branded manifest (`name: "UatuCode Hub"`, `scope: "/"`, `start_url: "/"`, `display: standalone`, reusing the existing icons via the hub's asset proxy or its own asset route). Served ungated (like the login page's own assets must be): Safari fetches the manifest at install time and may fetch it anonymously; a 401 would silently degrade installs. The manifest reveals nothing but branding. Alternative considered: gating it and relying on `crossorigin="use-credentials"` — rejected because hub pages are plain HTML (no JS injection point like the SPA has) and an ungated manifest has no secrecy value.

2. **Session scope under a hub = origin root, decided by the serving mode, not sniffed.** `buildRoutes(deps)` gains an explicit deps knob (e.g. `manifestScope: "base-path" | "origin"`), set to `"origin"` by the hub's session spawner and `"base-path"` everywhere else. The rewrite keeps relocating `start_url` and icon paths to the base path; only `scope` differs. Alternative considered: hub proxy rewriting the child's manifest response in flight — rejected: the route table is the declared single source of truth for HTTP behavior, and a proxy-side rewrite hides the decision.

3. **Return-to via a `next` query parameter, validated hard.** Gate redirect becomes `/login?next=<path>`; the login form echoes it in a hidden field; successful login redirects to `next` iff it is a same-origin absolute path (`startsWith("/")`, not `//`, no scheme, normalized), else `/`. POST-only state changes and the existing CSRF origin check are unchanged. Alternative considered: Referer-based return — rejected as unreliable and spoof-adjacent.

4. **Service worker: verify, then delete.** First task is an empirical check on current Chrome/Edge that the install affordance appears for a manifest-only page (it has not required a SW since ~2023). On pass: delete `src/assets/sw.js`, `registerServiceWorker()` and its call site, the `Service-Worker-Allowed` header in `routes.ts`, and the SW registration expectations in specs/tests. On fail: keep a single pass-through worker registered at the hub origin scope only, and record which browser still needs it. The deletion is behind the verification on purpose — the affordance is the only reason the worker exists.

5. **Existing installs re-add manually.** iOS captures the manifest at install time; there is no upgrade path for a web clip's scope. Release notes tell users (the user base is single-digit) to remove and re-add the icon.

## Risks / Trade-offs

- [iOS ignores origin-wide scope for a session-installed clip in some Safari version] → The hub-page install path (the primary flow) doesn't depend on it; verify on-device as an acceptance task.
- [Chromium install pill still wants a SW in some channel] → Fallback decision 4 keeps one hub-scoped worker; the per-session registration still dies.
- [`next` opens a redirect vector] → Strict same-origin-path validation; reject `//host`, `\` tricks, and anything with a scheme; unit-test the validator.
- [Two manifests on one origin (hub's at `/`, sessions' at `/s/<id>/manifest.webmanifest`) confuse install UX] → They're consistent in branding and icons; scope is identical after this change; browsers pick the manifest of the page being installed. Acceptable.

## Migration Plan

Single release. No data migration. Manual step for existing installs: re-add to home screen. Rollback = revert; old scope behavior returns.

## Open Questions

- Does the hub manifest want its own name/short_name per hub (config `title`) or fixed branding? Default: fixed "UatuCode Hub" now; revisit with hub user settings.
