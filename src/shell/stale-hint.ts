export type StaleHint =
  | { kind: "changed"; documentId: string }
  | { kind: "deleted"; documentId: string };

export type StaleHintEvent =
  // SSE state event arrived. The caller has already determined whether the
  // active file still exists in the new payload and what (if anything)
  // changed on disk. With Modes gone, the single-mode app no longer raises
  // stale hints from file events — the active file simply reloads in place
  // (Rule D of the follow-mode capability). This kind survives only so a
  // future change can re-introduce a freeze-while-reading affordance.
  | {
      kind: "file-event";
      activeId: string | null;
      changedId: string | null;
      activeStillExists: boolean;
    }
  // The user navigated away (Files pane click, commit click, URL nav, etc.).
  | { kind: "manual-navigation" }
  // The refresh / close affordance was activated.
  | { kind: "refresh-action" };

export function nextStaleHint(
  current: StaleHint | null,
  event: StaleHintEvent,
): StaleHint | null {
  switch (event.kind) {
    case "file-event":
      // Single-mode app: file events never produce a stale hint. The
      // follow-mode capability's Rule C/D drives selection/reload directly.
      return current;
    case "manual-navigation":
      return null;
    case "refresh-action":
      return null;
  }
}
