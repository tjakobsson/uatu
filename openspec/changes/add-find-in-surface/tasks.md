## 1. Spike: does ⌘F reach the page in UatuCode Desktop?

- [ ] 1.1 Add a temporary `keydown` logger to the SPA that reports `⌘F` presses, build with `bun run build`, and open a folder in UatuCode Desktop
- [ ] 1.2 Record whether the key reaches the page as-is; if not, add `CommandGroup(replacing: .textEditing) {}` and re-test to confirm SwiftUI's inherited Find group is the interceptor
- [ ] 1.3 Write the finding into `design.md` under Open Questions and remove the temporary logger — group 5 depends on the answer, groups 2–4 do not

## 2. Active surface and preview focusability

- [ ] 2.1 Add `activeSurface: "preview" | "terminal" | "browser"` to `src/shell/state.ts`, defaulting to `preview`
- [ ] 2.2 Create `src/find/active-surface.ts` with a setter plus `initActiveSurfaceTracking()` that binds `pointerdown`/`focusin` on the preview, terminal panel, and sidebar roots — sidebar resolving to `preview`
- [ ] 2.3 Wire `initActiveSurfaceTracking()` into `src/app.ts` boot
- [ ] 2.4 Confirm follow-mode's programmatic path cannot reach the setter: assert `withProgrammaticUpdate` selection changes leave `activeSurface` untouched
- [ ] 2.5 Add `tabindex="-1"` to `.preview-shell` in `src/index.html` and a `:focus-visible` rule in `src/styles.css` that does not draw a box around the whole pane
- [ ] 2.6 Unit tests in `src/find/active-surface.test.ts`: default state, each surface's interaction, sidebar-resolves-to-preview, programmatic selection is inert

## 3. Preview find: matcher, highlighting, find bar

- [ ] 3.1 Create `src/find/text-index.ts` — a `TreeWalker` over text nodes building a concatenated string plus a node/offset table, skipping shadow roots and `hidden` subtrees
- [ ] 3.2 Add `src/find/text-index.test.ts` covering matches that span element boundaries, attribute text never matching, and offset→`Range` round-tripping
- [ ] 3.3 Create `src/find/matcher.ts` — literal, case-sensitive, whole-word, and regex matching over the indexed string, with a match cap and zero-length-match guard
- [ ] 3.4 Add `src/find/matcher.test.ts` covering each toggle, invalid regex reporting, zero-length patterns terminating, and cap behavior
- [ ] 3.5 Create `src/find/highlight.ts` — register `Highlight` objects with `CSS.highlights` for all-matches and current-match, expose `revealMatch(range)` scrolling `.preview-shell`, and a `clear()` that leaves no residue
- [ ] 3.6 Add `::highlight()` rules for both matches and current match to `src/styles.css`, with explicit light and dark values
- [ ] 3.7 Add find-bar markup to `src/index.html` (query input, counter, prev/next, Aa / whole-word / regex toggles, close) and style it in `src/styles.css`
- [ ] 3.8 Create `src/find/find-bar.ts` — open/close, debounced incremental search, counter rendering including a distinct no-results state, next/previous with wrap-around, session-scoped toggle state, seed-from-selection with length and multi-line clamping
- [ ] 3.9 Handle split view: index both preview panes and order matches by document order across them
- [ ] 3.10 Recompute on remount — hook the preview mount lifecycle in `src/preview/mount.ts` so query survives live reload and view-mode switches, re-resolving the current match by ordinal
- [ ] 3.11 On `Escape`, clear highlights and move focus to `.preview-shell` at the current match
- [ ] 3.12 Bind `⌘F`/`Ctrl+F`, `⌘G`, `⇧⌘G` in `src/shell/events.ts`, routing through `activeSurface` and calling `preventDefault()` so native find does not open
- [ ] 3.13 Add `src/find/find-bar.test.ts` for counter states, wrap-around, toggle persistence, and seeding

## 4. Terminal find

- [ ] 4.1 Add `@xterm/addon-search` to `package.json` and confirm `bun run check:licenses` passes
- [ ] 4.2 Instantiate one search addon per terminal pane in `src/terminal/panel.ts`, disposing with the pane
- [ ] 4.3 Set `activeSurface` to `terminal` on pane focus, and verify background PTY output does not change it
- [ ] 4.4 Route `⌘F`/`⌘G`/`⇧⌘G` to the focused pane's addon when the terminal is the active surface, with next/previous and reveal-in-scrollback
- [ ] 4.5 Assert searching writes nothing to the PTY and does not touch the other pane in a split

## 5. macOS wrapper: menu and shortcut routing

- [ ] 5.1 Apply the group-1 finding — strip or replace SwiftUI's inherited `.textEditing` Find group so nothing silently claims `⌘F`
- [ ] 5.2 Add Find, Find Next, Find Previous to the Edit menu in `ContentView.swift` with standard key equivalents, enabled whenever a running window is focused
- [ ] 5.3 Resolve the target surface at invoke time via `split.hasFocus(in:)` — following the `⌘W`/`⌘[`/`⌘]` monitor precedent, not menu enablement
- [ ] 5.4 When the embedded SPA is the target, forward the request into the page rather than handling it natively
- [ ] 5.5 Verify in a built app that ⌘F opens uatu's find bar with the SPA focused and does not when the split browser is focused

## 6. Split-browser native find

- [ ] 6.1 Create `desktop/macos/UatuCodeDesktop/FindBar.swift` — a SwiftUI bar with query field, counter, prev/next, and close
- [ ] 6.2 Drive matching with `WKWebView.find(_:configuration:)` against the selected tab, reporting match counts
- [ ] 6.3 Hold find state per `BrowserTab` so switching tabs does not carry highlights across, and closing a tab discards it
- [ ] 6.4 No-op when the split is open with no selected tab, rather than falling through to another surface
- [ ] 6.5 `Escape` closes the bar, clears highlights, and returns focus to the tab's web view

## 7. End-to-end coverage and docs

- [ ] 7.1 Add `tests/e2e/find.e2e.ts` — find in Rendered and Source views, counter and wrap-around, a match spanning highlight spans, no-results state
- [ ] 7.2 E2E: find survives a live-reload remount with the query intact
- [ ] 7.3 E2E: after a tree click, `⌘F` opens preview find and the tree still responds to arrow keys
- [ ] 7.4 E2E: with the terminal focused, `⌘F` searches the terminal and not the preview
- [ ] 7.5 Run `bun test` and `bun test:e2e`
- [ ] 7.6 Update `CLAUDE.md`'s `src/` folder map with the `find/` folder, and `ARCHITECTURE.md` with the active-surface concept and the find routing rule
