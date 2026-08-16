import { describe, expect, test } from "bun:test";

import { IdempotencyReceipts } from "./receipts";

describe("idempotency receipts", () => {
  test("joins concurrent duplicates and retains the settled result", async () => {
    let calls = 0;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const receipts = new IdempotencyReceipts({ maxEntries: 10, maxBytes: 10_000, ttlMs: 100 });
    const operation = () => receipts.run("scope:request", async () => {
      calls += 1;
      await blocked;
      return { id: "provider-message" };
    });
    const first = operation();
    const second = operation();
    release();
    expect(await Promise.all([first, second])).toEqual([{ id: "provider-message" }, { id: "provider-message" }]);
    expect(await operation()).toEqual({ id: "provider-message" });
    expect(calls).toBe(1);
  });

  test("expires receipts and remains entry bounded", async () => {
    let now = 0;
    let calls = 0;
    const receipts = new IdempotencyReceipts({ maxEntries: 2, maxBytes: 10_000, ttlMs: 10, now: () => now });
    await receipts.run("a", async () => ++calls);
    await receipts.run("b", async () => ++calls);
    await receipts.run("c", async () => ++calls);
    expect(receipts.size()).toBe(2);
    now = 11;
    await receipts.run("c", async () => ++calls);
    expect(calls).toBe(4);
  });
});
