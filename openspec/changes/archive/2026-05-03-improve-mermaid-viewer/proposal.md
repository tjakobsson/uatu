## Why

Mermaid emits each rendered SVG with an inline `style="max-width: <Npx>"` pinned to the diagram's intrinsic pixel width. Across diagram types — flowcharts, sequence diagrams, class diagrams, C4 — that natural width is consistently smaller than the preview pane, so diagrams float in a sea of whitespace and labels are harder to read than they need to be. There is also no way to look closer: no zoom, no pan, no fullscreen, and the browser's page zoom is too coarse. On top of that, the renderer is hard-coded to `theme: "default"`, which will clash with non-light themes once uatu picks up theme support. This change replaces the static viewer with one that fits the available width for any diagram, supports zoom/pan in a fullscreen modal, and is theme-aware from day one.

## What Changes

- Diagram SVGs scale to fill the preview width while preserving aspect ratio (strip Mermaid's inline `max-width`, set `width: 100%`, keep `viewBox`).
- Each rendered diagram becomes a clickable trigger that opens a fullscreen modal viewer.
- The modal viewer supports: wheel-zoom centered on the cursor, drag-to-pan, double-click to reset, keyboard shortcuts (`+` / `-` / `0` / `f`), an inline toolbar (zoom in / zoom out / reset / fit), and Esc-or-backdrop close with focus return.
- Mermaid initialization accepts theme inputs (`theme` plus `themeVariables`) so a future theme switch can re-render diagrams to match the active UI theme. The default visual remains the existing light look.
- e2e coverage is extended to assert (a) inline diagrams fill the container, (b) clicking a diagram opens the modal, (c) Esc closes the modal and returns focus, (d) wheel events change the SVG transform.
- Theme tokens for the modal chrome are added to the existing CSS so it inherits whatever the rest of the app uses.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `document-watch-browser`: extends the existing "Render Mermaid diagrams from fenced code blocks" requirement so that diagrams scale to the preview width, are openable in a zoom/pan modal, and follow the active UI theme.

## Impact

- **Code**: `src/preview.ts` (sizing fix, modal trigger wiring, theme inputs), `src/styles.css` (`.mermaid` block, new modal styles, hover affordance), `src/app.ts` (mount the modal once, wire trigger handler), and `tests/e2e/uatu.e2e.ts` (new diagram interaction cases). One new module is expected: `src/mermaid-viewer.ts` for the modal + pan/zoom logic.
- **Dependencies**: no new runtime dependencies. Pan/zoom is implemented in ~100 lines using native `<dialog>` and pointer events. Mermaid version is unchanged.
- **Bundle**: minor growth for the new module; no third-party additions.
- **Behavior compatibility**: existing diagrams continue to render. The visible change is that they fill more horizontal space and react to a click. Existing keyboard navigation and other preview features are unaffected.
- **Theme readiness**: introduces the seam for theme-driven re-rendering; actual non-light themes are out of scope and will land with the broader theme work.
