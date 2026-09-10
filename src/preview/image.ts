// Image preview rendering — used by `loadDocument` when the active document
// is a binary file whose extension is in the viewable allowlist. Extracted
// from `app.ts` so the preview/ feature folder owns this thin renderer.

import { closeMermaidViewer } from "./mermaid-viewer";
import type { DocumentMeta } from "../shared/types";
import {
  clearPreviewType,
  previewPathElement,
  previewTitleElement,
  setPreviewBase,
} from "./header";
import { hideViewToggle } from "./view-mode";
import { appUrl } from "../shared/app-url";
import { contextualAppUrl } from "../shell/watch-context";

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

export async function renderImagePreview(doc: DocumentMeta, isCurrent: () => boolean = () => true): Promise<void> {
  const image = new Image();
  image.alt = doc.name;
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("image unavailable"));
  });
  image.src = contextualAppUrl(appUrl(`/api/document/resource?id=${encodeURIComponent(doc.id)}&rootId=${encodeURIComponent(doc.rootId)}`));
  try {
    await loaded;
  } catch (error) {
    // Decoding the image off-document keeps a half-loaded frame from flashing,
    // but it also means a failure would otherwise leave the *previous*
    // document mounted under this document's identity. Land the destination
    // explicitly before rethrowing, so every mode shows the failure rather
    // than silently showing the wrong file. The recovery affordance is
    // touch-only; desktop at least sees the truthful empty state.
    if (isCurrent()) renderImageUnavailable(doc);
    throw error;
  }
  if (!isCurrent()) return;
  closeMermaidViewer();
  setPreviewBase(doc.relativePath);
  previewTitleElement.textContent = doc.name;
  previewPathElement.textContent = doc.relativePath;
  clearPreviewType();
  hideViewToggle();
  previewElement.classList.remove("empty");
  const container = document.createElement("div");
  container.className = "image-preview";
  container.append(image);
  previewElement.replaceChildren(container);
}

function renderImageUnavailable(doc: DocumentMeta): void {
  closeMermaidViewer();
  setPreviewBase(doc.relativePath);
  previewTitleElement.textContent = doc.name;
  previewPathElement.textContent = doc.relativePath;
  clearPreviewType();
  hideViewToggle();
  previewElement.classList.add("empty");
  previewElement.replaceChildren(
    Object.assign(document.createElement("p"), { textContent: "This image could not be loaded." }),
  );
}
