import { describe, expect, test } from "bun:test";

import { deriveConversationTitle, InteractionConflictError, InvalidModelSelectionError, OpenCodeChatAdapter, parseSlashCommand } from "./adapter";
import { normalizeProviderEvent } from "./normalization";
import type {
  OpenCodeProvider,
  ProviderEvent,
  ProviderMessage,
  ProviderPage,
  ProviderPermissionReply,
  ProviderSession,
} from "./provider";
import type { ChatEvent, ChatModel, ModelSelection } from "./types";
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
  commands = [
    { name: "review", description: "Review", argumentHint: "[focus]", kind: "command" as const },
    { name: "compact", description: "Compact", argumentHint: "", kind: "command" as const },
  ];
  models: ChatModel[] = [{ selection: { providerId: "anthropic", modelId: "claude" }, provider: "Anthropic", name: "Claude" }];
  sessions: ProviderSession[] = [];
  pages = new Map<string, ProviderPage<ProviderMessage>>();
  eventQueue = new EventQueue();
  prompts: Array<{ sessionId: string; id: string; text: string; delivery: "steer" | "queue" }> = [];
  commandCalls: Array<{ sessionId: string; id: string; name: string; arguments: string; model?: ModelSelection }> = [];
  permissionReplies: Array<{ sessionId: string; requestId: string; reply: ProviderPermissionReply }> = [];
  questionReplies: Array<{ sessionId: string; requestId: string; answers?: string[][]; rejected?: true }> = [];
  interrupts: string[] = [];
  modelSwitches: Array<{ sessionId: string; selection: ModelSelection }> = [];
  renameSession?: OpenCodeProvider["renameSession"];
  listPermissions?: OpenCodeProvider["listPermissions"];

  async listCommands() { return this.commands; }
  async listModels() { return this.models; }
  async switchModel(sessionId: string, selection: ModelSelection) { this.modelSwitches.push({ sessionId, selection }); }

  async listSessions() { return this.sessions; }
  async createSession(id: string) {
    const session = fixtureSession(id, process.cwd(), this.sessions.length + 1);
    this.sessions.push(session);
    return session;
  }
  async getSession(id: string) { return this.sessions.find(session => session.id === id) ?? null; }
  async listMessages(_sessionId: string, options: { cursor?: string; limit: number }) {
    return this.pages.get(options.cursor ?? "first") ?? { items: [] };
  }
  events(signal: AbortSignal): AsyncIterable<ProviderEvent> {
    signal.addEventListener("abort", () => this.eventQueue.close(), { once: true });
    return this.eventQueue;
  }
  async prompt(sessionId: string, input: { id: string; text: string; delivery: "steer" | "queue" }) {
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
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => "created" });
    const created = await adapter.createConversation();
    expect(created).toEqual(expect.objectContaining({
      conversation: expect.objectContaining({ id: "created" }),
      generation: "g",
      items: [],
    }));
    expect(await adapter.getConversation("created")).toEqual(expect.objectContaining({ id: "created" }));
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
    expect(accepted).toEqual({ messageId: "message", delivery: "queue" });
    expect(provider.commandCalls).toEqual([{ sessionId: "session", id: "message", name: "review", arguments: "API compatibility", model }]);
    expect(provider.prompts).toEqual([]);

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

  test("joins duplicate prompts, steers while running, and preserves content on abort", async () => {
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
    expect(first.delivery).toBe("queue");
    expect(projection.status).toBe("running");

    expect((await adapter.prompt("session", "request-2", "steer")).delivery).toBe("steer");
    await Promise.all([adapter.abort("session", "cancel-1"), adapter.abort("session", "cancel-1")]);
    expect(provider.interrupts).toEqual(["session"]);
    expect(projection.status).toBe("interrupted");
    expect(projection.items()).toContainEqual(expect.objectContaining({ id: "part:answer", markdown: "Completed content" }));
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
    provider.listPermissions = async () => [{ requestId: "perm_1", conversationId: "local", action: "skill", resources: ["review-code"] }];
    const adapter = new OpenCodeChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    const snapshot = await adapter.history("local");
    expect(snapshot.items).toEqual([expect.objectContaining({
      id: "permission:perm_1",
      type: "permission",
      action: "skill",
      resources: ["review-code"],
      status: "pending",
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
