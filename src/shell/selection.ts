// Owner of the selection pair in appState: which document (or commit /
// commit surface) the preview is showing. Every module that moves the
// selection goes through these mutators — `appState.selectedId = …` outside
// this file is a review error (see the module-structure spec's appState
// field-ownership requirement). Mutators only assign; rendering and history
// side effects stay at the call sites.

import { appState, type PreviewMode } from "./state";
import { persistPersonalWorkspaceState } from "./personal-state";
import { writeSelectionCleared } from "./selection-storage";

let selectedDestination: { id: string; name: string; relativePath: string } | null = null;
let selectionGeneration = 0;

// Presentation requests capture this epoch, not just an id: close → reselect
// of the same file must never make an old response current again.
export function getSelectionGeneration(): number {
  return selectionGeneration;
}

export function resumeDocumentSelection(): void {
  appState.selectionCleared = false;
  writeSelectionCleared(false);
}

export function clearDocumentSelection(): void {
  ++selectionGeneration;
  selectedDestination = null;
  appState.selectedId = null;
  appState.selectionCleared = true;
  writeSelectionCleared(true);
  persistPersonalWorkspaceState({ documentPath: null, follow: false });
}

export function getSelectedDestination() {
  return selectedDestination;
}

export function setSelectedId(next: string | null, origin: "reconcile" | "navigation" = "reconcile"): void {
  // Watcher frames still remember the destination through the existing Hub
  // preference, but must not erase a browser marker written by another tab.
  // Only explicit navigation (including same-file activation) resumes it.
  if (origin === "navigation") resumeDocumentSelection();
  const changed = next !== appState.selectedId;
  if (changed) {
    selectedDestination = null;
    ++selectionGeneration;
  }
  appState.selectedId = next;
  if (next) {
    for (const root of appState.roots) {
      const document = root.docs.find(candidate => candidate.id === next);
      if (document) {
        selectedDestination = { id: document.id, name: document.name, relativePath: document.relativePath };
        // Every watcher frame re-confirms the selection it already holds. That
        // is not this client choosing a document: re-saving it would let an
        // idle client overwrite the document the user last picked elsewhere,
        // so a later browser resumes the wrong one. Save a move, or a user
        // activating a document (even the one already shown).
        if (changed || origin === "navigation") {
          persistPersonalWorkspaceState({ documentPath: document.relativePath });
        }
        break;
      }
    }
  }
}

export function setPreviewMode(next: PreviewMode): void {
  appState.previewMode = next;
}
