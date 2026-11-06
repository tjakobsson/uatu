## MODIFIED Requirements

### Requirement: Browse supported documents from watched roots
The sidebar SHALL offer the permitted indexed files under each watched root through All, Recent, and Changed. Markdown, AsciiDoc, and viewable text SHALL render through their existing document pipelines. Binary files SHALL be clickable; previewable images SHALL render as images, recognized audio/video SHALL open paused media previews, and unsupported binaries SHALL show preview unavailable. Mandatory denied paths, secrets, and explicit Uatu exclusions SHALL not appear or be directly readable. Git-ignore status SHALL be indexed separately from each client's visibility choice, and permitted ignored files SHALL be available when that client shows them. Narrow configured build/dist output includes SHALL follow the tree-filtering capability.

#### Scenario: Sidebar lists every non-ignored file under each watched root
- **WHEN** roots contain Markdown, AsciiDoc, source, configuration, image, media, and unsupported binary files
- **THEN** all permitted entries are available under the applicable view and visibility settings
- **AND** each type routes to its corresponding preview or unavailable state

#### Scenario: Secret-like files are excluded by default
- **WHEN** roots contain default-denied secret-bearing files such as environment files, credentials, or private keys
- **THEN** they are not listed and cannot be previewed or delivered by direct identity

#### Scenario: Selecting a Markdown file renders its preview
- **WHEN** a Markdown filename is selected
- **THEN** it becomes active and renders through the Markdown pipeline

#### Scenario: Selecting an AsciiDoc file renders its preview
- **WHEN** an adoc/asciidoc filename is selected
- **THEN** it becomes active and renders through the AsciiDoc pipeline

#### Scenario: A `.asc` file is not rendered as AsciiDoc
- **WHEN** an ASCII-armored signature file uses the asc extension
- **THEN** it is treated as text rather than AsciiDoc

#### Scenario: Selecting a non-Markdown text file renders its preview
- **WHEN** another viewable text filename is selected
- **THEN** it becomes active and uses the existing source/code pipeline

#### Scenario: Selecting a binary entry routes to the preview-unavailable view
- **WHEN** an unsupported binary filename is selected
- **THEN** selection updates to that file and preview unavailable is displayed without streaming its contents into document rendering

### Requirement: Keep the indexed view and preview current
The system SHALL detect creations, deletions, renames, and writes under permitted watched roots and update file metadata and views incrementally. Watching and indexing SHALL share exposure rules. A changed active non-media file SHALL refresh regardless of Follow, invalidating affected Source, Rendered, Diff, and image representations; freshness SHALL not depend solely on a batch's representative Follow target or modification-time equality. Selected and embedded watched images SHALL show the new revision without rerendering the surrounding document or resetting scroll. Existing exclusions for file-scoped embedded-image refresh, srcset/picture, CSS background images, and interactive SVG objects SHALL remain. Active audio/video is the explicit-refresh exception: revision changes SHALL follow media-playback's New render available/Reload contract rather than replacing a mounted source automatically. Fresh snapshots SHALL reconcile revisions after gaps, and stale asynchronous work MUST NOT replace newer selections or revisions. Classification SHALL be reevaluated for writes/renames. Event publication SHALL be scheduled within two seconds of the first queued normalized event even under sustained churn. Keepalives SHALL have no presentation effect or expected-idle warnings. Watchers MUST NOT traverse Git internals or excluded symlink trees and MUST survive transient watcher errors.

#### Scenario: A new file appears in the sidebar
- **WHEN** a permitted file is created under a watched root
- **THEN** it becomes available in the corresponding Files views with its actual write time

#### Scenario: The active document refreshes after a save
- **WHEN** an active non-media document is saved with Follow on or off
- **THEN** current contents replace its preview and old cached representations cannot reappear

#### Scenario: The selected image refreshes after it changes
- **WHEN** the selected image is rewritten
- **THEN** its new revision appears in place without blanking the image or resetting scroll

#### Scenario: An embedded image refreshes when only the image changes
- **WHEN** a watched embedded image changes without a surrounding Markdown/AsciiDoc write
- **THEN** the image refreshes without rerendering the document or changing scroll

#### Scenario: A multi-file burst includes the active document
- **WHEN** a batch includes the active document and other paths
- **THEN** the active document refreshes independently of the representative Follow target

#### Scenario: Reconnection reconciles a missed active-document change
- **WHEN** recovery supplies a newer active-file revision with equal modification time
- **THEN** the non-media preview reloads and an active media session instead gets its explicit update notice

#### Scenario: An older preview load finishes last
- **WHEN** an older asynchronous load completes after a newer load or selection
- **THEN** it cannot replace the preview or populate the newer revision's cache

#### Scenario: Sustained churn cannot starve the refresh
- **WHEN** file events continue faster than the debounce interval
- **THEN** publication is scheduled within two seconds and remaining paths stay queued

#### Scenario: A rename across the binary boundary updates clickability
- **WHEN** a file is renamed across text, image, media, or unsupported-binary classification
- **THEN** routing uses the new classification and retained old destinations use normal unavailable rules

#### Scenario: Idle watch periods do not look like failures
- **WHEN** no file writes occur while the client stays connected
- **THEN** keepalives maintain delivery without warnings or forced UI refreshes

#### Scenario: Excluded paths do not expand watch coverage
- **WHEN** a directory is mandatory-denied or an excluded symlink tree
- **THEN** the content watcher neither traverses it nor attaches descendant watchers

#### Scenario: The watcher does not descend into `.git/`
- **WHEN** a content path has a .git directory segment
- **THEN** it is excluded from content watching, including with generated-output includes

#### Scenario: A transient watch-syscall failure does not crash the process
- **WHEN** a disappearing path causes a transient observation error
- **THEN** the process remains available and uncertain coverage is recovered

#### Scenario: A playing export is overwritten
- **WHEN** the active media's revision changes
- **THEN** index and Recent metadata update but the media source is not automatically replaced or restarted

### Requirement: Serve adjacent files from watched roots as static content
The server SHALL distinguish HTML-preferring top-level navigation from subresource requests using Accept. Navigation to any known indexed file SHALL return the SPA shell rather than raw file contents, including images/media, so a watched SVG cannot execute at the app origin through direct navigation. Other fallback requests SHALL resolve against permitted files under watched roots, enforcing mandatory denied paths, secrets, explicit Uatu excludes, configured output includes, and realpath containment. Git-ignore browsing visibility SHALL not deny permitted authenticated static delivery. Authored rendered src/href references SHALL remain unchanged in server HTML and resolve through the per-document base. Mounted watched images SHALL retain revision query parameters for cache invalidation; static path resolution SHALL ignore that query string. External or non-watched image URLs SHALL remain unchanged. Traversal, malformed encoding, and symlink escapes SHALL fail without serving outside contents. The dedicated media route SHALL retain its own indexed-identity/range contract and SHALL not depend on this fallback's Accept negotiation.

#### Scenario: A README's centered hero image loads via the static file fallback
- **WHEN** an allowed adjacent image is referenced by a relative src
- **THEN** server-rendered HTML preserves that src, the per-document base resolves it, and the mounted watched image carries its revision

#### Scenario: A top-level navigation to a document URL returns the SPA shell
- **WHEN** a known document is requested with HTML-preferring Accept
- **THEN** the shell is returned instead of raw document contents

#### Scenario: A top-level navigation to an image URL returns the SPA shell
- **WHEN** a known image is requested with HTML-preferring Accept
- **THEN** the shell is returned instead of raw image/SVG contents

#### Scenario: A sub-resource fetch for a document URL returns raw bytes
- **WHEN** an allowed document is requested with Accept */*
- **THEN** its raw contents are returned instead of the shell

#### Scenario: A top-level navigation to an asset URL returns the asset
- **WHEN** a permitted image is requested as an image subresource
- **THEN** its image bytes are returned instead of the shell

#### Scenario: Unrelated paths are 404
- **WHEN** a non-navigation request resolves to no permitted existing file
- **THEN** it receives 404

#### Scenario: Traversal attempts are rejected
- **WHEN** a request resolves outside every watched root
- **THEN** it receives no outside file contents

#### Scenario: Excluded files are not served directly
- **WHEN** an explicit Uatu exclusion removes a path
- **THEN** direct static delivery refuses it even when ignored files are shown

#### Scenario: Symlink escapes are rejected
- **WHEN** realpath resolution escapes a watched root
- **THEN** the outside file is not served

#### Scenario: Secret-like files are not served directly
- **WHEN** a static request names a default-denied secret-like file
- **THEN** no file contents are streamed

#### Scenario: Malformed URL encoding fails safely
- **WHEN** a fallback URL has malformed percent encoding
- **THEN** it fails without uncaught request-handling errors

#### Scenario: Browsing visibility does not deny a permitted ignored asset
- **WHEN** a client hides ignored rows but an allowed document references an ignored image
- **THEN** authenticated static delivery can still load that image

### Requirement: Detect binary files and route them to the right preview
The system SHALL classify permitted files as Markdown, AsciiDoc, viewable text, or binary using known-extension fast paths and at most an initial 8 KB binary sniff for unfamiliar names. Binary entries SHALL remain clickable. Existing previewable image extensions SHALL render through the image path; recognized audio/video candidates SHALL open paused media previews; other binaries SHALL show preview unavailable. Codec failure SHALL not be misreported as document absence. Images SHALL retain existing Follow eligibility, while audio/video and unsupported binaries SHALL not become automatic Follow targets. All binaries SHALL remain excluded from initial default-document selection and Follow-enable catch-up.

#### Scenario: An image file is rendered inline in the preview pane
- **WHEN** a known previewable image is selected
- **THEN** its image is displayed using file delivery rather than document JSON

#### Scenario: A non-image binary lists as a clickable entry routed to preview-unavailable
- **WHEN** archive.zip is selected
- **THEN** selection updates and preview unavailable is shown without a document-not-found message

#### Scenario: An unknown-extension binary blob is detected via content sniff
- **WHEN** an unfamiliar file's initial sniff contains a NUL byte or excessive non-printable content
- **THEN** it is classified binary and shows unavailable unless it is a recognized preview candidate

#### Scenario: A plain text file with no extension is treated as text
- **WHEN** Makefile contains ordinary text
- **THEN** it is listed and uses the existing source/code preview

#### Scenario: Binary files are excluded from the on-startup default document
- **WHEN** the newest file is an image, audio, video, or other binary
- **THEN** the startup default remains the newest eligible non-binary document

#### Scenario: A fresh sound export does not steal Follow
- **WHEN** Follow is enabled and a sound/video export is written
- **THEN** Recent updates but Follow does not switch the preview to the export or start it playing

## REMOVED Requirements

### Requirement: Respect `.gitignore` by default with an opt-out
**Reason**: Permitted Gitignored files need shared observation and per-client visibility for generated-media browsing.
**Migration**: Apply the tree-filtering capability's Show ignored files defaults and legacy-setting migration. Keep explicit Uatu excludes as exposure policy and runtime Git-ignore edits as classification/visibility updates rather than shared index deletion.

## ADDED Requirements

### Requirement: Ignored-file observation is independent of browsing visibility
The shared index SHALL retain permitted Gitignored files and deliver their write metadata and revisions through existing ordered snapshots/patches. Each client's visibility SHALL determine its browsing results and document/image Follow candidates without reconstructing the shared watcher or changing another client's corpus. Unknown ignore classification SHALL be represented without falsely asserting a Git state. Policy evaluation SHALL support standard Git-ignore sources and shall update when they change. Discovery/recovery SHALL remain bounded and incremental file writes SHALL retain path-bounded index work; toggling a client preference MUST NOT start a filesystem crawl.

#### Scenario: Two clients choose different ignored visibility
- **WHEN** one shows ignored files and another hides them while the same ignored export changes
- **THEN** the showing client's eligible views update, the hiding client's results remain filtered, and neither preference changes the other's state
- **AND** their existing document-topic delivery remains coherent

#### Scenario: Follow candidates differ between clients
- **WHEN** a newly written ignored document/image is eligible only in one client's visibility context
- **THEN** it can become that client's Follow target without steering the other client to a hidden file

#### Scenario: A visibility toggle is cheap
- **WHEN** a user toggles Show ignored files after discovery
- **THEN** results are projected from known file metadata without restarting watchers or performing a full scan
