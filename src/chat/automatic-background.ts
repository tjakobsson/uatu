import type { AutomaticBackgroundOutcome } from "./types";

export function automaticBackgroundNote(outcome?: AutomaticBackgroundOutcome): string {
  switch (outcome) {
    case "accepted": return "Steer accepted; background request acknowledged. Jobs may still be running.";
    case "not-needed": return "Steer accepted; no confirmed blocking work was observed.";
    case "unavailable": return "Steer accepted; automatic backgrounding is unavailable. Refresh status; explicit Continue remains available when supported.";
    case "failed": return "Steer accepted; automatic backgrounding was refused. Refresh status; explicit Continue remains available when supported.";
    case "unknown": return "Steer accepted; automatic backgrounding could not be confirmed. Refreshing status. Do not repeat the steer.";
    default: return "";
  }
}

/** Page-local receipts, not execution state. Only the same operation can
 * resolve its uncertainty; unrelated mutations convey no such evidence. */
export class AutomaticBackgroundNotices {
  private readonly conversations = new Map<string, Map<string, { text: string; successful: boolean }>>();

  record(conversation: string, operation: string, outcome?: AutomaticBackgroundOutcome): void {
    if (outcome === undefined) return;
    this.put(conversation, operation, automaticBackgroundNote(outcome), outcome === "accepted" || outcome === "not-needed");
  }

  unconfirmed(conversation: string, operation: string, text: string): void {
    this.put(conversation, operation, text, false);
  }

  private put(conversation: string, operation: string, text: string, successful: boolean): void {
    let notices = this.conversations.get(conversation);
    if (!notices) this.conversations.set(conversation, notices = new Map());
    notices.set(operation, { text, successful });
  }

  clearSuccessful(conversation: string): void {
    const notices = this.conversations.get(conversation);
    if (!notices) return;
    for (const [operation, notice] of notices) if (notice.successful) notices.delete(operation);
    if (!notices.size) this.conversations.delete(conversation);
  }

  text(conversation: string): string {
    const notices = [...(this.conversations.get(conversation)?.values() ?? [])]
      .sort((a, b) => Number(a.successful) - Number(b.successful));
    return [...new Set(notices.map(notice => notice.text))].join(" ");
  }
}
