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
// Leave space for preexisting frames and control/frame overhead. This bounds
// candidate copies independently of the (usually smaller) retained ring.
const RECOVERY_BATCH_BYTES = MAX_SUBSCRIBER_BACKLOG_BYTES - 64 * 1024;

export class ReplaySubscription implements AsyncIterable<ChatEvent> {
  private readonly queued: Array<{ event: ChatEvent; bytes: number }> = [];
  private readonly waiting: Array<(value: IteratorResult<ChatEvent>) => void> = [];
  private queuedBytes = 0;
  private closed = false;

  constructor(private readonly cleanup: () => void) {}

  canAccept(bytes: number): boolean {
    return !this.closed && this.queuedBytes + bytes <= RECOVERY_BATCH_BYTES;
  }

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

  /** Prepare without advancing a cursor or exposing a prefix. Call the result
   * synchronously after the matching projection commit, with no intervening
   * callbacks. Failed preparation leaves replay untouched; a stale publication
   * is refused. Once oversized, candidate event references are discarded. */
  prepareBatch(payloads: Iterable<EventPayload>): () => ChatEvent | undefined {
    const boundary = this.sequence;
    let candidates: Array<{ event: ChatEvent; bytes: number }> = [];
    let bytes = 0, count = 0, oversized = false;
    for (const payload of payloads) {
      if (oversized) { count++; continue; }
      const event = { ...payload, generation: this.generation, sequence: boundary + ++count, conversationId: this.conversationId } as ChatEvent;
      const size = Buffer.byteLength(JSON.stringify(event));
      // Reserve SSE framing/cursor overhead even though the subscriber counts
      // JSON bytes only. Ordinary publish retains its existing stall policy.
      bytes += size + 256;
      if (bytes > RECOVERY_BATCH_BYTES) { oversized = true; candidates = []; }
      if (!oversized) candidates.push({ event, bytes: size });
    }
    let committed = false;
    return () => {
      if (committed || this.sequence !== boundary) throw new Error("Recovery publication superseded");
      committed = true;
      if (!count) return;
      if (oversized) {
        const event = this.publish({ type: "resync", reason: "conversation-rewritten" });
        for (const subscriber of [...this.subscribers]) subscriber.cancel();
        return event;
      }
      this.sequence += count;
      this.events.push(...candidates);
      this.bytes += candidates.reduce((total, entry) => total + entry.bytes, 0);
      while (this.bytes > this.byteLimit && this.events.length) this.bytes -= this.events.shift()!.bytes;
      for (const subscriber of [...this.subscribers]) {
        if (subscriber.canAccept(bytes)) {
          for (const { event } of candidates) subscriber.push(event);
        } else {
          // The terminal SSE id must not acknowledge the unseen batch.
          subscriber.push({ generation: this.generation, sequence: boundary, conversationId: this.conversationId,
            type: "resync", reason: "conversation-rewritten" });
          subscriber.cancel();
        }
      }
      const last = candidates.at(-1)?.event;
      candidates = [];
      return last;
    };
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
    try {
      // Owed replay must precede any live publication reentering through the
      // snapshot callback. The callback still names the captured boundary.
      if (cursor) this.replayInto(cursor, boundary, subscription);
      if (signal?.aborted) subscription.cancel();
      const result = snapshot(encodeReplayCursor({ generation: this.generation, sequence: boundary }));
      return { snapshot: result, subscription };
    } catch (error) {
      subscription.cancel();
      throw error;
    }
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
      if (retained.event.sequence > parsed.sequence && retained.event.sequence <= boundary) {
        subscription.push(retained.event);
        if (retained.event.type === "resync") { subscription.cancel(); break; }
      }
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
