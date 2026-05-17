// Image preview rendering — used by `loadDocument` when the active document
// is a binary file whose extension is in the viewable allowlist. Extracted
// from `app.ts` so the preview/ feature folder owns this thin renderer.

import { recomputeSelectionInspector } from "../shell/inspector-instance";
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

const previewElementMaybe = document.querySelector<HTMLElement>("#preview");

if (!previewElementMaybe) {
  throw new Error("uatu UI failed to initialize (preview/image)");
}

const previewElement: HTMLElement = previewElementMaybe;

// File extensions that uatu can render directly in the preview pane as an
// inline image. Kept conservative — formats that browsers reliably display
// via `<img>` without polyfills. SVGs are included; they're served as
// `image/svg+xml` by the static-file fallback and the browser sandboxes any
// `<script>` inside an SVG loaded through `<img>`, so no XSS risk.
export const VIEWABLE_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".avif",
  ".bmp",
]);

export function isViewableImageName(name: string): boolean {
  const lower = name.toLowerCase();
  for (const ext of VIEWABLE_IMAGE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

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
  previewElement.innerHTML = `<div class="image-preview"><img alt="${escapeHtmlAttribute(doc.name)}" src="./${encodeURIComponent(doc.name)}"></div>`;
  recomputeSelectionInspector();
}
