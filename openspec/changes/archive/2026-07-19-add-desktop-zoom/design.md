# Design: add-desktop-zoom

## Context

UatuCode Desktop hosts three kinds of `WKWebView`: the SPA pane
(`WebViewHost`), and one per split-browser tab (`BrowserTab`). None of them
enables `allowsMagnification` (so trackpad pinch does nothing), and the app
defines no zoom menu commands (WKWebView has no built-in keyboard zoom —
Safari implements its own). The explore session settled on model A: one
shared zoom level for the whole app, chosen over focus-routed per-pane
levels (B) and Safari-style per-site persistence (C).

Existing machinery this design builds on:

- `UatuCodeDesktopCommands` (`ContentView.swift`) already exposes per-window
  actions through `WindowCommands` via `focusedSceneValue`.
- `@AppStorage` is already the app's pattern for app-wide preferences
  (`browserSplitWidth`, `recentFolders`) and propagates across windows in
  the same process.

## Goals / Non-Goals

**Goals:**

- Safari-familiar keyboard zoom: ⌘+ / ⌘− / ⌘0 as View-menu commands.
- Trackpad pinch and smart zoom (two-finger double-tap) on every web view.
- One zoom level shared by the SPA pane and all browser tabs, in every
  window, persisted across relaunch.

**Non-Goals:**

- Per-pane or per-site zoom levels (model B/C from the explore session —
  the focus predicate `split.hasFocus(in:)` already exists if B is ever
  wanted; nothing here forecloses it).
- Text-only zoom (no WKWebView API; would need CSS injection).
- Zoom controls inside the uatu web app itself; this is wrapper-only.
- Excluding the embedded terminal from zoom — `pageZoom` scales the whole
  SPA including the xterm.js terminal, and that is intended.

## Decisions

### D1: `pageZoom` for keyboard zoom, `magnification` for pinch

Keyboard/menu zoom sets `WKWebView.pageZoom` — layout zoom that reflows
text, matching Safari's ⌘+/⌘−. Pinch uses WebKit's native
`allowsMagnification = true` — visual zoom that scales without reflow,
matching Safari's pinch. They are independent axes by platform design and
we keep them independent: magnification is per-web-view and transient
(never persisted), `pageZoom` is the shared persisted level.

Alternative considered: driving pinch through `pageZoom` via a custom
gesture recognizer — rejected; reflowing continuously during a pinch is
janky and not what Safari does.

### D2: Shared level in `UserDefaults`, applied by each window

The level lives in one `UserDefaults` key (`pageZoom`, Double, default
1.0), read via `@AppStorage` in `ContentView`. Each window applies it to
its SPA web view and every split-tab web view via `onChange` (plus at web
view creation: `WebViewHost.init` load-time and `BrowserTab.init`). Since
`@AppStorage` observes the shared defaults, changing the level in one
window updates all windows without extra plumbing — same mechanism
`browserSplitWidth` already relies on.

Alternative considered: a dedicated `@Observable` zoom store singleton —
more moving parts for the same behavior; rejected.

### D3: Safari's zoom ladder, clamped

Zoom In/Out step through the Safari ladder
`0.5, 0.75, 0.85, 1.0, 1.15, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0` rather than
multiplying by a factor, so levels are familiar and ⌘0 round-trips exactly
to 1.0. At either end the command clamps (menu item disabled at the
boundary). A persisted value not on the ladder (hand-edited defaults)
snaps to the nearest step on the next zoom command.

### D4: Menu placement and key equivalents

Zoom In (⌘+), Zoom Out (⌘−), Actual Size (⌘0) join the existing
`CommandGroup(after: .toolbar)` in `UatuCodeDesktopCommands`, next to
Reload — that group is the app's View menu. Zoom In additionally answers
⌘= via a hidden menu alias, the standard trick for layouts where `+` is
shifted (US); on layouts with a dedicated `+` key (e.g. Swedish) ⌘+ works
directly. Commands are enabled whenever a window is focused — zoom is
meaningful on the launcher too, but gating on `isRunning` like Reload is
acceptable if simpler; pick one and keep Back/Forward's existing pattern.

### D5: ⌘0 resets both axes

Actual Size sets the shared level to 1.0 **and** resets `magnification`
to 1.0 on the focused window's web views (SPA + all tabs). Pinch zoom has
no other keyboard escape hatch; without this, a stray pinch leaves a pane
cropped with no obvious fix.

## Risks / Trade-offs

- [Zoom scales the embedded terminal along with the docs UI] → Intended
  behavior for model A; if it proves wrong, model B (focus-routed) is the
  upgrade path and `split.hasFocus(in:)` already exists.
- [`pageZoom` applies per web view, so a missed application site shows a
  stale level] → Application is centralized in one `applyZoom()` helper in
  `ContentView` called from `onChange` + tab creation; spec scenario
  covers "new tab inherits".
- [Pinch magnification can leave content panned/cropped] → ⌘0 resets it
  (D5); this matches Safari, where pinch state is also transient.
- [Two windows disagree transiently if defaults change notification lags]
  → `@AppStorage` observation is same-process KVO; lag is imperceptible.
