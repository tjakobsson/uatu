## ADDED Requirements

### Requirement: Render GitHub-style Markdown in light mode
The preview pane SHALL default to light mode and SHALL render Markdown using GitHub Flavored Markdown-compatible behavior for common GitHub README features. At minimum, the preview MUST support GitHub-style rendering for tables, task lists, strikethrough, autolinks, and fenced code blocks, and the resulting presentation SHALL follow GitHub's light Markdown visual style. The preview MUST also render block-level and inline raw HTML (matching GitHub's README behavior) so that common README idioms such as centered hero images and attribute-bearing elements render as real HTML rather than as escaped text. Rendered HTML MUST be sanitized against a whitelist modeled on GitHub's allowlist before reaching the browser: `<script>`, `<iframe>`, and other active-content elements MUST NOT execute, inline event handler attributes (such as `onerror`, `onclick`) MUST be stripped, and URL attributes MUST reject unsafe protocols such as `javascript:`. Raw HTML inside fenced code blocks MUST continue to be displayed as literal code, not interpreted. The preview MUST recognize a YAML or TOML frontmatter block at the start of a Markdown document — a block delimited by `---`/`---` (YAML) or `+++`/`+++` (TOML) appearing before any other content — and SHALL parse it out of the body so the leading delimiter is NOT rendered as a thematic break. Recognized frontmatter MUST be made available to the document metadata surface (see "Surface document metadata above the body"); when frontmatter is malformed and cannot be parsed, the preview MUST fall back to rendering the document as if no frontmatter existed (the leading `---` again behaves as a thematic break) and MUST NOT surface a parse error to the reader.

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

#### Scenario: YAML frontmatter is parsed out of the body
- **WHEN** a Markdown file begins with a `---`-delimited YAML frontmatter block followed by `# Heading` body content
- **THEN** the rendered body HTML does NOT contain a leading `<hr />` or any `<p>` carrying the raw `key: value` lines from the frontmatter
- **AND** the body's first heading renders as `<h1>Heading</h1>`
- **AND** the parsed metadata is made available to the document metadata surface

#### Scenario: TOML frontmatter is parsed out of the body
- **WHEN** a Markdown file begins with a `+++`-delimited TOML frontmatter block followed by body content
- **THEN** the rendered body HTML does NOT contain the literal `+++` delimiters or the raw TOML key/value lines
- **AND** the parsed metadata is made available to the document metadata surface

#### Scenario: Malformed frontmatter falls back to the legacy thematic-break rendering
- **WHEN** a Markdown file begins with `---` followed by content that cannot be parsed as YAML or TOML and a closing `---`
- **THEN** the preview does NOT show a parse error to the reader
- **AND** the document metadata surface is omitted (no card)

#### Scenario: Documents without frontmatter are unaffected
- **WHEN** a Markdown file does NOT begin with a frontmatter block
- **THEN** the rendered body HTML is byte-identical to the rendering produced before frontmatter support was added
- **AND** the document metadata surface is omitted

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
The preview pane SHALL render AsciiDoc files (`.adoc`, `.asciidoc`) using `@asciidoctor/core` configured with the `secure` safe mode. The system MUST NOT classify `.asc` files as AsciiDoc (despite GitHub doing so) because that extension is dominantly used for PGP ASCII-armored signatures and keys. The rendered HTML SHALL be sanitized against the same GitHub-modeled allowlist used for Markdown rendering, extended to whitelist the structural classes needed to style admonitions and callouts (`admonitionblock`, `note`, `tip`, `important`, `caution`, `warning`, `listingblock`, `title`, `content`, `colist`, `conum`). The preview MUST support GitHub-aligned AsciiDoc rendering for at minimum: section titles at every depth (the level-0 doctitle as `<h1>` and `==`–`======` mapping to `<h2>`–`<h6>`), paragraphs, ordered and unordered lists, tables, bold and italic, footnotes (collected at the bottom of the document), admonition blocks (`NOTE`, `TIP`, `IMPORTANT`, `CAUTION`, `WARNING`), `[source,LANG]` listings, table-of-contents output when the `:toc:` document attribute is set, and in-document cross-references via `<<id>>`. In-page anchor `href`s in the rendered HTML MUST resolve to the (possibly sanitize-prefixed) heading `id`s of the same document so that clicking a TOC entry or `<<xref>>` actually navigates to the target. **Cross-document AsciiDoc references — `xref:other.adoc[…]`, `xref:other.adoc#section[…]`, and the `<<other.adoc#section,…>>` shorthand — MUST keep their original file extension in the rendered `href` so the in-app cross-document anchor handler can resolve them against the watched roots; the system MUST NOT rewrite `.adoc` (or `.asciidoc`) to `.html` (this is enforced by setting the Asciidoctor `relfilesuffix` document attribute to `.adoc`).** The preview MUST NOT honor `include::` directives (the `secure` safe mode silently drops them), MUST NOT execute `<script>`/`<iframe>` or other active-content elements, MUST strip inline event handler attributes, and MUST reject `javascript:` URLs — matching the existing Markdown sanitize posture. The preview MUST default to light-mode visual presentation, reusing the existing GitHub-style document styling for elements common to both formats and applying minimal additional styling for AsciiDoc-specific structures (admonitions, callouts, listing block titles). For AsciiDoc input at or above 1 MB the preview MUST bypass Asciidoctor entirely and render the file as plain escaped text inside `<pre><code class="hljs">`, parallel to the existing size threshold for non-Markdown code views. The renderer MUST extract document-level metadata via Asciidoctor's document API rather than from the rendered HTML — the doctitle, the optional second-line author entry, the optional third-line revision entry, and the document header attributes (including but not limited to `:author:`, `:authors:`, `:email:`, `:revnumber:`, `:revdate:`, `:revremark:`, `:description:`, `:keywords:`, `:status:`) — and SHALL make that metadata available to the document metadata surface (see "Surface document metadata above the body"). Header attributes used today for body substitution (e.g. `{author}`) MUST continue to substitute correctly; surfacing them as metadata MUST NOT change body substitution behavior.

#### Scenario: A cross-document `xref:` keeps the `.adoc` extension
- **WHEN** an AsciiDoc document contains `xref:other.adoc[Other]`
- **THEN** the rendered `<a>` element carries `href="other.adoc"`
- **AND** the rendered href does NOT contain `.html`

#### Scenario: A cross-document `<<other.adoc#section,…>>` shorthand keeps the `.adoc` extension
- **WHEN** an AsciiDoc document contains `<<other.adoc#section,Other>>`
- **THEN** the rendered `<a>` element carries `href="other.adoc#section"`
- **AND** the rendered href does NOT contain `.html`

#### Scenario: AsciiDoc header attributes are surfaced as metadata
- **WHEN** an AsciiDoc file declares `:author:`, `:revnumber:`, `:revdate:`, `:description:`, and `:keywords:` in its document header
- **THEN** those values are made available to the document metadata surface
- **AND** the body HTML is byte-identical to the rendering produced before metadata extraction was added

#### Scenario: AsciiDoc author and revision lines are surfaced as metadata
- **WHEN** an AsciiDoc file places an author entry on its second line and a revision entry on its third line
- **THEN** the parsed author name (and optional email) and the parsed revision number, date, and remark are made available to the document metadata surface

#### Scenario: AsciiDoc body substitution still works after metadata extraction
- **WHEN** an AsciiDoc file uses `{author}` or `{revnumber}` in body text
- **THEN** those tokens are substituted with the corresponding header values in the rendered body HTML

#### Scenario: An AsciiDoc file without header metadata renders byte-identical body HTML
- **WHEN** an AsciiDoc file's header carries no `:attr:` lines, no author line, and no revision line beyond the doctitle
- **THEN** the rendered body HTML is byte-identical to the rendering produced before metadata extraction was added
- **AND** the document metadata surface is omitted

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

### Requirement: Show a stale-content hint in Review when the active file changes on disk
While the active Mode is **Review**, the system SHALL render a stale-content hint as a strip in the active preview's header when the currently displayed file changes on disk. The hint MUST identify that the file has changed and MUST expose a refresh affordance. Activating the refresh affordance MUST re-render the active preview to the current on-disk content for the same file and MUST clear the hint. Multiple subsequent change events for the same active file while the hint is visible MUST coalesce into a single hint and MUST NOT spawn additional hints. Manual navigation away from the file (selecting a different file in the `Files` pane, opening a commit preview, navigating via URL, switching Mode) MUST clear the hint as a side effect. The hint MUST NOT appear in **Author** Mode. When the currently displayed file is *deleted* on disk while in **Review**, the hint MUST enter a distinct "file no longer exists on disk" state with a close or back affordance instead of refresh; the stale rendered content MUST remain visible until the user acts. The hint MUST NOT alter the indexed sidebar's normal handling of the change.

#### Scenario: Hint appears when the active file changes on disk in Review
- **WHEN** Mode is **Review** and the currently displayed file changes on disk
- **THEN** a stale-content hint appears in the active preview's header strip
- **AND** the rendered content remains the pre-change content
- **AND** the hint exposes a refresh affordance

#### Scenario: Refresh affordance re-renders the active preview and clears the hint
- **WHEN** the stale-content hint is visible in **Review** Mode
- **AND** the user activates the refresh affordance
- **THEN** the active preview re-renders to the current on-disk content for the same file
- **AND** the hint is cleared

#### Scenario: Multiple changes coalesce into a single hint
- **WHEN** the stale-content hint is visible in **Review** Mode for the active file
- **AND** the active file changes on disk again before the user acts on the hint
- **THEN** only one stale-content hint remains visible
- **AND** activating refresh re-renders to the latest on-disk content

#### Scenario: Manual navigation clears the hint
- **WHEN** the stale-content hint is visible in **Review** Mode
- **AND** the user navigates to a different file (via the `Files` pane, a `Git Log` commit, or a URL)
- **THEN** the hint is cleared
- **AND** the new active preview renders normally

#### Scenario: Switching to Author Mode clears the hint
- **WHEN** the stale-content hint is visible in **Review** Mode
- **AND** the user switches Mode to **Author**
- **THEN** the hint is cleared
- **AND** the active preview re-renders to the current on-disk content for the same file

#### Scenario: Hint never appears in Author Mode
- **WHEN** Mode is **Author** and the currently displayed file changes on disk
- **THEN** no stale-content hint appears
- **AND** the existing in-place refresh behavior applies

#### Scenario: Active file deleted on disk shows a deleted hint state
- **WHEN** Mode is **Review** and the currently displayed file is deleted on disk
- **THEN** the active preview's header strip shows a "file no longer exists on disk" hint state
- **AND** the hint exposes a close or back affordance instead of a refresh affordance
- **AND** the previously rendered content remains visible until the user acts on the hint
