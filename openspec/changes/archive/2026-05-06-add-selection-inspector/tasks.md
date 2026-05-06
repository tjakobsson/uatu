<!-- All tasks reset to unchecked. The branch already contains a prior implementation
     of the OLD design (text-dump pane, no toggle, no click-to-copy). That code
     produces reusable scaffolding (Review-only pane registration, Author-mode
     hidden behavior, selectionchange listener pattern, document-swap recompute
     hook, persistence wiring, the sidebar pane DOM section, the per-pane CSS
     skeleton) but the captured shape, the pane render, the unit tests, and most
     of the e2e tests need to be redone against this updated design. The
     implementer should treat the prior code as scaffolding to refactor, not
     as completed work. -->

## 1. View-mode state and persistence

- [x] 1.1 Add a `Mode`-style `ViewMode` type (`"source" | "rendered"`) plus `readViewModePreference` / `writeViewModePreference` helpers using a `uatu:view-mode` key, defaulting to `"rendered"`. Place alongside the existing Mode helpers (likely `src/shared.ts`).
- [x] 1.2 Add `viewMode: ViewMode` to `appState` in `src/app.ts`, initialized from `readViewModePreference()` at boot, mutated when the toggle changes, persisted on every change.
- [x] 1.3 Add a small per-document client-side cache (e.g., `Map<documentId, { source?: payload; rendered?: payload }>`) so toggling between Source and Rendered for an already-loaded document does not refetch. Drop a doc's cache entry when the user navigates away from it.

## 2. Source / Rendered toggle UI

- [x] 2.1 Add a two-segment Source / Rendered control to the preview header in `src/index.html`, mirroring the structure of the existing `#mode-control`. Give each segment a `data-view-mode-value` attribute and ARIA roles consistent with the Mode toggle.
- [x] 2.2 Style the toggle in `src/styles.css` to share visual language with the existing Mode toggle (segmented look, active-state coloring, hover affordances).
- [x] 2.3 Wire a click handler on each segment that flips `appState.viewMode`, calls `writeViewModePreference`, re-renders the active document from cache (if available) or refetches in the new view, and triggers an inspector recompute.
- [x] 2.4 Hide the toggle's wrapping container when `appState.previewMode.kind !== "document"` (commit, review-score, empty) and when the active document has no separate rendered view (text / source / code files). Use a single `syncViewToggleVisibility()` function called from the same code paths that re-render the preview header.
- [x] 2.5 Verify the toggle does not push history entries, does not change Pin / Follow / Mode state, and does not flash an empty preview state during the in-place re-render.

## 3. Server-side source-view rendering

- [x] 3.1 Extend `GET /api/document` to accept a `view` query parameter (`"source" | "rendered"`, default `"rendered"`). When `view=source`, the server SHALL return a payload whose `html` field is a `<pre><code>` block of the file's verbatim text, syntax-highlighted by file kind, regardless of whether the file is Markdown / AsciiDoc / source code.
- [x] 3.2 Reuse the existing source-rendering / syntax-highlighting path that already produces `<pre><code>` for text/source files. The new behavior is "apply this path for any file kind when `view=source` is requested."
- [x] 3.3 Wrap the source-view whole-file `<pre>` with a distinguishing class (e.g. `pre.uatu-source-pre`) that does NOT appear on fenced code blocks rendered inside Markdown / AsciiDoc body content.
- [x] 3.4 Add server-side test coverage for the new `view=source` path on Markdown and AsciiDoc inputs (raw text round-trips, syntax-highlighter is invoked, distinguishing class is present).

## 4. Selection capture (line ranges)

- [x] 4.1 Refactor `src/selection-inspector.ts` so the captured shape is `SelectionRecord = { path: string; startLine: number; endLine: number }` (replacing the old `{ path, text }`). Keep the public API (`createSelectionInspector`, `subscribe`, `recompute`, `dispose`) but add a new state machine value: `current()` returns `PaneState = { kind: "placeholder" } | { kind: "hint" } | { kind: "reference"; record: SelectionRecord }` instead of just a record-or-null.
- [x] 4.2 Implement the `commonAncestorContainer.closest("pre.uatu-source-pre")` membership check as the gate that distinguishes "real source-view selection" from "selection inside a rendered fenced code block or chrome".
- [x] 4.3 Implement the line-counting helper: given the whole-file `code` element and a Range's start node + offset, walk the DOM accumulating preceding-text length to compute an absolute offset, then count `\n` characters in `code.textContent.slice(0, offset)` and add 1 to get the 1-indexed start line. Same for end. Handle the "selection ends exactly at a newline" case by trimming the trailing newline before counting (claudecode.nvim's convention).
- [x] 4.4 Implement the state-machine logic. The module needs read access to `appState.previewMode` and `appState.viewMode` (inject these via the existing options object). Decisions:
  - `previewMode.kind !== "document"` or no document path → `placeholder`
  - `viewMode === "rendered"` AND non-empty selection inside `#preview` → `hint`
  - `viewMode === "rendered"` AND no selection → `placeholder`
  - `viewMode === "source"` AND selection inside `pre.uatu-source-pre` AND non-empty → compute lines, return `reference`
  - any other case in source view → `placeholder`
- [x] 4.5 Add a small `formatReference({ path, startLine, endLine })` helper that returns `@<path>#L<a>-<b>` for ranges and `@<path>#L<a>` when start === end. Export for unit tests and for the pane render code.

## 5. Pane rendering and click-to-copy

- [x] 5.1 Update the pane DOM in `src/index.html` to a single render slot: a button (`<button class="selection-inspector-control">`) that takes the active label, plus a `<p class="pane-empty">` for the placeholder state. Remove the separate path / text slots from the prior iteration.
- [x] 5.2 Update `renderSelectionInspector` in `src/app.ts` to accept the new `PaneState` and switch on its `kind`:
  - `placeholder` → show `<p class="pane-empty">No selection</p>`, hide the button
  - `hint` → show button with text "Switch to Source view to capture a line range.", click handler flips `appState.viewMode` to `"source"`
  - `reference` → show button with text `formatReference(record)`, click handler copies the same string to the clipboard
- [x] 5.3 Always set the button's label via `textContent`, never `innerHTML`.
- [x] 5.4 Implement `copyToClipboard(text)` using `navigator.clipboard.writeText` with a hidden-textarea + `document.execCommand('copy')` fallback for cases the API is unavailable.
- [x] 5.5 On a successful copy, briefly switch the button label to "Copied" for ~1 second (and restore the reference text afterwards). Use `setTimeout`; cancel any pending restore on subsequent clicks.
- [x] 5.6 Make sure the button click does NOT collapse the user's preview selection. (The button has `tabindex` and is a `<button>`, so focus moves to it — that doesn't necessarily collapse the selection, but verify in e2e.)
- [x] 5.7 Update CSS for the new pane content (smaller, no big text dump). Remove the old `.selection-inspector-detail` / `.selection-inspector-meta` / `.selection-inspector-text` rules that no longer apply, replace with a single `.selection-inspector-control` rule and the `.pane-empty` placeholder style.

## 6. Wiring, recompute hooks, and edge cases

- [x] 6.1 Hook `selectionInspector.recompute()` from the existing places (loadDocument success, renderEmptyPreview, renderCommitMessage, renderReviewScoreDetails) AND add a new hook from the view-mode toggle handler so the pane re-evaluates when source/rendered flips.
- [x] 6.2 Verify that selecting inside fenced code blocks rendered as descendants of Markdown / AsciiDoc body content (NOT the whole-file source `<pre>`) produces the hint state, not a reference. The `closest("pre.uatu-source-pre")` check should yield null for these selections.
- [x] 6.3 Verify that selecting outside the preview entirely (sidebar, preview header, mode/view toggles) produces the placeholder state in source view and does NOT overwrite an existing capture.
- [x] 6.4 Verify Author mode still hides the pane entirely (carry-forward from prior design — the pane registration in `PANE_DEFS_BY_MODE` already excludes Author).
- [x] 6.5 Verify that the existing per-codeblock Copy button at `src/app.ts:1418` continues to copy the full block in Rendered view (and is absent in Source view because the source `<pre>` is not a fenced block — this may already be the case or may need a small carve-out depending on `attachCopyButtons`'s scope).

## 7. Tests

- [x] 7.1 Unit: `formatReference` collapses single-line ranges (`L42-42` → `L42`) and renders multi-line ranges (`L21-24`).
- [x] 7.2 Unit: line-counting helper computes correct 1-indexed start/end lines from synthetic `code` element + Range start/end node + offset combinations, including selection ending exactly at a newline.
- [x] 7.3 Unit: capture-module state machine — produces `placeholder` when `previewMode.kind !== "document"`, `placeholder` when no selection, `hint` in rendered view with a selection, `placeholder` in source view when selection's `commonAncestor` is not under `pre.uatu-source-pre`, `reference` in source view with a valid selection.
- [x] 7.4 Server unit / integration: `GET /api/document?view=source` for a Markdown document returns the verbatim source as `<pre class="uatu-source-pre"><code>...</code></pre>` with the syntax highlighter applied.
- [x] 7.5 E2E: Source / Rendered toggle appears for Markdown and AsciiDoc documents; hidden for `.ts` / `.json` / other source-only files; hidden for non-document previews.
- [x] 7.6 E2E: switching to Source view shows the file's verbatim text with the line-number gutter; switching back shows the rendered HTML again.
- [x] 7.7 E2E: view-mode preference persists across reload and applies to subsequently-opened documents.
- [x] 7.8 E2E: in Review + Source view, marking a span across known source lines causes the pane to display `@<path>#L<a>-<b>`; single-line selections collapse to `@<path>#L<n>`.
- [x] 7.9 E2E: clicking the displayed reference puts the same string on the clipboard (use Playwright clipboard read with `clipboard-read` permission granted on the context).
- [x] 7.10 E2E: in Review + Rendered view, marking text shows the "Switch to Source view to capture a line range." hint; clicking the hint flips the view to Source.
- [x] 7.11 E2E: in Review + Rendered view, selecting inside a fenced code block produces the hint, NOT a `@…#L…` reference.
- [x] 7.12 E2E: pane Author/Review behavior is unchanged from the prior implementation (Author hides, Review shows, mode-toggle round-trip preserves persisted Review state).
- [x] 7.13 E2E: pane visibility / collapse / size persist across reload (carry-forward from prior implementation).
- [x] 7.14 Run `bun test` and `bun run test:e2e` clean.

## 8. Documentation

- [x] 8.1 Update `README.md`'s feature list to mention the Source / Rendered view toggle and the Selection Inspector pane (Review-mode only, source-view-bound for line capture).
- [x] 8.2 Update `README.md`'s "Review panes" subsection to describe the pane's three states (placeholder, Rendered-view hint, captured reference) and the click-to-copy behavior.
- [x] 8.3 Make sure `README.md` does not promise hotkeys, send-to-agent, alternative reference formats, or per-document view-mode preference — those are explicit non-goals for this slice.
