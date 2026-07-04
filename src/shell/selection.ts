// Owner of the selection pair in appState: which document (or commit /
// review-score surface) the preview is showing. Every module that moves the
// selection goes through these mutators — `appState.selectedId = …` outside
// this file is a review error (see the module-structure spec's appState
// field-ownership requirement). Mutators only assign; rendering and history
// side effects stay at the call sites.

import { appState, type PreviewMode } from "./state";

export function setSelectedId(next: string | null): void {
  appState.selectedId = next;
}

export function setPreviewMode(next: PreviewMode): void {
  appState.previewMode = next;
}
