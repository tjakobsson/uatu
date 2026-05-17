// Empty-state preview renderer — title chip, path label, and the empty
// message body shown when there is no document to preview (e.g. waiting
// for files, deleted file, direct-link miss, etc.). Extracted from
// `app.ts` so the preview/ feature folder owns this small renderer
// alongside the other preview body writers.

import { escapeHtml } from "../shared/html";
import { recomputeSelectionInspector } from "../shell/inspector-instance";
import { clearPreviewType } from "./header";
import { closeMermaidViewer } from "./mermaid-viewer";
import { hideViewToggle } from "./view-mode";

const previewTitleElementMaybe = document.querySelector<HTMLElement>("#preview-title");
const previewPathElementMaybe = document.querySelector<HTMLElement>("#preview-path");
const previewElementMaybe = document.querySelector<HTMLElement>("#preview");

if (!previewTitleElementMaybe || !previewPathElementMaybe || !previewElementMaybe) {
  throw new Error("uatu UI failed to initialize (preview/empty)");
}

// Locally-scoped non-null aliases. TypeScript's narrowing from the
// throw-if-null guard above doesn't survive into function bodies (the
// hoisted function declarations sit outside the if-block's control-flow
// scope), so we re-alias to `T` here.
const previewTitleElement: HTMLElement = previewTitleElementMaybe;
const previewPathElement: HTMLElement = previewPathElementMaybe;
const previewElement: HTMLElement = previewElementMaybe;

export function renderEmptyPreview(title: string, body: string) {
  closeMermaidViewer();
  previewTitleElement.textContent = title;
  previewPathElement.textContent = body;
  clearPreviewType();
  hideViewToggle();
  previewElement.classList.add("empty");
  previewElement.innerHTML = `<p>${escapeHtml(body)}</p>`;
  // Any prior selection rooted in document content is now invalid and the
  // preview is no longer in document mode — clear the inspector pane.
  recomputeSelectionInspector();
}
