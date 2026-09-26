import { randomUUID } from "node:crypto";
import { NOTIFICATION_LIFETIME_MS, NOTIFICATION_PENDING_RETENTION_MS, type AgentNotification, type AgentNotificationEvent } from "./notifications";

export { CHILD_NOTIFICATIONS_PATH } from "../shared/live-protocol";
export type NotificationFrame =
  | { type: "event"; cursor: string; event: AgentNotificationEvent }
  | { type: "snapshot"; cursor: string; reason: "initial" | "gap"; pending: AgentNotification[] }
  | { type: "ready"; cursor: string };

export class NotificationFeed {
  private readonly epoch = randomUUID();
  private sequence = 0;
  private bytes = 0;
  private readonly ring: Array<{ frame: NotificationFrame; sequence: number; bytes: number; at: number }> = [];
  private readonly pending = new Map<string, AgentNotification>();
  private readonly subscribers = new Set<NotificationSubscription>();
  private readonly listeners = new Set<(event: AgentNotificationEvent) => void>();

  constructor(private readonly now = Date.now, private readonly limitBytes = 512 * 1024) {}

  publish(event: AgentNotificationEvent): void {
    this.prune();
    if (event.type === "resolved") this.pending.delete(event.id);
    else if (event.notification.kind !== "turn-completed") this.pending.set(event.notification.id, event.notification);
    this.sequence += 1;
    const frame: NotificationFrame = { type: "event", cursor: this.cursor(), event };
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    this.ring.push({ frame, sequence: this.sequence, bytes, at: this.now() });
    this.bytes += bytes;
    this.prune();
    for (const subscriber of this.subscribers) subscriber.push(frame);
    for (const listener of this.listeners) listener(event);
  }

  listen(listener: (event: AgentNotificationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  snapshot(): AgentNotification[] {
    this.prune();
    return [...this.pending.values()].map(item => ({ ...item }));
  }

  subscribe(cursor?: string, signal?: AbortSignal): NotificationSubscription {
    this.prune();
    const subscription = new NotificationSubscription(() => {
      this.subscribers.delete(subscription);
      signal?.removeEventListener("abort", cancel);
    });
    const cancel = () => subscription.cancel();
    if (signal?.aborted) { subscription.cancel(); return subscription; }
    this.subscribers.add(subscription);
    signal?.addEventListener("abort", cancel, { once: true });
    const sequence = cursor?.startsWith(`${this.epoch}:`) ? Number(cursor.slice(this.epoch.length + 1)) : NaN;
    const valid = Number.isSafeInteger(sequence) && sequence >= (this.ring[0]?.sequence ?? this.sequence + 1) - 1 && sequence <= this.sequence;
    if (!cursor || !valid) subscription.push({ type: "snapshot", cursor: this.cursor(), reason: cursor ? "gap" : "initial", pending: this.snapshot() });
    else {
      for (const entry of this.ring) if (entry.sequence > sequence) subscription.push(entry.frame);
      subscription.push({ type: "ready", cursor: this.cursor() });
    }
    return subscription;
  }

  dispose(): void {
    for (const subscriber of [...this.subscribers]) subscriber.cancel();
    this.listeners.clear();
    this.pending.clear();
    this.ring.length = 0;
    this.bytes = 0;
  }

  private cursor(): string { return `${this.epoch}:${this.sequence}`; }

  private prune(): void {
    while (this.ring.length && (this.bytes > this.limitBytes || this.now() - this.ring[0]!.at > NOTIFICATION_LIFETIME_MS)) {
      this.bytes -= this.ring.shift()!.bytes;
    }
    // Replay needs only the push lifetime; an unanswered request stays listed for as long as the hub may hold its push
    // (src/hub/presence.ts), so a gap snapshot does not report a still-open question as answered.
    for (const [id, notification] of this.pending) {
      if (this.now() - notification.createdAt > NOTIFICATION_PENDING_RETENTION_MS) this.pending.delete(id);
    }
  }
}

export class NotificationSubscription implements AsyncIterable<NotificationFrame> {
  private readonly queue: Array<{ frame: NotificationFrame; bytes: number }> = [];
  private readonly waiting: Array<(result: IteratorResult<NotificationFrame>) => void> = [];
  private bytes = 0;
  private closed = false;
  constructor(private readonly cleanup: () => void) {}

  push(frame: NotificationFrame): void {
    if (this.closed) return;
    const waiting = this.waiting.shift();
    if (waiting) { waiting({ value: frame, done: false }); return; }
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    this.bytes += bytes;
    this.queue.push({ frame, bytes });
    if (this.bytes > 1024 * 1024) this.cancel();
  }
  next(): Promise<IteratorResult<NotificationFrame>> {
    const entry = this.queue.shift();
    if (entry) { this.bytes -= entry.bytes; return Promise.resolve({ value: entry.frame, done: false }); }
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise(resolve => this.waiting.push(resolve));
  }
  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.bytes = 0;
    this.cleanup();
    for (const waiting of this.waiting.splice(0)) waiting({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() { return { next: () => this.next(), return: async () => { this.cancel(); return { value: undefined, done: true as const }; } }; }
}
