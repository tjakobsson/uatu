// Pure decision logic for the session picker. Separated from panel.ts (which
// touches `window` at module scope) so it can be unit-tested headlessly.

import type { TerminalSessionInfo } from "./server";

// Sessions worth offering to this window: everything it does not already
// show. Detached sessions first (attach is non-disruptive), then attached
// ones (attach means takeover), oldest first within each group so the list
// order is stable across refreshes.
export function pickerCandidates(
  inventory: TerminalSessionInfo[],
  shownIds: Iterable<string>,
): TerminalSessionInfo[] {
  const shown = new Set(shownIds);
  return inventory
    .filter(session => !shown.has(session.id))
    .sort((a, b) => {
      if (a.attached !== b.attached) return a.attached ? 1 : -1;
      return a.createdAt - b.createdAt;
    });
}

// Compact age label for picker rows. Coarse on purpose — it orients ("that
// htop from this morning"), it doesn't measure.
export function formatSessionAge(createdAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - createdAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
