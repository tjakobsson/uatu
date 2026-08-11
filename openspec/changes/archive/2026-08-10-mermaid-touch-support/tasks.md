## 1. Confirm the diagnosis

- [x] 1.1 Read `getComputedStyle(document.body).overflowY` in touch mode on a real device and confirm it reports `auto`, so `<body>` is what the current walk-up selects
- [x] 1.2 Load a diagram-heavy document in touch mode and record whether every diagram renders at mount (eager) or some never render (absent) — the answer decides whether this is a performance repair or an initial-support blocker, and belongs in the issue thread
- [x] 1.3 Check whether a document mounted while the Files tab is active (preview shell `display: none`) still delivers its observations after the tab switch, or leaves diagrams permanently pending
- [x] 1.4 Correct the design and spec deltas if either observation contradicts the inferred mechanism

Measured in Chromium and WebKit against the emulated iPhone viewport: `<body>`
reports `overflow-y: auto` and is what the walk-up selects, but it is a
`height: 100%` box pinned to the document origin, so diagrams below the first
screenful are clipped out of the root permanently — 2 of 12 render in touch
mode, 1 of 12 in the ≤900px stacked layout, and a full scroll sweep renders no
more. The Files-tab `display: none` case is not an additional failure mode.
This is a content-availability defect, it is present in `v0.4.0` via the
stacked layout, and the artifacts have been corrected accordingly.

## 2. Shared observer-root resolution

- [x] 2.1 Add `previewObserverRoot(): Element | null` to `src/shell/preview-scroll-root.ts`, returning `null` when the resolved container is the viewport scroller and the element otherwise, documented alongside its two sibling adapters
- [x] 2.2 Extend `src/shell/preview-scroll-root.test.ts` with the translation rule, following the existing behavioural `pickScrollRoot` pattern rather than faking a cascade onto linkedom

## 3. Inject the root into the lazy renderer

- [x] 3.1 Remove `nearestScrollRoot()` from `src/render/preview.ts`
- [x] 3.2 Accept an optional observer-root resolver on `renderMermaidDiagrams`, defaulting to the implicit viewport root when absent, and confirm `src/render/` still imports nothing outside `shared/`
- [x] 3.3 Stash the resolver next to `lastInstallContainer` so `rerenderMermaidDiagrams()` reinstalls against a freshly resolved root
- [x] 3.4 Export a re-observation entry point that disconnects, rebuilds against the current root, and observes only nodes still carrying the pending class — without restoring stashed sources or clearing `data-processed`
- [x] 3.5 Supply `previewObserverRoot` at both `renderMermaidDiagrams` call sites in `src/preview/mount.ts`
- [x] 3.6 Subscribe to `onUiModeChange` in `src/preview/mermaid.ts`, next to the existing `onColorSchemeChange` subscription, and trigger re-observation
- [x] 3.7 Cover the injection seam and the pending-only re-observation in `src/render/preview.test.ts`, including that a node already in flight in the queue is not enqueued twice

## 4. Viewer reachability

- [x] 4.1 Size `.mermaid-viewer` to the dynamic viewport with a `100vh` first declaration as fallback, mirroring the terminal panel's treatment
- [x] 4.2 Pad the toolbar for `env(safe-area-inset-bottom)` and the horizontal insets so landscape on a notched device keeps it clear
- [x] 4.3 Raise toolbar buttons to a 44px minimum touch target under `(pointer: coarse)`, keyed on the pointer type rather than the persisted UI mode

## 5. Viewer gestures

- [x] 5.1 Replace the single `pointerId`/`panStart` pair in `src/preview/mermaid-viewer.ts` with a Map of active pointers
- [x] 5.2 Keep one-pointer drag panning as it behaves today, seeded from the surviving pointer on every pointer-count transition so neither a landing nor a lifting finger displaces the diagram
- [x] 5.3 Add two-pointer pinch zoom: scale by the ratio of current to initial pointer distance, anchored on the midpoint, reusing `zoomAtPoint` and the existing `MIN_SCALE`/`MAX_SCALE` clamp, with panning suppressed while pinching
- [x] 5.4 Ignore third and subsequent pointers rather than defining behavior for them
- [x] 5.5 Add double-tap-to-fit via tap timing and a movement threshold on `pointerup`, keeping the existing `dblclick` listener for mouse input
- [x] 5.6 Clamp the translation after every pan and zoom so a margin of the scaled stage always remains inside the viewport on both axes, in both input modes
- [x] 5.7 Verify dismissal is still exactly the close button and Escape, and that no downward drag can close the viewer

## 6. Verification

- [x] 6.1 Add touch lazy-render coverage to `tests/e2e/mermaid.e2e.ts`: off-screen diagrams stay pending at mount in touch mode, and scrolling renders them
- [x] 6.2 Add a mid-session UI-mode-switch case asserting pending diagrams still render afterwards and rendered ones do not flash or re-render
- [x] 6.3 Add viewer touch coverage across `tests/e2e/mobile.e2e.ts` and `tests/e2e/ipad.e2e.ts`: close control inside the visual viewport, pinch zoom, double-tap fit, second-finger pan integrity, and the pan clamp
- [x] 6.4 Assert desktop behavior is unchanged — drag-pan, cursor-anchored wheel zoom, dblclick fit, toolbar, and the `+`/`-`/`0`/`f` shortcuts
- [x] 6.5 Run `bun test` and `bun test:e2e` clean
- [x] 6.6 Real-device pass on iPhone and iPad over the Tailscale hub, in Safari and as an installed PWA, in both orientations — the safe-area and dynamic-viewport cases emulation cannot decide

`bun test` is clean (1335 pass, 0 fail). `bun test:e2e` runs 305 pass / 2 fail,
and neither failure belongs to this change: `find.e2e.ts` "⌘G steps matches
without focus in the query box" fails identically on a clean tree, and the
second slot is a rotating parallel-worker flake (`document-tree`, `outline`,
and the touch terminal paste test have each taken it) — each passes in
isolation, `outline` 3/3 and the paste test 4/5. Every test this change adds or
touches passes consistently.

The device pass confirmed the cases emulation could not decide: on iPhone and
iPad, in Safari and as an installed PWA, in both orientations, the viewer's
toolbar and close control stay inside the visible viewport and clear of the
safe areas, and the gestures behave as specified. `100dvh` plus the
`env(safe-area-inset-*)` padding is the correct treatment on real hardware, not
only in the emulated viewport.

## Conventions

Branch and PR titles follow conventional commits. Both parts are visible
release-note entries and neither needs a `BEGIN_COMMIT_OVERRIDE`. The
lazy-render defect was expected to be touch-only and therefore unreleased, but
task 1 established that it is present in `v0.4.0` through the ≤900px stacked
layout, which loses its diagrams identically — that is a stable regression and
stays a visible `fix(...)`. Say so in the note: diagrams below the first screen
never render in narrow windows, not merely "on phones". The fullscreen-viewer
touch work is a genuine `feat`. Reference both issues with full URLs and a separate closing keyword
each — `Closes https://github.com/tjakobsson/uatu/issues/186` and
`Closes https://github.com/tjakobsson/uatu/issues/187` — since a combined
`Closes #186, #187` closes only the first. Confirm both issues actually closed
after the squash merge.
