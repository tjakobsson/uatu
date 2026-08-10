## Context

Six modules independently answer the question "which element do I scroll?" and
all six answer `.preview-shell`, captured once at module load:

| Call site | What it does today |
| --- | --- |
| `src/find/highlight.ts:132-150` `revealRange()` | `container.scrollTop += target` |
| `src/find/reveal.ts:67` | passes the module-level `previewShellElement` |
| `src/find/preview-engine.ts:37,104` | passes `shellElement` from construction |
| `src/preview/outline.ts:284,365,454` | `scrollIntoView`, `scroll` listener, `resolveRoots()` |
| `src/preview/anchors.ts:69` | `scrollIntoView({ block: "start" })` |
| `src/shell/history.ts:136`, `src/preview/mount.ts:334` | `previewShellElement.scrollTo({ top: 0 })` |

That answer is right for the desktop layout and wrong everywhere else.
`html[data-ui-mode="touch"] .preview-shell { overflow: visible; height: auto }`
(`src/styles.css:4638`) hands scrolling to the page, and the ≤900px stacked
layout (`src/styles.css:3523`) has done the same since long before touch mode
existed. Split layout is a third case that already works: the rendered pane is
its own scroll container, and `resolveRoots()` in `outline.ts` is the only place
in the codebase that reasons about it.

`scroll-padding-top: 9rem` — the reservation that keeps a revealed target clear
of the sticky preview header and its 28px blur falloff — sits on `.preview-shell`
(`src/styles.css:1123`, desktop-host variant at `:362`). When the page scrolls,
that reservation belongs to an element that no longer participates.

The surface-level bugs are a different failure with a shared moral. In touch
mode only the active tab's surface renders; `surfaceForTab("files")` maps Files
to the preview (deliberately — directing the sidebar is an act about the
document it directs), so `⌘F` from Files calls `preventDefault()` and mounts the
bar in a `display: none` shell. `openSearchPane()` already reasons about exactly
this class of failure for the collapsed sidebar and says so in its own comment;
touch mode added a second way to be `display: none` and the reasoning was never
extended.

## Goals / Non-Goals

**Goals:**

- One resolver for "the element that actually scrolls the preview", used by
  every call site, correct for desktop-single, split, stacked, and touch.
- Every listed scroll path observably moves the view in every layout and UI mode.
- Sticky-header clearance follows the scroller.
- A surface-directed shortcut never acts on a hidden surface.
- Desktop behavior byte-for-byte unchanged.

**Non-Goals:**

- Rearchitecting touch mode's layout so `.preview-shell` scrolls again. Page
  scrolling is what gives iOS its native scroll chrome (rubber-banding,
  hide-on-scroll browser UI); reversing it would be a worse app to fix a
  narrower bug.
- Software-keyboard / `visualViewport` geometry. Reveals while the iOS keyboard
  is up are a separate problem with its own device pass.
- Broadening `⌘F` routing rules. `surfaceForTab("files") → preview` stays as it
  is; the fix is about visibility, not routing.
- The terminal surface's own scrolling, which xterm owns entirely.

## Decisions

### 1. The resolver lives in `src/shell/`, not `src/preview/`

`src/shell/preview-scroll-root.ts` exports the resolution; `find/` and
`preview/` both import it.

The brief suggested extending `outline.ts`'s `resolveRoots()` and exporting it.
Rejected: `find/` and `preview/` have **no** imports of each other today
(verified), and making `find/` depend on an outline-shaped
`{ headingsRoot, scrollRoot }` tuple would create that edge for a value one side
does not want. `shell/` already owns `ui-mode.ts` and `state.ts` and is already
a dependency of both. The brief's real point — one concept, not two — is kept:
`resolveRoots()` **delegates** to the shared resolver rather than keeping its own
copy of the rule.

Shape:

```ts
// The element that actually scrolls the preview right now.
export function previewScrollRoot(): HTMLElement
// The event target that emits `scroll` for that element (see decision 3).
export function previewScrollEventTarget(): EventTarget
// The visible box of any scroll container (see decision 2).
export function scrollportRect(container: HTMLElement): { top; bottom; height }
// The rule, lifted out of the DOM so it can be tested (see below).
export function pickScrollRoot<T>(candidates, scrolls): T
```

`scrollportRect` was going to live in `find/highlight.ts` beside the arithmetic
that needs it. It moved here once the outline turned out to need it too — see
decision 2 — which is the whole argument of this module applied to itself.

`pickScrollRoot` exists because the unit suite's DOM (linkedom) has no
`getComputedStyle`, no `scrollingElement` and no `clientHeight`. Rather than
fake all three and end up asserting against the fake, the *rule* is a pure
function over candidates and a predicate, unit-tested directly; that it is wired
to the real cascade is left to E2E, which runs a real engine.

Resolved per call, never cached: UI mode switches live, the stacked breakpoint
crosses on rotation and window resize, and the terminal's right-dock changes the
shell's geometry. The resolution is a `getComputedStyle` read on a single
element — cheap enough that caching would buy nothing and cost correctness.

The test is behavioral, not a mode lookup: the shell is the scroller when it can
actually scroll (computed `overflow-y` is not `visible`), which covers touch
mode and the ≤900px media query with one rule and needs no update if a third
layout later hands scrolling to the page. Split layout keeps its existing
special case — the rendered pane, when present, is the container for content
inside it.

*Alternative considered:* a `data-scroll-root` attribute stamped by the layout
code. Rejected — it makes the styles and the attribute two sources of truth that
can disagree, which is the bug being fixed, one indirection later.

### 2. `revealRange()` needs a scrollport rect, not a bounding rect

`revealRange()` computes its offset from `container.getBoundingClientRect()`.
For an overflow container that is the visible box. For `document.scrollingElement`
it is the **entire document box** — height equal to the full content — so both
the already-in-view test (`rect.bottom <= view.bottom`) and the reveal-bias
arithmetic go wrong: everything looks in-view and nothing scrolls, or it scrolls
to an absurd offset.

The container therefore contributes a *scrollport rect*, derived once:

- element scroller → `getBoundingClientRect()`, as today;
- viewport scroller → `{ top: 0, bottom: clientHeight, height: clientHeight }`
  from `document.documentElement`.

Same for the padding read: `scrollPaddingTop` is read from the resolved
container's computed style, which for the root scroller is `<html>` — where
decision 4 puts it.

This is the single most likely place for a silent regression, because the
desktop path is unaffected and only device testing exercises the other. It gets
a direct unit test with a synthetic viewport-shaped container.

**Found during implementation:** `revealRange()` is not the only caller. The
outline's `updateActiveHeading()` computes each heading's offset in content as
`headingTop - rootRect.top + scrollTop`, and for the document scroller
`rootRect.top` is `-scrollTop` — so the offset double-counts the scroll and
every activation point drifts further out of reach the further down the page
the reader is. Same rect, second victim. That is why `scrollportRect` ended up
in the shared module rather than beside the reveal arithmetic.

### 3. Scroll observation binds to the *event target*, not the element

For the root scroller the `scroll` event is fired at `document` and reaches
`window` — it does **not** reach `document.documentElement`, which is a child of
the node it fires at. `attachScrollSpy(scrollRoot)` currently does
`scrollRoot.addEventListener("scroll", …)`; passing `document.scrollingElement`
would compile, run, and never fire — a second silent no-op of exactly the kind
this change exists to remove.

Hence `previewScrollEventTarget()` alongside the element: `document` when the
container is the viewport scroller, the element itself otherwise. `outline.ts`
reads position from the element and subscribes to the target.

The spy must also re-bind on a UI-mode switch, which is new: today it re-binds on
remount and on layout change only. `ui-mode.ts` already notifies on mode change;
the outline subscribes.

### 4. `scroll-padding-top` moves to the root when the root scrolls

CSS: keep `.preview-shell { scroll-padding-top: 9rem }` for the desktop layout
and add the same reservation to `:root` inside both
`html[data-ui-mode="touch"]` and the `@media (max-width: 900px)` block. Scroll
padding set on the root element propagates to the viewport scrollport, which is
the standard idiom for exactly this sticky-header problem.

The value is duplicated, not moved, because the two selectors are live
simultaneously on a device that can switch modes without reloading. It is
extracted to a custom property so the two cannot drift.

**Found during implementation: the value is also wrong.** 9rem was tuned
against the desktop header, and the preview header wraps on narrow viewports —
measured at **145.06px** at 320–430px wide against **111.47px** at 1280px. So
the 144px reservation cleared the desktop header by ~32px (the 28px blur
falloff plus breathing room) and fell about 1px SHORT of the touch-mode header
on its own, landing every jumped-to target underneath the frosted chrome. That
is the whole of #183 — the scroll-padding was on the wrong element *and* too
small once it got to the right one. The page-scrolling layouts therefore
override the property to **11.5rem** (184px), which reproduces desktop's ~32px
clearance over the 145px worst case. Erring large only lands the target
slightly lower; erring small is the bug.

The desktop-host variant (`calc(9rem + var(--titlebar-inset, 0px))`) composes
through the same property. Touch mode never runs inside the desktop host, but
writing it as a `calc` over the same variable costs nothing and removes a
special case.

### 5. Surface reveal is an engine capability, not a shortcut special case

`FindEngine` grows an optional `revealSurface?(): void`, alongside the existing
optional `isAvailable?()`, `watch?()`, `unwatch?()`. `openFindBar()` calls it
before mounting.

*Alternative considered:* calling `revealPreviewSurface()` directly in
`shortcut.ts`'s `⌘F` branch. Rejected because `shortcut.ts` is not the only
entry point — the host bridge (`installHostBridge()`) opens the bar too, and a
future one would have to remember. Putting it on the contract means the engine
that owns a surface owns the obligation to make it visible, and `openFindBar` is
the one place that has to honour it.

The preview engine implements it as `revealPreviewSurface()` (already exported
from `shell/tab-bar.ts`, already a no-op in desktop mode). The terminal engine
does not implement it: in touch mode the terminal surface is active only when
its tab is, so there is nothing to reveal.

### 6. `⇧⌘F` reveals the Files tab from inside `openSearchPane()`

`shell/tab-bar.ts` gains `revealFilesSurface()`, mirroring `revealPreviewSurface()`
(no-op outside touch mode). `openSearchPane()` calls it as its first act,
immediately before the `setSidebarCollapsed(false)` that exists for the same
reason. Placing it there rather than in `shortcut.ts` keeps every caller of
`openSearchPane()` correct, including the ones that seed it from a selection.

Ordering matters: the tab must be active *before* `queryInput.focus()`, because
`focus()` on an element inside a `display: none` subtree silently does nothing.

## Risks / Trade-offs

- **A silent no-op replaced by a silent wrong scroll.** Decision 2's geometry is
  the sharp edge, and the desktop suite cannot see it. → Unit-test
  `revealRange()` against a viewport-shaped container directly, plus touch-mode
  E2E for reveal and outline jump, plus the device pass.

- **E2E cannot prove the device case.** Playwright can set `data-ui-mode="touch"`
  and drive a narrow viewport, but iOS Safari's scroll chrome, momentum
  scrolling, and dynamic toolbar are not reproduced. → E2E guards the
  regression; the real-device pass on iPhone and iPad is a required task, not a
  courtesy. Hardware keyboard needed for the two shortcut fixes.

- **Desktop regression risk across six touched call sites.** The change is broad
  and the payoff is invisible on desktop. → The resolver returns `.preview-shell`
  in the desktop layout, so every desktop path receives exactly the element it
  receives today; the existing suites are the guard, and any diff in desktop
  landing position is a bug in this change.

- **Duplicated `scroll-padding-top`.** Two selectors carrying the reservation can
  drift. → One custom property, both selectors reference it.

- **`revealSurface()` changes the active tab as a side effect of a keystroke.**
  In touch mode `⌘F` from Files now moves the user off the Files tab. → That is
  the intended reading of the issue and matches `revealPreviewSurface()`'s
  existing contract for document picks; the alternative (a find bar the user
  cannot see) is strictly worse. No-op in desktop mode.

- **Blast radius beyond the four filed issues.** `preview-engine.ts`,
  `attachScrollSpy`, `history.ts`, `mount.ts`, and `anchors.ts` were read
  statically, not device-verified, and are fixed here on the strength of sharing
  the root cause. → The device pass covers them explicitly rather than assuming
  the shared fix carries; anything that still misbehaves gets filed rather than
  chased inside this change.

## Migration Plan

No data, no persisted state, no protocol. The one user-visible discontinuity is
that `⌘F` from the Files tab now switches tabs — new behavior in place of a dead
key, requiring no migration.

Rollback is a revert: nothing here is written to disk or to `localStorage`.

## Open Questions

- ~~**Does the sticky preview header still measure 9rem of clearance in touch
  mode?**~~ Resolved, and the answer was no. Measured 145.06px at 320–430px
  wide against 111.47px at 1280px, so 9rem (144px) was about 1px short of the
  touch header alone. The page-scrolling layouts now reserve 11.5rem. Measured
  in Chromium emulation; the device pass confirms it against real Safari, where
  safe-area insets and font rendering could shift the header height again.

- ~~**Does the bottom tab bar need a matching `scroll-padding-bottom`?**~~
  Resolved: no. `.app-shell`'s `--tab-bar-total` reservation holds even for the
  last match in a document, which is the only position with no scroll runway
  left to lift it clear. Pinned by an E2E case rather than left to the eye.
