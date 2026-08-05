## MODIFIED Requirements

### Requirement: Open a document by direct URL
The browser UI SHALL initialize on the document or preview identified by the explicit URL when the SPA boots. When the workspace-root URL has no explicit preview query, the system MUST select a valid document path from the current user's personal workspace state, falling back to the server-provided default document when no valid saved path exists. When `location.pathname` resolves to a known non-binary document under a watched root, the system MUST select that document as the initial active preview, overriding both personal state and `defaultDocumentId`. Explicit commit-preview and review-score query parameters likewise MUST override a saved document. When the watch session was started against a single file and an explicit path resolves outside that scope, the SPA MUST render the existing scoped-session empty state. Unknown paths SHALL follow the existing static-fallback/SPA behavior. A fragment SHALL scroll the matching element into view after render.

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

#### Scenario: Explicit preview query wins over saved document
- **WHEN** the root URL contains a resolvable commit-preview or review-score query
- **THEN** the requested preview is rendered
- **AND** no saved document replaces it

#### Scenario: Direct link outside a single-file watch scope is rejected
- **WHEN** the session was started for one file and an explicit URL names another document
- **THEN** the SPA renders the single-file-scope explanation
- **AND** does not widen the session
