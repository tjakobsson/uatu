# Touch Tab Navigation

## Why

The `mobile-experience` change (archived 2026-08-06) established the
one-surface-at-a-time model on phones but left its navigation scattered: a Browse
button in a pane header opens the file browser, "whatever you scroll back to" is the
preview, the terminal is toggled from the sidebar/rail, and exiting it parks a
minimized strip at the bottom of a scrolled page. iPads were deliberately excluded
from phone-class, yet the same person drives sessions from both devices and wants the
same recognizable interaction there.

An iOS-style bottom tab bar — Files / Preview / Terminal — is the canonical chrome
for the one-surface model, instantly recognizable to iPhone and iPad users. And
because an iPad is big enough to run the full desktop layout well, touch mode must be
escapable there: the user can flip uatu to render exactly as it would in a desktop
browser, and flip back.

## What Changes

- A per-device **UI mode** — `touch` or `desktop` — replaces the width-based
  phone-class gate for layout decisions. Coarse-pointer devices default to `touch`
  (iPhone AND iPad); the mode is overridable and persisted per device. Input
  affordances (keybar, size steppers, touch/wheel scroll routing) stay keyed on
  pointer coarseness and work in both modes.
- **Touch mode** shows a bottom tab bar (safe-area aware, above the home indicator)
  with three tabs, each a fullscreen surface: **Files** (the sidebar pane stack,
  subsuming the phone file-browser overlay), **Preview** (the main document area),
  and **Terminal** (the fullscreen terminal). One surface at a time, on any
  coarse-pointer device.
- Picking a document in the Files tab switches to the Preview tab (the Rule A
  user-click path — programmatic tree updates never switch tabs). Switching away
  from the Terminal tab keeps every PTY attached (minimize semantics without the
  strip); the minimized header strip disappears from touch mode entirely.
- A single **mode toggle** in the sidebar header (the Files tab's header in touch
  mode; the desktop chrome, with a rail variant, otherwise) switches the device
  between the touch rendering and the full desktop rendering — sidebar + preview +
  docked terminal, exactly as a desktop browser renders it — at any viewport
  width. The tab bar itself carries no mode control.
- The shipped phone-class CSS conditions (`pointer: coarse AND ≤900px`) migrate to
  the mode attribute for layout concerns; the Browse button and phone
  exit-fullscreen→minimized routing are retired in favor of tabs.

## Capabilities

### New Capabilities

- `touch-navigation`: the UI mode (default, override, persistence), the bottom tab
  bar, the three tab surfaces and their switching semantics, and the desktop-mode
  escape.

### Modified Capabilities

- `embedded-terminal`: the phone-class fullscreen requirements (auto-promotion,
  hidden geometry controls, visible-viewport tracking scope) re-key from phone-class
  viewports to touch mode, extending them to iPads; leaving the fullscreen terminal
  routes to a tab switch instead of `minimized`.
- `sidebar-shell`: the phone file-browser overlay requirement is superseded by the
  Files tab (same continuity guarantees, new chrome); the stacked-layout tree-height
  requirement narrows to desktop mode at narrow widths.

## Impact

- New `src/shell/ui-mode.ts` (mode resolution + persistence) and
  `src/shell/tab-bar.ts` (bar rendering + surface switching); `src/index.html` gains
  the bar markup.
- `src/styles.css` — phone-class media blocks re-keyed to `[data-ui-mode="touch"]`;
  tab-bar styles; minimized-strip and Browse-button rules retired from touch mode.
- `src/terminal/panel.ts` / `pane-state.ts` — promotion and exit routing driven by
  the active tab; `isPhoneClassViewport` generalizes to the mode helper.
- `src/sidebar/files-overlay.ts` — subsumed into the Files tab surface.
- E2E: `tests/e2e/mobile.e2e.ts` reworked around tabs; new iPad-viewport coverage
  (coarse + wide) including the desktop-mode escape round-trip.
- No server, hub, or protocol changes.
