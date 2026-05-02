## Purpose

Define the user-facing behavior for local browser-based document watch sessions over Markdown content.
## Requirements
### Requirement: Start a local document watch session
The system SHALL provide a `uatu watch [PATH...]` command that accepts zero or more positional paths. Each path MAY be either a directory (watched as a root group) or a non-binary file (watched as a single-file root). When no paths are provided, the system MUST use the current working directory as the only watched root. Paths that resolve to binary files MUST be rejected with a clear error before the server or watcher starts. Paths that do not exist on disk MUST also be rejected with a clear error before the server or watcher starts. By default, every watched path MUST be inside a git worktree; paths outside a git worktree MUST be rejected with a clear error before the server or watcher starts. The command SHALL accept a `--force` flag that permits non-git watched paths anyway and prints a warning that indexing may be slow. Starting the command SHALL launch a local browser UI server and print its URL to standard output after the initial watch session is ready. When standard output is a TTY, the command SHALL show an indexing status while initial indexing is in progress, then replace it with the ASCII `uatu` logo with the tagline "I observe. I follow. I render." above the URL once startup is ready. When standard output is not a TTY, the command SHALL omit both the indexing status and ASCII logo so only the URL is printed to standard output. The command SHALL accept a `--no-gitignore` flag that disables `.gitignore` filtering for the session.

#### Scenario: No paths defaults to the current git directory
- **WHEN** a user runs `uatu watch` with no positional paths from inside a git worktree
- **THEN** the current working directory is used as the only watched root
- **AND** the local browser URL is printed after the initial watch session is ready

#### Scenario: Multiple positional paths become separate watched roots
- **WHEN** a user runs `uatu watch docs notes`
- **AND** both paths are inside git worktrees
- **THEN** `docs` and `notes` are both registered as watched roots
- **AND** the browser UI shows them as separate root groups

#### Scenario: A non-Markdown text file path starts a single-file entry when it is inside git
- **WHEN** a user runs `uatu watch script.py`
- **AND** `script.py` is inside a git worktree
- **THEN** the session is scoped to that single file
- **AND** the sidebar shows only that file
- **AND** changes to other files outside the file's directory do not appear

#### Scenario: A Markdown file path starts a single-file entry when it is inside git
- **WHEN** a user runs `uatu watch README.md`
- **AND** `README.md` is inside a git worktree
- **THEN** the session is scoped to that single Markdown file
- **AND** the sidebar shows only that document
- **AND** changes to other files outside the file's directory do not appear

#### Scenario: A binary file path is rejected
- **WHEN** a user runs `uatu watch logo.png`
- **THEN** the command exits with a clear error naming the unsupported path
- **AND** no server or watcher is started

#### Scenario: A non-existent path is rejected
- **WHEN** a user runs `uatu watch nope-not-a-real-file`
- **THEN** the command exits with a clear error naming the missing path
- **AND** no server or watcher is started

#### Scenario: A non-git root is rejected by default
- **WHEN** a user runs `uatu watch ~/Downloads`
- **AND** `~/Downloads` is not inside a git worktree
- **THEN** the command exits with a clear error naming `~/Downloads`
- **AND** the error explains that `--force` can watch it anyway
- **AND** no server or watcher is started

#### Scenario: Multiple non-git roots are all reported
- **WHEN** a user runs `uatu watch ~/Downloads /tmp/scratch`
- **AND** both paths are outside git worktrees
- **THEN** the command exits with a clear error naming both non-git paths
- **AND** no server or watcher is started

#### Scenario: `--force` permits a non-git root with a warning
- **WHEN** a user runs `uatu watch ~/Downloads --force`
- **AND** `~/Downloads` is not inside a git worktree
- **THEN** the command starts the watch session anyway
- **AND** a warning is printed that non-git indexing may be slow
- **AND** the local browser URL is printed after the initial watch session is ready

#### Scenario: Interactive startup shows indexing before the ASCII banner
- **WHEN** `uatu watch` is run with standard output attached to a terminal
- **AND** all startup preflight checks pass
- **THEN** an indexing status is shown while the initial watch session is being prepared
- **AND** the indexing status is replaced by the ASCII `uatu` logo and its tagline before the URL is printed

#### Scenario: Piped startup omits indexing status and banner
- **WHEN** `uatu watch` is run with standard output redirected to a pipe or file
- **THEN** only the URL is printed to standard output, without indexing status or the ASCII banner

#### Scenario: `--no-gitignore` is accepted as a startup flag
- **WHEN** a user runs `uatu watch . --no-gitignore`
- **AND** `.` is inside a git worktree
- **THEN** the session starts without applying `.gitignore` patterns to the indexed file set
- **AND** the local browser URL is printed after the initial watch session is ready

#### Scenario: `--force` is accepted as a startup flag
- **WHEN** a user runs `uatu watch . --force`
- **THEN** the session permits watched roots that are outside git worktrees
- **AND** git-backed roots continue to use the normal indexing behavior

### Requirement: Configure startup browser behavior
The system SHALL attempt to open the browser automatically and SHALL start with follow mode enabled by default. The command MUST provide flags to disable browser auto-open and to disable follow mode before the watch session starts. The local browser URL MUST be printed whether or not the browser is opened successfully. When the SPA boots with `location.pathname` resolving to a known non-binary document (anything other than `/`), the SPA MUST disable follow mode for the session regardless of the CLI default — see "Force follow mode off when arriving via a direct document URL" for the full rule.

#### Scenario: Default startup opens the browser with follow enabled
- **WHEN** a user runs `uatu watch docs`
- **THEN** the system attempts to open the browser automatically
- **AND** the watch session starts with follow mode enabled
- **AND** the local browser URL is printed

#### Scenario: Startup flags disable auto-open and follow
- **WHEN** a user runs `uatu watch docs --no-open --no-follow`
- **THEN** the system does not attempt to open the browser
- **AND** the watch session starts with follow mode disabled
- **AND** the local browser URL is printed

#### Scenario: SPA boot at the root URL honors the CLI follow default
- **WHEN** a user opens the browser to `http://127.0.0.1:NNNN/`
- **AND** the CLI was started without `--no-follow`
- **THEN** the SPA boots with follow mode enabled

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

### Requirement: Render GitHub-style Markdown in light mode
The preview pane SHALL default to light mode and SHALL render Markdown using GitHub Flavored Markdown-compatible behavior for common GitHub README features. At minimum, the preview MUST support GitHub-style rendering for tables, task lists, strikethrough, autolinks, and fenced code blocks, and the resulting presentation SHALL follow GitHub's light Markdown visual style. The preview MUST also render block-level and inline raw HTML (matching GitHub's README behavior) so that common README idioms such as centered hero images and attribute-bearing elements render as real HTML rather than as escaped text. Rendered HTML MUST be sanitized against a whitelist modeled on GitHub's allowlist before reaching the browser: `<script>`, `<iframe>`, and other active-content elements MUST NOT execute, inline event handler attributes (such as `onerror`, `onclick`) MUST be stripped, and URL attributes MUST reject unsafe protocols such as `javascript:`. Raw HTML inside fenced code blocks MUST continue to be displayed as literal code, not interpreted.

#### Scenario: A Markdown table and task list render with GitHub-style formatting
- **WHEN** a selected Markdown file contains a table and task list items
- **THEN** the preview renders them as formatted HTML elements rather than plain paragraph text
- **AND** the preview uses light-mode GitHub-style Markdown presentation by default

#### Scenario: A GitHub-style autolink renders as a link
- **WHEN** a selected Markdown file contains a supported GitHub Flavored Markdown autolink
- **THEN** the preview renders it as a clickable link

#### Scenario: Inline HTML blocks render as HTML
- **WHEN** a selected Markdown file contains a block-level HTML element such as `<p align="center">` with a nested `<img>`
- **THEN** the preview renders those elements as real HTML with their attributes (including `align`, `width`, `height`, `alt`) preserved

#### Scenario: Unsafe HTML is neutralized before it reaches the browser
- **WHEN** a Markdown file contains `<script>`, `<iframe>`, an inline event handler such as `onerror`, or a `javascript:` URL
- **THEN** no executable `<script>` or `<iframe>` element reaches the preview DOM
- **AND** inline event handler attributes are removed from the rendered elements
- **AND** `href`/`src` attributes using the `javascript:` protocol are removed

#### Scenario: HTML inside fenced code blocks stays literal
- **WHEN** a fenced code block contains raw HTML such as `<script>alert(1)</script>`
- **THEN** the preview displays that HTML as text inside the code block
- **AND** the HTML is not interpreted as active markup

### Requirement: Render Mermaid diagrams from fenced code blocks
The preview pane SHALL detect Markdown fenced code blocks whose info string is `mermaid` and AsciiDoc `[source,mermaid]` listings, and SHALL render those blocks as Mermaid diagrams in the browser instead of leaving them as plain code blocks. AsciiDoc bare `[mermaid]` blocks (without the `source` style) MUST NOT render as diagrams — this matches GitHub's behavior, which only recognizes `[source,mermaid]`.

#### Scenario: A Markdown Mermaid fenced block renders as a diagram
- **WHEN** a selected Markdown file contains a fenced code block with the info string `mermaid`
- **THEN** the preview renders the block as a Mermaid diagram
- **AND** the rendered diagram remains within the document flow of the preview

#### Scenario: An AsciiDoc `[source,mermaid]` listing renders as a diagram
- **WHEN** a selected AsciiDoc file contains a `[source,mermaid]` listing
- **THEN** the preview renders the listing as a Mermaid diagram
- **AND** the rendered diagram remains within the document flow of the preview

#### Scenario: An AsciiDoc bare `[mermaid]` block renders as a literal block
- **WHEN** a selected AsciiDoc file contains a bare `[mermaid]` block (without the `source` style)
- **THEN** the preview renders the block as a literal block, not as a diagram
- **AND** the block content is shown as text, matching GitHub's behavior

### Requirement: Keep the indexed view and preview current
The system SHALL detect file creation, deletion, rename, and modification events under watched roots, applying the same ignore filter the indexer uses, and update the indexed sidebar view accordingly. When the currently selected file changes on disk, the preview MUST refresh automatically. Binary classification SHALL be re-evaluated when a file is renamed or modified so that an extension change (e.g. `data.bin` → `data.json`) reflects in the tree's clickability and render path. The live update channel MUST remain available during normal idle periods without requiring user action or emitting spurious server timeout warnings for expected long-lived connections.

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

### Requirement: Follow the latest changed non-binary file
When follow mode is enabled, the system SHALL switch the active preview to the latest changed non-binary file under the watched roots. Markdown and non-Markdown text files SHALL both be eligible to change the active preview under follow mode. Binary file changes MUST NOT change the active preview. Manual file selection in the sidebar MUST disable follow mode and pin the selected file until follow mode is enabled again. When the user transitions follow mode from disabled to enabled, the system SHALL immediately switch the active preview to the most recently modified non-binary file under the watched roots, rather than waiting for the next change event. When a follow-driven auto-switch changes the active document, the system MUST update the browser URL via `history.replaceState` (not `pushState`) so the address bar stays accurate while the back stack reflects only user-initiated navigation.

#### Scenario: Follow mode switches to the latest changed Markdown file
- **WHEN** follow mode is enabled and a Markdown file changes under a watched root
- **THEN** that Markdown file becomes the active selection
- **AND** the preview updates to render it

#### Scenario: Follow mode switches to the latest changed non-Markdown text file
- **WHEN** follow mode is enabled and a non-Markdown text file (e.g. `config.yaml`, `script.py`) changes under a watched root
- **THEN** that file becomes the active selection
- **AND** the preview updates to render it as syntax-highlighted code

#### Scenario: Follow mode ignores binary file changes
- **WHEN** follow mode is enabled and a binary file changes under a watched root
- **THEN** the active selection does not change
- **AND** the preview is not refreshed

#### Scenario: Manual selection disables follow mode
- **WHEN** a user manually selects a non-binary file from the sidebar while follow mode is enabled
- **THEN** follow mode is disabled
- **AND** the selected file remains active until the user re-enables follow mode or selects another file

#### Scenario: Enabling follow jumps to the latest modified file
- **WHEN** a user enables follow mode while folder-scoped
- **AND** the most recently modified non-binary file under the watched roots is not the current selection
- **THEN** the active preview switches to that most recently modified file

#### Scenario: Follow-driven auto-switch replaces the URL without pushing history
- **WHEN** follow mode is enabled and a file-system change causes the active document to switch
- **THEN** the browser URL pathname updates to the new document's relative path
- **AND** no new entry is added to the browser history stack

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

### Requirement: Organize sidebar content into resizable panes
The browser UI SHALL organize the expanded sidebar as a stack of panes. The initial panes SHALL include `Change Overview`, `Files`, and `Git Log`. The existing document tree SHALL render inside the `Files` pane and MUST preserve existing document selection, directory open/closed state, follow-mode interaction, pin interaction, binary-file display, and relative-time behavior. Pane visibility, collapsed state, and vertical sizing SHALL persist across reloads in the same browser for that origin. The pane stack SHALL fill the available expanded-sidebar height and MUST NOT force the whole sidebar body to scroll. Scrollbars used inside panes and preview overflow regions SHOULD be thin and visually light while remaining discoverable. The existing whole-sidebar collapse and expand controls MUST remain separate from per-pane visibility and collapse controls.

#### Scenario: Sidebar opens with default panes
- **WHEN** a user opens the browser UI with no pane preferences stored
- **THEN** the expanded sidebar shows `Change Overview`, `Files`, and `Git Log` panes
- **AND** the `Files` pane contains the document tree for watched roots

#### Scenario: Selecting a document from the Files pane
- **WHEN** a user selects a non-binary document from the `Files` pane tree
- **THEN** the preview loads that document
- **AND** follow mode is disabled in the same way as selecting from the previous sidebar tree

#### Scenario: Pane visibility can be changed and restored
- **WHEN** a user hides a sidebar pane
- **THEN** that pane is removed from the expanded sidebar stack
- **AND** a sidebar panels control allows the user to show that pane again

#### Scenario: Pane size can be adjusted
- **WHEN** a user resizes one sidebar pane relative to another
- **THEN** the pane stack updates the affected pane heights
- **AND** the pane stack remains within the current expanded-sidebar height
- **AND** the updated pane sizes persist across reloads in the same browser for that origin

#### Scenario: Pane content scrolls inside its allocated pane
- **WHEN** pane content exceeds that pane's allocated height
- **THEN** that pane body scrolls internally
- **AND** the whole sidebar body does not gain a scrollbar
- **AND** the scrollbar is thinner and lighter than the default heavy pane treatment where platform styling allows it

#### Scenario: Spare height is assigned to the Files pane
- **WHEN** the expanded pane stack has more vertical space than fixed contextual panes require
- **THEN** the `Files` pane receives the spare space
- **AND** the `Git Log` pane does not show excessive empty space beneath its content

#### Scenario: Whole-sidebar collapse remains separate
- **WHEN** a user collapses the whole sidebar
- **THEN** the sidebar shrinks to the existing narrow rail
- **AND** per-pane visibility and sizing preferences are preserved for when the sidebar is expanded again

### Requirement: Resize expanded sidebar width
The browser UI SHALL allow users to resize the expanded sidebar horizontally. The expanded-sidebar width SHALL persist across reloads in the same browser for that origin. The width control MUST remain separate from whole-sidebar collapse and MUST NOT erase the collapsed/expanded sidebar preference.

#### Scenario: Sidebar width can be resized
- **WHEN** a user drags the divider between sidebar and preview
- **THEN** the expanded sidebar width changes within bounded minimum and maximum values
- **AND** the preview area resizes to fill the remaining width

#### Scenario: Sidebar width persists across reload
- **WHEN** a user resizes the expanded sidebar and reloads the browser UI
- **THEN** the expanded sidebar restores the resized width

#### Scenario: Sidebar collapse preserves resized width
- **WHEN** a user resizes the expanded sidebar, collapses it, and expands it again
- **THEN** the expanded sidebar returns to the resized width

### Requirement: Render review-load summary in the Change Overview pane
The browser UI SHALL render repository and review-load data in the `Change Overview` pane when that data is available. The pane MUST show whether the watched root is inside a git repository, the current branch or detached commit, dirty status, resolved review base or fallback mode, cognitive-load level, and score. The pane MUST NOT list raw mechanical statistics such as changed-file count, touched-line count, diff-hunk count, or directory spread directly in the sidebar. The score MUST be clickable and MUST open a detailed scoring explanation in the main preview area. The pane MUST label the score as review burden or cognitive load and MUST NOT present it as code quality or correctness. If review-load data is unavailable, the pane SHALL show a clear unavailable or non-git message instead of failing to render.

#### Scenario: Git-backed change has review-load data
- **WHEN** the browser receives repository metadata and a computed review-load result
- **THEN** the `Change Overview` pane shows the branch or detached commit, dirty status, review base, cognitive-load level, and score
- **AND** the pane does not show raw mechanical statistics such as `Changed files`, `Touched lines`, `Diff hunks`, or `Directory spread`

#### Scenario: Watch root has no git repository
- **WHEN** the browser receives a non-git repository state for the watched root
- **THEN** the `Change Overview` pane states that no git repository is available
- **AND** the document preview and `Files` pane remain usable

#### Scenario: Review settings contain a warning
- **WHEN** the review-load result includes a settings warning such as invalid `.uatu.json`
- **THEN** the `Change Overview` pane displays that warning
- **AND** the pane still displays any available default review-load result

#### Scenario: Score drivers distinguish configured and factual inputs
- **WHEN** a user clicks the review-burden score
- **THEN** the main preview renders configured risk, support, and ignore area matches with their configured area names
- **AND** mechanical drivers such as files, hunks, lines, and directories are labeled as factual change-shape inputs
- **AND** Follow mode is disabled
- **AND** the browser URL changes to a linkable score-explanation state

#### Scenario: Score explanation remains active during refresh
- **WHEN** a user has opened the score explanation from `Change Overview`
- **AND** the watch session receives a file-change refresh
- **THEN** the main preview remains on the score explanation
- **AND** Follow mode remains disabled

#### Scenario: Score explanation compares the numeric score
- **WHEN** a user opens the score explanation from `Change Overview`
- **THEN** the main preview explains that the score is an additive review-burden index, not a percentage or code-quality score
- **AND** the preview shows the configured or default low, medium, and high thresholds
- **AND** the score total and threshold cards use the corresponding low, medium, and high background colors
- **AND** the preview explains whether the current score is below or above those thresholds
- **AND** the preview does not render a separate `Changed Files` section

#### Scenario: Mechanical statistics have inline explanations
- **WHEN** a user opens the score explanation from `Change Overview`
- **THEN** mechanical statistics such as `Changed files`, `Touched lines`, `Diff hunks`, and `Directory spread` expose help markers
- **AND** hovering or focusing a help marker shows a tooltip that explains what that statistic means in review-burden scoring
- **AND** the explanation does not require clicking the marker

### Requirement: Render bounded commit history in the Git Log pane
The browser UI SHALL render the bounded commit log for the selected or only detected repository in the `Git Log` pane. Each visible commit row MUST show at minimum the short SHA and subject. If multiple repositories are detected, the pane SHALL make clear which repository each log belongs to or provide a repository grouping/selection. The pane SHALL provide a history-length control for selecting how many commit rows are visible from the bounded data supplied by the server. The `Git Log` pane body SHALL scroll internally when the visible commit rows exceed its allocated height. If no commit log is available, the pane SHALL show an empty or unavailable state instead of failing to render.

#### Scenario: Single repository has commits
- **WHEN** the browser receives a commit log for one detected repository
- **THEN** the `Git Log` pane lists recent commits for that repository
- **AND** each row includes the commit short SHA and subject

#### Scenario: Commit history length can be changed
- **WHEN** a user selects a different history length in the `Git Log` pane
- **THEN** the pane updates the visible commit rows to that selected limit
- **AND** the selected history length persists across reloads in the same browser for that origin

#### Scenario: Git Log pane scrolls internally
- **WHEN** the visible commit rows exceed the `Git Log` pane height
- **THEN** the `Git Log` pane body scrolls
- **AND** the pane stack remains within the expanded-sidebar height

#### Scenario: Commit click renders full message in preview
- **WHEN** a user clicks a commit row in the `Git Log` pane
- **THEN** the main preview renders that commit's full commit message
- **AND** Follow mode is disabled
- **AND** no hover-only popover is required to read the full message

#### Scenario: Multiple repositories have commits
- **WHEN** the browser receives commit logs for multiple detected repositories
- **THEN** the `Git Log` pane separates or labels commits by repository
- **AND** the user can tell which repository a commit belongs to

#### Scenario: Commit log is unavailable
- **WHEN** no commit log is available for the watched repository context
- **THEN** the `Git Log` pane displays an empty or unavailable state
- **AND** the rest of the sidebar remains usable

### Requirement: Display build identifier in the browser UI
The browser UI SHALL display a build identifier in its header derived from build-time metadata. For compiled release binaries the identifier MUST include the embedded semantic version and short git commit sha. For local development runs (for example under `bun run dev`) the identifier MUST include the current git branch name and short commit sha. When git metadata is unavailable in a development run, the identifier MUST still display the branch placeholder `main` paired with `unknown` rather than hiding the field.

#### Scenario: Release build shows version and commit
- **WHEN** a user opens the browser UI served from a compiled release binary
- **THEN** the header shows `v<version> · <shortsha>` using the embedded metadata

#### Scenario: Local dev run shows branch and commit
- **WHEN** a user opens the browser UI while running `uatu` from source with git available
- **THEN** the header shows `<branch>@<shortsha>`

#### Scenario: Local dev run without git still shows an identifier
- **WHEN** a user opens the browser UI while running `uatu` from source and git metadata cannot be read
- **THEN** the header shows `main@unknown`

### Requirement: Show a file-type icon next to each document in the tree
The sidebar document tree SHALL display a small icon next to each tree leaf — both clickable and non-clickable — that reflects its file type, so readers can visually distinguish file types at a glance. The icon rendering SHALL be keyed by file extension and MUST be trivially extensible (one entry per extension) so additional types can be added without churn. A generic fallback icon MUST be used for any extension that has no dedicated icon. Binary entries MUST also display an icon (using their extension where mapped, otherwise the generic icon).

#### Scenario: Markdown documents show a markdown icon in the tree
- **WHEN** the sidebar lists a `.md` or `.markdown` file
- **THEN** the tree row shows a file-type icon to the left of the file name

#### Scenario: Unknown extensions fall back to a generic file icon
- **WHEN** a file extension is not in the icon registry
- **THEN** the tree row still shows an icon (a generic file glyph) rather than an empty gap

#### Scenario: Binary entries also show an icon
- **WHEN** the sidebar lists a binary file (e.g. `logo.png`)
- **THEN** the tree row shows the file-type icon for that extension (or the generic icon if not mapped)
- **AND** the row remains non-clickable

### Requirement: Preserve manual directory open/closed state in the document tree
Directories in the sidebar tree SHALL render collapsed (closed) by default, matching the conventions of common file trees (VS Code, Finder, GitHub). When a user clicks a directory's summary to open or close it, that explicit choice SHALL persist for the rest of the session across document selections and sidebar re-renders triggered by file changes, overriding the default until the user toggles that directory again. When the active document changes (initial default, follow-mode auto-switch, or user click), the system SHALL reveal the path to that document by opening every ancestor directory between the watched root and the document. The reveal MUST be purely additive — it opens ancestors but never closes any directory the user has opened. The session-level override state MAY reset on page reload.

#### Scenario: Directories start collapsed
- **WHEN** the document tree is first rendered and the default document is at a watched root with no ancestor directories
- **THEN** nested directories render collapsed and only top-level documents are visible until the user expands a directory

#### Scenario: Follow-mode auto-switch reveals the path to the newly active document
- **WHEN** follow mode is enabled and a Markdown file inside a nested directory changes on disk
- **THEN** the preview switches to that file
- **AND** each ancestor directory from the watched root down to the file renders open

#### Scenario: Reveal is purely additive — it never closes anything
- **WHEN** the active document changes (initial default, follow-mode auto-switch, or user click)
- **THEN** directories the user has opened remain open
- **AND** only the new document's ancestor directories are added to the open set

#### Scenario: A manually opened directory stays open across file selections
- **WHEN** a user opens a directory by clicking its summary
- **AND** then selects a different Markdown file in the tree
- **THEN** the directory remains open

#### Scenario: Manual open/closed state survives sidebar re-renders
- **WHEN** a user opens a directory and a Markdown file is modified on disk, triggering a sidebar re-render
- **THEN** the directory remains open

### Requirement: Collapse and expand the sidebar
The browser UI SHALL provide a control that collapses the sidebar into a narrow rail and another (or the same, toggled) control that expands it back to full width. The collapsed/expanded preference SHALL persist across reloads in the same browser for that origin. While collapsed, the preview pane MUST expand to use the freed horizontal space.

#### Scenario: Collapsing hides the document list
- **WHEN** a user clicks the sidebar collapse control
- **THEN** the sidebar shrinks to a narrow rail with only an expand control visible
- **AND** the preview pane grows to fill the freed width

#### Scenario: Sidebar collapse persists across reloads
- **WHEN** a user collapses the sidebar and then reloads the page in the same browser
- **THEN** the sidebar is still collapsed after the reload

#### Scenario: Expanding restores the document list
- **WHEN** a user clicks the expand control on a collapsed sidebar
- **THEN** the document list returns to its previous width

### Requirement: Animate the live connection indicator
While the browser UI is connected to the live update channel, the connection indicator SHALL animate with a subtle pulse so the live state is visually distinguishable from a static label. When the channel enters a reconnecting state, the pulse MUST stop and the indicator MUST communicate the reconnecting state without animation. The pulse MUST be disabled when the user's operating system requests reduced motion. The connection indicator MUST be rendered outside the collapsible sidebar (for example, in the preview header) so that users who collapse the sidebar can still observe the live channel state.

#### Scenario: The indicator pulses while connected to the server
- **WHEN** the browser UI's event channel is open
- **THEN** the connection indicator displays a pulsing animation labeled `Online`

#### Scenario: Reconnecting stops the pulse
- **WHEN** the browser UI's event channel reports an error and enters a reconnecting state
- **THEN** the indicator stops pulsing and communicates the reconnecting state

#### Scenario: Reduced-motion users see no animation
- **WHEN** the operating system reports a reduced-motion preference
- **THEN** the indicator does not pulse even while connected
- **AND** the live state is still communicated (e.g. via color and label)

#### Scenario: Indicator stays visible while the sidebar is collapsed
- **WHEN** a user collapses the sidebar
- **THEN** the connection indicator remains visible elsewhere in the UI

### Requirement: Pin the session to a single non-binary file
The browser UI SHALL provide a pin control on the active document that narrows the running session to that file without restarting the process. Pin SHALL be available for any visible non-binary file (Markdown or text). The server MUST reject file-scope mutations for unknown, ignored, secret-like, or binary document IDs and MUST leave the current scope unchanged when rejecting them. While pinned, the sidebar MUST show only the pinned file and changes to other files MUST NOT alter the active preview. While pinned, follow mode MUST NOT be enabled: the follow control MUST be disabled and its pressed state MUST be false, and pinning while follow was on MUST turn follow off. An unpin control MUST restore the previous folder-scoped view and re-enable the follow control. If the pinned file is deleted on disk, the session MUST automatically revert to folder scope and notify the UI. Pin state is per-session and MAY reset on page reload.

#### Scenario: Pinning narrows the session to one Markdown file
- **WHEN** a user clicks the pin control on the currently previewed Markdown file
- **THEN** the sidebar shows only that pinned document
- **AND** changes to other files under the watched root do not change the preview

#### Scenario: Pinning narrows the session to one text file
- **WHEN** a user clicks the pin control on the currently previewed non-Markdown text file
- **THEN** the sidebar shows only that pinned file
- **AND** changes to other files under the watched root do not change the preview

#### Scenario: Unpinning restores folder scope
- **WHEN** a user clicks the unpin control while a file is pinned
- **THEN** the sidebar re-populates with all non-ignored files under the watched roots

#### Scenario: Deleted pinned file reverts scope
- **WHEN** the pinned file is deleted on disk
- **THEN** the session automatically returns to folder scope
- **AND** the UI reflects the updated sidebar contents

#### Scenario: Pinning disables follow mode
- **WHEN** follow mode is enabled and a user pins the active file
- **THEN** follow mode is turned off
- **AND** the follow control is disabled while pinned

#### Scenario: Unpinning re-enables follow
- **WHEN** a user unpins the active file
- **THEN** the follow control is re-enabled (though follow itself remains off until the user activates it)

#### Scenario: Invalid file-scope mutation is rejected
- **WHEN** a client posts a file scope for a document ID that is unknown, ignored, secret-like, or binary
- **THEN** the server responds with a non-success response
- **AND** the current scope remains unchanged

### Requirement: Scroll the sidebar independently of the preview
The sidebar SHALL scroll within its own container and MUST NOT scroll together with the preview pane. The sidebar header (title, controls, and meta row) MUST remain visible while the sidebar's document list scrolls, and the sidebar MUST remain in place while the preview scrolls.

#### Scenario: Scrolling the preview does not move the sidebar
- **WHEN** a user scrolls a long Markdown document in the preview pane
- **THEN** the sidebar remains fixed in place
- **AND** the sidebar header and document list stay in their current scroll positions

#### Scenario: Scrolling a long document list does not scroll the preview
- **WHEN** a user scrolls the sidebar document list because it overflows its container
- **THEN** the preview pane does not scroll
- **AND** the sidebar header remains visible at the top of the sidebar

### Requirement: Keep the preview header visible while scrolling
The preview header SHALL remain pinned to the top of the preview pane while the document scrolls beneath it. The pinned header MUST use a translucent, blurred backdrop (frosted-glass effect) so scrolling content remains faintly visible through it and the transition between header and content reads as soft rather than as a sharp edge; the header MUST NOT use a hard bottom border in browsers that support `backdrop-filter`. Where the browser does not support `backdrop-filter`, the header MUST fall back to an opaque background with a hairline bottom border. The pinned header MUST contain the preview controls (follow and pin toggles) together on the right, so that scope controls stay reachable even when the sidebar is collapsed.

#### Scenario: Header stays visible while the document scrolls
- **WHEN** a user scrolls a long Markdown document in the preview
- **THEN** the preview header with the document title and path stays pinned at the top of the preview pane

#### Scenario: Scrolling content is faintly visible through the pinned header
- **WHEN** content passes behind the pinned header while scrolling
- **AND** the browser supports `backdrop-filter`
- **THEN** the content behind the header renders with a blurred, translucent effect rather than being fully hidden

#### Scenario: Older browsers fall back to an opaque header
- **WHEN** the browser does not support `backdrop-filter`
- **THEN** the pinned header uses an opaque background with a hairline bottom border

#### Scenario: Preview controls stay reachable while the sidebar is collapsed
- **WHEN** the sidebar is collapsed
- **THEN** the follow and pin controls remain visible in the preview header

### Requirement: Apply GitHub-style syntax highlighting to fenced code blocks
The preview pane SHALL render non-Mermaid fenced code blocks with GitHub-style syntax highlighting that visually matches the light GitHub theme. Language resolution MUST use the fenced block's info string when provided. Mermaid blocks MUST continue to render as diagrams and MUST NOT be syntax-highlighted as code.

#### Scenario: A JavaScript fenced block renders with highlighted tokens
- **WHEN** a selected Markdown file contains a fenced block with info string `js`
- **THEN** the preview renders the block with GitHub-style token coloring for JavaScript

#### Scenario: An unknown-language fenced block still renders readably
- **WHEN** a selected Markdown file contains a fenced block with an unrecognized info string
- **THEN** the preview renders the block as plain code without crashing the preview
- **AND** uses the GitHub-style neutral code block styling

#### Scenario: Mermaid blocks are not highlighted as code
- **WHEN** a selected Markdown file contains a fenced block with info string `mermaid`
- **THEN** the block renders as a Mermaid diagram
- **AND** no syntax-highlighting markup is applied to it

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

### Requirement: Render non-Markdown text files as syntax-highlighted code
The preview pane SHALL render selected text files that are not Markdown by emitting their contents as a single `<pre><code class="hljs language-X">` block whose token coloring uses GitHub-style highlight.js styling. Language resolution SHALL use a file-extension to highlight.js-language map, with a fallback to plain escaped text inside `<pre><code class="hljs">` for extensions that are not in the map. The map MUST be trivially extensible (one entry per extension). For files at or above 1 MB, the preview MUST render the contents as plain escaped text without invoking syntax highlighting, to keep the browser responsive. Markdown files MUST continue to render through the existing Markdown pipeline and MUST NOT be affected by the code render path.

#### Scenario: A YAML file renders with YAML token coloring
- **WHEN** a user selects a `.yaml` file in the sidebar
- **THEN** the preview renders its contents inside `<pre><code class="hljs language-yaml">`
- **AND** YAML tokens are colored using the GitHub-style highlight.js theme

#### Scenario: An unknown-extension text file renders readably without highlighting
- **WHEN** a user selects a text file whose extension is not in the language map
- **THEN** the preview renders its contents inside `<pre><code class="hljs">` as plain escaped text
- **AND** the preview does not crash

#### Scenario: A text file at or above 1 MB renders without syntax highlighting
- **WHEN** a user selects a 2 MB JSON file
- **THEN** the preview renders its contents as plain escaped text inside `<pre><code class="hljs">`
- **AND** highlight.js is not invoked on the contents

#### Scenario: Selecting a Markdown file uses the Markdown pipeline
- **WHEN** a user selects a `.md` file in the sidebar
- **THEN** the preview renders the file through the existing Markdown pipeline
- **AND** the preview is not wrapped in `<pre><code>`

### Requirement: Show last-modified time on each tree row
The sidebar tree SHALL display a small relative-time label next to every tree row (file leaves AND directories), reflecting how recently activity occurred at that path. For file leaves the label SHALL reflect the file's last-modified time on disk. For directory rows the label SHALL reflect the most recent last-modified time among any descendant file (recursively), so users can spot active subtrees without expanding them. The label SHALL use compact units (`now`, `5s`, `12m`, `2h`, `3d`, `4w`, `6mo`) and MUST be visually muted relative to the filename so it does not compete for attention. The label SHALL update in real time at approximately one-second resolution so the elapsed values tick visibly while the user watches.

#### Scenario: A recently modified file shows a small relative-time label
- **WHEN** the sidebar lists a file that was modified seconds ago
- **THEN** that tree row contains a relative-time label with a value like `now` or `5s`

#### Scenario: A directory row reflects the newest descendant file's modified time
- **WHEN** the sidebar lists a directory whose most recently modified descendant file was modified seconds ago
- **THEN** the directory row contains a relative-time label matching that descendant's relative time (e.g. `5s`)
- **AND** other descendants with older modified times do NOT influence the label

#### Scenario: Relative-time labels tick live without requiring a server event
- **WHEN** the user watches a tree row whose label currently reads `4s` and no file changes occur
- **THEN** within a few seconds the same label reads a larger value (e.g. `7s`, `10s`)

### Requirement: Display sidebar file count breakdown
The sidebar SHALL display a file count for the current scope. The count SHALL always show the total number of files visible in the tree. When the visible set contains binary files, the count SHALL additionally show how many are binary. When the watched roots contain files filtered by `.uatuignore` or `.gitignore`, the count SHALL additionally show how many were hidden by those user-controlled filters. The hardcoded directory denylist (e.g. `node_modules/`, `.git/`) MUST NOT contribute to the hidden count.

#### Scenario: Counter shows only the total when the tree is uniform
- **WHEN** the watched roots contain only viewable text and Markdown files with no `.uatuignore` or `.gitignore` filtering
- **THEN** the sidebar counter reads `N files` (e.g. `3 files`)

#### Scenario: Counter surfaces the binary subcount
- **WHEN** the watched roots contain a mix of viewable and binary files
- **THEN** the sidebar counter reads `N files · M binary` where M is the number of binary entries in the tree

#### Scenario: Counter surfaces the hidden subcount
- **WHEN** the watch root's `.uatuignore` filters out 2 files
- **AND** no binary files are present
- **THEN** the sidebar counter reads `N files · 2 hidden`

#### Scenario: Counter does not count denylisted directories as hidden
- **WHEN** the watch root contains `node_modules/` (in the hardcoded denylist) but no `.uatuignore` or `.gitignore` matches
- **THEN** the sidebar counter does not include a `· hidden` segment

### Requirement: Show the active file's type in the preview header
The preview header SHALL display a small chip next to the document title indicating the active file's type. For Markdown files the chip SHALL read `markdown`. For AsciiDoc files the chip SHALL read `asciidoc`. For non-Markdown, non-AsciiDoc text files the chip SHALL read the highlight.js language identifier when one is mapped (e.g. `yaml`, `python`, `typescript`). When the file's extension does not map to a known language, the chip SHALL read `text`. The chip MUST be hidden when no document is selected.

#### Scenario: A YAML file shows a `yaml` chip
- **WHEN** a user selects a `config.yaml` file
- **THEN** the preview header shows a chip reading `yaml`

#### Scenario: A Markdown file shows a `markdown` chip
- **WHEN** a user selects a `README.md` file
- **THEN** the preview header shows a chip reading `markdown`

#### Scenario: An AsciiDoc file shows an `asciidoc` chip
- **WHEN** a user selects a `README.adoc` file
- **THEN** the preview header shows a chip reading `asciidoc`

#### Scenario: An unmapped text extension shows a `text` chip
- **WHEN** a user selects a text file whose extension is not in the language map
- **THEN** the preview header shows a chip reading `text`

#### Scenario: Empty preview hides the chip
- **WHEN** no document is selected
- **THEN** no preview-header type chip is visible

### Requirement: Show line numbers on non-Markdown code views
The preview pane SHALL render a line-number gutter on the `<pre><code>` block produced by the non-Markdown code render path. Line numbers SHALL start at 1 and increment by 1 per line of source content. Markdown fenced code blocks (those that originate from a Markdown document's ` ``` ` fences) MUST NOT show a line-number gutter, matching the conventions of GitHub's README rendering. The line-number gutter MUST be visually distinguishable from the code, MUST NOT be selectable as part of the code text, and MUST NOT be included when the code is copied to the clipboard via the copy control or via standard text selection in supporting browsers.

#### Scenario: A non-Markdown text file shows numbered lines
- **WHEN** a user selects a text file (e.g. `config.yaml`) with three lines of content
- **THEN** the preview's `<pre>` displays a line-number gutter with the values `1`, `2`, `3`

#### Scenario: A Markdown fenced code block does not show numbered lines
- **WHEN** a user selects a Markdown document containing a fenced code block
- **THEN** the rendered `<pre>` for that fenced block has no line-number gutter

#### Scenario: Copying the code excludes the line numbers
- **WHEN** a user activates the copy control on a non-Markdown code view
- **THEN** the clipboard contains the source code only
- **AND** the clipboard contents do not begin with line-number digits

### Requirement: Provide a copy-to-clipboard control on every code block
The preview pane SHALL render a copy-to-clipboard control on every `<pre><code>` block, including Markdown fenced code blocks AND the single block produced by the non-Markdown render path. Activating the control SHALL copy the code block's textual contents to the system clipboard and display a brief confirmation. The control MUST NOT appear on Mermaid diagrams (which render as inline SVG, not `<pre><code>`).

#### Scenario: A Markdown fenced code block exposes a copy control
- **WHEN** a Markdown document containing a fenced code block is rendered in the preview
- **THEN** the rendered `<pre>` contains a copy control

#### Scenario: A non-Markdown code render exposes a copy control
- **WHEN** a non-Markdown text file is rendered in the preview
- **THEN** the rendered `<pre>` contains a copy control

#### Scenario: Activating the copy control writes the code to the clipboard
- **WHEN** a user activates a copy control on a code block
- **THEN** the code block's textual contents are written to the system clipboard
- **AND** the control briefly shows a confirmation label before reverting

#### Scenario: Mermaid diagrams do not show a copy control
- **WHEN** a Mermaid fenced block is rendered as a diagram
- **THEN** no copy control is added to the diagram

### Requirement: Render AsciiDoc in light mode
The preview pane SHALL render AsciiDoc files (`.adoc`, `.asciidoc`) using `@asciidoctor/core` configured with the `secure` safe mode. The system MUST NOT classify `.asc` files as AsciiDoc (despite GitHub doing so) because that extension is dominantly used for PGP ASCII-armored signatures and keys. The rendered HTML SHALL be sanitized against the same GitHub-modeled allowlist used for Markdown rendering, extended to whitelist the structural classes needed to style admonitions and callouts (`admonitionblock`, `note`, `tip`, `important`, `caution`, `warning`, `listingblock`, `title`, `content`, `colist`, `conum`). The preview MUST support GitHub-aligned AsciiDoc rendering for at minimum: section titles at every depth (the level-0 doctitle as `<h1>` and `==`–`======` mapping to `<h2>`–`<h6>`), paragraphs, ordered and unordered lists, tables, bold and italic, footnotes (collected at the bottom of the document), admonition blocks (`NOTE`, `TIP`, `IMPORTANT`, `CAUTION`, `WARNING`), `[source,LANG]` listings, table-of-contents output when the `:toc:` document attribute is set, and in-document cross-references via `<<id>>`. In-page anchor `href`s in the rendered HTML MUST resolve to the (possibly sanitize-prefixed) heading `id`s of the same document so that clicking a TOC entry or `<<xref>>` actually navigates to the target. **Cross-document AsciiDoc references — `xref:other.adoc[…]`, `xref:other.adoc#section[…]`, and the `<<other.adoc#section,…>>` shorthand — MUST keep their original file extension in the rendered `href` so the in-app cross-document anchor handler can resolve them against the watched roots; the system MUST NOT rewrite `.adoc` (or `.asciidoc`) to `.html` (this is enforced by setting the Asciidoctor `relfilesuffix` document attribute to `.adoc`).** The preview MUST NOT honor `include::` directives (the `secure` safe mode silently drops them), MUST NOT execute `<script>`/`<iframe>` or other active-content elements, MUST strip inline event handler attributes, and MUST reject `javascript:` URLs — matching the existing Markdown sanitize posture. The preview MUST default to light-mode visual presentation, reusing the existing GitHub-style document styling for elements common to both formats and applying minimal additional styling for AsciiDoc-specific structures (admonitions, callouts, listing block titles). For AsciiDoc input at or above 1 MB the preview MUST bypass Asciidoctor entirely and render the file as plain escaped text inside `<pre><code class="hljs">`, parallel to the existing size threshold for non-Markdown code views.

#### Scenario: A cross-document `xref:` keeps the `.adoc` extension
- **WHEN** an AsciiDoc document contains `xref:other.adoc[Other]`
- **THEN** the rendered `<a>` element carries `href="other.adoc"`
- **AND** the rendered href does NOT contain `.html`

#### Scenario: A cross-document `<<other.adoc#section,…>>` shorthand keeps the `.adoc` extension
- **WHEN** an AsciiDoc document contains `<<other.adoc#section,Other>>`
- **THEN** the rendered `<a>` element carries `href="other.adoc#section"`
- **AND** the rendered href does NOT contain `.html`

### Requirement: Navigate cross-document anchor clicks inside the preview
When a user clicks an anchor inside the rendered preview whose resolved URL maps to a known non-binary document under any watched root, the browser UI SHALL switch the preview to that document via the in-app document load path rather than letting the browser perform a full navigation. The interception MUST resolve the click target against the per-document `<base href>` so cross-document references written as relative paths (e.g. `xref:other.adoc[…]`, `[setup](guides/setup.md)`) reach the correct document. The interception MUST NOT fire for any of the following — those clicks MUST fall through to the browser's default behavior: a fragment-only href (handled by the existing in-page anchor handler), a modifier-click (Cmd, Ctrl, Shift, or Alt held), an explicit `target` attribute other than `_self`, a URL whose origin differs from the current page, a non-`http(s):` protocol (`mailto:`, `javascript:`, `tel:`, etc.), a path that does not resolve to any document in the current state, and a path that resolves to a document classified as binary. After the in-app load completes, a fragment in the resolved URL (e.g. `other.adoc#section`) SHALL scroll the matching element into view, mirroring sanitize's `user-content-` id prefix the same way the in-page anchor handler does. When the interception fires AND the active document is changing as a result of the click, the system MUST push a new browser history entry via `history.pushState`, with the new URL being the target document's relative path (per-segment percent-encoded), so the back button can return to the previously selected document.

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
The browser UI SHALL initialize on the document identified by `location.pathname` when the SPA boots. When `location.pathname` is `/`, the system MUST select the server-provided default document (today's behavior). When `location.pathname` resolves to a known non-binary document under a watched root, the system MUST select that document as the initial active preview, overriding the server-provided `defaultDocumentId`. When `location.pathname` resolves to a document that exists under a watched root but is outside the current scope (for example, the session is pinned to a different file), the SPA MUST render an empty-preview state explaining that the session is pinned to another file rather than silently selecting the wrong document or auto-unpinning. When `location.pathname` does not resolve to any known document under any watched root, the server MUST return a 404 via the static-file fallback (the SPA shell is not served — see "Serve adjacent files from watched roots as static content"); the SPA's "document not found" empty-preview state instead handles in-session cases where a previously-known document becomes unresolvable, covered under "Navigate document history with the browser back and forward buttons". When `location.hash` is present, the system MUST scroll the matching element into view after the document loads, mirroring the existing in-page anchor handler's `user-content-` prefix logic.

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

#### Scenario: A direct link to a document outside the pinned scope is rejected
- **WHEN** the watch session is pinned to file `README.md`
- **AND** a user navigates to `http://127.0.0.1:NNNN/guides/setup.md`
- **THEN** the SPA renders an empty-preview state explaining the session is pinned to `README.md`
- **AND** the active preview is NOT switched to `guides/setup.md`
- **AND** the sidebar still shows only the pinned file

### Requirement: Force follow mode off when arriving via a direct document URL
When the SPA boots with `location.pathname` resolving to a known non-binary document (i.e. anything other than `/`), the system MUST disable follow mode for the session, regardless of the server-provided `initialFollow` value derived from the CLI flags. The follow toggle MUST reflect the disabled state. The user MAY re-enable follow mode after arrival via the existing follow toggle. When `location.pathname` is `/`, the system MUST honor the server-provided `initialFollow` value (today's behavior preserved).

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
The system SHALL handle the browser's `popstate` event by re-selecting the document identified by the new URL pathname, without itself pushing or replacing additional history entries. The newly active document MUST be loaded through the in-app document load path (no full-page navigation). When the URL pathname resolves to a document outside the current scope or to no known document, the system MUST apply the same empty-preview rules defined in "Open a document by direct URL". When `popstate` fires AND follow mode is currently enabled, the system MUST disable follow mode for the session so the next file-system change does not immediately undo the back/forward navigation; this mirrors the follow-off rule that already applies to sidebar clicks, cross-document link clicks, and direct-link arrival.

#### Scenario: Back button restores a previously selected document
- **WHEN** a user has navigated from `README.md` to `guides/setup.md` to `guides/troubleshooting.md` via in-app clicks
- **AND** the user clicks the browser back button
- **THEN** the active preview returns to `guides/setup.md`
- **AND** the sidebar selection matches

#### Scenario: Forward button restores a document the user just stepped back from
- **WHEN** a user has stepped back from `guides/troubleshooting.md` to `guides/setup.md`
- **AND** the user clicks the browser forward button
- **THEN** the active preview returns to `guides/troubleshooting.md`

#### Scenario: Popstate to a no-longer-existent document renders empty preview
- **WHEN** a history entry refers to a document that has since been deleted from disk
- **AND** the user navigates to that entry via back/forward
- **THEN** the SPA renders an empty-preview state with a "document not found" message
- **AND** the sidebar still functions

#### Scenario: Browser back disables follow mode
- **WHEN** follow mode is enabled
- **AND** the user clicks the browser back button
- **THEN** the active preview returns to the previous document
- **AND** follow mode is disabled
- **AND** a subsequent file-system change does NOT auto-switch the preview away from the back-navigated document until the user re-enables follow
