## Why

An image that changes on disk keeps showing its old content in the preview (upstream issue tjakobsson/uatu#294). It is not an HTTP-cache problem: the static-file fallback already answers with `cache-control: no-cache` and no service worker caches images. A browser reuses an image it has already decoded for a URL within the page, whatever the response headers say. The selected image already carries its file's change revision in its URL, but an image embedded in Markdown or AsciiDoc keeps the author's own `src`, and nothing reloads a document whose own file did not change, so an embedded image is never asked for again.

Follow has the matching gap: a changed image is a binary file, and Follow ignores every binary change, so with Follow on, editing a diagram's SVG never brings it into view, while the preview could show it like any text file. And once a user is on an image, reload, workspace-root resume, and Back drop it, because boot and history accept only non-binary documents; Follow would make that common. The bug is present in the latest stable release (v0.7.0).

## What Changes

- Every `<img>` in the preview that resolves to a file under a watched root carries that file's change revision as a `revision` query parameter: the same parameter, from the same revision key (`documentRevisionKey`), that the selected image already uses, so there is one mechanism. A changed image therefore has a new URL and is fetched again; an unchanged one keeps its URL and is not refetched. Freshness follows the revision, never the modification time. The parameter is applied when a document or image mounts and again on every applied state update, so an embedded image refreshes when only the image changed, by swapping its `src` in place: no document re-render, no scroll reset. Images on other hosts, data URLs, and paths that are not watched files are left as authored.
- An opened image that changes swaps its source on the element already on screen, so the old bitmap stays up until the new one has loaded.
- Follow (Rule C) follows a change to a binary file the preview renders inline as an image (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.ico`, `.avif`, `.bmp`) as it does a text file: the server's file index nominates it as the changed file and the client moves the selection to it. Changes to other binaries (archives, PDFs, fonts, …) stay ignored.
- With Follow on, a changed image that is embedded in the document the preview shows does not move the selection: the embedded image refreshes in place and the reader stays on the document. The embedded images come from the document's rendered payload, not from the preview's DOM, so the exception holds in Rendered, Source, Diff, and split views; a document shown only as Source or Diff has its rendered payload looked up once per revision for this. Until that answer is in, an image change waits rather than moving the selection, and a lookup that fails follows the image. Every client path that applies a file event (incremental patch, full frame, reconcile) applies the exception through one shared helper.
- An image Follow switched to survives a reload, a workspace-root resume of the saved document, and Back, like a document.
- Turning Follow on (Rule B) and the on-startup default still pick the newest document, not the newest image: on a fresh checkout every file shares the checkout time, so "newest image" would be an arbitrary asset. Images are followed only when they actually change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `follow-mode`: Rule C follows changed images the preview can show, except an image embedded in the shown document (in any view), which refreshes in place; it still ignores other binaries. Rule B states that images are not catch-up candidates. Batch selection counts previewable images as eligible.
- `document-watch-index`: "Keep the indexed view and preview current" requires a changed image to show its new content, opened or embedded, without re-rendering or scrolling the document. "Serve adjacent files from watched roots as static content" states the revision parameter on watched images, and that an HTML navigation to any known file, an image included, gets the SPA shell (what the server already does). "Detect binary files and route them to the right preview" makes previewable images eligible for Follow's auto-switch but keeps them out of the default document and the Follow catch-up.
- `document-routing`: direct links, a saved document, and Back accept a previewable image; the scenario that claimed an HTML navigation to a watched image returns its bytes now states the SPA shell the server returns.

## Impact

- `src/shared/viewable-image.ts` (new): the viewable image extension list, moved from `src/preview/image.ts` so the server and the follow rules share it.
- `src/shared/types.ts`: `isFollowableFile`; `nextSelectedDocumentId` follows and keeps followable files.
- `src/server/file-index.ts`: nominates followable files as `changedId`; `src/server/watch-session.ts` keeps a followable latest change in snapshots.
- `src/preview/image-revision.ts` (new): resolves an image URL to a watched file and applies its revision.
- `src/preview/embedded-images.ts` (new): which watched images the shown document embeds, from its rendered payload: known for the current revision, or unknown.
- `src/shell/follow-rules.ts`: `imageChangeOutcome`, the pure image exception (select, stay, or defer while unknown).
- `src/shell/image-follow.ts` (new): the one held image decision, settled when the lookup answers and dropped when something newer decides the selection.
- `src/preview/image.ts`, `src/preview/header.ts`, `src/preview/mount.ts`, `src/shell/events.ts`: apply revisions on mount and on every state update; an opened image refreshes in place; learn a document's embedded images; apply the Follow exception on the patch, frame, and reconcile paths.
- `src/shell/boot.ts`, `src/shell/history.ts`: accept followable images for direct links, the saved document, and popstate.
- No API or wire change. The server's navigation behaviour is unchanged; only its spec now describes it.
