## Why

Four independently reported papercuts in the preview pane and sidebar are eroding the "in-app navigation feels right" promise: (1) clicking an external link in a rendered doc hijacks the current tab — the user loses their uatu session and has to navigate back to recover; (2) the Files-pane header visually mashes the "Files" title into the "N files · M binary" count when the sidebar is at a typical working width — the layout flexes the title and the meta block toward each other until they overlap, looking broken; (3) clicking a TOC entry inside an AsciiDoc file scrolls correctly the first time but the browser back button then jumps to the previous *document* instead of returning the user to the top of the TOC where they started reading, because the in-page anchor handler scrolls without pushing a history entry; (4) the testdata-driven TOC fixtures only exercise top-level entries, masking a real bug where clicking a deeper TOC entry (h3 or below) scrolls the target heading *underneath* the sticky preview header — the `scroll-margin-top` rule applies to the heading element but Asciidoctor places the id on the surrounding `<div class="sect2">` wrapper, so `scrollIntoView` aligns the wrapper edge to the viewport top and the heading sits behind the frosted-glass strip.

The four bugs are individually small but they all degrade the same surface: "clicking things in the preview behaves the way users expect." Bundling them into one change concentrates the in-app navigation polish into one round-trip of e2e regression coverage rather than four near-empty PRs.

## What Changes

- **External-link target.** The Markdown and AsciiDoc render passes rewrite anchors whose resolved origin differs from the app's origin to carry `target="_blank"` and `rel="noopener noreferrer"` so clicking them opens the destination in a new tab and never tears down the uatu SPA. The sanitize schema is extended to permit the `target` and `rel` attributes on `<a>` since the existing GitHub-modeled allowlist strips them. Same-origin links keep falling through to the existing cross-document anchor handler.
- **Files-pane header doesn't visually overlap.** The pane header's flex layout is hardened so the `<h2>Files</h2>` title and the `pane-meta` block (file count + filter chip) stay legible at every sidebar width: the title gets `flex-shrink: 1` + `min-width: 0` + `text-overflow: ellipsis`, the meta keeps `flex-shrink: 0`, and the gap between them widens to a value that doesn't collapse to zero. The title clips with an ellipsis before it ever paints on top of the count.
- **In-page anchor click pushes a history entry.** `initInPageAnchorHandler` calls `history.pushState` with the new pathname + hash before scrolling, so the browser back button returns to the fragment-less URL (i.e. the top of the same document) instead of stepping back to the previously selected document. The popstate handler in `src/shell/history.ts` learns to recognize "same pathname, hash changed" and just re-runs `scrollToFragment` (or scrolls the preview to the top when the hash is gone) without re-fetching the document.
- **TOC depth + nested-section scroll target.** The AsciiDoc render call sets `:toclevels: 5` (was: the Asciidoctor default of 2) so the cheat-sheet TOC actually lists `===`-and-below entries — which is the only way the test fixture can exercise a deep-anchor click. The `.preview :is(h1…h6) { scroll-margin-top }` rule is extended to also target the Asciidoctor section wrappers `.preview :is(.sect1, .sect2, .sect3, .sect4, .sect5)[id]`, since Asciidoctor emits the heading id on the wrapper div for `==`-and-deeper sections and `scrollIntoView` aligns the wrapper, not the inner `<h2>`, to the viewport.

## Capabilities

### New Capabilities

None. All four fixes refine existing capabilities.

### Modified Capabilities

- `document-routing`: New requirement — external (non-same-origin) anchors in the rendered preview MUST open in a new browser tab/window so the SPA stays mounted. Modified requirement — the in-page fragment anchor handler MUST push a history entry whose URL carries the new hash, and the popstate handler MUST treat a same-pathname hash change as a scroll-only event (no document reload).
- `document-rendering`: Modified requirement — the AsciiDoc renderer MUST emit table-of-contents entries for at least heading levels 1–5 (`:toclevels: 5`). New requirement — clicking any TOC entry MUST scroll the target heading clear of the sticky preview header regardless of the heading's depth or whether Asciidoctor placed the id on the heading itself or on the surrounding `.sect*` wrapper.
- `sidebar-shell`: Modified requirement — the `Files` pane header MUST render the title and the metadata block (file count, filter chip, actions) without visual overlap at every supported sidebar width.

## Impact

**Code touched**

- `src/render/markdown.ts` — extend `sanitizeSchema.attributes.a` to permit `target` and `rel`; add a post-sanitize pass (or a pre-sanitize hast walk) that sets `target="_blank"` + `rel="noopener noreferrer"` on absolute http(s) anchors whose host differs from `window.location.host` — except the renderer runs on the server, so the host comparison can't be runtime-driven. Instead, mark every `<a>` whose `href` parses as an absolute http(s) URL — the cross-doc handler already lets external-origin clicks fall through, so over-marking same-origin absolute links with `target=_blank` is acceptable only if the same-origin case is unreachable at render time. We'll mark only links whose `href` starts with `http://` or `https://` (a heuristic that captures author-written external links) and let same-origin in-app links continue to use bare or relative hrefs.
- `src/render/asciidoc.ts` — same post-sanitize external-link pass; add `toclevels: 5` to the `attributes` object on the `asciidoctor.load` call.
- `src/render/markdown.test.ts` / `src/render/asciidoc.test.ts` — unit tests for the external-link rewrite (covers `<a href="https://example.com">` → adds `target` + `rel`; covers `<a href="other.adoc">` → untouched).
- `src/preview/anchors.ts` — `initInPageAnchorHandler`: after scroll, push a history entry whose URL is `pathname + search + #fragment`. The fragment is the *already-decoded* id; encoding back into the URL uses `encodeURIComponent` over the id.
- `src/shell/history.ts` — `attachPopstateHandler`: detect the "same pathname, hash changed" case at the top of the handler. If true, run `scrollToFragment(hash.slice(1))` (or scroll the preview body to the top when no hash) and return early. Do NOT disable follow mode for hash-only navigations — that would punish users for using the TOC and is inconsistent with the existing rule that disables follow on document switches.
- `src/styles.css` — broaden the `.preview :is(h1…h6) { scroll-margin-top: 7.5rem }` rule to also cover `.preview :is(.sect1, .sect2, .sect3, .sect4, .sect5)[id]`. The pane-header rule (line ~1245) gains `min-width: 0` allowance on the title via `.pane-header h2 { flex-shrink: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }` and `.pane-meta { gap: 0.5rem; flex-shrink: 0; }` (already partially set) is reaffirmed.
- `testdata/watch-docs/asciidoc-cheatsheet.adoc` — no change to the fixture itself; the `:toclevels: 5` document attribute is set at the renderer level so any AsciiDoc file with `:toc:` gets the deeper TOC automatically. (Authors can still override per-doc.)

**Tests**

- `tests/e2e/asciidoc.e2e.ts` — extend the existing "TOC link click" test (or add a sibling test) to (a) assert the TOC actually contains an `h3`/`h4` entry and (b) click that deeper entry and assert the target heading's `getBoundingClientRect().top` is strictly below the bottom of the sticky `.preview-header` (i.e. the heading is *not* obscured).
- `tests/e2e/asciidoc.e2e.ts` (or new `tests/e2e/in-page-anchor.e2e.ts`) — new test for the in-page anchor history-push: open a TOC link, click an entry, click browser back, assert the URL no longer carries the fragment AND the preview is still showing the same document AND the scroll position is at the top (not on a different document).
- `tests/e2e/links.e2e.ts` (new) or extension of an existing file — assert an external link in a markdown fixture has `target="_blank"` + `rel="noopener noreferrer"` attributes set in the rendered DOM.
- `tests/e2e/sidebar.e2e.ts` — a regression assertion that the Files-pane title's bounding rect doesn't overlap the document-count's bounding rect at the default sidebar width AND at `--sidebar-width: 320px` (the minimum).

**No data migration, no CLI surface change, no server change.** All four fixes are browser-side rendering and event-handling adjustments.

**Out of scope**

- Generalizing the in-page anchor handler to non-fragment internal links (e.g. footnote markers, callout circles). Those are already same-origin clicks handled correctly by the cross-doc handler.
- Adding a "back to top" affordance on the rendered preview. The fixed back-button behavior addresses the reported symptom; an explicit affordance is a separate UX decision.
- Reworking Asciidoctor TOC styling. The cheat sheet's TOC currently renders as a default Asciidoctor-styled nested list; we're only changing depth, not visual structure.
- Rendering "smart" link targets (e.g. only external for some hosts, in-tab for others). The simple http(s) heuristic is enough; users with strong preferences can shift-click to override.
