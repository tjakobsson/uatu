// Pure decision helpers for the `follow-mode` capability. Lives in its own
// file (no DOM imports) so the test suite can exercise the rules without a
// browser environment. The imperative orchestrators in `follow.ts` call into
// these.

import type { EmbeddedImageMembership } from "../preview/embedded-images";
import { defaultDocumentId, findDocument, isFollowableFile, nextSelectedDocumentId, type RootGroup } from "../shared/types";

// Rule C/D — selection decision on a watcher-driven file event.
// Follow on  → switch to the changed file (if present and followable: a
//              document or a previewable image).
// Follow off → keep the current selection; reload is the caller's concern.
// Rule C's image exception is decided first (`imageChangeOutcome`): a change
// it keeps off the selection reaches this rule as no change at all.
export function chooseSelectionForFileEvent(
  roots: RootGroup[],
  previousSelectedId: string | null,
  changedId: string | null,
  followEnabled: boolean,
  selectionCleared = false,
): string | null {
  return nextSelectedDocumentId(roots, previousSelectedId, changedId, followEnabled, selectionCleared);
}

// Rule C's image exception, for a change Follow would otherwise follow.
// `select` — not an image Follow can show, the selected file itself, or an
//            image the shown document does not embed: the rule above decides.
// `stay`   — an image the shown document embeds: it refreshes in place and
//            the selection stays.
// `defer`  — an image, and what the shown document embeds is not known yet
//            (its rendered payload for this revision has not been read): the
//            caller holds the decision until it is (shell/image-follow.ts).
export type ImageChangeOutcome = "select" | "stay" | "defer";

export function imageChangeOutcome(
  roots: RootGroup[],
  selectedId: string | null,
  changedId: string,
  shownDocumentImages: EmbeddedImageMembership,
): ImageChangeOutcome {
  const changed = findDocument(roots, changedId);
  if (!changed || changed.kind !== "binary" || !isFollowableFile(changed) || changedId === selectedId) return "select";
  if (!shownDocumentImages.known) return "defer";
  return shownDocumentImages.ids.has(changedId) ? "stay" : "select";
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
