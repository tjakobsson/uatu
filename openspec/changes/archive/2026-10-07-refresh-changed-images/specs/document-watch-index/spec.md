## RENAMED Requirements

- FROM: `### Requirement: Follow the latest changed non-binary file`
- TO: `### Requirement: Follow the latest changed file the preview can show`

## MODIFIED Requirements

### Requirement: Keep the indexed view and preview current
The system SHALL detect file creation, deletion, rename, and modification events under watched roots, applying the same ignore filter the indexer uses, and update the indexed sidebar view accordingly. When the currently selected file changes on disk in a mode that permits live document refresh, the preview MUST refresh automatically. An `<img>` element in the preview whose `src` resolves to a file under a watched root — the selected image file itself, or an image embedded in the selected Markdown or AsciiDoc document — MUST show its current content after that file changes on disk, even when the surrounding document did not change; the browser's copy of an earlier version MUST NOT be reused. File-scoped (single-file pinned) sessions, `srcset` and `<picture>` sources, CSS background images, and AsciiDoc interactive SVGs rendered as `<object>` are not covered. Refreshing such an image MUST NOT re-render the surrounding document and MUST NOT reset the preview's scroll position. When follow mode is enabled and the changed file is an image embedded in the document the preview shows, the image MUST refresh in place and the active selection MUST NOT switch to the image. Active-preview freshness MUST NOT depend solely on one file being selected as the representative change from a debounced multi-file batch. A fresh state snapshot received after a live-update connection gap MUST reconcile the active preview when that snapshot shows that the selected document changed. When multiple preview loads overlap, an older load MUST NOT replace the content produced by a newer refresh or selection. Binary classification SHALL be re-evaluated when a file is renamed or modified so that an extension change (e.g. `data.bin` → `data.json`) reflects in the tree's clickability and render path. Refresh scheduling MAY debounce bursts of events, but sustained event streams MUST NOT starve updates: a refresh SHALL occur no later than a bounded interval (at most 2 seconds) after the first unprocessed event, even while further events continue to arrive and reset the debounce. The live update channel MUST remain available during normal idle periods without requiring user action or emitting spurious server timeout warnings for expected long-lived connections. The watcher MUST NOT attach native filesystem watchers to any path whose location relative to a watched root contains a `.git` directory segment, since that directory is git's working metadata and is never user-authored content the indexer surfaces. The watcher MUST tolerate transient errors from the underlying filesystem watcher implementation (for example, an `EINVAL` from a `watch` syscall against a file that has already been removed) without terminating the host process; such errors MAY be logged but MUST NOT propagate as unhandled errors.

#### Scenario: A new file appears in the sidebar
- **WHEN** a new non-ignored file is created within a watched root
- **THEN** the sidebar updates to include the new file in the correct root and directory grouping

#### Scenario: The active document refreshes after a save
- **WHEN** the currently selected file is modified on disk in a mode that permits live document refresh
- **THEN** the preview refreshes to show the updated rendered content

#### Scenario: The selected image refreshes after it changes
- **WHEN** an image file such as `hero.svg` is selected and the file is rewritten on disk
- **THEN** the preview shows the new image without a page reload
- **AND** the image element stays mounted, so the pane neither blanks nor scrolls

#### Scenario: An embedded image refreshes when only the image changes
- **WHEN** the selected Markdown document embeds `<img src="./hero.svg">` and only `hero.svg` is rewritten on disk
- **THEN** the embedded image shows the new content
- **AND** the document around it is not re-rendered and keeps its scroll position
- **AND** with follow mode enabled, the selection stays on the Markdown document rather than switching to `hero.svg`

#### Scenario: A multi-file burst includes the active document
- **WHEN** the selected document and another watched path change within one debounced refresh batch
- **THEN** the preview refreshes to show the selected document's updated content
- **AND** the representative change used for Follow does not determine whether the selected document is considered stale

#### Scenario: Reconnection reconciles a missed active-document change
- **WHEN** the selected document changes while the live update connection is interrupted
- **AND** the client subsequently receives a fresh state snapshot showing that change
- **THEN** the preview refreshes to show the current document content

#### Scenario: An older preview load finishes last
- **WHEN** two document loads overlap and the older load completes after the newer load
- **THEN** the older result does not replace the newer active preview

#### Scenario: Sustained churn cannot starve the refresh
- **WHEN** files under a watched root change continuously at intervals shorter than the debounce interval
- **THEN** a refresh still occurs within the bounded interval after the first unprocessed event
- **AND** the sidebar and any follow-driven selection reflect the changes without waiting for the churn to stop

#### Scenario: A rename across the binary boundary updates clickability
- **WHEN** a binary file is renamed to an extension classified as text (or vice versa)
- **THEN** the sidebar entry's clickability and icon update to reflect the new classification

#### Scenario: Idle watch periods do not look like failures
- **WHEN** the browser remains connected to the live update channel during a normal idle period with no file changes
- **THEN** the watch session remains available without requiring the user to reconnect
- **AND** the server does not emit a timeout warning for that expected idle connection

#### Scenario: The watcher does not descend into `.git/`
- **WHEN** a path under a watched root has any path segment equal to `.git` between the watched root and the path itself
- **THEN** the watcher's ignore predicate returns true for that path
- **AND** no native filesystem watcher is attached to it

#### Scenario: A transient watch-syscall failure does not crash the process
- **WHEN** the underlying filesystem watcher emits an error event for a single watch target (for example, an `EINVAL` from a `watch` syscall against a file that has already been unlinked)
- **THEN** the host process does not terminate
- **AND** the watch session remains available for subsequent events

### Requirement: Follow the latest changed file the preview can show
When follow mode is enabled AND the active Mode is **Author**, the system SHALL switch the active preview to the latest changed file under the watched roots that the preview can show. Markdown and non-Markdown text files SHALL both be eligible to change the active preview under follow mode, and so SHALL binary files with a viewable image extension (see "Detect binary files and route them to the right preview"), which the preview renders inline. A changed image that is embedded in the document the preview currently shows MUST NOT change the active preview; that image refreshes in place instead. Changes to any other binary file MUST NOT change the active preview. Manual file selection in the sidebar MUST disable follow mode and pin the selected file until follow mode is enabled again. When the user transitions follow mode from disabled to enabled while in **Author** Mode, the system SHALL immediately switch the active preview to the most recently modified non-binary file under the watched roots, rather than waiting for the next change event. When a follow-driven auto-switch changes the active document, the system MUST update the browser URL via `history.replaceState` (not `pushState`) so the address bar stays accurate while the back stack reflects only user-initiated navigation. While the active Mode is **Review**, follow mode MUST be off, the Follow control MUST NOT be rendered (the chip is hidden in the preview toolbar), and file-system change events MUST NOT switch the active preview. When the user transitions from **Author** to **Review**, the system SHALL snapshot the user's current Follow choice; when the user later transitions from **Review** back to **Author**, the system SHALL restore Follow to that snapshot value so the user's Author-mode Follow choice round-trips through Review automatically and they do not have to re-enable Follow after every Review peek. Manual file selection from the `Files` pane and other manual navigation (e.g. `Git Log` commit clicks, direct URLs) MUST continue to work in **Review** Mode. In **Author** Mode, in-place refresh of the currently displayed file's content when that file changes on disk SHALL continue to work as today. In **Review** Mode, the system MUST NOT automatically re-render the active preview when the currently displayed file changes on disk.

#### Scenario: Follow mode switches to the latest changed Markdown file
- **WHEN** Mode is **Author** and follow mode is enabled and a Markdown file changes under a watched root
- **THEN** that Markdown file becomes the active selection
- **AND** the preview updates to render it

#### Scenario: Follow mode switches to the latest changed non-Markdown text file
- **WHEN** Mode is **Author** and follow mode is enabled and a non-Markdown text file (e.g. `config.yaml`, `script.py`) changes under a watched root
- **THEN** that file becomes the active selection
- **AND** the preview updates to render it as syntax-highlighted code

#### Scenario: Follow mode switches to a changed image
- **WHEN** Mode is **Author** and follow mode is enabled and an image with a viewable image extension (e.g. `hero.svg`, `logo.png`) that the document in the preview does not embed changes under a watched root
- **THEN** that image becomes the active selection
- **AND** the preview renders its current content inline

#### Scenario: Follow mode ignores binary file changes
- **WHEN** Mode is **Author** and follow mode is enabled and a binary file without a viewable image extension (e.g. `bundle.zip`, `manual.pdf`) changes under a watched root
- **THEN** the active selection does not change
- **AND** the preview is not refreshed

#### Scenario: Manual selection disables follow mode
- **WHEN** a user manually selects a non-binary file from the sidebar while in **Author** Mode and follow mode is enabled
- **THEN** follow mode is disabled
- **AND** the selected file remains active until the user re-enables follow mode or selects another file

#### Scenario: Enabling follow jumps to the latest modified file
- **WHEN** a user enables follow mode while folder-scoped in **Author** Mode
- **AND** the most recently modified non-binary file under the watched roots is not the current selection
- **THEN** the active preview switches to that most recently modified file

#### Scenario: Follow-driven auto-switch replaces the URL without pushing history
- **WHEN** Mode is **Author** and follow mode is enabled and a file-system change causes the active document to switch
- **THEN** the browser URL pathname updates to the new document's relative path
- **AND** no new entry is added to the browser history stack

#### Scenario: Review Mode suppresses file-change-driven preview switching
- **WHEN** Mode is **Review** and the active preview is some file A
- **AND** a different non-binary file B changes under a watched root
- **THEN** the active preview remains file A
- **AND** the browser URL does not change

#### Scenario: Review Mode allows manual file selection
- **WHEN** Mode is **Review**
- **AND** the user clicks a non-binary file in the `Files` pane
- **THEN** the active preview switches to that file
- **AND** the browser URL updates to that file

#### Scenario: Review Mode does not re-render the active preview when the active file changes on disk
- **WHEN** Mode is **Review** and the currently displayed file changes on disk
- **THEN** the active preview does not re-render
- **AND** the rendered content the reviewer was reading remains visible

#### Scenario: Author Mode refreshes the currently displayed file in place
- **WHEN** Mode is **Author** and the currently displayed file changes on disk
- **THEN** the preview re-renders the new content for that same file
- **AND** the active selection does not switch to a different file when Follow is off

#### Scenario: Follow control is hidden in Review mode
- **WHEN** Mode is **Review**
- **THEN** the `Follow` chip in the preview toolbar is not rendered (hidden, not merely disabled)

#### Scenario: Follow ON in Author round-trips through Review back to Author
- **WHEN** Mode is **Author** and the user has Follow enabled
- **AND** the user switches to **Review**
- **AND** later switches back to **Author**
- **THEN** Follow is restored to enabled automatically without user action
- **AND** the Follow chip is visible and shows the active state

#### Scenario: Follow OFF in Author round-trips through Review back to Author
- **WHEN** Mode is **Author** and the user has Follow disabled
- **AND** the user switches to **Review**
- **AND** later switches back to **Author**
- **THEN** Follow remains disabled (the user's Author-mode preference is preserved)

### Requirement: Serve adjacent files from watched roots as static content
For any request path that does not match a known API or built-in asset route, the server SHALL inspect the request's `Accept` header to distinguish top-level navigation requests from sub-resource fetches. When the `Accept` header prefers `text/html` AND the request path resolves to a known non-binary document under a watched root, the server MUST return the SPA shell (the same response served at `/`) so the SPA can render the document with its full UI. For all other requests — including requests whose `Accept` does not prefer `text/html`, requests that resolve to a binary file, and requests that do not resolve to any document — the server SHALL attempt to resolve the path against the union of watched roots and, if the path maps to an existing allowed file inside a watched root, serve that file statically. Static fallback serving MUST apply the same hardcoded ignore, default secret-file denylist, `.uatu.json ignore.exclude` patterns, and active `.gitignore` exposure rules as the browser tree. Static fallback serving MUST verify containment after resolving real filesystem paths and MUST NOT serve files reached through symlink escapes outside the watched root. The rendered preview HTML MUST preserve the author's original `src` and `href` URLs verbatim (no URL rewriting); the browser SHALL resolve those references using a per-document base so that relative references such as `<img src="./hero.svg">` in a README just work. The one exception is an image whose URL resolves to a file under a watched root: the client MAY add a version query parameter derived from the file's modification time, so that a changed image is fetched again rather than reused from the browser's image cache. Static fallback serving SHALL resolve files by path alone and ignore the query string. Images on other origins and URLs that do not resolve to a watched file MUST be left as authored. Any requested path that resolves outside every watched root, is ignored, is secret-like, is malformed, or cannot be safely resolved MUST receive a non-success response and MUST NOT read or stream the file.

#### Scenario: A README's centered hero image loads via the static file fallback
- **WHEN** a previewed Markdown file contains `<img src="./hero.svg">` whose target exists next to the document and is not ignored or secret-like
- **THEN** the rendered HTML from the server preserves the image's `src` as `./hero.svg`
- **AND** the browser resolves it through the per-document base and receives the image from the static file fallback
- **AND** once the preview is mounted, the image's URL carries the file's version as a query parameter

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

#### Scenario: Excluded files are not served directly
- **WHEN** a watched root contains a file hidden by `.uatu.json ignore.exclude` or an active `.gitignore` rule
- **THEN** a direct static fallback request for that file receives a non-success response
- **AND** the server does not stream the excluded file contents

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

### Requirement: Detect binary files and route them to the right preview
The system SHALL classify every file accepted by the ignore filter as either a Markdown document, an AsciiDoc document, a viewable text file, or a binary file. Binary files SHALL appear in the sidebar tree as clickable entries. Selecting a binary entry SHALL change the active document to that file and route the preview based on the file's extension: binaries with a viewable image extension (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.ico`, `.avif`, `.bmp`) SHALL render inline in the preview pane via `<img>`, served by uatu's static-file fallback; all other binaries SHALL render the existing preview-unavailable notice. Binary classification SHALL use a fast path of known-binary file extensions, and a content sniff (NUL bytes or excessive non-printable byte ratio in the first 8 KB) for files whose extensions are not in the known-text or known-binary lists. Under follow-mode auto-switch, a change to a binary entry with a viewable image extension SHALL be eligible to change the active document, since the preview renders it; all other binary entries MUST remain ineligible. Binary entries, images included, MUST remain excluded from the on-startup default document and from the catch-up when Follow is turned on.

#### Scenario: An image file is rendered inline in the preview pane
- **WHEN** the watch root contains `logo.png` and the user selects it from the tree
- **THEN** the active selection updates to that file
- **AND** the preview renders an `<img>` tag for the file rather than the preview-unavailable view
- **AND** the image bytes are served by the static-file fallback (not the document-render API)

#### Scenario: A non-image binary lists as a clickable entry routed to preview-unavailable
- **WHEN** the watch root contains `archive.zip`
- **THEN** the sidebar tree lists `archive.zip` as a clickable entry
- **AND** clicking it updates the active selection to that file
- **AND** the preview displays a "this file type isn't viewable" notice rather than streaming binary bytes
- **AND** the preview does NOT display a "document not found" or "no longer exists" message

#### Scenario: An unknown-extension binary blob is detected via content sniff
- **WHEN** the watch root contains a file with an unfamiliar extension whose first 8 KB contain a NUL byte
- **THEN** the sidebar tree lists that file as a clickable entry
- **AND** selecting it routes the preview to the preview-unavailable notice (no image extension matched)

#### Scenario: A plain text file with no extension is treated as text
- **WHEN** the watch root contains a file named `Makefile` whose contents are plain ASCII
- **THEN** the sidebar tree lists `Makefile` as a clickable entry
- **AND** selecting `Makefile` renders its contents in the preview as syntax-highlighted code

#### Scenario: Binary files are excluded from the on-startup default document
- **WHEN** the most recently modified file under the watched roots is a binary file (image or otherwise)
- **THEN** the on-startup default document is the most recently modified non-binary file instead
