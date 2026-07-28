# Fix desktop titlebar drag and terminal top-strip regressions

## Why

Two visible regressions in UatuCode Desktop's glass-titlebar layout:

1. **The window can no longer be moved by its titlebar** except when
   dragging over the split-browser side. Dragging in the titlebar strip
   above the SPA web view does nothing. This directly violates the existing
   `desktop-macos-shell` requirement "Windows use a transparent full-height
   content layout", whose draggability was explicitly verified when the
   glass titlebar shipped (archive `2026-07-19-add-desktop-glass-titlebar`,
   task 1.3) — so it broke somewhere between the 0.3.0 release and current
   main (candidates: the find/search commit `9d036c3`, which reworked the
   window key monitor and Edit menu, or a macOS/WebKit update).

2. **The right-docked terminal looks broken under the transparent
   titlebar.** The panel's opaque dark background paints up through its
   inset padding into the covered strip, and the page's frost overlay then
   blurs it into a smeared light-to-dark gradient across the toolbar. The
   frost was designed for *scrolled document content* and explicitly
   excludes the sidebar (a solid, non-scrolling surface) — but the
   right-docked terminal is exactly such a surface and was never excluded.
   This combination (dock-right terminal + glass titlebar) has been broken
   since #137 shipped; it just wasn't exercised until now.

## What Changes

- Restore titlebar dragging over the full window width, including the
  region above the SPA web view, and pin down the root cause (bisect
  between `ad839fd` (v0.3.0) and main; rule the OS in or out).
- Make the covered strip above the right-docked terminal panel read like
  the strip above the sidebar: no opaque panel surface smeared by the
  frost — the terminal's chrome sits below the inset and the strip above
  it renders cleanly under the native glass.
- Add a regression-proofing scenario to `desktop-macos-shell` making
  explicit that titlebar dragging must work at every horizontal position,
  regardless of which surface (SPA, terminal column, split browser) lies
  beneath.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `desktop-macos-shell`: strengthen the "Windows use a transparent
  full-height content layout" requirement with a scenario asserting the
  window is draggable via the titlebar strip at any horizontal position —
  over the SPA web view and over the split pane alike.
- `desktop-titlebar-inset`: extend the frost requirement — solid,
  non-scrolling app surfaces (the sidebar today, the right-docked terminal
  panel) SHALL NOT be washed by the frost; the strip above the terminal
  panel must render cleanly, with the panel's own chrome laid out below
  the inset.

## Impact

- `desktop/macos/UatuCodeDesktop/` — wherever the drag root cause lands
  (ContentView window setup, key monitor, or an explicit drag affordance
  such as a titlebar accessory / `mouseDownCanMoveWindow` path).
- `src/styles.css` — the `html.uatu-desktop-host` block: frost overlay
  geometry and `.terminal-panel[data-dock="right"]` inset treatment.
- Possibly `src/terminal/panel.ts` (dock-state class hooks) if the frost
  exclusion needs a live width variable like `--sidebar-width`.
- Specs: `openspec/specs/desktop-macos-shell/spec.md`,
  `openspec/specs/desktop-titlebar-inset/spec.md`.
- No server, CLI, or non-desktop browser behavior changes; browser/PWA
  layout stays untouched (all changes gated behind `uatu-desktop-host`).
