## Context

The preview pane has three view modes (Rendered / Source / Diff). Long
lines currently force horizontal scrolling in Source and Diff. We want a
single, familiar **Wrap** toggle.

Current state:

- **Source view** renders the whole file as a single `<pre><code>` blob
  (highlight.js, server-side `renderCodeAsHtml` in `src/render/markdown.ts`).
  Line numbers are attached client-side by `attachLineNumbers`
  (`src/preview/code-block.ts`) as a **single sibling `<span>`** holding
  `"1\n2\n3…"`. The `<pre>` uses `white-space: pre` (inherited) +
  `overflow: auto`. Copy-to-clipboard reads `code.textContent`; the gutter
  is excluded only because it lives outside `<code>`.
- **Diff view** renders via `@pierre/diffs` (`FileDiff`) into a Shadow DOM
  host. `@pierre/diffs` (1.2.4) already supports wrapping via
  `BaseCodeOptions.overflow: 'scroll' | 'wrap'`, but uatu never passes it,
  so it defaults to `'scroll'`. Pierre builds its own per-line DOM and
  keeps its own line numbers, so wrapping there is essentially free.

The hard part is the source view: the single-blob + single-gutter design
is built on the invariant "one logical line = one visual row," which is
exactly what wrap breaks.

## Goals / Non-Goals

**Goals:**
- A single global Wrap preference, applied to whichever view supports it
  (Source, Diff), hidden in Rendered. Persisted, default off.
- Source-view wrap that keeps line numbers **truthful** — VSCode behavior:
  a wrapped logical line keeps its own number, continuation rows are blank,
  the next line's number stays aligned to where that line begins.
- Diff-view wrap via the library's native `overflow: 'wrap'`.
- A pre-committed performance comparison that decides the source-view
  rendering implementation before we build it.

**Non-Goals:**
- Wrap in Rendered (Markdown/AsciiDoc body) view — not meaningful.
- Changing how fenced code blocks *inside* rendered Markdown behave
  (they share `attachLineNumbers`, so they inherit any structural
  refactor, but the Wrap toggle does not target them).
- Per-view independent wrap preferences (explicitly rejected — see below).
- Hard-wrapping / inserting real newlines. This is soft (visual) wrap only.

## Decisions

### Decision 1: One global Wrap preference, not per-view
A single `wrap` boolean applied to whichever view supports wrapping.
Mirrors the existing `diffStyle` / view-mode / layout preferences in
`src/shell/state.ts` + storage. Persisted to `localStorage` (key e.g.
`uatu:preview-wrap`), default `false`, re-applied on load.

- **Alternative — per-view toggles**: rejected. The user's mental model is
  one "Wrap on/off"; two toggles is more chrome and more state for no
  added value.

### Decision 2: Toggle is a single pressed-state button in the shared preview toolbar
A single toggle button with `aria-pressed`, living in `.preview-toolbar`
next to the Rendered/Source/Diff chooser. Visibility follows the active
view (shown for Source and Diff, hidden for Rendered) using the same
mechanism that already hides unsupported view-mode segments
(`syncViewToggle` in `src/preview/view-mode.ts`).

- **Alternative — checkbox**: rejected. It would be the only checkbox in
  the chrome; a pressed-state button matches the existing segmented-pill /
  toggle vocabulary and reads as a checkbox to assistive tech anyway.
- **Alternative — per-view in-body toggle** (like the diff Unified/Split
  control): rejected for the shared control; a single top-toolbar home is
  simpler and avoids duplicating the control in two places.

### Decision 3: Source wrap keeps truthful per-line numbers (behavior "B")
When wrapped, each line number aligns to the start of its own logical line;
continuation rows carry no number. This is the VSCode behavior.

- **Alternative A — hide the gutter while wrapped**: truthful by omission,
  trivial, but the user wants numbers visible while wrapped. Rejected.
- **Alternative C — naive `white-space: pre` → `pre-wrap` flip on the
  current single-span gutter**: rejected because it makes the numbers
  **lie** — the gutter advances one number per visual row while code
  advances one logical line per (multi-row) wrap, so numbers desync and
  point at the wrong code. This directly violates the truthfulness goal.

Achieving B requires the gutter + code to become **per-line** so a number
can align (top-aligned) to a multi-row wrapped line — e.g. a CSS grid /
table with `auto 1fr` columns, `align-items: start`, where `.cl` (code
line) is `white-space: pre` when unwrapped and `pre-wrap` +
`overflow-wrap: anywhere` when wrapped, and `.ln` cells are
`user-select: none`. Copy-to-clipboard must change from reading the single
`<code>` blob to gathering per-line code text (joined by `\n`), since the
numbers would otherwise either pollute the copy or be missing.

### Decision 4: Source-view rendering engine is gated by a perf spike
There are two ways to get per-line + wrap, and they differ a lot in blast
radius. The choice is **deferred to a measured spike** because a prior
attempt to render source through Pierre had performance problems — likely
a poor (non-virtualized) implementation, since Pierre is explicitly built
to scale (it exports `Virtualizer`, `VirtualizedFile`, `FileStream`,
`ShikiStreamTokenizer`, `CodeView`).

- **B-homegrown**: refactor `renderCodeAsHtml` + `attachLineNumbers` into a
  per-line grid; solve the highlight.js "tokens span newlines" splitting
  problem (reopen spans per line); rewire copy to gather per-line text; add
  wrap CSS. *Contained, low blast radius, but fiddly.* Keeps light DOM,
  hljs, and the existing copy / selection-inspector / anchors / metadata
  card behavior untouched.
- **B-pierre**: render the source view through Pierre's virtualized
  `File` / `CodeView`. Wrap (`overflow: 'wrap'`), per-line DOM, and line
  numbers come for free, and source + diff unify on one highlighter
  (Shiki). *Elegant, larger blast radius* — source moves into Shadow DOM,
  so copy button, selection inspector (`window.getSelection()`), anchors,
  and the metadata card all need re-validation.

**Spike (gate):** a throwaway harness in `tests/` rendering identical
fixture files two ways — current hljs source vs. Pierre's *virtualized*
code viewer — **both without wrap**, across a size curve
(~100 / ~2k / ~20k lines / near the 1 MB highlight cap) × a light grammar
(json/txt) and a heavy one (tsx). Measure: time-to-first-paint
(`performance.mark`/`measure`), cold vs warm, DOM node count (the
virtualization tell), scroll FPS / long-tasks on the 20k file.

**Pass criteria (committed before running — task 3.1):**

The virtualized path is `CodeView.setup(root)` → `setItems([fileItem])` →
`render()` with `preloadHighlighter` warming shiki; the prior failure was
almost certainly the non-virtualized `File`. Criteria, judged on a 600px
scroll viewport across the size curve (~100 / ~2k / ~20k lines / ~1 MB) ×
light (json) and heavy (tsx) grammars:

1. **First paint, warm** — Pierre ≤ 1.5× hljs at ≤2k lines, AND Pierre ≤
   hljs at 20k lines and ~1 MB (virtualization should *win* on big files;
   if Pierre is slower than hljs on the 20k file, that's a red flag).
2. **First paint, cold** — Pierre's one-time shiki/grammar penalty ≤ ~800 ms
   on the first render; acceptable because it amortizes (warm renders meet
   #1) and can be hidden with `preloadHighlighter` at boot.
3. **DOM node count** — on the 20k and ~1 MB fixtures Pierre stays bounded
   (≲ a few thousand nodes, viewport-proportional and clearly sub-linear in
   file size), while hljs is O(lines). This is the core virtualization
   proof.
4. **Scroll** — scrolling the 20k fixture, Pierre sustains ≥ 50 fps (median
   frame ≤ 20 ms) with no long task > 100 ms.
5. **Phase 2 — wrap** — with `overflow: 'wrap'` on the 20k fixture, Pierre
   still sustains ≥ 50 fps and first paint within 1.5× of its own
   scroll-mode first paint (wrap stresses the virtualizer's variable-height
   assumption — see Risks).

**Decision rule:** adopt **B-pierre** iff #1–#4 pass AND #5 passes. If
Pierre fails large-file first paint or scroll even when virtualized →
**B-homegrown**. If Pierre passes unwrapped but fails the wrap phase (#5) →
**B-homegrown** (wrap is the whole point). Thresholds are guidance for a
clear call, not a hair-trigger; a marginal miss gets a judgment note in
3.6 rather than an automatic veto.

### Decision 5: Diff wrap via native `overflow`
Pass `overflow: appState.wrap ? 'wrap' : 'scroll'` to the `FileDiff`
constructor in `src/preview/diff-view.ts`, and re-render in place from the
cached payload when the preference changes (same flow the Unified/Split
toggle already uses). No new fetch.

### Decision 4 — Spike outcome (resolved): **B-homegrown**

The spike (`tests/spike/wordwrap-perf/`, results in `results.json`) ran the
current highlight.js path vs Pierre's virtualized `CodeView` across
100 / 2k / ~900 KB(under-cap) / ~1.3 MB(over-cap) fixtures × json (light)
and tsx (heavy) grammars in headless Chromium.

What passed for Pierre:
- **Virtualization works** — DOM nodes bounded (~333 json / ~601 tsx
  *regardless* of file size) while hljs grows O(lines) (403 → ~38k). (#3 ✓)
- **Scroll is smooth** — ≥50 fps on the large heavy fixture in both scroll
  (118 fps) and **wrap** (92 fps) modes; no long tasks. (#4, #5 ✓)
- Cold shiki penalty negligible. (#2 ✓)

What failed — and decides it:
- **First paint on heavy grammars (#1 ✗).** Pierre tokenizes the whole file
  up front via shiki; shiki's TextMate tsx grammar is ~4× slower than
  highlight.js. Measured warm first paint: tsx-2k 210 ms vs hljs 49 ms;
  tsx-~900 KB (9k lines) **937 ms** vs hljs 213 ms; tsx-over (13k lines)
  **1343 ms** vs hljs's escape path. Virtualization bounds *rendering*, not
  *tokenization*, so this scales with file size. For light grammars (json)
  Pierre actually wins (47 ms vs 137 ms at 9k lines), but a code-review
  tool's source view is dominated by heavy-grammar code files.

**Decision: B-homegrown.** Keep highlight.js for the source view (fast
tokenization, already integrated, snappy first paint) and build the
per-line gutter ourselves.

**Implementation refinement (during build):** the per-line layout renders
each source line as a `.uatu-cl` block and draws its number with a CSS
`::before` from a `data-ln` attribute — *not* as a DOM text node inside a
grid. This was chosen over the originally-sketched grid-with-`.ln`-children
because it keeps `<code>`.textContent exactly equal to the source: the
Selection Inspector's character-offset → line mapping and copy-to-clipboard
both read `code.textContent` and therefore need **no changes**. Real `\n`
text nodes are reinserted between line blocks (and `<code>` is
`white-space: normal` so they collapse visually) to preserve that text
content; each `.uatu-cl` is `white-space: pre` (→ `pre-wrap` when wrapped),
and the absolutely-positioned number stays pinned to the line's top row.
The span-aware splitter lives in `src/preview/highlight-lines.ts` (pure,
unit-tested) so it's testable without a DOM. The spike also de-risks the homegrown path:
Pierre's variable-height **wrap** mode held ≥50 fps, so our CSS-grid
per-line layout — the same variable-height problem with simpler DOM — is
very likely fine.

Caveats recorded for honesty:
- The harness bundles `@pierre/diffs` the same way uatu does (Bun
  single-file). If Pierre's worker/stream tokenization
  (`FileStream`/`ShikiStreamTokenizer`/worker pool) isn't wired up by
  default, the spike reflects how Pierre would actually behave *in uatu* —
  which is the relevant question. A future option (not pursued now) is to
  adopt Pierre + offload tokenization to a worker so first paint renders
  plain then progressively highlights; that's a larger, uncertain effort
  and the user's prior experience plus this data favor the low-risk
  homegrown path.

## Risks / Trade-offs

- **Wrap erodes virtualization** → Virtualizers assume fixed row height
  (`scrollTop / rowHeight`); wrap makes heights variable, forcing
  per-row measurement. *Mitigation:* the spike must include a **phase 2**
  measuring Pierre *with* `overflow: 'wrap'` on the large fixtures — the
  unwrapped baseline alone is not sufficient evidence. (A fast
  Pierre-with-wrap result is also positive evidence that B-homegrown's
  hand-rolled variable-height grid will be fine.)
- **highlight.js tokens span newlines** (block comments, template
  strings) → naive split-by-`\n` breaks spans. *Mitigation (B-homegrown):*
  use the established reopen-spans-per-line technique; cover with a unit
  test on a fixture containing a multi-line token.
- **Copy-to-clipboard regression** → copy currently relies on the single
  `<code>` blob. *Mitigation:* update copy to gather per-line `.cl` text;
  keep `.ln` `user-select: none` so manual selection stays clean; e2e
  assertion that copied text excludes line numbers and preserves newlines.
- **B-pierre Shadow DOM blast radius** → selection inspector, copy,
  anchors, metadata card may break when source leaves light DOM.
  *Mitigation:* only taken if the spike passes; gated by explicit
  re-validation tasks against the `document-source-view` and
  `selection-inspector` specs. The diff view already lives in Shadow DOM,
  so there is precedent (and `selection-inspector` already excludes diff).
- **Shiki cold start** (B-pierre) → first highlight loads grammars/themes.
  *Mitigation:* measured as "cold vs warm" in the spike; Pierre exposes
  `preloadHighlighter` if warming is needed.
- **Horizontal-scroll behavior in unwrapped mode** must remain unchanged
  (regression guard) — the toggle only adds a wrapped mode.

## Migration Plan

- Additive, behind a default-off preference; no data migration. Existing
  users see identical behavior until they toggle Wrap on.
- Rollback: remove the toggle / preference read; both views fall back to
  current scroll behavior.
- Sequencing: (1) ship the Diff half (cheap, native `overflow`) and the
  shared toggle+preference behind it; (2) run the source-view spike;
  (3) implement source wrap via the winning path. The Diff half and the
  toggle do not depend on the spike outcome.

## Open Questions

- Exact `localStorage` key and whether to reuse one preference object or a
  standalone key (lean: standalone `uatu:preview-wrap`, mirroring
  `diffStyle`).
- Whether B-pierre, if chosen, should also migrate fenced code blocks
  inside rendered Markdown off hljs for consistency, or leave them on hljs
  (smaller scope). Default: leave them; revisit separately.
- ~~The numeric first-paint margin for the spike pass criteria~~ —
  resolved in Decision 4's pass criteria above (task 3.1).
