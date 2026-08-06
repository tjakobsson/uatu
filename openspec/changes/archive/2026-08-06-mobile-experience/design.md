# Design — mobile-experience

## Context

At ≤900px `styles.css` switches the app shell to a stacked, body-scrolling layout
(`.app-shell { height: auto }`, sidebar above preview). The terminal panel is a child
of `.main-stack` (grid-area: preview), so its fullscreen mode — `position: absolute;
inset: 0` — covers only the preview region. On a phone that means "fullscreen" is a
strip somewhere down a scrolling page. The panel's display mode
(`normal | minimized | fullscreen`) and dock persist in localStorage
(`pane-state.ts`), which is per-device — a fresh phone always starts with the
terminal closed and `normal`.

Precedent to build on: `panel.ts` already forces right-dock back to bottom-dock below
`TERMINAL_RIGHT_DOCK_VIEWPORT_MIN` while *preserving* the stored preference, and the
keybar (`keybar.ts`) is a pure data table (`KEYBAR_KEYS`) whose visibility is
CSS-owned via `@media (pointer: coarse)`.

Strategic constraint (recorded here so it shapes details): a future iPhone app cannot
spawn a local server (iOS forbids the macOS wrapper's model), so it will be a thin
native shell (WKWebView) over this same web UI served by the hub. Everything built
here must therefore work inside WKWebView and remain the app's UI later. Prefer
CSS/data-attribute-owned behavior over JS sniffing so a native shell can adjust
presentation without forking the frontend.

## Goals / Non-Goals

**Goals:**
- Terminal is a first-class, genuinely full-viewport surface on phones.
- The iOS software keyboard never hides the prompt line.
- The keybar makes shells and TUIs actually drivable from a software keyboard.
- All behavior works identically in Safari, installed PWA, and WKWebView.

**Goals (file navigation):**
- The file tree is a usable, full-height browsing surface on phones.
- Picking a document hands off to the preview — one surface at a time.

**Non-Goals:**
- No hub-side changes (deep links, session pages) — follow-up change.
- No native iPhone shell — follow-up project.
- No phone redesign of the sidebar/preview reading experience; the stacked layout
  stays as-is when the terminal is not fullscreen.
- No press-and-hold key repeat on keybar arrows (nice-to-have, deferred).

## Decisions

### D1: Phone-class = narrow viewport AND coarse pointer

Phone mode applies when `(pointer: coarse)` and viewport width is below the existing
900px stacking breakpoint. Coarse-only would catch iPads in landscape (which the
current desktop-style layout serves fine); width-only would catch narrow desktop
windows (which must keep dock/resize affordances). In JS, detection uses one
`matchMedia` query kept in `panel.ts`; in CSS the same condition guards the phone
rules. Alternative considered: a `data-phone` attribute stamped on `<html>` at boot —
rejected because orientation changes mid-session must re-evaluate it; live
`matchMedia`/media-query evaluation handles rotation for free.

### D2: Fullscreen goes `position: fixed` on phones only

Desktop fullscreen keeps its current meaning (cover the preview area, sidebar
visible) — that requirement stands. Under the phone media condition,
`[data-display="fullscreen"]` becomes `position: fixed; inset: 0; height: 100dvh`
with `body` scroll locked (`overflow: hidden` via a `:has()` guard, matching the
existing `:has()` usage for right-dock). `dvh` not `vh`: iOS Safari's collapsing URL
bar makes `vh` overshoot. Alternative — restructure the mobile grid so `.main-stack`
itself fills the viewport — rejected: it reflows the whole reading layout for a
terminal-only need.

### D3: Auto-promote to fullscreen on phone, preserve stored preference

When the panel opens (or the viewport crosses into phone-class) the *effective*
display mode is forced to fullscreen; the stored preference is not overwritten,
exactly like the right-dock → bottom-dock fallback in `panel.ts`. Exiting fullscreen
on a phone minimizes the panel (header-bar strip) rather than entering `normal` —
a 240px `normal` strip at the bottom of a scrolling page is the state this change
exists to eliminate. Rotating an iPhone to landscape or attaching from desktop later
sees the stored preference unchanged.

### D4: Size the fullscreen panel to `visualViewport`, not the layout viewport

On phones, `panel.ts` subscribes to `window.visualViewport` `resize`/`scroll` events
and sets the panel height to `visualViewport.height` (as an inline CSS custom
property), then triggers the existing xterm fit path. This is the only reliable
cross-WebKit signal for software-keyboard geometry. The subscription is active only
while phone-fullscreen; desktop keeps the current ResizeObserver-driven fit.
Alternative — the CSS `interactive-widget=resizes-content` viewport key — rejected:
inconsistent iOS support, and we need the resize hook to refit xterm anyway.

### D5: Safe areas via `viewport-fit=cover` + inset padding

`index.html`'s viewport meta gains `viewport-fit=cover`. The fullscreen panel pads
by `env(safe-area-inset-top/left/right)`; the keybar pads bottom by
`env(safe-area-inset-bottom)` so it clears the home indicator (also where
accidental swipe-to-home lives). Insets are zero on non-notched devices and in
desktop browsers, so no scoping is needed beyond the fullscreen rules.

### D6: Keybar grows keys as data; sticky Ctrl is a latch that composes in the client

New `KEYBAR_KEYS` entries: PgUp `\x1b[5~`, PgDn `\x1b[6~`, Home `\x1b[H`,
End `\x1b[F`. Two non-sequence buttons get their own affordance type in the keybar
model (the current type only carries a raw sequence):

- **Paste** — reads `navigator.clipboard.readText()` in the tap's user-gesture
  context (iOS shows its permission callout) and writes the text through the same
  `sendToActivePane` path. Reuses `clipboard.ts` helpers. On rejection (denied or
  empty), the tap is inert — same convention as tapping a key with no active pane.
- **Sticky Ctrl** — a single-shot latch. Tap arms it (visual pressed state +
  `aria-pressed`); the next printable character from xterm's input path is composed
  to its control character (`char.toUpperCase().charCodeAt(0) & 0x1f`) and the latch
  releases. Tap again while armed to cancel. The composition hook lives in the
  client's input path (where typed data is forwarded to the PTY), not in the keybar,
  which stays a dumb button row. No double-tap caps-lock mode — single-shot covers
  ^R/^A/^E/^W/^L and stays predictable.

Keybar layout: the row already has `overflow-x: auto`; with ~15 keys it scrolls
horizontally on narrow screens. Ordering puts the highest-frequency keys first
(esc, tab, ctrl, ^C, paste, arrows, then paging/home/end, then ^D/^Z).

### D7: Phone header hides geometry controls with CSS only

Split, dock-toggle, and the resize handle are hidden under the phone media condition
via CSS; minimize, fullscreen-toggle, and close remain. No JS branches — the buttons
are simply not visible, and their keyboard shortcuts remain harmless (dock changes
are already viewport-guarded by D3/existing fallback logic).

### D8: One-surface-at-a-time is the phone navigation model

On phone-class viewports the app presents exactly one primary surface: the file
browser, the preview, or the fullscreen terminal. The desktop metaphor being escaped
is pane *stacking* — 45vh slices of sidebar panes above a preview. This model is why
the terminal exits to minimized (D3) rather than a docked strip, and why the Files
pane becomes an overlay (D10) rather than a taller stacked pane. Change Overview
remains a stacked pane above the preview (it is glanceable summary, not a working
surface); the Files pane header remains in the stack as the browser's entry point.

### D9: Fix the tree collapse with an explicit phone height, not by fighting virtualization

Root cause: `@pierre/trees` sizes its virtualization viewport from a ResizeObserver
on `.tree` (`flex: 1 1 auto; min-height: 0`), which requires *allocated* height; the
≤900px stacked layout switches panes to content-driven sizing
(`flex-basis: auto !important`), and a virtualized tree has no intrinsic content
height — it collapses to about one row. The fix gives the Files `.pane-body` an
explicit height in the stacked layout (the existing `max-height: 45vh` becomes a
real height for this pane), which repairs the *stacked* rendering independently of
the browser overlay. The overlay (D10) then supersedes it as the primary phone
browsing surface. Alternative — teach the virtualized tree an intrinsic height —
rejected: that reaches into library-owned behavior (`document-tree` capability
boundary) for a layout problem the pane shell owns.

### D10: The phone file browser is the Files pane promoted to a fixed overlay

Tapping the Files pane (its header, or the collapsed tree region) on a phone-class
viewport promotes the pane to a full-viewport overlay: `position: fixed; inset: 0`,
same `dvh` + safe-area treatment as the terminal (D2/D5), with a close affordance in
its header. It is the same pane DOM promoted via a data attribute (mirroring the
terminal's `data-display` pattern) — not a second tree instance — so tree state
(expansion, selection, filter chip, follow-mode highlighting) is continuous, and
`TreeView.withProgrammaticUpdate` semantics are untouched. When a document is picked
(the tree's select callback for a real user click — the follow-mode Rule A path),
the overlay dismisses and the preview is scrolled into view. Directory
expand/collapse taps keep the overlay open. Alternative — a separate phone-only
browser component — rejected: duplicated tree wiring, duplicated follow-mode rules,
and drift risk.

### D11: The preview header stacks on width alone, not phone-class

`.preview-header` lays heading and toolbar on one flex row with
`.preview-toolbar { flex-shrink: 0 }` — on a 390px portrait iPhone the toolbar
crushes the title; at 844px landscape there is room. Because the failure is purely
width-driven (a narrow desktop window crams identically), the fix keys on a plain
width media query (~640px, tuned so iPhone portrait stacks and iPhone landscape does
not) rather than the phone-class (coarse + width) condition used elsewhere. Below
it, the header becomes a column: heading first, toolbar on its own row, toolbar
allowed to wrap. Sticky-header behavior and the blur fade are untouched — only the
inner flex direction changes. Alternative — shrink controls to icons-only on narrow
widths — rejected: the Rendered/Source/Diff segmented control's labels are the
control; two rows cost little under a sticky header.

### D12: Rail toggles are second presentations, not second controls

The collapsed rail currently holds only the expand button; Follow and Terminal are
reachable only in the expanded sidebar or via keyboard shortcuts (⌃`), which
software keyboards cannot produce — on an iPad (desktop-like layout, phone-like
keyboard) a collapsed sidebar locks both capabilities out. The rail gains two icon
buttons that call the exact same handlers as the expanded controls (the Follow
chip's toggle path, the sidebar Terminal row's toggle path) — no parallel state, no
new events. `aria-pressed` mirrors the same booleans. This holds the follow-mode
spec's single-representation intent by construction: chip and rail icon are
mutually exclusive presentations of one toggle, never visible together. Applies on
every pointer type — a collapsed rail on desktop has the same gap, just with a
keyboard escape hatch. Note the iPad keyboard limitation itself needs no new work
beyond this: the terminal keybar (and its sticky Ctrl / paste additions) already
targets all coarse-pointer devices, iPad included.

### D13: Font size becomes a runtime, per-device stepper on touch surfaces

Touch browsers have no Cmd+/− and pinch zoom scales the whole layout — today there
is *no* way to change text size on iPhone/iPad. Two steppers, both A−/A+ buttons,
both coarse-pointer-only (desktop keeps its clean chrome; it has browser zoom and
`.uatu.json`):

- **Terminal**: in the panel header. Applies live via xterm's `options.fontSize` +
  refit across all panes. Precedence: per-device runtime override (localStorage) →
  `.uatu.json terminal.fontSize` → default 13, clamped to the same range the config
  loader already validates. The stored value is the resolved size, so a config
  change under an override is simply shadowed until the user resets (stepping back
  to the config value clears the override).
- **Preview**: in the action bar. Steps a CSS custom property scaling document
  content only (the preview body — not app chrome), roughly 85%–150% in ~7 steps,
  persisted per device. This is a *text-size* control, not zoom: layout reflows.

Alternative — pinch-gesture font sizing on the terminal — deferred: it collides
with touch scrolling (D14) on the same surface and needs gesture disambiguation;
the buttons ship first and pinch can layer on later.

### D14: Alternate-screen swipes become arrow keys

xterm's viewport already touch-scrolls *scrollback*, so plain shells scroll by
swipe today. TUIs run on the alternate buffer, which has no scrollback — swipes hit
nothing, and without a mouse there is no scroll at all (the core reason PgUp/PgDn
were requested; both land in the keybar per D6). The fix is the touch analogue of
xterm's wheel alternate-scroll (DECSET 1007): a touch handler on the pane that,
when the active buffer is the alternate one, converts vertical swipe distance —
quantized by cell height — into repeated arrow-up/down sequences, honoring
application cursor-key mode (`\x1b[A/B` vs `\x1bOA/OB`). Normal-buffer swipes are
untouched (xterm keeps them). Horizontal swipes are ignored. The handler is a pure
translation function (buffer type, swipe delta, cell height, DECCKM state → byte
sequence list) with colocated unit tests; the DOM listener is thin.

## Risks / Trade-offs

- [visualViewport events are quirky across iOS versions — height can lag the
  keyboard animation] → Refit on both `resize` and `scroll`, and do a final fit on
  `focusin`/`focusout` of the xterm textarea; accept transient one-frame gaps.
- [Sticky Ctrl composition intercepts the client input path — a bug could corrupt
  typed input for everyone] → The hook is a pure function on (latched, data) with
  colocated unit tests; when not latched it must be an identity pass-through.
- [iOS smart punctuation / autocapitalize may mangle shell input in ways this change
  doesn't address] → Out of scope but verified during e2e device testing; if xterm's
  textarea attributes need hardening it's a one-line follow-up.
- [`:has()`-guarded body scroll lock leaks if the panel is removed abnormally] →
  `:has()` is state-derived from the live DOM attribute, so there is no imperative
  lock to leak — this is why the lock is CSS-owned.
- [Promoting the live Files pane to an overlay could confuse the pane-stack height
  allocator (`panes.ts` distributes sidebar height across visible panes)] → While
  promoted, the pane is taken out of stack allocation the same way a hidden pane is;
  demotion restores it. Unit-test the allocator with a promoted pane present.
- [Dismiss-on-pick could misfire on follow-mode programmatic selections (Rules C/D
  fire the same select callback)] → Dismissal keys off the user-click path that
  `TreeView.withProgrammaticUpdate` already distinguishes; programmatic updates never
  close the overlay. Covered by an e2e case with a file event while the browser is
  open.
- [Swipe-to-arrow could fight xterm's own touch handling or text selection] → The
  handler only intervenes when the alternate buffer is active (xterm does nothing
  there today); long-press selection gestures are distinguished by xterm before the
  scroll threshold; verified on-device in the manual pass.
- [Playwright cannot fully emulate the iOS software keyboard] → E2E asserts the
  layout/latch/fallback logic under device emulation (viewport + touch); the
  visualViewport resize path gets unit coverage with a stubbed viewport object, and
  real-device verification is a manual release-checklist item.

## Open Questions

- Should minimized-on-phone show a persistent floating re-open affordance instead of
  the header strip at the bottom of the scrolled page? Deferred until the strip is
  tried on a device.
- Whether the future native shell should announce itself (query param or UA hint) so
  the frontend can hide the PWA install affordance inside the app — decided in the
  native-shell change, but noted here as the reason phone behavior stays
  CSS/data-attribute-owned.
