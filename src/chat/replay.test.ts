import { describe, expect, test } from "bun:test";

import { ConversationProjection } from "./adapter";
import { ConversationReplay, encodeReplayCursor } from "./replay";
import { parseChatEvent } from "./validation";
import type { ChatEvent } from "./types";

async function next<T>(iterator: AsyncIterator<T>): Promise<T> {
  const result = await iterator.next();
  if (result.done) throw new Error("iterator ended");
  return result.value;
}

describe("conversation replay", () => {
  test("replacement preparation failure preserves the complete old view, text and replay boundary", () => {
    const replay = new ConversationReplay("g", "c", 10_000);
    let fail = false;
    const old = { id: "part:text", type: "assistant_message" as const, createdAt: 1, markdown: "Old text" };
    const projection = new ConversationProjection(replay, undefined, undefined, item => {
      if (fail && item.id === "new:b") throw new Error("replacement preparation failed");
    });
    projection.seed([old]); fail = true;
    const cursor = replay.latestCursor();
    expect(() => projection.replace([
      { id: "new:a", type: "notice", createdAt: 2, level: "info", message: "A" },
      { id: "new:b", type: "notice", createdAt: 3, level: "info", message: "B" },
    ], [old.id])).toThrow("replacement preparation failed");
    expect(projection.items()).toEqual([old]);
    expect(replay.latestCursor()).toBe(cursor);
    projection.apply({ kind: "text", itemId: old.id, identity: "text", mode: "incremental", text: "!" });
    expect(projection.get(old.id)).toMatchObject({ markdown: "Old text!" });
  });

  test("replacement admission and hooks retain atomic snapshots, reset text and invalidate prior read fences", async () => {
    const replay = new ConversationReplay("g", "c", 10_000);
    let armed = false, current = true;
    const old = { id: "part:text", type: "assistant_message" as const, createdAt: 1, markdown: "Old" };
    const projection = new ConversationProjection(replay, undefined, {
      cleared() { expect(projection.items()).toMatchObject([{ id: old.id, markdown: "New" }]); }, pending() {}, settled() {},
    }, () => { if (armed) { expect(projection.items()).toEqual([old]); current = false; } });
    projection.seed([old]); armed = true;
    const fence = projection.beginHistoryRead(), cursor = replay.latestCursor();
    const replacement = [{ ...old, markdown: "New" }];
    expect(() => projection.replace(replacement, [old.id], () => current)).toThrow();
    expect(projection.items()).toEqual([old]); expect(replay.latestCursor()).toBe(cursor); expect(fence.current()).toBe(true);
    current = true; armed = false;
    const subscriber = replay.handoff(boundary => boundary);
    projection.replace(replacement, [old.id], () => current);
    expect(fence.current()).toBe(false); fence.release();
    subscriber.subscription.cancel();
    const announced: ChatEvent[] = []; for await (const event of subscriber.subscription) announced.push(event);
    expect(announced).toMatchObject([{ type: "item.remove", itemId: old.id, sequence: 1 }, { type: "resync", sequence: 2 }]);
    projection.apply({ kind: "text", itemId: old.id, identity: "text", mode: "incremental", text: "!" });
    expect(projection.get(old.id)).toMatchObject({ markdown: "New!" });
  });

  test("an oversized replacement removal plan emits one marker and no prefix", async () => {
    const replay = new ConversationReplay("g", "c", 256 * 1024);
    const projection = new ConversationProjection(replay);
    const rows = Array.from({ length: 3_000 }, (_, i) => ({ id: `old:${i}`, type: "notice" as const, createdAt: i, level: "info" as const, message: "Old" }));
    projection.seed(rows);
    const client = replay.handoff(cursor => cursor);
    projection.replace([], rows.map(item => item.id));
    client.subscription.cancel();
    const announced: ChatEvent[] = []; for await (const event of client.subscription) announced.push(event);
    expect(announced).toMatchObject([{ type: "resync", reason: "conversation-rewritten", sequence: 1 }]);
    expect(projection.items()).toEqual([]);
  });

  test("a deliberate remove and reinsert recovery resets client authority even when its final row only loses fields", async () => {
    const replay = new ConversationReplay("g", "c", 256 * 1024);
    const projection = new ConversationProjection(replay);
    const sanitized = { id: "tool:root", type: "tool" as const, name: "subagent", status: "completed" as const, createdAt: 1, output: "Safe output" };
    projection.seed([{ ...sanitized, childConversationId: "revoked-child", model: "revoked-model", usage: { input: 100 } }]);
    const client = replay.handoff(cursor => cursor);
    projection.recover([{ kind: "remove", itemId: sanitized.id }, { kind: "upsert", item: sanitized }]);
    client.subscription.cancel();
    const announced: ChatEvent[] = []; for await (const event of client.subscription) announced.push(event);
    expect(announced).toMatchObject([{ type: "item.remove", itemId: sanitized.id, sequence: 1 }, { type: "item.upsert", item: sanitized, sequence: 2 }]);
    expect(projection.get(sanitized.id)).toEqual(sanitized);
    const cursor = replay.latestCursor();
    for (let i = 0; i < 3; i++) projection.recover([{ kind: "upsert", item: { ...sanitized } }]);
    expect(replay.latestCursor()).toBe(cursor);
  });

  test("recovery hooks see the complete old projection, then subscribers and snapshots see the complete commit", async () => {
    const replay = new ConversationReplay("g", "c", 10_000);
    const observations: string[][] = [];
    const proofs = new WeakMap<object, string>();
    const projection = new ConversationProjection(replay, undefined, undefined, (item, _current, incoming) => {
      observations.push(projection.items().map(row => row.id));
      const proof = incoming && proofs.get(incoming); if (proof) proofs.set(item, proof);
    });
    const a = { type: "notice" as const, id: "a", level: "info" as const, message: "A", createdAt: 1 };
    const b = { ...a, id: "b", message: "B" };
    const client = replay.handoff(cursor => ({ cursor, items: projection.items() }));
    expect(projection.recover([{ kind: "upsert", item: a }, { kind: "upsert", item: b }])).toBe(true);
    expect(observations).toEqual([[], []]);
    expect(projection.items()).toEqual([a, b]);
    const cursor = replay.latestCursor();
    const refreshed = { ...a }; proofs.set(refreshed, "new private proof");
    projection.recover([{ kind: "upsert", item: refreshed }]);
    expect(proofs.get(projection.get("a")!)).toBe("new private proof");
    expect(replay.latestCursor()).toBe(cursor);
    client.subscription.cancel();
    const delivered = []; for await (const event of client.subscription) delivered.push(event);
    expect(delivered).toMatchObject([{ type: "item.upsert", item: a, sequence: 1 }, { type: "item.upsert", item: b, sequence: 2 }]);
  });

  test("fallible and reentrant recovery preparation never exposes a partial batch or overwrites newer state", () => {
    const replay = new ConversationReplay("g", "c", 10_000);
    let fail = true, reenter = false;
    const row = (id: string) => ({ type: "notice" as const, id, level: "info" as const, message: id, createdAt: 1 });
    const projection = new ConversationProjection(replay, undefined, undefined, item => {
      if (item.id === "b" && fail) throw new Error("hook failed");
      if (item.id === "b" && reenter) { reenter = false; projection.upsert(row("native")); }
    });
    projection.seed([row("old")]);
    const before = replay.latestCursor();
    const batch = [{ kind: "remove" as const, itemId: "old" }, { kind: "upsert" as const, item: row("a") }, { kind: "upsert" as const, item: row("b") }];
    expect(() => projection.recover(batch)).toThrow("hook failed");
    expect(projection.items()).toEqual([row("old")]);
    expect(replay.latestCursor()).toBe(before);
    fail = false; reenter = true;
    expect(projection.recover(batch)).toBe(false);
    expect(projection.items().map(item => item.id)).toEqual(["native", "old"]);
    expect(projection.recover(batch, () => false)).toBe(false);
    expect(projection.items().map(item => item.id)).toEqual(["native", "old"]);
    expect(projection.recover(batch)).toBe(true);
    expect(projection.items().map(item => item.id)).toEqual(["a", "b", "native"]);
  });

  test("mandatory history invalidation participates in the prepared batch rather than a later publication", async () => {
    const replay = new ConversationReplay("g", "c", 256 * 1024);
    const projection = new ConversationProjection(replay);
    projection.seed([{ id: "old", type: "notice", level: "info", createdAt: 1, message: "Old" }]);
    const client = replay.handoff(cursor => cursor);
    projection.recover([{ kind: "remove", itemId: "old" }, { kind: "upsert", item: {
      id: "new", type: "notice", level: "info", createdAt: 2, message: "New",
    } }], () => true, true);
    client.subscription.cancel();
    const announced: ChatEvent[] = []; for await (const event of client.subscription) announced.push(event);
    expect(announced).toMatchObject([
      { type: "item.remove", itemId: "old", sequence: 1 },
      { type: "item.upsert", item: { id: "new" }, sequence: 2 },
      { type: "resync", reason: "conversation-rewritten", sequence: 3 },
    ]);
    expect(projection.items().map(item => item.id)).toEqual(["new"]);
  });

  test("snapshot callbacks can publish new live events without preceding their owed replay", async () => {
    const replay = new ConversationReplay("g", "c", 10_000);
    const before = replay.latestCursor();
    replay.publish({ type: "conversation.status", status: "running" });
    const client = replay.handoff(cursor => {
      replay.publish({ type: "conversation.status", status: "completed" });
      return cursor;
    }, before);
    const iterator = client.subscription[Symbol.asyncIterator]();
    expect((await next(iterator)).sequence).toBe(1);
    expect((await next(iterator)).sequence).toBe(2);
    client.subscription.cancel();
    expect(() => replay.handoff(() => { throw new Error("snapshot failed"); })).toThrow("snapshot failed");
    expect(replay.subscriberCount()).toBe(0);
  });

  test("a fitting recovery respects each subscriber's existing backlog without losing healthy ordered delivery", async () => {
    const replay = new ConversationReplay("g", "c", 2 * 1024 * 1024);
    const slow = replay.handoff(cursor => cursor);
    for (let i = 0; i < 16; i++) replay.publish({ type: "item.upsert", item: {
      id: `old:${i}`, type: "notice", createdAt: i, level: "info", message: "x".repeat(50_000),
    } });
    const healthy = replay.handoff(cursor => cursor);
    replay.prepareBatch([0, 1].map(i => ({ type: "item.upsert" as const, item: {
      id: `new:${i}`, type: "notice" as const, createdAt: i + 16, level: "info" as const, message: "y".repeat(100_000),
    } })))();
    healthy.subscription.cancel(); slow.subscription.cancel();
    const delivered = []; for await (const event of healthy.subscription) delivered.push(event);
    expect(delivered.map(event => event.sequence)).toEqual([17, 18]);
    expect(delivered.map(event => event.type)).toEqual(["item.upsert", "item.upsert"]);
    const queued = []; for await (const event of slow.subscription) queued.push(event);
    expect(queued.length).toBe(17);
    expect(queued.at(-1)).toMatchObject({ type: "resync", reason: "conversation-rewritten", sequence: 16 });
    expect(queued.filter(event => event.type === "item.upsert" && event.item.id.startsWith("new:"))).toEqual([]);
    // Native EventSource reconnects using the terminal frame's SSE id, not
    // necessarily the application's last applied data cursor.
    const terminal = queued.at(-1)!;
    const reconnect = replay.handoff(cursor => cursor, encodeReplayCursor(terminal));
    reconnect.subscription.cancel();
    const replayed = []; for await (const event of reconnect.subscription) replayed.push(event);
    expect(replayed.map(event => event.sequence)).toEqual([17, 18]);
  });

  test("hook-time snapshots remain complete and revoked admission cannot publish a candidate", () => {
    const replay = new ConversationReplay("g", "c", 10_000);
    let current = true, revoke = false;
    const snapshots: Array<{ cursor: string; ids: string[] }> = [];
    const projection = new ConversationProjection(replay, undefined, undefined, () => {
      const handoff = replay.handoff(cursor => ({ cursor, ids: projection.items().map(item => item.id) }));
      snapshots.push(handoff.snapshot); handoff.subscription.cancel();
      if (revoke) current = false;
    });
    const updates = ["a", "b"].map(id => ({ kind: "upsert" as const, item: {
      id, type: "notice" as const, level: "info" as const, createdAt: 1, message: id,
    } }));
    revoke = true;
    expect(projection.recover(updates, () => current)).toBe(false);
    expect(projection.items()).toEqual([]);
    expect(snapshots).toEqual([0, 1].map(() => ({ cursor: encodeReplayCursor({ generation: "g", sequence: 0 }), ids: [] })));
    current = true; revoke = false;
    expect(projection.recover(updates, () => current)).toBe(true);
    expect(projection.items().map(item => item.id)).toEqual(["a", "b"]);
    expect(replay.latestCursor()).toBe(encodeReplayCursor({ generation: "g", sequence: 2 }));
  });

  test("oversized projection recovery commits all rows before one resync and unchanged recovery converges", async () => {
    const replay = new ConversationReplay("g", "c", 256 * 1024);
    let expectedRows = 0, expectedSequence = 0;
    const projection = new ConversationProjection(replay, undefined, undefined, () => {
      expect(projection.items()).toHaveLength(expectedRows);
      expect(replay.latestCursor()).toBe(encodeReplayCursor({ generation: "g", sequence: expectedSequence }));
    });
    const updates = Array.from({ length: 318 }, (_, i) => ({ kind: "upsert" as const,
      item: { type: "notice" as const, id: `n:${i}`, createdAt: i, level: "info" as const, message: "x".repeat(4096) } }));
    const client = replay.handoff(cursor => cursor);
    expect(projection.recover(updates)).toBe(true);
    const iterator = client.subscription[Symbol.asyncIterator]();
    expect(await next(iterator)).toMatchObject({ type: "resync", reason: "conversation-rewritten", sequence: 1 });
    expect((await iterator.next()).done).toBe(true);
    const fresh = replay.handoff(cursor => ({ cursor, items: projection.items() }));
    expect(fresh.snapshot.items).toHaveLength(318);
    // Public equality, not a cached source-array reference, determines
    // convergence on independently materialized source rows.
    expectedRows = 318; expectedSequence = 1;
    for (let i = 0; i < 3; i++) expect(projection.recover(updates.map(update => ({ ...update, item: { ...update.item } })))).toBe(true);
    expect(replay.latestCursor()).toBe(fresh.snapshot.cursor);
    fresh.subscription.cancel();
  });

  test("a prepared recovery publishes ordered data only after commit and empty recovery keeps its cursor", async () => {
    const replay = new ConversationReplay("g", "c", 10_000);
    const before = replay.latestCursor();
    const client = replay.handoff(cursor => cursor);
    const prepared = replay.prepareBatch([
      { type: "conversation.status", status: "running" },
      { type: "conversation.status", status: "completed" },
    ]);
    expect(replay.latestCursor()).toBe(before);
    prepared();
    const iterator = client.subscription[Symbol.asyncIterator]();
    expect(await next(iterator)).toMatchObject({ sequence: 1, status: "running" });
    expect(await next(iterator)).toMatchObject({ sequence: 2, status: "completed" });
    const after = replay.latestCursor();
    replay.prepareBatch([])();
    expect(replay.latestCursor()).toBe(after);
    client.subscription.cancel();
  });

  test("oversized recovery emits one explicit resync with no partial prefix and replay resumes after its snapshot", async () => {
    const replay = new ConversationReplay("g", "c", 256 * 1024);
    const before = replay.latestCursor();
    const client = replay.handoff(cursor => cursor);
    replay.prepareBatch(Array.from({ length: 318 }, (_, i) => ({ type: "item.upsert" as const,
      item: { id: `notice:${i}`, type: "notice" as const, createdAt: i, level: "info" as const, message: "x".repeat(4096) } })))();
    client.subscription.cancel();
    const delivered = [];
    for await (const event of client.subscription) delivered.push(event);
    expect(delivered).toMatchObject([{ type: "resync", reason: "conversation-rewritten", sequence: 1 }]);
    const behind = replay.handoff(cursor => cursor, before);
    expect(await next(behind.subscription[Symbol.asyncIterator]())).toMatchObject({ type: "resync", sequence: 1 });
    const fresh = replay.handoff(cursor => cursor, replay.latestCursor());
    replay.publish({ type: "conversation.status", status: "completed" });
    expect(await next(fresh.subscription[Symbol.asyncIterator]())).toMatchObject({ type: "conversation.status", sequence: 2 });
    behind.subscription.cancel(); fresh.subscription.cancel();
  });

  test("failed preparation and superseded publication cannot advance replay or strand later recovery", async () => {
    const replay = new ConversationReplay("g", "c", 10_000);
    const before = replay.latestCursor();
    function* broken() { yield { type: "conversation.status" as const, status: "running" as const }; throw new Error("prepare failed"); }
    expect(() => replay.prepareBatch(broken())).toThrow("prepare failed");
    expect(replay.latestCursor()).toBe(before);
    const stale = replay.prepareBatch([{ type: "conversation.status", status: "running" }]);
    replay.publish({ type: "conversation.status", status: "completed" });
    expect(() => stale()).toThrow("superseded");
    expect(replay.latestCursor()).toBe(encodeReplayCursor({ generation: "g", sequence: 1 }));
    replay.prepareBatch([{ type: "conversation.status", status: "idle" }])();
    expect(replay.latestCursor()).toBe(encodeReplayCursor({ generation: "g", sequence: 2 }));
  });

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
