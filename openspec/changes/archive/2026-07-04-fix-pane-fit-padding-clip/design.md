# Design — fix-pane-fit-padding-clip

## Context

FitAddon (`@xterm/addon-fit`) computes the grid as:

```
availableHeight = parseInt(getComputedStyle(terminal.element.parentElement).height)
                − (terminal.element's own vertical padding)
rows = floor(availableHeight / cellHeight)
```

In uatu, `terminal.element` is `.xterm` and its parent is `.terminal-pane-host`.
The host carries `padding: 0.4rem 0.6rem` (`src/styles.css`), and the global
`box-sizing: border-box` rule makes the host's computed `height` include that
padding. `.xterm` itself has no padding, so FitAddon subtracts nothing and
over-proposes the grid by ~12.8px vertically / ~19.2px horizontally. The host's
`overflow: hidden` (needed so the absolutely-positioned `.xterm-screen` cannot
intercept pointer events on the inter-pane resizer) then clips the excess —
producing half-visible rows at pane edges.

## Goals / Non-Goals

**Goals:**
- Exact fit math: the grid never exceeds the host content box at any pane size.
- Preserve the existing visual inset (same 0.4rem/0.6rem breathing room).
- Preserve the `overflow: hidden` pointer-event containment on the host.
- Regression coverage that would have caught this.

**Non-Goals:**
- No changes to the fit/reattach flow in `client.ts` (ResizeObserver-driven
  `fit()` is correct once the measurement is).
- The tmux-inside-a-pane DECSLRM corruption (upstream xterm.js #4285) —
  unrelated, tracked separately.

## Decisions

### D1: Move padding to `.xterm` instead of removing it or compensating in JS
`.terminal-pane-host { padding: 0 }` and `.terminal-pane-host .xterm
{ padding: 0.4rem 0.6rem }`. FitAddon explicitly reads the terminal element's
own padding and subtracts it — this is the upstream-sanctioned place for
visual insets. Alternatives rejected:
- Removing the padding entirely: loses the visual inset for no reason.
- A JS-side correction (shrinking the proposed dims after `proposeDimensions`):
  fights the addon and breaks the next time the CSS changes.
- Padding on an intermediate wrapper: same bug, one element deeper.

`.xterm` already has `height: 100%`; with the global `border-box` sizing the
padding stays inside the host's content box, and `.xterm-screen` (positioned
relative to `.xterm`'s content area by xterm.js) sits inside the inset.

### D2: E2E assertion strategy
Playwright can read the ground truth directly: the host's content-box height
(`clientHeight − paddingTop − paddingBottom` — with the padding moved, just
`clientHeight` of the host) versus the rendered `.xterm-screen` bounding box.
Sweep several panel heights via the resizer/drag APIs (odd pixel values on
purpose), in bottom dock and right dock, single pane and one split, asserting
`screen.height ≤ host content height` and that the screen's bottom edge is
inside the host's bounds. This catches any future padding/box-sizing
regression regardless of which element carries the inset.

## Risks / Trade-offs

- [xterm's selection/scrollbar layers assume the padding-free `.xterm` box] →
  xterm.js documents padding on `.xterm` as the supported inset mechanism
  (FitAddon subtracts exactly this); visual smoke via existing terminal E2E
  plus the new sweep test.
- [First-paint fit path re-measures before layout settles] → unchanged logic;
  the existing "first paint after refresh" E2E guards it and must stay green.
- [Rounding: `parseInt` truncation and fractional cell heights leave ≤1px
  slack] → acceptable; the failure mode is a 1px underfill (padding grows by
  1px), never an overflow clip.
