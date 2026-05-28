## ADDED Requirements

### Requirement: Anchors targeting in-document section ids clear the sticky preview header at every depth
When a reader clicks any anchor whose target is a heading or section anchored inside the current document — whether the matching id sits on a `<h1>`–`<h6>` heading element or on an Asciidoctor section wrapper (`<div class="sect1">`, `<div class="sect2">`, `<div class="sect3">`, `<div class="sect4">`, `<div class="sect5">`) — the scroll operation MUST land the visible heading text below the bottom edge of the sticky preview header rather than behind it. The preview stylesheet MUST apply a `scroll-margin-top` sufficient to clear the sticky preview header AND its blur-fade falloff zone to BOTH the heading elements AND the Asciidoctor section wrappers with an `id` attribute.

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

## MODIFIED Requirements

### Requirement: Render AsciiDoc files
The preview pane SHALL render AsciiDoc files (`.adoc`, `.asciidoc`) using `@asciidoctor/core` configured with the `secure` safe mode. The system MUST NOT classify `.asc` files as AsciiDoc (despite GitHub doing so) because that extension is dominantly used for PGP ASCII-armored signatures and keys. The rendered HTML SHALL be sanitized against the same GitHub-modeled allowlist used for Markdown rendering, extended to whitelist the structural classes needed to style admonitions and callouts (`admonitionblock`, `note`, `tip`, `important`, `caution`, `warning`, `listingblock`, `title`, `content`, `colist`, `conum`). The preview MUST support GitHub-aligned AsciiDoc rendering for at minimum: section titles at every depth (the level-0 doctitle as `<h1>` and `==`–`======` mapping to `<h2>`–`<h6>`), paragraphs, ordered and unordered lists, tables, bold and italic, footnotes (collected at the bottom of the document), admonition blocks (`NOTE`, `TIP`, `IMPORTANT`, `CAUTION`, `WARNING`), `[source,LANG]` listings, table-of-contents output when the `:toc:` document attribute is set, and in-document cross-references via `<<id>>`. When the `:toc:` document attribute is set, the renderer SHALL include heading levels 1 through 5 in the generated TOC by default (i.e. it MUST set the Asciidoctor `toclevels` attribute to `5`), so the TOC reflects the deeper structure typical of web-displayed documentation. A document that declares its own `:toclevels:` value in its header MUST continue to override the default — authoring control is preserved. In-page anchor `href`s in the rendered HTML MUST resolve to the (possibly sanitize-prefixed) heading `id`s of the same document so that clicking a TOC entry or `<<xref>>` actually navigates to the target. **Cross-document AsciiDoc references — `xref:other.adoc[…]`, `xref:other.adoc#section[…]`, and the `<<other.adoc#section,…>>` shorthand — MUST keep their original file extension in the rendered `href` so the in-app cross-document anchor handler can resolve them against the watched roots; the system MUST NOT rewrite `.adoc` (or `.asciidoc`) to `.html` (this is enforced by setting the Asciidoctor `relfilesuffix` document attribute to `.adoc`).** The preview MUST NOT honor `include::` directives (the `secure` safe mode silently drops them), MUST NOT execute `<script>`/`<iframe>` or other active-content elements, MUST strip inline event handler attributes, and MUST reject `javascript:` URLs — matching the existing Markdown sanitize posture. The preview MUST default to light-mode visual presentation, reusing the existing GitHub-style document styling for elements common to both formats and applying minimal additional styling for AsciiDoc-specific structures (admonitions, callouts, listing block titles). For AsciiDoc input at or above 1 MB the preview MUST bypass Asciidoctor entirely and render the file as plain escaped text inside `<pre><code class="hljs">`, parallel to the existing size threshold for non-Markdown code views. The renderer MUST extract document-level metadata via Asciidoctor's document API rather than from the rendered HTML — the doctitle, the optional second-line author entry, the optional third-line revision entry, and the document header attributes (including but not limited to `:author:`, `:authors:`, `:email:`, `:revnumber:`, `:revdate:`, `:revremark:`, `:description:`, `:keywords:`, `:status:`) — and SHALL make that metadata available to the document metadata surface (see "Surface document metadata above the body"). Header attributes used today for body substitution (e.g. `{author}`) MUST continue to substitute correctly; surfacing them as metadata MUST NOT change body substitution behavior.

#### Scenario: Render an AsciiDoc file with sections, lists, tables, and admonitions
- **WHEN** a user selects an `.adoc` file containing a title, section headings, paragraphs, ordered and unordered lists, a table, and a `NOTE` admonition
- **THEN** the preview renders each element using the GitHub-modeled visual style
- **AND** the rendered HTML is sanitized before insertion (e.g. inline event handler attributes are stripped, `<script>` blocks are removed)

#### Scenario: An AsciiDoc file with a `:toc:` block emits a deep table of contents
- **WHEN** a user selects an `.adoc` file that declares `:toc:` and contains headings at depths `==`, `===`, `====`, and `=====`
- **THEN** the generated TOC includes entries at all of those depths
- **AND** clicking a TOC entry scrolls to the corresponding section

#### Scenario: A document `:toclevels:` setting overrides the default
- **WHEN** a user selects an `.adoc` file that declares both `:toc:` and `:toclevels: 2`
- **THEN** the generated TOC contains only `==` (level 1) entries
- **AND** deeper headings are not listed

#### Scenario: AsciiDoc cross-document references preserve the `.adoc` extension in their href
- **WHEN** a user views an AsciiDoc document containing `xref:other.adoc[Other]`, `xref:other.adoc#sect[Other Section]`, or `<<other.adoc#sect,Other Section>>`
- **THEN** the rendered preview contains anchors whose `href` attributes are `other.adoc`, `other.adoc#sect`, and `other.adoc#sect` respectively (no `.html` extension)
- **AND** clicking any of those anchors triggers the in-app cross-document load path (verified by the absence of a sub-resource fetch to `/other.adoc` or `/other.html`)

#### Scenario: Render an AsciiDoc file at or above 1 MB as plain text
- **WHEN** a user selects an `.adoc` file whose size is at or above 1 MB
- **THEN** the preview renders the file contents inside `<pre><code class="hljs">` as escaped plain text
- **AND** Asciidoctor is not invoked on the contents
- **AND** the existing rendering controls (e.g. classification banners) behave as for any oversized code-view path

#### Scenario: `.asc` files are not treated as AsciiDoc
- **WHEN** a user views a directory containing `key.asc` (a PGP ASCII-armored key)
- **THEN** the file is not classified as an AsciiDoc document
- **AND** the preview surface for that file is whatever the non-AsciiDoc classification produces (e.g. raw text or binary fallback)
