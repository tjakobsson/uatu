# document-rendering Specification

## Purpose
Render Markdown, AsciiDoc, and text files safely with GitHub-style presentation, syntax highlighting, code affordances, metadata extraction, and sticky-header-safe anchor navigation.
## Requirements
### Requirement: Preserve document rendering behavior while benchmarking
Document render benchmarks SHALL measure existing rendering behavior without changing the rendered HTML, metadata extraction, source-view behavior, or safety guarantees defined by document rendering requirements.

#### Scenario: Benchmarking does not alter Markdown rendering
- **WHEN** Markdown render benchmarks are added
- **THEN** existing Markdown rendering behavior and tests remain valid

#### Scenario: Benchmarking does not alter AsciiDoc rendering
- **WHEN** AsciiDoc render benchmarks are added
- **THEN** existing AsciiDoc rendering behavior and tests remain valid

#### Scenario: Benchmarking does not alter source rendering
- **WHEN** source-code render benchmarks are added
- **THEN** existing source-view rendering behavior and tests remain valid

### Requirement: Render GitHub-style Markdown in light mode
The preview pane SHALL default to light mode and SHALL render Markdown using GitHub Flavored Markdown-compatible behavior for common GitHub README features, with sanitized raw HTML and frontmatter extraction for document metadata.

#### Scenario: README features and raw HTML follow GitHub presentation safely
- **WHEN** a Markdown document contains formatted content or raw HTML
- **THEN** the preview MUST support at least tables, task lists, strikethrough, autolinks, and fenced code blocks, with GitHub's light Markdown visual style
- **AND** block-level and inline raw HTML MUST render as real HTML rather than escaped text, including centered hero images and attribute-bearing elements
- **AND** rendered HTML MUST be sanitized against a GitHub-modeled whitelist before reaching the browser: `<script>`, `<iframe>`, and other active-content elements MUST NOT execute, inline event handlers such as `onerror` and `onclick` MUST be stripped, and URL attributes MUST reject unsafe protocols such as `javascript:`
- **AND** raw HTML inside fenced code blocks MUST remain literal code, not interpreted

#### Scenario: Leading frontmatter becomes metadata with a non-disruptive parse fallback
- **WHEN** Markdown begins before any other content with `---`/`---` YAML or `+++`/`+++` TOML frontmatter
- **THEN** the preview MUST recognize the block and SHALL parse it out of the body so the leading delimiter is NOT rendered as a thematic break
- **AND** recognized frontmatter MUST be available to the document metadata surface (see "Surface document metadata above the body")
- **AND** malformed, unparseable frontmatter MUST fall back to rendering as if no frontmatter existed, with leading `---` again a thematic break, and MUST NOT surface a parse error to the reader

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
The preview pane SHALL render selected text files that are not Markdown by emitting their contents as a single `<pre><code class="hljs language-X">` block whose token coloring uses GitHub-style highlight.js styling. The language map MUST be trivially extensible with one entry per extension.

#### Scenario: Code rendering resolves language and bounds highlighting work
- **WHEN** a selected text file enters the non-Markdown code render path
- **THEN** language resolution SHALL use a file-extension to highlight.js-language map, falling back to plain escaped text inside `<pre><code class="hljs">` for unmapped extensions
- **AND** the map MUST be trivially extensible with one entry per extension
- **AND** files at or above 1 MB MUST render as plain escaped text without invoking syntax highlighting to keep the browser responsive

#### Scenario: Markdown selection stays outside the code render path
- **WHEN** a Markdown file is selected
- **THEN** it MUST continue through the existing Markdown pipeline and MUST NOT be affected by the code render path

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
The preview header SHALL display a small chip next to the document title indicating the active file's type. The chip MUST be hidden when no document is selected.

#### Scenario: Selected file type determines the chip label
- **WHEN** a document is selected
- **THEN** Markdown SHALL show `markdown`, and AsciiDoc SHALL show `asciidoc`
- **AND** other text files SHALL show the mapped highlight.js language identifier (e.g. `yaml`, `python`, `typescript`) when one is mapped

#### Scenario: An active text file has an unmapped extension
- **WHEN** the active non-Markdown, non-AsciiDoc text file's extension does not map to a known language
- **THEN** the chip SHALL read `text`

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
The preview pane SHALL render a line-number gutter on the `<pre><code>` block produced by the non-Markdown code render path. Line numbers SHALL start at 1 and increment by 1 per line of source content.

#### Scenario: Line numbers remain separate from source text and Markdown fences
- **WHEN** code blocks are rendered, selected, or copied
- **THEN** Markdown fenced code blocks originating from a Markdown document's ` ``` ` fences MUST NOT show a line-number gutter, matching GitHub README conventions
- **AND** the gutter MUST be visually distinguishable from code, MUST NOT be selectable as code text, and MUST NOT be included in clipboard copies through the copy control or standard text selection in supporting browsers

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

### Requirement: Render AsciiDoc files
The preview pane SHALL render AsciiDoc files (`.adoc`, `.asciidoc`) using `@asciidoctor/core` configured with the `secure` safe mode, sanitized GitHub-aligned presentation, working references, and document metadata. It MUST default to light mode. The system MUST NOT classify `.asc` files as AsciiDoc (despite GitHub doing so) because that extension is dominantly used for PGP ASCII-armored signatures and keys.

#### Scenario: AsciiDoc structures use the shared safe light presentation
- **WHEN** AsciiDoc is rendered through Asciidoctor
- **THEN** HTML SHALL be sanitized against Markdown's GitHub-modeled allowlist, extended for admonition and callout structural classes `admonitionblock`, `note`, `tip`, `important`, `caution`, `warning`, `listingblock`, `title`, `content`, `colist`, and `conum`
- **AND** the preview MUST NOT honor `include::` directives (silently dropped by `secure` mode), MUST NOT execute `<script>`/`<iframe>` or other active content, MUST strip inline event handlers, and MUST reject `javascript:` URLs, matching Markdown sanitization
- **AND** the preview MUST default to light mode, reusing GitHub-style styling for common elements and adding minimal styling for admonitions, callouts, and listing block titles

#### Scenario: Standard AsciiDoc content and heading depths render completely
- **WHEN** an AsciiDoc document contains section titles, paragraphs, lists, tables, emphasis, footnotes, admonitions, listings, a TOC request, or in-document cross-references
- **THEN** the preview MUST support at least section titles at every depth (level-0 doctitle as `<h1>`, `==`–`======` as `<h2>`–`<h6>`), paragraphs, ordered and unordered lists, tables, bold and italic, bottom-collected footnotes, `NOTE` / `TIP` / `IMPORTANT` / `CAUTION` / `WARNING` admonitions, `[source,LANG]` listings, TOC output with `:toc:`, and `<<id>>` in-document cross-references
- **AND** with `:toc:` set, the renderer SHALL include heading levels 1 through 5 by default and MUST set Asciidoctor `toclevels` to `5`, reflecting deeper web documentation structure
- **AND** a document's own header `:toclevels:` value MUST continue overriding that default, preserving authoring control

#### Scenario: Every emitted in-page AsciiDoc anchor resolves within its document
- **WHEN** rendered AsciiDoc HTML contains any in-page anchor `href`, including an ordinary hyperlink without TOC or cross-reference macros
- **THEN** every such `href` MUST resolve to the same document's possibly sanitize-prefixed heading `id` so TOC entries, `<<xref>>`, and ordinary hyperlinks navigate to their targets

#### Scenario: AsciiDoc cross-document references preserve their file extensions
- **WHEN** the renderer emits cross-document AsciiDoc references
- **THEN** `xref:other.adoc[…]`, `xref:other.adoc#section[…]`, and `<<other.adoc#section,…>>` MUST retain their original file extension in rendered `href`s so the in-app cross-document handler resolves them against watched roots
- **AND** the system MUST NOT rewrite `.adoc` or `.asciidoc` to `.html`, enforced by setting Asciidoctor `relfilesuffix` to `.adoc`

#### Scenario: Large AsciiDoc input bypasses conversion
- **WHEN** AsciiDoc input is at or above 1 MB
- **THEN** the preview MUST bypass Asciidoctor entirely and render plain escaped text inside `<pre><code class="hljs">`, parallel to the non-Markdown code-view threshold

#### Scenario: Header metadata extraction preserves body substitution
- **WHEN** AsciiDoc header metadata is available
- **THEN** the renderer MUST extract it through Asciidoctor's document API rather than rendered HTML: doctitle, optional second-line author, optional third-line revision, and header attributes including `:author:`, `:authors:`, `:email:`, `:revnumber:`, `:revdate:`, `:revremark:`, `:description:`, `:keywords:`, and `:status:`
- **AND** it SHALL expose that metadata to the document metadata surface (see "Surface document metadata above the body")
- **AND** existing body substitutions such as `{author}` MUST continue correctly; surfacing metadata MUST NOT change body substitution behavior

#### Scenario: An AsciiDoc file with a `:toc:` block emits a deep table of contents
- **WHEN** a user selects an `.adoc` file that declares `:toc:` and contains headings at depths `==`, `===`, `====`, and `=====`
- **THEN** the generated TOC includes entries at all of those depths
- **AND** clicking a TOC entry scrolls to the corresponding section

#### Scenario: A document `:toclevels:` setting overrides the default
- **WHEN** a user selects an `.adoc` file that declares both `:toc:` and `:toclevels: 2`
- **THEN** the generated TOC contains only `==` (level 1) entries
- **AND** deeper headings are not listed

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
The preview header SHALL remain pinned to the top of the preview pane while the document scrolls beneath it. The pinned header MUST contain the preview controls (follow and pin toggles) together on the right, so scope controls stay reachable even when the sidebar is collapsed.

#### Scenario: Sticky-header styling follows backdrop-filter support
- **WHEN** the pinned preview header is displayed, whether or not its document is currently scrolling
- **THEN** it MUST use a translucent, blurred frosted-glass backdrop so content remains faintly visible and the transition reads as soft rather than sharp
- **AND** supporting browsers MUST NOT use a hard bottom border
- **AND** browsers without `backdrop-filter` MUST fall back to an opaque background with a hairline bottom border

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

### Requirement: Anchors targeting in-document section ids clear the sticky preview header at every depth
When a reader clicks any anchor whose target is anchored inside the current document, the scroll operation MUST land the visible target content below the bottom edge of the sticky preview header rather than behind it — regardless of the target element's type.

#### Scenario: All target elements clear the header through both anchor paths
- **WHEN** the in-page click handler directly scrolls a matching element or post-load scrolling resolves an inter-document cross-reference fragment
- **THEN** clearance MUST hold for `<h1>`–`<h6>` headings, Asciidoctor section wrappers `<div class="sect1">` through `<div class="sect5">`, and explicitly identified non-heading blocks
- **AND** non-heading examples include Asciidoctor `[#id]` anchors on tables or `[source]` listings and inline `[[id]]` anchors on paragraphs

#### Scenario: Scroll-container inset covers the header and blur-fade zone uniformly
- **WHEN** the preview stylesheet defines anchor clearance
- **THEN** it MUST reserve a top inset sufficient to clear the sticky header AND its blur-fade falloff zone on the preview scroll container, via `scroll-padding-top` on the scrolling element hosting the header, uniformly for every target it can reveal
- **AND** it MUST NOT depend on an enumerated per-element-type `scroll-margin-top` list

#### Scenario: Clicking a top-level TOC entry positions the heading clear of the sticky header
- **WHEN** a reader clicks a TOC entry that targets a `==` (level 1) section in an AsciiDoc document
- **THEN** after the scroll the corresponding `<h2>` element's top edge is at or below the bottom edge of the sticky preview header (plus a sub-pixel tolerance)
- **AND** the heading text is fully readable, not obscured by the frosted-glass band

#### Scenario: Clicking a deep TOC entry positions the heading clear of the sticky header
- **WHEN** a reader clicks a TOC entry that targets a `===`, `====`, or `=====` section in an AsciiDoc document
- **THEN** after the scroll the corresponding heading element's top edge is at or below the bottom edge of the sticky preview header (plus a sub-pixel tolerance)
- **AND** the heading text is fully readable

#### Scenario: Clicking a Markdown heading anchor positions the heading clear of the sticky header
- **WHEN** a reader clicks an `<a href="#section">` anchor that targets a Markdown heading rendered as `<h2 id="user-content-section">`
- **THEN** the heading element's top edge is at or below the bottom edge of the sticky preview header

#### Scenario: Clicking an intra-document cross-reference to a non-heading block clears the sticky header
- **WHEN** a reader clicks an intra-document cross-reference (e.g. `<<id>>` / `xref:#id[…]`) whose target id sits on a non-heading block such as a table or `[source]` listing carrying an Asciidoctor `[#id]` anchor
- **THEN** after the scroll the target block's top edge is at or below the bottom edge of the sticky preview header (plus a sub-pixel tolerance)
- **AND** the target block's leading content is fully readable, not obscured by the frosted-glass band

#### Scenario: An inter-document cross-reference to a non-heading block clears the sticky header
- **WHEN** a reader clicks an inter-document cross-reference into a sibling document at a fragment whose id sits on a non-heading block nested in a deep section (e.g. `xref:other.adoc#block-id[…]`) and the in-app document load completes
- **THEN** after the post-load scroll the resolved target block's top edge is at or below the bottom edge of the sticky preview header (plus a sub-pixel tolerance)
- **AND** the target block's leading content is fully readable, not obscured by the frosted-glass band
