# document-routing Specification

## Purpose
TBD - created by archiving change split-document-watch-browser. Update Purpose after archive.
## Requirements
### Requirement: Navigate cross-document anchor clicks inside the preview
When a user clicks an anchor inside the rendered preview whose resolved URL has the same origin as the current page and a non-`http(s):` exclusion does not apply, the browser UI SHALL handle the click in the SPA rather than letting the browser perform a full navigation. If the resolved path maps to a known non-binary document under any watched root, the SPA SHALL switch the preview to that document via the in-app document load path. If the resolved path does NOT map to a known viewable document (the path is unknown, or it resolves to a document classified as binary), the SPA SHALL render the in-app "Document not found" empty state and push the unknown path to the URL bar, EXCEPT that clicks resolving to a binary document MUST continue to fall through to the browser so the static-file fallback can serve the bytes. The interception MUST resolve the click target against the per-document `<base href>` so cross-document references written as relative paths (e.g. `xref:other.adoc[…]`, `[setup](guides/setup.md)`) reach the correct document. The interception MUST NOT fire for any of the following — those clicks MUST fall through to the browser's default behavior: a fragment-only href (handled by the existing in-page anchor handler), a modifier-click (Cmd, Ctrl, Shift, or Alt held), an explicit `target` attribute other than `_self`, a URL whose origin differs from the current page, a non-`http(s):` protocol (`mailto:`, `javascript:`, `tel:`, etc.), and a path that resolves to a document classified as binary. After the in-app load completes for a resolvable doc, a fragment in the resolved URL (e.g. `other.adoc#section`) SHALL scroll the matching element into view, mirroring sanitize's `user-content-` id prefix the same way the in-page anchor handler does. When the interception fires AND the active document or URL is changing as a result of the click, the system MUST push a new browser history entry via `history.pushState`, with the new URL being the target document's relative path (per-segment percent-encoded), so the back button can return to the previously selected document. While rendering the in-app "Document not found" empty state, the SPA MUST NOT tear down or restart its open WebSocket connections (notably the embedded terminal's per-pane WebSockets).

#### Scenario: Clicking an AsciiDoc cross-document link swaps the preview in place
- **WHEN** a user clicks an anchor in an AsciiDoc preview whose `href` is `asciidoc-cheatsheet.adoc`
- **AND** that file is a known non-binary document under a watched root
- **THEN** the preview swaps to render `asciidoc-cheatsheet.adoc`
- **AND** the page URL pathname updates to `/asciidoc-cheatsheet.adoc`
- **AND** a new history entry is pushed
- **AND** the browser does NOT request `/asciidoc-cheatsheet.adoc` from the static-file fallback as a sub-resource fetch
- **AND** the sidebar selection follows the new document

#### Scenario: Clicking a Markdown cross-document link swaps the preview in place
- **WHEN** a user clicks an anchor in a Markdown preview whose `href` is `guides/setup.md`
- **AND** that file is a known non-binary document under a watched root
- **THEN** the preview swaps to render `guides/setup.md`
- **AND** the page URL pathname updates to `/guides/setup.md`
- **AND** a new history entry is pushed
- **AND** the sidebar selection follows the new document

#### Scenario: A subdirectory cross-document link still swaps the preview
- **WHEN** a user clicks an anchor whose `href` resolves through the per-document `<base href>` to a non-binary document inside a subdirectory of a watched root
- **THEN** the preview swaps to render that document
- **AND** the page URL pathname updates to that document's relative path

#### Scenario: Clicking an unknown same-origin link shows the in-app empty state
- **WHEN** a user clicks an anchor whose `href` resolves to a same-origin path that the SPA cannot map to any known document (e.g., a renamed file, a typo in a hand-authored link)
- **THEN** the click is intercepted (no browser-level navigation occurs)
- **AND** the preview renders the in-app "Document not found" empty state
- **AND** the URL bar reflects the unknown path
- **AND** any open WebSocket connections (notably the embedded terminal's) remain attached and uninterrupted

#### Scenario: An external link is not intercepted
- **WHEN** a user clicks an anchor whose `href` origin differs from the current page (e.g. `https://example.com`)
- **THEN** the click is NOT intercepted and the browser navigates to the external URL natively

#### Scenario: A modifier-click is not intercepted
- **WHEN** a user holds Cmd, Ctrl, Shift, or Alt and clicks a cross-document anchor
- **THEN** the click is NOT intercepted and the browser handles it natively (typically opening the resolved URL in a new tab)

#### Scenario: A link to a binary document is not intercepted
- **WHEN** a user clicks an anchor whose `href` resolves to a document classified as binary under a watched root
- **THEN** the click is NOT intercepted and the browser fetches the URL through the static-file fallback

#### Scenario: A fragment-only link is left to the in-page anchor handler
- **WHEN** a user clicks an anchor whose `href` begins with `#`
- **THEN** the cross-document handler does NOT intercept and the existing in-page anchor handler scrolls the matching id into view inside the current document

#### Scenario: An oversized AsciiDoc file falls back to plain text
- **WHEN** a user selects an `.adoc` file at or above 1 MB
- **THEN** the preview renders the contents inside `<pre><code class="hljs">` as plain escaped text
- **AND** Asciidoctor is not invoked on the contents

### Requirement: Reflect the active document in the URL
The browser URL pathname SHALL track the document currently rendered in the preview, at all times during a watch session. User-initiated changes to the active document (sidebar tree click, in-preview cross-document link click, manual pin/unpin that changes the rendered file) MUST push a new entry onto the browser history stack via `history.pushState`, with the new URL being the document's relative path (per-segment percent-encoded). Follow-mode auto-switches caused by file-system events MUST update the URL via `history.replaceState` so the address bar stays accurate without polluting the back stack with file-change-driven entries. On initial page load, the system MUST call `history.replaceState` once to populate `history.state` with the current document identifier so subsequent `popstate` events can be resolved unambiguously. The system MUST NOT update the URL while the active document is unchanged.

#### Scenario: Clicking a sidebar entry pushes a history entry
- **WHEN** a user clicks a non-binary document in the sidebar tree
- **THEN** the browser URL pathname updates to the clicked document's relative path
- **AND** a new entry is added to the browser history stack
- **AND** clicking the browser back button restores the previously selected document

#### Scenario: Clicking a cross-document link in the preview pushes a history entry
- **WHEN** a user clicks an anchor in the preview whose href resolves to a known non-binary document under a watched root
- **THEN** the browser URL pathname updates to that document's relative path
- **AND** a new entry is added to the browser history stack

#### Scenario: Follow-mode auto-switch replaces the URL without pushing
- **WHEN** follow mode is enabled and a file-system change causes the active document to switch
- **THEN** the browser URL pathname updates to the new document's relative path
- **AND** no new entry is added to the browser history stack
- **AND** clicking the browser back button does NOT step backward through the chain of follow-driven switches

#### Scenario: Path segments are percent-encoded
- **WHEN** the active document's relative path contains characters that require encoding (e.g. spaces, unicode, `#`, `?`)
- **THEN** each path segment in the URL is percent-encoded via `encodeURIComponent`
- **AND** the URL remains parseable and round-trips back to the original relative path on decode

### Requirement: Open a document by direct URL
The browser UI SHALL initialize on the document identified by `location.pathname` when the SPA boots. When `location.pathname` is `/`, the system MUST select the server-provided default document (today's behavior). When `location.pathname` resolves to a known non-binary document under a watched root, the system MUST select that document as the initial active preview, overriding the server-provided `defaultDocumentId`. When the watch session was started against a single file (`uatu watch some-file.md`) and `location.pathname` resolves to a document that exists but is outside that single-file watch scope, the SPA MUST render an empty-preview state explaining that the session is scoped to a single file rather than silently selecting the wrong document or auto-widening the scope. When `location.pathname` does not resolve to any known document under any watched root, the server MUST return a 404 via the static-file fallback (the SPA shell is not served — see "Serve adjacent files from watched roots as static content"); the SPA's "document not found" empty-preview state instead handles in-session cases where a previously-known document becomes unresolvable, covered under "Navigate document history with the browser back and forward buttons". When `location.hash` is present, the system MUST scroll the matching element into view after the document loads, mirroring the existing in-page anchor handler's `user-content-` prefix logic.

#### Scenario: Navigating directly to a document URL renders that document
- **WHEN** a user navigates the browser to `http://127.0.0.1:NNNN/guides/setup.md` (typed URL, bookmark, or shared link)
- **AND** `guides/setup.md` is a known non-binary document under a watched root
- **THEN** the SPA boots with `guides/setup.md` as the active preview
- **AND** the rendered preview is the Markdown rendering of `guides/setup.md`, not its raw source bytes
- **AND** the sidebar selection follows the active document

#### Scenario: Refreshing the page restores the active document
- **WHEN** a user has navigated to a document and the URL pathname reflects it
- **AND** the user refreshes the page
- **THEN** the SPA boots and renders the same document as before the refresh
- **AND** the sidebar selection matches

#### Scenario: A direct link to a document includes a fragment
- **WHEN** a user navigates to `http://127.0.0.1:NNNN/guides/setup.md#installation`
- **AND** the document contains a heading whose sanitized id is `user-content-installation`
- **THEN** the document loads
- **AND** the page scrolls to the matching heading after render

#### Scenario: A direct link to an unknown path returns 404
- **WHEN** a user navigates the browser to a path that does not resolve to any document under a watched root
- **THEN** the server responds with 404 via the static-file fallback
- **AND** the SPA shell is NOT served (no empty-preview state for unresolvable paths on direct-link arrival — see design D4)

#### Scenario: A direct link outside a single-file watch scope is rejected
- **WHEN** the watch session was started with `uatu watch README.md`
- **AND** a user navigates to `http://127.0.0.1:NNNN/guides/setup.md`
- **THEN** the SPA renders an empty-preview state explaining the session is scoped to `README.md`
- **AND** the active preview is NOT switched to `guides/setup.md`
- **AND** the sidebar still shows only the scoped file

### Requirement: Server returns the SPA shell for unknown HTML-preferring navigations
The server's navigation fallback SHALL distinguish HTML-preferring navigation requests (i.e., a top-level browser navigation whose `Accept` header expresses a preference for `text/html`) from non-HTML-preferring requests (e.g., `curl` with `Accept: */*`, sub-resource fetches with `Accept: image/*`). For an HTML-preferring request whose path does NOT resolve to a known viewable document AND does NOT match an existing static file under any watched root, the server SHALL return the SPA shell (the same HTML body it returns for known viewable doc paths) instead of a `404 Not Found` response. The SPA then renders the in-app "Document not found" empty state from its own boot path. For non-HTML-preferring requests at unknown paths, the server's behavior is unchanged — `404 Not Found`.

#### Scenario: HTML-preferring navigation to an unknown path serves the SPA shell
- **WHEN** the server receives a GET to `/no-such-doc.md` with `Accept: text/html,application/xhtml+xml,*/*`
- **AND** no document is known at that path
- **AND** no static file exists at that path
- **THEN** the response status is `200`
- **AND** the response body is the SPA shell HTML (the same body served at `/`)
- **AND** the SPA, once booted, renders the in-app "Document not found" empty state

#### Scenario: curl to an unknown path still returns 404
- **WHEN** the server receives a GET to `/no-such-doc.md` with `Accept: */*`
- **AND** no document is known at that path
- **AND** no static file exists at that path
- **THEN** the response status is `404`
- **AND** the response body is `Not Found`

#### Scenario: HTML-preferring navigation to an existing static file still serves the bytes
- **WHEN** the server receives a GET to `/diagram.png` with `Accept: text/html,application/xhtml+xml,*/*`
- **AND** `diagram.png` exists under a watched root
- **THEN** the response status is `200`
- **AND** the response body is the file's bytes
- **AND** the response is NOT the SPA shell

### Requirement: Force follow mode off when arriving via a direct document URL
When the SPA boots with `location.pathname` resolving to a known non-binary document (i.e. anything other than `/`), the system MUST disable follow mode for the session, regardless of the server-provided `initialFollow` value derived from the CLI flags. The follow toggle MUST reflect the disabled state. The user MAY re-enable follow mode after arrival via the existing follow toggle. When `location.pathname` is `/`, the system MUST honor the server-provided `initialFollow` value (today's behavior preserved).

#### Scenario: Direct link arrival turns follow mode off
- **WHEN** a user navigates directly to `http://127.0.0.1:NNNN/guides/setup.md`
- **AND** the CLI was started without `--no-follow` (so the server's `initialFollow` is `true`)
- **THEN** the SPA boots with follow mode disabled
- **AND** the follow toggle's pressed state is `false`

#### Scenario: Default-URL arrival honors the CLI follow default
- **WHEN** a user navigates to `http://127.0.0.1:NNNN/`
- **AND** the CLI was started without `--no-follow`
- **THEN** the SPA boots with follow mode enabled

#### Scenario: User can re-enable follow after a direct-link arrival
- **WHEN** the SPA has booted via a direct link with follow mode disabled
- **AND** the user clicks the follow toggle
- **THEN** follow mode becomes enabled
- **AND** the active preview catches up to the latest changed non-binary file under the watched roots

### Requirement: Navigate document history with the browser back and forward buttons
The system SHALL handle the browser's `popstate` event by re-selecting the document identified by the new URL pathname, without itself pushing or replacing additional history entries. The newly active document MUST be loaded through the in-app document load path (no full-page navigation). When the URL pathname resolves to a document outside the current scope or to no known document, the system MUST apply the same empty-preview rules defined in "Open a document by direct URL". When `popstate` fires AND follow mode is currently enabled, the system MUST disable follow mode for the session so the next file-system change does not immediately undo the back/forward navigation; this mirrors the follow-off rule that already applies to sidebar clicks, cross-document link clicks, and direct-link arrival. When `popstate` fires AND the new URL's pathname (decoded, leading slashes stripped) matches the active document's relative path AND only the fragment has changed, the system MUST treat the event as a same-document scroll: scroll the matching element into view when the new URL has a fragment, scroll the preview to the top when the new URL has no fragment, and MUST NOT reload the document, MUST NOT push or replace history, and MUST NOT disable follow mode.

#### Scenario: Back button restores a previously selected document
- **WHEN** a user has navigated from `README.md` to `guides/setup.md` to `guides/troubleshooting.md` via in-app clicks
- **AND** the user clicks the browser back button
- **THEN** the active preview returns to `guides/setup.md`
- **AND** the sidebar selection matches

#### Scenario: Forward button restores a document the user just stepped back from
- **WHEN** a user has stepped back from `guides/troubleshooting.md` to `guides/setup.md`
- **AND** the user clicks the browser forward button
- **THEN** the active preview returns to `guides/troubleshooting.md`

#### Scenario: Popstate to a no-longer-existent document renders empty preview
- **WHEN** a history entry refers to a document that has since been deleted from disk
- **AND** the user navigates to that entry via back/forward
- **THEN** the SPA renders an empty-preview state with a "document not found" message
- **AND** the sidebar still functions

#### Scenario: Browser back disables follow mode
- **WHEN** follow mode is enabled
- **AND** the user clicks the browser back button to switch to a previously selected document
- **THEN** the active preview returns to the previous document
- **AND** follow mode is disabled
- **AND** a subsequent file-system change does NOT auto-switch the preview away from the back-navigated document until the user re-enables follow

#### Scenario: Popstate that only changes the fragment scrolls within the same document
- **WHEN** the user has clicked a TOC entry inside `guides/setup.md` and the URL now reads `/guides/setup.md#installation`
- **AND** the user clicks the browser back button
- **THEN** the URL becomes `/guides/setup.md` (no fragment)
- **AND** the active document remains `guides/setup.md`
- **AND** the preview scrolls to the top of `guides/setup.md`
- **AND** the document is NOT reloaded
- **AND** follow mode (if enabled) remains enabled

### Requirement: Navigate Git Log commit previews by URL
The browser UI SHALL represent Git Log commit previews with a same-origin URL using the query parameters `repository` and `commit` on the SPA root path. A commit preview URL MUST resolve against the bounded repository commit-log data already present in the current state payload. The browser UI MUST restore a resolvable commit preview on direct-link arrival, refresh, and `popstate`. When the URL references a repository or commit that is not present in the current bounded state payload, the browser UI MUST render a clear empty-preview unavailable state instead of selecting an unrelated document.

#### Scenario: Direct commit preview URL renders the commit message
- **WHEN** a user navigates directly to `/?repository=<repositoryId>&commit=<commitSha>`
- **AND** the current state payload contains that repository and commit in its bounded commit log
- **THEN** the SPA boots with that commit message rendered in the main preview
- **AND** no document is selected in the file tree
- **AND** Follow mode is disabled

#### Scenario: Refreshing a commit preview URL restores the commit preview
- **WHEN** a user has opened a commit preview whose URL contains `repository` and `commit` query parameters
- **AND** the user refreshes the page
- **THEN** the SPA boots and renders the same commit preview again
- **AND** the URL remains the commit preview URL

#### Scenario: Back button restores the previous preview from a commit preview
- **WHEN** a user opens a document preview
- **AND** the user opens a commit preview from the Git Log
- **AND** the user clicks the browser back button
- **THEN** the active preview returns to the previous document
- **AND** the sidebar selection matches that document

#### Scenario: Forward button restores a commit preview
- **WHEN** a user has stepped back from a commit preview to a document preview
- **AND** the user clicks the browser forward button
- **THEN** the active preview returns to the commit preview
- **AND** no document is selected in the file tree

#### Scenario: Commit preview URL references unavailable data
- **WHEN** a user navigates to a commit preview URL whose repository or commit is not present in the current bounded state payload
- **THEN** the SPA renders an empty-preview state explaining that the commit preview is unavailable
- **AND** the sidebar remains usable

#### Scenario: Active commit preview is re-resolved after state refresh
- **WHEN** the active preview is a commit preview
- **AND** the browser receives a refreshed state payload
- **THEN** the browser re-resolves the active repository and commit against the refreshed payload
- **AND** the preview renders the refreshed commit data when the commit is still present
- **AND** the preview renders an unavailable empty state when the commit is no longer present

### Requirement: Open external links from the preview in a new browser tab
Anchors in the rendered preview whose `href` is an absolute `http:` or `https:` URL SHALL open in a new browser tab/window so that following them does NOT unload the uatu SPA. The renderer MUST mark such anchors with `target="_blank"` and `rel="noopener noreferrer"` before sanitization passes the HTML to the browser. The sanitize allowlist MUST permit those two attributes on `<a>` so the markings survive. Same-origin relative links (`other.adoc`, `guides/setup.md`, fragment-only `#section`) MUST NOT be marked and MUST continue to flow through the in-app cross-document and in-page anchor handlers respectively. Both the Markdown and AsciiDoc render paths MUST apply the same rewrite uniformly.

#### Scenario: An external Markdown link opens in a new tab
- **WHEN** a Markdown document contains `[example](https://example.com)`
- **AND** the document is rendered into the preview
- **THEN** the rendered anchor has `target="_blank"`
- **AND** the rendered anchor has `rel="noopener noreferrer"`
- **AND** clicking the anchor does NOT navigate the uatu SPA away

#### Scenario: An external AsciiDoc link opens in a new tab
- **WHEN** an AsciiDoc document contains `https://example.com[example]` or `link:https://example.com[example]`
- **AND** the document is rendered into the preview
- **THEN** the rendered anchor has `target="_blank"` and `rel="noopener noreferrer"`

#### Scenario: A relative cross-document link is not marked external
- **WHEN** a rendered document contains `<a href="other.adoc">` or `<a href="guides/setup.md">`
- **THEN** the rendered anchor does NOT have `target="_blank"`
- **AND** the cross-document anchor handler swaps the preview in place as before

#### Scenario: A fragment-only link is not marked external
- **WHEN** a rendered document contains `<a href="#section">`
- **THEN** the rendered anchor does NOT have `target="_blank"`
- **AND** the in-page anchor handler intercepts the click and scrolls within the document

### Requirement: In-page fragment clicks push a browser history entry
When a user clicks an anchor whose `href` begins with `#` inside the rendered preview, the system SHALL push a new browser history entry whose URL is the current pathname and search query concatenated with the new fragment, so that the back button returns the user to the previous scroll state (fragment-less URL or prior fragment) of the same document rather than to a previously selected document. The system MUST scroll the matching element into view as before. The system MUST NOT push a new history entry when the resulting URL is identical to the current URL (clicking a TOC entry that already corresponds to the active fragment is a no-op). The system MUST NOT disable follow mode for hash-only navigations — follow mode is a document-selection concept and intra-document TOC navigation does not change the active document.

#### Scenario: Clicking a TOC entry pushes a history entry
- **WHEN** a user views a rendered AsciiDoc document with a `:toc:` block
- **AND** the user clicks a TOC entry that links to a fragment
- **THEN** the browser URL gains the corresponding `#fragment`
- **AND** a new history entry is added
- **AND** the matching heading scrolls into view

#### Scenario: Back button after a TOC click returns to the prior scroll state
- **WHEN** a user has clicked a TOC entry from the top of a document
- **AND** the user clicks the browser back button
- **THEN** the URL no longer carries the `#fragment`
- **AND** the active document remains the SAME document (not the previously selected one)
- **AND** the preview scrolls to the top of that document

#### Scenario: Re-clicking the active TOC entry does not grow the history stack
- **WHEN** the URL already carries `#section`
- **AND** the user clicks the same `<a href="#section">` again
- **THEN** no new history entry is pushed
- **AND** the back stack length is unchanged

#### Scenario: Hash-only navigation does not disable follow mode
- **WHEN** follow mode is enabled
- **AND** the user clicks a fragment-only anchor inside the active document
- **THEN** follow mode remains enabled
- **AND** subsequent file-system changes can still auto-switch the preview

