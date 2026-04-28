## Purpose

Define the user-facing behavior for local browser-based document watch sessions over Markdown content.
## Requirements
### Requirement: Start a local document watch session
The system SHALL provide a `uatu watch [PATH...]` command that accepts zero or more positional paths. Each path MAY be either a directory (watched as a root group) or a non-binary file (watched as a single-file root). When no paths are provided, the system MUST use the current working directory as the only watched root. Paths that resolve to binary files MUST be rejected with a clear error before the server starts. Paths that do not exist on disk MUST also be rejected with a clear error. Starting the command SHALL launch a local browser UI server and print its URL to standard output. When standard output is a TTY, the command SHALL additionally print an ASCII `uatu` logo with the tagline "I observe. I follow. I render." above the URL. The command SHALL accept a `--no-gitignore` flag that disables `.gitignore` filtering for the session.

#### Scenario: No paths defaults to the current directory
- **WHEN** a user runs `uatu watch` with no positional paths
- **THEN** the current working directory is used as the only watched root
- **AND** the local browser URL is printed

#### Scenario: Multiple positional paths become separate watched roots
- **WHEN** a user runs `uatu watch docs notes`
- **THEN** `docs` and `notes` are both registered as watched roots
- **AND** the browser UI shows them as separate root groups

#### Scenario: A non-Markdown text file path starts a single-file watch session
- **WHEN** a user runs `uatu watch script.py`
- **THEN** the session is scoped to that single file
- **AND** the sidebar shows only that file
- **AND** changes to other files outside the file's directory do not appear

#### Scenario: A Markdown file path starts a single-file watch session
- **WHEN** a user runs `uatu watch README.md`
- **THEN** the session is scoped to that single Markdown file
- **AND** the sidebar shows only that document
- **AND** changes to other files outside the file's directory do not appear

#### Scenario: A binary file path is rejected
- **WHEN** a user runs `uatu watch logo.png`
- **THEN** the command exits with a clear error naming the unsupported path
- **AND** no server is started

#### Scenario: A non-existent path is rejected
- **WHEN** a user runs `uatu watch nope-not-a-real-file`
- **THEN** the command exits with a clear error naming the missing path
- **AND** no server is started

#### Scenario: Interactive startup prints the ASCII banner
- **WHEN** `uatu watch` is run with standard output attached to a terminal
- **THEN** the ASCII `uatu` logo and its tagline are printed before the URL

#### Scenario: Piped startup omits the banner
- **WHEN** `uatu watch` is run with standard output redirected to a pipe or file
- **THEN** only the URL is printed, without the ASCII banner

#### Scenario: `--no-gitignore` is accepted as a startup flag
- **WHEN** a user runs `uatu watch . --no-gitignore`
- **THEN** the session starts without applying `.gitignore` patterns to the indexed file set
- **AND** the local browser URL is printed

### Requirement: Configure startup browser behavior
The system SHALL attempt to open the browser automatically and SHALL start with follow mode enabled by default. The command MUST provide flags to disable browser auto-open and to disable follow mode before the watch session starts. The local browser URL MUST be printed whether or not the browser is opened successfully.

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

### Requirement: Browse supported documents from watched roots
The browser UI SHALL display a sidebar tree grouped by watched root. The tree SHALL list every file accepted by the ignore filter under each root, recursively. Files classified as Markdown, AsciiDoc, or as viewable text SHALL render as clickable entries that can become the active preview. Files classified as binary SHALL render as non-clickable entries that show a file-type icon but cannot change the active preview. The preview pane SHALL render the currently selected non-binary file: Markdown files through the Markdown pipeline, AsciiDoc files through the AsciiDoc pipeline, other text files through the syntax-highlighted code render path.

#### Scenario: Sidebar lists every non-ignored file under each watched root
- **WHEN** watched roots contain a mix of Markdown, AsciiDoc, source code, configuration, and binary files
- **THEN** the sidebar displays all of those files within the hierarchy of their corresponding watched root
- **AND** Markdown, AsciiDoc, and other text files appear as clickable entries
- **AND** binary files appear as non-clickable entries

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
When follow mode is enabled, the system SHALL switch the active preview to the latest changed non-binary file under the watched roots. Markdown and non-Markdown text files SHALL both be eligible to change the active preview under follow mode. Binary file changes MUST NOT change the active preview. Manual file selection in the sidebar MUST disable follow mode and pin the selected file until follow mode is enabled again. When the user transitions follow mode from disabled to enabled, the system SHALL immediately switch the active preview to the most recently modified non-binary file under the watched roots, rather than waiting for the next change event.

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

### Requirement: Serve adjacent files from watched roots as static content
For any request path that does not match a known API or built-in asset route, the server SHALL attempt to resolve the path against the union of watched roots and, if the path maps to an existing file inside a watched root, serve that file statically. The rendered preview HTML MUST preserve the author's original `src` and `href` URLs verbatim (no URL rewriting); the browser SHALL resolve those references using a per-document base so that relative references such as `<img src="./hero.svg">` in a README just work. Any requested path that resolves outside every watched root (via `..` segments or otherwise) MUST receive a 404.

#### Scenario: A README's centered hero image loads via the static file fallback
- **WHEN** a previewed Markdown file contains `<img src="./hero.svg">` whose target exists next to the document
- **THEN** the rendered image's `src` attribute is preserved as `./hero.svg`
- **AND** the browser resolves it through the per-document base and receives the image from the static file fallback

#### Scenario: Unrelated paths are 404
- **WHEN** the server receives a request for a path that does not map to any file inside a watched root
- **THEN** the server responds with 404

#### Scenario: Traversal attempts are rejected
- **WHEN** a request path resolves (via `..`) outside every watched root
- **THEN** the server responds with 404 and does not read the file

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
The browser UI SHALL provide a pin control on the active document that narrows the running session to that file without restarting the process. Pin SHALL be available for any non-binary file (Markdown or text). While pinned, the sidebar MUST show only the pinned file and changes to other files MUST NOT alter the active preview. While pinned, follow mode MUST NOT be enabled: the follow control MUST be disabled and its pressed state MUST be false, and pinning while follow was on MUST turn follow off. An unpin control MUST restore the previous folder-scoped view and re-enable the follow control. If the pinned file is deleted on disk, the session MUST automatically revert to folder scope and notify the UI. Pin state is per-session and MAY reset on page reload.

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
The preview pane SHALL render AsciiDoc files (`.adoc`, `.asciidoc`) using `@asciidoctor/core` configured with the `secure` safe mode. The system MUST NOT classify `.asc` files as AsciiDoc (despite GitHub doing so) because that extension is dominantly used for PGP ASCII-armored signatures and keys. The rendered HTML SHALL be sanitized against the same GitHub-modeled allowlist used for Markdown rendering, extended to whitelist the structural classes needed to style admonitions and callouts (`admonitionblock`, `note`, `tip`, `important`, `caution`, `warning`, `listingblock`, `title`, `content`, `colist`, `conum`). The preview MUST support GitHub-aligned AsciiDoc rendering for at minimum: section titles at every depth (the level-0 doctitle as `<h1>` and `==`–`======` mapping to `<h2>`–`<h6>`), paragraphs, ordered and unordered lists, tables, bold and italic, footnotes (collected at the bottom of the document), admonition blocks (`NOTE`, `TIP`, `IMPORTANT`, `CAUTION`, `WARNING`), `[source,LANG]` listings, table-of-contents output when the `:toc:` document attribute is set, and in-document cross-references via `<<id>>`. In-page anchor `href`s in the rendered HTML MUST resolve to the (possibly sanitize-prefixed) heading `id`s of the same document so that clicking a TOC entry or `<<xref>>` actually navigates to the target. The preview MUST NOT honor `include::` directives (the `secure` safe mode silently drops them), MUST NOT execute `<script>`/`<iframe>` or other active-content elements, MUST strip inline event handler attributes, and MUST reject `javascript:` URLs — matching the existing Markdown sanitize posture. The preview MUST default to light-mode visual presentation, reusing the existing GitHub-style document styling for elements common to both formats and applying minimal additional styling for AsciiDoc-specific structures (admonitions, callouts, listing block titles). For AsciiDoc input at or above 1 MB the preview MUST bypass Asciidoctor entirely and render the file as plain escaped text inside `<pre><code class="hljs">`, parallel to the existing size threshold for non-Markdown code views.

#### Scenario: An AsciiDoc document renders with section titles, lists, and tables
- **WHEN** a user selects an `.adoc` file containing a level-0 title, level-1 sections, an ordered list, and a table
- **THEN** the preview renders the document title as `<h1>`
- **AND** sections render with their nested headings
- **AND** lists and tables render as formatted HTML elements rather than plain paragraph text

#### Scenario: Heading depth maps `=`–`======` to `<h1>`–`<h6>`
- **WHEN** a user selects an `.adoc` file whose deepest heading uses six `=` characters
- **THEN** the level-0 doctitle renders as `<h1>` and each subsequent depth maps to the next heading element through `<h6>`

#### Scenario: A `:toc:` document renders a clickable Table of Contents
- **WHEN** a user selects an `.adoc` file that sets `:toc:` and contains multiple section headings
- **THEN** the preview renders a Table of Contents listing each section as a link
- **AND** clicking a TOC entry navigates the preview to that section (the entry's `href` resolves to the section's heading `id`)

#### Scenario: TOC navigation still works when the AsciiDoc file lives in a subdirectory
- **WHEN** a user selects an `.adoc` file located inside a subdirectory of a watched root (so the per-document `<base href>` points at that subdirectory rather than the page URL's directory)
- **AND** the user clicks a TOC entry whose `href` is a fragment-only anchor
- **THEN** the click MUST scroll the matching heading into view inside the preview
- **AND** the browser MUST NOT navigate the page to a different URL or to the server's static-file fallback (which would 404)

#### Scenario: An admonition block renders with its kind class preserved
- **WHEN** a user selects an `.adoc` file containing a `NOTE:` admonition
- **THEN** the preview renders an element carrying the admonition kind class (e.g. `admonitionblock note`)
- **AND** uatu's admonition styling is applied to that element

#### Scenario: A `[source,LANG]` listing renders with highlight.js token coloring
- **WHEN** a user selects an `.adoc` file containing a `[source,javascript]` listing
- **THEN** the preview renders that listing with GitHub-style highlight.js token coloring
- **AND** the rendered code block carries `class="hljs language-javascript"` so existing code-block features (copy control, line numbering rules) apply uniformly

#### Scenario: An `include::` directive is silently dropped
- **WHEN** a user selects an `.adoc` file containing an `include::other.adoc[]` directive
- **THEN** Asciidoctor's `secure` safe mode prevents the include from being resolved
- **AND** the preview renders without crashing
- **AND** no contents from the referenced file appear in the preview

#### Scenario: Unsafe HTML in AsciiDoc input is neutralized
- **WHEN** an AsciiDoc file contains a passthrough that would emit `<script>`, an inline `onerror` handler, or a `javascript:` URL
- **THEN** no executable `<script>` reaches the preview DOM
- **AND** inline event handler attributes are removed
- **AND** `href`/`src` attributes using the `javascript:` protocol are removed

#### Scenario: An oversized AsciiDoc file falls back to plain text
- **WHEN** a user selects an `.adoc` file at or above 1 MB
- **THEN** the preview renders the contents inside `<pre><code class="hljs">` as plain escaped text
- **AND** Asciidoctor is not invoked on the contents

