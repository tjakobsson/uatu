type Receipt<T> = {
  promise: Promise<T>;
  expiresAt: number;
  bytes: number;
  settled: boolean;
};

export class IdempotencyReceipts {
  private readonly receipts = new Map<string, Receipt<unknown>>();
  private bytes = 0;

  constructor(private readonly options: { maxEntries: number; maxBytes: number; ttlMs: number; now?: () => number }) {}

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    this.prune();
    const existing = this.receipts.get(key) as Receipt<T> | undefined;
    if (existing) return existing.promise;
    const initialBytes = Buffer.byteLength(key) + 64;
    while (this.receipts.size >= this.options.maxEntries || this.bytes + initialBytes > this.options.maxBytes) {
      const oldest = [...this.receipts.entries()].find(([, receipt]) => receipt.settled);
      if (!oldest) throw new Error("idempotency receipt capacity reached");
      this.remove(oldest[0], oldest[1]);
    }

    const promise = operation();
    const receipt: Receipt<T> = { promise, expiresAt: Infinity, bytes: initialBytes, settled: false };
    this.receipts.set(key, receipt);
    this.bytes += receipt.bytes;
    void promise.then(value => {
      const settledBytes = Buffer.byteLength(safeJson(value));
      receipt.bytes += settledBytes;
      this.bytes += settledBytes;
      receipt.settled = true;
      receipt.expiresAt = this.now() + this.options.ttlMs;
      this.prune();
    }, () => this.remove(key, receipt));
    this.prune();
    return promise;
  }

  size(): number {
    this.prune();
    return this.receipts.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, receipt] of this.receipts) {
      if (receipt.settled && receipt.expiresAt <= now) this.remove(key, receipt);
    }
    while (this.receipts.size > this.options.maxEntries || this.bytes > this.options.maxBytes) {
      const oldest = [...this.receipts.entries()].find(([, receipt]) => receipt.settled);
      if (!oldest) break;
      this.remove(oldest[0], oldest[1]);
    }
  }

  private remove(key: string, receipt: Receipt<unknown>): void {
    if (this.receipts.get(key) !== receipt) return;
    this.receipts.delete(key);
    this.bytes -= receipt.bytes;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
