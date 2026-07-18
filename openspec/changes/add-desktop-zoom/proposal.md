# Proposal: add-desktop-zoom

## Why

UatuCode Desktop has no way to zoom at all: `WKWebView` ships with pinch
magnification disabled and provides no built-in keyboard zoom, and the app
never wired up either. Users coming from Safari expect ⌘+/⌘−/⌘0 and
trackpad pinch to work in both the uatu pane and the split browser.

## What Changes

- Add View-menu zoom commands — Zoom In (⌘+), Zoom Out (⌘−), Actual Size
  (⌘0) — that adjust WebKit page zoom (layout zoom that reflows, matching
  Safari's ⌘+/⌘− behavior).
- One shared, persisted zoom level for the whole app: the uatu SPA pane and
  every split-browser tab render at the same level, and newly created
  browser tabs inherit it.
- Enable trackpad pinch-to-zoom and smart zoom (two-finger double-tap) on
  the SPA web view and every browser-tab web view. Pinch magnification is
  visual (no reflow), per-web-view, and transient — it does not persist and
  is independent of the shared page-zoom level. Actual Size (⌘0) also
  resets any pinch magnification on the focused pane.

## Capabilities

### New Capabilities

- `desktop-zoom`: Zoom behavior of UatuCode Desktop's web surfaces — the
  shared persisted page-zoom level, the keyboard/menu commands that adjust
  it, and pinch/smart-zoom magnification on every web view.

### Modified Capabilities

<!-- none — desktop-macos-shell and desktop-split-browser requirements are
     unchanged; zoom is layered on top as its own capability -->

## Impact

- `desktop/macos/UatuCodeDesktop/WebViewHost.swift` — enable magnification,
  apply the shared page-zoom level.
- `desktop/macos/UatuCodeDesktop/BrowserSplit.swift` — enable magnification
  and apply the shared zoom level on each `BrowserTab`'s web view.
- `desktop/macos/UatuCodeDesktop/ContentView.swift` — zoom commands in
  `UatuCodeDesktopCommands`, shared level storage, plumbing into
  `WindowCommands`.
- No changes to the uatu web app or server; no dependency changes.
  Requires macOS 11+ `WKWebView.pageZoom` (already satisfied — the app
  targets far newer).
