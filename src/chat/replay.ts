import type { ChatEvent } from "./types";

type EventPayload = ChatEvent extends infer Event
  ? Event extends ChatEvent ? Omit<Event, "generation" | "sequence" | "conversationId"> : never
  : never;

export type ReplayCursor = { generation: string; sequence: number };

// A consumer that stops pulling must not hold the workspace hostage: the
// backlog below this many bytes of undelivered frames ends the stream
// instead of growing without bound. The client reconnects with its last
// cursor and either replays from the retained ring or resynchronizes from a
// fresh snapshot — both already-working paths.
const MAX_SUBSCRIBER_BACKLOG_BYTES = 1024 * 1024;

export class ReplaySubscription implements AsyncIterable<ChatEvent> {
  private readonly queued: Array<{ event: ChatEvent; bytes: number }> = [];
  private readonly waiting: Array<(value: IteratorResult<ChatEvent>) => void> = [];
  private queuedBytes = 0;
  private closed = false;

  constructor(private readonly cleanup: () => void) {}

  push(event: ChatEvent): void {
    if (this.closed) return;
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    this.queued.push({ event, bytes });
    this.queuedBytes += bytes;
    if (this.queuedBytes > MAX_SUBSCRIBER_BACKLOG_BYTES) {
      // The backlog is dropped, not drained: a consumer this far behind is
      // stalled, and the reconnect path recovers everything it missed.
      this.queued.length = 0;
      this.queuedBytes = 0;
      this.cancel();
    }
  }

  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.cleanup();
    for (const waiter of this.waiting.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<ChatEvent> {
    return {
      next: () => {
        const entry = this.queued.shift();
        if (entry) {
          this.queuedBytes -= entry.bytes;
          return Promise.resolve({ value: entry.event, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => this.waiting.push(resolve));
      },
      return: async () => {
        this.cancel();
        return { value: undefined, done: true };
      },
    };
  }
}

export class ConversationReplay {
  private readonly events: Array<{ event: ChatEvent; bytes: number }> = [];
  private readonly subscribers = new Set<ReplaySubscription>();
  private sequence = 0;
  private bytes = 0;

  constructor(readonly generation: string, readonly conversationId: string, private readonly byteLimit: number) {}

  latestCursor(): string {
    return encodeReplayCursor({ generation: this.generation, sequence: this.sequence });
  }

  publish(payload: EventPayload): ChatEvent {
    const event = { ...payload, generation: this.generation, sequence: ++this.sequence, conversationId: this.conversationId } as ChatEvent;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    this.events.push({ event, bytes });
    this.bytes += bytes;
    while (this.bytes > this.byteLimit && this.events.length > 0) {
      const removed = this.events.shift();
      if (removed) this.bytes -= removed.bytes;
    }
    for (const subscriber of this.subscribers) subscriber.push(event);
    return event;
  }

  handoff<T>(snapshot: (cursor: string) => T, cursor?: string, signal?: AbortSignal): { snapshot: T; subscription: ReplaySubscription } {
    const subscription = new ReplaySubscription(() => {
      this.subscribers.delete(subscription);
      signal?.removeEventListener("abort", onAbort);
    });
    const onAbort = () => subscription.cancel();
    this.subscribers.add(subscription);
    signal?.addEventListener("abort", onAbort, { once: true });

    const boundary = this.sequence;
    const result = snapshot(encodeReplayCursor({ generation: this.generation, sequence: boundary }));
    if (cursor) this.replayInto(cursor, boundary, subscription);
    return { snapshot: result, subscription };
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  private replayInto(cursor: string, boundary: number, subscription: ReplaySubscription): void {
    const parsed = decodeReplayCursor(cursor);
    if (!parsed) {
      subscription.push(this.resync("invalid-cursor"));
      subscription.cancel();
      return;
    }
    if (parsed.generation !== this.generation) {
      subscription.push(this.resync("generation-changed"));
      subscription.cancel();
      return;
    }
    const oldest = this.events[0]?.event.sequence ?? this.sequence + 1;
    if (parsed.sequence < oldest - 1 || parsed.sequence > boundary) {
      subscription.push(this.resync("retention-gap"));
      subscription.cancel();
      return;
    }
    for (const retained of this.events) {
      if (retained.event.sequence > parsed.sequence && retained.event.sequence <= boundary) subscription.push(retained.event);
    }
  }

  private resync(reason: "generation-changed" | "retention-gap" | "invalid-cursor"): ChatEvent {
    return {
      generation: this.generation,
      sequence: this.sequence,
      conversationId: this.conversationId,
      type: "resync",
      reason,
    };
  }
}

export function encodeReplayCursor(cursor: ReplayCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, g: cursor.generation, s: cursor.sequence })).toString("base64url");
}

export function decodeReplayCursor(value: string): ReplayCursor | null {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString()) as { v?: unknown; g?: unknown; s?: unknown };
    if (decoded.v !== 1 || typeof decoded.g !== "string" || !Number.isSafeInteger(decoded.s) || (decoded.s as number) < 0) return null;
    return { generation: decoded.g, sequence: decoded.s as number };
  } catch {
    return null;
  }
}
