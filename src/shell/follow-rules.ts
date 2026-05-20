// Pure decision helpers for the `follow-mode` capability. Lives in its own
// file (no DOM imports) so the test suite can exercise the rules without a
// browser environment. The imperative orchestrators in `follow.ts` call into
// these.

import { defaultDocumentId, nextSelectedDocumentId, type RootGroup } from "../shared/types";

// Rule C/D — selection decision on a watcher-driven file event.
// Follow on  → switch to the changed file (if non-binary and present).
// Follow off → keep the current selection; reload is the caller's concern.
export function chooseSelectionForFileEvent(
  roots: RootGroup[],
  previousSelectedId: string | null,
  changedId: string | null,
  followEnabled: boolean,
): string | null {
  return nextSelectedDocumentId(roots, previousSelectedId, changedId, followEnabled);
}

// Rule B catch-up — when the user flips the chip from off → on, decide
// whether to jump the selection to the newest changed file. Returns the
// target document id when a jump is warranted, or null when the current
// selection should remain. Returning null means "no visible change at all
// until the next watcher event."
export function selectionForChipTurnOn(
  roots: RootGroup[],
  currentSelectedId: string | null,
): string | null {
  const latestId = defaultDocumentId(roots);
  if (latestId === null) {
    return null;
  }
  if (latestId === currentSelectedId) {
    return null;
  }
  return latestId;
}
