## ADDED Requirements

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

## MODIFIED Requirements

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
