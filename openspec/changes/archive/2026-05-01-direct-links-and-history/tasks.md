## 1. Server: Accept-based dispatch

- [x] 1.1 Add a small helper in `src/server.ts` (e.g. `prefersHtmlNavigation(request: Request): boolean`) that parses the `Accept` header and returns `true` only when `text/html` is preferred over the alternatives. Treat absent headers and `*/*`-only as non-HTML-preferring (matches the curl-gets-raw-bytes design decision).
- [x] 1.2 Add a helper in `src/server.ts` that, given a pathname and the watched roots, resolves the path to a known non-binary document (reusing the same `RootGroup` index the SPA sees, not `resolveStaticFileRequest` — we need the document classification, not just file existence).
- [x] 1.3 In the catch-all `fetch` handler in `src/cli.ts`, before delegating to `staticFileResponse`, invoke the two helpers above. When `prefersHtmlNavigation` is true AND the path resolves to a viewable document, return the same `Response` `/` returns (the imported `index` HTML asset). Otherwise fall through to today's `staticFileResponse`.
- [x] 1.4 Confirm the existing `/api/...` and `/assets/...` routes are unaffected (they're matched by Bun's route table before the catch-all `fetch` runs).
- [x] 1.5 Unit test in `src/server.test.ts`: HTML-preferring navigation to a known doc returns the SPA shell HTML, not raw markdown.
- [x] 1.6 Unit test in `src/server.test.ts`: `Accept: */*` request to the same path returns raw bytes via the static fallback.
- [x] 1.7 Unit test in `src/server.test.ts`: HTML-preferring navigation to a binary file falls through to the static fallback.
- [x] 1.8 Unit test in `src/server.test.ts`: HTML-preferring navigation to an unknown path returns the static fallback's 404 (we are NOT serving the SPA shell for unresolvable paths — see design D4).

## 2. Client: history integration on user actions

- [x] 2.1 Add a small `pushSelection(documentId, relativePath)` helper in `src/app.ts` that constructs the URL via `"/" + relativePath.split("/").map(encodeURIComponent).join("/")` and calls `history.pushState({ documentId }, "", url)`.
- [x] 2.2 Add a parallel `replaceSelection(documentId, relativePath)` helper that calls `history.replaceState` with the same URL shape.
- [x] 2.3 In the sidebar tree click handler (`treeElement.addEventListener("click", ...)` for buttons), after the existing selection update, call `pushSelection(documentId, doc.relativePath)`.
- [x] 2.4 In `initCrossDocAnchorHandler`, after the existing selection update and before `loadDocument`, call `pushSelection(doc.id, doc.relativePath)`.
- [x] 2.5 Confirm pin/unpin without changing the rendered file does NOT push a history entry. The pin click handler currently calls `postScope` without changing `selectedId`, so this should be a no-op review rather than a code change.

## 3. Client: history integration on follow auto-switch

- [x] 3.1 In the SSE `state` event handler in `src/app.ts`, when a follow-mode auto-switch changes `appState.selectedId` (the branch where `appState.selectedId !== previousSelectedId` and the change came from a server-driven event, not a user click), call `replaceSelection(appState.selectedId, doc.relativePath)`.
- [x] 3.2 Confirm that the existing manual-click code path (which sets follow off in 2.3) does NOT also fire `replaceSelection` from the SSE handler — the follow-flag-off branch in `nextSelectedDocumentId` shouldn't pick up changes the user already pushed.

## 4. Client: history integration on initial boot

- [x] 4.1 At the top of `loadInitialState`, before fetching `/api/state`, parse `location.pathname`. Decode it via `decodeURIComponent` (with try/catch — malformed encoding falls through to default behavior). Strip leading `/`.
- [x] 4.2 After receiving the state payload, branch:
  - If the decoded relative path is empty: keep today's behavior (`selectedId = payload.defaultDocumentId`, `followEnabled = payload.initialFollow`).
  - If the path resolves to a known non-binary doc within the current scope: set `selectedId = doc.id`, `followEnabled = false` (force off per design D3), and remember `cameFromDirectLink = true` for the empty-state messaging.
  - If the path does not resolve under the current scope but the server is pinned to a different file: set `selectedId = payload.defaultDocumentId` (the pinned file), but render an empty-preview state with the "session pinned to X" message instead of loading the pinned doc's preview. The user can unpin from the header.
  - If the path does not resolve at all: render the empty-preview state with "document not found".
- [x] 4.3 After determining the boot selection, call `replaceSelection(appState.selectedId, doc.relativePath)` once so `history.state` carries the document id (the initial entry has `state === null` until we set it).
- [x] 4.4 If `location.hash` is non-empty after the document loads, call the existing `scrollToFragment(rawId)` helper.

## 5. Client: history integration on popstate

- [x] 5.1 Add a `window.addEventListener("popstate", ...)` handler in `src/app.ts`.
- [x] 5.2 The handler reads `location.pathname`, decodes it (try/catch), and resolves it against the current `appState.roots`. Same resolution rules as the boot path (4.2).
- [x] 5.3 Update `appState.selectedId` and call `loadDocument(...)` — but DO NOT push or replace history (popstate already moved the URL).
- [x] 5.4 In the popstate handler, disable follow mode if it is currently on (same rule as sidebar/cross-doc clicks). Otherwise the next file-change-driven auto-switch would immediately undo the back/forward navigation.
- [x] 5.5 Call `revealSelectedFile()` and `renderSidebar()` so the sidebar selection follows the URL.

## 6. Client: empty-preview messaging

- [x] 6.1 Extend `renderEmptyPreview(title, body)` callers (or add a small helper) so the boot path can show "Session pinned to `<file>`. Unpin to view other documents." and "Document not found at `<path>`." messages with appropriate titles.
- [x] 6.2 Make sure the sidebar still renders normally when these empty-preview states are shown (don't accidentally bail out of `renderSidebar()`).

## 7. End-to-end tests

- [x] 7.1 Add E2E test: type `http://127.0.0.1:NNNN/<doc-path>` (via Playwright `page.goto`), assert the rendered preview matches the document's expected rendering (not raw markdown), and assert the follow toggle is in the off state.
- [x] 7.2 Add E2E test: navigate via in-app cross-doc clicks across two documents, assert URL updates after each click, click browser back, assert the previously selected document is restored.
- [x] 7.3 Add E2E test: navigate via in-app click, click forward, assert the forward target is restored.
- [x] 7.4 Add E2E test: refresh the page on a deep-linked URL, assert the same document is rendered after refresh and the URL is preserved.
- [x] 7.5 Add E2E test: with follow on (root URL), trigger a file change, assert the URL updates to the new doc but the back stack length did not grow.
- [x] 7.6 Add E2E test: pin to a file, navigate (via address bar) to a different doc URL, assert the empty-preview "session pinned" message renders and the active preview is unchanged.
- [x] 7.7 Add E2E test: navigate to `/<doc-path>#fragment`, assert the matching heading is scrolled into view after render.
- [x] 7.8 Add E2E test: navigate to `/typo-not-a-real-doc`, assert the static fallback 404 is returned (no SPA shell, no shell-with-message — design D4 is strict here).

## 8. Spec sync and validation

- [x] 8.1 Run `bun test` and confirm all unit/integration tests pass.
- [x] 8.2 Run `bun run test:e2e` and confirm all Playwright tests pass.
- [x] 8.3 Run `bun run build` and confirm the standalone build still produces a working binary.
- [x] 8.4 Run `openspec validate direct-links-and-history --strict` and resolve any spec validation errors.
- [x] 8.5 Manually exercise: open `uatu watch testdata/watch-docs`, click two cross-doc links, hit back twice, verify the path back to the default doc; refresh on a deep link; pin a file and try to navigate to another via URL bar.
