import { createHmac, randomBytes } from "node:crypto";
import { IdempotencyReceipts } from "../chat/receipts";

type Operation = { principal: string; method: string; pathname: string; requestId: string };

/** Per-running-child Hub state. The token is an operation identifier only,
 * never a principal assertion or permission to automatically background work. */
export class HubOperationReceipts {
  private readonly key = randomBytes(32);
  private readonly decisions: IdempotencyReceipts;

  constructor(options: { maxEntries?: number; maxBytes?: number; now?: () => number } = {}) {
    this.decisions = new IdempotencyReceipts({ maxEntries: options.maxEntries ?? 1_000, maxBytes: options.maxBytes ?? 512 * 1024, ttlMs: 15 * 60_000, now: options.now });
  }

  async identify(operation: Operation, unavailable: boolean): Promise<{ token: string; unavailable: boolean }> {
    // Normalize percent-encoded identifier spelling without merging path
    // segment boundaries. Invalid encodings remain for the route to refuse.
    const path = operation.pathname.split("/").map(segment => {
      try { return decodeURIComponent(segment); } catch { return segment; }
    });
    const token = `opr_${createHmac("sha256", this.key).update(JSON.stringify([operation.principal, operation.method, path, operation.requestId])).digest("base64url")}`;
    return { token, unavailable: await this.decisions.run(token, async () => unavailable) };
  }
}
