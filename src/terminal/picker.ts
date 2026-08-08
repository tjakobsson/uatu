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

// What the panel does with inventory when it has no per-window panes to
// restore. `attach` is claimed silently — a detached PTY belongs to nobody, so
// attaching is non-disruptive and reversible. `decide` needs the user: taking a
// session from another client is destructive to that client, and detached
// sessions past the pane cap have nowhere to go.
export type SessionPlan = {
  attach: TerminalSessionInfo[];
  decide: TerminalSessionInfo[];
};

// Split not-shown inventory into the auto-attach set and the leftovers.
// `freeSlots` is how many more panes the window can hold; a non-positive value
// pushes everything into `decide` (nothing can be attached, but the sessions
// still exist and stay reachable).
export function resolveSessionPlan(
  inventory: TerminalSessionInfo[],
  shownIds: Iterable<string>,
  freeSlots: number,
): SessionPlan {
  const shown = new Set(shownIds);
  const available = inventory.filter(session => !shown.has(session.id));
  const detached = available
    .filter(session => !session.attached)
    .sort((a, b) => a.createdAt - b.createdAt);
  const elsewhere = available
    .filter(session => session.attached)
    .sort((a, b) => a.createdAt - b.createdAt);
  const capacity = Math.max(0, freeSlots);
  return {
    attach: detached.slice(0, capacity),
    // Detached overflow first: it's the cheaper choice of the two (plain
    // attach, no takeover), so it should be the first thing offered.
    decide: [...detached.slice(capacity), ...elsewhere],
  };
}

// Which of a just-attached batch becomes the active pane. The saved last-active
// PTY wins when it's in the batch; otherwise the newest session does, on the
// theory that the most recently spawned shell is the one being worked in.
// This only ever *selects* among sessions that were already going to attach —
// it never causes an attachment, which is what keeps takeover explicit.
export function resolveActiveSessionId(
  attached: TerminalSessionInfo[],
  lastPtyId: string | undefined,
): string | undefined {
  if (attached.length === 0) return undefined;
  if (lastPtyId && attached.some(session => session.id === lastPtyId)) return lastPtyId;
  return attached.reduce((newest, session) =>
    session.createdAt > newest.createdAt ? session : newest,
  ).id;
}

// A terminal as the touch switcher shows it. `state` drives both the row's
// label copy and which actions it offers:
//   visible            — the pane currently on screen; no switch action needed
//   attached-here      — this window holds it, hidden behind the visible pane
//   detached           — nobody holds it; selecting attaches it
//   attached-elsewhere — another client holds it; only an explicit takeover moves it
export type SwitcherRowState = "visible" | "attached-here" | "detached" | "attached-elsewhere";

export type SwitcherRow = {
  sessionId: string;
  label: string;
  state: SwitcherRowState;
  age: string;
  // Whether this row is the user's saved last-active PTY. Presentation only.
  lastActive: boolean;
  // Selecting the row switches to (or attaches) this terminal.
  canSelect: boolean;
  // The row needs an explicit takeover before it can be shown.
  canTakeOver: boolean;
};

// Panes as the switcher needs to see them: window-local order plus the server
// resource each one holds.
export type SwitcherPane = {
  sessionId: string;
};

// Build the switcher's row model. Attached-here rows come first in pane order
// (the window's own terminals are what the user is switching between), then
// detached, then attached-elsewhere — the same least-disruptive-first ordering
// the desktop chooser uses. `freeSlots` gates attach: at the pane cap the
// window can still switch between what it holds, but it cannot take on more.
export function buildSwitcherRows(
  panes: SwitcherPane[],
  inventory: TerminalSessionInfo[],
  activeSessionId: string | undefined,
  lastPtyId: string | undefined,
  now: number,
  freeSlots: number,
): SwitcherRow[] {
  const byId = new Map(inventory.map(session => [session.id, session]));
  const held = new Set(panes.map(pane => pane.sessionId));
  const hasCapacity = freeSlots > 0;

  const mine: SwitcherRow[] = panes.map(pane => {
    const session = byId.get(pane.sessionId);
    const visible = pane.sessionId === activeSessionId;
    return {
      sessionId: pane.sessionId,
      // A pane whose session vanished from inventory between the GET and this
      // render still belongs on the list — it's on screen.
      label: session?.label ?? "shell",
      state: visible ? "visible" : "attached-here",
      age: session ? formatSessionAge(session.createdAt, now) : "",
      lastActive: pane.sessionId === lastPtyId,
      canSelect: !visible,
      canTakeOver: false,
    };
  });

  const available = inventory.filter(session => !held.has(session.id));
  const toRow = (session: TerminalSessionInfo, state: SwitcherRowState): SwitcherRow => ({
    sessionId: session.id,
    label: session.label,
    state,
    age: formatSessionAge(session.createdAt, now),
    lastActive: session.id === lastPtyId,
    canSelect: state === "detached" && hasCapacity,
    canTakeOver: state === "attached-elsewhere" && hasCapacity,
  });

  const detached = available
    .filter(session => !session.attached)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(session => toRow(session, "detached"));
  const elsewhere = available
    .filter(session => session.attached)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(session => toRow(session, "attached-elsewhere"));

  return [...mine, ...detached, ...elsewhere];
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
