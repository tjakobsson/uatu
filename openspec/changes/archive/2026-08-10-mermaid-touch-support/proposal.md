## Why

Mermaid diagrams are the one preview surface that never got a touch pass, and
in every page-scrolling layout most of them never render at all.

The lazy-render observer picks its own root by walking up for a computed
overflow of `auto`. In touch mode and in the ≤900px stacked layout, `<body>`
carries `overflow: auto` and so terminates that walk — but `<body>` is also
`height: 100%`, and its overflow propagates to the viewport, so the page is
what actually scrolls. The result is an intersection root that is one screenful
tall, anchored at the top of the document, and that never moves relative to the
content. Diagrams below that first screenful (plus the observer's margin) are
clipped out of the root permanently: they do not render at mount, and scrolling
to them does not render them either. They stay pending placeholders for the
life of the page. Measured on a 12-diagram document, 2 of 12 render in touch
mode and 1 of 12 in the stacked layout, in both Chromium and WebKit, and a full
scroll sweep changes neither number.

And the fullscreen viewer, the affordance for reading a dense diagram on a
small screen, cannot be operated by touch at all: it is sized in `100vh`, so on
iOS its toolbar — including the close control — sits below the visible fold
behind the URL bar, and there is no pinch gesture, so enlarging a diagram means
tapping a 32px button that is itself off-screen.

The two defects differ in release status. The viewer's touch gaps arrive with
touch mode, which is unreleased. The lazy-render defect does not: `v0.4.0`
ships both the walk-up and the ≤900px `body { overflow: auto }`, so any
released build viewed in a window narrower than 900px already loses its
diagrams. That is a stable regression and stays a visible `fix` in the release
notes.

## What Changes

**Lazy rendering (issue [#186](https://github.com/tjakobsson/uatu/issues/186))**

- The Mermaid lazy-render observer stops deriving its own scroll root. The
  private `nearestScrollRoot()` walk-up in `src/render/preview.ts` is removed
  and the root becomes an injected dependency, supplied by `preview/mount.ts`
  from the existing single resolver in `src/shell/preview-scroll-root.ts`.
- A new `previewObserverRoot()` adapter translates the resolved scroller into
  what `IntersectionObserver` needs: `null` when the scroller is the viewport.
  Neither `<body>` nor `documentElement` works as an element root in these
  layouts — both are `height: 100%` boxes pinned to the document origin, which
  is exactly the clipping that loses the diagrams. Only the implicit root
  tracks the visible region as the page scrolls.
- Observation is re-established when the UI mode switches mid-session. An
  observer's root is fixed at construction, so a live desktop↔touch flip
  otherwise leaves it bound to the stale root.

**Fullscreen viewer (issue [#187](https://github.com/tjakobsson/uatu/issues/187))**

- The viewer is sized to the dynamic viewport and padded for safe areas, so its
  toolbar and close control are reachable in Safari and in an installed PWA.
- Two-finger pinch zooms the diagram, anchored on the midpoint between the
  pointers — the touch counterpart of cursor-anchored wheel zoom.
- Double-tap fits the diagram to the screen, detected explicitly rather than
  through `dblclick`, which is unreliable on touch under `touch-action: none`.
- A second finger can no longer hijack an in-progress one-finger pan.
- Panning is clamped so part of the diagram always remains on screen, in both
  input modes — today a fling loses the diagram entirely and only the fit
  button recovers it.
- Dismissal stays exactly the close button and Escape. No swipe-to-dismiss:
  the whole surface is a one-finger pan target, so a downward drag already
  means "move the diagram up".
- All existing desktop mouse and keyboard behavior is preserved unchanged.

## Capabilities

### New Capabilities

None. Both parent requirements already exist as siblings in
`mermaid-rendering`, and the scroll-root contract already exists in
`preview-scrolling`.

### Modified Capabilities

- `mermaid-rendering`: the lazy-rendering requirement gains the obligation to
  observe against the effective scroll container in every layout rather than
  deriving one locally, to guarantee that a deferred diagram is deferred rather
  than abandoned — every diagram must remain reachable by scrolling — and to
  re-observe when the UI mode changes. The
  fullscreen-viewer requirement gains touch operation — pinch zoom, double-tap
  to fit, single-pointer pan integrity, clamped panning, and a close control
  that stays reachable inside the dynamic viewport and safe areas.
- `preview-scrolling`: the "exactly one resolver serves every caller" rule is
  extended past scroll-position callers to viewport-observation callers, which
  need the resolved container expressed as an `IntersectionObserver` root
  rather than as an element, and which must re-subscribe on a live mode switch
  because their root is fixed at construction.

## Impact

**Source**

- `src/render/preview.ts` — remove `nearestScrollRoot()`; accept an injected
  observer-root resolver; stash it for the theme-flip reinstall path; expose
  re-observation of still-pending nodes.
- `src/shell/preview-scroll-root.ts` — add `previewObserverRoot()`, joining
  `previewScrollEventTarget()` and `scrollportRect()` as the third adapter over
  the same resolution.
- `src/preview/mount.ts` — supply the resolver at both `renderMermaidDiagrams`
  call sites.
- `src/preview/mermaid.ts` — subscribe to `onUiModeChange` alongside the
  existing `onColorSchemeChange` subscription.
- `src/preview/mermaid-viewer.ts` — pointer bookkeeping for pan/pinch, tap
  detection, pan clamping.
- `src/styles.css` — `.mermaid-viewer` dynamic-viewport sizing, toolbar safe
  areas, coarse-pointer touch targets.

**Layering**

`src/render/` keeps its only project import (`shared/app-url`). The layout
knowledge stays in `shell/`, injected by `preview/`, so the renderer remains
usable from a non-browser DOM.

**Tests**

`src/shell/preview-scroll-root.test.ts` and `src/render/preview.test.ts` for
the rule and the injection seam; `tests/e2e/mermaid.e2e.ts`,
`tests/e2e/mobile.e2e.ts`, and `tests/e2e/ipad.e2e.ts` for touch behavior. A
real-device pass on iPhone and iPad, including an installed PWA, covers the
safe-area and dynamic-viewport cases that emulation cannot decide.

**Also fixed, not just touch**

The ≤900px stacked layout resolves through the same `<body>` and loses its
diagrams the same way — a released defect, not a touch-mode one. The wide
desktop layout, where `.preview-shell` is a real scroll container, is the only
layout that resolves correctly today, and its behavior must be unchanged. No
dependency, API, or server-side impact.
