# add-desktop-glass-titlebar Design

## Context

Today the wrapper is a stock SwiftUI `WindowGroup`: the WKWebView starts
below an opaque titlebar/toolbar, so the SPA's frosted-glass headers get cut
at a hard edge. The wrapper already resolves the raw `NSWindow` per window in
`ContentView`'s `WindowResolver` hook (used for tabbing identifiers and
server binding), which is the natural place for window styling. The
deployment target is macOS 26, so the toolbar is Liquid Glass: once content
extends beneath it, toolbar items float as glass capsules and the system's
scroll-edge effect samples the real page — the Safari look comes from the
platform, not from CSS.

`add-system-theme` lands first: with the SPA and the native chrome both
following the system appearance, the glass toolbar and the page agree in both
schemes with no wrapper↔SPA theme contract.

macOS WKWebView does not populate `env(safe-area-inset-top)` from the
titlebar, so the page cannot discover the covered strip on its own — the
wrapper must tell it.

## Goals / Non-Goals

**Goals:**
- Web content spans the full window frame; titlebar transparent; toolbar as
  floating glass — in every window state and with native tabs.
- A minimal, reload-proof inset contract so the SPA's own chrome clears the
  native chrome while scrolled content flows beneath it.
- Zero behavior change for browser/PWA users.

**Non-Goals:**
- A manual theme switch or any theme signaling from page to wrapper (the
  system-follow model makes it unnecessary; a future manual switch would
  reopen this).
- Hiding the native toolbar entirely or moving navigation into the page.
- Windows/Linux wrappers (none exist; the contract is named generically so a
  future host could reuse it).

## Decisions

### 1. Window styling via the existing `WindowResolver` hook

In the resolver: insert `.fullSizeContentView` into `styleMask`, set
`titlebarAppearsTransparent = true` and `titleVisibility = .hidden`. The
hosted web view ignores the top safe area so it truly spans the frame.
Rationale: the hook already runs once per resolved window (and re-runs
safely), keeping all NSWindow mutation in one place. Alternative — SwiftUI
`.windowStyle(.hiddenTitleBar)` at the scene — styles every window of the
group identically and offers less control over re-application timing with
native tabbing; the AppKit route matches how the wrapper already works.

The toolbar keeps its default macOS 26 glass appearance; we do not hide its
background. The system scroll-edge effect over real content is the desired
Safari-like visual.

### 2. Inset contract: document-start `WKUserScript` + live updates

A `WKUserScript` (document start, main frame) sets on `<html>`:
- class `uatu-desktop-host`
- `--titlebar-inset: <N>px`

Document-start injection is the reload-proof mechanism — the SPA's
live-reload reloads the page, and query parameters can be lost across
SPA-internal history navigation. The initial `N` is computed from the
window's `contentLayoutRect` (frame height minus content layout height),
which accounts for titlebar + toolbar and, when present, the native tab bar.

For live changes (tab bar appears/disappears), the wrapper observes
`contentLayoutRect` on the window and pushes updates via
`evaluateJavaScript`, updating the same custom property. The user script's
baked-in value is refreshed whenever the observed value changes so the next
reload starts correct.

Alternative considered: standard Window Controls Overlay env vars
(`titlebar-area-*`) — not available in WKWebView; this contract is the same
idea hand-rolled, and deliberately tiny.

### 3. SPA-side consumption is pure CSS

`html.uatu-desktop-host` rules add `padding-top: var(--titlebar-inset, 0px)`
to the top-level chrome containers (sidebar pane, preview pane's sticky
header offset, split of the app grid — exact containers determined against
the real layout). No JS on the SPA side; absence of the class is the
browser/PWA no-op path. The sticky `top: 0` headers become
`top: var(--titlebar-inset, 0px)` where needed so the frost zone starts
below the toolbar and scrolled content passes beneath the native glass.

### 4. Split pane inset in SwiftUI

The split-browser pane is native SwiftUI beside the web view; its tab strip
gets top padding from the same resolved inset value rather than a hardcoded
constant, so it also tracks the tab-bar case.

### 5. Non-running states: keep layouts clear of the bar

Launcher/starting/failure views are centered layouts; they gain top padding
equal to the inset so nothing collides with traffic lights or the nav pill.
Cheap and robust rather than clever.

## Risks / Trade-offs

- [Native tab bar heights differ across appearance/settings, so a wrong
  inset overlaps chrome] → Derive the inset from `contentLayoutRect` (ground
  truth) rather than a constant; observe it for changes.
- [Clicks in the covered strip go to the titlebar, surprising users if the
  SPA parks controls there] → The inset contract exists precisely to keep
  interactive chrome out of that strip; spec scenario covers it.
- [SwiftUI toolbar + fullSizeContentView interactions can be finicky across
  OS point releases] → Keep the AppKit mutations minimal and centralized;
  verify on the edge-channel build (nightly dogfood) before release.
- [Glass over arbitrary page colors can reduce toolbar-control contrast] →
  macOS 26 glass adapts tint automatically; system-theme landing first keeps
  page top regions in system-consistent palettes.
- [E2E can't cover native window chrome] → Wrapper behavior is verified
  manually and via the desktop CI build; the SPA-side contract (class +
  variable → padding) is e2e-testable by injecting the marker.

## Open Questions

- Whether the preview pane's frost falloff needs retuning once the native
  glass sits above it (two stacked blurs) — visual call during
  implementation.
