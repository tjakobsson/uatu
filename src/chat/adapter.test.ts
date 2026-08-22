import { describe, expect, test } from "bun:test";

import { ChatQueueFullError, ConversationRenameUnsupportedError, deriveConversationTitle, InteractionConflictError, InvalidConversationTitleError, InvalidModeSelectionError, InvalidModelSelectionError, InvalidVariantSelectionError, OpenCodeChatAdapter, parseSlashCommand, QueuedMessageNotHeldError } from "./adapter";
import { normalizeProviderEvent } from "./normalization";
import type { ChatAgent } from "./types";
import type {
  OpenCodeProvider,
  ProviderEvent,
  ProviderMessage,
  ProviderPage,
  ProviderPermissionReply,
  ProviderSession,
} from "./provider";
import { UnsupportedVariantSelectionError } from "./provider";
import type { ChatEvent, ChatModel, ConversationItem, ModelSelection } from "./types";
import { ConversationNotFoundError } from "./workspace";
import { MetricsRegistry } from "../debug/metrics";

class EventQueue implements AsyncIterable<ProviderEvent> {
  private values: ProviderEvent[] = [];
  private waiters: Array<(result: IteratorResult<ProviderEvent>) => void> = [];
  private closed = false;

  push(event: ProviderEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.values.push(event);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => this.waiters.push(resolve));
      },
    };
  }
}

class FakeProvider implements OpenCodeProvider {
  // A fake declares less than OpenCode on purpose: it is the only thing in
  // the suite that can exercise a surface whose agent is missing a capability.
  agent: ChatAgent = { id: "fake", name: "Fake Agent", capabilities: ["models", "commands", "permissions"] };
  describe(): ChatAgent { return this.agent; }
  commands = [
    { name: "review", description: "Review", argumentHint: "[focus]", kind: "command" as const },
    { name: "compact", description: "Compact", argumentHint: "", kind: "command" as const },
  ];
  models: ChatModel[] = [{ selection: { providerId: "anthropic", modelId: "claude" }, provider: "Anthropic", name: "Claude" }];
  sessions: ProviderSession[] = [];
  pages = new Map<string, ProviderPage<ProviderMessage>>();
  eventQueue = new EventQueue();
  prompts: Array<{ sessionId: string; id: string; text: string; delivery: "queue"; mode?: string; variant?: string }> = [];
  commandCalls: Array<{ sessionId: string; id: string; name: string; arguments: string; model?: ModelSelection }> = [];
  permissionReplies: Array<{ sessionId: string; requestId: string; reply: ProviderPermissionReply }> = [];
  questionReplies: Array<{ sessionId: string; requestId: string; answers?: string[][]; rejected?: true }> = [];
  interrupts: string[] = [];
  modelSwitches: Array<{ sessionId: string; selection: ModelSelection }> = [];
  renameSession?: OpenCodeProvider["renameSession"];
  listPermissions?: OpenCodeProvider["listPermissions"];
  listQuestions?: OpenCodeProvider["listQuestions"];
  listModes?: OpenCodeProvider["listModes"];
  configurations = new Map<string, import("./types").ConversationConfiguration>();
  newConfiguration: import("./types").ConversationConfiguration = {};

  async listCommands() { return this.commands; }
  async listModels() { return this.models; }
  async switchModel(sessionId: string, selection: ModelSelection) { this.modelSwitches.push({ sessionId, selection }); }

  async listSessions() { return this.sessions; }
  async newConversationConfiguration() { return this.newConfiguration; }
  async createSession(id: string, configuration = {}) {
    const session = fixtureSession(id, process.cwd(), this.sessions.length + 1);
    this.sessions.push(session);
    this.configurations.set(id, configuration);
    return session;
  }
  async getSession(id: string) { return this.sessions.find(session => session.id === id) ?? null; }
  async getConversationConfiguration(id: string, _completeMessages?: ProviderMessage[]) { return this.configurations.get(id) ?? {}; }
  async listMessages(_sessionId: string, options: { cursor?: string; limit: number }) {
    return this.pages.get(options.cursor ?? "first") ?? { items: [] };
  }
  events(signal: AbortSignal): AsyncIterable<ProviderEvent> {
    signal.addEventListener("abort", () => this.eventQueue.close(), { once: true });
    return this.eventQueue;
  }
  async prompt(sessionId: string, input: { id: string; text: string; delivery: "queue"; mode?: string; variant?: string }) {
    this.prompts.push({ sessionId, ...input });
    return { messageId: input.id };
  }
  async command(sessionId: string, input: { id: string; name: string; arguments: string; model?: ModelSelection }) {
    this.commandCalls.push({ sessionId, ...input });
    return { messageId: input.id };
  }
  async interrupt(sessionId: string) { this.interrupts.push(sessionId); }
  async replyPermission(sessionId: string, requestId: string, reply: ProviderPermissionReply) {
    this.permissionReplies.push({ sessionId, requestId, reply });
  }
  async replyQuestion(sessionId: string, requestId: string, answers: string[][]) {
    this.questionReplies.push({ sessionId, requestId, answers });
  }
  async rejectQuestion(sessionId: string, requestId: string) {
    this.questionReplies.push({ sessionId, requestId, rejected: true });
  }
}

function fixtureSession(id: string, directory = process.cwd(), updatedAt = 1): ProviderSession {
  return { id, title: `Conversation ${id}`, directory, createdAt: updatedAt, updatedAt };
}

function sumInput(item: ConversationItem | undefined): number | undefined {
  return item?.type === "tool" ? item.usage?.input : undefined;
}

function applyEvent(adapter: OpenCodeChatAdapter, conversationId: string, event: ProviderEvent): void {
  for (const update of normalizeProviderEvent(event).updates) adapter.projectionForTests(conversationId).apply(update);
}

describe("OpenCode conversation inventory and history", () => {
  test("repairs a persisted default title from its first user message", async () => {
    const provider = new FakeProvider();
    provider.sessions = [{ ...fixtureSession("session"), title: "New session - 2026-08-15T12:00:00Z" }];
    provider.pages.set("first", { items: [
      { id: "assistant", type: "assistant", time: { created: 2 }, text: "Answer" },
      { id: "first", type: "user", time: { created: 1 }, text: "Investigate authenticated model discovery" },
    ] });
    provider.renameSession = async (id, title) => {
      const renamed = { ...provider.sessions.find(session => session.id === id)!, title };
      provider.sessions[0] = renamed;
      return renamed;
    };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd() });

    expect((await adapter.listConversations())[0]?.title).toBe("Investigate authenticated model discovery");
  });

  test("repairs a persisted default title from before the newest message page", async () => {
    const provider = new FakeProvider();
    provider.sessions = [{ ...fixtureSession("session"), title: "New session - 2026-08-15T12:00:00Z" }];
    const first = { id: "first", type: "user", time: { created: 1 }, text: "Name the conversation from this prompt" };
    const later = { id: "later", type: "user", time: { created: 101 }, text: "Do not use this later prompt" };
    provider.pages.set("first", { items: [later], configurationItems: [first, later] });
    provider.renameSession = async (id, title) => {
      const renamed = { ...provider.sessions.find(session => session.id === id)!, title };
      provider.sessions[0] = renamed;
      return renamed;
    };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd() });

    expect((await adapter.listConversations())[0]?.title).toBe("Name the conversation from this prompt");
  });


  test("subagent child sessions stay out of the conversation list", async () => {
    const provider = new FakeProvider();
    provider.sessions = [
      fixtureSession("parent", process.cwd(), 2),
      { ...fixtureSession("child", process.cwd(), 3), parentId: "parent" },
    ];
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd() });

    const conversations = await adapter.listConversations();
    expect(conversations.map(conversation => conversation.id)).toEqual(["parent"]);
    // The child stays reachable directly — it is hidden, not gone.
    await expect(adapter.history("child")).resolves.toBeDefined();
  });

  test("replay preserves provider part order when timestamps tie", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    provider.pages.set("first", { items: [{
      info: { id: "msg", role: "assistant", time: { created: 5 } },
      parts: [
        { id: "prt_z", type: "reasoning", text: "why", time: { start: 900, end: 950 } },
        { id: "prt_a", type: "text", text: "answer" },
      ],
    }] });
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd() });

    const snapshot = await adapter.history("session");
    // Alphabetical ids and later part-level times would both reorder this;
    // the provider emitted reasoning first, so replay shows reasoning first.
    expect(snapshot.items.map(item => item.type)).toEqual(["reasoning", "assistant_message"]);
  });

  test("an event landing during the history read is replayable from the snapshot cursor", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();
    // The pump publishes while listMessages is in flight — the torn-snapshot
    // window: the update reaches the replay log but not the items history()
    // is assembling.
    provider.listMessages = async () => {
      provider.eventQueue.push({ id: "during", type: "session.next.text.delta", data: { sessionID: "local", partID: "p", delta: "missed" } });
      await Bun.sleep(10);
      return { items: [] };
    };

    const snapshot = await adapter.history("local");
    expect(snapshot.items).toEqual([]);
    // Wait until the pump event is fully published, so nothing can arrive
    // "live" after the handoff and mask a cursor that acknowledged too much.
    while (adapter.projectionForTests("local").items().length === 0) await Bun.sleep(1);

    // The SSE route forwards only replayed events, not the handoff snapshot —
    // a cursor taken after the read would acknowledge the event and lose it.
    const { events } = await adapter.subscribe("local", { cursor: snapshot.cursor });
    const iterator = events[Symbol.asyncIterator]();
    const first = await Promise.race([iterator.next(), Bun.sleep(500).then(() => "timeout" as const)]);
    expect(first).not.toBe("timeout");
    expect(JSON.stringify((first as IteratorResult<unknown>).value)).toContain("missed");
    events.cancel();

    await adapter.stopEventPump();
    await pump;
  });

  test("pending questions from the provider join the snapshot as answerable items", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    provider.pages.set("first", { items: [] });
    (provider as FakeProvider & { listQuestions?: unknown }).listQuestions = async () => [{
      requestId: "que_1",
      conversationId: "session",
      questions: [{ prompt: "Proceed?", header: "Next", options: [{ label: "Yes", description: "" }], multiple: false, allowFreeForm: false }],
    }];
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd() });

    const snapshot = await adapter.history("session");
    expect(snapshot.items).toEqual([expect.objectContaining({
      id: "question:que_1",
      type: "question",
      requestId: "que_1",
      status: "pending",
    })]);
  });

  test("discovers persisted sessions after restart, filters foreign directories, and orders deterministically", async () => {
    const provider = new FakeProvider();
    provider.sessions = [
      fixtureSession("older", process.cwd(), 2),
      fixtureSession("newer-z", process.cwd(), 4),
      fixtureSession("newer-a", process.cwd(), 4),
      fixtureSession("foreign", `${process.cwd()}-foreign`, 10),
    ];
    const first = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "first" });
    const restarted = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "second" });

    expect((await first.listConversations()).map(item => item.id)).toEqual(["newer-a", "newer-z", "older"]);
    expect((await restarted.listConversations()).map(item => item.id)).toEqual(["newer-a", "newer-z", "older"]);
    await expect(restarted.getConversation("foreign")).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  test("creates and looks up an empty workspace conversation", async () => {
    const provider = new FakeProvider();
    provider.newConfiguration = { model: { providerId: "recent", modelId: "model" }, mode: "build" };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => "created" });
    const created = await adapter.createConversation();
    expect(created).toEqual(expect.objectContaining({
      conversation: expect.objectContaining({ id: "created" }),
      configuration: provider.newConfiguration,
      generation: "g",
      items: [],
    }));
    expect((await adapter.history("created")).configuration).toEqual(provider.newConfiguration);
    expect(await adapter.getConversation("created")).toEqual(expect.objectContaining({ id: "created" }));
  });

  test("stale running activity from a dead server is closed out on load", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    // OpenCode died mid-turn (hub quit): the store never received a terminal
    // state for these parts, so they still read as running.
    provider.pages.set("first", { items: [{
      info: { id: "m1", role: "assistant", time: { created: 10 } },
      parts: [
        { id: "p1", type: "tool", tool: "task", state: { status: "running", input: { description: "Audit styles" } } },
        { id: "p2", type: "tool", tool: "task", state: { status: "completed" } },
        { id: "p3", type: "reasoning", text: "thinking", time: { start: 10 } },
      ],
    } as never] });
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    const items = (await adapter.history("local")).items;
    expect(items).toEqual([
      expect.objectContaining({ id: "tool:p1", status: "cancelled" }),
      expect.objectContaining({ id: "tool:p2", status: "completed" }),
      expect.objectContaining({ id: "part:p3", type: "reasoning", status: "cancelled" }),
    ]);
  });

  test("a live turn keeps its running activity across a reload", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    provider.pages.set("first", { items: [{
      info: { id: "m1", role: "assistant", time: { created: 10 } },
      parts: [{ id: "p1", type: "tool", tool: "task", state: { status: "running", input: { description: "Audit styles" } } }],
    } as never] });
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    adapter.projectionForTests("local").statusUpdate("running");

    const items = (await adapter.history("local")).items;
    expect(items).toEqual([expect.objectContaining({ id: "tool:p1", status: "running" })]);
  });

  test("an evicted projection does not cancel a turn that is still running", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local"), fixtureSession("other")];
    provider.pages.set("first", { items: [{
      info: { id: "m1", role: "assistant", time: { created: 10 } },
      parts: [{ id: "p1", type: "tool", tool: "task", state: { status: "running", input: { description: "Audit styles" } } }],
    } as never] });
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", maxProjections: 1 });
    adapter.projectionForTests("local").statusUpdate("running");
    // Touching another conversation evicts "local"; its projection comes back
    // fresh ("idle") while the turn still runs. Liveness must survive that.
    adapter.projectionForTests("other");

    const items = (await adapter.history("local")).items;
    expect(items).toEqual([expect.objectContaining({ id: "tool:p1", status: "running" })]);
  });

  test("uses opaque stable provider page boundaries without duplicate or reordered items", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    provider.pages.set("first", {
      items: [
        { id: "u2", type: "user", time: { created: 3 }, text: "Second" },
        { id: "a1", type: "assistant", time: { created: 2 }, content: [{ id: "p1", type: "text", text: "First answer" }] },
      ],
      nextCursor: "provider-boundary-a1",
    });
    provider.pages.set("provider-boundary-a1", {
      items: [{ id: "u1", type: "user", time: { created: 1 }, text: "First" }],
    });
    const firstAdapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g1" });
    const first = await firstAdapter.history("session", { limit: 2 });
    expect(first.items.map(item => item.id)).toEqual(["part:p1", "message:u2"]);
    expect(first.olderCursor).toBeDefined();
    expect(first.olderCursor).not.toContain("provider-boundary");

    const restarted = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g2" });
    const older = await restarted.history("session", { cursor: first.olderCursor });
    expect(older.items.map(item => item.id)).toEqual(["message:u1"]);
    expect(new Set([...first.items, ...older.items].map(item => item.id)).size).toBe(3);
  });
});

describe("filtered provider event pump", () => {
  test("validates the current session directory before every publication", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local"), fixtureSession("foreign", `${process.cwd()}-foreign`)];
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const pump = adapter.startEventPump();
    provider.eventQueue.push({ id: "foreign-event", type: "session.next.text.delta", data: { sessionID: "foreign", partID: "x", delta: "secret" } });
    provider.eventQueue.push({ id: "local-event", type: "session.next.text.delta", data: { sessionID: "local", partID: "x", delta: "safe" } });
    await Bun.sleep(1);
    provider.sessions[0] = fixtureSession("local", `${process.cwd()}-moved`);
    provider.eventQueue.push({ id: "moved-event", type: "session.next.text.delta", data: { sessionID: "local", partID: "x", delta: " hidden" } });
    await Bun.sleep(1);
    await adapter.stopEventPump();
    await pump;

    expect(adapter.projectionForTests("foreign").items()).toEqual([]);
    expect(adapter.projectionForTests("local").items()).toEqual([expect.objectContaining({ markdown: "safe" })]);
  });

  test("a pump failure aborts the provider event signal so surviving streams shut down", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    let observed: AbortSignal | undefined;
    provider.events = (signal: AbortSignal) => {
      observed = signal;
      return {
        async *[Symbol.asyncIterator]() {
          throw new Error("stream died");
        },
      };
    };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    await expect(adapter.startEventPump()).rejects.toThrow("stream died");
    expect(observed?.aborted).toBe(true);
  });

  test("a message.updated echo without parts keeps a history-loaded user message's text", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    provider.pages.set("first", { items: [{ id: "msg_history", type: "user", time: { created: 1 }, text: "hello from history" }] });
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    await adapter.history("local");
    const pump = adapter.startEventPump();
    provider.eventQueue.push({ id: "echo", type: "message.updated", data: { info: { id: "msg_history", role: "user", sessionID: "local", time: { created: 1 } } } });
    await Bun.sleep(1);
    await adapter.stopEventPump();
    await pump;

    expect(adapter.projectionForTests("local").items()).toEqual([expect.objectContaining({ type: "user_message", text: "hello from history" })]);
  });

  test("coalesces streamed deltas into a single published event per window", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 5 });
    const pump = adapter.startEventPump();
    const { events } = await adapter.subscribe("local");
    const received: ChatEvent[] = [];
    void (async () => { for await (const event of events) received.push(event); })();

    for (const delta of ["He", "ll", "o"]) {
      provider.eventQueue.push({ id: `e-${delta}`, type: "session.next.text.delta", data: { sessionID: "local", partID: "p", delta } });
    }
    await Bun.sleep(40);
    await adapter.stopEventPump();
    await pump;

    expect(adapter.projectionForTests("local").items()).toEqual([expect.objectContaining({ markdown: "Hello" })]);
    // Three provider deltas within one window publish a single event.
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(expect.objectContaining({ type: "item.upsert", item: expect.objectContaining({ markdown: "Hello" }) }));
    events.cancel();
  });

  test("evicts the least recently used idle conversation and keeps subscribed ones", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("a"), fixtureSession("b"), fixtureSession("c")];
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", maxProjections: 2 });
    const { events } = await adapter.subscribe("a");
    await adapter.subscribe("b").then(result => result.events.cancel());
    const before = adapter.projectionForTests("a");

    await adapter.getConversation("c");
    await adapter.subscribe("c").then(result => result.events.cancel());

    // "a" still has a live subscriber, so "b" is the eviction target.
    expect(adapter.projectionForTests("a")).toBe(before);
    events.cancel();
  });
});

describe("prompt, abort, permission, and question mutations", () => {
  test("snapshots recover provider-owned configuration and cache only while projected", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("a"), fixtureSession("b")];
    provider.configurations.set("a", { model: { providerId: "openai", modelId: "gpt" }, mode: "build", variant: "high" });
    let reads = 0;
    const recover = provider.getConversationConfiguration.bind(provider);
    provider.getConversationConfiguration = async id => { reads += 1; return recover(id); };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), maxProjections: 1 });

    expect((await adapter.history("a")).configuration).toEqual(provider.configurations.get("a")!);
    expect((await adapter.history("a")).configuration).toEqual(provider.configurations.get("a")!);
    expect(reads).toBe(1);
    await adapter.history("b");
    await adapter.history("a");
    expect(reads).toBe(3);
  });

  test("configuration recovery uses the complete provider source rather than the visible page", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const user = { info: { id: "user", role: "user", variant: "high" }, parts: [] };
    const assistant = { info: { id: "assistant", role: "assistant" }, parts: [] };
    provider.pages.set("first", { items: [assistant], configurationItems: [user, assistant] });
    provider.getConversationConfiguration = async (_id, messages) => {
      expect(messages).toEqual([user, assistant]);
      return { model: { providerId: "openai", modelId: "gpt" }, mode: "build", variant: "high" };
    };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd() });

    expect((await adapter.history("session", { limit: 1 })).configuration.variant).toBe("high");
  });

  test("a cold configuration read cannot overwrite a newer provider event", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const stale = { model: { providerId: "anthropic", modelId: "claude" }, mode: "plan" };
    let reads = 0;
    let readStarted!: () => void;
    const started = new Promise<void>(resolve => { readStarted = resolve; });
    let releaseRead!: () => void;
    const gate = new Promise<void>(resolve => { releaseRead = resolve; });
    provider.getConversationConfiguration = async () => {
      reads += 1;
      if (reads === 1) {
        readStarted();
        await gate;
      }
      return stale;
    };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const events = adapter.projectionForTests("session").replay.handoff(() => null).subscription;
    const iterator = events[Symbol.asyncIterator]();
    const pump = adapter.startEventPump();

    const pendingHistory = adapter.history("session");
    await started;
    provider.eventQueue.push({
      type: "session.next.model.switched",
      properties: { sessionID: "session", model: { providerID: "openai", id: "gpt" } },
    });
    await Bun.sleep(0);
    releaseRead();
    await pendingHistory;
    let event: ChatEvent | undefined;
    while (event?.type !== "conversation.configuration") event = (await iterator.next()).value;

    expect(reads).toBe(1);
    expect(event.configuration).toEqual({ model: { providerId: "openai", modelId: "gpt" }, mode: "plan" });
    expect((await adapter.history("session")).configuration).toEqual(event.configuration);
    events.cancel();
    await adapter.stopEventPump();
    await pump;
  });

  test("accepted configuration is returned and published once to live and replay subscribers", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    provider.configurations.set("session", { model: { providerId: "anthropic", modelId: "claude" }, mode: "plan" });
    provider.models[0] = { ...provider.models[0]!, variants: ["high"] };
    provider.listModes = async () => [{ name: "plan", description: "" }, { name: "build", description: "" }];
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => "message" });
    const first = await adapter.subscribe("session");
    const second = await adapter.subscribe("session");
    const cursor = first.snapshot.cursor;
    const configuration = { model: { providerId: "anthropic", modelId: "claude" }, mode: "build", variant: "high" };

    const accepted = await adapter.prompt("session", "request", "go", configuration.model, configuration.mode, configuration.variant);
    expect(accepted.configuration).toEqual(configuration);
    for (const subscription of [first.events, second.events]) {
      const iterator = subscription[Symbol.asyncIterator]();
      let event: ChatEvent | undefined;
      while (event?.type !== "conversation.configuration") event = (await iterator.next()).value;
      expect(event).toEqual(expect.objectContaining({ type: "conversation.configuration", configuration }));
      subscription.cancel();
    }

    await adapter.prompt("session", "request", "go", configuration.model, configuration.mode, configuration.variant);
    const replayed = await adapter.subscribe("session", { cursor });
    const iterator = replayed.events[Symbol.asyncIterator]();
    const events: ChatEvent[] = [];
    while (!events.some(event => event.type === "conversation.configuration")) events.push((await iterator.next()).value!);
    expect(events.filter(event => event.type === "conversation.configuration")).toHaveLength(1);
    replayed.events.cancel();
  });

  test("a new conversation follows the last configuration accepted by this adapter", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("existing")];
    provider.newConfiguration = { model: { providerId: "anthropic", modelId: "claude" }, mode: "build" };
    provider.models.push({ selection: { providerId: "openai", modelId: "gpt" }, provider: "OpenAI", name: "GPT" });
    provider.listModes = async () => [{ name: "build", description: "" }, { name: "plan", description: "" }];
    let nextId = 0;
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), id: () => nextId++ === 0 ? "message" : "created" });
    const selected = { model: { providerId: "openai", modelId: "gpt" }, mode: "plan" };

    expect((await adapter.prompt("existing", "request", "go", selected.model, selected.mode)).configuration).toEqual(selected);
    expect((await adapter.createConversation()).configuration).toEqual(selected);
    expect(provider.configurations.get("created")).toEqual(selected);
  });

  test("an unknown accepted prompt does not erase durable new-conversation defaults", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("existing")];
    provider.newConfiguration = { model: { providerId: "anthropic", modelId: "claude" }, mode: "build" };
    let nextId = 0;
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), id: () => nextId++ === 0 ? "message" : "created" });

    expect((await adapter.prompt("existing", "request", "go")).configuration).toEqual({});
    expect((await adapter.createConversation()).configuration).toEqual(provider.newConfiguration);
  });

  test("provider-reported model and mode switches update effective configuration", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    provider.configurations.set("session", { model: { providerId: "anthropic", modelId: "claude" }, mode: "plan", variant: "old" });
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const { events } = await adapter.subscribe("session");
    const iterator = events[Symbol.asyncIterator]();
    const pump = adapter.startEventPump();
    provider.eventQueue.push({ type: "session.next.model.switched", properties: { sessionID: "session", model: { providerID: "openai", id: "gpt" } } });
    expect((await iterator.next()).value).toEqual(expect.objectContaining({
      type: "conversation.configuration",
      configuration: { model: { providerId: "openai", modelId: "gpt" }, mode: "plan" },
    }));
    provider.eventQueue.push({ type: "session.next.agent.switched", properties: { sessionID: "session", agent: "build" } });
    expect((await iterator.next()).value).toEqual(expect.objectContaining({
      type: "conversation.configuration",
      configuration: { model: { providerId: "openai", modelId: "gpt" }, mode: "build" },
    }));
    events.cancel();
    await adapter.stopEventPump();
    await pump;
  });

  test("accepted prompts merge onto provider events processed during admission", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    provider.configurations.set("session", { model: { providerId: "anthropic", modelId: "claude" }, mode: "plan" });
    provider.listModes = async () => [{ name: "plan", description: "" }, { name: "build", description: "" }];
    let admitPrompt!: () => void;
    const promptAdmitted = new Promise<void>(resolve => { admitPrompt = resolve; });
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>(resolve => { releasePrompt = resolve; });
    provider.prompt = async (_sessionId, input) => {
      admitPrompt();
      await promptGate;
      return { messageId: input.id };
    };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => "message" });
    const subscription = await adapter.subscribe("session");
    const iterator = subscription.events[Symbol.asyncIterator]();
    const pump = adapter.startEventPump();

    const pending = adapter.prompt("session", "request", "go", undefined, "build");
    await promptAdmitted;
    provider.eventQueue.push({
      type: "session.next.model.switched",
      properties: { sessionID: "session", model: { providerID: "openai", id: "gpt" } },
    });
    let event: ChatEvent | undefined;
    while (event?.type !== "conversation.configuration") event = (await iterator.next()).value;
    expect(event.configuration).toEqual({ model: { providerId: "openai", modelId: "gpt" }, mode: "plan" });
    releasePrompt();

    expect((await pending).configuration).toEqual({ model: { providerId: "openai", modelId: "gpt" }, mode: "build" });
    subscription.events.cancel();
    await adapter.stopEventPump();
    await pump;
  });

  test("concurrent prompts commit configuration in admission order", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const anthropic = { providerId: "anthropic", modelId: "claude" };
    const openai = { providerId: "openai", modelId: "gpt" };
    provider.configurations.set("session", { model: anthropic });
    provider.models.push({ selection: openai, provider: "OpenAI", name: "GPT" });
    let enterFirst!: () => void;
    let enterSecond!: () => void;
    const firstEntered = new Promise<void>(resolve => { enterFirst = resolve; });
    const secondEntered = new Promise<void>(resolve => { enterSecond = resolve; });
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const gates = [
      new Promise<void>(resolve => { releaseFirst = resolve; }),
      new Promise<void>(resolve => { releaseSecond = resolve; }),
    ];
    let calls = 0;
    provider.prompt = async (_sessionId, input) => {
      const call = calls++;
      (call === 0 ? enterFirst : enterSecond)();
      await gates[call];
      return { messageId: input.id };
    };
    let message = 0;
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `message-${++message}` });

    const first = adapter.prompt("session", "request-1", "use GPT", openai);
    await firstEntered;
    const second = adapter.prompt("session", "request-2", "use Claude", anthropic);
    await Promise.resolve();
    expect(calls).toBe(1);

    releaseFirst();
    await first;
    // The second submission was accepted while the turn ran: held by the
    // workspace with its configuration committed in admission order, and
    // nothing dispatched to the provider yet.
    expect((await second).held).toBe(true);
    expect((await second).configuration).toEqual({ model: anthropic });
    expect(calls).toBe(1);

    // The turn ending on its own releases the held message to the provider.
    adapter.projectionForTests("session").statusUpdate("completed");
    await secondEntered;
    releaseSecond();
    expect((await adapter.history("session")).configuration).toEqual({ model: anthropic });
    expect((await adapter.history("session")).queued).toEqual([]);
  });

  test("manual rename is confined, idempotent, preserves active turns, and prevents first-prompt overwrite", async () => {
    const provider = new FakeProvider();
    provider.agent.capabilities.push("conversation-rename");
    provider.sessions = [{ ...fixtureSession("session"), title: "New session - now" }];
    let renames = 0;
    provider.renameSession = async (id, title) => {
      renames += 1;
      const renamed = { ...provider.sessions.find(session => session.id === id)!, title };
      provider.sessions[0] = renamed;
      return renamed;
    };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => "message" });
    const subscriber = await adapter.subscribe("session");
    const [first, retry] = await Promise.all([
      adapter.renameConversation("session", "rename-1", "  Manual title  "),
      adapter.renameConversation("session", "rename-1", "different retry payload"),
    ]);
    expect(first).toEqual(retry);
    expect(first.conversation.title).toBe("Manual title");
    expect(renames).toBe(1);
    expect((await subscriber.events[Symbol.asyncIterator]().next()).value).toEqual(expect.objectContaining({ type: "conversation.updated" }));
    subscriber.events.cancel();
    await adapter.prompt("session", "prompt-1", "This must not replace the manual title");
    expect(renames).toBe(1);

    await expect(adapter.renameConversation("session", "empty", "  ")).rejects.toBeInstanceOf(InvalidConversationTitleError);
    await expect(adapter.renameConversation("session", "large", "é".repeat(101))).rejects.toBeInstanceOf(InvalidConversationTitleError);
    adapter.projectionForTests("session").statusUpdate("running");
    const whileRunning = await adapter.renameConversation("session", "running", "Renamed while running");
    expect(whileRunning.conversation).toEqual(expect.objectContaining({ title: "Renamed while running", status: "running" }));
    expect(adapter.projectionForTests("session").status).toBe("running");
  });

  test("a manual rename during prompt validation wins over first-prompt naming", async () => {
    const provider = new FakeProvider();
    provider.agent.capabilities.push("conversation-rename");
    provider.sessions = [{ ...fixtureSession("session"), title: "New session - now" }];
    let renames = 0;
    provider.renameSession = async (id, title) => {
      renames += 1;
      const renamed = { ...provider.sessions.find(session => session.id === id)!, title };
      provider.sessions[0] = renamed;
      return renamed;
    };
    let validationStarted!: () => void;
    const validating = new Promise<void>(resolve => { validationStarted = resolve; });
    let releaseValidation!: () => void;
    const validationGate = new Promise<void>(resolve => { releaseValidation = resolve; });
    provider.listMessages = async () => {
      validationStarted();
      await validationGate;
      return { items: [] };
    };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => "message" });

    const pending = adapter.prompt("session", "prompt-1", "Automatic title candidate");
    await validating;
    await adapter.renameConversation("session", "rename-1", "Manual title");
    releaseValidation();
    await pending;

    expect(provider.sessions[0]?.title).toBe("Manual title");
    expect(renames).toBe(1);
  });

  test("rename rejects unsupported and foreign-workspace provider outcomes", async () => {
    const unsupported = new FakeProvider();
    unsupported.sessions = [fixtureSession("session")];
    await expect(new OpenCodeChatAdapter({ provider: unsupported, workspacePath: process.cwd() })
      .renameConversation("session", "r1", "Title")).rejects.toBeInstanceOf(ConversationRenameUnsupportedError);

    const foreign = new FakeProvider();
    foreign.agent.capabilities.push("conversation-rename");
    foreign.sessions = [fixtureSession("session")];
    foreign.renameSession = async (id, title) => ({ ...fixtureSession(id, "/foreign"), title });
    await expect(new OpenCodeChatAdapter({ provider: foreign, workspacePath: process.cwd() })
      .renameConversation("session", "r2", "Title")).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  test("recognizes only well-formed listed slash commands and separates arguments", () => {
    const commands = new FakeProvider().commands;
    expect(parseSlashCommand("/review   routing behavior ", commands)).toEqual({ name: "review", arguments: "routing behavior" });
    for (const text of ["/unknown args", "/ review", "//review", "prefix /review"]) {
      expect(parseSlashCommand(text, commands)).toBeUndefined();
    }
  });

  test("dispatches recognized slash commands without changing the prompt contract", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => "message" });
    const model = { providerId: "anthropic", modelId: "claude" };

    const accepted = await adapter.prompt("session", "request", "/review   API compatibility", model);
    expect(accepted).toEqual({ messageId: "message", held: false, configuration: { model } });
    expect(provider.commandCalls).toEqual([{ sessionId: "session", id: "message", name: "review", arguments: "API compatibility", model }]);
    expect(provider.prompts).toEqual([]);

    adapter.projectionForTests("session").statusUpdate("completed");
    await adapter.prompt("session", "ordinary", "/missing stays ordinary");
    expect(provider.prompts[0]).toEqual(expect.objectContaining({ text: "/missing stays ordinary" }));
  });

  test("derives concise titles without reducing numeric prompts to a generic label", () => {
    expect(deriveConversationTitle("123 investigate flaky model routing")).toBe("123 investigate flaky model routing");
    expect(deriveConversationTitle("# Implement a deliberately long model selection request that should be shortened at a word boundary for the chooser"))
      .toBe("Implement a deliberately long model selection request that...");
  });

  test("strictly selects a model and gives the first prompt a provider-owned title", async () => {
    const provider = new FakeProvider();
    provider.sessions = [{ ...fixtureSession("session"), title: "New session - 2026-08-15T12:00:00Z" }];
    provider.renameSession = async (id, title) => {
      const session = provider.sessions.find(candidate => candidate.id === id)!;
      const renamed = { ...session, title };
      provider.sessions[0] = renamed;
      return renamed;
    };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => "message" });
    const selection = { providerId: "anthropic", modelId: "claude" };

    const accepted = await adapter.prompt("session", "request", "Implement model selection cleanly across the workspace", selection);
    expect(provider.modelSwitches).toEqual([]);
    expect(accepted.conversation?.title).toBe("Implement model selection cleanly across the workspace");
    expect(provider.sessions[0]!.title).toBe("Implement model selection cleanly across the workspace");

    await expect(adapter.prompt("session", "other", "retry", { providerId: "anthropic", modelId: "missing" }))
      .rejects.toBeInstanceOf(InvalidModelSelectionError);
  });

  test("passes a listed mode through and refuses an unknown one", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    provider.listModes = async () => [{ name: "build", description: "" }, { name: "plan", description: "" }];
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    await adapter.prompt("session", "r1", "switch me", undefined, "build");
    expect(provider.prompts[0]).toEqual(expect.objectContaining({ mode: "build" }));
    await expect(adapter.prompt("session", "r2", "nope", undefined, "reviewer")).rejects.toBeInstanceOf(InvalidModeSelectionError);
  });

  test("passes a listed reasoning variant through and refuses an unknown one", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    provider.models = [{ selection: { providerId: "anthropic", modelId: "claude" }, provider: "Anthropic", name: "Claude", variants: ["high", "xhigh"] }];
    const model = { providerId: "anthropic", modelId: "claude" };
    let modelLists = 0;
    const listModels = provider.listModels.bind(provider);
    provider.listModels = async () => { modelLists += 1; return listModels(); };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    await adapter.prompt("session", "r1", "think hard", model, undefined, "high");
    expect(provider.prompts[0]).toEqual(expect.objectContaining({ variant: "high" }));
    // The model changed and the variant is new, but one list answers both
    // checks — and a variant is re-sent with every prompt, so an unchanged
    // one must not pay a provider round trip per message.
    expect(modelLists).toBe(1);
    adapter.projectionForTests("session").statusUpdate("completed");
    await adapter.prompt("session", "r2", "keep thinking", model, undefined, "high");
    expect(modelLists).toBe(1);
    adapter.projectionForTests("session").statusUpdate("completed");
    // Unknown for this model — refused before dispatch.
    await expect(adapter.prompt("session", "r3", "nope", model, undefined, "ultra")).rejects.toBeInstanceOf(InvalidVariantSelectionError);

    // A variant without a restated model means "this conversation's model,
    // harder": the last applied model stands in for the check AND rides the
    // dispatch — on the v2 path the variant travels on the model reference,
    // so a variant with no model to ride would be silently dropped.
    await adapter.prompt("session", "r4", "go deeper", undefined, undefined, "xhigh");
    expect(provider.prompts[2]).toEqual(expect.objectContaining({ variant: "xhigh", model }));

    // A conversation whose model this adapter never learned has nothing to
    // check the variant against, and nothing for it to ride — refused.
    const fresh = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g2" });
    await expect(fresh.prompt("session", "r5", "nope", undefined, undefined, "high")).rejects.toBeInstanceOf(InvalidVariantSelectionError);
  });

  test("maps a provider's unsupported variant to the client selection error", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    provider.models = [{ selection: { providerId: "anthropic", modelId: "claude" }, provider: "Anthropic", name: "Claude", variants: ["high"] }];
    provider.command = async () => { throw new UnsupportedVariantSelectionError("reasoning variants are not supported for compatibility compaction"); };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    const error = adapter.prompt("session", "r1", "/compact", { providerId: "anthropic", modelId: "claude" }, undefined, "high");
    await expect(error).rejects.toBeInstanceOf(InvalidVariantSelectionError);
    await expect(error).rejects.toThrow("compatibility compaction");
  });

  test("delivers held messages in order on the turn's own end, and a cancellation pauses the queue until the next submission", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let message = 0;
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `id-${++message}` });
    const until = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
      expect(predicate()).toBe(true);
    };

    expect((await adapter.prompt("session", "r1", "first")).held).toBe(false);
    const second = await adapter.prompt("session", "r2", "second");
    const third = await adapter.prompt("session", "r3", "third");
    expect([second.held, third.held]).toEqual([true, true]);
    expect(provider.prompts).toHaveLength(1);
    expect((await adapter.history("session")).queued).toEqual([
      expect.objectContaining({ id: second.messageId, text: "second", requestId: "r2" }),
      expect.objectContaining({ id: third.messageId, text: "third", requestId: "r3" }),
    ]);

    // The turn ending on its own releases exactly the queue head.
    adapter.projectionForTests("session").statusUpdate("completed");
    await until(() => provider.prompts.length === 2);
    expect(provider.prompts[1]).toEqual(expect.objectContaining({ text: "second", id: second.messageId }));

    // Cancel pauses the queue: the interrupt and its trailing idle deliver
    // nothing, and "third" stays held.
    await adapter.abort("session", "cancel-1");
    adapter.projectionForTests("session").statusUpdate("idle");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(provider.prompts).toHaveLength(2);

    // The next submission joins the back of the queue and resumes delivery
    // from its head, preserving submission order.
    const fourth = await adapter.prompt("session", "r4", "fourth");
    expect(fourth.held).toBe(true);
    await until(() => provider.prompts.length === 3);
    expect(provider.prompts[2]).toEqual(expect.objectContaining({ text: "third" }));
    adapter.projectionForTests("session").statusUpdate("completed");
    await until(() => provider.prompts.length === 4);
    expect(provider.prompts[3]).toEqual(expect.objectContaining({ text: "fourth" }));
    expect((await adapter.history("session")).queued).toEqual([]);
  });

  test("cancellation waits for an in-flight delivery and then interrupts the turn it started", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let message = 0;
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `id-${++message}` });

    expect((await adapter.prompt("session", "r1", "first")).held).toBe(false);
    await adapter.prompt("session", "r2", "second");
    const third = await adapter.prompt("session", "r3", "third");

    // Delivery of "second" enters dispatch and stalls at the provider.
    let releaseDelivery!: () => void;
    const gate = new Promise<void>(resolve => { releaseDelivery = resolve; });
    let entered!: () => void;
    const enteredDelivery = new Promise<void>(resolve => { entered = resolve; });
    const accept = provider.prompt.bind(provider);
    provider.prompt = async (sessionId, input) => {
      entered();
      await gate;
      return accept(sessionId, input);
    };
    adapter.projectionForTests("session").statusUpdate("completed");
    await enteredDelivery;

    // Cancellation queues behind the started delivery rather than letting it
    // slip past the pause and start work after the interrupt.
    const cancelled = adapter.abort("session", "cancel-1");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(provider.interrupts).toEqual([]);
    releaseDelivery();
    await cancelled;
    expect(provider.interrupts).toEqual(["session"]);
    expect(provider.prompts).toHaveLength(2);

    // The delivery that had started was admitted and then interrupted; the
    // one that had not stays held through the trailing idle.
    adapter.projectionForTests("session").statusUpdate("idle");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(provider.prompts).toHaveLength(2);
    expect((await adapter.history("session")).queued).toEqual([expect.objectContaining({ id: third.messageId, text: "third" })]);
  });

  test("a straggling completion of the previous turn does not release a second delivery", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let message = 0;
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `id-${++message}` });

    expect((await adapter.prompt("session", "r1", "first")).held).toBe(false);
    await adapter.prompt("session", "r2", "second");
    const third = await adapter.prompt("session", "r3", "third");

    // Delivery of "second" stalls in dispatch, holding the projection at
    // "sending" — the window in which the merged provider streams can
    // restate the PREVIOUS turn's completion.
    let releaseDelivery!: () => void;
    const gate = new Promise<void>(resolve => { releaseDelivery = resolve; });
    let entered!: () => void;
    const enteredDelivery = new Promise<void>(resolve => { entered = resolve; });
    const accept = provider.prompt.bind(provider);
    provider.prompt = async (sessionId, input) => {
      entered();
      await gate;
      return accept(sessionId, input);
    };
    adapter.projectionForTests("session").apply({ kind: "status", status: "completed" });
    await enteredDelivery;
    // The duplicate terminal report lands mid-admission and must be ignored.
    expect(adapter.projectionForTests("session").apply({ kind: "status", status: "completed" })).toBeUndefined();
    expect(adapter.projectionForTests("session").status).toBe("sending");
    releaseDelivery();
    await new Promise(resolve => setTimeout(resolve, 20));

    // Only "second" was admitted; "third" is still held and removable.
    expect(provider.prompts).toHaveLength(2);
    expect((await adapter.history("session")).queued).toEqual([expect.objectContaining({ id: third.messageId })]);
  });

  test("a delivery-time session lookup failure pauses the queue instead of stranding it", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let message = 0;
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `id-${++message}` });

    expect((await adapter.prompt("session", "r1", "first")).held).toBe(false);
    const held = await adapter.prompt("session", "r2", "second");
    expect(held.held).toBe(true);

    const lookup = provider.getSession.bind(provider);
    provider.getSession = async () => { throw new Error("transient lookup failure"); };
    adapter.projectionForTests("session").statusUpdate("completed");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(provider.prompts).toHaveLength(1);

    // The queue paused rather than silently stranding the message: a later
    // idle transition alone delivers nothing...
    provider.getSession = lookup;
    adapter.projectionForTests("session").statusUpdate("idle");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(provider.prompts).toHaveLength(1);
    // ...and the documented exit — the next submission — resumes delivery.
    await adapter.prompt("session", "r3", "third");
    for (let attempt = 0; attempt < 200 && provider.prompts.length < 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
    expect(provider.prompts[1]).toEqual(expect.objectContaining({ text: "second", id: held.messageId }));
  });

  test("a held message freezes the configuration it was submitted under", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const modelA = { providerId: "anthropic", modelId: "claude" };
    const modelB = { providerId: "openai", modelId: "gpt" };
    provider.configurations.set("session", { model: modelA });
    provider.models.push({ selection: modelB, provider: "OpenAI", name: "GPT" });
    let message = 0;
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `id-${++message}` });
    const until = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
      expect(predicate()).toBe(true);
    };

    expect((await adapter.prompt("session", "r1", "first")).held).toBe(false);
    // Submitted with no explicit model — under the configuration the user
    // saw at the time (model A)...
    await adapter.prompt("session", "r2", "second");
    // ...before a later submission moves the conversation to model B.
    await adapter.prompt("session", "r3", "third", modelB);

    adapter.projectionForTests("session").statusUpdate("completed");
    await until(() => provider.prompts.length === 2);
    expect(provider.prompts[1]).toEqual(expect.objectContaining({ text: "second", model: modelA }));
    adapter.projectionForTests("session").statusUpdate("completed");
    await until(() => provider.prompts.length === 3);
    expect(provider.prompts[2]).toEqual(expect.objectContaining({ text: "third", model: modelB }));
  });

  test("the held queue is bounded and a full queue refuses the submission without altering it", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let message = 0;
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `id-${++message}` });

    expect((await adapter.prompt("session", "r0", "start")).held).toBe(false);
    for (let index = 1; index <= 20; index += 1) {
      expect((await adapter.prompt("session", `count-${index}`, `held ${index}`)).held).toBe(true);
    }
    await expect(adapter.prompt("session", "count-21", "one too many")).rejects.toBeInstanceOf(ChatQueueFullError);
    expect((await adapter.history("session")).queued).toHaveLength(20);

    // The byte bound trips before the count bound for oversized prompts.
    const bytes = new OpenCodeChatAdapter({ provider: (() => {
      const fresh = new FakeProvider();
      fresh.sessions = [fixtureSession("session")];
      return fresh;
    })(), workspacePath: process.cwd(), generation: "g2", id: () => `byte-${++message}` });
    expect((await bytes.prompt("session", "b0", "start")).held).toBe(false);
    const large = "x".repeat(60 * 1024);
    for (let index = 1; index <= 4; index += 1) {
      expect((await bytes.prompt("session", `bytes-${index}`, large)).held).toBe(true);
    }
    await expect(bytes.prompt("session", "bytes-5", large)).rejects.toBeInstanceOf(ChatQueueFullError);
  });

  test("a held message does not ride an idle event that outruns the interrupt acknowledgement", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let message = 0;
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `id-${++message}` });

    expect((await adapter.prompt("session", "r1", "first")).held).toBe(false);
    const held = await adapter.prompt("session", "r2", "second");
    expect(held.held).toBe(true);

    // The provider publishes the interrupt's idle transition before the
    // interrupt request itself resolves — the pump is faster than the HTTP
    // acknowledgement. The queue must already be paused when that happens.
    provider.interrupt = async sessionId => {
      provider.interrupts.push(sessionId);
      adapter.projectionForTests("session").statusUpdate("idle");
      await new Promise(resolve => setTimeout(resolve, 10));
    };
    await adapter.abort("session", "cancel-1");
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(provider.prompts).toHaveLength(1);
    await expect(adapter.removeQueued("session", held.messageId, "remove-1")).resolves.toEqual({ removed: true });

    // A failed interrupt leaves the turn running and must roll back only the
    // pause this cancellation added — the next natural end still delivers.
    expect((await adapter.prompt("session", "r3", "third")).held).toBe(false);
    const fourth = await adapter.prompt("session", "r4", "fourth");
    expect(fourth.held).toBe(true);
    provider.interrupt = async () => { throw new Error("interrupt refused"); };
    await expect(adapter.abort("session", "cancel-2")).rejects.toThrow("interrupt refused");
    adapter.projectionForTests("session").statusUpdate("completed");
    for (let attempt = 0; attempt < 200 && provider.prompts.length < 3; attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
    expect(provider.prompts[2]).toEqual(expect.objectContaining({ text: "fourth", id: fourth.messageId }));
  });

  test("a failed delivery pauses the queue instead of hammering a failing conversation", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let message = 0;
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `id-${++message}` });
    const until = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
      expect(predicate()).toBe(true);
    };

    expect((await adapter.prompt("session", "r1", "first")).held).toBe(false);
    const held = await adapter.prompt("session", "r2", "second");
    expect(held.held).toBe(true);

    let attempts = 0;
    const accept = provider.prompt.bind(provider);
    provider.prompt = async (sessionId, input) => {
      attempts += 1;
      if (attempts === 1) throw new Error("provider refused");
      return accept(sessionId, input);
    };
    adapter.projectionForTests("session").statusUpdate("completed");
    await until(() => attempts === 1);
    expect(adapter.projectionForTests("session").status).toBe("failed");

    // A later idle transition does not retry on its own...
    adapter.projectionForTests("session").statusUpdate("idle");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(attempts).toBe(1);
    // ...the message is still held and removable, and a new submission
    // resumes delivery.
    expect((await adapter.history("session")).queued).toEqual([
      expect.objectContaining({ id: held.messageId, text: "second" }),
    ]);
    await adapter.prompt("session", "r3", "third");
    await until(() => attempts === 2);
  });

  test("joins duplicate prompts, holds busy submissions, and preserves content on abort", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let nextId = 0;
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `message-${++nextId}` });
    const projection = adapter.projectionForTests("session");
    projection.upsert({ id: "part:answer", type: "assistant_message", createdAt: 1, markdown: "Completed content" });

    const [first, duplicate] = await Promise.all([
      adapter.prompt("session", "request-1", "first"),
      adapter.prompt("session", "request-1", "first"),
    ]);
    expect(first).toEqual(duplicate);
    expect(provider.prompts).toHaveLength(1);
    expect(first.held).toBe(false);
    expect(projection.status).toBe("running");

    // A busy submission is held by the workspace, not delivered mid-turn.
    const held = await adapter.prompt("session", "request-2", "follow-up");
    expect(held.held).toBe(true);
    expect(provider.prompts).toHaveLength(1);

    await Promise.all([adapter.abort("session", "cancel-1"), adapter.abort("session", "cancel-1")]);
    expect(provider.interrupts).toEqual(["session"]);
    expect(projection.status).toBe("interrupted");
    expect(projection.items()).toContainEqual(expect.objectContaining({ id: "part:answer", markdown: "Completed content" }));

    // The cancellation left the held message queued and removable, and it
    // never rode the interrupt's idle transition to the provider.
    expect(provider.prompts).toHaveLength(1);
    await expect(adapter.removeQueued("session", held.messageId, "remove-1")).resolves.toEqual({ removed: true });
    await expect(adapter.removeQueued("session", held.messageId, "remove-2")).rejects.toBeInstanceOf(QueuedMessageNotHeldError);
  });

  test("maps completed and failed provider transitions", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const pump = adapter.startEventPump();
    provider.eventQueue.push({ id: "idle", type: "session.idle", data: { sessionID: "session" } });
    provider.eventQueue.push({ id: "error", type: "session.error", data: { sessionID: "session", error: { type: "unknown", message: "failed" } } });
    for (let attempt = 0; attempt < 100 && adapter.projectionForTests("session").status !== "failed"; attempt += 1) {
      await Bun.sleep(1);
    }
    await adapter.stopEventPump();
    await pump;
    expect(adapter.projectionForTests("session").status).toBe("failed");
    expect(adapter.projectionForTests("session").items()).toContainEqual(expect.objectContaining({ type: "notice", level: "error", message: "failed" }));
  });

  test("supports permission outcomes exactly once and refuses stale duplicates", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    for (const [requestId, outcome] of [["once", "approved-once"], ["always", "approved-session"], ["reject", "rejected"]] as const) {
      applyEvent(adapter, "session", { id: requestId, type: "permission.v2.asked", data: { id: requestId, sessionID: "session", action: "shell", resources: ["bun test"], timestamp: Date.now() } });
      const first = adapter.respondPermission("session", requestId, `client-${requestId}`, outcome);
      const duplicate = adapter.respondPermission("session", requestId, `client-${requestId}`, outcome);
      expect(await duplicate).toEqual(await first);
      await expect(adapter.respondPermission("session", requestId, `other-${requestId}`, outcome)).rejects.toBeInstanceOf(InteractionConflictError);
    }
    expect(provider.permissionReplies.map(reply => reply.reply)).toEqual(["once", "always", "reject"]);
  });

  test("a late ask alias does not reopen a resolved interaction", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    applyEvent(adapter, "session", { id: "ask", type: "permission.v2.asked", data: { id: "perm_1", sessionID: "session", action: "shell", resources: ["ls"], timestamp: 10 } });
    await adapter.respondPermission("session", "perm_1", "c1", "approved-once");
    // The classic stream's alias of the same ask, delivered after the reply:
    // the merged streams only preserve order within themselves.
    applyEvent(adapter, "session", { id: "alias", type: "permission.asked", data: { id: "perm_1", sessionID: "session", permission: "shell", patterns: ["ls"], timestamp: 9 } });

    expect(adapter.projectionForTests("session").items()[0]).toEqual(expect.objectContaining({
      id: "permission:perm_1",
      status: "resolved",
      outcome: "approved-once",
    }));
    await expect(adapter.respondPermission("session", "perm_1", "c2", "rejected")).rejects.toBeInstanceOf(InteractionConflictError);

    applyEvent(adapter, "session", {
      id: "q-ask", type: "question.v2.asked",
      data: { id: "que_1", sessionID: "session", timestamp: 10, questions: [{ question: "Choose", header: "Choice", options: [{ label: "A", description: "A" }], multiple: false, custom: false }] },
    });
    await adapter.respondQuestion("session", "que_1", "c3", { kind: "answered", answers: [["A"]] });
    applyEvent(adapter, "session", {
      id: "q-alias", type: "question.v2.asked",
      data: { id: "que_1", sessionID: "session", timestamp: 9, questions: [{ question: "Choose", header: "Choice", options: [{ label: "A", description: "A" }], multiple: false, custom: false }] },
    });
    expect(adapter.projectionForTests("session").items().find(item => item.id === "question:que_1")).toEqual(
      expect.objectContaining({ status: "resolved", outcome: { kind: "answered", answers: [["A"]] } }),
    );
  });

  test("supports option, multi-option, free-form, and rejection answers and refuses invalid or stale responses", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const ask = (id: string, multiple: boolean, custom: boolean) => applyEvent(adapter, "session", {
      id,
      type: "question.v2.asked",
      data: { id, sessionID: "session", timestamp: Date.now(), questions: [{ question: "Choose", header: "Choice", options: [{ label: "A", description: "A" }, { label: "B", description: "B" }], multiple, custom }] },
    });

    ask("option", false, false);
    const option = adapter.respondQuestion("session", "option", "c1", { kind: "answered", answers: [["A"]] });
    const optionDuplicate = adapter.respondQuestion("session", "option", "c1", { kind: "answered", answers: [["A"]] });
    expect(await optionDuplicate).toEqual(await option);
    ask("multi", true, false);
    await adapter.respondQuestion("session", "multi", "c2", { kind: "answered", answers: [["A", "B"]] });
    ask("free", false, true);
    await adapter.respondQuestion("session", "free", "c3", { kind: "answered", answers: [["Other"]] });
    ask("reject", false, false);
    await adapter.respondQuestion("session", "reject", "c4", { kind: "rejected" });
    await expect(adapter.respondQuestion("session", "reject", "new-client", { kind: "rejected" })).rejects.toBeInstanceOf(InteractionConflictError);
    ask("invalid", false, false);
    await expect(adapter.respondQuestion("session", "invalid", "c5", { kind: "answered", answers: [["Other"]] })).rejects.toThrow(/free-form/);

    expect(provider.questionReplies).toEqual([
      expect.objectContaining({ requestId: "option", answers: [["A"]] }),
      expect.objectContaining({ requestId: "multi", answers: [["A", "B"]] }),
      expect.objectContaining({ requestId: "free", answers: [["Other"]] }),
      expect.objectContaining({ requestId: "reject", rejected: true }),
    ]);
  });

  test("invalid question answers neither reach the provider nor resolve the request", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const invalid = [
      { id: "empty", multiple: true, custom: true, answers: [] },
      { id: "whitespace", multiple: true, custom: true, answers: ["   "] },
      { id: "single-extra", multiple: false, custom: true, answers: ["A", "Other"] },
      { id: "unknown", multiple: false, custom: false, answers: ["Other"] },
    ];

    for (const testCase of invalid) {
      applyEvent(adapter, "session", {
        id: testCase.id,
        type: "question.v2.asked",
        data: {
          id: testCase.id,
          sessionID: "session",
          timestamp: Date.now(),
          questions: [{ question: "Choose", header: "Choice", options: [{ label: "A", description: "" }], multiple: testCase.multiple, custom: testCase.custom }],
        },
      });
      await expect(adapter.respondQuestion("session", testCase.id, `client-${testCase.id}`, {
        kind: "answered",
        answers: [testCase.answers],
      })).rejects.toBeInstanceOf(InteractionConflictError);
      expect(adapter.projectionForTests("session").items().find(item => item.id === `question:${testCase.id}`)).toEqual(
        expect.objectContaining({ status: "pending" }),
      );
    }

    expect(provider.questionReplies).toEqual([]);
  });
});

describe("discarded event accounting", () => {
  function counters() {
    const values: Record<string, number> = {};
    return { values, inc: (name: string, delta = 1) => { values[name] = (values[name] ?? 0) + delta; } };
  }

  test("an unrecognized event is counted by type and the stream keeps flowing", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    const metrics = counters();
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), metrics, coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();

    provider.eventQueue.push({ id: "u1", type: "totally.unknown.event", data: { sessionID: "local" } } as never);
    provider.eventQueue.push({ id: "d1", type: "session.next.text.delta", data: { sessionID: "local", partID: "p", delta: "after" } });
    while (adapter.projectionForTests("local").items().length === 0) await Bun.sleep(1);

    expect(metrics.values["chat.event.unrecognized.totally.unknown.event"]).toBe(1);
    // The event after the unrecognized one still landed.
    expect(JSON.stringify(adapter.projectionForTests("local").items())).toContain("after");
    await adapter.stopEventPump();
    await pump;
  });

  test("a malformed payload of a known type costs one event, not the pump", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    const metrics = counters();
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), metrics, coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();

    // `permission.v2.asked` requires an id; without one its accessor throws.
    provider.eventQueue.push({ id: "bad", type: "permission.v2.asked", data: { sessionID: "local" } } as never);
    provider.eventQueue.push({ id: "d1", type: "session.next.text.delta", data: { sessionID: "local", partID: "p", delta: "survived" } });
    while (adapter.projectionForTests("local").items().length === 0) await Bun.sleep(1);

    expect(metrics.values["chat.event.unparseable.permission.v2.asked"]).toBe(1);
    expect(JSON.stringify(adapter.projectionForTests("local").items())).toContain("survived");
    await adapter.stopEventPump();
    await pump;
  });

  test("an intentionally ignored type is not counted as a discard", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    const metrics = counters();
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), metrics, coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();

    provider.eventQueue.push({ id: "hb", type: "server.heartbeat", data: {} } as never);
    provider.eventQueue.push({ id: "cd", type: "session.next.compaction.delta", data: { sessionID: "local" } } as never);
    provider.eventQueue.push({ id: "d1", type: "session.next.text.delta", data: { sessionID: "local", partID: "p", delta: "ok" } });
    while (adapter.projectionForTests("local").items().length === 0) await Bun.sleep(1);

    expect(Object.keys(metrics.values).filter(key => key.startsWith("chat.event."))).toEqual([]);
    await adapter.stopEventPump();
    await pump;
  });

  test("the counted type space is bounded, folding overflow into `other`", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    const metrics = counters();
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), metrics, coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();

    for (let index = 0; index < 70; index += 1) {
      provider.eventQueue.push({ id: `u${index}`, type: `unknown.type.${index}`, data: { sessionID: "local" } } as never);
    }
    provider.eventQueue.push({ id: "d1", type: "session.next.text.delta", data: { sessionID: "local", partID: "p", delta: "last" } });
    while (adapter.projectionForTests("local").items().length === 0) await Bun.sleep(1);

    const keys = Object.keys(metrics.values).filter(key => key.startsWith("chat.event.unrecognized."));
    expect(keys.length).toBe(65);
    expect(metrics.values["chat.event.unrecognized.other"]).toBe(6);
    await adapter.stopEventPump();
    await pump;
  });

  test("discards land in the registry snapshot the workspace writes without --debug", async () => {
    // cli.ts writes `snapshot-<pid>.json` from MetricsRegistry.snapshot() on an
    // unconditional 1Hz tick; --debug only adds the NDJSON history. Driving the
    // real registry here guards the property that makes these counters readable
    // on the machine where chat broke, with no restart and no flag.
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    const registry = new MetricsRegistry();
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), metrics: registry, coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();

    provider.eventQueue.push({ id: "u1", type: "question.asked.someday", data: { sessionID: "local" } } as never);
    provider.eventQueue.push({ id: "d1", type: "session.next.text.delta", data: { sessionID: "local", partID: "p", delta: "ok" } });
    while (adapter.projectionForTests("local").items().length === 0) await Bun.sleep(1);

    expect(registry.snapshot().counters["chat.event.unrecognized.question.asked.someday"]).toBe(1);
    await adapter.stopEventPump();
    await pump;
  });

  test("no counter key or value carries an event payload", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    const metrics = counters();
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), metrics, coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();

    provider.eventQueue.push({
      id: "secret",
      type: "unknown.secret.carrier",
      data: { sessionID: "local", contents: "PRIVATE-FILE-CONTENTS" },
    } as never);
    provider.eventQueue.push({ id: "d1", type: "session.next.text.delta", data: { sessionID: "local", partID: "p", delta: "ok" } });
    while (adapter.projectionForTests("local").items().length === 0) await Bun.sleep(1);

    expect(JSON.stringify(metrics.values)).not.toContain("PRIVATE-FILE-CONTENTS");
    await adapter.stopEventPump();
    await pump;
  });
});

describe("pending permission recovery", () => {
  test("a permission the event stream never delivered appears on load and is answerable", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    // The pump never saw this: OpenCode raised it while the stream was down.
    // The diff rides along — recovery exists for the reader who missed the
    // live announcement, who must not approve an edit without seeing it.
    provider.listPermissions = async () => [{ requestId: "perm_1", conversationId: "local", action: "skill", resources: ["review-code"], diff: "@@ -1 +1 @@\n-a\n+b" }];
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    const snapshot = await adapter.history("local");
    expect(snapshot.items).toEqual([expect.objectContaining({
      id: "permission:perm_1",
      type: "permission",
      action: "skill",
      resources: ["review-code"],
      status: "pending",
      diff: "@@ -1 +1 @@\n-a\n+b",
    })]);

    await adapter.respondPermission("local", "perm_1", "req-1", "approved-once");
    expect(provider.permissionReplies).toEqual([{ sessionId: "local", requestId: "perm_1", reply: "once" }]);
  });

  test("a recovered request that also arrives live stays one entry", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    provider.listPermissions = async () => [{ requestId: "perm_1", conversationId: "local", action: "skill", resources: ["review-code"] }];
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    await adapter.history("local");
    applyEvent(adapter, "local", {
      id: "live",
      type: "permission.v2.asked",
      data: { id: "perm_1", sessionID: "local", action: "skill", resources: ["review-code"] },
    } as never);

    const items = adapter.projectionForTests("local").items().filter(item => item.type === "permission");
    expect(items).toHaveLength(1);
  });

  test("a permission answered elsewhere is revoked on load, not left answerable", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    // Answered through another client while its reply event was missed: the
    // successful pending list no longer carries it.
    provider.listPermissions = async () => [];
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    applyEvent(adapter, "local", {
      id: "live",
      type: "permission.v2.asked",
      data: { id: "perm_gone", sessionID: "local", action: "shell", resources: ["ls"] },
    } as never);

    const snapshot = await adapter.history("local");
    expect(snapshot.items).toEqual([]);
    expect(adapter.projectionForTests("local").has("permission:perm_gone")).toBe(false);
  });

  test("a failing permission list leaves already-known requests visible", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    provider.listPermissions = async () => { throw new Error("provider unreachable"); };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    applyEvent(adapter, "local", {
      id: "live",
      type: "permission.v2.asked",
      data: { id: "perm_known", sessionID: "local", action: "shell", resources: ["ls"] },
    } as never);

    // The snapshot degrades rather than erasing what the stream established.
    const snapshot = await adapter.history("local");
    expect(snapshot.items.some(item => item.id === "permission:perm_known")).toBe(true);
  });

  test("a failed permission list does not resurrect a question a successful read retired", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    // The question read succeeds and says the question is gone; the
    // permission read then fails and must not vouch for it anyway.
    provider.listQuestions = async () => [];
    provider.listPermissions = async () => { throw new Error("provider unreachable"); };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    applyEvent(adapter, "local", {
      id: "q", type: "question.v2.asked",
      data: { id: "que_stale", sessionID: "local", timestamp: 10, questions: [{ question: "Choose", header: "Choice", options: [{ label: "A", description: "A" }], multiple: false, custom: false }] },
    });
    applyEvent(adapter, "local", {
      id: "p", type: "permission.v2.asked",
      data: { id: "perm_live", sessionID: "local", action: "shell", resources: ["ls"], timestamp: 11 },
    });

    const snapshot = await adapter.history("local");
    // The permission survives its failed read; the retired question does not.
    expect(snapshot.items).toEqual([expect.objectContaining({ id: "permission:perm_live", status: "pending" })]);
    expect(adapter.projectionForTests("local").has("question:que_stale")).toBe(false);
  });

  test("the global question read vouches for mirrored child questions both ways", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    const childQuestion = {
      requestId: "que_child",
      conversationId: "child",
      questions: [{ prompt: "Pick", header: "Choice", options: [{ label: "A", description: "" }], multiple: false, allowFreeForm: false }],
    };
    let pending = [childQuestion];
    provider.listQuestions = async () => pending;
    provider.listPermissions = async () => { throw new Error("provider unreachable"); };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    // Present in the read: the child's question asked while the pump was down
    // surfaces on parent load, owned by the child.
    let snapshot = await adapter.history("parent");
    expect(snapshot.items).toEqual([expect.objectContaining({ id: "question:que_child", conversationId: "child", status: "pending" })]);

    // Absent from a later successful read: answered elsewhere, so the
    // parent's mirrored copy retires even while the permission read fails.
    pending = [];
    snapshot = await adapter.history("parent");
    expect(snapshot.items).toEqual([]);
    expect(adapter.projectionForTests("parent").has("question:que_child")).toBe(false);
  });

  test("a recovered child question answered elsewhere clears live, not just on reload", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    let pending = [{
      requestId: "que_gone",
      conversationId: "child",
      questions: [{ prompt: "Pick", header: "Choice", options: [{ label: "A", description: "" }], multiple: false, allowFreeForm: false }],
    }];
    provider.listQuestions = async () => pending;
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    // Recovered through the parent's snapshot — the child transcript is
    // never opened, so only this bookkeeping can seed the removal path.
    await adapter.history("parent");
    expect(adapter.projectionForTests("parent").has("question:que_gone")).toBe(true);

    // Answered from another client; the reply event was missed, and the next
    // question-tool update on the child is the only live signal.
    pending = [];
    const pump = adapter.startEventPump();
    provider.eventQueue.push({
      id: "t1", type: "session.next.tool.success",
      data: { sessionID: "child", callID: "c1", tool: "question" },
    } as never);
    while (adapter.projectionForTests("parent").has("question:que_gone")) await Bun.sleep(1);
    await adapter.stopEventPump();
    await pump;
  });

  // A subagent's model and cost live in its own session, which the parent's
  // client never sees. The adapter is the only place both are in scope, so it
  // sums the child's messages and materializes the total onto the row that
  // launched it.
  test("a subagent's usage aggregates across its messages and lands on the parent's row", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "running", input: { description: "Review renderer", subagent_type: "explore" }, metadata: { sessionId: "child" },
      } }],
    }] });
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    await adapter.history("parent");
    const row = () => adapter.projectionForTests("parent").items().find(item => item.type === "tool");
    expect(row()).toEqual(expect.objectContaining({ id: "tool:prt_task", childConversationId: "child" }));
    expect(row()).not.toHaveProperty("usage");

    const pump = adapter.startEventPump();
    // The child's own stream: a text part first (usage decorates the part it
    // belongs to), then the message's tokens.
    const part = (id: string) => ({
      id: `e-part-${id}`, type: "message.part.updated",
      data: { part: { id: `prt_${id}`, messageID: id, sessionID: "child", type: "text", text: "findings" } },
    });
    const message = (id: string, input: number, output: number) => ({
      id: `e-${id}-${input}`, type: "message.updated",
      data: { info: { id, sessionID: "child", role: "assistant", modelID: "claude-sonnet-4-5", time: { created: 2 }, tokens: { input, output, cache: { read: 100, write: 0 } } } },
    });
    // Two messages, and one of them restated: `message.updated` reports a
    // message's growing tokens rather than a delta, so the restatement must
    // replace that message's figure and not add to it.
    provider.eventQueue.push(part("msg_a") as never);
    provider.eventQueue.push(message("msg_a", 1_000, 10) as never);
    provider.eventQueue.push(message("msg_a", 1_200, 20) as never);
    provider.eventQueue.push(part("msg_b") as never);
    provider.eventQueue.push(message("msg_b", 800, 5) as never);
    while (sumInput(row()) !== 2_000) await Bun.sleep(1);
    expect(row()).toEqual(expect.objectContaining({
      model: "claude-sonnet-4-5",
      usage: { input: 2_000, output: 25, cacheRead: 200, cacheWrite: 0 },
    }));

    // A message that emits a second text part reports the SAME cumulative
    // tokens again, against the new part. Keyed by part, that message's spend
    // would be banked twice; keyed by message, the restatement replaces it.
    provider.eventQueue.push({
      id: "e-part-msg_b-2", type: "message.part.updated",
      data: { part: { id: "prt_msg_b_2", messageID: "msg_b", sessionID: "child", type: "text", text: "and more" } },
    } as never);
    provider.eventQueue.push(message("msg_b", 900, 7) as never);
    while (sumInput(row()) === 2_000) await Bun.sleep(1);
    expect(sumInput(row())).toBe(2_100);

    // Reopening the parent reapplies the tally rather than losing it: the
    // store has no memory of an attribution that only ever arrived live, so a
    // refresh would otherwise show costs that simply vanished.
    const reopened = await adapter.history("parent");
    expect(reopened.items.find(item => item.type === "tool")).toEqual(expect.objectContaining({
      model: "claude-sonnet-4-5",
      usage: { input: 2_100, output: 27, cacheRead: 200, cacheWrite: 0 },
    }));

    // The tool part's own later update knows nothing about attribution; it
    // must not wipe what the child reported.
    applyEvent(adapter, "parent", {
      id: "e-done", type: "message.part.updated",
      data: { part: { id: "prt_task", messageID: "m1", sessionID: "parent", type: "tool", tool: "task", callID: "c1", state: {
        status: "completed", input: { description: "Review renderer", subagent_type: "explore" }, metadata: { sessionId: "child" }, output: "done",
      } } },
    } as never);
    expect(row()).toEqual(expect.objectContaining({ status: "completed", model: "claude-sonnet-4-5", usage: { input: 2_100, output: 27, cacheRead: 200, cacheWrite: 0 } }));

    await adapter.stopEventPump();
    await pump;
  });

  test("removing a subagent message withdraws its usage now and after reopening", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "running", input: { description: "Review renderer" }, metadata: { sessionId: "child" },
      } }],
    }] });
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    await adapter.history("parent");
    const row = () => adapter.projectionForTests("parent").items().find(item => item.type === "tool");
    const pump = adapter.startEventPump();
    const report = (messageId: string, input: number) => provider.eventQueue.push({
      id: `e-${messageId}`, type: "message.updated",
      properties: { sessionID: "child", info: { id: messageId, sessionID: "child", role: "assistant", modelID: "claude-haiku", time: { created: 2 }, tokens: { input } } },
    } as never);

    report("msg_a", 700);
    report("msg_b", 300);
    while (sumInput(row()) !== 1_000) await Bun.sleep(1);
    provider.eventQueue.push({ id: "remove-a", type: "message.removed", properties: { sessionID: "child", messageID: "msg_a" } } as never);
    while (sumInput(row()) !== 300) await Bun.sleep(1);
    expect((await adapter.history("parent")).items.find(item => item.type === "tool")).toEqual(expect.objectContaining({ usage: { input: 300 } }));

    provider.eventQueue.push({ id: "remove-b", type: "message.removed", properties: { sessionID: "child", messageID: "msg_b" } } as never);
    while ((row() as { usage?: unknown } | undefined)?.usage !== undefined) await Bun.sleep(1);
    expect((await adapter.history("parent")).items.find(item => item.type === "tool")).not.toHaveProperty("usage");
    await adapter.stopEventPump();
    await pump;
  });

  test("removing the newest subagent message restores the remaining message's model", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    const parentMessages = [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "completed", input: { description: "Review renderer" }, metadata: { sessionId: "child" },
      } }],
    }];
    let childMessages = [
      { id: "msg_old", type: "assistant", modelID: "claude-haiku", time: { created: 2 }, tokens: { input: 100 } },
      { id: "msg_new", type: "assistant", modelID: "gpt-5", time: { created: 3 }, tokens: { reasoning: 50 } },
    ];
    provider.listMessages = async (sessionId) => ({ items: (sessionId === "child" ? childMessages : parentMessages) as never[] });
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const row = () => adapter.projectionForTests("parent").items().find(item => item.type === "tool");

    await adapter.history("parent");
    expect(row()).toEqual(expect.objectContaining({ model: "gpt-5", usage: { input: 100, reasoning: 50 } }));
    const pump = adapter.startEventPump();
    childMessages = [childMessages[0]!];
    provider.eventQueue.push({ id: "remove-new", type: "message.removed", properties: { sessionID: "child", messageID: "msg_new" } } as never);
    while ((row() as { model?: string } | undefined)?.model !== "claude-haiku") await Bun.sleep(1);
    expect(row()).toEqual(expect.objectContaining({ model: "claude-haiku", usage: { input: 100 } }));
    expect((row() as { usage?: Record<string, number> }).usage).not.toHaveProperty("reasoning");
    expect((await adapter.history("parent")).items.find(item => item.type === "tool"))
      .toEqual(expect.objectContaining({ model: "claude-haiku", usage: { input: 100 } }));
    await adapter.stopEventPump();
    await pump;
  });

  test("a subagent that reports nothing leaves its row readable and unattributed", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "running", input: { description: "Audit styles" }, metadata: { sessionId: "child" },
      } }],
    }] });
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    await adapter.history("parent");
    const pump = adapter.startEventPump();
    // An assistant message with no tokens at all: nothing to attribute, and a
    // zero would be a figure the agent never gave.
    provider.eventQueue.push({
      id: "e1", type: "message.updated",
      data: { info: { id: "msg", sessionID: "child", role: "assistant", time: { created: 2 } } },
    } as never);
    provider.eventQueue.push({
      id: "e2", type: "message.part.updated",
      data: { part: { id: "prt_c", messageID: "msg", sessionID: "child", type: "text", text: "working" } },
    } as never);
    await Bun.sleep(20);
    const row = adapter.projectionForTests("parent").items().find(item => item.type === "tool");
    // Still named, still carrying a status; simply nothing claimed about cost.
    expect(row).toEqual(expect.objectContaining({ id: "tool:prt_task", name: "task", input: JSON.stringify({ description: "Audit styles" }) }));
    expect(typeof (row as { status?: unknown }).status).toBe("string");
    expect(row).not.toHaveProperty("usage");
    expect(row).not.toHaveProperty("model");
    await adapter.stopEventPump();
    await pump;
  });

  test("a subagent seen only in the store is attributed from its own messages", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "completed", input: { description: "Review renderer" }, metadata: { sessionId: "child" },
      } }],
    }] });
    // The child's own history, as a fresh adapter would find it: the turn
    // finished before this process existed, so nothing was ever seen live.
    const childMessages = [
      { id: "msg_a", type: "assistant", modelID: "claude-sonnet-4-5", time: { created: 2 }, tokens: { input: 900, output: 30, cache: { read: 40, write: 0 } } },
      { id: "msg_b", type: "assistant", modelID: "claude-sonnet-4-5", time: { created: 3 }, tokens: { input: 600, output: 10, cache: { read: 0, write: 0 } } },
    ];
    let childReads = 0;
    const listMessages = provider.listMessages.bind(provider);
    provider.listMessages = async (sessionId, options) => {
      if (sessionId !== "child") return listMessages(sessionId, options);
      childReads += 1;
      return { items: childMessages as never[] };
    };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    const snapshot = await adapter.history("parent");
    expect(snapshot.items.find(item => item.type === "tool")).toEqual(expect.objectContaining({
      model: "claude-sonnet-4-5",
      usage: { input: 1_500, output: 40, cacheRead: 40, cacheWrite: 0 },
    }));
    expect(childReads).toBe(1);

    // Banked, so reopening does not pay for it again.
    await adapter.history("parent");
    expect(childReads).toBe(1);
  });

  test("a child message with only tool parts still counts toward the parent's total", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "running", input: { description: "Review renderer" }, metadata: { sessionId: "child" },
      } }],
    }] });
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    await adapter.history("parent");
    const row = () => adapter.projectionForTests("parent").items().find(item => item.type === "tool");
    const pump = adapter.startEventPump();
    // The child's whole turn is agentic: tool calls, no text part ever, so
    // nothing ever lands in the child's own timeline. The message's tokens
    // must still reach the parent's tally.
    provider.eventQueue.push({
      id: "e1", type: "message.updated",
      data: { info: { id: "msg_agentic", sessionID: "child", role: "assistant", modelID: "claude-sonnet-4-5", time: { created: 2 }, tokens: { input: 700, output: 15, cache: { read: 30, write: 0 } } } },
    } as never);
    while (!(row() as { usage?: unknown }).usage) await Bun.sleep(1);
    expect(row()).toEqual(expect.objectContaining({
      model: "claude-sonnet-4-5",
      usage: { input: 700, output: 15, cacheRead: 30, cacheWrite: 0 },
    }));
    await adapter.stopEventPump();
    await pump;
  });

  test("usage arriving during a reconstruction wins over the stored snapshot", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "completed", input: { description: "Review renderer" }, metadata: { sessionId: "child" },
      } }],
    }] });
    // The stored read is held open so live events can land mid-flight. The
    // snapshot it eventually returns is older than what the child reports
    // live while it is pending.
    let release: () => void = () => {};
    const listMessages = provider.listMessages.bind(provider);
    provider.listMessages = async (sessionId, options) => {
      if (sessionId !== "child") return listMessages(sessionId, options);
      await new Promise<void>(resolve => { release = resolve; });
      return { items: [
        { id: "msg_a", type: "assistant", modelID: "claude-haiku", time: { created: 2 }, tokens: { input: 500, output: 5, cache: { read: 0, write: 0 } } },
      ] as never[] };
    };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();

    const opening = adapter.history("parent");
    await Bun.sleep(5); // the reconstruction is now blocked inside the read
    provider.eventQueue.push({
      id: "e-live", type: "message.updated",
      data: { info: { id: "msg_a", sessionID: "child", role: "assistant", modelID: "gpt-5", time: { created: 3 }, tokens: { input: 900, output: 20, cache: { read: 0, write: 0 } } } },
    } as never);
    await Bun.sleep(20); // let the live attribution land before the read returns
    release();

    // Both the returned snapshot and later opens carry the live figure — the
    // stale stored read must not overwrite what arrived while it was in
    // flight, or the stale number would be banked permanently.
    expect((await opening).items.find(item => item.type === "tool")).toEqual(expect.objectContaining({
      model: "gpt-5",
      usage: { input: 900, output: 20, cacheRead: 0, cacheWrite: 0 },
    }));
    expect((await adapter.history("parent")).items.find(item => item.type === "tool")).toEqual(expect.objectContaining({
      model: "gpt-5",
      usage: { input: 900, output: 20, cacheRead: 0, cacheWrite: 0 },
    }));
    await adapter.stopEventPump();
    await pump;
  });

  test("concurrent snapshots share reconstruction and preserve a racing removal", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "completed", input: { description: "Review renderer" }, metadata: { sessionId: "child" },
      } }],
    }] });
    let childReads = 0;
    let release: () => void = () => {};
    const listMessages = provider.listMessages.bind(provider);
    provider.listMessages = async (sessionId, options) => {
      if (sessionId !== "child") return listMessages(sessionId, options);
      childReads += 1;
      const items = childReads === 1
        ? [{ id: "msg_removed", type: "assistant", time: { created: 2 }, tokens: { input: 500 } }]
        : [];
      if (childReads === 1) await new Promise<void>(resolve => { release = resolve; });
      return { items: items as never[] };
    };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();

    const first = adapter.history("parent");
    const second = adapter.history("parent");
    while (childReads === 0) await Bun.sleep(1);
    provider.eventQueue.push({ id: "remove", type: "message.removed", properties: { sessionID: "child", messageID: "msg_removed" } } as never);
    await Bun.sleep(20);
    release();

    for (const snapshot of await Promise.all([first, second])) {
      expect(snapshot.items.find(item => item.type === "tool")).not.toHaveProperty("usage");
    }
    // Both snapshots share one read, and the racing tombstone removes the
    // deleted message's usage and model from its result.
    expect(childReads).toBe(1);
    expect((await adapter.history("parent")).items.find(item => item.type === "tool")).not.toHaveProperty("usage");
    await adapter.stopEventPump();
    await pump;
  });

  test("eviction invalidates a stored attribution read already in flight", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    const parentMessages = [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "completed", input: { description: "Review renderer" }, metadata: { sessionId: "child" },
      } }],
    }];
    let childStore = [{ id: "msg_old", type: "assistant", time: { created: 2 }, tokens: { input: 500 } }];
    let childReads = 0;
    let release: () => void = () => {};
    provider.listMessages = async (sessionId) => {
      if (sessionId !== "child") return { items: parentMessages as never[] };
      childReads += 1;
      const snapshot = childStore;
      if (childReads === 1) await new Promise<void>(resolve => { release = resolve; });
      return { items: snapshot as never[] };
    };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1, maxProjections: 2 });
    const pump = adapter.startEventPump();

    const opening = adapter.history("parent");
    while (childReads === 0) await Bun.sleep(1);
    provider.eventQueue.push({
      id: "live", type: "message.updated",
      properties: { info: { id: "msg_live", sessionID: "child", role: "assistant", time: { created: 3 }, tokens: { input: 900 } } },
    } as never);
    await Bun.sleep(20);
    adapter.projectionForTests("other-1");
    adapter.projectionForTests("other-2");
    childStore = [...childStore, { id: "msg_live", type: "assistant", time: { created: 3 }, tokens: { input: 900 } }];
    release();

    expect((await opening).items.find(item => item.type === "tool")).not.toHaveProperty("usage");
    const reopened = await adapter.history("parent");
    expect(reopened.items.find(item => item.type === "tool")).toEqual(expect.objectContaining({ usage: { input: 1_400 } }));
    expect(childReads).toBe(2);
    await adapter.stopEventPump();
    await pump;
  });

  test("a subagent longer than a page is tallied across all its pages", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "completed", input: { description: "Review renderer" }, metadata: { sessionId: "child" },
      } }],
    }] });
    // The provider pages newest-first: the first read returns the tail of the
    // transcript with a cursor pointing at what came before it.
    const childPages = new Map<string, { items: never[]; nextCursor?: string }>([
      ["latest", { items: [
        { id: "msg_new", type: "assistant", modelID: "claude-sonnet-4-5", time: { created: 3 }, tokens: { input: 600, output: 10, cache: { read: 0, write: 0 } } },
      ] as never[], nextCursor: "older" }],
      ["older", { items: [
        { id: "msg_old", type: "assistant", modelID: "claude-haiku", time: { created: 2 }, tokens: { input: 900, output: 30, cache: { read: 40, write: 0 } } },
      ] as never[] }],
    ]);
    let childReads = 0;
    const listMessages = provider.listMessages.bind(provider);
    provider.listMessages = async (sessionId, options) => {
      if (sessionId !== "child") return listMessages(sessionId, options);
      childReads += 1;
      return childPages.get(options.cursor ?? "latest") ?? { items: [] };
    };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    const snapshot = await adapter.history("parent");
    // The tally covers the whole transcript, and the model is the child's
    // newest, not whichever page happened to be read last.
    expect(snapshot.items.find(item => item.type === "tool")).toEqual(expect.objectContaining({
      model: "claude-sonnet-4-5",
      usage: { input: 1_500, output: 40, cacheRead: 40, cacheWrite: 0 },
    }));
    expect(childReads).toBe(2);

    // Banked as one answer: reopening re-reads nothing.
    await adapter.history("parent");
    expect(childReads).toBe(2);
  });

  test("a subagent that reported nothing is read once and not asked again", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "completed", input: { description: "Audit styles" }, metadata: { sessionId: "child" },
      } }],
    }] });
    let childReads = 0;
    const listMessages = provider.listMessages.bind(provider);
    provider.listMessages = async (sessionId, options) => {
      if (sessionId !== "child") return listMessages(sessionId, options);
      childReads += 1;
      return { items: [] };
    };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    const snapshot = await adapter.history("parent");
    // Still a readable row asserting no figure — and an empty answer is an
    // answer, so it is not re-asked.
    expect(snapshot.items.find(item => item.type === "tool")).not.toHaveProperty("usage");
    await adapter.history("parent");
    expect(childReads).toBe(1);
  });

  test("a failed child read is unknown, not empty, and is retried", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "completed", input: { description: "Review renderer" }, metadata: { sessionId: "child" },
      } }],
    }] });
    let fail = true;
    const listMessages = provider.listMessages.bind(provider);
    provider.listMessages = async (sessionId, options) => {
      if (sessionId !== "child") return listMessages(sessionId, options);
      if (fail) throw new Error("provider unreachable");
      return { items: [{ id: "msg_a", type: "assistant", modelID: "gpt-5", time: { created: 2 }, tokens: { input: 500 } }] as never[] };
    };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    // The error degrades the row rather than the snapshot, and banks nothing —
    // caching it as "no usage" would hide the cost permanently.
    expect((await adapter.history("parent")).items.find(item => item.type === "tool")).not.toHaveProperty("usage");
    fail = false;
    expect((await adapter.history("parent")).items.find(item => item.type === "tool")).toEqual(expect.objectContaining({
      model: "gpt-5",
      usage: { input: 500 },
    }));
  });

  test("a subagent that starts and reports inside one coalescer window still lands on its row", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 25 });
    await adapter.history("parent");
    const pump = adapter.startEventPump();
    // The task row and the child's whole report enter one buffer window: when
    // the usage arrives, the parent's row is not in the projection yet, so
    // the live decoration path finds nothing. The flush must settle the
    // banked figures onto the row it just materialized — a fast child that
    // never speaks again gives no later event to retry on.
    provider.eventQueue.push({
      id: "e-task", type: "message.part.updated",
      data: { part: { id: "prt_task", messageID: "m1", sessionID: "parent", type: "tool", tool: "task", callID: "c1", state: {
        status: "running", input: { description: "Quick check" }, metadata: { sessionId: "child" },
      } } },
    } as never);
    provider.eventQueue.push({
      id: "e-msg", type: "message.updated",
      data: { info: { id: "msg_fast", sessionID: "child", role: "assistant", modelID: "claude-haiku", time: { created: 2 }, tokens: { input: 120 } } },
    } as never);
    const row = () => adapter.projectionForTests("parent").items().find(item => item.type === "tool");
    while (!(row() as { usage?: unknown } | undefined)?.usage) await Bun.sleep(5);
    expect(row()).toEqual(expect.objectContaining({ model: "claude-haiku", usage: { input: 120 } }));
    await adapter.stopEventPump();
    await pump;
  });

  test("a tally rebuilt by live events after an eviction is not mistaken for complete", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "running", input: { description: "Review renderer" }, metadata: { sessionId: "child" },
      } }],
    }] });
    // The child's store holds what was reported before the eviction; the
    // stored figure for msg_a is deliberately staler than what arrived live.
    let childStore: never[] = [];
    const listMessages = provider.listMessages.bind(provider);
    provider.listMessages = async (sessionId, options) => {
      if (sessionId !== "child") return listMessages(sessionId, options);
      return { items: childStore };
    };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1, maxProjections: 2 });
    await adapter.history("parent");
    const pump = adapter.startEventPump();
    const report = (suffix: string, input: number) => {
      provider.eventQueue.push({
        id: `e-part-${suffix}`, type: "message.part.updated",
        data: { part: { id: `prt_${suffix}`, messageID: `msg_${suffix}`, sessionID: "child", type: "text", text: "findings" } },
      } as never);
      provider.eventQueue.push({
        id: `e-msg-${suffix}`, type: "message.updated",
        data: { info: { id: `msg_${suffix}`, sessionID: "child", role: "assistant", time: { created: 2 }, tokens: { input } } },
      } as never);
    };
    const row = () => adapter.projectionForTests("parent").items().find(item => item.type === "tool");

    report("a", 500);
    while (sumInput(row()) !== 500) await Bun.sleep(1);
    childStore = [{ id: "msg_a", type: "assistant", time: { created: 2 }, tokens: { input: 500 } }] as never[];

    // Two other conversations push the parent out of the LRU, and the tally
    // kept for its subagent goes with it. The child keeps running: its next
    // report recreates a map holding only the post-eviction message.
    adapter.projectionForTests("other-1");
    adapter.projectionForTests("other-2");

    report("b", 700);
    await Bun.sleep(20);

    // Reopened, the partial rebuild must not pass for the whole answer: the
    // pre-eviction 500 is recovered from the child's store and merged with
    // the 700 that arrived live after the eviction.
    await adapter.history("parent");
    expect(sumInput(row())).toBe(1_200);
    report("c", 300);
    while (sumInput(row()) !== 1_500) await Bun.sleep(1);
    expect(sumInput(row())).toBe(1_500);

    await adapter.stopEventPump();
    await pump;
  });

  test("a child question answered from the parent seeds an empty owning projection", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.listQuestions = async () => [{
      requestId: "que_child",
      conversationId: "child",
      questions: [{ prompt: "Pick", header: "Choice", options: [{ label: "A", description: "" }], multiple: false, allowFreeForm: false }],
    }];
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    // The parent shows the card; the child's transcript was never opened, so
    // its projection is empty when the answer arrives.
    await adapter.history("parent");
    await adapter.respondQuestion("child", "que_child", "client-1", { kind: "answered", answers: [["A"]] });
    expect(provider.questionReplies).toEqual([{ sessionId: "child", requestId: "que_child", answers: [["A"]] }]);
  });

  test("a provider without the list simply never recovers, and does not throw", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    expect((await adapter.history("local")).items).toEqual([]);
  });

  test("a resolution whose ask was never projected is suppressed, not published invalid", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    // The classic replied event carries no action or resources; without the
    // ask to merge into, publishing it would fail client validation and force
    // a resync on every snapshot that repeats the item.
    applyEvent(adapter, "local", {
      id: "orphan",
      type: "permission.replied",
      data: { sessionID: "local", requestID: "perm_ghost", reply: "once", timestamp: 10 },
    } as never);
    expect(adapter.projectionForTests("local").items()).toEqual([]);
  });
});

describe("a subagent's request reaches the conversation that launched it", () => {
  function withChild() {
    const provider = new FakeProvider();
    provider.sessions = [
      fixtureSession("parent"),
      { ...fixtureSession("child"), parentId: "parent" },
    ];
    return provider;
  }
  const asked = (id: string) => ({
    id, type: "permission.v2.asked",
    data: { id, sessionID: "child", action: "bash", resources: ["rm -rf build"], timestamp: 10 },
  });

  test("appears in the parent, owned by the child, and is answerable there", async () => {
    const provider = withChild();
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();
    provider.eventQueue.push(asked("perm-1") as never);
    while (adapter.projectionForTests("parent").items().length === 0) await Bun.sleep(1);

    const mirrored = adapter.projectionForTests("parent").items()[0]!;
    expect(mirrored).toEqual(expect.objectContaining({
      id: "permission:perm-1",
      type: "permission",
      // The child owns it — that is what routes the answer correctly.
      conversationId: "child",
      status: "pending",
    }));
    // It is in the child's own transcript too.
    expect(adapter.projectionForTests("child").items()).toHaveLength(1);

    // Answering addresses the child, and replies exactly once.
    await adapter.respondPermission("child", "perm-1", "client-1", "approved-once");
    expect(provider.permissionReplies).toEqual([{ sessionId: "child", requestId: "perm-1", reply: "once" }]);

    await adapter.stopEventPump();
    await pump;
  });

  test("resolving in the child clears the parent's copy", async () => {
    const provider = withChild();
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();
    provider.eventQueue.push(asked("perm-2") as never);
    while (adapter.projectionForTests("parent").items().length === 0) await Bun.sleep(1);

    provider.eventQueue.push({
      id: "replied", type: "permission.v2.replied",
      data: { sessionID: "child", requestID: "perm-2", reply: "once", timestamp: 11 },
    } as never);
    const permissionStatus = (conversation: string) => {
      const item = adapter.projectionForTests(conversation).items()[0];
      return item?.type === "permission" ? item.status : undefined;
    };
    while (permissionStatus("parent") !== "resolved") await Bun.sleep(1);

    for (const conversation of ["parent", "child"]) {
      const item = adapter.projectionForTests(conversation).items()[0]!;
      expect(item).toEqual(expect.objectContaining({ status: "resolved" }));
    }
    await adapter.stopEventPump();
    await pump;
  });

  test("a reconciled subagent question reaches the parent and clears when withdrawn", async () => {
    const provider = withChild();
    let pending = [{
      requestId: "que-1",
      conversationId: "child",
      questions: [{ prompt: "Pick one", header: "Choice", options: [{ label: "A", description: "" }], multiple: false, allowFreeForm: false }],
    }];
    provider.listQuestions = async () => pending;
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();
    // The question tool part is the only live signal a question exists; the
    // asked event never fires, so this fallback is the parent's only chance.
    provider.eventQueue.push({
      id: "t1", type: "session.next.tool.called",
      data: { sessionID: "child", callID: "c1", tool: "question" },
    } as never);
    const parentQuestion = () => adapter.projectionForTests("parent").items().find(item => item.type === "question");
    while (!parentQuestion()) await Bun.sleep(1);
    expect(parentQuestion()).toEqual(expect.objectContaining({
      id: "question:que-1",
      conversationId: "child",
      status: "pending",
    }));

    // Withdrawn (answered from the CLI): the parent's copy must clear too.
    pending = [];
    provider.eventQueue.push({
      id: "t2", type: "session.next.tool.success",
      data: { sessionID: "child", callID: "c1", tool: "question" },
    } as never);
    while (parentQuestion()) await Bun.sleep(1);
    await adapter.stopEventPump();
    await pump;
  });

  test("a newer subagent request does not block answering the parent's own", async () => {
    const provider = withChild();
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();
    provider.eventQueue.push({
      id: "own", type: "permission.v2.asked",
      data: { id: "perm-own", sessionID: "parent", action: "bash", resources: ["bun test"], timestamp: 10 },
    } as never);
    provider.eventQueue.push({
      id: "mirrored", type: "permission.v2.asked",
      data: { id: "perm-late", sessionID: "child", action: "bash", resources: ["rm -rf build"], timestamp: 20 },
    } as never);
    while (adapter.projectionForTests("parent").items().length < 2) await Bun.sleep(1);

    // The renderer enables one request per owning conversation; the guard
    // must admit the same set, not just the globally newest.
    await adapter.respondPermission("parent", "perm-own", "client-own", "approved-once");
    await adapter.respondPermission("child", "perm-late", "client-late", "rejected");
    expect(provider.permissionReplies).toEqual([
      { sessionId: "parent", requestId: "perm-own", reply: "once" },
      { sessionId: "child", requestId: "perm-late", reply: "reject" },
    ]);
    await adapter.stopEventPump();
    await pump;
  });

  test("a request from a parentless conversation is not mirrored anywhere", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("solo")];
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();
    provider.eventQueue.push({
      id: "perm-3", type: "permission.v2.asked",
      data: { id: "perm-3", sessionID: "solo", action: "bash", resources: ["ls"], timestamp: 10 },
    } as never);
    while (adapter.projectionForTests("solo").items().length === 0) await Bun.sleep(1);
    expect(adapter.projectionForTests("solo").items()[0]).toEqual(expect.objectContaining({ conversationId: "solo" }));
    await adapter.stopEventPump();
    await pump;
  });
});

describe("a subagent's pending request is reconciled into its parent", () => {
  // The live-event path is not enough: OpenCode does not deliver a subagent's
  // permission on the main stream, so the parent must find it by asking.
  function withPendingChildRequest() {
    const provider = new FakeProvider();
    provider.sessions = [
      fixtureSession("parent"),
      { ...fixtureSession("child"), parentId: "parent" },
    ];
    provider.listPermissions = async () => [
      { requestId: "perm-child", conversationId: "child", action: "bash", resources: ["echo from-subagent"] },
    ];
    return provider;
  }

  test("appears in the parent on load, owned by the child", async () => {
    const provider = withPendingChildRequest();
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const snapshot = await adapter.history("parent");
    expect(snapshot.items).toEqual([expect.objectContaining({
      id: "permission:perm-child",
      type: "permission",
      conversationId: "child",
      action: "bash",
      status: "pending",
    })]);
  });

  test("answering it from the parent replies once, for the child", async () => {
    const provider = withPendingChildRequest();
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    await adapter.history("parent");
    // The client addresses the owner, which is what the item carries.
    await adapter.respondPermission("child", "perm-child", "client-1", "approved-once");
    expect(provider.permissionReplies).toEqual([{ sessionId: "child", requestId: "perm-child", reply: "once" }]);
  });

  test("answering also resolves the parent's mirrored copy, not just the child's", async () => {
    const provider = withPendingChildRequest();
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    await adapter.history("parent");
    await adapter.respondPermission("child", "perm-child", "client-1", "approved-once");
    // A recovered request may never produce a replied event for the pump to
    // mirror, so the answer itself must clear the parent's copy — otherwise
    // the parent counts an already-answered request forever.
    expect(adapter.projectionForTests("parent").items()).toEqual([
      expect.objectContaining({ id: "permission:perm-child", status: "resolved", outcome: "approved-once" }),
    ]);
  });

  test("a transient parent-lookup failure does not permanently hide the child's request", async () => {
    const provider = withPendingChildRequest();
    const lookup = provider.getSession.bind(provider);
    let failing = true;
    provider.getSession = async (id: string) => {
      if (failing && id === "child") throw new Error("provider unreachable");
      return lookup(id);
    };
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    // Degraded while the provider errors — unknown, not empty…
    expect((await adapter.history("parent")).items).toEqual([]);
    failing = false;
    // …and recovered on the next load, rather than cached as "no parent".
    expect((await adapter.history("parent")).items).toEqual([
      expect.objectContaining({ id: "permission:perm-child", conversationId: "child", status: "pending" }),
    ]);
  });

  test("an unrelated conversation's request is not pulled in", async () => {
    const provider = withPendingChildRequest();
    provider.sessions.push({ ...fixtureSession("stranger") });
    provider.listPermissions = async () => [
      { requestId: "perm-other", conversationId: "stranger", action: "bash", resources: ["ls"] },
    ];
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    expect((await adapter.history("parent")).items).toEqual([]);
  });
});
