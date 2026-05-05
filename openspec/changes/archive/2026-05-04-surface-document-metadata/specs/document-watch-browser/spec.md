## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Surface document metadata above the body
The preview pane SHALL render extracted document-level metadata as a single, format-agnostic metadata card placed above the body of the rendered document. The card SHALL surface a curated set of fields — title, author(s), date, revision/version, description, tags/keywords, status — when those fields are present in the source. Format-specific keys MUST be normalized so that the card looks consistent regardless of whether the source was Markdown YAML/TOML frontmatter or AsciiDoc header attributes (for example, AsciiDoc `:keywords:` MUST surface in the same `tags` row that Markdown `tags` populates; AsciiDoc `:revnumber:` MUST surface in the same `revision` row that Markdown `version` populates). Fields that are not part of the curated set MUST still render — visually subdued — as a generic key/value list so that the curated fields stand out. Every metadata value reaching the DOM MUST be HTML-escaped or passed through the same GitHub-modeled sanitize allowlist used for body HTML, so a metadata value containing `<script>`, `<iframe>`, an inline event handler, or a `javascript:` URL MUST NOT execute. The card MUST be omitted entirely when no metadata is present so documents without frontmatter or AsciiDoc header metadata render unchanged. The card MUST be available regardless of source format: a Markdown document with YAML frontmatter and an AsciiDoc document with equivalent header attributes MUST produce the same card shape.

#### Scenario: A Markdown document with frontmatter shows a metadata card
- **WHEN** a user selects a Markdown document whose frontmatter declares `title`, `author`, `date`, `description`, and `tags`
- **THEN** the preview shows a metadata card above the body containing those fields
- **AND** the curated rows render in a consistent order regardless of the order they appeared in the source

#### Scenario: An AsciiDoc document with header metadata shows the same card shape
- **WHEN** a user selects an AsciiDoc document whose header declares an equivalent set of attributes (doctitle, author line, `:revdate:`, `:description:`, `:keywords:`)
- **THEN** the preview shows a metadata card above the body containing those fields
- **AND** the card uses the same row ordering and visual shape as the Markdown card for the same conceptual metadata

#### Scenario: Documents without metadata show no card
- **WHEN** a user selects a Markdown or AsciiDoc document that has no frontmatter and no AsciiDoc header attributes
- **THEN** the preview renders no metadata card
- **AND** the body HTML occupies the same vertical space it did before metadata support was added

#### Scenario: Unknown metadata fields render as a subdued key/value list
- **WHEN** a Markdown document's frontmatter or an AsciiDoc document's header includes fields that are not part of the curated set (e.g. `slug`, `permalink`, `category`)
- **THEN** the preview shows those fields in a subdued generic key/value list within the card
- **AND** the curated fields remain visually prominent above or distinct from the generic list

#### Scenario: Metadata values are sanitized before reaching the DOM
- **WHEN** a metadata value contains `<script>alert(1)</script>`, an `onerror=` attribute, an `<iframe>`, or a `javascript:` URL
- **THEN** no executable script or active-content element is added to the preview DOM
- **AND** the offending content is rendered as escaped text or stripped, matching the body-HTML sanitize posture
