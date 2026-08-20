import { describe, expect, test } from "bun:test";
import type { ChatEvent, ConversationSnapshot } from "./types";
import { addAcceptedDraft, applyChatEvent, prependSnapshot, projectionFromSnapshot } from "./projection";

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

  test("prepends older pages without duplicate identities", () => {
    const current = projectionFromSnapshot(snapshot([{ id: "new", type: "user_message", createdAt: 2, text: "new" }]));
    const page = snapshot([{ id: "old", type: "user_message", createdAt: 1, text: "old" }, { id: "new", type: "user_message", createdAt: 2, text: "new" }]);
    expect(prependSnapshot(current, page).items.map(item => item.id)).toEqual(["old", "new"]);
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
    const renamed = applyChatEvent(configured.projection, {
      generation: "g1", sequence: 6, conversationId: "c1", type: "conversation.updated",
      conversation: { ...snapshot().conversation, title: "Renamed" },
    });
    expect(renamed.projection.conversation?.title).toBe("Renamed");
  });
});
