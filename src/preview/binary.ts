// Binary-file fallback preview — surfaces a "not viewable in uatu" message
// for any binary document whose extension isn't in the viewable allowlist.
// Extracted from `app.ts` so the preview/ feature folder owns this thin
// renderer alongside its sibling `renderImagePreview`.

import { recomputeSelectionInspector } from "../shell/inspector-instance";
import { closeMermaidViewer } from "./mermaid-viewer";
import type { DocumentMeta } from "../shared/types";
import { clearPreviewType, previewPathElement, previewTitleElement } from "./header";
import { hideViewToggle } from "./view-mode";

const previewElementMaybe = document.querySelector<HTMLElement>("#preview");

if (!previewElementMaybe) {
  throw new Error("uatu UI failed to initialize (preview/binary)");
}

const previewElement: HTMLElement = previewElementMaybe;

export function renderBinaryUnavailable(doc: DocumentMeta): void {
  closeMermaidViewer();
  previewTitleElement.textContent = doc.name;
  previewPathElement.textContent = doc.relativePath;
  clearPreviewType();
  hideViewToggle();
  previewElement.classList.add("empty");
  previewElement.innerHTML = `<p>This file type isn't viewable in uatu.</p>`;
  recomputeSelectionInspector();
}
