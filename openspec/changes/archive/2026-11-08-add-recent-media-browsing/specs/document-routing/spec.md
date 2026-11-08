## MODIFIED Requirements

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
