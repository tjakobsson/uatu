# Design — add-desktop-split-browser

## Context

`fix-desktop-external-links` gives UatuCode Desktop a single interception
point where new-window navigations leave the WebView, currently routed to
the system browser. This change redirects that routing (by default) into an
in-app browser surface so external content — a dev server started in the
embedded terminal, a referenced PR, upstream docs — stays next to the uatu
window content.

Decisions already made during exploration (2026-07-18):

- The surface is a **split pane with its own internal tabs**, not native
  window tabs. macOS native tabs are window-level (`NSWindow` tab groups)
  and cannot be embedded inside a pane, so the tab strip is custom SwiftUI.
- **Opt-out, not opt-in**: in-app is the default; a setting restores
  system-browser behavior.
- **Editable address bar** — the pane acts as a browser, not just a link
  viewer.
- **Persistent login state, ephemeral tabs**: cookies/logins survive
  relaunch; the set of open tabs does not.

## Goals / Non-Goals

**Goals:**
- Per-window, resizable, closable right-hand split hosting N browser tabs.
- Default routing of external `http(s)` links into the split; predictable
  escape hatches to the system browser.
- Enough chrome per tab to act as a browser: back/forward/reload, editable
  address bar with search fallback, eject to system browser.

**Non-Goals:**
- No browser-grade features: no downloads UI, extensions, profiles,
  bookmarks, or tab restore across relaunch.
- No changes to the uatu web app or server; the split is native and
  invisible to the web layout (`src/` untouched).
- No framing/iframe approach — the split is a top-level WebKit context, so
  `X-Frame-Options`/`frame-ancestors` do not apply.

## Decisions

### D1: Surface shape — split with custom tab strip

One split per uatu window, docked right, native resizable divider
(SwiftUI `HSplitView`-style layout around the existing hosting view).
Inside: custom tab strip → per-tab chrome row → WebKit view. Native window
tabs were considered and rejected: they cannot nest inside a pane, and a
second whole-window surface duplicates what the system browser already does.

### D2: Tab model

The split owns `[BrowserTab]` (ordered) + selected index, where each tab
wraps its own WebKit page. Unselected tabs stay alive (no reload on
switch); each page keeps its own back-forward list. Closing the last tab
closes the split.

### D3: Link routing

```
external http(s) link activation (from the fix-desktop-external-links hook)
  ├─ setting "open in system browser" ON  → system browser
  ├─ ⌘-click                              → system browser (always)
  ├─ exact URL already open in a tab      → focus that tab
  ├─ split closed                         → open split, new focused tab
  └─ otherwise                            → new focused tab
non-http(s) scheme                        → system handler (always)
```

Duplicate detection is exact-URL match — dumb and predictable; no
same-origin cleverness in v1.

### D4: Address bar semantics

Editable, per tab. On commit: parseable-as-URL input (has a scheme, or
looks like a host) loads directly, `foo.example` gets `https://` prefixed;
anything else becomes a search query against a default engine. Engine
choice is an Open Question; hardcode one initially rather than building
settings UI for it.

### D5: Persistence

All browser tabs share one persistent `WKWebsiteDataStore` (identifier-based
store, distinct from the uatu WebView's default store) so logins survive
relaunch. Open tabs, selection, and per-tab history are NOT restored across
relaunch — each app session starts with the split closed. Split width and
open/closed state per window follow the pattern of other per-window state.

### D6: Opt-out setting

`AppStorage` bool ("Open external links in system browser"), exposed as a
menu toggle. App-level, not per-project — `.uatu.json` was considered and
rejected: a project file should not decide desktop window behavior.

### D7: Menu/command surface

Toggle Split Browser (`⌘⇧B`), Close Tab routes to the split's selected tab
when the split has focus (`⌘W` otherwise keeps closing the window tab —
focus-dependent, matching macOS convention). Eject button (⧉) on the chrome
row opens the current tab's URL in the system browser and closes the tab.

## Risks / Trade-offs

- [Embedded WebKit lacks the user's browser profile — OAuth/login pages may
  behave poorly] → persistent data store makes logins one-time; ⌘-click and
  eject cover pages that refuse embedded contexts entirely.
- [`⌘W`/`⌘[`,`⌘]` ambiguity between uatu pane and browser tabs] → resolve by
  focus: shortcuts act on the focused surface; needs explicit focus
  handling in the split.
- [Split + uatu's own web layout (sidebar, right-docked terminal) can get
  cramped] → the web app is unaware by design; users resize or close the
  split. Revisit only if real usage hurts.
- [Custom tab strip is bespoke UI to maintain] → keep it minimal (title,
  favicon optional, close button, overflow scrolling).

## Migration Plan

Ships behind the default-on routing change; flipping the opt-out setting
restores exactly the `fix-desktop-external-links` behavior, so rollback is
a setting, not a code path.

## Open Questions

- Default search engine for address-bar search fallback (D4) — pick at
  implementation time (candidate: DuckDuckGo, no API key or tracking
  params needed).
- Whether the split's width/open-state should persist per window tab or
  per app — decide during implementation, mirroring whatever the terminal
  panel convention feels like from the desktop side.
