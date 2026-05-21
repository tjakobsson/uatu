## Why

Three independently reported bugs all trace back to one weakness: the embedded terminal's lifecycle is fragile in the face of page-level URL state. (1) Any same-origin anchor the SPA can't resolve becomes a real browser navigation to a server 404, tearing down the SPA and killing every terminal WebSocket. (2) After a browser refresh, terminals appear empty until the user resizes the panel — the xterm canvas is measured before the panel container has its final layout, so the first paint goes to a 0×0 grid. (3) Deep-linking to a document with a hash (e.g. `…/doc.md#section`) throws an unhandled `SyntaxError` on every boot, because the WebSocket URL is built from `window.location.href` and inherits the fragment, which the WebSocket constructor rejects. The three are small individually, but together they make the terminal feel "twitchy" — a single mis-click or refresh on a deep link can wipe a running shell session. Fixing them as one change captures the shared theme (terminal lifecycle survives page-level URL events) and lets the e2e regression coverage land together.

## What Changes

- Same-origin navigation that doesn't resolve to a known document is no longer allowed to tear down the SPA. The cross-document anchor handler intercepts every same-origin click (not just resolvable ones) and routes unknown paths through the existing in-app "Document not found" path. The server's navigation fallback ALSO returns the SPA shell for HTML-preferring requests to unknown paths (was: `404 Not Found`), so address-bar entry and external deep links get the same in-app empty state instead of a hard 404. Same-origin links to existing non-document static files (images, raw bytes via `Accept: */*`) keep working through the static fallback unchanged.
- The terminal WebSocket URL builder strips the fragment identifier before constructing the `WebSocket`. This eliminates the `SyntaxError` and is the right invariant regardless of how URLs flow through the SPA.
- The terminal pane's first attach on boot defers the initial `term.open()` / `fit.fit()` until the panel container has a non-zero `getBoundingClientRect`. A follow-up refit + `term.refresh(0, rows - 1)` runs on the next animation frame after the WebSocket opens, so any data buffered during the layout race renders immediately rather than waiting for a user-initiated resize.
- An e2e regression test covers each of the three behaviors: clicking an unknown same-origin link does NOT close the WebSocket; refreshing a page with a deep-linked hash does NOT throw and the terminal renders without manual resize; an unknown URL typed in the address bar shows the in-app "Document not found" with the terminal panel intact.

## Capabilities

### New Capabilities

None. The fixes refine existing capabilities.

### Modified Capabilities

- `embedded-terminal`: New requirement — terminal WebSocket URL MUST NOT include a fragment identifier. New requirement — terminal pane's initial paint MUST converge to a correctly-sized grid without requiring user-initiated resize.
- `document-routing`: Modify the "Navigate cross-document anchor clicks inside the preview" requirement so unresolved same-origin paths route to an in-app "Document not found" state rather than falling through to a browser navigation. Add a new requirement — the server's HTML-preferring navigation fallback returns the SPA shell for unknown paths (with the SPA rendering the in-app empty state) instead of a plain `404 Not Found` response. Static file requests (non-HTML-preferring `Accept` headers) are unaffected.

## Impact

**Code touched**

- `src/preview/anchors.ts` — `initCrossDocAnchorHandler`: catch unresolved same-origin paths, route through `pushSelection` + `renderEmptyPreview("Document not found", …)` (mirroring the popstate handler in `src/shell/history.ts:202`).
- `src/server/session.ts:823-837` — `createNavigationFetchHandler`: when the request is HTML-preferring and the path doesn't resolve AND the static fallback returns null, serve the SPA shell instead of `404 Not Found`. Non-HTML-preferring requests retain current behavior (static fallback, then 404).
- `src/terminal/client.ts:197-207` — `connect()`: clear `wsUrl.hash = ""` before constructing the `WebSocket`.
- `src/terminal/client.ts:187-220` — `connect()`: defer `term.open()`/`fit.fit()` until the container has non-zero dimensions; schedule a post-open refit so buffered output renders.
- `src/terminal/panel.ts` — only if needed; ideally the deferred-fit logic stays inside `client.ts` so panel ordering stays unchanged.

**Tests**

- `tests/e2e/terminal.e2e.ts` (or new `terminal-lifecycle.e2e.ts`) — three regression cases, each described above.
- `src/terminal/client.test.ts` (new or extended) — unit test the URL builder (hash stripping).
- `src/server/session.test.ts` — assert HTML-preferring navigation to an unknown path returns the SPA shell, not `Not Found`. The existing test at `session.test.ts:1029` ("HTML-preferring navigation to a known doc returns the SPA shell") is the template.

**No data migration, no CLI surface change, no user-visible UX regression** — the navigation-fallback change makes 404 messaging *more* consistent (in-app empty state instead of a raw HTTP error page).

**Out of scope**

- General terminal reconnect / session resumption hardening (the 5-second PTY grace window already exists; this change does not extend it). If a user spends >5s on an in-app "Document not found" before hitting back, the PTY is reaped — that is acceptable for this change.
- Refactoring `createNavigationFetchHandler` more broadly. We're adding one branch, not restructuring the dispatch.
