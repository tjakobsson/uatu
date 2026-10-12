## MODIFIED Requirements

### Requirement: Open a document by direct URL
The browser UI SHALL initialize on the document or preview identified by the explicit URL when the SPA boots. When the workspace-root URL has no explicit preview query, the system MUST select a valid document path from the current user's personal workspace state, falling back to the server-provided default document when no valid saved path exists. When `location.pathname` resolves to a known non-binary document or a previewable image under a watched root, the system MUST select that file as the initial active preview, overriding both personal state and `defaultDocumentId`. A saved personal document path SHALL likewise be valid when it names a non-binary document or a previewable image, so an image Follow switched to survives a reload and a workspace-root resume. Explicit commit-preview and review-score query parameters likewise MUST override a saved document. When the watch session was started against a single file and an explicit path resolves outside that scope, the SPA MUST render the existing scoped-session empty state. Unknown paths SHALL follow the existing static-fallback/SPA behavior. A fragment SHALL scroll the matching element into view after render.

#### Scenario: Root URL restores the personal document
- **WHEN** a user opens the workspace root and personal state names `guides/setup.md`
- **AND** that document is currently viewable
- **THEN** the SPA's initial preview is `guides/setup.md`
- **AND** the sidebar selection matches

#### Scenario: Root URL falls back to the session default
- **WHEN** a user opens the workspace root with no valid saved document
- **THEN** the SPA selects the server-provided default document

#### Scenario: Navigating directly to a document URL renders that document
- **WHEN** a user navigates directly to `guides/setup.md`
- **AND** personal state names a different document
- **THEN** the SPA renders `guides/setup.md`
- **AND** the sidebar selection follows the explicit URL

#### Scenario: Refreshing an explicit document preserves it
- **WHEN** the current URL identifies a document and the user refreshes
- **THEN** the SPA renders that URL's document rather than a different saved document

#### Scenario: Refreshing an image Follow switched to preserves it
- **WHEN** Follow switched the preview to `hero.svg`, so the URL is `/hero.svg`, and the user refreshes
- **THEN** the SPA renders `hero.svg` in the preview
- **AND** follow mode is disabled, as for any direct link

#### Scenario: Root URL restores a saved image
- **WHEN** a user opens the workspace root and personal state names `hero.svg`, a previewable image
- **THEN** the SPA's initial preview is `hero.svg`

#### Scenario: Explicit preview query wins over saved document
- **WHEN** the root URL contains a resolvable commit-preview or review-score query
- **THEN** the requested preview is rendered
- **AND** no saved document replaces it

#### Scenario: A direct link outside a single-file watch scope is rejected
- **WHEN** the session was started for one file and an explicit URL names another document
- **THEN** the SPA renders the single-file-scope explanation
- **AND** does not widen the session

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
When the SPA boots with `location.pathname` resolving to a known non-binary document or a previewable image (i.e. anything other than `/`), the system MUST disable follow mode for the session, regardless of the server-provided `initialFollow` value derived from the CLI flags. The follow toggle MUST reflect the disabled state. The user MAY re-enable follow mode after arrival via the existing follow toggle. When `location.pathname` is `/`, the system MUST honor the server-provided `initialFollow` value (today's behavior preserved).

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
The system SHALL handle the browser's `popstate` event by re-selecting the document identified by the new URL pathname, without itself pushing or replacing additional history entries. A pathname naming a previewable image re-selects that image, so Back returns to an image Follow switched to as it does to a document. The newly active document MUST be loaded through the in-app document load path (no full-page navigation). When the URL pathname resolves to a document outside the current scope or to no known document, the system MUST apply the same empty-preview rules defined in "Open a document by direct URL". When `popstate` fires AND follow mode is currently enabled, the system MUST disable follow mode for the session so the next file-system change does not immediately undo the back/forward navigation; this mirrors the follow-off rule that already applies to sidebar clicks, cross-document link clicks, and direct-link arrival. When `popstate` fires AND the new URL's pathname (decoded, leading slashes stripped) matches the active document's relative path AND only the fragment has changed, the system MUST treat the event as a same-document scroll: scroll the matching element into view when the new URL has a fragment, scroll the preview to the top when the new URL has no fragment, and MUST NOT reload the document, MUST NOT push or replace history, and MUST NOT disable follow mode.

#### Scenario: Back button restores a previously selected document
- **WHEN** a user has navigated from `README.md` to `guides/setup.md` to `guides/troubleshooting.md` via in-app clicks
- **AND** the user clicks the browser back button
- **THEN** the active preview returns to `guides/setup.md`
- **AND** the sidebar selection matches

#### Scenario: Forward button restores a document the user just stepped back from
- **WHEN** a user has stepped back from `guides/troubleshooting.md` to `guides/setup.md`
- **AND** the user clicks the browser forward button
- **THEN** the active preview returns to `guides/troubleshooting.md`

#### Scenario: Back button returns to an image Follow switched to
- **WHEN** Follow switched the preview to `hero.svg` and the user then clicked `guides/setup.md` in the tree
- **AND** the user clicks the browser back button
- **THEN** the active preview returns to `hero.svg`, rendered as an image
- **AND** the preview does NOT show "Document not found"

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
