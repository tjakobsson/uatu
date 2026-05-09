# document-watch-index Specification

## Purpose
TBD - created by archiving change split-document-watch-browser. Update Purpose after archive.
## Requirements
### Requirement: Browse supported documents from watched roots
The browser UI SHALL display a sidebar tree grouped by watched root. The tree SHALL list every file accepted by the ignore and exposure filters under each root, recursively. Files classified as Markdown, AsciiDoc, or as viewable text SHALL render as clickable entries that can become the active preview. Files classified as binary SHALL render as non-clickable entries that show a file-type icon but cannot change the active preview. Files matching default-denied secret patterns, hardcoded ignored names, `.uatuignore`, or active `.gitignore` rules MUST NOT appear in the sidebar. The preview pane SHALL render the currently selected non-binary file: Markdown files through the Markdown pipeline, AsciiDoc files through the AsciiDoc pipeline, other text files through the syntax-highlighted code render path.

#### Scenario: Sidebar lists every non-ignored file under each watched root
- **WHEN** watched roots contain a mix of Markdown, AsciiDoc, source code, configuration, and binary files
- **THEN** the sidebar displays all of those files within the hierarchy of their corresponding watched root
- **AND** Markdown, AsciiDoc, and other text files appear as clickable entries
- **AND** binary files appear as non-clickable entries

#### Scenario: Secret-like files are excluded by default
- **WHEN** a watched root contains common secret-bearing files such as `.env`, `.env.local`, `.npmrc`, credential JSON, or private-key files
- **THEN** those files do not appear as clickable or non-clickable sidebar entries
- **AND** they cannot become the active preview document by direct document ID request

#### Scenario: Selecting a Markdown file renders its preview
- **WHEN** a user selects a Markdown file from the sidebar
- **THEN** the preview pane renders that file through the Markdown pipeline
- **AND** the active selection updates to the chosen file

#### Scenario: Selecting an AsciiDoc file renders its preview
- **WHEN** a user selects an AsciiDoc file (`.adoc` or `.asciidoc`) from the sidebar
- **THEN** the preview pane renders that file through the AsciiDoc pipeline
- **AND** the active selection updates to the chosen file

#### Scenario: A `.asc` file is not rendered as AsciiDoc
- **WHEN** the watch root contains a `release-1.0.tar.gz.asc` PGP signature file
- **THEN** the sidebar lists it as a regular text entry rather than as an AsciiDoc document
- **AND** selecting it renders its contents through the syntax-highlighted code path, not the AsciiDoc pipeline

#### Scenario: Selecting a non-Markdown text file renders its preview
- **WHEN** a user selects a non-Markdown, non-AsciiDoc text file (e.g. `.yaml`, `.py`, `.json`) from the sidebar
- **THEN** the preview pane renders that file as syntax-highlighted code
- **AND** the active selection updates to the chosen file

#### Scenario: A binary entry cannot be selected
- **WHEN** a user clicks a binary tree entry
- **THEN** the active selection does not change
- **AND** the preview is not refreshed

### Requirement: Keep the indexed view and preview current
The system SHALL detect file creation, deletion, rename, and modification events under watched roots, applying the same ignore filter the indexer uses, and update the indexed sidebar view accordingly. When the currently selected file changes on disk, the preview MUST refresh automatically. Binary classification SHALL be re-evaluated when a file is renamed or modified so that an extension change (e.g. `data.bin` → `data.json`) reflects in the tree's clickability and render path. The live update channel MUST remain available during normal idle periods without requiring user action or emitting spurious server timeout warnings for expected long-lived connections. The watcher MUST NOT attach native filesystem watchers to any path whose location relative to a watched root contains a `.git` directory segment, since that directory is git's working metadata and is never user-authored content the indexer surfaces. The watcher MUST tolerate transient errors from the underlying filesystem watcher implementation (for example, an `EINVAL` from a `watch` syscall against a file that has already been removed) without terminating the host process; such errors MAY be logged but MUST NOT propagate as unhandled errors.

#### Scenario: A new file appears in the sidebar
- **WHEN** a new non-ignored file is created within a watched root
- **THEN** the sidebar updates to include the new file in the correct root and directory grouping

#### Scenario: The active document refreshes after a save
- **WHEN** the currently selected file is modified on disk
- **THEN** the preview refreshes to show the updated rendered content

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

### Requirement: Follow the latest changed non-binary file
When follow mode is enabled AND the active Mode is **Author**, the system SHALL switch the active preview to the latest changed non-binary file under the watched roots. Markdown and non-Markdown text files SHALL both be eligible to change the active preview under follow mode. Binary file changes MUST NOT change the active preview. Manual file selection in the sidebar MUST disable follow mode and pin the selected file until follow mode is enabled again. When the user transitions follow mode from disabled to enabled while in **Author** Mode, the system SHALL immediately switch the active preview to the most recently modified non-binary file under the watched roots, rather than waiting for the next change event. When a follow-driven auto-switch changes the active document, the system MUST update the browser URL via `history.replaceState` (not `pushState`) so the address bar stays accurate while the back stack reflects only user-initiated navigation. While the active Mode is **Review**, follow mode MUST be off, the Follow control MUST NOT be rendered (the chip is hidden in the preview toolbar), and file-system change events MUST NOT switch the active preview. When the user transitions from **Author** to **Review**, the system SHALL snapshot the user's current Follow choice; when the user later transitions from **Review** back to **Author**, the system SHALL restore Follow to that snapshot value so the user's Author-mode Follow choice round-trips through Review automatically and they do not have to re-enable Follow after every Review peek. Manual file selection from the `Files` pane and other manual navigation (e.g. `Git Log` commit clicks, direct URLs) MUST continue to work in **Review** Mode. In **Author** Mode, in-place refresh of the currently displayed file's content when that file changes on disk SHALL continue to work as today. In **Review** Mode, the system MUST NOT automatically re-render the active preview when the currently displayed file changes on disk; the stale-content hint behavior is governed by the "Show a stale-content hint in Review when the active file changes on disk" requirement.

#### Scenario: Follow mode switches to the latest changed Markdown file
- **WHEN** Mode is **Author** and follow mode is enabled and a Markdown file changes under a watched root
- **THEN** that Markdown file becomes the active selection
- **AND** the preview updates to render it

#### Scenario: Follow mode switches to the latest changed non-Markdown text file
- **WHEN** Mode is **Author** and follow mode is enabled and a non-Markdown text file (e.g. `config.yaml`, `script.py`) changes under a watched root
- **THEN** that file becomes the active selection
- **AND** the preview updates to render it as syntax-highlighted code

#### Scenario: Follow mode ignores binary file changes
- **WHEN** Mode is **Author** and follow mode is enabled and a binary file changes under a watched root
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
- **AND** the stale-content hint behavior is governed by its own requirement

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

### Requirement: Filter the indexed file set with `.uatuignore`
The system SHALL read a `.uatuignore` file at the watch root, when present, and apply its patterns as a filter on top of the hardcoded directory denylist. The file SHALL use gitignore-compatible syntax, including `!` negation patterns. Patterns in `.uatuignore` SHALL take precedence over patterns inherited from `.gitignore`. When a watched root is a single file path rather than a directory, `.uatuignore` SHALL NOT be consulted for that root. Per-directory nested `.uatuignore` files within the watch root SHALL be ignored in this version. Files filtered by `.uatuignore` MUST NOT appear in the sidebar tree, MUST NOT be eligible to change the active preview under follow mode, and MUST NOT trigger live-update broadcasts when changed. Filtering decisions SHALL reflect the current on-disk contents of `.uatuignore`: when the user edits the file mid-session, the next refresh MUST re-read it so newly-added patterns hide their matches and removed patterns restore previously-hidden files, without requiring the session to be restarted.

#### Scenario: A `.uatuignore` pattern hides a file from the tree
- **WHEN** the watch root contains a `.uatuignore` whose patterns match `bun.lock`
- **AND** the watch root contains a `bun.lock` file
- **THEN** the sidebar tree does not list `bun.lock`
- **AND** modifying `bun.lock` does not change the active preview under follow mode

#### Scenario: A `.uatuignore` negation un-ignores something `.gitignore` excluded
- **WHEN** the watch root's `.gitignore` excludes `*.log`
- **AND** the watch root's `.uatuignore` contains `!debug.log`
- **THEN** the sidebar tree lists `debug.log`
- **AND** every other `.log` file remains hidden

#### Scenario: Single-file watch roots ignore `.uatuignore`
- **WHEN** the watch session is started with `uatu watch script.py`
- **AND** a `.uatuignore` file exists in `script.py`'s directory
- **THEN** that `.uatuignore` does not affect the session
- **AND** the watched file is shown in the sidebar regardless of `.uatuignore` patterns

#### Scenario: Nested `.uatuignore` files are not consulted
- **WHEN** the watch root contains a subdirectory `docs/` with its own `.uatuignore`
- **THEN** the patterns in `docs/.uatuignore` do not affect filtering
- **AND** only the root-level `.uatuignore` is read

#### Scenario: Editing `.uatuignore` at runtime reapplies the new patterns
- **WHEN** a watch session is running and the sidebar tree lists `package-lock.json`
- **AND** the user appends `package-lock.json` to the watch root's `.uatuignore`
- **THEN** the next refresh MUST drop `package-lock.json` from the sidebar tree
- **AND** when the user removes that pattern from `.uatuignore` again
- **THEN** the next refresh MUST list `package-lock.json` once more
- **AND** the session is not restarted at any point

### Requirement: Respect `.gitignore` by default with an opt-out flag
The system SHALL read `.gitignore` at each watch root by default and apply its patterns to filter the indexed file set. The system SHALL provide a `--no-gitignore` flag on the `uatu watch` command that disables this behavior for the session. The hardcoded directory denylist (`node_modules`, `.git`, `dist`, `build`, etc.) MUST continue to apply regardless of `--no-gitignore`. Files filtered by `.gitignore` MUST NOT appear in the sidebar tree and MUST NOT be eligible for follow mode. When the session is honouring `.gitignore` (i.e. `--no-gitignore` was not passed), filtering SHALL reflect the current on-disk contents of `.gitignore`: edits made mid-session MUST take effect on the next refresh without requiring the session to be restarted.

#### Scenario: `.gitignore` patterns hide files by default
- **WHEN** the watch root's `.gitignore` excludes `*.log`
- **AND** the watch root contains `debug.log`
- **THEN** the sidebar tree does not list `debug.log`

#### Scenario: `--no-gitignore` exposes gitignored files
- **WHEN** the watch session is started with `uatu watch . --no-gitignore`
- **AND** the watch root's `.gitignore` excludes `*.log`
- **AND** the watch root contains `debug.log`
- **THEN** the sidebar tree lists `debug.log`
- **AND** the hardcoded directory denylist still applies (e.g. `node_modules/` remains hidden)

#### Scenario: Editing `.gitignore` at runtime reapplies the new patterns
- **WHEN** a watch session is running without `--no-gitignore` and the sidebar tree lists `notes.tmp`
- **AND** the user appends `*.tmp` to the watch root's `.gitignore`
- **THEN** the next refresh MUST drop `notes.tmp` from the sidebar tree
- **AND** when the user removes that pattern from `.gitignore` again
- **THEN** the next refresh MUST list `notes.tmp` once more
- **AND** the session is not restarted at any point

### Requirement: Detect binary files and list them as non-viewable
The system SHALL classify every file accepted by the ignore filter as either a markdown document, a viewable text file, or a binary file. Binary files SHALL appear in the sidebar tree but MUST be rendered as non-clickable entries that cannot become the active preview. Selecting a binary tree row MUST NOT change the active document or trigger a render. Binary classification SHALL use a fast path of known-binary file extensions, and a content sniff (NUL bytes or excessive non-printable byte ratio in the first 8 KB) for files whose extensions are not in the known-text or known-binary lists.

#### Scenario: A known-binary extension lists as disabled
- **WHEN** the watch root contains `logo.png`
- **THEN** the sidebar tree lists `logo.png` as a non-clickable entry
- **AND** clicking `logo.png` does not change the active preview

#### Scenario: An unknown-extension binary blob is detected via content sniff
- **WHEN** the watch root contains a file with an unfamiliar extension whose first 8 KB contain a NUL byte
- **THEN** the sidebar tree lists that file as a non-clickable entry

#### Scenario: A plain text file with no extension is treated as text
- **WHEN** the watch root contains a file named `Makefile` whose contents are plain ASCII
- **THEN** the sidebar tree lists `Makefile` as a clickable entry
- **AND** selecting `Makefile` renders its contents in the preview

#### Scenario: Binary files are excluded from the on-startup default document
- **WHEN** the most recently modified file under the watched roots is a binary file
- **THEN** the on-startup default document is the most recently modified non-binary file instead

