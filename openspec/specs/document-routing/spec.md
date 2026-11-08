# document-routing Specification

## Purpose
Route documents, commit previews, cross-document links, and fragments through the SPA with accurate URLs and browser history while preserving native handling for external and binary links.

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
The browser UI SHALL initialize on the document or preview identified by an explicit URL. With no explicit preview query at the workspace root, it SHALL restore a valid personal document path, otherwise the session default. Known non-binary documents, previewable images, and recognized audio/video files SHALL be valid explicit and saved preview destinations. Explicit commit-preview and other supported preview queries SHALL override a saved document. Media URLs and saved media previews SHALL open paused, without restoring an audition session. A CLI single-file constraint SHALL not be widened by an explicit path. Unknown paths SHALL retain existing static-fallback/SPA behavior; fragments SHALL retain normal post-render handling where applicable. Existing intentional-deselection rules SHALL continue to override implicit restoration.

#### Scenario: Root URL restores the personal document
- **WHEN** the workspace root is opened and personal state names a valid document
- **THEN** the preview and file selection restore that document

#### Scenario: Root URL falls back to the session default
- **WHEN** the root URL has no valid saved destination or intentional-empty state
- **THEN** the session default is selected

#### Scenario: Navigating directly to a document URL renders that document
- **WHEN** an explicit known document URL is opened and a different destination is saved
- **THEN** the explicit URL determines preview and selection

#### Scenario: Refreshing an explicit document preserves it
- **WHEN** a document URL is refreshed
- **THEN** that document remains the initial preview

#### Scenario: Refreshing an image Follow switched to preserves it
- **WHEN** Follow displayed an image and its explicit URL is refreshed
- **THEN** that image is previewed with Follow off

#### Scenario: Root URL restores a saved image
- **WHEN** personal state names a valid previewable image
- **THEN** a root arrival restores that image

#### Scenario: Explicit preview query wins over saved document
- **WHEN** a supported explicit preview query is present
- **THEN** the requested preview is displayed instead of a saved document

#### Scenario: A direct link outside a single-file watch scope is rejected
- **WHEN** an explicit path is outside a CLI single-file scope
- **THEN** the existing scoped-session explanation is shown without widening the scope

#### Scenario: A video URL is refreshed
- **WHEN** an allowed recognized video's URL is opened or refreshed
- **THEN** the SPA shows that video's paused preview rather than autoplaying or selecting another document

#### Scenario: Root arrival restores saved audio without autoplay
- **WHEN** personal state names an allowed recognized audio file
- **THEN** its paused preview is restored without restoring prior playback position or active auditioning

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

#### Scenario: HTML-preferring navigation to a watched image serves the SPA shell
- **WHEN** the server receives a GET to `/diagram.png` with `Accept: text/html,application/xhtml+xml,*/*`
- **AND** `diagram.png` is a known file under a watched root
- **THEN** the response status is `200`
- **AND** the response body is the SPA shell, which renders `diagram.png` in the preview
- **AND** the response is NOT the file's bytes

### Requirement: Force follow mode off when arriving via a direct document URL
An explicit non-root URL resolving to a known non-binary document, previewable image, or recognized media file SHALL disable Follow at boot regardless of the launch default, and the control SHALL reflect that state. The user SHALL remain able to re-enable Follow explicitly. Root arrival SHALL retain existing initial-Follow resolution. Opening media through any URL SHALL not initiate playback.

#### Scenario: Direct link arrival turns follow mode off
- **WHEN** an explicit document, image, or recognized media URL is opened with launch Follow enabled
- **THEN** Follow is disabled and its toggle reflects that state

#### Scenario: Default-URL arrival honors the CLI follow default
- **WHEN** the workspace root is opened without a saved overriding preference or intentional-empty state
- **THEN** the existing launch Follow default applies

#### Scenario: User can re-enable follow after a direct-link arrival
- **WHEN** the user enables Follow after a direct-link arrival
- **THEN** existing eligible document/image catch-up behavior resumes without autoplaying media

### Requirement: Navigate document history with the browser back and forward buttons
The system SHALL restore the destination identified by popstate through in-app preview loading, without pushing or replacing additional history. Recognized media SHALL be valid history destinations alongside documents and previewable images. A restored media preview SHALL be paused unless it presents the same clip's independently active playback session, which SHALL continue without a duplicate source. Unknown/out-of-scope destinations SHALL follow the existing empty-preview rules. Destination-changing Back/Forward SHALL disable Follow. A same-document fragment-only transition SHALL scroll to the fragment or top without reloading, changing history, or disabling Follow. History navigation alone SHALL not start or replace an independently active audition session.

#### Scenario: Back button restores a previously selected document
- **WHEN** Back follows navigation across several document destinations
- **THEN** the preceding document and sidebar selection are restored without full-page navigation

#### Scenario: Forward button restores a document the user just stepped back from
- **WHEN** Forward follows a document-history Back action
- **THEN** the later document and selection are restored

#### Scenario: Back button returns to an image Follow switched to
- **WHEN** history contains a previewable image destination
- **THEN** Back restores the image preview without a document-not-found notice

#### Scenario: Popstate to a no-longer-existent document renders empty preview
- **WHEN** the destination was deleted or is outside current scope
- **THEN** the appropriate unavailable preview is shown while Files remains usable

#### Scenario: Browser back disables follow mode
- **WHEN** Back changes the preview destination while Follow is on
- **THEN** Follow turns off and later file writes do not undo that navigation

#### Scenario: Popstate that only changes the fragment scrolls within the same document
- **WHEN** only the fragment changes in the current document's history
- **THEN** the preview scrolls to its target or top without reloading or changing Follow

#### Scenario: Back restores a video preview while another clip is auditioned
- **WHEN** Back resolves to a recognized video and a different audition session is active
- **THEN** that video's preview opens paused and does not replace or duplicate the active audition

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
