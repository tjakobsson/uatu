## Why

An image that changes on disk keeps showing its old content in the preview (upstream issue tjakobsson/uatu#294). It is not an HTTP-cache problem: the static-file fallback already answers with `cache-control: no-cache` and no service worker caches images. The preview asks for the same URL every time — `./hero.svg` for an opened image, the author's own `src` for an image embedded in Markdown or AsciiDoc — and a browser reuses an image it has already decoded for a URL within the page, whatever the response headers say. So an opened image re-renders with the stale bitmap, and an embedded image is not even asked again, because nothing reloads a document whose own file did not change.

Follow has the matching gap: a changed image is a binary file, and Follow ignores every binary change, so with Follow on, editing a diagram's SVG never brings it into view, while the preview could show it like any text file. The bug is present in the latest stable release (v0.7.0).

## What Changes

- Every `<img>` in the preview that resolves to a file under a watched root carries the file's modification time as a `v` query parameter. A changed image therefore has a new URL and is fetched again; an unchanged one keeps its URL and is not refetched. The stamp is applied when a document or image mounts and again on every state update, so an embedded image refreshes when only the image changed, by swapping its `src` in place: no document re-render, no scroll reset. The server resolves static files by path alone, so the query needs no server change. Images on other hosts, data URLs, and paths that are not watched files are left as authored.
- An opened image that changes swaps its source on the element already on screen, so the old bitmap stays up until the new one has loaded.
- Follow (Rule C) follows a change to a binary file the preview renders inline as an image (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.ico`, `.avif`, `.bmp`) as it does a text file: the server nominates it as the changed file and the client moves the selection to it. Changes to other binaries (archives, PDFs, fonts, …) stay ignored. A followed image also stays selected through later state updates instead of falling back to the newest document.
- With Follow on, a changed image that is embedded in the document the preview shows does not move the selection: the embedded image refreshes in place and the reader stays on the document. Only the client knows what the preview embeds, so it decides this from the preview as it is before the update; the server still nominates the image.
- Turning Follow on (Rule B) and the on-startup default still pick the newest document, not the newest image: on a fresh checkout every file shares the checkout time, so "newest image" would be an arbitrary asset. Images are followed only when they actually change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `document-watch-index`: "Keep the indexed view and preview current" requires a changed image to show its new content, opened or embedded, without re-rendering or scrolling the document. "Follow the latest changed non-binary file" becomes "Follow the latest changed file the preview can show" and admits previewable images, other than one embedded in the shown document. "Serve adjacent files from watched roots as static content" permits the version parameter on watched images. "Detect binary files and route them to the right preview" makes previewable images eligible for Follow's auto-switch but keeps them out of the default document and the Follow catch-up.
- `follow-mode`: Rule C follows changed images the preview can show, except an image embedded in the shown document, which refreshes in place; it still ignores other binaries. Rule B states that images are not catch-up candidates.

## Impact

- `src/shared/viewable-image.ts` (new): the viewable image extension list, moved from `src/preview/image.ts` so the server and the follow rules share it.
- `src/shared/types.ts`: `isFollowableFile`; `nextSelectedDocumentId` follows and keeps followable files, and stays put for a changed image the caller reports as shown in the preview.
- `src/server/watch-session.ts`: the refresh nominates followable files as `changedId`.
- `src/preview/image-version.ts` (new): resolves an image URL to a watched file and stamps it with the file's mtime; lists the watched files the preview's images show, for Follow.
- `src/preview/image.ts`, `src/preview/mount.ts`, `src/shell/events.ts`: stamp images on mount and on every state update; an opened image refreshes in place; Follow reads the preview's embedded images before applying an update.
- No API, wire, or server-response change.
