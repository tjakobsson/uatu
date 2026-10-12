## 1. Follow previewable images

- [x] 1.1 Move the viewable image extension list to `src/shared/viewable-image.ts` and add `isFollowableFile` to `src/shared/types.ts`; make `nextSelectedDocumentId` follow and keep followable files. Verify with `src/shared/types.test.ts`: a changed `.png`/`.svg`/`.JPG`/`.gif`/`.webp` is followed, a changed `.zip`/`.pdf`/`.bin`/`.tiff` is not, and a followed image stays selected through a frame with no `changedId`.
- [x] 1.2 Nominate followable files as `changedId` in `src/server/file-index.ts`, and keep a followable latest change in snapshots. Verify with `src/server/file-index.test.ts`: an SVG edit is nominated, an archive edit is not and does not erase an earlier document edit.
- [x] 1.3 Keep Rule B documents-only. Verify with `src/shell/follow-rules.test.ts`: a newer image does not become the catch-up target.
- [x] 1.4 Keep the selection on a document whose embedded image changed. Verify with `src/shell/follow-rules.test.ts` (the pure exception: select, stay, or defer while unknown), `src/preview/embedded-images.test.ts` (ids from the rendered payload, independent of the view, an image created later still recognised, unknown versus known-empty per revision, lookup outcomes), and `src/shell/image-follow.test.ts` (a held decision settles on the lookup's answer, a failed lookup follows, and a selection change, user activation, document edit, Follow switch, commit preview, or newer file change drops it).
- [x] 1.5 Accept followable images in `boot.ts` (direct link, saved document) and `history.ts` (popstate).

## 2. Refresh changed images

- [x] 2.1 Add `revisionedImageUrl` / `refreshImageRevisions` in `src/preview/image-revision.ts`, on the existing `revision` parameter. Verify with `src/preview/image-revision.test.ts`: relative and parent paths, percent-encoding, replacing an earlier revision, stability, base paths, and untouched external/data/unknown URLs.
- [x] 2.2 Apply revisions on mount (single and split layouts) and on every applied patch, frame, and reconcile; refresh an opened image in place. Verify with `tests/e2e/preview-renderers.e2e.ts`: an opened SVG and an SVG embedded in a Markdown document both show the new intrinsic width after the file is rewritten, with the element / document kept mounted, and the embedded image's URL carries `revision`.

## 3. End to end

- [x] 3.1 Verify with `tests/e2e/follow-mode.e2e.ts`: with Follow on, a changed SVG becomes the selection and renders its new content; an embedded SVG's change keeps the document, in Rendered view and in Source view, and in Source and Diff views while the rendered lookup is held and after it answers; a failed lookup follows the image; an archive does not move the selection; a followed image survives a reload, a workspace-root resume, and Back.
- [x] 3.2 Specs: Follow requirements in `follow-mode`; image freshness, static serving, and binary routing in `document-watch-index`; direct link, saved document, Back, and HTML navigation in `document-routing`.
