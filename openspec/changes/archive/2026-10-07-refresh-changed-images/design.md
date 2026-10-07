## Context

The preview loads images through the static-file fallback at stable URLs. Within a page, the browser's image cache keys on the URL and reuses a decoded image regardless of `cache-control`, so changing the response headers cannot fix staleness; the URL has to change when the file does. The client already holds every watched file's `mtimeMs` in its roots, and receives new roots on every change, including changes to binaries (their mtime is part of the state fingerprint).

## Goals / Non-Goals

**Goals:** a changed image shows its new content in the preview, opened or embedded, without a page reload, a document re-render, or a scroll jump; Follow follows changed images the preview can show, but stays on a document whose own embedded image changed.

**Non-Goals:** `srcset`, `<picture>` sources, CSS backgrounds, images inside inline SVG, and AsciiDoc interactive SVGs rendered as `<object>` are not stamped. A file-pinned session (scope `file`) only holds the pinned document, so images embedded in it are not stamped. HTTP validators (ETag, Last-Modified) on the static fallback are left as they are; the version parameter makes them unnecessary for correctness.

## Decisions

- **Version the URL on the client, from the roots it already has.** The alternative, stamping on the server while rendering Markdown, would still need a client pass for the case where only the image changed (the document is not re-rendered), so the client pass is the one mechanism. It runs on mount and on every state update and only writes `src` when the version differs, so it is idempotent and refetches nothing that did not change.
- **Resolve like the server does.** The image's URL is resolved against the per-document base, the session's base path is stripped, the path is percent-decoded, and the first root holding that relative path wins — the static fallback's own order. Anything that does not resolve to a watched file is left alone.
- **Swap `src` on the existing element.** The stamping pass changes the source of the `<img>` already on screen, embedded or opened, so the previous bitmap stays up until the new one has loaded and layout does not collapse. Re-rendering an opened image whose file changed keeps the element the pass has already re-stamped rather than rebuilding it.
- **One predicate for "followable".** `isFollowableFile` (non-binary, or a viewable image name) is shared by the server's `changedId` nomination and the client's selection rule, so the two cannot disagree. The extension list moved to `src/shared/` for that.
- **An embedded image's change does not move Follow.** With Follow on, a changed image that the shown document embeds already refreshes in place; switching to it would take the reader away from the context they were following. The server cannot know what the preview embeds, so the client decides: before applying an update it collects the watched files the preview's `<img>` elements resolve to (the same resolution as the stamping pass, over the whole preview, so both panes in split layout), and passes that set to the pure selection rule (`nextSelectedDocumentId`), which keeps the current selection when the changed file is a binary in the set. Nothing switches, so the URL, history, and the "updated" signal are untouched.
- **Rule B and the default document stay documents-only.** Their pick is "newest mtime", and image mtimes mostly reflect a checkout or a build, not an edit the user wants to see. Following an image only when it changes keeps Follow predictable.

## Risks / Trade-offs

- Two writes to one image within the same millisecond keep the same version. The watcher's write-finish delay makes this unlikely to matter.
- An image is fetched once unstamped when a document mounts, before the stamp is applied, because the HTML is assigned before the pass runs. Local and cheap; avoiding it would mean parsing the HTML twice.
