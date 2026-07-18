# Design — fix-desktop-external-links

## Context

UatuCode Desktop hosts the uatu SPA in SwiftUI's `WebPage`/`WebView`
(macOS 26 API). Two behaviors are broken or missing:

1. External links are dead. The web app emits them correctly
   (`target="_blank"` + `rel="noopener noreferrer"` from
   `src/render/external-links.ts`; xterm.js OSC 8 activation calls
   `window.open()`), but new-window navigations require host cooperation in
   WebKit, and the wrapper provides none — WebKit silently drops them.
2. No Back/Forward. uatu is an SPA with real history (`src/shell/history.ts`
   uses `pushState`, so WebKit's back-forward list has entries); a browser
   exposes buttons for it, the desktop window doesn't.

Constraint: the wrapper↔CLI contract (URL on stdout, SIGTERM, stdin-EOF) and
the web app itself should not change. This is a wrapper-only fix.

## Goals / Non-Goals

**Goals:**
- Every external-link activation inside the WebView reaches the system
  (default browser for `http(s)`, system handler for other schemes).
- Back/Forward for the embedded SPA via menu (`⌘[` / `⌘]`) and toolbar.
- Establish the interception point that `add-desktop-split-browser` will
  later redirect into an in-app pane.

**Non-Goals:**
- No in-app browser surface (that is `add-desktop-split-browser`).
- No settings/preferences UI — behavior is unconditional in this change.
- No changes to `src/` (web app) or the server.

## Decisions

### D1: Where to intercept new-window navigations (spike)

In WKWebView terms, `target="_blank"` / `window.open()` arrives at
`WKUIDelegate.webView(_:createWebViewWith:for:windowFeatures:)`, not the
navigation delegate. The open question is whether the SwiftUI `WebPage` API
surfaces an equivalent hook.

- **Preferred**: stay on SwiftUI `WebPage` if it exposes new-window
  navigation (via its navigation-deciding hook or a popup/dialog API).
  Verify by clicking a rendered-doc external link and a terminal OSC 8 link.
- **Fallback (guaranteed to work)**: replace `WebView(page)` with a
  `WKWebView` in an `NSViewRepresentable`, set a `WKUIDelegate` whose
  `createWebViewWith` calls `NSWorkspace.shared.open(url)` and returns `nil`.
  This is the well-trodden escape hatch; it also gives full control later
  for the split browser.

The spike resolves D1 before any other task; whichever hosting approach wins
becomes the routing point the split-browser change builds on.

**Spike outcome (resolved 2026-07-18):** the fallback wins. Inspection of the
macOS 26 SDK's WebKit swiftinterface shows `WebPage.NavigationDeciding`
receives `NavigationAction.target: FrameInfo?` (nil = new window), so it
could intercept `target="_blank"` anchors — but the API has no equivalent of
`WKUIDelegate.createWebViewWith` and `DialogPresenting` covers only JS
dialogs/file pickers, so `window.open()` is dropped before any hook fires.
xterm.js activates OSC 8 links via `window.open(url, "_blank", "noopener")`,
so terminal links cannot work on `WebPage`. The wrapper therefore hosts the
SPA in a `WKWebView` via `NSViewRepresentable`: `createWebViewWith` routes
the URL and returns nil (catches both `window.open` and `target="_blank"`),
with a navigation-delegate `targetFrame == nil` check as belt and braces.

### D2: Scheme routing

All intercepted URLs go through one function: `http`/`https` →
`NSWorkspace.shared.open` (default browser); anything else (`mailto:`,
editor schemes) → `NSWorkspace.shared.open` as well, which resolves the
registered handler. Centralizing now means `add-desktop-split-browser` only
changes this one function's `http(s)` branch.

### D3: Back/Forward drives WebKit history, not app-invented state

`pushState` entries populate the page's back-forward list, so native
Back/Forward buttons simply call the page's `goBack()`/`goForward()` and
disable off `canGoBack`/`canGoForward`. No coupling to uatu's internal
history module; the SPA's `popstate` handling (`src/shell/history.ts`)
already restores selection.

### D4: Chrome placement

Menu: Back/Forward in the existing `UatuCodeDesktopCommands` View/History
area with `⌘[` / `⌘]`, disabled when unavailable (mirrors "Reload Page").
Toolbar: back/forward buttons on the window toolbar next to the title.

## Risks / Trade-offs

- [SwiftUI `WebPage` may not expose new-window navigations] → the WKWebView
  representable fallback is scoped into the spike task; cost is a modest
  rewrite of the hosting view, not of the app.
- [Dropping to WKWebView loses `WebPage` observability conveniences]
  → keep the representable thin; expose only canGoBack/canGoForward/URL as
  published state.
- [`window.open` from scripts with no user gesture could spam the system
  browser] → uatu's own UI only opens on user activation; acceptable.

## Open Questions

- None blocking; D1 is a spike with a defined fallback, resolved as the
  first task.
