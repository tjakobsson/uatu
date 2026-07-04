// Diff view rendering — fetches the `/api/document/diff` payload and
// mounts Pierre's diff component into the preview body. Caches the payload
// per-document so toggling out and back into Diff doesn't re-fetch.
// Extracted from `app.ts` so the preview/ feature folder owns the entire
// view pipeline (single, split, diff) in one place.

import { findDocumentById } from "../shell/storage";
import { renderDocumentDiff, type DocumentDiffPayload } from "./diff-view";
import { closeMermaidViewer } from "./mermaid-viewer";
import { recomputeSelectionInspector } from "../shell/inspector-instance";
import { writeDiffStylePreference, type DiffStyle, type DocumentMeta } from "../shared/types";
import { appState, safeLocalStorage } from "../shell/state";
import {
  clearPreviewType,
  previewPathElement,
  previewTitleElement,
  setPreviewBase,
} from "./header";
import { mountLayoutToolbar, syncLayoutChooser } from "./layout";
import { documentDiffCache, type RenderedDocument } from "./mount";
import { refreshOutline } from "./outline";
import { extensionToLanguage, syncViewToggle } from "./view-mode";
import { setPreviewMode } from "../shell/selection";

const previewElementMaybe = document.querySelector<HTMLElement>("#preview");

if (!previewElementMaybe) {
  throw new Error("uatu UI failed to initialize (preview/diff)");
}

const previewElement: HTMLElement = previewElementMaybe;

export async function applyDiffForActiveDocument(documentId: string): Promise<void> {
  const cached = documentDiffCache.get(documentId);
  if (cached) {
    await renderDiffIntoPreview(documentId, cached);
    return;
  }
  // No cache: do NOT clear #preview before the response is in hand. The
  // previous view's content stays visible until we have something to swap
  // in, matching the "no empty-state flash" rule established for Source ↔
  // Rendered toggles.
  const payload = await fetchDocumentDiff(documentId);
  if (!payload) {
    return;
  }
  documentDiffCache.set(documentId, payload);
  // The user may have switched away while the fetch was in flight; only
  // apply if the active selection AND view mode are still consistent.
  if (
    appState.previewMode.kind !== "document" ||
    appState.selectedId !== documentId ||
    appState.viewMode !== "diff"
  ) {
    return;
  }
  await renderDiffIntoPreview(documentId, payload);
}

export async function fetchDocumentDiff(documentId: string): Promise<DocumentDiffPayload | null> {
  try {
    const response = await fetch(`/api/document/diff?id=${encodeURIComponent(documentId)}`);
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as DocumentDiffPayload;
  } catch {
    return null;
  }
}

export async function renderDiffIntoPreview(documentId: string, payload: DocumentDiffPayload): Promise<void> {
  // Pin previewMode to document so the header chrome (path, title, pin/follow
  // controls) keeps treating this as a document preview.
  setPreviewMode({ kind: "document" });

  const doc = findDocumentById(documentId);
  if (doc) {
    previewTitleElement.textContent = doc.name;
    previewPathElement.textContent = doc.relativePath;
    setPreviewBase(doc.relativePath);
  }
  clearPreviewType();
  previewElement.classList.remove("empty", "is-split", "is-split-h", "is-split-v");
  previewElement.removeAttribute("data-auto-stack");
  closeMermaidViewer();
  // Diff view brings its own inline toolbar (Unified / Split) from the
  // document-diff-view module; the markdown/asciidoc layout toolbar must
  // not bleed across from a previous render of the same document.
  mountLayoutToolbar(false);
  // The outline + copy-source are Rendered-view affordances; Diff has neither.
  refreshOutline(null);

  const languageHint = doc ? extensionToLanguage(doc.name) : null;
  // Wrap the diff host so styles target `.uatu-diff-host` consistently
  // whether or not Pierre's Shadow DOM is in play.
  previewElement.innerHTML = "";
  const host = document.createElement("div");
  host.className = "uatu-diff-host";
  previewElement.appendChild(host);
  await renderDocumentDiff(host, payload, languageHint, {
    diffStyle: appState.diffStyle,
    wrap: appState.wrap,
    onDiffStyleChange: next => {
      void applyDiffStyle(next);
    },
  });

  // The Source / Rendered cache is cleared on every file selection, so
  // `currentRenderedPayload()` returns null while the diff view is the
  // primary representation. A minimal kind-only stub built from
  // DocumentMeta lets `syncViewToggle` / `syncLayoutChooser` make the
  // correct visibility decisions without needing a real RenderedDocument.
  const choicePayload = doc ? renderedDocumentStubFromMeta(doc) : null;
  syncViewToggle(choicePayload);
  syncLayoutChooser(choicePayload);
  recomputeSelectionInspector();
}

// Minimal RenderedDocument-shape view chooser / layout chooser only consult
// `kind`. When the diff view is the primary representation there is no real
// RenderedDocument in the cache, so we construct a stub from the meta so
// the chooser stays on screen with the right segments.
export function renderedDocumentStubFromMeta(meta: DocumentMeta): RenderedDocument | null {
  if (meta.kind === "binary") return null;
  return {
    id: meta.id,
    title: meta.name,
    path: meta.relativePath,
    html: "",
    kind: meta.kind,
    view: "rendered",
    language: null,
  };
}

export async function applyDiffStyle(next: DiffStyle): Promise<void> {
  if (appState.diffStyle === next) return;
  appState.diffStyle = next;
  writeDiffStylePreference(safeLocalStorage(), next);
  // Re-render the active diff in place using the cached payload — no
  // network round-trip, no full document reload, just a Pierre re-mount
  // with the new layout option.
  if (
    appState.previewMode.kind !== "document"
    || !appState.selectedId
    || appState.viewMode !== "diff"
  ) {
    return;
  }
  const cached = documentDiffCache.get(appState.selectedId);
  if (cached) {
    await renderDiffIntoPreview(appState.selectedId, cached);
  }
}
