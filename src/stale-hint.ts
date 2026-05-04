import type { Mode } from "./shared";

export type StaleHint =
  | { kind: "changed"; documentId: string }
  | { kind: "deleted"; documentId: string };

export type StaleHintEvent =
  // SSE state event arrived. The caller has already determined whether the
  // active file still exists in the new payload and what (if anything)
  // changed on disk.
  | {
      kind: "file-event";
      mode: Mode;
      activeId: string | null;
      changedId: string | null;
      activeStillExists: boolean;
    }
  // The user navigated away (Files pane click, commit click, URL nav, etc.).
  | { kind: "manual-navigation" }
  // Mode changed. Switching to Author always clears the hint.
  | { kind: "mode-changed"; nextMode: Mode }
  // The refresh / close affordance was activated.
  | { kind: "refresh-action" };

export function nextStaleHint(
  current: StaleHint | null,
  event: StaleHintEvent,
): StaleHint | null {
  switch (event.kind) {
    case "file-event": {
      if (event.mode !== "review" || !event.activeId) {
        return current;
      }
      if (!event.activeStillExists) {
        // Deleted-on-disk overrides any prior changed-on-disk for the same
        // file. The reviewer's content stays visible until they act on it.
        return { kind: "deleted", documentId: event.activeId };
      }
      if (event.changedId === event.activeId) {
        // Coalesce: keep an existing changed/deleted hint for the same doc
        // rather than spawning duplicates. Deleted always wins over changed.
        if (current && current.documentId === event.activeId) {
          return current;
        }
        return { kind: "changed", documentId: event.activeId };
      }
      return current;
    }
    case "manual-navigation":
      return null;
    case "mode-changed":
      // Switching to Author clears any visible hint (Author handles refresh
      // in-place). Switching to Review never auto-creates a hint; the next
      // file event will if applicable.
      return event.nextMode === "author" ? null : current;
    case "refresh-action":
      return null;
  }
}
