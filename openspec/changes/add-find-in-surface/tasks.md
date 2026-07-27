## 1. Spike: does ⌘F reach the page in UatuCode Desktop?

- [x] 1.1 Spiked with the real feature instead of a logger — the find bar is its own probe
- [x] 1.2 **Answer: ⌘F reaches the page — but only while a non-editable element has focus.** Rendered and Source find work untouched; the terminal does not, because WebKit swallows ⌘F for its own editing machinery whenever an editable element is focused, and xterm keeps a helper `<textarea>` focused throughout
- [x] 1.3 Finding recorded in `design.md`; it makes the group-5 key monitor load-bearing rather than cosmetic

## 2. Active surface and preview focusability

- [x] 2.1 Add `activeSurface: "preview" | "terminal" | "browser"` to `src/shell/state.ts`, defaulting to `preview`
- [x] 2.2 Create `src/find/active-surface.ts` with a setter plus `initActiveSurfaceTracking()` that binds `pointerdown`/`focusin` on the preview, terminal panel, and sidebar roots — sidebar resolving to `preview`
- [x] 2.3 Wire `initActiveSurfaceTracking()` into `src/app.ts` boot
- [x] 2.4 Confirm follow-mode's programmatic path cannot reach the setter: assert `withProgrammaticUpdate` selection changes leave `activeSurface` untouched
- [x] 2.5 Add `tabindex="-1"` to `.preview-shell` in `src/index.html` and a `:focus-visible` rule in `src/styles.css` that does not draw a box around the whole pane
- [x] 2.6 Unit tests in `src/find/active-surface.test.ts`: default state, each surface's interaction, sidebar-resolves-to-preview, programmatic selection is inert

## 3. Preview find: matcher, highlighting, find bar

- [x] 3.1 Create `src/find/text-index.ts` — a `TreeWalker` over text nodes building a concatenated string plus a node/offset table, skipping shadow roots and `hidden` subtrees
- [x] 3.2 Add `src/find/text-index.test.ts` covering matches that span element boundaries, attribute text never matching, and offset→`Range` round-tripping
- [x] 3.3 Create `src/find/matcher.ts` — literal, case-sensitive, whole-word, and regex matching over the indexed string, with a match cap and zero-length-match guard
- [x] 3.4 Add `src/find/matcher.test.ts` covering each toggle, invalid regex reporting, zero-length patterns terminating, and cap behavior
- [x] 3.5 Create `src/find/highlight.ts` — register `Highlight` objects with `CSS.highlights` for all-matches and current-match, expose `revealMatch(range)` scrolling `.preview-shell`, and a `clear()` that leaves no residue
- [x] 3.6 Add `::highlight()` rules for both matches and current match to `src/styles.css`, with explicit light and dark values
- [x] 3.7 Add find-bar markup to `src/index.html` (query input, counter, prev/next, Aa / whole-word / regex toggles, close) and style it in `src/styles.css`
- [x] 3.8 Create `src/find/find-bar.ts` — open/close, debounced incremental search, counter rendering including a distinct no-results state, next/previous with wrap-around, session-scoped toggle state, seed-from-selection with length and multi-line clamping
- [x] 3.9 Handle split view: index both preview panes and order matches by document order across them
- [x] 3.10 Recompute on remount — a scoped `childList` observer on `#preview` (there are eight mount sites, not one; see design Decision 4) so query survives live reload and view-mode switches, re-resolving the current match by position
- [x] 3.11 On `Escape`, clear highlights and move focus to `.preview-shell` at the current match
- [x] 3.12 Bind `⌘F`/`Ctrl+F`, `⌘G`, `⇧⌘G` in `src/find/shortcut.ts` (`shell/events.ts` is the SSE stream, not keyboard), routing through `activeSurface` and calling `preventDefault()` so native find does not open
- [x] 3.13 Add `src/find/find-status.test.ts` for counter states and seed clamping, plus `matcher.test.ts` for wrap-around — the pure half of the bar, split out per the `outline-headings.ts` idiom

## 4. Terminal find

- [x] 4.1 Add `@xterm/addon-search` to `package.json` and confirm `bun run check:licenses` passes
- [x] 4.2 Instantiate one search addon per terminal pane in `src/terminal/panel.ts`, disposing with the pane
- [x] 4.3 Set `activeSurface` to `terminal` on pane focus — already covered by group 2's tracker (`#terminal-panel` is a surface root); background PTY output cannot change it because only pointer/focus events write
- [x] 4.4 Route `⌘F`/`⌘G`/`⇧⌘G` to the focused pane's addon when the terminal is the active surface — via one shared find bar with a pluggable engine (`engine.ts`), resolving the design's open question in favour of reuse
- [x] 4.5 Assert searching writes nothing to the PTY and does not touch the other pane in a split

## 5. macOS wrapper: menu and shortcut routing

- [x] 5.1 `CommandGroup(replacing: .textEditing)` — also drops the inherited Spelling/Substitutions submenus, which apply only to native text fields (the split browser's address bar)
- [x] 5.2 Add Find, Find Next, Find Previous to the Edit menu in `ContentView.swift` with standard key equivalents, enabled whenever a running window is focused
- [x] 5.3 Resolve the target surface at invoke time via `split.hasFocus(in:)` — following the `⌘W`/`⌘[`/`⌘]` monitor precedent, not menu enablement
- [x] 5.4 When the embedded SPA is the target, forward the request into the page rather than handling it natively
- [x] 5.5 Verified in a built app: Rendered, Source, Diff, terminal, Edit ▸ Find, and ⌘G/⇧⌘G all confirmed by hand. Split-browser behaviour is unverified pending group 6 — ⌘F there is inert, same as before this change

## 6. Split-browser native find

- [ ] 6.1 Create `desktop/macos/UatuCodeDesktop/FindBar.swift` — a SwiftUI bar with query field, counter, prev/next, and close
- [ ] 6.2 Drive matching with `WKWebView.find(_:configuration:)` against the selected tab, reporting match counts
- [ ] 6.3 Hold find state per `BrowserTab` so switching tabs does not carry highlights across, and closing a tab discards it
- [ ] 6.4 No-op when the split is open with no selected tab, rather than falling through to another surface
- [ ] 6.5 `Escape` closes the bar, clears highlights, and returns focus to the tab's web view

## 7. End-to-end coverage and docs

- [x] 7.1 Add `tests/e2e/find.e2e.ts` — find in Rendered and Source views, counter and wrap-around, a match spanning highlight spans, no-results state
- [x] 7.2 E2E: find survives a live-reload remount with the query intact
- [x] 7.3 E2E: after a tree click, `⌘F` opens preview find with focus still in the sidebar — measured: the library's arrow keys move focus within the widget, they do not advance selection, so the spec scenario was corrected
- [x] 7.4 E2E: with the terminal focused, `⌘F` searches the terminal and not the preview
- [x] 7.5 Run `bun test` (867 pass) and `bun test:e2e` (224 pass; `terminal-lifecycle.e2e.ts:173` fails on a clean tree too — pre-existing, unrelated)
- [x] 7.6 Update `CLAUDE.md`'s `src/` folder map with the `find/` folder, and `ARCHITECTURE.md` with the active-surface concept and the find routing rule
