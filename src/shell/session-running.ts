// Whether the hub says the current workspace's session is running — the one
// fact the shell needs to tell a stopped session from a transport gap.
//
// Written only by the workspace switcher (`shell/hub-nav.ts`), which is the
// module that knows the current workspace id and reconciles the hub's list
// with the stream's activity topic. Read by the connection indicator, which
// shows `Stopped` and offers a start instead of a reconnect, and by the
// manual recovery, which must not reload a page whose session is stopped.
// Kept apart from both so neither imports the other: hub-nav already
// imports the live channel, and the channel's recovery reads this.
//
// `null` means unknown — a page not served through a hub, or one whose hub
// probe has not answered. Only an explicit `false` is a stopped session.

export type SessionRunningFact = boolean | null;

let fact: SessionRunningFact = null;
const listeners = new Set<(running: SessionRunningFact) => void>();

export function currentSessionRunningFact(): SessionRunningFact {
  return fact;
}

// Called at once with the current fact, then on every change.
export function onCurrentSessionRunning(listener: (running: SessionRunningFact) => void): () => void {
  listeners.add(listener);
  listener(fact);
  return () => { listeners.delete(listener); };
}

// Emits only on change: the switcher recomputes on every list read and
// activity report, and the indicator must not re-render for a repeat.
export function setCurrentSessionRunning(next: SessionRunningFact): void {
  if (next === fact) return;
  fact = next;
  for (const listener of [...listeners]) listener(fact);
}

export function resetCurrentSessionRunningForTests(): void {
  fact = null;
  listeners.clear();
}
