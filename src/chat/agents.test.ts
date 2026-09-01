import { describe, expect, test } from "bun:test";

import { MultiAgentChatService, parseQualifiedConversationId, qualifyConversationId, UnknownAgentError, type RegisteredChatAgent } from "./agents";
import { ConversationInventoryBroadcaster } from "./inventory-broadcaster";
import { ReplaySubscription } from "./replay";
import type { WorkspaceChatService } from "./service";
import { ConversationNotFoundError } from "./workspace";
import type { ChatAvailability, ChatEvent, ConversationSnapshot, ConversationSummary } from "./types";

function summary(id: string, updatedAt = 1): ConversationSummary {
  return { id, title: `Conversation ${id}`, createdAt: updatedAt, updatedAt, status: "idle" };
}

function snapshot(id: string): ConversationSnapshot {
  return {
    conversation: summary(id),
    configuration: {},
    generation: "g1",
    cursor: "c0",
    items: [],
  };
}

class StubAgentService implements WorkspaceChatService {
  calls: Array<{ method: string; args: unknown[] }> = [];
  availability: ChatAvailability = { state: "ready", version: "1.0.0" };
  conversations: ConversationSummary[] = [];
  inventory = new ConversationInventoryBroadcaster();
  replay: ReplaySubscription | null = null;

  private record<T>(method: string, args: unknown[], value: T): Promise<T> {
    this.calls.push({ method, args });
    return Promise.resolve(value);
  }

  async status() { return this.availability; }
  async retry() { this.calls.push({ method: "retry", args: [] }); return this.availability; }
  async models() { return this.record("models", [], []); }
  async modes() { return this.record("modes", [], []); }
  async commands() { return this.record("commands", [], []); }
  async listConversations() { return this.conversations; }
  async subscribeInventory(options: { signal?: AbortSignal } = {}) { return this.inventory.subscribe(options.signal); }
  async createConversation() { return this.record("createConversation", [], snapshot("created")); }
  async history(id: string, options?: unknown) { return this.record("history", [id, options], snapshot(id)); }
  async subscribe(id: string) {
    this.calls.push({ method: "subscribe", args: [id] });
    this.replay = new ReplaySubscription(() => undefined);
    return { snapshot: snapshot(id), events: this.replay };
  }
  async prompt(id: string, requestId: string, text: string) {
    return this.record("prompt", [id, requestId, text], {
      messageId: "msg-1",
      held: false,
      configuration: {},
      conversation: summary(id),
    });
  }
  async removeQueued(id: string, messageId: string) { return this.record("removeQueued", [id, messageId], { removed: true as const }); }
  async saveAttachment(): Promise<{ id: string; mimeType: string; sizeBytes: number }> { throw new Error("unused: the router owns the store"); }
  async resolveAttachment(): Promise<null> { throw new Error("unused: the router owns the store"); }
  async renameConversation(id: string, _requestId: string, title: string) {
    return this.record("renameConversation", [id, title], { conversation: { ...summary(id), title } });
  }
  async cancel(id: string) { return this.record("cancel", [id], { cancelled: true as const }); }
  async undo(id: string) { return this.record("undo", [id], { outcome: "changed" as const, state: { staged: false, canUndo: false, canRedo: false, revertedMessages: [] } }); }
  async redo(id: string) { return this.record("redo", [id], { outcome: "changed" as const, state: { staged: false, canUndo: false, canRedo: false, revertedMessages: [] } }); }
  async revert(id: string, messageId: string) { return this.record("revert", [id, messageId], { outcome: "changed" as const, state: { staged: false, canUndo: false, canRedo: false, revertedMessages: [] } }); }
  async restore(id: string, messageId: string) { return this.record("restore", [id, messageId], { outcome: "changed" as const, state: { staged: false, canUndo: false, canRedo: false, revertedMessages: [] } }); }
  async respondPermission(id: string, interactionId: string) {
    return this.record("respondPermission", [id, interactionId], { outcome: "approved-once" as const });
  }
  async respondQuestion(id: string, interactionId: string) {
    return this.record("respondQuestion", [id, interactionId], { outcome: { kind: "rejected" as const } });
  }
  async dispose() { this.calls.push({ method: "dispose", args: [] }); }
}

function fixture(): { service: MultiAgentChatService; a: StubAgentService; b: StubAgentService } {
  const a = new StubAgentService();
  const b = new StubAgentService();
  const agents: RegisteredChatAgent[] = [
    { descriptor: { id: "opencode", name: "OpenCode" }, service: a },
    { descriptor: { id: "claude", name: "Claude Code" }, service: b },
  ];
  return { service: new MultiAgentChatService({ workspacePath: process.cwd(), agents }), a, b };
}

describe("qualified conversation ids", () => {
  test("qualify and parse round-trip, provider ids pass through untouched", () => {
    const qualified = qualifyConversationId("claude", "ses_abc:with:colons");
    expect(qualified).toBe("claude:ses_abc:with:colons");
    expect(parseQualifiedConversationId(qualified)).toEqual({ agentId: "claude", conversationId: "ses_abc:with:colons" });
  });

  test("an unqualified or empty-sided id parses to nothing", () => {
    expect(parseQualifiedConversationId("bare-id")).toBeNull();
    expect(parseQualifiedConversationId(":x")).toBeNull();
    expect(parseQualifiedConversationId("agent:")).toBeNull();
  });

  test("agent ids with colons are rejected at registration", () => {
    expect(() => new MultiAgentChatService({
      workspacePath: process.cwd(),
      agents: [{ descriptor: { id: "a:b", name: "Bad" }, service: new StubAgentService() }],
    })).toThrow('agent id must not contain ":"');
  });
});

describe("routing", () => {
  test("conversation mutations reach the owning agent with the bare id", async () => {
    const { service, a, b } = fixture();
    const accepted = await service.prompt("claude:ses_1", "r1", "hello");
    expect(b.calls).toEqual([{ method: "prompt", args: ["ses_1", "r1", "hello"] }]);
    expect(a.calls).toEqual([]);
    // The result's conversation is re-qualified and attributed.
    expect(accepted.conversation).toEqual(expect.objectContaining({
      id: "claude:ses_1",
      agent: { id: "claude", name: "Claude Code" },
    }));
  });

  test("an unknown agent prefix or a bare id is rejected before reaching any agent", async () => {
    const { service, a, b } = fixture();
    await expect(service.history("codex:ses_1")).rejects.toBeInstanceOf(ConversationNotFoundError);
    await expect(service.history("ses_1")).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual([]);
  });

  test("creation defaults to the first registered agent and honors an explicit choice", async () => {
    const { service, a, b } = fixture();
    const defaulted = await service.createConversation();
    expect(defaulted.conversation.agent.id).toBe("opencode");
    expect(defaulted.conversation.id).toBe("opencode:created");
    const chosen = await service.createConversation("claude");
    expect(chosen.conversation.agent.id).toBe("claude");
    expect(a.calls.filter(call => call.method === "createConversation")).toHaveLength(1);
    expect(b.calls.filter(call => call.method === "createConversation")).toHaveLength(1);
    await expect(service.createConversation("codex")).rejects.toBeInstanceOf(UnknownAgentError);
  });

  test("catalog reads are agent-scoped", async () => {
    const { service, a, b } = fixture();
    await service.models("claude");
    await service.modes("opencode");
    expect(b.calls).toEqual([{ method: "models", args: [] }]);
    expect(a.calls).toEqual([{ method: "modes", args: [] }]);
    await expect(service.commands("codex")).rejects.toBeInstanceOf(UnknownAgentError);
  });
});

describe("status and retry", () => {
  test("status fans out per agent and attributes a failure to its agent alone", async () => {
    const { service, b } = fixture();
    b.status = async () => { throw new Error("probe exploded"); };
    const statuses = await service.status();
    expect(statuses).toEqual([
      { agent: { id: "opencode", name: "OpenCode" }, availability: { state: "ready", version: "1.0.0" } },
      { agent: { id: "claude", name: "Claude Code" }, availability: { state: "unavailable", reason: "startup-failed", message: "probe exploded" } },
    ]);
  });

  test("retry touches only the named agent", async () => {
    const { service, a, b } = fixture();
    const status = await service.retry("claude");
    expect(status.agent.id).toBe("claude");
    expect(b.calls).toEqual([{ method: "retry", args: [] }]);
    expect(a.calls).toEqual([]);
  });
});

describe("inventory", () => {
  test("conversations merge across agents, newest first, each attributed", async () => {
    const { service, a, b } = fixture();
    a.conversations = [summary("old", 1)];
    b.conversations = [summary("new", 5)];
    expect(await service.listConversations()).toEqual([
      expect.objectContaining({ id: "claude:new", agent: { id: "claude", name: "Claude Code" } }),
      expect.objectContaining({ id: "opencode:old", agent: { id: "opencode", name: "OpenCode" } }),
    ]);
  });

  test("identical provider ids from different agents do not collide", async () => {
    const { service, a, b } = fixture();
    a.conversations = [summary("same", 2)];
    b.conversations = [summary("same", 1)];
    const ids = (await service.listConversations()).map(conversation => conversation.id);
    expect(ids).toEqual(["opencode:same", "claude:same"]);
  });

  test("a failing agent does not empty the chooser", async () => {
    const { service, a, b } = fixture();
    a.conversations = [summary("kept", 3)];
    b.listConversations = async () => { throw new Error("enumeration failed"); };
    expect((await service.listConversations()).map(conversation => conversation.id)).toEqual(["opencode:kept"]);
  });

  test("either agent's inventory tick surfaces on the merged subscription", async () => {
    const { service, a, b } = fixture();
    const subscription = await service.subscribeInventory();
    // Both broadcasters start with a pending bit; drain it first.
    await subscription.next();
    const tick = subscription.next();
    b.inventory.invalidate();
    expect(await tick).toEqual({ value: undefined, done: false });
    const second = subscription.next();
    a.inventory.invalidate();
    expect(await second).toEqual({ value: undefined, done: false });
    subscription.cancel();
    expect(a.inventory.subscriberCount()).toBe(0);
    expect(b.inventory.subscriberCount()).toBe(0);
  });
});

describe("qualification of snapshots and events", () => {
  test("snapshot items carry qualified interaction and child conversation ids", async () => {
    const { service, b } = fixture();
    const base = snapshot("parent");
    b.history = async () => ({
      ...base,
      items: [
        { id: "permission:p1", type: "permission", createdAt: 1, requestId: "p1", conversationId: "child", action: "edit", resources: [], status: "pending" },
        { id: "tool:t1", type: "tool", createdAt: 2, name: "task", status: "running", childConversationId: "child" },
      ],
    });
    const qualified = await service.history("claude:parent");
    expect(qualified.conversation.id).toBe("claude:parent");
    expect(qualified.items[0]).toEqual(expect.objectContaining({ conversationId: "claude:child" }));
    expect(qualified.items[1]).toEqual(expect.objectContaining({ childConversationId: "claude:child" }));
  });

  test("subscribed events are re-qualified, including embedded summaries", async () => {
    const { service, b } = fixture();
    const { events } = await service.subscribe("claude:ses_1");
    const received: ChatEvent[] = [];
    const consume = (async () => {
      for (const _ of [1, 2]) {
        for await (const event of events) { received.push(event); break; }
      }
    })();
    b.replay!.push({ generation: "g1", sequence: 1, conversationId: "ses_1", type: "conversation.updated", conversation: summary("ses_1") });
    b.replay!.push({ generation: "g1", sequence: 2, conversationId: "ses_1", type: "item.upsert", item: { id: "tool:t1", type: "tool", createdAt: 1, name: "task", status: "running", childConversationId: "kid" } });
    await consume;
    expect(received[0]).toEqual(expect.objectContaining({
      conversationId: "claude:ses_1",
      conversation: expect.objectContaining({ id: "claude:ses_1", agent: { id: "claude", name: "Claude Code" } }),
    }));
    expect(received[1]).toEqual(expect.objectContaining({
      conversationId: "claude:ses_1",
      item: expect.objectContaining({ childConversationId: "claude:kid" }),
    }));
  });

  test("cancelling the qualified subscription cancels the source", async () => {
    const { service, b } = fixture();
    const { events } = await service.subscribe("opencode:ses_1", undefined);
    void b; // agent a owns this one
    events.cancel();
    // Push after cancel is a no-op on the source; iteration ends immediately.
    const iterator = events[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });
});

describe("lifecycle", () => {
  test("dispose disposes every agent even when one fails", async () => {
    const { service, a, b } = fixture();
    a.dispose = async () => { a.calls.push({ method: "dispose", args: [] }); throw new Error("dispose failed"); };
    await service.dispose();
    expect(a.calls).toEqual([{ method: "dispose", args: [] }]);
    expect(b.calls).toEqual([{ method: "dispose", args: [] }]);
  });
});
