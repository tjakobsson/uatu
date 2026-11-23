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
 */
export class PushQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
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
        // By length, not by the value: a pushed `undefined` is a value too.
        if (this.values.length > 0) return Promise.resolve({ value: this.values.shift() as T, done: false });
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
