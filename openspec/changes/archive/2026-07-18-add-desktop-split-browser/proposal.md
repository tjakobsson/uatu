# In-app split browser with tabs (UatuCode Desktop)

## Why

Opening external links in the system browser tears the user away from the
docs-plus-terminal context UatuCode Desktop exists to hold together. The
links that matter most while reviewing docs — a dev server the embedded
terminal just started, a referenced PR, an upstream doc — should be viewable
*next to* the uatu window content. In a plain web browser this need is
already met by ordinary tabs; the desktop app has no equivalent, so it gets
a first-class one.

## What Changes

- UatuCode Desktop gains a **split browser pane**: a native, resizable
  right-hand split in each window, hosting its own tab strip (custom UI —
  macOS native tabs are window-level and cannot be embedded in a pane),
  with one WebKit page per tab.
- **Default-on (opt-out)**: external `http(s)` links clicked in the uatu UI
  open in the split. A setting ("Open external links in system browser")
  restores the `fix-desktop-external-links` behavior. `⌘`-click always goes
  to the system browser; non-`http(s)` schemes always go to the system.
- Per-tab browser chrome: back/forward/reload, an **editable address bar**
  (URL or search-term entry), and an "open in system browser" eject button.
- Routing: if the exact URL is already open in a tab, focus that tab;
  otherwise open a new focused tab. Clicking a link while the split is
  closed opens the split.
- Browser pages share a **persistent WebKit data store** (logins survive
  relaunch); open tabs are **not** restored across relaunch.

## Capabilities

### New Capabilities

- `desktop-split-browser`: the split pane — lifecycle (open/close/resize),
  internal tab model, per-tab chrome and address bar, link-routing rules,
  data-store persistence.

### Modified Capabilities

- `desktop-macos-shell`: the external-link requirement added by
  `fix-desktop-external-links` changes — default target becomes the split
  browser; system browser becomes the opt-out and the `⌘`-click/eject
  escape hatch. Menu gains split-related commands (toggle split, close tab).

## Impact

- Depends on `fix-desktop-external-links` (link interception + the
  WebPage-vs-WKWebView spike outcome).
- `desktop/macos/UatuCodeDesktop/` — new split/tab views and state, settings
  (`AppStorage`), menu commands; touches the window layout around the
  existing `WebView`.
- No uatu server or `src/` web-app changes; the split is native and invisible
  to the web layout (sidebar/terminal panes are unaffected inside a narrower
  WebView).
- New persistent state: a shared `WKWebsiteDataStore` for browser tabs.
