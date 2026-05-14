## Context

The preview pane in `src/app.ts` already supports two view modes for documents with a non-trivial rendered representation (Markdown, AsciiDoc):

- **Rendered**: parses the source through markdown-it / Asciidoctor and emits sanitized HTML into `#preview`.
- **Source**: emits the file's raw text as a single `<pre><code>` with the existing line-number gutter (`attachLineNumbers` at `src/app.ts:1393`).

The user's choice is a single global preference (`VIEW_MODE_STORAGE_KEY = "uatu:view-mode"` in `src/shared.ts:219`), persisted to `localStorage`, defaulting to `rendered`. The header exposes a two-segment toggle (`#view-control` in `src/index.html:276`, sync logic at `src/app.ts:2324`). The toggle is hidden for non-document previews and for code/text files whose source = rendered.

Switching is instantaneous because `documentViewCache` (`src/app.ts:2357`) keeps both rendered and source payloads warm per document; `applyDocumentPayload` re-uses the cached payload instead of refetching.

This change layers a **split layout** on top of that machinery: showing both representations side-by-side or stacked, with a draggable resizer between them, while leaving the single-view path unchanged.

The codebase already has two distinct resizer patterns to draw from:
- The **sidebar pane resizer** at `src/app.ts:1876` (`[data-pane-resizer]`), a vertical pointer-drag handle that locks adjacent pane heights and persists via `persistPaneState`.
- The **terminal pane resizer** at `src/app.ts:2656+`, which supports both horizontal-and-vertical orientation depending on the terminal dock position.

Either is reusable as a model; the new split needs orientation-switchable drag like the terminal version.

## Goals / Non-Goals

**Goals:**
- Let users see Source and Rendered side-by-side or stacked for Markdown and AsciiDoc documents.
- Switch between layouts via a single header control with three states: single / side-by-side / stacked.
- Provide a draggable resizer between the two panes with per-orientation ratio persistence.
- Reuse the existing rendering pipeline and `documentViewCache` — split must not double-fetch or re-render unnecessarily.
- Keep the single-view path byte-identical in DOM output, so existing scenarios in `document-source-view` and `document-rendering` continue to pass unchanged.
- Auto-stack when the preview pane is too narrow for side-by-side to be readable, without overwriting the user's preference.

**Non-Goals:**
- **Scroll synchronization** between panes. Each pane scrolls independently. (Explicitly deferred — likely a follow-up change.)
- **Per-document** layout preferences. Layout is global, same as the existing Source/Rendered preference.
- **More than two panes** (e.g., source + rendered + preview-of-something-else). Two only.
- Layout chooser for files where source = rendered. Hidden, same as the existing toggle.
- Changes to the rendering pipeline, sanitizer, syntax highlighting, or selection inspector beyond what's needed to host two panes side-by-side.
- A keyboard shortcut for layout switching. (Could be added later; not in scope.)

## Decisions

### 1. Layout chooser is a separate three-icon control next to the existing toggle

The header gains a new control group, a three-segment radio (`single` / `split-h` / `split-v`), sibling to the existing `#view-control`. The existing Source/Rendered toggle is kept verbatim and is **hidden** when layout ≠ `single` (both views are visible, so the toggle has no meaning in split).

**Alternatives considered:**
- *Three-segment toggle replacing the existing one (Source / Rendered / Split)*: bundles orientation into a sub-control. Rejected — collapses orthogonal concerns into one widget and complicates the spec delta (existing requirements assume two-segment).
- *Split on/off icon next to existing toggle, with toggle picking "focused" pane in split*: rejected — "which pane is focused in split" is a weird UX question and existing toggle becomes ambiguous.

The separate-control approach also keeps the spec delta cleaner: existing requirements about the Source/Rendered toggle remain word-for-word valid (extended only by an additional requirement that it's hidden in split layouts).

### 2. Persistence: two new localStorage keys, separate from `viewMode`

- `uatu:view-layout` → `"single" | "split-h" | "split-v"`, default `"single"`.
- `uatu:view-split-ratio` → JSON object `{ "h": number, "v": number }` with each value in `(0, 1)`. Default `{ h: 0.5, v: 0.5 }`. Ratio is **source-pane fraction** of the available split-container size on that axis.
- Existing `uatu:view-mode` stays untouched.

Helper functions live alongside `readViewModePreference` in `src/shared.ts` (`readViewLayoutPreference`, `writeViewLayoutPreference`, `readSplitRatioPreference`, `writeSplitRatioPreference`) — same pattern as the existing helpers, including the `try/catch` around `localStorage` access.

**Alternatives considered:**
- *Single combined key `uatu:view-state` as JSON*: rejected — three independent values shouldn't share a key; partial updates become read-modify-write and the existing `viewMode` key can't be cleanly subsumed without a migration.
- *Per-orientation single ratio*: rejected — flipping side-by-side ↔ stacked feels jarring when the same numeric ratio means different things (50% of width vs 50% of height). Storing per orientation lets users dial in each independently.

### 3. DOM shape: the existing `#preview` article becomes the split container

In single layout, the existing `<article id="preview">` is the body container, as today. In split layout, the same `#preview` element becomes a flex container with **two child panes** plus a draggable separator between them:

```html
<article id="preview" class="preview ... is-split is-split-h">
  <div class="preview-pane preview-pane-source" data-split-side="source">
    <!-- rendered identically to current source view -->
  </div>
  <div class="preview-split-resizer" role="separator" aria-orientation="vertical"></div>
  <div class="preview-pane preview-pane-rendered" data-split-side="rendered">
    <!-- rendered identically to current rendered view -->
  </div>
</article>
```

The Source pane carries the same whole-file distinguishing class on its `<pre>` that single Source view uses today, so Selection Inspector detection logic continues to work.

**Alternative considered:** introduce a new wrapper element around `#preview`. Rejected — adds a layer and forces every existing DOM query that targets `#preview` to be revisited.

### 4. Source pane in split mode reuses the single-view source render — no duplicate code paths

The current `applyDocumentPayload` builds either the source HTML or the rendered HTML depending on `viewMode`. In split mode it builds **both** (the cached payloads from `documentViewCache` make this free), then injects them into the two panes. The shared rendering helpers (`buildSourceView`, `buildRenderedView`, or equivalent — current call sites are inside `applyDocumentPayload`) are refactored if necessary so each returns a self-contained subtree that can target either `#preview` directly (single) or `.preview-pane-*` (split).

Cache misses still work: if only one representation is warm and the layout flips to split, the missing one is fetched (single round-trip), just like today's `applyViewMode` fallback. Both are then cached.

### 5. Resizer: model on the terminal split resizer, not the sidebar one

The terminal split resizer (`src/app.ts:2660+`) already supports orientation switching (`data-orientation="horizontal" | "vertical"`) and locks adjacent pane sizes during drag. The new preview-split resizer is the same pattern, scoped to the preview body. It:

- Uses `setPointerCapture` so a drag that leaves the resizer keeps tracking (matches the existing pattern at `src/app.ts:3276`).
- Translates pointer delta to a new ratio in `(0, 1)`, applies it as flex-basis (or width/height) on the source pane, writes the ratio to the preference, and clamps so each pane retains at least `minPaneSize` pixels (proposed: 160px).
- Cursor + `aria-orientation` flips with the layout (`col-resize` / `vertical` in `split-h`, `row-resize` / `horizontal` in `split-v`).

### 6. Narrow-width auto-stack

A `ResizeObserver` on `#preview` watches the available width. If the user's preference is `split-h` and the observed width drops below the side-by-side threshold (proposed: `2 * minPaneSize + resizer = 320px + a few`), the rendered layout class is forced to `split-v` while keeping the stored preference unchanged. When width grows back over the threshold, the preference is honored again.

**Alternative considered:** CSS-only via `container queries`. Rejected — container queries don't help the resizer (its drag math needs to know which axis it's on) and the JS path is needed for the persistence-preserving behavior. CSS still handles the resulting flex-direction once the class is set.

### 7. Cache reuse, no document refetch on layout change

Toggling the layout chooser:
- If `documentViewCache[selectedId]` has both `source` and `rendered`, apply directly — no fetch, no "Document unavailable" flash. Same instantaneous feel as Source/Rendered toggle today.
- If only one is cached, fetch the missing one via the existing `/api/document?id=...&view=...` endpoint, then apply.
- Layout change MUST NOT push a history entry, MUST NOT change `selectedId`, MUST NOT alter Pin/Follow state. (Mirrors the existing "Toggling view does not change the active document" requirement.)

### 8. Hide layout chooser everywhere the Source/Rendered toggle is hidden today

Single source of truth: a small helper `documentSupportsViewToggle(payload)` returns `payload.kind === "markdown" || payload.kind === "asciidoc"`. Both `#view-control` and the new layout chooser bind to this. For non-document previews (commit, review-score, empty) both controls are hidden via `hideViewToggle` (which gets a renamed or sibling `hideLayoutChooser`).

## Risks / Trade-offs

- **No scroll sync feels wrong to users familiar with VS Code / Obsidian** → mitigated by being a deliberate, documented first-cut. Spec scenario captures it explicitly so it's not silently "TBD". Follow-up change is teed up for proportional or anchor sync.
- **Side-by-side at narrow widths is unreadable** → mitigated by auto-stack fallback at the `ResizeObserver` threshold, without overwriting preference.
- **Split rendering doubles the rendered-HTML cost on first open** → mitigated by `documentViewCache`: subsequent layout flips and document switches reuse cached payloads. First open in `split` from cold cache fetches both views (one parallel request). Acceptable cost.
- **Selection Inspector behavior in split** → the source pane carries the same whole-file `<pre>` class that single Source view uses, so line-range capture from selections inside that pane works unchanged. Selections in the rendered pane behave like Rendered (no line capture), which matches existing single-view semantics.
- **Markdown/AsciiDoc anchor links (TOC, `<<xref>>`) inside the rendered pane** → these resolve within the rendered pane's scope. In stacked layout they scroll the rendered pane; the source pane is unaffected. No behavior change beyond pane scoping.
- **DOM-query churn**: any code currently treating `#preview` as a content container that walks children may need an adjustment when it's a flex container with two panes. Audit before implementation. Mitigation: keep the single-view DOM shape unchanged (one element of children under `#preview`) so most queries continue to work without modification.
- **Header real estate**: adding a second control next to Source/Rendered tightens the preview header. Mitigation: icon-only layout chooser (segmented `▮ ⫼ ⊟` icons), no text labels, matching the visual weight of existing chip controls.

## Migration Plan

No data migration is needed — the new `localStorage` keys default cleanly on first read, and the existing `uatu:view-mode` key is untouched.

Rollout is a single change. There is no rollback concern: removing the new control degrades gracefully to today's behavior (single layout, existing toggle) because layout-related code paths are additive on top of existing render paths.

## Open Questions

- **Exact pixel threshold for auto-stack.** Proposal uses 320px+ as a starting point; settle on the empirical number during implementation by trying common sidebar+terminal configurations.
- **Minimum pane size during drag.** Proposal uses 160px; revisit if the source pane's line-number gutter pushes a usable minimum higher.
- **Icon glyphs for the layout chooser.** Current proposal uses three SVG glyphs (single rect, vertical split, horizontal split) matching the existing `chip-button` visual language. Final glyphs can be refined during implementation; spec only requires the three-state semantics.
