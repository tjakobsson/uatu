# Fix desktop external links + add navigation chrome

## Why

In UatuCode Desktop, clicking an external link does nothing: rendered docs mark
external anchors `target="_blank"` (`src/render/external-links.ts`) and xterm.js
activates OSC 8 hyperlinks via `window.open()`, but the wrapper's SwiftUI
`WebPage` has no popup/navigation handler, so WebKit silently swallows both.
The desktop window also lacks any back/forward affordance, even though uatu is
an SPA with real history (`src/shell/history.ts`) — in a normal browser the
back button navigates document selection; in the desktop app that navigation
is unreachable.

## What Changes

- External `http(s)` links clicked anywhere in the uatu UI (rendered docs,
  terminal OSC 8 hyperlinks, metadata card, git log) open in the user's
  default browser when running in UatuCode Desktop.
- Non-`http(s)` schemes (`mailto:`, editor schemes, …) are handed to the
  system handler.
- The desktop window gains Back/Forward navigation for the uatu SPA itself
  (document-selection history), as menu commands with `⌘[` / `⌘]` shortcuts
  and toolbar buttons.
- Spike (resolved during design): determine whether the SwiftUI
  `WebPage`/`WebView` API can intercept `target="_blank"`/`window.open`
  navigations, or whether the wrapper must drop to `WKWebView` in an
  `NSViewRepresentable` with a `WKUIDelegate`.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `desktop-macos-shell`: two new requirements — (1) external-link activation
  inside the WebView must reach the system instead of being swallowed;
  (2) window chrome and menu expose Back/Forward for the embedded SPA's
  history.

## Impact

- `desktop/macos/UatuCodeDesktop/` — WebView hosting (`ContentView.swift`,
  possibly a new `WKWebView` representable), menu commands
  (`UatuCodeDesktopCommands`), toolbar.
- No `src/` (web app) changes expected; link emission is already correct
  (`target="_blank"` + `rel="noopener noreferrer"`).
- Groundwork for `add-desktop-split-browser`, which redirects this routing
  into an in-app browser pane; the system-browser behavior added here becomes
  that change's opt-out fallback.
