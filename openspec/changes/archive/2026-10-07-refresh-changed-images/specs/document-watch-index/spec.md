## MODIFIED Requirements

### Requirement: Keep the indexed view and preview current

The system SHALL detect file creation, deletion, rename, and modification events under watched roots, applying the same ignore and exposure filters to watching and indexing, and update the sidebar accordingly. A changed active file SHALL refresh automatically regardless of Follow. A refresh SHALL fetch current bytes and invalidate the affected cached Source, Rendered, Diff, and image representations before they can be reused. Active-preview freshness MUST NOT depend solely on the representative Follow target of a multi-file batch or on modification-time equality. An image in the preview that resolves to a watched file — the selected image itself, or an image embedded in the selected Markdown or AsciiDoc document — MUST show its current content after that file changes, even when the surrounding document did not change; the browser's copy of an earlier revision MUST NOT be reused. Refreshing such an image MUST NOT re-render the surrounding document or reset the preview's scroll position. File-scoped (single-file pinned) sessions, `srcset` and `<picture>` sources, CSS background images, and AsciiDoc interactive SVGs rendered as `<object>` are not covered. A fresh snapshot after a live-update gap SHALL reconcile the active file using its change revision. Older asynchronous loads MUST NOT replace a newer refresh or selection. Classification SHALL be reevaluated for modified or renamed files. Event batching SHALL preserve bounded progress, with publication scheduled no later than two seconds after the first unprocessed normalized file event even under sustained churn. Transport keepalives SHALL preserve idle connections without presentation effects or expected-idle timeout warnings. The content watcher MUST NOT attach native filesystem watchers to `.git` descendants, follow excluded symlink trees, or terminate the host process on transient watcher errors.

#### Scenario: A new file appears in the sidebar
- **WHEN** a new non-ignored file is created within a watched root
- **THEN** the sidebar includes it in the correct root and directory grouping

#### Scenario: The active document refreshes after a save
- **WHEN** the selected file is modified on disk with Follow either on or off
- **THEN** the preview shows the updated content fetched from disk
- **AND** switching preview representation does not restore the previous cached contents

#### Scenario: The selected image refreshes after it changes
- **WHEN** an image file such as `hero.svg` is selected and the file is rewritten on disk
- **THEN** the preview shows the new image without a page reload
- **AND** the image element stays mounted, so the pane neither blanks nor scrolls

#### Scenario: An embedded image refreshes when only the image changes
- **WHEN** the selected Markdown document embeds `<img src="./hero.svg">` and only `hero.svg` is rewritten on disk
- **THEN** the embedded image shows the new content
- **AND** the document around it is not re-rendered and keeps its scroll position

#### Scenario: A multi-file burst includes the active document
- **WHEN** the selected document and another watched path change in one batch
- **THEN** the selected document is invalidated independently of the representative Follow target
- **AND** with Follow off its preview reloads in place

#### Scenario: Reconnection reconciles a missed active-document change
- **WHEN** the selected document changes while the live connection is interrupted
- **AND** a subsequent snapshot carries its newer revision
- **THEN** the preview reloads current content even if the file's modification time is unchanged

#### Scenario: An older preview load finishes last
- **WHEN** two document loads overlap and the older load completes after the newer load
- **THEN** the older result neither replaces the preview nor repopulates a cache for the newer revision

#### Scenario: Sustained churn cannot starve the refresh
- **WHEN** normalized file events arrive continuously faster than the debounce interval
- **THEN** publication is scheduled within two seconds of the first unprocessed event
- **AND** later events remain queued until applied rather than being discarded

#### Scenario: A rename across the binary boundary updates clickability
- **WHEN** a file is renamed between extensions classified as binary and text
- **THEN** the index and preview routing reflect the new classification
- **AND** a manually retained old destination follows the existing unavailable-selection rules

#### Scenario: Idle watch periods do not look like failures
- **WHEN** the browser remains connected during a normal idle period
- **THEN** the watch session remains available without manual reconnection
- **AND** the server emits no timeout warning for that expected idle connection

#### Scenario: Excluded paths do not expand watch coverage
- **WHEN** a directory is denied, lies inside `.git`, or is reached through a symlink excluded from the index
- **THEN** the content watcher does not traverse or attach native watchers inside it

#### Scenario: The watcher does not descend into `.git/`
- **WHEN** a path contains a `.git` directory segment between the watched root and the path itself
- **THEN** the content watcher's ignore predicate excludes that path
- **AND** no native filesystem watcher is attached to it

#### Scenario: A transient watch-syscall failure does not crash the process
- **WHEN** the watcher reports a transient error for a disappearing path
- **THEN** the host process remains available
- **AND** affected observation is recovered when coverage is uncertain

### Requirement: Serve adjacent files from watched roots as static content
For any request path that does not match a known API or built-in asset route, the server SHALL inspect the request's `Accept` header to distinguish top-level navigation requests from sub-resource fetches. When the `Accept` header prefers `text/html` AND the request path resolves to a known file under a watched root — a document, or a binary file such as an image — the server MUST return the SPA shell (the same response served at `/`) so the SPA can render the file with its full UI; a top-level navigation never receives a watched file's raw bytes, so an SVG cannot run script at the app's origin. For all other requests — including requests whose `Accept` does not prefer `text/html` and requests that do not resolve to any known file — the server SHALL attempt to resolve the path against the union of watched roots and, if the path maps to an existing allowed file inside a watched root, serve that file statically. Static fallback serving MUST apply the same hardcoded ignore, default secret-file denylist, `.uatu.json ignore.exclude` patterns, and active `.gitignore` exposure rules as the browser tree. Static fallback serving MUST verify containment after resolving real filesystem paths and MUST NOT serve files reached through symlink escapes outside the watched root. The rendered preview HTML MUST preserve the author's original `src` and `href` URLs verbatim (no URL rewriting); the browser SHALL resolve those references using a per-document base so that relative references such as `<img src="./hero.svg">` in a README just work. Once mounted, an image whose URL resolves to a file under a watched root carries that file's change revision as a `revision` query parameter, the same parameter the selected image's URL carries, so that a changed image is fetched again rather than reused from the browser's image cache. Static fallback serving SHALL resolve files by path alone and ignore the query string. Images on other origins and URLs that do not resolve to a watched file MUST be left as authored. Any requested path that resolves outside every watched root, is ignored, is secret-like, is malformed, or cannot be safely resolved MUST receive a non-success response and MUST NOT read or stream the file.

#### Scenario: A README's centered hero image loads via the static file fallback
- **WHEN** a previewed Markdown file contains `<img src="./hero.svg">` whose target exists next to the document and is not ignored or secret-like
- **THEN** the rendered HTML from the server preserves the image's `src` as `./hero.svg`
- **AND** the browser resolves it through the per-document base and receives the image from the static file fallback
- **AND** once the preview is mounted, the image's URL carries the file's change revision as a query parameter

#### Scenario: A top-level navigation to a document URL returns the SPA shell
- **WHEN** the server receives `GET /guides/setup.md` with `Accept: text/html,application/xhtml+xml,...`
- **AND** `guides/setup.md` is a known non-binary document under a watched root
- **THEN** the server responds with the SPA shell (same body served at `/`)
- **AND** the response is NOT the raw markdown source bytes

#### Scenario: A top-level navigation to an image URL returns the SPA shell
- **WHEN** the server receives `GET /hero.svg` with `Accept: text/html,application/xhtml+xml,...` (for example, reloading the page while Follow shows `hero.svg`)
- **AND** `hero.svg` is a known file under a watched root
- **THEN** the server responds with the SPA shell, which renders `hero.svg` in the preview
- **AND** the response is NOT the raw SVG bytes

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
