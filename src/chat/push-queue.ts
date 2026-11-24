/**
 * An async queue that producers push into and one consumer iterates. A
 * provider feeds its `events()` stream through one, and the Claude Code
 * provider also feeds each SDK session's prompt input through one.
 *
 * A value pushed while nobody reads is banked for the next read. `close()`
 * ends the queue for good: later pushes are dropped, banked values are still
 * read, then every read ends. `detachWaiters()` ends only the reads in
 * progress, so an aborted subscriber's replacement keeps the banked values
 * and every later push.
 *
 * `offer()` is a push that reports whether a reader took the value: true
 * once a read returns it, false if `close()` comes first, which withdraws
 * it, so it is never read after it was reported untaken.
 */
export class PushQueue<T> implements AsyncIterable<T> {
  private values: Array<{ value: T; taken?: (taken: boolean) => void }> = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push({ value });
  }

  offer(value: T): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return Promise.resolve(true);
    }
    return new Promise(taken => this.values.push({ value, taken }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.values) entry.taken?.(false);
    this.values = this.values.filter(entry => entry.taken === undefined);
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  /**
   * Ends every outstanding read without closing: banked values stay for
   * the next consumer. What an aborted subscriber's replacement needs.
   */
  detachWaiters(): void {
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  take(): Promise<IteratorResult<T>> {
    return this[Symbol.asyncIterator]().next();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        // By entry, not by the value: a pushed `undefined` is a value too.
        const entry = this.values.shift();
        if (entry) {
          entry.taken?.(true);
          return Promise.resolve({ value: entry.value, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise(resolve => this.waiters.push(resolve));
      },
      return: async (): Promise<IteratorResult<T>> => {
        this.close();
        return { value: undefined as never, done: true };
      },
    };
  }
}
