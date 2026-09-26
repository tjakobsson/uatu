// Live occurrences, not timeline rows or aggregate workspace activity. A turn
// identity must come from its source lifecycle, not the latest selected row.
export type AgentNotificationKind = "question-pending" | "permission-pending" | "turn-completed";
export type AgentNotification = {
  id: string;
  conversationId: string;
  sourceId: string;
  kind: AgentNotificationKind;
  createdAt: number;
};

export type AgentNotificationEvent =
  | { type: "notification"; notification: AgentNotification }
  | { type: "resolved"; id: string; conversationId: string };

export type NotificationSourceEvent = {
  origin: "live" | "history";
  conversationId: string;
  sourceId: string;
  createdAt: number;
} & (
  | { type: "interaction"; kind: "question-pending" | "permission-pending"; pending: boolean }
  | { type: "turn"; phase: "started" | "completed" | "failed" | "interrupted" | "background"; child: boolean }
);

export const NOTIFICATION_LIFETIME_MS = 5 * 60_000;
// How long a needs-answer push may wait for its user to leave (the hub holds
// it while they are looking at Uatu), and so how long the workspace keeps an
// unanswered request reconcilable: its resolution must still reach the hub.
export const NOTIFICATION_HOLD_LIMIT_MS = 60 * 60_000;
// A question released just before the hold limit still has a full delivery
// lifetime of retries ahead; its answer must reach the hub until that ends.
export const NOTIFICATION_PENDING_RETENTION_MS = NOTIFICATION_HOLD_LIMIT_MS + NOTIFICATION_LIFETIME_MS;
const RETENTION_MS = 24 * 60 * 60_000;
const DEFAULT_RETAINED_LIMIT = 8192;

export function notificationIdentity(conversationId: string, kind: AgentNotificationKind, sourceId: string): string {
  // Tuple encoding avoids collisions when provider ids themselves contain ':'.
  return JSON.stringify([conversationId, kind, sourceId]);
}

export function qualifyNotificationEvent(agentId: string, event: AgentNotificationEvent): AgentNotificationEvent {
  if (event.type === "resolved") {
    return { ...event, id: JSON.stringify([agentId, event.id]), conversationId: `${agentId}:${event.conversationId}` };
  }
  return { type: "notification", notification: {
    ...event.notification,
    id: JSON.stringify([agentId, event.notification.id]),
    conversationId: `${agentId}:${event.notification.conversationId}`,
  } };
}

export class AgentNotificationTracker {
  private readonly turns = new Map<string, { conversationId: string; createdAt: number }>();
  private readonly pending = new Map<string, AgentNotification>();
  private readonly settled = new Map<string, number>();
  private readonly now: () => number;
  private readonly limit: number;

  constructor(private readonly options: {
    emit: (event: AgentNotificationEvent) => void;
    now?: () => number;
    retainedLimit?: number;
  }) {
    this.now = options.now ?? Date.now;
    this.limit = options.retainedLimit ?? DEFAULT_RETAINED_LIMIT;
  }

  observe(event: NotificationSourceEvent): void {
    if (event.origin !== "live") return;
    this.prune();
    if (event.type === "interaction") {
      const id = notificationIdentity(event.conversationId, event.kind, event.sourceId);
      if (!event.pending) {
        this.pending.delete(id);
        if (!this.settled.has(id)) {
          this.remember(id);
          // A resolution can arrive after loss of the pending frame. It must
          // still cancel a delivery the hub retained from an earlier stream.
          this.options.emit({ type: "resolved", id, conversationId: event.conversationId });
        }
      } else if (!this.pending.has(id) && !this.settled.has(id)) {
        const notification: AgentNotification = {
          id, conversationId: event.conversationId, sourceId: event.sourceId,
          kind: event.kind, createdAt: event.createdAt,
        };
        this.pending.set(id, notification);
        this.options.emit({ type: "notification", notification });
      }
      return;
    }
    if (event.child) return;
    const id = notificationIdentity(event.conversationId, "turn-completed", event.sourceId);
    if (this.settled.has(id)) return;
    if (event.phase === "started") {
      if (!this.turns.has(id)) this.turns.set(id, { conversationId: event.conversationId, createdAt: event.createdAt });
      return;
    }
    const matches = this.turns.delete(id);
    this.remember(id);
    if (matches && event.phase === "completed") {
      this.options.emit({ type: "notification", notification: {
        id, conversationId: event.conversationId, sourceId: event.sourceId,
        kind: "turn-completed", createdAt: event.createdAt,
      } });
    }
  }

  pendingSnapshot(): AgentNotification[] {
    this.prune();
    return [...this.pending.values()].map(notification => ({ ...notification }));
  }

  forgetConversation(conversationId: string): void {
    for (const [id, turn] of this.turns) if (turn.conversationId === conversationId) this.turns.delete(id);
    for (const [id, notification] of this.pending) {
      if (notification.conversationId !== conversationId) continue;
      this.pending.delete(id);
      this.remember(id);
      this.options.emit({ type: "resolved", id, conversationId });
    }
  }

  private remember(id: string): void {
    this.settled.set(id, this.now());
    while (this.settled.size > this.limit) this.settled.delete(this.settled.keys().next().value!);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, at] of this.settled) {
      if (now - at < RETENTION_MS) break;
      this.settled.delete(id);
    }
    // A pending request older than the hold limit can no longer become a
    // push: the hub drops a held one at that age. Forget it without changing
    // the chat request itself. Until then its answer must still be announced,
    // or the hub would release a push for a question already answered.
    for (const [id, notification] of this.pending) {
      if (now - notification.createdAt <= NOTIFICATION_PENDING_RETENTION_MS) continue;
      this.pending.delete(id);
      this.remember(id);
    }
  }
}
