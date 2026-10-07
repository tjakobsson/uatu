## 1. Follow previewable images

- [x] 1.1 Move the viewable image extension list to `src/shared/viewable-image.ts` and add `isFollowableFile` to `src/shared/types.ts`; make `nextSelectedDocumentId` follow and keep followable files. Verify with `src/shared/types.test.ts`: a changed `.png`/`.svg`/`.JPG`/`.gif`/`.webp` is followed, a changed `.zip`/`.pdf`/`.bin`/`.tiff` is not, and a followed image stays selected through a frame with no `changedId`.
- [x] 1.2 Nominate followable files as `changedId` in the watch session refresh. Verify with `src/server/watch-session.test.ts`: an SVG change broadcasts its id, an archive change broadcasts `null`.
- [x] 1.3 Keep Rule B documents-only. Verify with `src/shell/follow-rules.test.ts`: a newer image does not become the catch-up target.

## 2. Refresh changed images

- [x] 2.1 Add `versionedImageUrl` / `refreshImageVersions` in `src/preview/image-version.ts`. Verify with `src/preview/image-version.test.ts`: relative and parent paths, percent-encoding, re-stamping, base paths, and untouched external/data/unknown URLs.
- [x] 2.2 Stamp images on mount (single and split layouts) and on every applied state snapshot; refresh an opened image in place. Verify with `tests/e2e/preview-renderers.e2e.ts`: an opened SVG and an SVG embedded in a Markdown document both show the new intrinsic width after the file is rewritten, with the element / document kept mounted.
- [x] 2.3 Follow end to end. Verify with `tests/e2e/follow-mode.e2e.ts`: with Follow on, a changed SVG becomes the selection and renders its new content; a new archive does not move the selection.
