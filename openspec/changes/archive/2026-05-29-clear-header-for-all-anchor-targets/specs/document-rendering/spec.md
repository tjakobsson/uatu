## MODIFIED Requirements

### Requirement: Anchors targeting in-document section ids clear the sticky preview header at every depth
When a reader clicks any anchor whose target is anchored inside the current document, the scroll operation MUST land the visible target content below the bottom edge of the sticky preview header rather than behind it — regardless of the target element's type. This MUST hold whether the matching id sits on a `<h1>`–`<h6>` heading element, on an Asciidoctor section wrapper (`<div class="sect1">` through `<div class="sect5">`), or on a **non-heading block** that carries an explicit id (for example an Asciidoctor `[#id]` block anchor on a table or `[source]` listing, or an inline `[[id]]` anchor on a paragraph). This MUST hold for both in-document scroll paths: the in-page anchor click handler (which scrolls the matching element into view directly) and the post-load scroll applied after an inter-document cross-reference resolves to a fragment in another document.

The preview stylesheet MUST reserve a top inset sufficient to clear the sticky preview header AND its blur-fade falloff zone on the preview scroll container (i.e. via `scroll-padding-top` on the scrolling element that hosts the sticky header), so the inset applies uniformly to every anchored target the container can reveal. The stylesheet MUST NOT depend on an enumerated per-element-type `scroll-margin-top` list to achieve header clearance.

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
