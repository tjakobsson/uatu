## MODIFIED Requirements

### Requirement: Browse supported documents from watched roots
The browser UI SHALL display a sidebar tree grouped by watched root. The tree SHALL list every file accepted by the ignore and exposure filters under each root, recursively. Files classified as Markdown, AsciiDoc, or as viewable text SHALL render as clickable entries that can become the active preview. Files classified as binary SHALL render as clickable entries: clicking a binary entry MUST route the preview to the existing "preview unavailable" view rather than rendering binary contents. Files matching the hardcoded directory denylist, default-denied secret patterns, hardcoded ignored names, `.uatu.json tree.exclude` patterns, or active `.gitignore` rules MUST NOT appear in the sidebar. The preview pane SHALL render the currently selected non-binary file: Markdown files through the Markdown pipeline, AsciiDoc files through the AsciiDoc pipeline, other text files through the syntax-highlighted code render path.

#### Scenario: Sidebar lists every non-ignored file under each watched root
- **WHEN** watched roots contain a mix of Markdown, AsciiDoc, source code, configuration, and binary files
- **THEN** the sidebar displays all of those files within the hierarchy of their corresponding watched root
- **AND** Markdown, AsciiDoc, and other text files appear as clickable entries
- **AND** binary files appear as clickable entries that route to the preview-unavailable view when selected

#### Scenario: Secret-like files are excluded by default
- **WHEN** a watched root contains common secret-bearing files such as `.env`, `.env.local`, `.npmrc`, credential JSON, or private-key files
- **THEN** those files do not appear as sidebar entries
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

#### Scenario: Selecting a binary entry routes to the preview-unavailable view
- **WHEN** a user selects a binary tree entry
- **THEN** the active selection updates to that file
- **AND** the preview shows the existing preview-unavailable view for binary content
- **AND** no binary bytes are streamed into the preview

### Requirement: Detect binary files and route them to the right preview
The system SHALL classify every file accepted by the ignore filter as either a Markdown document, an AsciiDoc document, a viewable text file, or a binary file. Binary files SHALL appear in the sidebar tree as clickable entries. Selecting a binary entry SHALL change the active document to that file and route the preview based on the file's extension: binaries with a viewable image extension (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.ico`, `.avif`, `.bmp`) SHALL render inline in the preview pane via `<img>`, served by uatu's static-file fallback; all other binaries SHALL render the existing preview-unavailable notice. Binary classification SHALL use a fast path of known-binary file extensions, and a content sniff (NUL bytes or excessive non-printable byte ratio in the first 8 KB) for files whose extensions are not in the known-text or known-binary lists. Binary entries (including images) MUST remain ineligible to change the active document under follow-mode auto-switch — the auto-switch only targets non-binary files.

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

### Requirement: Serve adjacent files from watched roots as static content
For any request path that does not match a known API or built-in asset route, the server SHALL inspect the request's `Accept` header to distinguish top-level navigation requests from sub-resource fetches. When the `Accept` header prefers `text/html` AND the request path resolves to a known non-binary document under a watched root, the server MUST return the SPA shell (the same response served at `/`) so the SPA can render the document with its full UI. For all other requests — including requests whose `Accept` does not prefer `text/html`, requests that resolve to a binary file, and requests that do not resolve to any document — the server SHALL attempt to resolve the path against the union of watched roots and, if the path maps to an existing allowed file inside a watched root, serve that file statically. Static fallback serving MUST apply the same hardcoded ignore, default secret-file denylist, `.uatu.json tree.exclude` patterns, and active `.gitignore` exposure rules as the browser tree. Static fallback serving MUST verify containment after resolving real filesystem paths and MUST NOT serve files reached through symlink escapes outside the watched root. The rendered preview HTML MUST preserve the author's original `src` and `href` URLs verbatim (no URL rewriting); the browser SHALL resolve those references using a per-document base so that relative references such as `<img src="./hero.svg">` in a README just work. Any requested path that resolves outside every watched root, is ignored, is secret-like, is malformed, or cannot be safely resolved MUST receive a non-success response and MUST NOT read or stream the file.

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

#### Scenario: Excluded files are not served directly
- **WHEN** a watched root contains a file hidden by `.uatu.json tree.exclude` or an active `.gitignore` rule
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

### Requirement: Respect `.gitignore` by default with an opt-out
The system SHALL read `.gitignore` at each watch root by default and apply its patterns to filter the indexed file set. The system SHALL provide two ways to opt out of this behavior: a per-session CLI flag `--no-gitignore` on the `uatu watch` command, and a per-project setting `tree.respectGitignore: false` in the watch root's `.uatu.json`. When both are present, the CLI flag wins for the duration of that session. The hardcoded directory denylist (`node_modules`, `.git`, `dist`, `build`, etc.) MUST continue to apply regardless of either opt-out. Files filtered by `.gitignore` MUST NOT appear in the sidebar tree and MUST NOT be eligible for follow mode. When the session is honoring `.gitignore`, filtering SHALL reflect the current on-disk contents of `.gitignore`: edits made mid-session MUST take effect on the next refresh without requiring the session to be restarted.

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

#### Scenario: `.uatu.json tree.respectGitignore: false` exposes gitignored files
- **WHEN** the watch root's `.uatu.json` sets `tree.respectGitignore: false`
- **AND** the watch root's `.gitignore` excludes `*.log`
- **AND** the watch root contains `debug.log`
- **THEN** the sidebar tree lists `debug.log`
- **AND** the hardcoded directory denylist still applies

#### Scenario: CLI flag wins over the .uatu.json setting
- **WHEN** the watch root's `.uatu.json` sets `tree.respectGitignore: true`
- **AND** the session is started with `uatu watch . --no-gitignore`
- **THEN** `.gitignore` is NOT honored for the duration of the session

#### Scenario: Editing `.gitignore` at runtime reapplies the new patterns
- **WHEN** a watch session is running and honoring `.gitignore` and the sidebar tree lists `notes.tmp`
- **AND** the user appends `*.tmp` to the watch root's `.gitignore`
- **THEN** the next refresh MUST drop `notes.tmp` from the sidebar tree
- **AND** when the user removes that pattern from `.gitignore` again
- **THEN** the next refresh MUST list `notes.tmp` once more
- **AND** the session is not restarted at any point

## REMOVED Requirements

### Requirement: Filter the indexed file set with `.uatuignore`
**Reason**: `.uatuignore` is retired. Filtering is now configured exclusively through `.uatu.json tree.exclude` (project-controlled) plus `.gitignore` honoring (toggleable per project or per session) plus uatu's built-in defaults. This collapses three filter sources into one and matches the VS Code-style configuration users already expect. The new `tree-filtering` capability owns the replacement requirements.
**Migration**: Existing `.uatuignore` files are NOT auto-migrated. On session start, if a `.uatuignore` file exists at any watched root, uatu MUST log a one-line warning naming the file and pointing users to `.uatu.json tree.exclude`. The contents of `.uatuignore` MUST NOT be parsed or applied. Users who relied on `.uatuignore` patterns must move them into `.uatu.json` under `tree.exclude` (gitignore-compatible syntax is preserved).
