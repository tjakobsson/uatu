## 1. The shared scroll-root resolver

- [x] 1.1 Add `src/shell/preview-scroll-root.ts` exporting `previewScrollRoot()` and `previewScrollEventTarget()`, resolved per call from computed style (the shell is the scroller when its computed `overflow-y` is not `visible`; the split layout's rendered pane keeps its existing precedence; otherwise the viewport scroller)
- [x] 1.2 Add `src/shell/preview-scroll-root.test.ts` covering desktop-single, split, `data-ui-mode="touch"`, and the ≤900px stacked case, plus the event-target pairing for each
- [x] 1.3 Extract the sticky-header reservation into a custom property in `src/styles.css` and reference it from `.preview-shell`, keeping the desktop-host `calc(… + var(--titlebar-inset, 0px))` variant composing through it
- [x] 1.4 Reserve the same inset on `:root` inside `html[data-ui-mode="touch"]` and inside the `@media (max-width: 900px)` block, so the reservation follows whichever element scrolls

## 2. Reveal geometry

- [x] 2.1 Rework `revealRange()` in `src/find/highlight.ts` to compute against a scrollport rect — `getBoundingClientRect()` for an element scroller, `{ top: 0, bottom: clientHeight, height: clientHeight }` for the viewport scroller — and to read `scroll-padding-top` from the resolved container's computed style
- [x] 2.2 Add unit coverage in `src/find/highlight.test.ts` (or a sibling) for a viewport-shaped container: a match below the fold scrolls, a match already visible does not, and the reveal bias lands where the desktop path lands
- [x] 2.3 Point `src/find/reveal.ts:67` at `previewScrollRoot()` instead of the module-level `.preview-shell`, keeping the focus target on the shell
- [x] 2.4 Point `src/find/preview-engine.ts:37,104` at `previewScrollRoot()` for both `paint(reveal)` and `focusSurface()`

## 3. Outline

- [x] 3.1 Make `resolveRoots()` in `src/preview/outline.ts` delegate its scroll-root half to `previewScrollRoot()`, keeping `headingsRoot` as it is
- [x] 3.2 Make `attachScrollSpy()` subscribe via `previewScrollEventTarget()` while reading position from the resolved element
- [x] 3.3 Re-bind the scroll spy on a UI-mode switch, in addition to the existing remount and layout-change triggers
- [x] 3.4 Verify the outline entry click (`scrollIntoView({ block: "start" })`) lands clear of the sticky header now that the reservation follows the scroller; add the touch-mode assertion to the outline tests

## 4. Navigation and anchor scroll paths

- [x] 4.1 Point the scroll-to-top on document switch (`src/preview/mount.ts:334`) at `previewScrollRoot()`
- [x] 4.2 Point the hash-only-back scroll-to-top (`src/shell/history.ts:136`) at `previewScrollRoot()`
- [x] 4.3 Confirm the in-page anchor click (`src/preview/anchors.ts:69`) and the post-navigation fragment scroll clear the sticky header under the new reservation, in touch mode and in the stacked layout

## 5. Surfaces are visible before they are acted on

- [x] 5.1 Add optional `revealSurface?(): void` to the `FindEngine` contract in `src/find/engine.ts`, documented alongside the other optional members
- [x] 5.2 Implement it on the preview engine as `revealPreviewSurface()`; leave the terminal engine without it
- [x] 5.3 Call `engine.revealSurface?.()` from `openFindBar()` in `src/find/find-bar.ts`, before the bar is mounted, so every entry point (shortcut and host bridge) is covered
- [x] 5.4 Add `revealFilesSurface()` to `src/shell/tab-bar.ts`, mirroring `revealPreviewSurface()` and a no-op outside touch mode
- [x] 5.5 Call it from `openSearchPane()` in `src/sidebar/search-pane.ts` as its first act, before `setSidebarCollapsed(false)` and well before `queryInput.focus()`

## 6. Automated coverage

- [x] 6.1 Extend the touch-mode E2E file with a reveal case: activate a Search pane result and assert the scroll position moved and the match is in view
- [x] 6.2 Add an outline-jump E2E case in touch mode asserting the heading's top clears the sticky header's bottom edge
- [x] 6.3 Add an E2E case for `⌘F` from the Files tab asserting the Preview tab becomes active and the find bar is visible with focus in its input
- [x] 6.4 Add an E2E case for `⇧⌘F` from the Preview tab asserting the Files tab becomes active with the Search pane visible and focused
- [x] 6.5 Run `bun test` and `bun test:e2e` and confirm no desktop landing position changed — 1327 unit pass; E2E 289 passed / 2 failed, both the pre-existing macOS-local failures unrelated to this branch (see the note below), and the desktop suites unchanged

## 7. Device pass

- [ ] 7.1 Serve the branch over the Tailscale rig on port 4705, leaving the daily edge hub on 4701 untouched
- [ ] 7.2 On iPhone, verify search-result reveal, outline jump, find-bar next/previous, in-page anchor clicks, and scroll-to-top on document switch
- [ ] 7.3 On iPad with a hardware keyboard, verify the same list plus `⌘F` from Files and `⇧⌘F` from Preview and from Terminal
- [x] 7.4 Measure the sticky header's computed height in touch mode and give the reservation a touch-mode value if it differs from the desktop 9rem (design.md open question) — it differs: 145.06px at 320–430px wide against 111.47px at 1280px, so the desktop 9rem (144px) was ~1px SHORT of the header alone and landed targets under it. Page-scrolling layouts now reserve 11.5rem. Measured in Chromium emulation; 7.2/7.3 confirm it on real Safari
- [ ] 7.5 Confirm no revealed target lands under the bottom tab bar; add `scroll-padding-bottom` only if it does (design.md open question)
- [ ] 7.6 Verify active-heading highlighting tracks scrolling in touch mode, and that switching modes mid-session leaves every scroll path working without a reload
- [ ] 7.7 File any blast-radius misbehaviour the pass surfaces that is not fixed here, rather than widening this change

## Conventions for this change

Work item B ([#209](https://github.com/tjakobsson/uatu/issues/209)) is the
sibling change `pwa-cleanup-and-login-return-to`. Both land in **one PR** — main
is squash-only with required checks, so a second PR would leave the other branch
behind and re-run the full validate cycle.

The PR body repeats the closing keyword per issue —
`Closes https://github.com/tjakobsson/uatu/issues/181`,
`Closes https://github.com/tjakobsson/uatu/issues/183`,
`Closes https://github.com/tjakobsson/uatu/issues/191`,
`Closes https://github.com/tjakobsson/uatu/issues/192` — because a comma-joined
list only closes the first. Verify each issue actually closed after merge.

Every issue here is in code shipped after `v0.4.0`, so the PR keeps its truthful
`fix(...)` title and carries a Release Please override in the body:

```text
BEGIN_COMMIT_OVERRIDE
chore(touch): stabilize touch-mode scrolling and surface reveal before release
END_COMMIT_OVERRIDE
```

Archiving both changes is the branch's **last** commit, inside the same PR, via
the `openspec-archive-change` skill — merging with a change still active forced a
follow-up archive PR last time
([#226](https://github.com/tjakobsson/uatu/pull/226)). The new
`preview-scrolling` spec needs a `## Purpose` line when it is synced: *"Define
which element actually scrolls the preview for the current layout and UI mode,
and the obligation on every scroll-and-reveal path to target it."*
