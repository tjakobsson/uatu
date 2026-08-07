# Tasks — touch-tab-navigation

## 1. UI mode

- [x] 1.1 Create `src/shell/ui-mode.ts`: mode resolution (stored override → coarse-pointer default), per-device persistence, `data-ui-mode` stamping on `<html>`, a live `setUiMode()` that re-stamps without reload, and a change-listener seam; colocated unit tests for resolution and persistence
- [x] 1.2 Re-key the touch-layout CSS: every `@media (pointer: coarse) and (max-width: 900px)` layout block in `src/styles.css` moves to `[data-ui-mode="touch"]` selectors (fullscreen terminal geometry, scroll locks, hidden geometry controls); input-affordance blocks (keybar, steppers) stay on `(pointer: coarse)`
- [x] 1.3 Replace live layout uses of `isPhoneClassViewport` in `panel.ts`/`files-overlay.ts` with the mode helper; the viewport predicate remains only as ui-mode's boot default heuristic

## 2. Tab bar

- [x] 2.1 Add tab-bar markup to `src/index.html` (tablist, three tabs with icon + label, trailing Desktop escape button) and safe-area-aware fixed-bottom styles shown only under `[data-ui-mode="touch"]`
- [x] 2.2 Create `src/shell/tab-bar.ts`: active-tab state in `appState`, per-device persistence (default Preview), `aria-selected` sync, surface application (stamp `data-active-tab` for CSS), wired in `app.ts`
- [x] 2.3 Surface CSS: Files tab renders the sidebar element full-screen (safe-area padded); Preview tab shows the main-stack; non-active surfaces hidden — all keyed off `data-active-tab` under touch mode

## 3. Surface integration

- [x] 3.1 Terminal tab: activating it shows the panel fullscreen through the existing promotion path (spawn/reattach identical to the desktop toggle); switching away applies minimize semantics WITHOUT `setVisible(false)` (PTYs stay attached — pin with a unit test on the switch path); the minimized strip and exit-to-minimized routing are removed from touch mode, with Esc/fullscreen-toggle switching to the Preview tab
- [x] 3.2 Files tab pick-to-Preview: the tree's Rule A selection handler switches the active tab to Preview (replacing `dismissFilesOverlayAfterPick`); directory taps and programmatic updates never switch tabs
- [x] 3.3 Retire the files-overlay: remove `src/sidebar/files-overlay.ts`, the Browse/close buttons from `index.html`, the `data-overlay` CSS, and the pane-stack promotion exclusion (the Files tab hosts the whole stack instead)
- [x] 3.4 Mode-switch normalization: flipping to desktop mode restores the terminal's stored dock/display and clears touch surface state; flipping to touch re-applies the active tab; wire the desktop-chrome return control (coarse-pointer + wide viewports only)

## 4. Tests

- [x] 4.1 Rework `tests/e2e/mobile.e2e.ts` around tabs: boot lands on Preview with the bar visible, tab switching swaps surfaces, Files pick switches to Preview, file events don't steal the active tab, terminal survives tab round-trips with output intact, active tab persists across reload
- [x] 4.2 Add iPad-viewport e2e (coarse + wide, e.g. 1024×768): touch mode by default with the tab bar, the Desktop escape round-trip (desktop layout renders fully, mode persists across reload, terminal dock/display restored), and no escape control at phone widths
- [x] 4.3 Desktop guards: fine-pointer viewports never render the tab bar or mode controls; existing desktop terminal/sidebar suites stay green
- [x] 4.4 `bun test` and `bun test:e2e` green; manual iPhone + iPad pass over the hub (tab feel, keyboard-over-bar behavior, safe areas, Desktop escape on iPad), findings recorded in the change

## 5. Nice-to-have (cut first if squeezed)

- [x] 5.1 Terminal tab badge: a dot when PTY output arrives while another tab is active, cleared on tab activation

## Verification notes (2026-08-06, implementation session)

- `bun test`: 1217 pass / 0 fail (full suite, including the new ui-mode,
  tab-action, and pane-stack tests).
- `bun test:e2e`: the reworked `mobile.e2e.ts` (17 tests) and new
  `ipad.e2e.ts` (4 tests) are green. Full-suite runs surface a handful of
  order/environment-dependent failures (`document-tree.e2e.ts:71`,
  `find.e2e.ts:96`, `change-overview.e2e.ts:203/227`) — all reproduced on
  the UNMODIFIED tree on this machine, so they are pre-existing flakes,
  not regressions from this change.
- Outstanding for 4.4: the manual iPhone + iPad pass over the hub (tab
  feel, keyboard-over-bar, safe areas, Desktop escape on iPad) — needs
  real devices; record findings here.

### Device-pass findings (2026-08-06, iPhone + iPad over the hub)

- Overall: works fairly well on both devices.
- **Stranded in desktop mode** (fixed): the touch-mode return was gated on
  `min-width: 901px`, so escaping to desktop in iPad landscape and
  rotating to portrait (768–834px) — or collapsing the sidebar — removed
  the only way back. Fix: the return now renders on EVERY coarse-pointer
  viewport in desktop mode, in both the sidebar header and the collapsed
  rail (`#rail-touch-mode-return`); spec delta updated with a
  "rotation cannot strand desktop mode" scenario, e2e-covered.
- **Mode flip felt janky** (mitigated): `setUiMode` now dispatches a
  window resize on the frame after the stamp so resize-driven consumers
  (pane normalization, split ratios, dock fallback) settle immediately.
- **Pane resizing hard on touch** (fixed): the 6px resizer strip is no
  finger target. Pane headers are now the coarse-pointer drag surface —
  dragging a header moves the boundary above it (previous pane trades
  height), with an 8px threshold so header-button taps keep working and
  `touch-action: none` so the drag beats the scroll gesture. Spec + e2e
  updated.
- Still open for 4.4: re-verify the three fixes on-device (keyboard-over-
  bar, safe areas were fine on the first pass).
- **Follow-up iteration**: the mode switch moved out of the tab bar
  entirely — one `#ui-mode-toggle` in the sidebar header (the Files tab's
  header in touch mode, beside the collapse in desktop mode, rail variant
  when collapsed), shown on every coarse-pointer viewport in both modes.
  The bar now carries only the three surface tabs. Spec, design, and
  proposal updated; e2e reworked around the new placement.
- **Search results didn't reveal Preview** (fixed): opening a search-pane
  result loaded the document but left the Files tab active. The switch now
  lives at the Rule A chokepoint (`applyUserRowClick` calls tab-bar's
  `revealPreviewSurface()`), so tree picks AND search results both land on
  Preview — and the review-score and git-log commit clicks got the same
  treatment, since they also render into the preview. Spec requirement
  generalized to "preview-bound navigations"; e2e added.
- **Double-tap collapse** (added on device feedback): the − / + pane
  buttons are hard to hit on touch, so double-tapping a pane header now
  toggles that pane's collapse (same persistence as the buttons). Single
  taps and header-button taps are unaffected (350ms/24px double-tap window,
  drags excluded); works on the topmost pane too, which has no drag
  boundary. Spec scenario + e2e added.
- **Manual pass complete** (2026-08-06): Tobias verified iPhone + iPad
  over the hub — tab feel, keyboard-over-bar, safe areas, mode toggle,
  header drag/double-tap all good. One out-of-scope UX bug found and filed:
  search-pane results don't scroll to the match in touch mode —
  https://github.com/tjakobsson/uatu/issues/181 (reveal scrolls
  `.preview-shell`, but touch mode scrolls the page).
