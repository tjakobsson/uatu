# Tasks — mobile-experience

## 1. Phone-class detection and fullscreen layout

- [x] 1.1 Add the phone-class `matchMedia` query (coarse pointer AND width < 900px) to `src/terminal/panel.ts` with a colocated helper that tests can drive, re-evaluated on media-query change (rotation)
- [x] 1.2 Add `viewport-fit=cover` to the viewport meta in `src/index.html`
- [x] 1.3 In `src/styles.css`, make `[data-display="fullscreen"]` under the phone media condition `position: fixed; inset: 0; height: 100dvh` with a `:has()`-guarded body scroll lock, plus `env(safe-area-inset-*)` padding on the panel edges and keybar bottom
- [x] 1.4 Hide split, dock-toggle, and the panel resizer under the phone media condition (CSS only), keeping title/minimize/fullscreen/close

## 2. Display-mode promotion

- [x] 2.1 In `pane-state.ts`/`panel.ts`, force the effective display mode to fullscreen when the panel is shown in `normal` on a phone-class viewport, preserving the stored preference (mirror the right-dock fallback pattern); unit-test the resolution function
- [x] 2.2 Route fullscreen-exit (toggle and Esc) to `minimized` instead of `normal` on phone-class viewports; verify stored preference is restored when the viewport leaves phone-class

## 3. Visible-viewport sizing

- [x] 3.1 Add a visualViewport subscription in `panel.ts` — active only while phone-fullscreen — that sets the panel height from `visualViewport.height` (CSS custom property) and triggers xterm refit on `resize`, `scroll`, and textarea `focusin`/`focusout`
- [x] 3.2 Unit-test the sizing logic against a stubbed visualViewport object (attach/detach on mode change, height propagation, refit calls)

## 4. Keybar growth

- [x] 4.1 Add PgUp (`\x1b[5~`), PgDn (`\x1b[6~`), Home (`\x1b[H`), End (`\x1b[F`) to `KEYBAR_KEYS` in `src/terminal/keybar.ts`, reordering the row by frequency (esc, tab, ctrl, ^C, paste, arrows, paging/home/end, ^D/^Z)
- [x] 4.2 Extend the keybar model with action buttons (not raw sequences): Paste, reading `navigator.clipboard.readText()` in the tap gesture and writing through `sendToActivePane`; inert on denial/empty; reuse `clipboard.ts` helpers
- [x] 4.3 Implement the sticky Ctrl latch: keybar button with armed visual state + `aria-pressed`; a pure compose hook in the client input path (`char & 0x1f` on next printable, then release; second tap cancels); identity pass-through when unarmed, colocated unit tests
- [x] 4.4 Keybar keeps `pointerdown`+`preventDefault` semantics for all new affordances so focus never leaves xterm
- [x] 4.5 Implement alternate-screen swipe scrolling: a pure translation function (buffer type, swipe delta, cell height, cursor-key mode → arrow sequences) with colocated unit tests, plus a thin touch listener on the pane host active only on coarse-pointer devices; normal-buffer swipes keep xterm's native scrollback scrolling
- [x] 4.6 Add A−/A+ font-size controls to the terminal panel header (coarse-pointer only): live `options.fontSize` update + refit across panes, per-device persistence with precedence over `.uatu.json` (override cleared when stepped back to the configured value), clamped to the config loader's bounds

## 5. Phone file navigation

- [x] 5.1 Fix the stacked-layout tree collapse: give the Files `.pane-body` an explicit height in the ≤900px block of `src/styles.css` so the virtualized tree allocates real rows and scrolls internally; verify desktop flex allocation is untouched
- [x] 5.2 Add the overlay promotion to the Files pane: a data attribute on the pane element with phone-media-guarded CSS (`position: fixed; inset: 0`, `dvh`, safe-area padding, close affordance in the pane header), promoted on pane activation, demoted on close
- [x] 5.3 Exclude a promoted pane from the stacked pane-height allocator in `src/sidebar/panes.ts` (treat as hidden for allocation) and restore on demotion; unit-test the allocator with a promoted pane
- [x] 5.4 Wire dismiss-on-pick through the user-click selection path (follow-mode Rule A / `withProgrammaticUpdate` distinction): document pick dismisses the overlay and scrolls the preview into view; directory taps and programmatic updates leave it open

- [x] 5.5 Stack the preview header on narrow widths: width-only media query (~640px, tuned so iPhone portrait stacks, landscape does not) switching `.preview-header` to a column with the toolbar wrapping on its own row; sticky positioning and the blur fade untouched
- [x] 5.6 Add A−/A+ text-size controls to the preview action bar (coarse-pointer only): bounded step scale (~85%–150%) via a CSS custom property on the preview body, layout reflow not zoom, persisted per device; at-limit state communicated on the controls
- [x] 5.7 Add Follow and Terminal icon toggles to the collapsed sidebar rail (`src/index.html` rail markup + `src/styles.css`), wired to the same handlers as the expanded-sidebar controls with `aria-pressed` mirroring `followEnabled` and panel visibility; keep the rail toggles in sync when state changes while collapsed

## 6. E2E and device verification

- [x] 6.1 Add a phone-viewport Playwright suite (device emulation: coarse touch + narrow viewport) covering auto-fullscreen on open, whole-viewport coverage with scroll lock, exit-to-minimized, slim header, and keybar key/latch behavior
- [x] 6.2 Extend the phone suite to cover file navigation: tree shows multiple rows in the stacked layout, overlay opens full-screen, directory taps keep it open, a file event while open does not dismiss it, document pick dismisses to the preview
- [x] 6.3 Add portrait-phone header coverage: heading and toolbar on separate rows, all controls visible, no horizontal overflow; landscape/desktop widths keep the single-row header
- [x] 6.4 Extend the existing desktop terminal and sidebar e2e to assert desktop fullscreen still preserves sidebar/topbar, geometry controls remain visible, and the Files pane never renders an overlay affordance
- [x] 6.5 Add rail-toggle e2e: collapse the sidebar, toggle the terminal and Follow from the rail, assert state matches what the expanded controls report after re-expanding
- [x] 6.6 Add coarse-pointer e2e for the size controls: terminal font steps persist as a per-device override, preview text-size steps persist across reload and respect bounds. The alternate-buffer swipe translation is covered at the unit level (`touch-scroll.test.ts`) — the e2e harness deliberately avoids PTY round-trips, so no TUI is available to swipe against; on-device behavior is part of the 6.7 manual pass
- [ ] 6.7 Manual pass on a real iPad (collapsed-rail toggles, keybar with sticky Ctrl and Paste, font steppers, TUI swipe-scrolling in a real pager) and a real iPhone (Safari + installed PWA) for software-keyboard resize, safe-area clearance, Paste permission callout, smart-punctuation input sanity, file-browser feel, and the portrait header; record findings in the change

Verification beyond the checkboxes: `bun test` and `bun test:e2e` green; the manual
device pass (6.7) is the release gate for the visualViewport behavior Playwright
cannot emulate.
