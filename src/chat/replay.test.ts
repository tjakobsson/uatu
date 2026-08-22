import { describe, expect, test } from "bun:test";

import { ConversationReplay, encodeReplayCursor } from "./replay";

async function next<T>(iterator: AsyncIterator<T>): Promise<T> {
  const result = await iterator.next();
  if (result.done) throw new Error("iterator ended");
  return result.value;
}

describe("conversation replay", () => {
  test("hands off atomically from ordered replay to live events", async () => {
    const replay = new ConversationReplay("generation", "session", 10_000);
    replay.publish({ type: "conversation.status", status: "sending" });
    const cursor = replay.latestCursor();
    replay.publish({ type: "conversation.status", status: "running" });
    const handoff = replay.handoff(snapshotCursor => ({ cursor: snapshotCursor }), cursor);
    replay.publish({ type: "conversation.status", status: "completed" });
    const iterator = handoff.subscription[Symbol.asyncIterator]();

    expect((await next(iterator)).sequence).toBe(2);
    expect((await next(iterator)).sequence).toBe(3);
    expect(handoff.snapshot.cursor).toBe(encodeReplayCursor({ generation: "generation", sequence: 2 }));
    await iterator.return?.();
    expect(replay.subscriberCount()).toBe(0);
  });

  test("reports retention gaps and generation changes as terminal resync events", async () => {
    const replay = new ConversationReplay("new", "session", 1);
    replay.publish({ type: "conversation.status", status: "sending" });
    replay.publish({ type: "conversation.status", status: "running" });

    const gap = replay.handoff(() => null, encodeReplayCursor({ generation: "new", sequence: 0 })).subscription[Symbol.asyncIterator]();
    expect(await next(gap)).toEqual(expect.objectContaining({ type: "resync", reason: "retention-gap" }));
    expect((await gap.next()).done).toBe(true);

    const stale = replay.handoff(() => null, encodeReplayCursor({ generation: "old", sequence: 2 })).subscription[Symbol.asyncIterator]();
    expect(await next(stale)).toEqual(expect.objectContaining({ type: "resync", reason: "generation-changed" }));
    expect((await stale.next()).done).toBe(true);
  });

  test("a stalled subscriber's backlog is bounded and ends the stream instead of growing", async () => {
    const replay = new ConversationReplay("generation", "session", 10_000);
    const handoff = replay.handoff(cursor => ({ cursor }));
    // Nothing pulls: every published frame lands in the backlog. A ~64 KiB
    // notice needs at most 17 frames to cross the 1 MiB bound.
    const message = "x".repeat(64 * 1024);
    for (let index = 0; index < 20; index += 1) {
      replay.publish({ type: "item.upsert", item: { id: `notice:${index}`, type: "notice", createdAt: index, level: "info", message } });
    }
    const iterator = handoff.subscription[Symbol.asyncIterator]();
    // The backlog was dropped, not drained — the stream reports done and the
    // client's reconnect path recovers from the ring or a fresh snapshot.
    expect((await iterator.next()).done).toBe(true);
    // A cancelled subscriber no longer accumulates.
    replay.publish({ type: "conversation.status", status: "completed" });
    expect((await iterator.next()).done).toBe(true);
  });

  test("cancellation closes a pending iterator and cleans up the subscriber", async () => {
    const replay = new ConversationReplay("g", "s", 100);
    const controller = new AbortController();
    const subscription = replay.handoff(() => null, undefined, controller.signal).subscription;
    const pending = subscription[Symbol.asyncIterator]().next();
    controller.abort();
    expect((await pending).done).toBe(true);
    expect(replay.subscriberCount()).toBe(0);
  });
});
