// Owner of the selection pair in appState: which document (or commit /
// commit surface) the preview is showing. Every module that moves the
// selection goes through these mutators — `appState.selectedId = …` outside
// this file is a review error (see the module-structure spec's appState
// field-ownership requirement). Mutators only assign; rendering and history
// side effects stay at the call sites.

import { appState, type PreviewMode } from "./state";
import { persistPersonalWorkspaceState } from "./personal-state";

let selectedDestination: { id: string; rootId: string; name: string; relativePath: string } | null = null;
const listeners = new Set<() => void>();
let selectionGeneration = 0;
export function getSelectionGeneration(): number { return selectionGeneration; }
export function onSelectionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function notifySelection(): void { for (const listener of listeners) listener(); }

export function getSelectedDestination() {
  return selectedDestination;
}

export function setSelectedId(next: string | null): void {
  if (next !== appState.selectedId) selectionGeneration++;
  if (next !== appState.selectedId) selectedDestination = null;
  appState.selectedId = next;
  if (next) {
    for (const root of appState.roots) {
      const document = root.docs.find(candidate => candidate.id === next);
      if (document) {
        selectedDestination = { id: document.id, rootId: root.id, name: document.name, relativePath: document.relativePath };
        persistPersonalWorkspaceState({ documentPath: document.relativePath });
        break;
      }
    }
  }
  notifySelection();
}

export function setPreviewMode(next: PreviewMode): void {
  if (next.kind === "commit") selectionGeneration++;
  appState.previewMode = next;
  notifySelection();
}
