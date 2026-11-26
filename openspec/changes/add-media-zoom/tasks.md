# Tasks

Work test-first: each task's tests go red before the implementation turns
them green. Unit tests sit next to their module (`foo.ts` / `foo.test.ts`).
E2E fixtures go through `/__e2e/reset` extras, as in
`tests/e2e/svg-visibility.e2e.ts`. Touch coverage uses
`test.use({ hasTouch: true, isMobile: true })` blocks. No test writes into
`openspec/`.

## 1. Zoom engine

- [x] 1.1 Create `src/zoom/transform.ts` with pure transform math: clamp,
  point-anchored zoom, fit and centring, the *keep-visible* (48px) pan
  bound, the *cover* pan bound with an at-fit floor, and the actual-pixels
  scale for a given `devicePixelRatio`. Port the constants from
  `src/preview/mermaid-viewer.ts`. Verify with
  `src/zoom/transform.test.ts`, covering anchor invariance, clamp limits,
  both bounds at the edges, and fit for wide, tall and tiny content.
- [x] 1.2 Create `src/zoom/gestures.ts` by lifting the pointer-map state
  machine out of `mermaid-viewer.ts` (pan, pinch, tap, double-tap, and
  re-seeding when the pointer count changes). It takes plain point records
  so Pointer and Touch events can both feed it. Verify with
  `src/zoom/gestures.test.ts`, covering 1→2→1 finger transitions without a
  jump, a third finger ignored, a wandering drag that is not a tap, a tap
  then a pan then a tap that is not a double-tap, a cancelled pointer, and
  backdrop-tap classification.
- [x] 1.3 Add `src/zoom/boundary.test.ts`, which asserts that no module in
  `src/zoom/` imports `preview/`, `chat/`, `shell/state`, `shell/storage`,
  `shell/personal-state` or `shell/presentation-storage`. Verify that it
  fails when such an import is added and passes on the clean folder.

## 2. Shared fullscreen viewer

- [x] 2.1 Create `src/zoom/viewer.ts` from `mermaid-viewer.ts` on top of
  the engine. It needs an `open(descriptor, options)` API for Mermaid clones
  (with `remapSvgIds`) and for `<img>` content from a supplied real source,
  plus the toolbar (zoom out, zoom in, fit, "1:1 actual pixels" for raster
  only, "Open link" for linked media only, close), the keys, `returnFocusTo`
  and an `afterClose` hook. Close on a tap or click on the empty backdrop,
  never on a drag. Render raster pixelated above native size. Commit the
  layout size about 120ms after input stops, and expose the committed state
  as `data-zoom-state`. Rename the CSS in `src/styles.css` from
  `mermaid-viewer*` to `media-viewer*`, keeping `100dvh`, the safe areas and
  44px coarse targets. Verify with `src/zoom/viewer.test.ts` (linkedom):
  toolbar contents per media kind, focus return, and the stage holding a
  real source rather than a placeholder.
- [x] 2.2 Move Mermaid to the shared viewer. Switch `src/preview/mermaid.ts`
  and the close calls in `mount.ts`, `image.ts`, `empty.ts`, `binary.ts`,
  `diff.ts` and `commit-message.ts` to the new API, then delete
  `src/preview/mermaid-viewer.ts`. Update the selectors in
  `tests/e2e/mermaid.e2e.ts`, `tests/e2e/mobile.e2e.ts` and
  `tests/e2e/ipad.e2e.ts`. Switch `tests/e2e/transform-helpers.ts` to
  `data-zoom-state`. Verify that every existing viewer test passes unchanged
  in intent, except the "editing the watched file … closes the viewer"
  test, which group 5 rewrites.
- [x] 2.3 Add viewer E2E tests to a new `tests/e2e/media-zoom.e2e.ts`:
  backdrop click closes; a drag that starts on the backdrop does not close
  (mouse and touch); a click on the media does not close; Escape and close
  return focus; at 3000×2000 a PNG reaches 1:1 with one natural pixel per
  device pixel and computed `image-rendering: pixelated` above native size;
  an SVG at 6× has a committed layout width equal to base × scale; an SVG
  containing `<script>` stays an `<img>` and its script never runs. Verify
  with `bun run test:e2e tests/e2e/media-zoom.e2e.ts tests/e2e/mermaid.e2e.ts`.
- [x] 2.4 Document the new folder: add `src/zoom/` to the `src/` map in
  `CLAUDE.md` and to the folder tour in `ARCHITECTURE.md`, and remove
  `mermaid-viewer` from the `preview/` descriptions. Verify that both maps
  list `zoom/` with its engine, inline controller and viewer, and that
  `grep -rn mermaid-viewer CLAUDE.md ARCHITECTURE.md src` finds nothing.

## 3. Inline zoom in the preview

- [x] 3.1 Create `src/zoom/media.ts`, the media descriptor: kind, real
  source, identity key (the resolved URL without `revision`, or
  `mermaid:<index>`), enclosing link, aspect ratio, and the small-media test
  (either side below 96 CSS px). Verify with `src/zoom/media.test.ts`,
  covering revision stripping, `#`/`?` in file names, the 95/96px boundary,
  link detection, and Mermaid indexing.
- [x] 3.2 Create `src/zoom/inline.ts`, the inline controller. It builds the
  frame, activator and toolbar (zoom in, zoom out, fit, expand) as siblings,
  never nested. The toolbar shows on hover (`(hover: hover)`) and on focus
  within. Drag pans only past fit. There is no `wheel` listener. On touch:
  `touch-action: pan-x pan-y` at fit, with a non-passive second-touch
  `preventDefault` feeding `gestures.ts`; `touch-action: none` once zoomed;
  fit and expand shown once zoomed. Click or tap at fit opens the viewer.
  Verify with `src/zoom/inline.test.ts` (linkedom): DOM structure without
  nested controls, small media getting no toolbar, and the touch-action
  changes as the state moves.
- [x] 3.3 Restructure the inline Mermaid markup in `src/render/preview.ts`
  (`normalizeRenderedDiagram`). `button.mermaid-trigger` keeps the SVG,
  its accessible name and `cursor: zoom-in`; the badge becomes the toolbar's
  expand control outside the button. Update the matching CSS
  (`.mermaid-trigger*`). Verify with `normalizeRenderedDiagram` cases in
  `src/render/preview.test.ts` (no `button button`, name kept, idempotent) and
  the existing inline-sizing tests in `tests/e2e/mermaid.e2e.ts`.
- [x] 3.4 Add `src/preview/media-zoom.ts` to wire inline zoom into
  `#preview`. It attaches to rendered-document images (after
  `preparePreviewHtml` and `observePreviewSvgImages`), to the standalone
  image preview (`image.ts`) and to Mermaid diagrams as they render. It
  supplies `previewImageSource`. "Open link" calls the anchor's `click()`
  so `anchors.ts` applies, and modifier clicks fall through to the browser.
  Verify that `bun run typecheck` passes and that `src/app.ts` gains only an
  init call.
- [x] 3.5 Extend `tests/e2e/media-zoom.e2e.ts` with desktop inline tests
  for a PNG file, an SVG file, a document PNG, a document SVG and a Mermaid
  diagram: the toolbar appears on hover and focus; +, −, fit and drag work;
  the bounding boxes of the media and of the following paragraph are
  identical at fit, zoomed, and without the integration; the wheel scrolls
  the document and leaves the zoom unchanged; Ctrl+wheel leaves the inline
  zoom unchanged; a click at fit opens the viewer, while a click or drag
  when zoomed does not; expand opens the viewer at fit; closing keeps the
  inline zoom; a 16×16 badge opens the viewer with no toolbar; a linked
  image opens the viewer, and "Open link" loads an in-app document; Tab
  and Enter on a diagram open the viewer with the name "Open diagram in
  fullscreen viewer". Verify that the file passes.
- [x] 3.6 Add touch inline tests in a `hasTouch` block of
  `tests/e2e/media-zoom.e2e.ts`, using CDP multi-touch: a pinch on a
  document image zooms the image and leaves `visualViewport.scale` at 1; a
  one-finger drag at fit scrolls the page; a one-finger drag when zoomed
  pans and does not scroll; fit and expand appear only when zoomed; a tap at
  fit opens the viewer. Cover a Mermaid diagram and the image file preview
  too. Verify that the block passes.

## 4. Chat media

- [x] 4.1 Route chat to the shared viewer. Keep the delegated
  `[data-attachment-view]` handler in `src/chat/ui.ts`; give chat one way
  into `src/zoom/viewer.ts` in `src/chat/media-viewer.ts`, which owns the
  `blob:`/same-origin guard, passes the attachment's name as the caption,
  and keeps the `.chat-timeline` blur in `afterClose`. Remove `#chat-image-viewer` from `src/index.html` and its
  CSS from `src/styles.css`. Verify that
  `grep -rn chat-image-viewer src tests` finds nothing, and that a unit
  test of the guard rejects a cross-origin URL.
- [x] 4.2 Give chat visuals inline zoom. Restructure
  `button.chat-visual-enlarge` in `src/chat/markdown.ts` so the toolbar is a
  sibling, keep its accessible name and fallback, and attach the inline
  controller in `src/chat/visual-ui.ts`. Streaming re-renders keep each
  visual's node (retained by its resolved source), so they keep
  the zoom. Attachment thumbnails stay viewer-only as small media. Verify
  with `src/chat/markdown.test.ts` and `src/chat/visual-ui.test.ts` (no nested
  controls, name kept).
- [x] 4.3 Update `tests/e2e/chat-attachments.e2e.ts` and
  `tests/e2e/chat-visuals.e2e.ts`. Dismissal becomes Escape, close or empty
  backdrop; a click on the image keeps the viewer open; the viewBox-only
  SVG keeps nonzero enlarged dimensions inside the visible viewport. Add
  visual inline zoom on desktop and touch, zoom kept across a streamed text
  delta, and the focus-ring regression still passing. Verify that both
  files pass on desktop and touch.
- [x] 4.4 Update `docs/CHAT.md` where it describes enlarging visuals and
  viewing attachments, covering inline zoom, the viewer and the dismissal
  rules. Verify that the text matches the behaviour tested in 4.3.

## 5. Zoom across edits and navigation

- [x] 5.1 Implement the zoom session in `src/preview/media-zoom.ts`, keyed
  by (selected id, view mode, layout). For the same session, snapshot before
  the body is replaced and restore on image `load` or diagram render, with a
  1% aspect-ratio tolerance; drop all Mermaid states when the diagram count
  changes. A different session closes the viewer and clears the carry.
  The open viewer swaps in matched content (images preloaded, Mermaid
  re-cloned) or keeps its content and resets to fit. Verify with
  `src/zoom/inline.test.ts` cases for the carry rules: match, aspect change,
  count change, missing media and a session change.
- [x] 5.2 Rewrite the file-edit test in `tests/e2e/mermaid.e2e.ts`: the
  viewer stays open with the same transform and shows the re-rendered
  diagram. Add tests to `tests/e2e/media-zoom.e2e.ts`: a zoomed PNG
  rewritten with the same aspect keeps its zoom, inline and in the viewer;
  a different aspect resets to fit; adding a diagram resets all diagrams
  and an open viewer goes to fit; a removed image leaves the viewer open at
  fit; Follow to another file closes the viewer, and returning shows fit; a
  reload shows fit, and neither `localStorage` nor the URL holds a zoom
  value. Verify that both files pass.

## 6. Documentation and integration checks

- [x] 6.1 Update the `README.md` feature list (from "Mermaid … fullscreen
  pan/zoom viewer" to zoom and pan for images, SVGs, diagrams and chat
  media). Add a short "Media zoom" section to `ARCHITECTURE.md` covering
  the engine and adapter seam, the zoom session and identity rules, and the
  commit-at-rest rendering. Verify that every path it cites exists.
- [x] 6.2 If a frame or commit budget test is added for the large-diagram
  fixture, tag it `@perf`, make deterministic commit counts its pass
  criterion, and verify with `bun run test:e2e:perf`.
- [x] 6.3 Run `bun run typecheck` and `bun run test:ci`, and verify that
  both pass.
- [x] 6.4 Run `bun run test:e2e tests/e2e/media-zoom.e2e.ts
  tests/e2e/mermaid.e2e.ts tests/e2e/mobile.e2e.ts tests/e2e/ipad.e2e.ts
  tests/e2e/svg-visibility.e2e.ts tests/e2e/find.e2e.ts
  tests/e2e/chat-visuals.e2e.ts tests/e2e/chat-attachments.e2e.ts`, then
  `bun run test:e2e:no-perf`, and verify that both pass.
- [ ] 6.5 Check pinch at fit, one-finger scrolling, and the viewer close
  control by hand on a real iPhone and iPad in Safari, in a tab and as an
  installed PWA. Record the device, OS and result in the PR, because
  emulation does not reproduce Safari's gesture handling.

## Workflow follow-up

- At PR time, assemble screenshots by running the relevant suites with
  `UATU_E2E_SCREENSHOTS_DIR=openspec/changes/add-media-zoom/screenshots`.
- Reference #670 as the issue this resolves, and mention #187 only as
  related, since it was already closed by PR #229.
- At archive, update the Purpose line of
  `openspec/specs/mermaid-rendering/spec.md` so it no longer describes the
  fullscreen viewer as Mermaid-owned.
