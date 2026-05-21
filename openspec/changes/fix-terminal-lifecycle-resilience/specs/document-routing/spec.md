## MODIFIED Requirements

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

## ADDED Requirements

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
