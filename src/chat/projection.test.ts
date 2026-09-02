import { describe, expect, test } from "bun:test";
import type { ChatEvent, ConversationSnapshot } from "./types";
import { ConversationProjection } from "./adapter";
import { addAcceptedDraft, applyChatEvent, dropQueuedMessage, noteQueuedMessage, prependSnapshot, projectionFromSnapshot } from "./projection";
import { ConversationReplay } from "./replay";

const snapshot = (items: ConversationSnapshot["items"] = []): ConversationSnapshot => ({
  conversation: { id: "c1", title: "Chat", createdAt: 1, updatedAt: 1, status: "running" },
  configuration: {},
  generation: "g1",
  cursor: Buffer.from(JSON.stringify({ v: 1, g: "g1", s: 4 })).toString("base64url"),
  items,
  olderCursor: "older",
});

describe("chat projection", () => {
  test("upserts by identity, ignores duplicates, and rejects sequence gaps", () => {
    const initial = projectionFromSnapshot(snapshot());
    const event: ChatEvent & { type: "item.upsert" } = { generation: "g1", sequence: 5, conversationId: "c1", type: "item.upsert", item: { id: "a1", type: "assistant_message", createdAt: 2, markdown: "one" } };
    const applied = applyChatEvent(initial, event);
    expect(applied.outcome).toBe("applied");
    expect(applyChatEvent(applied.projection, event).outcome).toBe("duplicate");
    expect(applyChatEvent(applied.projection, { ...event, sequence: 7 }).outcome).toBe("gap");
    const updated = applyChatEvent(applied.projection, { generation: "g1", sequence: 6, conversationId: "c1", type: "item.upsert", item: { id: "a1", type: "assistant_message", createdAt: 2, markdown: "two" } });
    expect(updated.projection.items).toHaveLength(1);
    expect(updated.projection.items[0]).toMatchObject({ markdown: "two" });
  });

  test("retains accepted drafts until the matching user identity appears", () => {
    let state = addAcceptedDraft(projectionFromSnapshot(snapshot()), { requestId: "request", messageId: "message", text: "hello" });
    expect(state.acceptedDrafts).toHaveLength(1);
    const result = applyChatEvent(state, { generation: "g1", sequence: 5, conversationId: "c1", type: "item.upsert", item: { id: "message", type: "user_message", createdAt: 2, text: "hello", requestId: "request" } });
    expect(result.projection.acceptedDrafts).toEqual([]);
  });

  test("does not add an accepted marker after the matching message arrived first", () => {
    const state = projectionFromSnapshot(snapshot([
      { id: "message:msg_provider", type: "user_message", createdAt: 2, text: "hello" },
    ]));
    expect(addAcceptedDraft(state, { requestId: "request", messageId: "msg_provider", text: "hello" }).acceptedDrafts).toEqual([]);
  });

  test("tracks the held queue from the snapshot and queue events", () => {
    const initial = projectionFromSnapshot({ ...snapshot(), queued: [{ id: "held-1", text: "waiting", queuedAt: 2 }] });
    expect(initial.queued).toEqual([{ id: "held-1", text: "waiting", queuedAt: 2 }]);
    // Every queue event restates the whole queue; a removal converges to it.
    const removed = applyChatEvent(initial, {
      generation: "g1", sequence: 5, conversationId: "c1", type: "conversation.queue",
      queued: [], change: { kind: "removed", messageId: "held-1" },
    });
    expect(removed.outcome).toBe("applied");
    expect(removed.projection.queued).toEqual([]);
  });

  test("a held echo stands down once the stream has spoken since the submission", () => {
    const base = projectionFromSnapshot(snapshot());
    // A delivery event outruns the acceptance: the queue event lands first
    // (advancing the revision) and the delivered item is already a timeline
    // entry when the response resolves. The echo must not resurrect it.
    const withDrafts = addAcceptedDraft(base, { requestId: "r1", messageId: "pending:r1", text: "fast" });
    const revisionAtSubmit = withDrafts.queueRevision;
    const heldEvent = applyChatEvent(withDrafts, {
      generation: "g1", sequence: 5, conversationId: "c1", type: "conversation.queue",
      queued: [{ id: "held-1", text: "fast", queuedAt: 2, requestId: "r1" }], change: { kind: "held", messageId: "held-1" },
    });
    const deliveredItem = applyChatEvent(heldEvent.projection, {
      generation: "g1", sequence: 6, conversationId: "c1", type: "item.upsert",
      item: { id: "message:m1", type: "user_message", createdAt: 3, text: "fast", requestId: "r1" },
    });
    const deliveredEvent = applyChatEvent(deliveredItem.projection, {
      generation: "g1", sequence: 7, conversationId: "c1", type: "conversation.queue",
      queued: [], change: { kind: "delivered", messageId: "held-1" },
    });
    expect(deliveredEvent.projection.queueRevision).toBe(revisionAtSubmit + 2);
    const echoed = noteQueuedMessage(deliveredEvent.projection, { id: "held-1", text: "fast", queuedAt: 2, requestId: "r1" }, revisionAtSubmit);
    expect(echoed.queued).toEqual([]);
    expect(echoed.acceptedDrafts).toEqual([]);

    // A retried acceptance answered after delivery (fresh projection, no
    // queue event seen) is caught by the delivered timeline item instead.
    const reloaded = projectionFromSnapshot(snapshot([
      { id: "message:m1", type: "user_message", createdAt: 3, text: "fast", requestId: "r1" },
    ]));
    const retried = noteQueuedMessage(reloaded, { id: "held-1", text: "fast", queuedAt: 2, requestId: "r1" });
    expect(retried.queued).toEqual([]);
  });

  test("a refused removal drops the stale local entry and is a no-op otherwise", () => {
    const state = projectionFromSnapshot({ ...snapshot(), queued: [{ id: "held-1", text: "waiting", queuedAt: 2 }] });
    const dropped = dropQueuedMessage(state, "held-1");
    expect(dropped.queued).toEqual([]);
    // Unknown ids leave the projection untouched — same object, no render.
    expect(dropQueuedMessage(dropped, "held-1")).toBe(dropped);
  });

  test("a draft the server now holds is represented once, by its queued entry", () => {
    // The held acceptance mirrors locally before any stream event arrives.
    let state = addAcceptedDraft(projectionFromSnapshot(snapshot()), { requestId: "r1", messageId: "pending:r1", text: "hello" });
    state = noteQueuedMessage(state, { id: "held-1", text: "hello", queuedAt: 2, requestId: "r1" });
    expect(state.queued.map(held => held.id)).toEqual(["held-1"]);
    expect(state.acceptedDrafts).toEqual([]);

    // The same handoff works when the queue event beats the acceptance.
    let raced = addAcceptedDraft(projectionFromSnapshot(snapshot()), { requestId: "r2", messageId: "pending:r2", text: "again" });
    const applied = applyChatEvent(raced, {
      generation: "g1", sequence: 5, conversationId: "c1", type: "conversation.queue",
      queued: [{ id: "held-2", text: "again", queuedAt: 3, requestId: "r2" }], change: { kind: "held", messageId: "held-2" },
    });
    expect(applied.projection.queued).toHaveLength(1);
    expect(applied.projection.acceptedDrafts).toEqual([]);
  });

  test("a late upsert for an earlier moment takes its snapshot position", () => {
    const initial = projectionFromSnapshot(snapshot([
      { id: "message:u1", type: "user_message", createdAt: 10, text: "ask" },
      { id: "part:a1", type: "assistant_message", createdAt: 20, markdown: "answer" },
    ]));
    // A recovered request created between the two items must not render at
    // the end of the timeline just because it arrived last.
    const recovered = applyChatEvent(initial, {
      generation: "g1", sequence: 5, conversationId: "c1", type: "item.upsert",
      item: { id: "permission:p1", type: "permission", createdAt: 15, requestId: "p1", action: "edit", resources: ["file.ts"], status: "pending" },
    });
    expect(recovered.projection.items.map(item => item.id)).toEqual(["message:u1", "permission:p1", "part:a1"]);
    // Equal timestamps keep arrival order — which matches the provider's
    // part order only when parts arrive in order; a snapshot reload restores
    // the exact order otherwise.
    const tied = applyChatEvent(recovered.projection, {
      generation: "g1", sequence: 6, conversationId: "c1", type: "item.upsert",
      item: { id: "part:a2", type: "assistant_message", createdAt: 20, markdown: "more" },
    });
    expect(tied.projection.items.map(item => item.id)).toEqual(["message:u1", "permission:p1", "part:a1", "part:a2"]);
  });

  test("prepends older pages without duplicate identities", () => {
    const current = projectionFromSnapshot(snapshot([{ id: "new", type: "user_message", createdAt: 2, text: "new" }]));
    const page = snapshot([{ id: "old", type: "user_message", createdAt: 1, text: "old" }, { id: "new", type: "user_message", createdAt: 2, text: "new" }]);
    expect(prependSnapshot(current, page).items.map(item => item.id)).toEqual(["old", "new"]);
  });

  test("authoritative replacement removes a suffix and resets text reconciliation", () => {
    const server = new ConversationProjection(new ConversationReplay("g1", "c1", 10_000));
    server.seed([
      { id: "part:answer", type: "assistant_message", createdAt: 1, markdown: "kept discarded" },
      { id: "message:discarded", type: "user_message", createdAt: 2, text: "discarded turn" },
    ]);

    const event = server.replace([
      { id: "part:answer", type: "assistant_message", createdAt: 1, markdown: "kept" },
    ]);
    server.apply({ kind: "text", itemId: "part:answer", identity: "answer", mode: "incremental", text: " fresh" });

    expect(event).toEqual(expect.objectContaining({ type: "resync", reason: "conversation-rewritten" }));
    expect(server.items()).toEqual([
      expect.objectContaining({ id: "part:answer", markdown: "kept fresh" }),
    ]);
  });

  test("removing a streamed item forgets its reconciled text", () => {
    const server = new ConversationProjection(new ConversationReplay("g1", "c1", 10_000));
    const id = "message:stream:m1:0";
    const item = { id, type: "assistant_message" as const, createdAt: 1, markdown: "" };
    server.apply({ kind: "text", itemId: id, identity: id, mode: "incremental", text: "Hello", item });
    server.apply({ kind: "remove", itemId: id });
    // The same identity later is a fresh stream, not a continuation.
    server.apply({ kind: "text", itemId: id, identity: id, mode: "incremental", text: "Again", item });
    expect(server.items()).toEqual([expect.objectContaining({ id, markdown: "Again" })]);
  });

  test("projects configuration and conversation updates in sequence", () => {
    const initial = projectionFromSnapshot({
      ...snapshot(),
      configuration: { model: { providerId: "anthropic", modelId: "claude" }, mode: "plan" },
    });
    const configured = applyChatEvent(initial, {
      generation: "g1", sequence: 5, conversationId: "c1", type: "conversation.configuration",
      configuration: { model: { providerId: "openai", modelId: "gpt" }, mode: "build" },
    });
    expect(configured.projection.configuration).toEqual({ model: { providerId: "openai", modelId: "gpt" }, mode: "build" });
    // Configuration events count, like queue events, so an acceptance's
    // committed configuration can tell whether the stream outran it.
    expect(initial.configurationRevision).toBe(0);
    expect(configured.projection.configurationRevision).toBe(1);
    const renamed = applyChatEvent(configured.projection, {
      generation: "g1", sequence: 6, conversationId: "c1", type: "conversation.updated",
      conversation: { ...snapshot().conversation, title: "Renamed" },
    });
    expect(renamed.projection.conversation?.title).toBe("Renamed");
    expect(renamed.projection.configurationRevision).toBe(1);
  });
});

describe("sparse user-message updates preserve attachments", () => {
  test("an upsert that omits attachments keeps the existing references", () => {
    const attachments = [{ id: "11111111-2222-4333-8444-555555555555", name: "shot.png", mimeType: "image/png" }];
    const initial = projectionFromSnapshot(snapshot([
      { id: "message:m1", type: "user_message", createdAt: 2, text: "look", requestId: "r1", attachments },
    ]));
    const sparse = applyChatEvent(initial, {
      generation: "g1", sequence: 5, conversationId: "c1", type: "item.upsert",
      item: { id: "message:m1", type: "user_message", createdAt: 2, text: "look" },
    });
    expect(sparse.projection.items[0]).toMatchObject({ text: "look", requestId: "r1", attachments });

    const replaced = [{ id: "22222222-2222-4333-8444-555555555555", name: "other.png", mimeType: "image/webp" }];
    const authoritative = applyChatEvent(sparse.projection, {
      generation: "g1", sequence: 6, conversationId: "c1", type: "item.upsert",
      item: { id: "message:m1", type: "user_message", createdAt: 2, text: "look", attachments: replaced },
    });
    expect(authoritative.projection.items[0]).toMatchObject({ attachments: replaced });
  });
});
