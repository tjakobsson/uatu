# Tasks: add-desktop-zoom

## 1. Zoom model

- [x] 1.1 Define the shared zoom ladder (Safari steps 0.5–3.0) and
      next/previous/nearest-step helpers in the desktop target
- [x] 1.2 Add the persisted shared level: `@AppStorage("pageZoom")`
      (Double, default 1.0) in `ContentView`, plumbed as zoomIn/zoomOut/
      actualSize closures plus canZoomIn/canZoomOut flags on
      `WindowCommands`

## 2. Apply zoom to web views

- [x] 2.1 Enable `allowsMagnification` on the SPA web view
      (`WebViewHost.init`) and on each tab's web view (`BrowserTab.init`)
- [x] 2.2 Apply the shared `pageZoom` level to the SPA web view and all
      split-tab web views from a single helper in `ContentView`, wired to
      `onChange` of the stored level
- [x] 2.3 Make `BrowserTab` render at the current level from creation
      (pass or read the level in `newTab`/`BrowserTab.init`)
- [x] 2.4 Actual Size resets `magnification` to 1.0 on the window's SPA
      web view and every tab web view, in addition to setting the level
      to 1.0

## 3. Menu commands

- [x] 3.1 Add Zoom In (⌘+), Zoom Out (⌘−), Actual Size (⌘0) to the
      `CommandGroup(after: .toolbar)` in `UatuCodeDesktopCommands`,
      clamped/disabled at ladder ends
- [x] 3.2 Add the hidden ⌘= alias for Zoom In so shifted-`+` layouts work

## 4. Verify

- [x] 4.1 Build the app (`bun run build`, then the Xcode project) and
      manually verify each spec scenario: both panes zoom together, new
      tab inherits, level survives relaunch, second window follows, pinch
      + smart zoom per pane, ⌘0 resets level and magnification
- [x] 4.2 Run `openspec validate add-desktop-zoom` and fix any
      artifact issues
