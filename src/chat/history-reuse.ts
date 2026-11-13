import { createHash } from "node:crypto";

export const HISTORY_REUSE_BYTES = 32 * 1024 * 1024;
export const HISTORY_REUSE_CONVERSATIONS = 8;

/** Provider-owned LRU. An absent version shares concurrent work only. */
export class HistoryReuse<T> {
  private readonly shared = new Map<string, { version: string | undefined; controller: AbortController; promise: Promise<T>; users: number; settled: boolean }>();
  private readonly owners = new Set<AbortController>();
  private readonly retained = new Map<string, { version: string; value: T; bytes: number }>();
  private readonly pending = new Map<string, { version: string | undefined; promise: Promise<T> }>();
  private bytes = 0;
  private disposed = false;

  constructor(private readonly byteLimit = HISTORY_REUSE_BYTES, private readonly countLimit = HISTORY_REUSE_CONVERSATIONS) {}

  get size(): number { return this.retained.size; }
  get retainedBytes(): number { return this.bytes; }

  /** Read a qualified retained value without loading or refreshing its LRU
   * position. Like read(), this returns the stored value, not a deep copy. */
  peek(key: string, version: string | undefined): T | undefined {
    if (this.disposed || version === undefined) return;
    const cached = this.retained.get(key);
    return cached?.version === version ? cached.value : undefined;
  }

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

  /** Opt-in collective I/O ownership. Legacy read() callers keep their existing
   * invalidation and loader semantics. Waiters own only their own cancellation. */
  async readShared(key: string, version: string | undefined, loader: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    if (this.disposed) throw new Error("History reuse is disposed");
    let owner = this.shared.get(key);
    if (!owner || owner.version !== version) {
      const controller = new AbortController();
      // Even an uncooperative transport cannot keep a shared owner indefinitely.
      const lifetime = AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]);
      const promise = this.read(key, version, () => abortable(lifetime, () => loader(lifetime)));
      owner = { version, controller, promise, users: 0, settled: false };
      this.shared.set(key, owner);
      this.owners.add(controller);
      const owned = owner;
      void promise.finally(() => {
        owned.settled = true;
        this.owners.delete(controller);
        if (this.shared.get(key) === owned) this.shared.delete(key);
      }).catch(() => undefined);
    }
    owner.users++;
    try { return await abortable(signal, () => owner.promise); }
    finally {
      if (--owner.users === 0 && !owner.settled) {
        owner.controller.abort();
        // An abandoned owner must not remove or populate its replacement.
        if (this.shared.get(key) === owner) {
          this.shared.delete(key);
          this.pending.delete(key);
        }
      }
    }
  }

  invalidate(key?: string): void {
    if (key !== undefined) { this.remove(key); this.pending.delete(key); this.shared.delete(key); }
    else { this.retained.clear(); this.pending.clear(); this.shared.clear(); this.bytes = 0; }
  }
  dispose(): void { this.disposed = true; for (const owner of this.owners) owner.abort(); this.invalidate(); }
  private remove(key: string): void {
    const entry = this.retained.get(key);
    if (entry) { this.bytes -= entry.bytes; this.retained.delete(key); }
  }
}

async function abortable<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let aborted!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { aborted = () => reject(signal.reason); });
  signal.addEventListener("abort", aborted, { once: true });
  try {
    const value = await Promise.race([read(), cancelled]);
    signal.throwIfAborted();
    return value;
  } finally { signal.removeEventListener("abort", aborted); }
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
