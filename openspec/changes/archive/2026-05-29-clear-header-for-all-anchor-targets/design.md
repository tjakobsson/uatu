## Context

The preview pane pins its header to the top of the scroll container (`.preview-header`, `position: sticky; top: 0`, hosted inside `.preview-shell` which is the `overflow: auto` scroller — `src/styles.css:400,965`). To keep an anchored target from landing behind that frosted header, the stylesheet currently sets `scroll-margin-top: 7.5rem` on a fixed selector list: `.preview :is(h1,h2,h3,h4,h5,h6)` and `.preview :is(.sect1,.sect2,.sect3,.sect4,.sect5)[id]` (`src/styles.css:2151`). That value clears the header plus its 28px blur-fade falloff.

Two scroll paths consume this offset, and both rely on the browser honoring it:
- **In-page click** (`src/preview/anchors.ts:66`) — `element.scrollIntoView({ behavior: "smooth", block: "start" })` for `#fragment` links (TOC, intra-doc `<<id>>`/`xref:#id`).
- **Cross-document load** (`src/shell/history.ts:91` `scrollToFragment`) — same `scrollIntoView` after the in-app document load, for `xref:other.adoc#section[…]` and direct-URL fragments.

Exploration confirmed the heading case works (intra-doc `<<source-listings>>` lands its `<h2>` clear of the header). It also confirmed the selector is the whole contract: an id placed on a **non-heading block** (Asciidoctor `[#id]` on a table/listing, `[[id]]` on a paragraph) matches neither selector arm, gets no scroll-margin, and `scrollIntoView({block:"start"})` aligns its top to the viewport top — behind the header.

## Goals / Non-Goals

**Goals:**
- Any in-document anchor target lands at or below the sticky header's bottom edge, regardless of element type or which scroll path resolved it.
- Collapse the offset to a single rule that cannot drift out of sync with the set of anchorable element types.
- Lock the behavior with fixtures + e2e for the two currently-uncovered cases (non-heading block intra-doc xref; inter-document deep-fragment xref).

**Non-Goals:**
- Reworking the offset *magnitude* beyond a small bump for breathing room (lands at `9rem` — header + 28px falloff + a little clearance so the target doesn't sit right where the frost fades out).
- Split-view scroll behavior (the sticky header lives outside the per-pane scrollers, so panes never overlap it).
- Touching `architecture-large.adoc` or pulling the benchmark tree into the e2e watch root.
- Any server/CLI/routing/sanitize change.

## Decisions

### Decision: `scroll-padding-top` on the scroll container, not `scroll-margin-top` per element

Set `scroll-padding-top: 9rem` on `.preview-shell` (the scroll container) and delete the heading/section `scroll-margin-top` rule.

Per the CSSOM View spec, `scrollIntoView` computes the scroll position using the *scroll container's* `scroll-padding` as an inset in addition to the target's `scroll-margin`. Putting the inset on the container therefore applies it to **every** target the scroller can reveal — headings, `.sectN` wrappers, tables, listings, paragraphs, and any future anchorable element — without enumerating element types. It covers both scroll paths automatically because both call `scrollIntoView` against elements inside `.preview-shell`.

**Why over the alternatives:**
- *Broaden the selector to `.preview [id]`* — would cover today's blocks but re-encodes the "list every anchorable thing" pattern as a different list, applies a 7.5rem margin to every id'd element (affecting layout/scroll math broadly), and still leaves the offset duplicated across two mechanisms. A single container inset is strictly simpler.
- *JS offset (scroll then adjust by header height)* — reintroduces per-call math in two handlers, fights smooth-scroll, and would need to read the live header height. The CSS container inset is declarative and path-agnostic.

### Decision: a `9rem` inset — today's `7.5rem` plus a little breathing room

The pre-change `7.5rem` cleared the header plus its 28px blur-fade falloff, but landed the target *exactly* where the frost fades out, which reads as tight. Bump to `9rem` so anchored targets land with visible clearance below the fade. The heading/TOC cases that already passed keep passing — a larger inset only lands targets lower, and their clearance assertions are `>= headerBottom - tolerance`.

### Decision: cover both gaps with one small fixture pair under `testdata/watch-docs/`

Add an AsciiDoc fixture that (a) defines a non-heading block with `[#id]` and an intra-doc cross-reference to it, and (b) cross-references a deep section of a sibling doc via `xref:other.adoc#deep-section[…]`. Keep it small and deterministic, consistent with the existing `asciidoc-cheatsheet.adoc` / `links-demo.adoc` fixtures. The benchmark `architecture-large.adoc` stays out of the watch tree — it has no cross-references and is only consumed by `scripts/bench-render.ts`.

## Risks / Trade-offs

- **`scroll-padding` browser/scroll-path support** → All target browsers (the app is Chromium-driven for e2e; modern evergreen otherwise) honor `scroll-padding` for `scrollIntoView`. The new e2e scenarios assert real landing positions, so a regression here fails loudly rather than silently.
- **The existing heading/TOC scenarios could regress if the inset interacts differently than the per-element margin** → Mitigated by keeping the existing deep-TOC clearance test; its assertion is `>= headerBottom - tolerance`, so the slightly larger inset only lands targets lower and the test still passes (verified).
- **Smooth-scroll timing in tests** → The new assertions poll the target rect after the scroll settles (the established pattern in `asciidoc.e2e.ts:218`), avoiding mid-animation reads.
- **Non-scrolling targets near the document end** → If a target is close enough to the bottom that the scroller cannot place it below the inset, the browser scrolls as far as it can. This matches today's behavior and is acceptable; the assertion tolerates the documented sub-pixel margin and is exercised against targets with enough content below them.
