# Design — fix-desktop-titlebar-regressions

## Context

The glass-titlebar layout (#137) puts the WKWebView under a transparent
titlebar via `.fullSizeContentView` + `.ignoresSafeArea`, floats the toolbar
as glass, and announces the covered height to the SPA as `--titlebar-inset`
on `<html>` (KVO on `contentLayoutRect` in `WebViewHost.bindTitlebarInset`).
The SPA pads its chrome below the inset and paints a `body::before` frost
(blur + tint, `pointer-events: none`, starting at `left: var(--sidebar-width)`)
over the covered strip.

Two regressions are visible on current main:

1. **Titlebar drag is dead over the SPA web view** — the window moves only
   when dragged above the split-browser (SwiftUI) side. Drag was explicitly
   verified when #137 shipped (archive task 1.3), so it broke afterwards.
   The regression window is `ad839fd` (v0.3.0) → main, which contains only
   `00d0072` (git-init preflight, no window/layout surface) and `9d036c3`
   (find/search — reworked the local key monitor, replaced the Edit menu's
   `.textEditing` group, added SPA top-strip UI). A macOS/WebKit update in
   the same window is also possible. Code inspection has already exonerated
   the SPA's `pointerdown` tracker in `src/find/active-surface.ts` (passive,
   no `preventDefault`) and the frost overlay (`pointer-events: none`).

2. **The right-docked terminal smears the titlebar strip.** The rule
   `html.uatu-desktop-host .terminal-panel[data-dock="right"] { padding-top:
   var(--titlebar-inset) }` (from #137) pushes the panel's *content* down,
   but CSS backgrounds paint through padding — the panel's opaque dark
   surface fills the covered strip, and the frost then blurs it into a
   light-to-dark gradient band across the toolbar. The frost's sidebar
   exclusion shows the intended treatment for solid non-scrolling surfaces;
   the terminal column never got the same treatment because dock-right +
   desktop was an unexercised combination.

## Goals / Non-Goals

**Goals:**
- Root-cause and restore titlebar dragging across the full window width.
- Make the covered strip above a right-docked terminal render cleanly:
  panel chrome below the inset, no opaque surface or frost smear in the
  strip, sharp preview/terminal boundary under the toolbar.
- Encode both behaviors in specs so they are regression-proof.

**Non-Goals:**
- No redesign of the glass titlebar, frost recipe, or inset contract.
- No change to dock-bottom terminal layout or to browser/PWA rendering
  (everything stays gated behind `uatu-desktop-host`).
- No changes to find/search behavior itself, even if `9d036c3` turns out to
  be the trigger — the fix must keep its features working.

## Decisions

### D1: Bisect before patching the drag
The drag fix starts with a reproduction and a bisect (`ad839fd` → main,
rebuilding the app per step; only two functional commits, so this is cheap),
plus a check of the same binary on the previously-verified macOS build if
available. Rationale: the plausible mechanisms differ wildly — a SwiftUI
toolbar/`ToolbarSpacer` interaction, the `.textEditing` menu replacement
changing the responder chain, native tab bar visibility, or an OS behavior
change — and patching blind (e.g. bolting on an `NSTitlebarAccessory` drag
view) risks masking the real cause and breaking toolbar hit-testing.

### D2: Fallback if the cause is external (OS/WebKit)
If the bisect shows drag broken at `ad839fd` too (OS change), restore drag
explicitly rather than waiting on Apple: a transparent titlebar-region
drag affordance in the wrapper — an `NSTitlebarAccessoryViewController`
(or equivalent view returning `mouseDownCanMoveWindow = true`) spanning the
titlebar strip, kept *behind* toolbar controls so buttons still win
hit-testing. The alternative — `isMovableByWindowBackground` — is rejected:
it makes every non-interactive page area drag the window, which fights text
selection and terminal drag-selection.

### D3: Terminal strip — stop painting, then stop frosting
Two complementary CSS fixes, both scoped to `uatu-desktop-host`:
1. Keep the panel surface out of the strip: switch the dock-right desktop
   offset from `padding-top` to a treatment where the covered strip is not
   painted by the panel's opaque background (`background-clip: content-box`
   on the panel, or margin-top on the panel with the shell background
   showing through — chosen at implementation time based on which preserves
   the panel's border/rounding and minimized dock-right layout).
2. Exclude the terminal column from the frost the same way the sidebar is
   excluded: cap the frost's `right` edge with a width variable
   (`--terminal-dock-right-width`, maintained alongside the existing panel
   width var) when `body:has(.terminal-panel[data-dock="right"]:not([hidden]))`
   matches. The `:has()` + CSS-variable pattern is already used for the
   sidebar-collapsed case, so this stays idiomatic.
Rationale for doing both: without (1), any gap in the frost shows raw dark
surface under the transparent titlebar; without (2), even a clean strip
gets a visible blur seam at the preview/terminal boundary.

### D4: Spec deltas, not new capabilities
Drag was already a MUST in `desktop-macos-shell`; the delta only adds a
scenario pinning "every horizontal position". The terminal treatment lands
in `desktop-titlebar-inset` (frost exclusion MODIFIED + a new dock-right
requirement) because it is part of the inset contract, not the terminal
feature — `embedded-terminal` stays untouched.

## Risks / Trade-offs

- [Bisect is inconclusive because the bug is intermittent or depends on
  window state (tab bar, split open)] → Reproduce with a fixed recipe
  first (fresh window, no split, terminal closed), and vary one factor at
  a time; record the recipe in the tasks.
- [D2's accessory view steals clicks from toolbar buttons] → Keep the
  accessory at `.fullWidth` behind the toolbar layer and verify every
  toolbar control (back/forward, split toggle, traffic lights) still
  activates; this is an explicit verification task.
- [Frost `right`-cap misses the minimized dock-right terminal rail] →
  The minimized rail is also opaque; the `:has()` selector must match the
  minimized state too, using its actual rendered width.
- [`background-clip`/margin change disturbs dock-right minimized layout or
  the terminal find-bar slot anchoring] → Covered by manual pass over
  dock-right normal/minimized/fullscreen states and the find bar open in
  the terminal.

## Open Questions

- Which commit (or OS update) actually killed the drag — ANSWERED
  (2026-07-28): drag is broken in a clean `ad839fd` (v0.3.0) build too, and
  double-clicking the strip selects page text beneath — the OS now passes
  titlebar-strip mouse events through to the WKWebView (macOS 26 /
  Darwin 25.6.0). No uatu commit is at fault; the fix is the design D2
  affordance (`TitlebarDragArea`), which also restores the spec's "covered
  strip is not interactive" behavior.
- Whether the strip above the terminal should show the shell background or
  the system glass alone; decide visually during implementation, matching
  the sidebar strip's reading.
