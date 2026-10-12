// Image preview rendering — used by `loadDocument` when the active document
// is a binary file whose extension is in the viewable allowlist. Extracted
// from `app.ts` so the preview/ feature folder owns this thin renderer.

import { closeMermaidViewer } from "./mermaid-viewer";
import { escapeHtmlAttribute } from "../shared/html";
import type { DocumentMeta } from "../shared/types";
import {
  clearPreviewType,
  previewPathElement,
  previewTitleElement,
  setPreviewBase,
} from "./header";
import { hideViewToggle } from "./view-mode";
import { documentRevisionKey } from "../shell/document-state";
import { withImageRevision } from "./image-revision";

const previewElementMaybe = document.querySelector<HTMLElement>("#preview");

if (!previewElementMaybe) {
  throw new Error("uatu UI failed to initialize (preview/image)");
}

const previewElement: HTMLElement = previewElementMaybe;

export function renderImagePreview(doc: DocumentMeta): void {
  closeMermaidViewer();
  setPreviewBase(doc.relativePath);
  previewTitleElement.textContent = doc.name;
  previewPathElement.textContent = doc.relativePath;
  clearPreviewType();
  hideViewToggle();
  previewElement.classList.remove("empty");
  // The browser resolves `./<name>` via the per-document `<base href>` set by
  // setPreviewBase, which already points at the document's directory under
  // the watched root — the same path the static-file fallback knows how to
  // serve. Encoded for safety against names with spaces / special chars.
  // encodeURIComponent (not encodeURI) — doc.name is a bare filename with no
  // path separators to preserve, and we MUST encode `#` and `?` so filenames
  // like `screenshot#2.png` aren't truncated by the URL parser into a path
  // ending at `screenshot` plus a `#2.png` fragment.
  // Carries the file's change revision, the parameter every watched image in
  // the preview carries (see image-revision.ts), so a changed image gets a URL
  // the browser has not loaded before.
  const src = withImageRevision(`./${encodeURIComponent(doc.name)}`, documentRevisionKey(doc.id));
  // The image already on screen is kept, not rebuilt: its source moves to the
  // new revision in place, so the old bitmap stays up until the new one has
  // loaded and the pane neither blanks nor loses its scroll position.
  const mounted = previewElement.querySelector<HTMLImageElement>(":scope > .image-preview > img");
  if (mounted && mounted.dataset.documentId === doc.id) {
    const next = new URL(src, mounted.baseURI).href;
    if (mounted.src !== next) mounted.src = next;
    return;
  }
  previewElement.innerHTML = `<div class="image-preview"><img alt="${escapeHtmlAttribute(doc.name)}" data-document-id="${escapeHtmlAttribute(doc.id)}" src="${escapeHtmlAttribute(src)}"></div>`;
}
