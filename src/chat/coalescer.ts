import type { NormalizedProviderUpdate } from "./provider";

export type CoalescerOptions = {
  windowMs?: number;
  onFlush: (conversationId: string, updates: NormalizedProviderUpdate[]) => void | Promise<void>;
};

const DEFAULT_WINDOW_MS = 50;

/**
 * Batches high-frequency provider updates (streamed text deltas, repeated tool
 * upserts) into one apply per window, while urgent updates — status changes,
 * interactions, user messages, terminal tool states — flush immediately.
 * Flushes for one conversation are serialized so apply order is preserved.
 */
export class ProviderUpdateCoalescer {
  private readonly windowMs: number;
  private readonly onFlush: CoalescerOptions["onFlush"];
  private readonly buffers = new Map<string, NormalizedProviderUpdate[]>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly epochs = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: CoalescerOptions) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.onFlush = options.onFlush;
  }

  push(conversationId: string, updates: NormalizedProviderUpdate[]): void {
    if (this.disposed || updates.length === 0) return;
    let buffer = this.buffers.get(conversationId);
    if (!buffer) {
      buffer = [];
      this.buffers.set(conversationId, buffer);
    }
    let urgent = false;
    for (const update of updates) {
      urgent = mergeUpdate(buffer, update) || urgent;
    }
    if (urgent) {
      this.flushConversation(conversationId);
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = null;
      for (const id of [...this.buffers.keys()]) this.flushConversation(id);
    }, this.windowMs);
  }

  flushAll(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const id of [...this.buffers.keys()]) this.flushConversation(id);
  }

  /** Drops buffered updates made obsolete by an authoritative rewrite. */
  discard(conversationId: string): void {
    this.buffers.delete(conversationId);
    this.epochs.set(conversationId, (this.epochs.get(conversationId) ?? 0) + 1);
    if (!this.tails.has(conversationId)) this.epochs.delete(conversationId);
    if (this.buffers.size === 0 && this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.flushAll();
    this.disposed = true;
  }

  /** Resolves when every flush issued so far has been applied. */
  async settled(): Promise<void> {
    await Promise.all([...this.tails.values()]);
  }

  private flushConversation(conversationId: string): void {
    const buffer = this.buffers.get(conversationId);
    if (!buffer || buffer.length === 0) return;
    this.buffers.delete(conversationId);
    const epoch = this.epochs.get(conversationId) ?? 0;
    const tail = this.tails.get(conversationId) ?? Promise.resolve();
    const next = tail.then(() => {
      if ((this.epochs.get(conversationId) ?? 0) !== epoch) return;
      return this.onFlush(conversationId, buffer);
    }).catch(() => undefined).then(() => {
      // Release the chain once it is the last one queued for this conversation.
      if (this.tails.get(conversationId) === next) {
        this.tails.delete(conversationId);
        if (!this.buffers.has(conversationId)) this.epochs.delete(conversationId);
      }
    });
    this.tails.set(conversationId, next);
  }
}

/** Returns true when the update must flush the buffer immediately. */
function mergeUpdate(buffer: NormalizedProviderUpdate[], update: NormalizedProviderUpdate): boolean {
  if (update.kind === "status" || update.kind === "remove") {
    buffer.push(update);
    return true;
  }
  if (update.kind === "text") {
    const existing = buffer.find(candidate => candidate.kind === "text" && candidate.itemId === update.itemId && candidate.identity === update.identity);
    if (existing && existing.kind === "text") {
      if (update.mode === "cumulative") {
        existing.mode = "cumulative";
        existing.text = update.text;
      } else {
        // A delta extends whatever is buffered, whichever mode that is: a
        // cumulative entry holds the full text so far, so the delta appends
        // and the entry stays cumulative. Guarding this on
        // `existing.mode === "incremental"` dropped every delta that landed
        // in the same window as the `text.started` snapshot — which is the
        // opening of each assistant message. Plain concatenation is right
        // here; the overlap-tolerant merge belongs downstream in
        // ProviderTextReconciler, and would corrupt true deltas ("Hel" +
        // "lo" collapses to "Helo" under its suffix heuristic).
        existing.text += update.text;
      }
      existing.item = update.item ?? existing.item;
      return false;
    }
    buffer.push({ ...update });
    return false;
  }
  const index = buffer.findIndex(candidate => candidate.kind === "upsert" && candidate.item.id === update.item.id);
  if (index >= 0) buffer[index] = update;
  else buffer.push(update);
  const item = update.item;
  if (item.type === "user_message" || item.type === "permission" || item.type === "question" || item.type === "notice" || item.type === "turn_status") return true;
  if ("status" in item && (item.status === "completed" || item.status === "failed" || item.status === "cancelled")) return true;
  return false;
}
