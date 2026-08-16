## 1. Prerequisite

- [ ] 1.1 Archive `add-opencode-chat` so the `opencode-chat` spec exists under
  `openspec/specs/` (this change's delta is written against that result)

## 2. Layout — DOM and CSS

- [ ] 2.1 Wrap `.preview-shell` + `#chat-surface` in a `.work-row` flex row
  inside `.main-stack` (both `index.html` layout instances stay consistent);
  verify main-stack children remain `[content, resizer, panel]` so the
  terminal dock `:has()` rule is untouched
- [ ] 2.2 Add the chat split divider element and the collapsed-state slim
  strip with its reopen toggle (accessible name, keyboard operable)
- [ ] 2.3 Remove the two `main-surface-switch` markup instances, their styles,
  and the `data-main-surface` exclusivity rule; grep-sweep `styles.css`,
  `index.html`, and `src/` for remaining `data-main-surface` /
  `main-surface` references
- [ ] 2.4 CSS for the split: fractional widths via a custom property, minimum
  widths for both sides, full-height chat within the work row, collapsed
  strip presentation; confirm terminal bottom dock spans under both surfaces
  and right dock keeps the right edge
- [ ] 2.5 Replace the inline pre-paint boot script's main-surface handling
  with panel-state equivalents (collapsed attribute + width variable) so
  first paint doesn't flash

## 3. Panel state module

- [ ] 3.1 Rewrite `src/chat/surface.ts` as chat-panel state: open/collapsed +
  split fraction, `localStorage` persistence with new key(s), clamping to
  minimum widths; delete `mainSurface`/`MAIN_SURFACE_KEY` from
  `src/shell/state.ts`
- [ ] 3.2 Implement divider drag (pointer capture, clamps, fraction commit)
  and the collapse/reopen toggle wiring
- [ ] 3.3 Implement the narrow-viewport guard: auto-collapse below the
  minimum combined width without overwriting the open preference, restore on
  grow; keep it independent of the terminal's right-dock fallback
- [ ] 3.4 Unit tests for persistence round-trip, clamping, guard
  yield-and-restore, and reopen-restores-fraction

## 4. Call-site simplifications

- [ ] 4.1 `src/find/active-surface.ts`: delete the `onMainSurfaceChange`
  desktop claim and its import; confirm pointer/focus tracking covers the
  co-visible chat and the structural no-file-event test still holds
- [ ] 4.2 `src/chat/file-references.ts`: drop `setMainSurface("preview")` —
  desktop navigates in place, touch still switches to the Preview tab
- [ ] 4.3 `src/find/find-bar.ts`: reveal-chat-for-find becomes
  expand-if-collapsed via the panel API
- [ ] 4.4 `src/shell/tab-bar.ts`: replace the tab → mainSurface sync with
  mode-switch normalization (touch→desktop with Chat tab active opens the
  panel; desktop→touch picks a sensible tab); update tests

## 5. Visual verification, then e2e

- [ ] 5.1 Run `bun run dev` and visually verify all four states before any
  long e2e run: split default, divider drag + reload persistence, collapse
  strip + reopen, terminal bottom (spans both) and right (keeps edge),
  narrow-window auto-collapse and restore
- [ ] 5.2 Add a shared e2e helper that activates Chat via the panel
  (expand-if-collapsed) and migrate `chat.e2e.ts` / `chat-panels.e2e.ts`
  off the segmented switch; assert co-visibility where tests relied on
  exclusivity
- [ ] 5.3 New e2e coverage for the split: fraction persistence across reload,
  collapse/reopen state retention (conversation + preview scroll), file
  reference navigates without collapsing chat, find-in-chat expands a
  collapsed panel
- [ ] 5.4 Full `bun test` and `bun test:e2e` green; `openspec validate
  chat-side-panel --strict` passes
