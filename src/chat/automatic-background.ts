import type { AutomaticBackgroundOutcome } from "./types";

export function automaticBackgroundNote(outcome?: AutomaticBackgroundOutcome): string {
  switch (outcome) {
    case "accepted":
    case "not-needed": return "";
    case "unavailable": return "Automatic backgrounding is unavailable. Refresh status; the steer was not repeated.";
    case "failed": return "Automatic backgrounding was refused. Refresh status; the steer was not repeated.";
    case "unknown": return "Automatic backgrounding could not be confirmed. Do not repeat the steer.";
    default: return "";
  }
}

/** Page-local receipts, not execution state. Only the same operation can
 * resolve its uncertainty; unrelated mutations convey no such evidence. */
export class AutomaticBackgroundNotices {
  private readonly conversations = new Map<string, Map<string, { text: string; origin?: string; subject?: string }>>();

  record(conversation: string, operation: string, outcome?: AutomaticBackgroundOutcome): void {
    if (outcome === undefined) return;
    if (outcome === "accepted" || outcome === "not-needed") {
      const notices = this.conversations.get(conversation);
      notices?.delete(operation);
      if (!notices?.size) this.conversations.delete(conversation);
      return;
    }
    this.put(conversation, operation, { text: automaticBackgroundNote(outcome) });
  }

  unconfirmed(conversation: string, operation: string, action: string, text?: string, subject = "acceptance"): void {
    if (text === undefined) { this.put(conversation, operation, { text: action }); return; }
    const origin = actionOrigin(action, text || `attachment-only message · ${operation.replace(/[^a-zA-Z0-9-]/g, "").slice(-8) || "pending"}`);
    this.put(conversation, operation, {
      text: `${origin}: ${subject} unconfirmed. Checking conversation status; ${subject === "withdrawal" ? "do not resubmit; you may retry withdrawal" : "do not repeat"}.`,
      origin,
      subject,
    });
  }

  checked(conversation: string, operation: string, available: boolean): void {
    const notice = this.conversations.get(conversation)?.get(operation);
    if (!notice?.origin) return;
    notice.text = `${notice.origin}: ${available ? `Status checked; ${notice.subject} still unconfirmed` : `Status check unavailable; ${notice.subject} unconfirmed`}. ${notice.subject === "withdrawal" ? "Do not resubmit; you may retry withdrawal." : "Do not repeat."}`;
  }

  private put(conversation: string, operation: string, notice: { text: string; origin?: string; subject?: string }): void {
    let notices = this.conversations.get(conversation);
    if (!notices) this.conversations.set(conversation, notices = new Map());
    notices.set(operation, notice);
    // Page-local only, bounded across both conversations and operations.
    while (notices.size > 20) notices.delete(notices.keys().next().value!);
    while (this.conversations.size > 100) this.conversations.delete(this.conversations.keys().next().value!);
  }

  text(conversation: string): string {
    const notices = [...(this.conversations.get(conversation)?.values() ?? [])];
    return [...new Set(notices.map(notice => notice.text))].join(" ");
  }
}

export function actionOrigin(action: string, text: string): string {
  const excerpt = text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\s]+/g, " ").trim();
  return `${action} “${excerpt ? [...excerpt].slice(0, 72).join("") + ([...excerpt].length > 72 ? "…" : "") : "attachment-only message"}”`;
}
