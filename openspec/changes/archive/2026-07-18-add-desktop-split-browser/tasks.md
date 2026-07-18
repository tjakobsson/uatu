# Tasks — add-desktop-split-browser

## 1. Split pane scaffold

- [x] 1.1 Add a `BrowserSplitState` model per window (open/closed, width,
      `[BrowserTab]`, selected index) and a persistent shared
      `WKWebsiteDataStore` (identifier-based, separate from the uatu
      WebView's store)
- [x] 1.2 Wrap the existing hosting view in a resizable split layout;
      right pane renders the browser surface when open, uatu pane fills
      the window when closed
- [x] 1.3 Add "Toggle Split Browser" (`⌘⇧B`) to `UatuCodeDesktopCommands`,
      disabled without a running server

## 2. Tabs and chrome

- [x] 2.1 Build the custom tab strip (title, close button, overflow
      scrolling); keep unselected tabs' pages alive; closing the last tab
      closes the split
- [x] 2.2 Build the per-tab chrome row: back/forward/reload wired to the
      tab's page, plus the eject (⧉) control (open in system browser +
      close tab)
- [x] 2.3 Implement the editable address bar: URL/bare-host input loads
      (prefix `https://`), other input searches via the default engine
      chosen in design D4
- [x] 2.4 Route `⌘W` / `⌘[` / `⌘]` by focused surface (browser tab vs uatu
      pane / native window tab)

## 3. Link routing

- [x] 3.1 Add the `AppStorage` opt-out setting ("Open external links in
      system browser") as a menu toggle
- [x] 3.2 Redirect the `openExternally` `http(s)` branch from
      `fix-desktop-external-links` through the D3 routing rules (opt-out →
      system; `⌘`-click → system; exact-URL dedup → focus tab; split
      closed → open split; else new focused tab)
- [x] 3.3 Detect `⌘`-click at the interception point so it bypasses the
      split even when in-app routing is on

## 4. Verify and wrap up

- [x] 4.1 Manually verify each spec scenario: first-link opens split,
      dedup focuses tab, ⌘-click escapes, opt-out restores system
      behavior, terminal OSC 8 links route to the split, mailto goes to
      system, login survives relaunch, tabs do not
- [x] 4.2 Confirm no regressions in native window tabs (`⌘1`–`⌘9`,
      Control-Tab, Window menu) with the split open
- [x] 4.3 Build desktop app locally (`bun run build` + Xcode build) and
      update `ARCHITECTURE.md`'s wrapper section with the split-browser
      surface
