## Why

Clicking an in-document anchor only reliably lands its target clear of the sticky preview header when that target is a heading or an Asciidoctor section wrapper. The header-clearance offset is implemented as a per-element `scroll-margin-top` scoped to `<h1>`–`<h6>` and `.sect1`–`.sect5[id]` only (`src/styles.css:2151`). Any other anchored target — a table, a listing, or a paragraph carrying an explicit `[#id]`/`[[id]]` — has no scroll-margin, so `scrollIntoView` pins its top edge to the viewport top and the target lands *behind* the frosted-glass header. The spec and the test suite both encode the narrow heading-only contract, so this gap is invisible: no fixture exercises a non-heading anchor target, and no fixture exercises an inter-document cross-reference into a deep section (which scrolls via a different handler — `scrollToFragment` after the in-app load — than the in-page click handler the existing tests cover).

## What Changes

- **Generalize header clearance to every anchor target.** Replace the per-element `scroll-margin-top` rule (headings + section wrappers) with a single `scroll-padding-top` on the preview scroll container (`.preview-shell`). `scrollIntoView` honors the scroll container's `scroll-padding`, so the offset applies uniformly to any anchored target — headings, section wrappers, and non-heading blocks alike — across both scroll paths (the in-page click handler's `scrollIntoView` and `scrollToFragment` after a cross-document load). The now-redundant heading/section `scroll-margin-top` rule is removed.
- **Add cross-reference fixtures.** Add a small purpose-built AsciiDoc fixture (and a sibling target doc) under `testdata/watch-docs/` exercising (a) an intra-document cross-reference to a **non-heading block** anchor (e.g. a table or listing with `[#id]`) and (b) an inter-document cross-reference into a **deep section** of a sibling doc (`xref:other.adoc#deep-section[…]`). The benchmark `architecture-large.adoc` is intentionally left untouched and is not pulled into the watch tree.
- **Add regression coverage.** Extend `tests/e2e/asciidoc.e2e.ts` so a non-heading-block intra-doc cross-reference and an inter-document deep-fragment cross-reference each assert the resolved target lands at or below the sticky header's bottom edge. Existing TOC/heading scenarios must keep passing.

## Capabilities

### New Capabilities

None. This refines existing rendering behavior and adds test coverage.

### Modified Capabilities

- `document-rendering`: The header-clearance requirement (currently "Anchors targeting in-document section ids clear the sticky preview header at every depth") is broadened to cover **any** in-document anchor target — headings, Asciidoctor section wrappers, and non-heading blocks carrying an explicit id — and its implementation mandate changes from per-element `scroll-margin-top` on headings/section wrappers to `scroll-padding-top` on the preview scroll container.

## Impact

**Code**

- `src/styles.css` — remove the `.preview :is(h1…h6), .preview :is(.sect1…sect5)[id] { scroll-margin-top: 7.5rem }` rule; add `scroll-padding-top: 7.5rem` to `.preview-shell` (the `overflow:auto` scroll container that hosts the sticky `.preview-header`).

**Fixtures**

- `testdata/watch-docs/` — add an AsciiDoc fixture with a non-heading block anchor and an intra-doc cross-reference to it, plus an inter-document cross-reference into a deep section of a sibling doc (new or existing target doc long enough that the deep section would otherwise sit behind the header).

**Tests**

- `tests/e2e/asciidoc.e2e.ts` — new scenarios for the non-heading-block intra-doc cross-reference and the inter-document deep-fragment cross-reference, each asserting the target's top edge is at or below the sticky header bottom (with sub-pixel tolerance), mirroring the existing deep-TOC clearance assertion.

**Not affected**

- Split-view: in split mode the sticky header sits outside the per-pane `.preview-pane` scroll containers, so pane content never overlaps it — no change needed.
- No server, CLI, routing, or sanitize change. `architecture-large.adoc` is unchanged.
