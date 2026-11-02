import { describe, expect, test } from "bun:test";

import { ConversationProjection } from "./adapter";
import { ConversationReplay, encodeReplayCursor } from "./replay";
import { parseChatEvent } from "./validation";

async function next<T>(iterator: AsyncIterator<T>): Promise<T> {
  const result = await iterator.next();
  if (result.done) throw new Error("iterator ended");
  return result.value;
}

describe("conversation replay", () => {
  test("replay preserves independent worker activity and control evidence", async () => {
    const replay = new ConversationReplay("generation", "parent", 10_000);
    const projection = new ConversationProjection(replay);
    const cursor = replay.latestCursor();
    const item = { id: "task", type: "background_task" as const, taskId: "task", description: "Worker", status: "running" as const, createdAt: 1,
      stateUncertain: true, activity: { kind: "working" as const, executionId: "execution", observedAt: 2, generation: 1 }, control: { available: false, reason: "Control proof unavailable" } };
    projection.apply({ kind: "upsert", item });
    const handoff = replay.handoff(() => projection.items(), cursor);
    try {
      const event = parseChatEvent(JSON.parse(JSON.stringify(await next(handoff.subscription[Symbol.asyncIterator]()))));
      expect(event).toMatchObject({ type: "item.upsert", item });
      expect(handoff.snapshot).toEqual([item]);
    } finally { handoff.subscription.cancel(); }
  });

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

  test("a conversation rewrite resyncs existing subscribers and a fresh snapshot recovers", async () => {
    const replay = new ConversationReplay("generation", "session", 10_000);
    const projection = new ConversationProjection(replay);
    projection.seed([
      { id: "message:kept", type: "user_message", createdAt: 1, text: "kept" },
      { id: "message:removed", type: "user_message", createdAt: 2, text: "removed" },
    ]);
    const existing = replay.handoff(cursor => ({ cursor, items: projection.items() }));

    projection.replace([
      { id: "message:kept", type: "user_message", createdAt: 1, text: "kept" },
    ]);

    const rewrite = await next(existing.subscription[Symbol.asyncIterator]());
    expect(rewrite).toEqual(expect.objectContaining({ type: "resync", reason: "conversation-rewritten" }));

    const fresh = replay.handoff(cursor => ({ cursor, items: projection.items() }));
    expect(fresh.snapshot.items.map(item => item.id)).toEqual(["message:kept"]);
    expect(fresh.snapshot.cursor).toBe(replay.latestCursor());
    existing.subscription.cancel();
    fresh.subscription.cancel();
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
