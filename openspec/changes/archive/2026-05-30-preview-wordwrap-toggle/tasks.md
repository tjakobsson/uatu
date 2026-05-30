## 1. Shared Wrap preference + toggle

- [x] 1.1 Add a `wrap` boolean to `appState` in `src/shell/state.ts`, mirroring how `diffStyle` is modeled
- [x] 1.2 Add `localStorage` read/write for the wrap preference (standalone key, e.g. `uatu:preview-wrap`, default `false`), alongside the existing preference storage helpers
- [x] 1.3 Add the Wrap toggle to the preview toolbar in `src/index.html` as a single pressed-state button (`aria-pressed`), matching the toolbar's control vocabulary
- [x] 1.4 Style the Wrap toggle in `src/styles.css` using the existing toolbar/segmented-control primitive
- [x] 1.5 Wire the toggle in `src/preview/view-mode.ts`: persist on click, apply in place, and show/hide it per active view (hidden in Rendered) via the same mechanism that hides unsupported view segments
- [x] 1.6 Ensure toggling re-applies to the already-loaded view with no fetch and no empty-preview flash

## 2. Diff view wrap (cheap half — no spike dependency)

- [x] 2.1 Pass `overflow: appState.wrap ? 'wrap' : 'scroll'` to the `FileDiff` constructor in `src/preview/diff-view.ts`
- [x] 2.2 Re-render the active diff in place from the cached payload when the wrap preference changes (reuse the Unified/Split re-render flow; no network round-trip)
- [x] 2.3 Confirm fallback paths (state-card, lightweight large-diff) tolerate the preference without error

## 3. Source-render perf spike (gate for section 4)

- [x] 3.1 Record the pass criteria in `design.md` before measuring (first-paint margin vs hljs, >50 fps + bounded DOM nodes on the 20k-line fixture)
- [x] 3.2 Build a throwaway harness under `tests/` that renders identical fixtures with (a) the current highlight.js source renderer and (b) Pierre's virtualized code viewer (`CodeView`/`VirtualizedFile`), both without wrap
- [x] 3.3 Provide fixtures across the size curve (~100 / ~2k / ~20k lines / near the 1 MB highlight cap) × a light grammar (json/txt) and a heavy grammar (tsx)
- [x] 3.4 Capture metrics: time-to-first-paint (`performance.mark`/`measure`), cold-vs-warm, DOM node count, scroll FPS / long-tasks on the 20k fixture
- [x] 3.5 Phase 2 — if Pierre passes the unwrapped baseline, measure Pierre with `overflow: 'wrap'` on the large fixtures (variable-height virtualization stress)
- [x] 3.6 Record the outcome and the decision (B-homegrown vs B-pierre) in `design.md`

## 4. Source view wrap — **B-homegrown** (selected by the §3 spike)

> Spike outcome (design.md Decision 4): keep highlight.js for the source
> view and build the per-line gutter ourselves. Pierre's `CodeView` was
> ~4× slower to first paint on heavy grammars (≈940 ms on a 9k-line TSX
> file) because it tokenizes the whole file via shiki; virtualization
> bounds rendering, not tokenization. So the Pierre path (4.6) is dropped.
>
> Note: sections 1–2 shipped the shared toggle + preference and wired Diff
> wrap. The toggle's visibility is currently scoped to Diff via
> `WRAP_SUPPORTING_VIEWS` in `src/preview/view-mode.ts`. When source wrap
> lands, add `"source"` to that set and extend `applyWrap` to re-apply to
> the source representation.

- [x] 4.0 Add `"source"` to `WRAP_SUPPORTING_VIEWS` and extend `applyWrap` to re-apply source wrap in place
- [x] 4.1 Restructure the source code block + line-number gutter into a per-line CSS-grid layout (`auto 1fr`, `align-items: start`, `.ln` `user-select: none`) so a number can top-align to a multi-row wrapped line
- [x] 4.2 Split highlight.js output into per-line elements, reopening spans that cross newlines; unit-test on a fixture with a multi-line token (block comment / template string)
- [x] 4.3 Apply wrap CSS keyed off the preference: unwrapped = `white-space: pre` + horizontal scroll (unchanged); wrapped = `pre-wrap` + `overflow-wrap: anywhere`, continuation rows blank, numbers truthful
- [x] 4.4 Update copy-to-clipboard to gather per-line code text joined by `\n` (no line numbers, real newlines preserved, none inserted at soft-wrap points)
- [x] 4.5 Preserve the whole-file source distinguishing class so the Selection Inspector still identifies the source block
- [x] 4.6 ~~(Pierre path) Re-validate … Shadow DOM~~ — N/A: spike selected B-homegrown, source stays in light DOM

## 5. Tests

- [x] 5.1 Unit test: wrap preference persists to/from storage and defaults off
- [x] 5.2 Unit test (homegrown path): per-line split preserves multi-line tokens and copied text excludes line numbers
- [x] 5.3 E2E (`tests/e2e/`): Wrap toggle visible in Source and Diff, hidden in Rendered; persists across reload; single preference spans both views
- [x] 5.4 E2E: Source wrap keeps line numbers truthful (wrapped line keeps its number, continuation rows blank, next number aligned)
- [x] 5.5 E2E: Diff wrap on/off changes wrapping and re-renders in place with no new fetch

## 6. Validation & docs

- [x] 6.1 `openspec validate preview-wordwrap-toggle --strict` passes
- [x] 6.2 Update `ARCHITECTURE.md` if the source-render path changed (especially if B-pierre adopted)
- [x] 6.3 Run `bun test` and `bun test:e2e`; verify no regression to unwrapped scroll behavior
