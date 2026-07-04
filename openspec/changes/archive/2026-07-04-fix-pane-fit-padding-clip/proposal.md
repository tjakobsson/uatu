# Fix pane fit padding clipping

## Why

Terminal panes clip their bottom (and right-edge) character cells: a prompt or
TUI row at a pane boundary renders cut in half, and content near the edge of a
split appears "hidden". Root cause: `.terminal-pane-host` carries
`padding: 0.4rem 0.6rem` while the app's global `box-sizing: border-box` makes
`getComputedStyle(host).height` include that padding. FitAddon measures the
*parent* element's computed height and subtracts only the `.xterm` element's
own padding (which is zero), so the proposed grid is ~13px taller than the
host's content box. Whenever the pane height modulo the cell height falls in
the wrong window (~75% of arbitrary drag positions at the default font), the
grid gets one extra row and the host's `overflow: hidden` guillotines it.
Affects every pane; most visible in splits where the clipped row sits against
a neighboring pane.

## What Changes

- Move the pane padding from `.terminal-pane-host` onto
  `.terminal-pane-host .xterm` — the element whose padding FitAddon is
  written to subtract. The grid math becomes exact: `rows × cellHeight` never
  exceeds the host's content box, so no row is ever clipped.
- No TypeScript changes expected; this is a CSS-only fix plus regression
  coverage.
- E2E regression test: across a sweep of pane sizes (including odd pixel
  heights from simulated resizer drags), assert the rendered grid fits inside
  the host's content box and the last row is fully visible.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `embedded-terminal`: adds a requirement that the terminal character grid
  always fits within the visible pane — sizing measurements account for pane
  padding so no row or column is clipped by the pane's overflow bounds, at
  any pane size.

## Impact

- `src/styles.css` — `.terminal-pane-host` / `.terminal-pane-host .xterm`
  padding rules.
- `tests/e2e/` — new or extended terminal E2E asserting grid-fits-within-host
  across pane sizes (single pane and splits, both docks).
- Interacts with (but does not change) the reattach/first-paint fit logic in
  `src/terminal/client.ts`; existing first-paint E2E must stay green.
