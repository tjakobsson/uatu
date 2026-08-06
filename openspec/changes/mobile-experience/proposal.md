# Mobile Experience

## Why

Attaching to a session through the uatu hub from a phone is the natural "check on my
running agent" flow, but the current ≤900px layout was designed for stacked *reading*:
the terminal renders as a ~240px strip at the bottom of a long body-scrolling page,
below the entire sidebar, and the existing fullscreen display mode only covers the
preview grid area — it does not pin to the viewport on phones. On top of that, the iOS
software keyboard covers roughly half the screen without the terminal resizing, and the
touch keybar lacks keys phone users need constantly (PgUp/PgDn, Home/End, paste, Ctrl
combos beyond the three hardcoded ones).

The file tree is effectively unusable on phones for a structural reason: the Files
pane's virtualized tree derives its height from allocated flex space, but the stacked
mobile layout sizes panes to their content — a virtualized tree has no intrinsic
content height, so it collapses to roughly one visible row. Fixing the collapse and
rethinking phone navigation belong together: on a phone there is room for one surface
at a time, so the file browser and the terminal should each take the whole screen and
hand off to the preview, instead of stacking as desktop panes.

This work is also the foundation for a future iPhone app: iOS forbids the macOS
wrapper's spawn-a-local-server model, so an iPhone app must be a thin native shell over
this same web UI served by the hub. The phone UX built here *is* that app's UI, shipped
early to Safari/PWA users.

## What Changes

- Fullscreen display mode becomes truly full-viewport on phone-class viewports:
  `position: fixed`, `100dvh`, body scroll locked — no sidebar, no preview.
- Opening the terminal on a phone-class viewport auto-promotes to fullscreen (the
  stored display-mode preference is preserved, mirroring the existing right-dock →
  bottom-dock narrow-viewport fallback).
- The terminal panel resizes to the visible viewport (`window.visualViewport`) so the
  iOS software keyboard never hides the prompt line; xterm refits on keyboard
  show/hide.
- Safe-area insets are respected (`viewport-fit=cover` + `env(safe-area-inset-*)`);
  the keybar sits above the home indicator.
- The touch keybar gains PgUp, PgDn, Home, End, a Paste button (async Clipboard API),
  and a single-shot sticky Ctrl modifier that composes the next typed letter into a
  control character.
- The panel header slims down on phone-class viewports: split/dock/resize affordances
  hide (they are meaningless at phone widths), keeping title, minimize/restore-to-docs,
  and close.
- The file tree becomes usable on phones: the virtualized tree gets a real height in
  the stacked layout (bug fix), and on phone-class viewports the Files pane opens as a
  full-screen browser that dismisses back to the preview when a document is picked.
- Phone navigation follows a one-surface-at-a-time model: file browser, preview, or
  terminal — never a stack of desktop panes competing for 45vh slices.
- The preview header stops cramming on narrow viewports: below a narrow breakpoint
  the toolbar (view segments, Wrap, action icons) drops to its own row under the
  title instead of fighting it for one flex row (portrait iPhone today crushes the
  title; landscape is fine).
- Touch devices get runtime font-size control, which they currently lack entirely
  (pinch zoom scales the whole layout, not the text): an A−/A+ stepper in the
  terminal panel header (per-device persisted, overriding the `.uatu.json` default)
  and an A−/A+ text-size stepper in the preview action bar scaling document content
  only.
- TUIs become touch-scrollable: vertical swipes over a terminal pane in the
  alternate-screen buffer translate to arrow-key sequences (the touch analogue of
  wheel alternate-scroll), while normal-buffer swipes keep scrolling scrollback.
  The keybar's PgUp/PgDn cover paged jumps.
- The collapsed sidebar rail gains Follow and Terminal icon toggles. Today the rail
  holds only the expand control, leaving keyboard shortcuts as the sole fallback —
  which touch keyboards cannot produce, locking iPad users (who otherwise get the
  desktop layout) out of both capabilities while collapsed. Desktop benefits too.

Out of scope (candidate follow-up changes): a hub "attach → terminal" deep link,
PWA standalone-mode polish, and the native iPhone shell itself.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `embedded-terminal`: the fullscreen requirement changes on phone-class viewports
  (full viewport instead of "preserving the sidebar and topbar"); a new auto-promote
  rule on open; new requirements for visible-viewport (software keyboard) sizing and
  safe-area insets; the keybar requirement's minimum key set grows (PgUp/PgDn,
  Home/End, Paste, sticky Ctrl) and gains latch/paste behavior. New requirements for
  runtime font-size adjustment on touch devices and for touch scrolling in both
  terminal buffers.
- `sidebar-shell`: new requirements for phone-class viewports — the tree keeps a
  usable height in the stacked layout, and the Files pane opens as a full-screen file
  browser that dismisses to the preview on document pick. Desktop pane behavior is
  unchanged. The collapse/expand requirement is modified: the rail exposes Follow and
  Terminal toggles alongside the expand control.
- `follow-mode`: the single-boolean toggle requirement is modified to name two
  mutually exclusive presentations (expanded-header chip, collapsed-rail icon) of the
  same `followEnabled` state.
- `preview-action-bar`: new requirements — on narrow viewports the preview toolbar
  stacks below the document heading (every control reachable, no horizontal
  overflow), and coarse-pointer devices get a preview text-size stepper in the
  action bar.

## Impact

- `src/terminal/panel.ts` — display-mode promotion, phone-viewport detection,
  visualViewport wiring, header affordance gating.
- `src/terminal/pane-state.ts` — phone-fullscreen fallback logic beside the existing
  right-dock fallback.
- `src/terminal/keybar.ts` — new keys, paste action, sticky-Ctrl latch.
- `src/terminal/client.ts` / `src/terminal/clipboard.ts` — control-character
  composition for sticky Ctrl; clipboard read for Paste.
- `src/styles.css` — phone fullscreen rules (`dvh`, fixed positioning, scroll lock),
  safe-area padding, keybar layout.
- `src/index.html` — `viewport-fit=cover` on the viewport meta.
- `src/sidebar/panes.ts` / `src/sidebar/tree-mount.ts` — phone file-browser surface,
  pick-to-dismiss wiring (selection already flows through the tree's select callback).
- `src/styles.css` mobile block (≤900px rules) — tree height fix, browser overlay.
- E2E: `tests/e2e/` terminal suites gain phone-viewport coverage (Playwright device
  emulation); unit tests colocated with the touched modules.
- No server, hub, or protocol changes.
