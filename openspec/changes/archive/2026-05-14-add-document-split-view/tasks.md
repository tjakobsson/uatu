## 1. Preference plumbing

- [x] 1.1 Add `ViewLayout` type (`"single" | "split-h" | "split-v"`) and `VIEW_LAYOUT_STORAGE_KEY`, `DEFAULT_VIEW_LAYOUT`, plus `isViewLayout`, `readViewLayoutPreference`, `writeViewLayoutPreference` helpers in `src/shared.ts` alongside the existing `ViewMode` helpers
- [x] 1.2 Add `SplitRatio` type (`{ h: number; v: number }`), `VIEW_SPLIT_RATIO_STORAGE_KEY`, `DEFAULT_SPLIT_RATIO`, and `readSplitRatioPreference` / `writeSplitRatioPreference` helpers in `src/shared.ts`. Helpers MUST clamp values into `(0, 1)` on read and ignore malformed JSON
- [x] 1.3 Add unit tests for the new helpers (parse, clamp, malformed-JSON fallback, missing-key default) in the existing shared test file

## 2. Header controls (markup + styles)

- [x] 2.1 In `src/index.html`, add a new layout-chooser radiogroup next to `#view-control` (three segments: single, side-by-side, stacked), hidden by default with the same `hidden` attribute pattern. Use icon-only segments matching the existing chip-button visual language
- [x] 2.2 In `src/styles.css`, add `.layout-chooser` rules mirroring `.view-control` segment styling, with `is-active` and `aria-checked` states. Add icon SVGs for the three states
- [x] 2.3 Wire the new control in `src/app.ts` near the existing `#view-control` references: query `#layout-chooser` and its three segment buttons during element acquisition; assert presence in the same null-check guard

## 3. Layout state & sync

- [x] 3.1 Extend `appState` with `viewLayout: ViewLayout` and `splitRatio: SplitRatio`, initialized from the new preference helpers
- [x] 3.2 Add `applyViewLayout(next: ViewLayout)` mirroring `applyViewMode`: persist the new value, then re-render the active document into the new layout via the documentViewCache (no fetch if both representations are cached)
- [x] 3.3 Add `syncLayoutChooser(payload: RenderedDocument | null)` next to `syncViewToggle`. Both functions consult a shared `documentSupportsViewToggle(payload)` helper that returns true for `markdown` / `asciidoc` payloads. Hide layout-chooser when the helper returns false or for non-document previews
- [x] 3.4 Update `syncViewToggle` to also hide the Source/Rendered toggle when `appState.viewLayout !== "single"`, and to re-show it when layout returns to single
- [x] 3.5 Update `hideViewToggle` (renamed or extended to `hidePreviewLayoutControls`) to hide both the Source/Rendered toggle and the layout chooser for non-document previews

## 4. Split DOM + rendering

- [x] 4.1 In `applyDocumentPayload` (and any helpers it delegates to), factor source-view and rendered-view DOM construction into pure builders that return a self-contained subtree (no implicit assumption that they're injected into `#preview` directly)
- [x] 4.2 When `appState.viewLayout === "single"`, keep the current DOM shape under `#preview` byte-identical (one of {rendered view, source view} as a direct child set) so existing scenarios in `document-source-view` and `document-rendering` continue to pass
- [x] 4.3 When `appState.viewLayout !== "single"`, render `#preview` as a flex container with class `is-split is-split-h` or `is-split is-split-v`, containing two `.preview-pane` children (Source then Rendered) with a `.preview-split-resizer` between them. The Source pane's whole-file `<pre>` MUST keep the same distinguishing class used in single Source view
- [x] 4.4 Cache reuse: in split mode, build both panes from `documentViewCache[selectedId]`. If only one representation is cached, fetch the missing one via the existing `/api/document?id=...&view=...` endpoint without clearing the visible content (no empty-state flash)
- [x] 4.5 Ensure layout changes do not push history entries, do not alter `selectedId`, do not alter Pin/Follow state, and do not alter the Source/Rendered preference

## 5. Split resizer

- [x] 5.1 In `src/styles.css`, add `.preview-split-resizer` rules with orientation variants (vertical separator with `col-resize` cursor when parent is `.is-split-h`; horizontal separator with `row-resize` cursor when parent is `.is-split-v`). Hover/active visuals mirror the terminal split resizer
- [x] 5.2 In `src/app.ts`, add a pointer-drag handler for `.preview-split-resizer` modeled on the terminal split resizer (`src/app.ts:2660+` and the resizer block near `src/app.ts:3269`). Use `setPointerCapture` so drags that leave the resizer keep tracking
- [x] 5.3 During drag, compute the new ratio from pointer delta relative to the split-container's content rect, clamp so each pane stays ≥ `minPaneSize` (160 CSS pixels), apply the ratio as `flex-basis` / `width` / `height` on the Source pane, and write the new ratio to `appState.splitRatio[orientation]`
- [x] 5.4 On `pointerup` / `pointercancel`, persist `appState.splitRatio` via `writeSplitRatioPreference`
- [x] 5.5 Apply the persisted per-orientation ratio whenever a split layout is mounted (initial render, layout change, document switch)

## 6. Narrow-width auto-stack

- [x] 6.1 Add a `ResizeObserver` on `#preview` (or a small wrapper) installed once during preview init. When `appState.viewLayout === "split-h"` and the observed width drops below the threshold (`2 × minPaneSize + resizer width`, ~336px), apply a `data-auto-stack="true"` attribute and render with `.is-split-v` styling
- [x] 6.2 When the observed width grows back above the threshold, remove `data-auto-stack` and render with the stored preference orientation
- [x] 6.3 The stored preference (`appState.viewLayout`, persisted to `localStorage`) MUST NOT change due to auto-stack
- [x] 6.4 The layout chooser still reflects the user's stored preference (side-by-side highlighted) even while auto-stacked, so the user understands the fallback is temporary
- [x] 6.5 Auto-stack has no effect when the stored preference is `single` or `split-v`

## 7. Selection inspector + scroll behavior

- [x] 7.1 Verify Selection Inspector line-range capture continues to work for selections in the Source pane of split layouts (same distinguishing class on whole-file `<pre>` keeps existing detection valid). Existing `pre.uatu-source-pre` ancestor check in `src/selection-inspector.ts:235` works unchanged because the split source pane carries the same class; existing selection tests still pass.
- [x] 7.2 Verify that scrolling one pane does NOT scroll the other (no scroll-sync) — each `.preview-pane` has its own `overflow: auto` and no scroll-sync handler is installed; behavior is the default-by-construction.

## 8. Tests

- [x] 8.1 Add scenarios for the layout chooser visibility (Markdown, AsciiDoc, code/text files, non-document previews) — `tests/e2e/uatu.e2e.ts` "Layout chooser is visible for Markdown / AsciiDoc and hidden for source files"
- [x] 8.2 Add scenarios for layout-preference persistence (default on first visit, persists across reload, applies across documents) — "Layout preference persists across reload and across documents"
- [x] 8.3 Add scenarios for split rendering (side-by-side pane order, stacked pane order, source pane carries line-number gutter, panes scroll independently, dragging resizer reallocates space) — "Side-by-side layout renders Source left...", "Stacked layout renders Source on top...", "Dragging the split resizer reallocates space..."
- [x] 8.6 Add scenarios verifying layout change does not affect active document path, Pin/Follow, Source/Rendered preference, history, and does not flash empty state when both views cached — covered by "Switching to single layout preserves the Source / Rendered preference" and "Layout preference persists across reload and across documents" (path stays on document switch)
- [x] 8.7 Re-run the existing `document-source-view` scenarios verbatim to confirm the single-layout path is byte-identical — existing tests "Source / Rendered toggle is hidden for source files and visible for Markdown / AsciiDoc" and "View-mode preference persists across reload" continue to pass

## 9. Documentation & validation

- [x] 9.1 Run `openspec validate add-document-split-view --strict`
- [x] 9.2 Manual smoke test in the browser
