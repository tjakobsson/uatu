## Context

Four small bugs in the rendered-preview surface all trace back to assumptions that hold *most* of the time but quietly fail at the edges:

1. **External links nuke the SPA.** The cross-document anchor handler at `src/preview/anchors.ts:127` deliberately returns for non-same-origin clicks ("respect external URLs"). The browser then resolves the click natively — and because the rendered anchor has no `target` attribute, "natively" means a same-tab navigation that unloads uatu. The user's review session evaporates; recovery requires the back button and a re-load of the workspace state.

2. **Files-pane title overlaps the count.** `src/index.html:147-180` builds the pane header as a flexbox: `<h2>Files</h2>` on the left, `<div class="pane-meta">` (count + filter chip) on the right, then `<div class="pane-actions">` (collapse + hide). The h2 has `min-width: 0` (so it can shrink) but no `text-overflow: ellipsis`, so when the meta-and-actions block grows wider than the available space the h2 doesn't clip — it just paints into the same coordinate space, leaving the "F" of "Files" overlapping the "5" of "5 files · 5 binary" (per the user's screenshot). The visual artifact shows up at typical sidebar widths whenever the workspace has a large file count + the `All`/`Changed` chip + the collapse/hide buttons all present.

3. **TOC back-button goes to wrong place.** `initInPageAnchorHandler` at `src/preview/anchors.ts:31-71` intercepts `<a href="#x">` clicks, calls `event.preventDefault()`, and `scrollIntoView`s — but never touches `history`. The URL stays at the fragment-less pathname; the user's previous navigation entry (probably another document) is still the top of the back stack. Pressing back jumps the user to that other document rather than scrolling back up. This is asymmetric with the *standard* browser anchor behavior, which writes the hash into the URL and creates a history entry per click.

4. **Deep TOC entries scroll under the sticky header.** The `.preview :is(h1…h6) { scroll-margin-top: 7.5rem }` rule at `src/styles.css:2144` exists exactly to clear the sticky preview header. It works for `<h2>` because Asciidoctor renders top-level sections as `<div class="sect1" id="_..."><h2>…</h2><div class="sectionbody">…</div></div>` — the id is on the *wrapper*. `scrollIntoView` then aligns the wrapper's top edge to the viewport top, the wrapper has no scroll-margin, and the h2 sits two CSS pixels lower — totally hidden behind the frosted-glass band of the sticky header. The user can't reproduce this in tests today because `:toclevels` defaults to 2 in Asciidoctor (only `==` headings make it into the TOC), so all TOC entries land on `.sect1` wrappers — but `.sect1` *does* often have an id, and the same wrapper-id problem exists.

The four fixes are small and local, but worth bundling: they all live in the rendered-preview + sidebar surface, they all benefit from one round of e2e regression coverage, and they share the theme "in-app navigation matches user expectations."

## Goals / Non-Goals

**Goals:**

- Clicking an external link in a rendered preview opens a new browser tab/window. The uatu SPA stays mounted.
- The Files-pane header renders without visual overlap at every supported sidebar width (320px–620px and beyond).
- Clicking a TOC entry inside a document and then pressing browser back returns the user to the previous *scroll state* of that same document, not to a different document.
- Clicking a TOC entry at any depth (h1–h5) scrolls the target heading clear of the sticky preview header — the heading reads cleanly, not behind the frost.
- E2E regression coverage exists for each of the four behaviors.

**Non-Goals:**

- A "back to top" button or any other new affordance on the preview.
- Reworking Asciidoctor's TOC visual style. We change depth, not layout.
- Replacing the in-page anchor handler with native browser anchor behavior. The handler exists for a reason — see Decision 3.
- Hardening the rest of the sidebar against narrow widths. Other pane headers may have similar overlap potential but the user's bug report is specifically about the Files pane; we scope the fix accordingly.
- Smart per-host link targeting (e.g. "open same-origin in the same tab"). The cross-doc handler already covers same-origin links — they never reach the rewrite path.

## Decisions

### Decision 1: Mark external links at render time, not at click time

Two natural approaches:

- **(A)** Post-render hast walk that sets `target="_blank"` + `rel="noopener noreferrer"` on every `<a>` whose `href` parses as an absolute http(s) URL. Sanitize schema is extended to permit those attributes.
- **(B)** Intercept external clicks in the cross-document anchor handler and call `window.open(url, '_blank', 'noopener,noreferrer')` instead of falling through.

**Chosen: (A).** Render-time rewriting covers more click vectors than click interception: middle-click "open in new tab" already opens externals in a new tab via the browser's normal rules, but the *expectation* the user reports is also reflected by hover preview, drag-to-bookmark, copy-link-address, and any other anchor-touching gesture — all of which see the `target` attribute. Render-time rewrite is also the documented sanitize pattern for trustable enrichment of foreign HTML. The cost is the sanitize schema extension and one extra hast pass — both small.

The host-comparison heuristic: at render time we don't know `window.location.host` (the renderer runs in the server's Bun process). We use a structural heuristic instead: an anchor is "external" iff its `href` parses with a `protocol` of `http:` or `https:` (i.e. it's an absolute URL). Same-origin internal anchors in our rendered output are always relative (`other.adoc`, `guides/setup.md`, `#section`) — authors writing `http://localhost:4711/foo.md` would be over-marked as external, but that's a path of vanishing real-world traffic and the consequence (opens in a new tab) is not destructive.

Markdown and AsciiDoc both go through the same hast pipeline after their respective parsers run (`fromHtml` → `sanitize` → `toHtml`). The external-link rewrite is added as a hast pass between `sanitize` and `toHtml` — implemented once, shared between both renderers via a helper in `src/render/`.

### Decision 2: Files-pane header — clip the title, don't break the layout

Three options:

- **(A)** Add `text-overflow: ellipsis; overflow: hidden; white-space: nowrap` to `.pane-header h2`. The title clips to "F..." or "" at narrow widths; the meta + actions stay legible.
- **(B)** Wrap the header in two rows (title on top, meta below) when the viewport gets narrow. CSS-only via `flex-wrap`.
- **(C)** Hide the title entirely below some threshold; rely on the `Files` pane's distinct visual context for identification.

**Chosen: (A).** The title is the lowest-information item in the header — at a glance the file tree below is unmistakably the Files pane, and the count + filter chip carry the time-varying information the user actually needs to read. Clipping the title with an ellipsis is the conventional flex pattern. (B) doubles the header height at narrow widths, eating into the tree area. (C) breaks accessibility (no labeled landmark in the AX tree) and surprises sighted users on first reveal.

Additional small CSS adjustments:

- `.pane-header { gap: 0.5rem; }` is already set — preserved.
- `.pane-meta { flex-shrink: 0; }` is already set — preserved.
- `.pane-actions { flex-shrink: 0; }` is already set — preserved.
- The new clipping rules live on `.pane-header h2` so they apply to every pane header (Change Overview, Files, Git Log) uniformly. We don't scope to `.sidebar-pane[data-pane-id="files"]`, since the same overlap is latent in any pane header whose meta block could grow.

### Decision 3: In-page anchor — push the hash, scroll, intercept the popstate

The naive fix is "stop preventing default — let the browser write the hash and create the history entry." That breaks the existing reason for the handler: per-document `<base href>` is set to the document's directory so relative image URLs work, which means a bare `<a href="#x">` resolves to `/<dir>/#x` and triggers a full-page navigation to the static fallback's 404 (the very same case `tests/e2e/asciidoc.e2e.ts:84` regression-tests). We MUST keep `preventDefault()` and the scroll, but ALSO push a history entry that records the new hash.

Chosen flow inside `initInPageAnchorHandler`:

1. `event.preventDefault()` — already there, keep it.
2. `scrollIntoView` — already there, keep it.
3. `const newUrl = window.location.pathname + window.location.search + "#" + encodeURIComponent(id);` — build the destination URL preserving any query string.
4. `if (newUrl !== window.location.pathname + window.location.search + window.location.hash) window.history.pushState(null, "", newUrl);` — only push when the URL actually changes (re-clicking the same TOC entry must not grow the back stack).
5. We do NOT update `history.state` with a special marker; the popstate handler infers "hash-only change" from the pathname comparison alone.

The popstate handler at `src/shell/history.ts:124` learns one new branch at the top:

```ts
const currentPath = decodeURIComponent(window.location.pathname).replace(/^\/+/, "");
const activePath = activeRelativePath();  // looked up from appState.selectedId
if (currentPath === activePath) {
  // hash-only navigation — scroll, don't reload
  if (window.location.hash) {
    scrollToFragment(window.location.hash.slice(1));
  } else {
    previewElement.scrollTo({ top: 0, behavior: "smooth" });
  }
  return;
}
// fall through to existing document-resolution logic
```

This branch lands *before* the follow-mode disable, so hash-only navigations don't punish the user for using the TOC. The existing rule "back button disables follow" is preserved for actual document navigations.

The "activePath" lookup needs `findDocumentById(appState.selectedId).relativePath`; that helper already exists. When `selectedId` is null (e.g. commit preview is active), the hash-only branch is skipped and we fall through to the existing logic — correct, because in those preview modes the URL pathname is `/` and fragment navigation isn't a normal flow.

Alternatives considered:

- **(A)** Use `history.replaceState` instead of `pushState`. Would not create a back-stack entry, defeating the purpose.
- **(B)** Let the browser handle it (remove `preventDefault`). Re-introduces the `<base href>` 404 bug.
- **(C)** Use the `hashchange` event instead of `popstate` for the scroll-on-back behavior. `hashchange` doesn't fire for same-hash + back, and the popstate handler already runs for back navigations — adding another listener would mean both fire in some browsers. Single source of truth wins.

### Decision 4: Scroll-margin on the wrapper, not the heading

Asciidoctor's section-id placement is the load-bearing fact:

- Doctitle: id on `<h1>` directly.
- `== Section` (level 1): `<div class="sect1" id="_section"><h2>Section</h2>…</div>` — id on wrapper.
- `=== Subsection` (level 2): `<div class="sect2" id="_subsection"><h3>Subsection</h3>…</div>` — id on wrapper.
- ... down to `.sect5`.

`scrollIntoView` aligns the element-with-the-id, so for everything below `h1` we're aligning the wrapper. Two ways to fix:

- **(A)** Add scroll-margin to the wrapper selectors: `.preview :is(.sect1, .sect2, .sect3, .sect4, .sect5)[id] { scroll-margin-top: 7.5rem; }`. The existing `.preview :is(h1…h6)` rule stays as the doctitle / markdown-heading case.
- **(B)** Rewrite Asciidoctor's output to hoist the id from the wrapper to the heading. A post-render hast pass would do it but breaks any CSS that targets the wrapper-id (e.g. `:target` styling).
- **(C)** In `initInPageAnchorHandler`, manually compute a scroll position that accounts for the sticky header instead of relying on CSS scroll-margin. Works but moves a CSS concern into JS, and any future Markdown / Mermaid anchor target would need the same JS path.

**Chosen: (A).** Smallest, declarative, lives at the same site as the existing rule. The list of sect classes is bounded (Asciidoctor only emits sect1-sect5; sect0 is reserved for the doctitle which is on the h1 directly).

### Decision 5: `:toclevels: 5` is set at the renderer, not per-document

Three options:

- **(A)** Set `toclevels: 5` on the `asciidoctor.load` `attributes` object. Affects every AsciiDoc file rendered through uatu. Document authors can override with their own `:toclevels: N` at the top of a file.
- **(B)** Add `:toclevels: 5` to the test-fixture cheat sheet only.
- **(C)** Detect "deep document" and conditionally raise toclevels.

**Chosen: (A).** uatu is a documentation preview tool — readers expect a full TOC when one is requested. Asciidoctor's default of 2 is a compromise for printed-book output; in a scrollable web preview, depth-5 is the norm (GitHub renders TOC blocks at full available depth too). The fixture-only fix (B) would mean the test doesn't represent typical user experience. (C) adds magic that's hard to reason about.

Asciidoctor's per-attribute precedence: a document's own `:toclevels: N` header attribute overrides our default. That preserves authoring control.

### Decision 6: Test the visual-overlap and scroll-clearance bugs by geometry, not by snapshot

E2E pixel-snapshot tests are flaky. Instead:

- **Files-pane overlap test:** assert `titleRect.right + gap_min <= countRect.left` where `gap_min = 4px` (slightly looser than the 8px CSS gap to allow sub-pixel rounding). This catches overlap (`.right > .left`) without locking in exact widths. Run at two sidebar widths: the default and the minimum (`320px`).
- **TOC scroll-clearance test:** after clicking a deep TOC entry, assert `headingRect.top >= stickyHeaderRect.bottom - 2px`. The 2px tolerance accommodates subpixel rendering. This catches the user-reported bug — heading hidden behind the frost — without coupling to the exact 7.5rem value.

Both assertions are robust to future style tweaks: they enforce the invariant ("title and count don't overlap"; "heading clears the sticky header") rather than the implementation detail.

## Risks / Trade-offs

- **Risk:** External-link rewrite over-marks same-origin absolute URLs (an author writing `http://localhost:4711/foo`) as external.
  **Mitigation:** Such URLs are rare in real-world docs (relative paths are the convention). The cost of over-marking is "opens in new tab" — a much smaller surprise than the current bug ("uatu session lost"). Documented as an acceptable trade-off.

- **Risk:** Files-pane title clipping with ellipsis hides the word "Files" entirely at very narrow widths.
  **Mitigation:** At the sidebar minimum (320px) the title currently has ~80px of space before the meta block begins — plenty for "Files". The clipping kicks in only when the meta + actions grow large (high file counts). Even then, the `Files` pane is visually distinguishable by its tree contents below.

- **Risk:** In-page anchor history-push pollutes the back stack with every TOC click.
  **Mitigation:** This is exactly the conventional browser behavior — every fragment navigation in a normal browser creates a history entry. Users who don't want it can shift-click (caught by the modifier-key guard which we keep). The de-dup guard ("don't push if URL already matches") prevents grown stacks from re-clicks on the active entry.

- **Risk:** The popstate hash-only branch could be confused by query-string changes (review-score, commit-preview) and skip the document reload in those cases.
  **Mitigation:** The branch compares `decodeURIComponent(pathname).replace(/^\/+/, "")` to `findDocumentById(selectedId).relativePath`. When the URL has changed to a review-score query (`/?reviewScore=...`), the pathname is `/`, which doesn't match the active document's relative path — so the branch is skipped and the existing review-score and commit-preview branches handle it. We also explicitly check `appState.selectedId` is non-null before computing `activePath`; when it's null the branch falls through unconditionally.

- **Trade-off:** Setting `:toclevels: 5` makes TOCs longer for some docs. Authors who want a shorter TOC can set `:toclevels: 2` (or `:toclevels: 3`) in their document's header. This is the same opt-out path Asciidoctor already documents.

- **Trade-off:** The wrapper-scroll-margin fix adds five class names to a CSS selector that previously only listed six element names. Trivial.
