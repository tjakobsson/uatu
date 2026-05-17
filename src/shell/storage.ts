// Small storage / lookup glue functions shared across the shell. None of
// these belong to a single feature module — they're cross-cutting helpers
// that read or write app state without owning a specific UI surface.
// Extracted from `app.ts` so the bottom of that file shrinks to its boot
// orchestration plus a tiny number of remaining functions.

import type { DocumentMeta } from "../shared/types";
import { appState } from "./state";

const previewElementMaybe = document.querySelector<HTMLElement>("#preview");

if (!previewElementMaybe) {
  throw new Error("uatu UI failed to initialize (shell/storage)");
}

const previewElement: HTMLElement = previewElementMaybe;

export function activeDocumentPath(): string | null {
  if (appState.previewMode.kind !== "document") {
    return null;
  }
  if (!appState.selectedId) {
    return null;
  }
  const doc = findDocumentById(appState.selectedId);
  return doc?.relativePath ?? null;
}

// Whether the active preview body is currently rendered as the whole-file
// source `<pre class="uatu-source-pre">` block. True for any view-mode that
// produces source rendering, including text/source files and Markdown /
// AsciiDoc when the user has flipped to Source view.
export function isPreviewSourceView(): boolean {
  return previewElement.querySelector("pre.uatu-source-pre") !== null;
}

export function findDocumentByRelativePath(relativePath: string): DocumentMeta | null {
  for (const root of appState.roots) {
    const doc = root.docs.find(candidate => candidate.relativePath === relativePath);
    if (doc) {
      return doc;
    }
  }
  return null;
}

export function findDocumentById(documentId: string): DocumentMeta | null {
  for (const root of appState.roots) {
    const doc = root.docs.find(candidate => candidate.id === documentId);
    if (doc) {
      return doc;
    }
  }
  return null;
}

export function syncStateGeneration(generatedAt: number) {
  document.body.dataset.stateGeneratedAt = String(generatedAt);
}
