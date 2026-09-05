import { createHash } from "node:crypto";

export const HISTORY_REUSE_BYTES = 32 * 1024 * 1024;
export const HISTORY_REUSE_CONVERSATIONS = 8;

/** Provider-owned LRU. An absent version shares concurrent work only. */
export class HistoryReuse<T> {
  private readonly retained = new Map<string, { version: string; value: T; bytes: number }>();
  private readonly pending = new Map<string, { version: string | undefined; promise: Promise<T> }>();
  private bytes = 0;
  private disposed = false;

  constructor(private readonly byteLimit = HISTORY_REUSE_BYTES, private readonly countLimit = HISTORY_REUSE_CONVERSATIONS) {}

  get size(): number { return this.retained.size; }
  get retainedBytes(): number { return this.bytes; }

  async read(key: string, version: string | undefined, loader: () => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error("History reuse is disposed");
    const cached = this.retained.get(key);
    if (version !== undefined && cached?.version === version) {
      this.retained.delete(key);
      this.retained.set(key, cached);
      return cached.value;
    }
    const flight = this.pending.get(key);
    if (flight && flight.version === version) return flight.promise;
    this.remove(key);
    const entry = { version, promise: Promise.resolve().then(loader) };
    this.pending.set(key, entry);
    try {
      const value = await entry.promise;
      if (!this.disposed && version !== undefined && this.pending.get(key) === entry) {
        // Account conservatively for UTF-16 strings and decoded objects. This
        // is a retention budget, independent of a response's encoded bytes.
        const bytes = JSON.stringify(value).length * 2;
        if (bytes <= this.byteLimit && this.countLimit > 0) {
          while (this.retained.size >= this.countLimit || this.bytes + bytes > this.byteLimit) this.remove(this.retained.keys().next().value!);
          this.retained.set(key, { version, value, bytes });
          this.bytes += bytes;
        }
      }
      return value;
    } finally { if (this.pending.get(key) === entry) this.pending.delete(key); }
  }

  invalidate(key?: string): void {
    if (key !== undefined) { this.remove(key); this.pending.delete(key); }
    else { this.retained.clear(); this.pending.clear(); this.bytes = 0; }
  }
  dispose(): void { this.disposed = true; this.invalidate(); }
  private remove(key: string): void {
    const entry = this.retained.get(key);
    if (entry) { this.bytes -= entry.bytes; this.retained.delete(key); }
  }
}

export class HistoryChangedError extends Error {
  constructor() { super("Conversation history changed. Reload the conversation before loading older messages."); }
}

export function historyVersion(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

export function historyPageEnd(cursor: string | undefined, version: string, length: number): number {
  if (cursor === undefined) return length;
  let value: { version?: unknown; end?: unknown };
  try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); }
  catch { throw new HistoryChangedError(); }
  if (value?.version !== version || typeof value.end !== "number" || !Number.isSafeInteger(value.end) || value.end < 0 || value.end > length) throw new HistoryChangedError();
  return value.end;
}

export function historyPageCursor(end: number, version: string): string | undefined {
  return end > 0 ? Buffer.from(JSON.stringify({ version, end })).toString("base64url") : undefined;
}
