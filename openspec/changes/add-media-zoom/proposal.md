# Proposal

## Why

Large diagrams, SVGs and high-resolution screenshots often carry detail too
small to read at the size Uatu shows them.
[Issue #670](https://github.com/tjakobsson/uatu/issues/670) asks for zoom and
pan on desktop and touch, so that detail can be inspected without opening the
file in another application.

Today only rendered Mermaid diagrams can be zoomed, and only in a fullscreen
viewer (`src/preview/mermaid-viewer.ts`). Image and SVG file previews,
document images and chat media have no zoom at all; chat opens images in a
separate, non-zooming dialog that any click dismisses.

## What Changes

- Every supported media surface gets inline zoom and pan within the media's
  own box, plus one shared fullscreen viewer. The surfaces are raster and SVG
  file previews, images embedded in Markdown and AsciiDoc, rendered Mermaid
  diagrams, chat assistant visuals and chat attachment images. Media rendered
  under about 96px opens the viewer only.
- Desktop inline zoom uses an overlay toolbar (zoom in, zoom out, fit,
  expand) shown on hover and keyboard focus, and drag to pan. The mouse wheel
  never zooms inline media, so page scrolling is unaffected.
- On touch, a two-finger pinch on the media zooms the media rather than the
  page. At fit, one finger still scrolls the page; once zoomed, one finger
  pans the media.
- Clicking or tapping media at fit opens the viewer. Linked images open it
  too, and the viewer offers an "Open link" action that follows the
  preview's normal link rules.
- The viewer keeps the Mermaid viewer's wheel, pinch, double-tap and keyboard
  behaviour and always opens at fit. Raster media gains a "1:1 actual pixels"
  action and renders with crisp pixels above native size; SVG and Mermaid
  stay vector.
- **Behaviour change:** editing the shown file no longer closes the viewer.
  Inline and viewer zoom keep their scale and pan, swap in the new content,
  and reset to fit only when the media's aspect ratio changes or it can no
  longer be matched. Selecting a different file still closes the viewer and
  discards inline zoom.
- **Behaviour change:** chat's `#chat-image-viewer` dialog is replaced by the
  shared viewer. It closes with Escape, its close button, or a click on the
  empty backdrop; a click on the image or a drag no longer closes it.
- Zoom state is ephemeral and is never saved.
- No new dependency. SVGs stay inert `<img>` elements.

Out of scope: video, audio, PDF and terminal content; persisted zoom; wheel
zoom on inline media.

## Capabilities

### New Capabilities

- `media-zoom`: inline zoom and pan, the shared fullscreen viewer, the
  surfaces they apply to, their desktop and touch input, and how zoom
  behaves when content changes or the selection moves.

### Modified Capabilities

- `mermaid-rendering`: the fullscreen viewer requirement moves to
  `media-zoom`; the inline sizing scenario points detailed inspection at
  `media-zoom` instead of the viewer modal.
- `opencode-chat`: an attachment thumbnail opens the shared viewer, with the
  new dismissal rules.

The in-flight `add-agent-chat-visuals` change adds `chat-visuals`, whose
requirement that users can enlarge and dismiss a visual stays true; this
change provides that enlargement through `media-zoom` and does not edit
that change.

## Impact

- New feature folder `src/zoom/`: the transform engine, the inline zoom
  controller and the shared viewer dialog, with colocated unit tests.
- `src/preview/mermaid-viewer.ts` is folded into `src/zoom/`; its callers in
  `src/preview/` (`mount.ts`, `image.ts`, `empty.ts`, `binary.ts`, `diff.ts`,
  `commit-message.ts`, `mermaid.ts`) move to the new API.
- `src/render/preview.ts` restructures the inline Mermaid trigger so toolbar
  buttons are not nested inside a button.
- `src/preview/svg-images.ts` is read for the real source of off-screen SVGs.
- Chat: `src/chat/markdown.ts`, `src/chat/timeline-renderer.ts`,
  `src/chat/ui.ts` and the dialog in `src/index.html`.
- `src/styles.css`: viewer, inline toolbar and touch-action rules.
- E2E: a new `tests/e2e/media-zoom.e2e.ts`, plus updates to `mermaid`,
  `mobile`, `ipad`, `chat-visuals` and `chat-attachments` tests and
  `tests/e2e/transform-helpers.ts`.
- Docs: the `src/` map in `CLAUDE.md`, `ARCHITECTURE.md`, `README.md`.
