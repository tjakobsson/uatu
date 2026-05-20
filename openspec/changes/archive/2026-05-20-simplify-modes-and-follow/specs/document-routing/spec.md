## MODIFIED Requirements

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
