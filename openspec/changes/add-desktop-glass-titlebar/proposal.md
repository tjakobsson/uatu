# add-desktop-glass-titlebar

## Why

UatuCode Desktop's opaque titlebar slices the SPA's frosted-glass chrome off
at a hard edge: the web content view ends where the native titlebar begins, so
the CSS backdrop blur cannot continue to the top of the window the way
Safari's toolbar does. With the app targeting macOS 26, extending content
under a transparent Liquid Glass toolbar gives the Safari look natively — the
system samples the actual page behind the toolbar. This builds on
`add-system-theme`: with both the page and the native chrome following the
system appearance, they agree in both schemes without any extra contract.

## What Changes

- The desktop window adopts a full-height content layout: the web view spans
  the full window frame, the titlebar is transparent with its title hidden,
  and the toolbar (back/forward, split toggle) floats over the page as Liquid
  Glass.
- The wrapper injects a titlebar-inset contract into the SPA (a CSS variable
  and marker class on the document root, installed as a user script so it
  survives live-reloads), including the current top inset height.
- The SPA, when hosted under a covering titlebar, pads its top-level chrome
  (sidebar header, preview header, terminal panel top) down by the inset so
  sticky headers start below the floating toolbar while scrolled content
  flows beneath it.
- The inset tracks native chrome height changes (e.g. the native tab bar
  appearing when a second tab opens).
- The split-browser pane's tab strip honors the same inset.
- Non-running window states (launcher, starting, failure) render correctly
  under the transparent titlebar.

## Capabilities

### New Capabilities

- `desktop-titlebar-inset`: the wrapper↔SPA contract for content under a
  covering native titlebar — how the inset is announced, how the SPA lays
  out its chrome against it, and how it tracks native chrome height changes.

### Modified Capabilities

- `desktop-macos-shell`: window chrome gains full-size content with a
  transparent, glass-material titlebar/toolbar; window states and native
  tabbing must remain correct under it.

## Impact

- `desktop/macos/UatuCodeDesktop/ContentView.swift` — window styling in the
  existing `WindowResolver` hook; safe-area handling for the hosted web view;
  launcher/failure layouts under the transparent bar.
- `desktop/macos/UatuCodeDesktop/WebViewHost.swift` — user-script injection
  of the inset contract; inset updates on native chrome changes.
- `desktop/macos/UatuCodeDesktop/BrowserSplitView.swift` — split pane top
  inset.
- `src/styles.css` + `src/shell/` — SPA-side inset consumption (top padding
  on chrome surfaces keyed off the marker/variable).
- No server or CLI changes. Browser/PWA behavior unchanged (no marker → no
  inset).
