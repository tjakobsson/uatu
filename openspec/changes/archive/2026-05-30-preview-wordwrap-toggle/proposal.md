## Why

Long lines in the source preview and the diff view force horizontal
scrolling, which makes wide code, log lines, and prose-y Markdown source
awkward to read. The diff library (`@pierre/diffs`) already supports
wrapping but we never enable or surface it, and the source view has no
wrap capability at all. A single, familiar "Wrap" control — matching the
behavior editors like VSCode give — closes the gap for both panes.

## What Changes

- Add a shared **Wrap** toggle to the preview toolbar that turns
  soft word-wrap on/off. It is a single global preference applied to
  whichever view supports wrapping (Source and Diff), and is hidden in
  Rendered view where wrap is meaningless.
- **Diff view**: pass `overflow: 'wrap'` to `@pierre/diffs` when the
  preference is on (the library already handles per-line wrapping and
  keeps its own line numbers truthful). This is the cheap half.
- **Source view**: support soft word-wrap while keeping line numbers
  **truthful to the code** — a wrapped logical line keeps its own number,
  continuation rows stay blank, and the next line's number stays glued to
  where that line actually begins (VSCode behavior). This requires the
  current single-blob gutter + code structure to become per-line so a
  number can align to a multi-row wrapped line.
- The wrap preference persists across sessions (localStorage), defaults
  to off, and re-applies on reload.
- **Gating perf spike (decides implementation, not behavior)**: before
  committing the source-view rendering approach, measure two paths
  head-to-head — the current highlight.js source renderer vs. rendering
  the source through `@pierre/diffs`' virtualized code viewer — both
  without wrap, on a fixed file-size curve, against pre-committed pass
  criteria. The result picks between a contained homegrown per-line
  gutter and unifying source rendering on Pierre. See design.md.

## Capabilities

### New Capabilities
- `preview-wordwrap`: the shared Wrap toggle — its placement in the
  preview toolbar, single-global-preference semantics, persistence,
  default-off behavior, and visibility rules (shown for Source and Diff,
  hidden for Rendered).

### Modified Capabilities
- `document-source-view`: source preview gains soft word-wrap; line
  numbers must remain truthful to logical code lines when wrapped
  (each number aligns to the start of its own, possibly multi-row, line;
  continuation rows carry no number).
- `document-diff-view`: diff preview honors the wrap preference via the
  library's `overflow: 'wrap'` mode.
- `document-render-benchmarks`: add a comparative source-render
  performance measurement (current highlight.js path vs. Pierre code
  viewer) with explicit pass criteria, used to gate the source-view
  implementation choice.

## Impact

- **UI / DOM**: `src/index.html` (preview toolbar gains a Wrap control),
  `src/styles.css` (toggle styling + source-view wrap/per-line gutter
  CSS).
- **Source rendering**: `src/preview/code-block.ts` (`attachLineNumbers`,
  copy-to-clipboard which currently reads a single `<code>` blob) and
  `src/render/markdown.ts` (`renderCodeAsHtml`) — extent depends on the
  spike outcome (homegrown per-line restructure vs. Pierre adoption).
- **Diff rendering**: `src/preview/diff-view.ts` (pass `overflow` to the
  `FileDiff` constructor).
- **State / persistence**: `src/shell/state.ts` + storage (new `wrap`
  preference), mirroring the existing `diffStyle` preference.
- **View-mode wiring**: `src/preview/view-mode.ts` (show/hide the Wrap
  control per active view, same pattern that hides unsupported view
  segments).
- **Dependencies**: none new — `@pierre/diffs` (1.2.4) already installed.
- **Tests**: a throwaway perf-spike harness in `tests/` (not `src/`);
  e2e coverage for the toggle in `tests/e2e/`.
