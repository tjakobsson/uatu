## Why

Touch mode makes the **page** scroll, not `.preview-shell`
(`html[data-ui-mode="touch"] .preview-shell { overflow: visible; height: auto }`,
`src/styles.css:4638`). Every scroll-and-reveal path in the SPA still assumes the
shell is the scroller and hard-binds it at module load, so on iPhone/iPad the
highlight paints but the view never moves, and outline clicks land under the
sticky header. The same asymmetry exists in the ≤900px stacked desktop layout,
which has scrolled the body since long before touch mode.

A second, unrelated-looking class of touch-mode bug has the same shape at the
surface level: a keyboard shortcut acts on a surface that is not the active tab,
so the shortcut consumes the key and then works entirely inside a
`display: none` subtree.

Four filed issues, two root causes, one device-test pass:

- [#181](https://github.com/tjakobsson/uatu/issues/181) — a search-pane result
  opens the document but never scrolls to the match
- [#183](https://github.com/tjakobsson/uatu/issues/183) — an outline click
  scrolls but misses the heading, which lands under the sticky chrome
- [#191](https://github.com/tjakobsson/uatu/issues/191) — `⌘F` from the Files
  tab mounts the find bar inside the hidden preview and suppresses native find
- [#192](https://github.com/tjakobsson/uatu/issues/192) — `⇧⌘F` opens project
  search into a hidden sidebar

## What Changes

**Root cause 1 — "which element scrolls" is resolved, not assumed.**

- Introduce one shared resolver for the preview's *effective scroll container*:
  `.preview-shell` when it is the scroller, the viewport scroller otherwise
  (touch mode, and the ≤900px stacked layout). Resolved per call, because both
  UI mode and layout change live.
- Route every reveal-and-scroll path through it: find-bar match navigation, the
  externally supplied reveal project search uses, outline jumps, outline
  active-heading tracking, in-page anchor clicks, post-navigation fragment
  scrolls, and the scroll-to-top on document switch and hash-only back.
- Make the sticky-header clearance (`scroll-padding-top: 9rem`) apply to
  whichever element scrolls, instead of only to `.preview-shell`.
- Fix two viewport-scroller details the current code cannot survive: the root
  scroller's `scroll` event is fired at `document` (an element listener on
  `.preview-shell` never hears it), and `documentElement.getBoundingClientRect()`
  returns the whole document box rather than the visible viewport, which would
  corrupt the reveal offset math.

**Root cause 2 — a shortcut brings its surface forward before acting.**

- `⌘F` invoked while the Preview surface is not the visible tab brings Preview
  forward before mounting the bar, the same intent `revealPreviewSurface()`
  already expresses for document picks.
- `⇧⌘F` activates the Files tab as part of opening project search — the
  touch-mode counterpart of the `setSidebarCollapsed(false)` call
  `openSearchPane()` already makes for exactly this failure mode.

**Not changing:** desktop behavior. Every path above already works there and
must keep working unchanged; the shared resolver returns `.preview-shell` in the
desktop layout, which is what all of this code passes today.

## Capabilities

### New Capabilities

- `preview-scrolling`: which element actually scrolls the preview for the
  current layout and UI mode, and the obligation on every scroll-and-reveal path
  to target it — including sticky-header clearance and scroll-position
  observation. This is the concept whose absence produced
  [#181](https://github.com/tjakobsson/uatu/issues/181) and
  [#183](https://github.com/tjakobsson/uatu/issues/183); naming it once is what
  stops the next call site from re-deriving it wrongly.

### Modified Capabilities

- `document-outline`: outline jumps and active-heading tracking are stated
  against the effective scroll container rather than the preview shell, and both
  gain a touch/stacked-layout scenario.
- `find-in-surface`: `⌘F` brings its target surface forward before opening the
  bar, so the bar never mounts in a hidden subtree while native find stays
  suppressed.
- `project-search`: `⇧⌘F` reveals the Search pane however it is hidden — a
  collapsed sidebar *or* a non-Files touch tab.
- `touch-navigation`: the "the surface the user is acting on comes forward" rule
  extends from preview-bound navigations to surface-directed keyboard shortcuts.

## Impact

**Code**

- New: `src/shell/preview-scroll-root.ts` (the resolver; `shell/` because it
  already owns `ui-mode`, and both `find/` and `preview/` depend on it without
  introducing a new cross-feature edge).
- `src/find/highlight.ts` — `revealRange()` viewport-rect and scroll-padding
  handling for the root scroller.
- `src/find/reveal.ts`, `src/find/preview-engine.ts` — resolve the container per
  call instead of capturing `.preview-shell` at module load.
- `src/find/shortcut.ts`, `src/find/find-bar.ts`, `src/find/engine.ts` — the
  surface-reveal seam on the engine contract.
- `src/preview/outline.ts` — `resolveRoots()` delegates to the shared resolver;
  `attachScrollSpy()` subscribes to the right event target.
- `src/preview/anchors.ts`, `src/preview/mount.ts`, `src/shell/history.ts` —
  anchor and navigation scroll paths.
- `src/sidebar/search-pane.ts`, `src/shell/tab-bar.ts` — the Files-tab reveal.
- `src/styles.css` — `scroll-padding-top` on the touch-mode and ≤900px
  scrollers.

**Tests**

- Unit tests for the resolver and for `revealRange()` against a viewport-shaped
  container.
- E2E coverage in touch mode (`data-ui-mode="touch"`) for reveal, outline jump,
  `⌘F` from Files, and `⇧⌘F` from Preview.
- A real-device pass on iPhone and iPad, with a hardware keyboard for the two
  shortcut fixes — the Tailscale rig, hub on port 4705. The daily edge hub on
  4701 stays up.

**Release notes**

All four issues are in code shipped after `v0.4.0` (touch mode landed via
[#176](https://github.com/tjakobsson/uatu/pull/176) and
[#184](https://github.com/tjakobsson/uatu/pull/184)), so the PR keeps its
truthful `fix(...)` title and carries a Release Please override in the body.
