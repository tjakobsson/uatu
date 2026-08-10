## Context

Two Mermaid defects on iPhone and iPad, in different subsystems, sharing one
spec capability and one device-verification pass.

**Lazy rendering.** `src/render/preview.ts` picks its `IntersectionObserver`
root with a private `nearestScrollRoot()` walk-up that looks for a computed
overflow of `auto|scroll|overlay`. That is a second, independently written
answer to the question `src/shell/preview-scroll-root.ts` was created to answer
once. It was the one call site the consolidation missed, because it is not a
`scrollTop` assignment and so did not present the symptom the earlier work was
chasing.

Touch mode sets `html[data-ui-mode="touch"] body { overflow: auto }`, and the
≤900px stacked layout sets the identical rule. Either makes `<body>` match the
walk-up and terminate it. But `<body>` is also `height: 100%` (the base rule at
the top of `styles.css`), and with `html` at `visible` the body's overflow
propagates to the viewport, so the *page* is the real scroller. What the
observer gets as its root is therefore a box exactly one screenful tall, pinned
to the document origin, that does not move relative to the content when the
page scrolls:

```
  scrollY = 0                          scrollY = 3000
  ┌─ root = <body>, 844px ─┐           ┌─ visible screen ─────────┐
  │ ┌ visible screen ────┐ │           │    diagram 9   ·         │  ← in view,
  │ │  diagram 1   ✓     │ │           │    diagram 10  ·         │    still
  │ │  diagram 2   ✓     │ │           └──────────────────────────┘    clipped
  │ └────────────────────┘ │                                            out of
  └────────────────────────┘             root = <body> is up here,       the root
       diagram 3   ·   ← clipped out     off-screen above, still
       …                of the root      844px tall and still
       diagram 12  ·                     pinned to the document top
```

So the diagrams below the first screenful (plus the 50% root margin) are not
deferred — they are abandoned. They never intersect, never enqueue, and never
render, and scrolling to them changes nothing. Measured against a 12-diagram
document: 2 of 12 render in touch mode, 1 of 12 in the stacked layout, in both
Chromium and WebKit, and a 30-pass scroll sweep leaves both numbers unchanged.

That makes this a content-availability defect rather than the performance
repair it was first taken for, and it is not confined to touch mode. `v0.4.0`
ships both the walk-up and the ≤900px `body { overflow: auto }`, so a released
build in a window narrower than 900px already loses its diagrams. Only the wide
desktop layout, where `.preview-shell` is a genuine scroll container, resolves
correctly today.

This is the third appearance of one misconception in this subsystem, though it
bites in the opposite direction from the first two. `scrollportRect()` documents
those: a `documentElement` rect used as a visible box or as a coordinate origin.
Here the mistake is not that the root is too large but that it is the wrong box
entirely — an element that has an overflow value without being the thing that
scrolls. Asking "does this element have a scrolling overflow?" cannot
distinguish the two, which is precisely why the answer belongs to the one
resolver that already knows.

**Fullscreen viewer.** `src/preview/mermaid-viewer.ts` was written for a mouse.
Pointer events give it one-finger pan for free, and nothing else transfers:
`100vh` sizing puts the toolbar below the iOS fold, `touch-action: none` swallows
pinch without replacing it, unconditional `pointerdown` bookkeeping lets a second
finger hijack a pan, and unbounded panning can lose the diagram off-screen with
the only recovery being a button that is itself unreachable.

**Constraints.**

- `src/render/` has exactly one project import (`shared/app-url`) and must not
  gain a `shell/` dependency; the renderer has to stay usable from a
  non-browser DOM.
- The unit DOM is linkedom: no `getComputedStyle`, no `scrollingElement`, no
  `clientHeight`. Rules can be unit-tested; cascade wiring is an E2E question.
- UI mode switches live, without a reload and without re-mounting the document.
- Desktop mouse and keyboard behavior is settled and must not regress.

## Goals / Non-Goals

**Goals:**

- One resolver answers "what does the preview scroll against?" for every
  consumer, including viewport-observation consumers, so a fourth layout needs
  no new call-site knowledge.
- Off-screen diagrams stay deferred in touch mode exactly as they do on
  desktop.
- A dense diagram can be opened, enlarged, moved around, and dismissed using
  touch alone.
- Desktop behavior is bit-for-bit what it is today.

**Non-Goals:**

- Rewriting the lazy-render queue, the SVG cache, or the placeholder treatment.
  Only root selection and re-observation change.
- Rotation-driven or resize-driven re-fit of an open viewer. Out of scope; the
  fit control remains the recovery.
- Swipe-to-dismiss, momentum/inertial panning, or a rotate gesture.
- Making the inline preview diagram itself zoomable. The viewer is the
  "look closer" affordance and stays so.

## Decisions

### Inject the observer root rather than importing the resolver

`renderMermaidDiagrams(container, themeInputs, resolveObserverRoot?)` takes a
resolver function; `preview/mount.ts` supplies `previewObserverRoot` at both
call sites. Omitting it degrades to `root: null`, which is what a non-browser
DOM gets today.

*Why not import `shell/preview-scroll-root` into `render/preview.ts`?* It is
the shorter diff, and it is the wrong direction: `render/` is a cross-cutting
domain that today depends on nothing but `shared/`, and `preview/mount.ts`
already imports `previewScrollRoot`. Injection puts the layout knowledge where
the layout lives and keeps the renderer testable without a cascade.

*Why a resolver function and not an `Element | null` value?* The theme-flip path
(`rerenderMermaidDiagrams`) reinstalls over the last container without the
caller present, and re-observation after a mode switch needs a fresh answer.
Storing a resolver alongside `lastInstallContainer` gives both paths a current
root; storing a value would freeze the one captured at mount.

### `previewObserverRoot()` returns `null` for the viewport, not `documentElement`

The adapter maps the resolved container to what `IntersectionObserver`
actually wants: `null` when it is the viewport scroller, the element otherwise.

*Why not pass `previewScrollRoot()` straight through?* Because that returns
`document.scrollingElement` — `<html>` — and an element root's intersection
rectangle is that element's box. Measured in touch mode, `documentElement`'s
box is 844px pinned to the document origin, exactly like `<body>`'s: swapping
one for the other reproduces the bug verbatim. The viewport scroller has no
element whose box tracks the visible region, which is why the API provides the
implicit root, and why the translation cannot be skipped. This is the same
translation `previewScrollEventTarget()` performs
for listeners and `scrollportRect()` performs for geometry, and it belongs in
the same module for the same reason: one place where the difference between
"the scroller" and "how this API wants the scroller expressed" is written down.

### Re-observe on UI-mode change; do not re-render

An observer's root is fixed at construction, so a live desktop↔touch flip
strands it on the previous root. `preview/mermaid.ts` — already the home of the
`onColorSchemeChange` subscription — subscribes to `onUiModeChange` and asks
the renderer to re-observe.

Re-observation disconnects the current observer, builds a new one against the
freshly resolved root, and observes **only nodes still carrying the pending
class**. It must not walk the theme-flip path, which restores each node's
stashed source and clears `data-processed` to force a re-render: the theme has
not changed, every diagram would be a cache hit at best and a visible flash at
worst, and already-rendered diagrams have nothing to gain from observation.

*Why not resolve the root per-callback instead?* The observer API does not
allow it; the root is constructor-only. Re-observation is the only mechanism
available.

### Track pointers in a Map; two pointers means pinch

The viewer replaces its single `pointerId`/`panStart` pair with a Map of active
pointers keyed by `pointerId`.

- **1 pointer** — pan, as today, seeded from that pointer's position.
- **2 pointers** — pinch. Scale by the ratio of current to initial pointer
  distance, anchored on the midpoint between them, reusing the existing
  `zoomAtPoint` anchoring math and the existing `MIN_SCALE` 0.2 / `MAX_SCALE`
  8 clamp. Pan is suppressed while pinching.
- **back to 1 pointer** — re-seed the pan origin from the surviving pointer
  before resuming, or the diagram jumps by the distance between the two.
- **≥3 pointers** — ignore the extras rather than inventing behavior for them.

The midpoint anchor is the direct touch analogue of cursor-anchored wheel zoom:
the point between the fingers stays under the fingers. Anchoring on the
viewport center instead would make the content slide away from the gesture.

### Detect double-tap explicitly; keep `dblclick` for the mouse

A tap-timing check on `pointerup` (two taps inside a short window and a small
movement threshold) triggers fit-to-screen. The existing `dblclick` listener
stays for mouse input.

*Why not rely on `dblclick` alone?* It is synthesized inconsistently on touch,
and `touch-action: none` — which the viewport needs for pan — interferes with
the synthesis. Two independent detectors, each reliable for its own input mode,
beat one that is unreliable for half of them.

### Clamp panning so the diagram cannot be lost

After every pan and zoom, clamp the translation so at least a fixed margin of
the scaled stage stays inside the viewport on each axis. This applies in both
input modes; on desktop it is a small forgiveness improvement, on touch it
removes a dead end.

*Why not clamp to "fully contained"?* That fights the purpose of the viewer —
at high zoom the diagram is deliberately larger than the screen and must be
pannable past its edges. Only the "everything off-screen" state is disallowed.

### Dismissal is the close button and Escape — nothing else

*Rejected: swipe-down-to-dismiss.* The entire viewport is a one-finger pan
surface, so a downward drag already has a meaning — move the diagram up. Any
dismiss gesture layered on it either fires while the user is reading the bottom
of a tall diagram or needs a velocity/threshold heuristic that will
misclassify. The close button becomes reliably reachable once the dialog is
sized to the dynamic viewport, which is the actual fix for "trapped in the
overlay".

### Dynamic-viewport sizing and safe areas

`.mermaid-viewer` sizes to `100dvh` with a `100vh` first declaration as the
fallback for engines without dynamic viewport units. The toolbar takes
`env(safe-area-inset-bottom)` padding, and the horizontal insets so landscape
on a notched device does not tuck it under the sensor housing. Toolbar buttons
grow to a 44px minimum under `(pointer: coarse)`, keyed the same way the
terminal keybar and size steppers already are — the affordance follows the
input device, not the persisted UI mode, so an iPad in desktop mode keeps
touch-sized controls.

This mirrors the terminal panel, which already sizes itself against the
dynamic viewport for the same reason.

## Risks / Trade-offs

**The mechanism was inferred wrongly at proposal time and has been corrected.**
→ The original text predicted eager rendering from a whole-document root. The
measured behavior is the opposite: a one-screenful root that abandons every
diagram below it. Both the classification (content availability, not
performance) and the blast radius (the released ≤900px layout, not only touch
mode) changed as a result, and the release-note treatment changed with them.
The remaining risk is that a real device disagrees with emulated WebKit; the
device pass is where that would surface, and the fix — one resolver instead of
two — is right either way.

**Fixing the root could regress the wide desktop layout**, which is the one
layout that resolves correctly today and the one with an actual element
scroller. → `pickScrollRoot` already returns `.preview-shell` there and the
adapter passes it through unchanged, so the observer sees the same root it sees
now. Guarded by the existing desktop lazy-render E2E test, which must keep
passing untouched.

**Re-observation on mode switch could double-render a diagram** if a node is
mid-flight in the queue when the observer is rebuilt. → The generation tag
already guards this: re-observation does not bump the generation, and only
pending-class nodes are re-observed, so an in-flight node is not re-enqueued.
Worth an explicit test rather than trust.

**Pinch and pan can interleave badly** — a finger landing during a pan, or one
lifting during a pinch — producing jumps. → The re-seed step on every pointer
count transition is the mitigation, and it is the part most worth an E2E test,
since it is the failure users will actually hit.

**Pan clamping changes desktop behavior.** → It is a deliberate, small
behavioral change in both modes rather than a touch-only branch, because two
different pan models in one viewer would be worse than one slightly stricter
one. The clamp only forbids the fully-off-screen state.

**Emulated touch cannot decide the safe-area and dynamic-viewport cases.** →
Playwright covers gesture logic and reachability within an emulated viewport;
the URL-bar and home-indicator behavior needs the real-device pass on iPhone
and iPad including an installed PWA.

## Migration Plan

None. No persisted state, no stored preference, no API surface, no dependency
change. Both parts are behavioral fixes inside the client bundle and take
effect on the next load.

## Open Questions

Both questions raised at proposal time have been answered by measurement, in
Chromium and in WebKit, against the emulated iPhone viewport the E2E suite uses.

- **Does `getComputedStyle(body).overflowY` report `auto` in touch mode?** Yes,
  in both engines — `<body>` is what the walk-up selects. What the proposal got
  wrong was the consequence, not this step.
- **Is a diagram ever left permanently unrendered?** Yes, and it is the normal
  case rather than an edge case: every diagram below the first screenful is
  permanently unrendered in touch mode and in the ≤900px stacked layout. The
  `display: none` Files-tab case was checked separately and is *not* an
  additional failure mode — mounting behind the hidden shell and then switching
  tabs produces exactly the same counts as mounting with the preview visible.
  The root clipping is the whole story.

What remains genuinely open is only what emulation cannot decide, and it is
carried by the device pass in task 6.6: the URL-bar and home-indicator geometry
behind the viewer's dynamic-viewport sizing and safe-area padding.
