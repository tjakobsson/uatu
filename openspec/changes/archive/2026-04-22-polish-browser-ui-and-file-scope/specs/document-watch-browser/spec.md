## MODIFIED Requirements

### Requirement: Start a local document watch session
The system SHALL provide a `uatu watch [PATH...]` command that accepts zero or more positional paths. Each path MAY be either a directory (watched as a root group) or a Markdown file (watched as a single-file root). When no paths are provided, the system MUST use the current working directory as the only watched root. Non-directory, non-Markdown paths MUST be rejected with a clear error before the server starts. Starting the command SHALL launch a local browser UI server and print its URL to standard output. When standard output is a TTY, the command SHALL additionally print an ASCII `uatu` logo with the tagline "I observe. I follow. I render." above the URL.

#### Scenario: No paths defaults to the current directory
- **WHEN** a user runs `uatu watch` with no positional paths
- **THEN** the current working directory is used as the only watched root
- **AND** the local browser URL is printed

#### Scenario: Multiple positional paths become separate watched roots
- **WHEN** a user runs `uatu watch docs notes`
- **THEN** `docs` and `notes` are both registered as watched roots
- **AND** the browser UI shows them as separate root groups

#### Scenario: A Markdown file path starts a single-file watch session
- **WHEN** a user runs `uatu watch README.md`
- **THEN** the session is scoped to that single Markdown file
- **AND** the sidebar shows only that document
- **AND** changes to other Markdown files outside the file's directory do not appear

#### Scenario: A non-Markdown, non-directory path is rejected
- **WHEN** a user runs `uatu watch binary.png`
- **THEN** the command exits with a clear error naming the unsupported path
- **AND** no server is started

#### Scenario: Interactive startup prints the ASCII banner
- **WHEN** `uatu watch` is run with standard output attached to a terminal
- **THEN** the ASCII `uatu` logo and its tagline are printed before the URL

#### Scenario: Piped startup omits the banner
- **WHEN** `uatu watch` is run with standard output redirected to a pipe or file
- **THEN** only the URL is printed, without the ASCII banner

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

## ADDED Requirements

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
The sidebar document tree SHALL display a small icon next to each document leaf that reflects its file type, so readers can visually distinguish Markdown files from future supported types at a glance. The icon rendering SHALL be keyed by file extension and MUST be trivially extensible (one entry per extension) so additional types can be added without churn. A generic fallback icon MUST be used for any extension that has no dedicated icon.

#### Scenario: Markdown documents show a markdown icon in the tree
- **WHEN** the sidebar lists a `.md` or `.markdown` file
- **THEN** the tree row shows a file-type icon to the left of the file name

#### Scenario: Unknown extensions fall back to a generic file icon
- **WHEN** a future supported file type is not in the icon registry
- **THEN** the tree row still shows an icon (a generic file glyph) rather than an empty gap

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
While the browser UI is connected to the live update channel, the connection indicator SHALL animate with a subtle pulse so the live state is visually distinguishable from a static label. When the channel enters a reconnecting state, the pulse MUST stop and the indicator MUST communicate the reconnecting state without animation. The pulse MUST be disabled when the user's operating system requests reduced motion.

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

### Requirement: Pin the session to a single Markdown file
The browser UI SHALL provide a pin control on the active document that narrows the running session to that document without restarting the process. While pinned, the sidebar MUST show only the pinned document and changes to other Markdown files MUST NOT alter the active preview. While pinned, follow mode MUST NOT be enabled: the follow control MUST be disabled and its pressed state MUST be false, and pinning while follow was on MUST turn follow off. An unpin control MUST restore the previous folder-scoped view and re-enable the follow control. If the pinned document is deleted on disk, the session MUST automatically revert to folder scope and notify the UI. Pin state is per-session and MAY reset on page reload.

#### Scenario: Pinning narrows the session to one file
- **WHEN** a user clicks the pin control on the currently previewed Markdown file
- **THEN** the sidebar shows only that pinned document
- **AND** changes to other Markdown files under the watched root do not change the preview

#### Scenario: Unpinning restores folder scope
- **WHEN** a user clicks the unpin control while a document is pinned
- **THEN** the sidebar re-populates with all documents under the watched roots

#### Scenario: Deleted pinned file reverts scope
- **WHEN** the pinned Markdown file is deleted on disk
- **THEN** the session automatically returns to folder scope
- **AND** the UI reflects the updated sidebar contents

#### Scenario: Pinning disables follow mode
- **WHEN** follow mode is enabled and a user pins the active document
- **THEN** follow mode is turned off
- **AND** the follow control is disabled while pinned

#### Scenario: Unpinning re-enables follow
- **WHEN** a user unpins the active document
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
