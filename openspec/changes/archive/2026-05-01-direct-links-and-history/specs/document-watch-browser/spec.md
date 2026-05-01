## ADDED Requirements

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
The browser UI SHALL initialize on the document identified by `location.pathname` when the SPA boots. When `location.pathname` is `/`, the system MUST select the server-provided default document (today's behavior). When `location.pathname` resolves to a known non-binary document under a watched root, the system MUST select that document as the initial active preview, overriding the server-provided `defaultDocumentId`. When `location.pathname` resolves to a document that exists under a watched root but is outside the current scope (for example, the session is pinned to a different file), the SPA MUST render an empty-preview state explaining that the session is pinned to another file rather than silently selecting the wrong document or auto-unpinning. When `location.pathname` does not resolve to any known document under any watched root, the server MUST return a 404 via the static-file fallback (the SPA shell is not served — see "Serve adjacent files from watched roots as static content"); the SPA's "document not found" empty-preview state instead handles in-session cases where a previously-known document becomes unresolvable, covered under "Navigate document history with the browser back and forward buttons". When `location.hash` is present, the system MUST scroll the matching element into view after the document loads, mirroring the existing in-page anchor handler's `user-content-` prefix logic.

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

#### Scenario: A direct link to a document outside the pinned scope is rejected
- **WHEN** the watch session is pinned to file `README.md`
- **AND** a user navigates to `http://127.0.0.1:NNNN/guides/setup.md`
- **THEN** the SPA renders an empty-preview state explaining the session is pinned to `README.md`
- **AND** the active preview is NOT switched to `guides/setup.md`
- **AND** the sidebar still shows only the pinned file

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
The system SHALL handle the browser's `popstate` event by re-selecting the document identified by the new URL pathname, without itself pushing or replacing additional history entries. The newly active document MUST be loaded through the in-app document load path (no full-page navigation). When the URL pathname resolves to a document outside the current scope or to no known document, the system MUST apply the same empty-preview rules defined in "Open a document by direct URL". When `popstate` fires AND follow mode is currently enabled, the system MUST disable follow mode for the session so the next file-system change does not immediately undo the back/forward navigation; this mirrors the follow-off rule that already applies to sidebar clicks, cross-document link clicks, and direct-link arrival.

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
- **AND** the user clicks the browser back button
- **THEN** the active preview returns to the previous document
- **AND** follow mode is disabled
- **AND** a subsequent file-system change does NOT auto-switch the preview away from the back-navigated document until the user re-enables follow

## MODIFIED Requirements

### Requirement: Configure startup browser behavior
The system SHALL attempt to open the browser automatically and SHALL start with follow mode enabled by default. The command MUST provide flags to disable browser auto-open and to disable follow mode before the watch session starts. The local browser URL MUST be printed whether or not the browser is opened successfully. When the SPA boots with `location.pathname` resolving to a known non-binary document (anything other than `/`), the SPA MUST disable follow mode for the session regardless of the CLI default — see "Force follow mode off when arriving via a direct document URL" for the full rule.

#### Scenario: Default startup opens the browser with follow enabled
- **WHEN** a user runs `uatu watch docs`
- **THEN** the system attempts to open the browser automatically
- **AND** the watch session starts with follow mode enabled
- **AND** the local browser URL is printed

#### Scenario: Startup flags disable auto-open and follow
- **WHEN** a user runs `uatu watch docs --no-open --no-follow`
- **THEN** the system does not attempt to open the browser
- **AND** the watch session starts with follow mode disabled
- **AND** the local browser URL is printed

#### Scenario: SPA boot at the root URL honors the CLI follow default
- **WHEN** a user opens the browser to `http://127.0.0.1:NNNN/`
- **AND** the CLI was started without `--no-follow`
- **THEN** the SPA boots with follow mode enabled

### Requirement: Follow the latest changed non-binary file
When follow mode is enabled, the system SHALL switch the active preview to the latest changed non-binary file under the watched roots. Markdown and non-Markdown text files SHALL both be eligible to change the active preview under follow mode. Binary file changes MUST NOT change the active preview. Manual file selection in the sidebar MUST disable follow mode and pin the selected file until follow mode is enabled again. When the user transitions follow mode from disabled to enabled, the system SHALL immediately switch the active preview to the most recently modified non-binary file under the watched roots, rather than waiting for the next change event. When a follow-driven auto-switch changes the active document, the system MUST update the browser URL via `history.replaceState` (not `pushState`) so the address bar stays accurate while the back stack reflects only user-initiated navigation.

#### Scenario: Follow mode switches to the latest changed Markdown file
- **WHEN** follow mode is enabled and a Markdown file changes under a watched root
- **THEN** that Markdown file becomes the active selection
- **AND** the preview updates to render it

#### Scenario: Follow mode switches to the latest changed non-Markdown text file
- **WHEN** follow mode is enabled and a non-Markdown text file (e.g. `config.yaml`, `script.py`) changes under a watched root
- **THEN** that file becomes the active selection
- **AND** the preview updates to render it as syntax-highlighted code

#### Scenario: Follow mode ignores binary file changes
- **WHEN** follow mode is enabled and a binary file changes under a watched root
- **THEN** the active selection does not change
- **AND** the preview is not refreshed

#### Scenario: Manual selection disables follow mode
- **WHEN** a user manually selects a non-binary file from the sidebar while follow mode is enabled
- **THEN** follow mode is disabled
- **AND** the selected file remains active until the user re-enables follow mode or selects another file

#### Scenario: Enabling follow jumps to the latest modified file
- **WHEN** a user enables follow mode while folder-scoped
- **AND** the most recently modified non-binary file under the watched roots is not the current selection
- **THEN** the active preview switches to that most recently modified file

#### Scenario: Follow-driven auto-switch replaces the URL without pushing history
- **WHEN** follow mode is enabled and a file-system change causes the active document to switch
- **THEN** the browser URL pathname updates to the new document's relative path
- **AND** no new entry is added to the browser history stack

### Requirement: Serve adjacent files from watched roots as static content
For any request path that does not match a known API or built-in asset route, the server SHALL inspect the request's `Accept` header to distinguish top-level navigation requests from sub-resource fetches. When the `Accept` header prefers `text/html` AND the request path resolves to a known non-binary document under a watched root, the server MUST return the SPA shell (the same response served at `/`) so the SPA can render the document with its full UI. For all other requests — including requests whose `Accept` does not prefer `text/html`, requests that resolve to a binary file, and requests that do not resolve to any document — the server SHALL attempt to resolve the path against the union of watched roots and, if the path maps to an existing allowed file inside a watched root, serve that file statically. Static fallback serving MUST apply the same hardcoded ignore, default secret-file denylist, `.uatuignore`, and active `.gitignore` exposure rules as the browser tree. Static fallback serving MUST verify containment after resolving real filesystem paths and MUST NOT serve files reached through symlink escapes outside the watched root. The rendered preview HTML MUST preserve the author's original `src` and `href` URLs verbatim (no URL rewriting); the browser SHALL resolve those references using a per-document base so that relative references such as `<img src="./hero.svg">` in a README just work. Any requested path that resolves outside every watched root, is ignored, is secret-like, is malformed, or cannot be safely resolved MUST receive a non-success response and MUST NOT read or stream the file.

#### Scenario: A README's centered hero image loads via the static file fallback
- **WHEN** a previewed Markdown file contains `<img src="./hero.svg">` whose target exists next to the document and is not ignored or secret-like
- **THEN** the rendered image's `src` attribute is preserved as `./hero.svg`
- **AND** the browser resolves it through the per-document base and receives the image from the static file fallback

#### Scenario: A top-level navigation to a document URL returns the SPA shell
- **WHEN** the server receives `GET /guides/setup.md` with `Accept: text/html,application/xhtml+xml,...`
- **AND** `guides/setup.md` is a known non-binary document under a watched root
- **THEN** the server responds with the SPA shell (same body served at `/`)
- **AND** the response is NOT the raw markdown source bytes

#### Scenario: A sub-resource fetch for a document URL returns raw bytes
- **WHEN** the server receives `GET /README.md` with `Accept: */*` (e.g. from `curl`)
- **THEN** the server responds with the raw markdown source via the static fallback
- **AND** the response is NOT the SPA shell

#### Scenario: A top-level navigation to an asset URL returns the asset
- **WHEN** the server receives `GET /hero.svg` with an `Accept` header that does not prefer `text/html` (e.g. `image/avif,image/webp,*/*`)
- **THEN** the server responds with the SVG bytes via the static fallback
- **AND** the response is NOT the SPA shell

#### Scenario: Unrelated paths are 404
- **WHEN** the server receives a request for a path that does not map to any file inside a watched root
- **THEN** the server responds with 404

#### Scenario: Traversal attempts are rejected
- **WHEN** a request path resolves (via `..`) outside every watched root
- **THEN** the server responds with 404 and does not read the file

#### Scenario: Ignored files are not served directly
- **WHEN** a watched root contains a file hidden by `.uatuignore` or an active `.gitignore` rule
- **THEN** a direct static fallback request for that file receives a non-success response
- **AND** the server does not stream the ignored file contents

#### Scenario: Symlink escapes are rejected
- **WHEN** a request path maps through a symlink inside the watched root to a file outside the watched root
- **THEN** the server responds with 404 and does not stream the outside file contents

#### Scenario: Secret-like files are not served directly
- **WHEN** a watched root contains a default-denied secret-like file
- **THEN** a direct static fallback request for that file receives a non-success response
- **AND** the server does not stream the secret-like file contents

#### Scenario: Malformed URL encoding fails safely
- **WHEN** the server receives a fallback request path with malformed percent-encoding
- **THEN** the server responds with a non-success response
- **AND** request handling continues without an uncaught exception

### Requirement: Navigate cross-document anchor clicks inside the preview
When a user clicks an anchor inside the rendered preview whose resolved URL maps to a known non-binary document under any watched root, the browser UI SHALL switch the preview to that document via the in-app document load path rather than letting the browser perform a full navigation. The interception MUST resolve the click target against the per-document `<base href>` so cross-document references written as relative paths (e.g. `xref:other.adoc[…]`, `[setup](guides/setup.md)`) reach the correct document. The interception MUST NOT fire for any of the following — those clicks MUST fall through to the browser's default behavior: a fragment-only href (handled by the existing in-page anchor handler), a modifier-click (Cmd, Ctrl, Shift, or Alt held), an explicit `target` attribute other than `_self`, a URL whose origin differs from the current page, a non-`http(s):` protocol (`mailto:`, `javascript:`, `tel:`, etc.), a path that does not resolve to any document in the current state, and a path that resolves to a document classified as binary. After the in-app load completes, a fragment in the resolved URL (e.g. `other.adoc#section`) SHALL scroll the matching element into view, mirroring sanitize's `user-content-` id prefix the same way the in-page anchor handler does. When the interception fires AND the active document is changing as a result of the click, the system MUST push a new browser history entry via `history.pushState`, with the new URL being the target document's relative path (per-segment percent-encoded), so the back button can return to the previously selected document.

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
