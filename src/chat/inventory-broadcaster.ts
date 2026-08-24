export interface ConversationInventorySubscription extends AsyncIterableIterator<void> {
  cancel(): void;
}

class OneBitInventorySubscription implements ConversationInventorySubscription {
  private readonly waiting: Array<(result: IteratorResult<void>) => void> = [];
  private pending: boolean;
  private closed: boolean;

  constructor(private readonly cleanup: () => void, closed = false) {
    this.pending = !closed;
    this.closed = closed;
  }

  invalidate(): void {
    if (this.closed || this.pending) return;
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: undefined, done: false });
      return;
    }
    this.pending = true;
  }

  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending = false;
    this.cleanup();
    for (const waiter of this.waiting.splice(0)) waiter({ value: undefined, done: true });
  }

  next(): Promise<IteratorResult<void>> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve({ value: undefined, done: false });
    }
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise(resolve => this.waiting.push(resolve));
  }

  async return(): Promise<IteratorResult<void>> {
    this.cancel();
    return { value: undefined, done: true };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<void> {
    return this;
  }
}

export class ConversationInventoryBroadcaster {
  private readonly subscribers = new Set<OneBitInventorySubscription>();
  private disposed = false;

  subscribe(signal?: AbortSignal): ConversationInventorySubscription {
    if (this.disposed || signal?.aborted) return new OneBitInventorySubscription(() => undefined, true);

    let subscription: OneBitInventorySubscription;
    const onAbort = () => subscription.cancel();
    subscription = new OneBitInventorySubscription(() => {
      this.subscribers.delete(subscription);
      signal?.removeEventListener("abort", onAbort);
    });
    this.subscribers.add(subscription);
    signal?.addEventListener("abort", onAbort, { once: true });
    return subscription;
  }

  invalidate(): void {
    if (this.disposed) return;
    for (const subscriber of this.subscribers) subscriber.invalidate();
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscriber of [...this.subscribers]) subscriber.cancel();
  }
}
