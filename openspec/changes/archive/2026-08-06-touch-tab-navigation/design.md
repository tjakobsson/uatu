# Design — touch-tab-navigation

## Context

`mobile-experience` shipped the one-surface-at-a-time model gated on "phone-class"
(coarse pointer AND ≤900px): fullscreen terminal promotion, a Files-pane overlay with
a Browse button, exit-fullscreen→minimized routing, and safe-area/visualViewport
plumbing. iPads were excluded and fall through to the desktop layout. The user runs
sessions from iPhone and iPad via the hub and wants the same tab-based interaction on
both — with an iPad escape hatch to the full desktop rendering.

Everything this change needs already exists as machinery: fullscreen surface
promotion (terminal `data-display`, files `data-overlay`), PTY-preserving minimize,
the Rule A user-click distinction, safe-area and visualViewport handling. What's
missing is the chrome that names the surfaces and switches between them.

## Goals / Non-Goals

**Goals:**
- One recognizable navigation chrome (bottom tabs) on iPhone and iPad.
- iPad can flip to the exact desktop-browser rendering and back, persisted.
- No regression of PTY attachment, follow-mode rules, or safe-area behavior.

**Non-Goals:**
- No embedded web-browser surface (the "Browser" concept resolved to the
  desktop-mode escape, not an iframe surface).
- No desktop-layout changes when the mode is `desktop` — that rendering must stay
  byte-for-byte the desktop experience, tab bar absent.
- No per-tab URL routing/deep links (a candidate follow-up).
- No swipe-between-tabs gesture (conflicts with terminal/tree gestures).

## Decisions

### D1: Layout is driven by a persisted UI mode, not media queries

A `data-ui-mode="touch" | "desktop"` attribute on `<html>`, resolved at boot by
`src/shell/ui-mode.ts`: per-device stored override if present, else `touch` when
`(pointer: coarse)` matches, else `desktop`. Layout CSS that `mobile-experience`
keyed on `@media (pointer: coarse) and (max-width: 900px)` re-keys on
`[data-ui-mode="touch"]` — which both extends touch layout to iPads and makes the
desktop escape a one-attribute flip. Input-capability styling and behavior (keybar,
size steppers, scroll-gesture routing) deliberately stay on `(pointer: coarse)`:
an iPad in desktop mode still has no Ctrl key and still needs them. Mode changes
re-render live (attribute flip + refit), no reload required.

### D2: The tab bar is the only navigation chrome in touch mode

Fixed to the bottom edge, padded by `env(safe-area-inset-bottom)`, three tabs with
icon + label: Files, Preview, Terminal. `position: fixed` at the layout viewport's
bottom means the iOS software keyboard simply covers it — the platform convention —
and the terminal keybar (which sits inside the terminal surface above the bar)
remains reachable while typing. The bar carries ONLY the three surface tabs.
The mode switch is a single toggle in the sidebar header — inside the Files tab
in touch mode, beside the sidebar collapse in desktop mode, with a rail variant
when the sidebar is collapsed — shown on every coarse-pointer viewport in both
modes. (The first device pass proved width-gating the return strands the
device: escape in iPad landscape, rotate to portrait, control gone. One
un-gated control in one stable place fixes both the trap and the
discoverability split.) Active tab carries `aria-selected`; the bar is
`role="tablist"`.

### D3: Tabs map onto the existing surfaces — no new surface implementations

- **Files** = the sidebar element promoted fullscreen (the whole pane stack:
  Change Overview, Files tree, whatever panes are visible). This subsumes the
  files-overlay: same DOM, same tree-state continuity guarantee, one fewer
  mechanism. The Browse/close buttons and `data-overlay` machinery retire.
- **Preview** = the main-stack as-is (preview header, document, stacked panes gone
  since the sidebar lives in the Files tab now).
- **Terminal** = the existing fullscreen promotion. Selecting the tab shows the
  panel fullscreen (spawning/attaching exactly as the sidebar toggle does today);
  switching away applies minimize semantics (panes hidden, PTYs attached) with the
  header strip hidden in touch mode — the tab itself is the affordance to return.
  The Esc/fullscreen-button exit routes to the Preview tab instead of `minimized`.

The active tab is session state (`appState.activeTab`), default Preview on boot,
persisted per device so a reload lands where the user left off.

### D4: Document picks switch tabs through the Rule A path

The tree's user-click selection handler (which already distinguishes real clicks
from programmatic updates via `withProgrammaticUpdate`) switches to the Preview tab
after `applyUserRowClick` — replacing the overlay's dismiss-on-pick. Follow-driven
and file-event tree updates never switch tabs, same guarantee as before. Terminal
output arriving while another tab is active MAY badge the Terminal tab (dot, no
count) — nice-to-have, last task, cut first.

### D5: Migration is a re-keying, not a rewrite

The shipped phone-class CSS blocks move from the media condition to
`[data-ui-mode="touch"]` selectors with minimal content change; `isPhoneClassViewport`
becomes the boot-time default heuristic inside ui-mode.ts rather than a live layout
gate; `resolveEffectiveDisplayMode`'s phone-class parameter becomes "touch mode with
Terminal tab active". The archived mobile-experience specs' phone-class requirements
are MODIFIED (not removed) to speak in mode terms — behavior on an iPhone is
unchanged throughout; iPads gain it.

## Risks / Trade-offs

- [The Files tab hosts the whole pane stack, so pane visibility interacts with a
  fullscreen surface] → The stack already renders these panes; the lean defaults
  (Change Overview + Files) keep the tab focused. Pane menu still works inside it.
- [Terminal tab switching relies on minimize-not-detach semantics; a future refactor
  of setVisible could silently detach PTYs on tab switch] → The tab switch path
  MUST NOT call `setVisible(false)`; spec scenario pins PTY attachment across
  switches, e2e-covered.
- [Mode flip on iPad mid-session (touch → desktop) with the terminal fullscreen
  could strand display state] → Mode flip normalizes: terminal returns to its
  stored dock/display, tab state cleared; e2e covers the round-trip.
- [Users with the old per-device `uatu:terminal-visible` / overlay state] → All
  prior state keys remain readable; the overlay key is simply unused. No migration
  needed — localStorage state is per-device and self-heals.
- [Tab bar occupies vertical space on small phones] → ~56px + safe-area, the
  platform-standard cost; the keyboard covering it while typing returns the space
  where it matters most (terminal input).

## Open Questions

- Whether the Preview tab should host the stacked sidebar panes at all (current
  answer: no — Change Overview lives in the Files tab; revisit if it feels buried
  on-device).
- Tab persistence across attach links: should a hub "open terminal" deep link set
  the initial tab? Fits the deferred hub deep-link follow-up, not this change.
