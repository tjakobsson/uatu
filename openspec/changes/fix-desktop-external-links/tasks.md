# Tasks — fix-desktop-external-links

## 1. Spike: new-window interception point (design D1)

- [x] 1.1 Verify whether SwiftUI `WebPage` surfaces `target="_blank"` /
      `window.open()` navigations (test with a rendered-doc external link
      and a terminal OSC 8 link); record the outcome in design.md
- [x] 1.2 If `WebPage` cannot intercept: replace `WebView(page)` hosting in
      `ContentView.swift` with a thin `WKWebView` `NSViewRepresentable`
      exposing load/reload/back-forward state, with a `WKUIDelegate` whose
      `createWebViewWith` returns `nil`

## 2. External-link routing

- [x] 2.1 Add a single `openExternally(_ url: URL)` routing function
      (`NSWorkspace.shared.open`) and call it from the interception point
      for all new-window navigations
- [ ] 2.2 Manually verify: rendered-doc external link, terminal OSC 8 link,
      and a `mailto:` link each reach the correct system handler; uatu
      window state is untouched

## 3. Back/Forward chrome

- [x] 3.1 Expose `canGoBack`/`canGoForward` + `goBack()`/`goForward()` from
      the hosting view and wire them into `WindowCommands`
- [x] 3.2 Add Back (`⌘[`) and Forward (`⌘]`) menu commands in
      `UatuCodeDesktopCommands`, disabled when unavailable or no server runs
- [x] 3.3 Add back/forward toolbar buttons to the window
- [ ] 3.4 Manually verify: selecting doc A then doc B then Back restores A
      (SPA `popstate` path), Forward restores B, controls disable at edges

## 4. Wrap up

- [ ] 4.1 Run desktop CI checks locally (build via `bun run build` +
      Xcode build) and confirm no regressions in tab/window behavior
- [x] 4.2 Update `ARCHITECTURE.md` wrapper section if the hosting view
      changed (WebPage → WKWebView representable)
