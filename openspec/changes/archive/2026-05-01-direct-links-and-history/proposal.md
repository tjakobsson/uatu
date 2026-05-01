## Why

Today the browser URL is frozen at `/` for the entire session: navigating between documents inside the SPA never updates the address bar, so the back/forward buttons leave the app entirely instead of stepping back through the user's reading path, and a URL like `/guides/setup.md` cannot be shared, bookmarked, or refreshed — the static-file fallback streams the raw markdown source instead of the rendered preview. This makes the app feel "not like a real web app" for two of the most basic browser behaviors users expect, and breaks any workflow that depends on linking to a specific document.

## What Changes

- The browser URL pathname SHALL track the currently rendered document. User-initiated selection (sidebar click, cross-document link click) pushes a new history entry; follow-mode auto-switches replace the current entry; popstate (back/forward) re-selects without pushing.
- A direct top-level navigation to `/<doc-path>` (typed URL, bookmark, refresh, shared link) SHALL boot the SPA on that document and SHALL force follow mode off for the session, regardless of the CLI default. Sub-resource fetches (images, etc.) continue to be served by the static fallback.
- The server SHALL distinguish "top-level navigation for a viewable document" from "asset sub-resource fetch" by inspecting the request's `Accept` header. HTML-preferring requests for known viewable documents return the SPA shell; everything else falls through to today's static-file fallback unchanged.
- A direct link to a document that does not exist or is not currently in scope (for example, the session is pinned to a different file) SHALL render the SPA shell with a clear "not available" preview message rather than a hard 404, so the sidebar remains functional and the user can recover.
- A trailing fragment (`/guides/setup.md#installation`) SHALL scroll the matching element into view after the document loads, mirroring the existing in-page anchor handler's `user-content-` prefix logic.

## Capabilities

### New Capabilities
<!-- None — all changes are extensions to the existing browser-side capability. -->

### Modified Capabilities
- `document-watch-browser`: adds URL-tracks-active-document, direct-link boot, history navigation between documents, and the follow-defaults-off-on-direct-link rule. Existing requirement "Navigate cross-document anchor clicks inside the preview" gains a history-push obligation. Existing requirement "Follow the latest changed non-binary file" gains a URL-replace (not push) obligation. Existing requirement "Serve adjacent files from watched roots as static content" gains an `Accept`-based dispatch rule so top-level HTML navigation to a viewable document returns the SPA shell.

## Impact

- **Client (`src/app.ts`)**: new history integration on initial boot, on every selection change, on follow-mode auto-switch, and on `popstate`. The cross-doc and tree-click handlers gain `pushState` calls; follow-mode auto-switches gain `replaceState`.
- **Server (`src/cli.ts`, `src/server.ts`)**: the catch-all `fetch` handler branches on `Accept`. HTML-preferring requests that resolve to a viewable document return the SPA shell (the same response `/` returns today). All other paths and all non-HTML-preferring requests keep today's `staticFileResponse` behavior. No new routes; no asset URL changes.
- **State payload (`/api/state`)**: gains a way for the SPA to express "I arrived via a direct link, force follow off" — likely client-side only, by overriding `initialFollow` after parsing `location.pathname`. Server contract unchanged.
- **Spec**: three modifications and one or two new requirements added to `document-watch-browser/spec.md` (and a delta for archival).
- **Tests**: new E2E coverage for direct-link boot, history navigation, refresh-restores-doc, follow-mode replaceState, and pinned-server-rejects-direct-link-to-other-doc. Existing cross-doc-link tests should keep passing unchanged (the click is still intercepted; pushState is additive).
- **No breaking changes** for existing CLI usage — `uatu watch` with no path still opens at `/` with follow on as before.
