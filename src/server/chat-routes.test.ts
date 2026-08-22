import { describe, expect, test } from "bun:test";
import path from "node:path";

import { ConversationReplay, encodeReplayCursor } from "../chat/replay";
import type { WorkspaceChatService } from "../chat/service";
import type { ChatAvailability, ConversationSnapshot, ConversationSummary, ModelSelection, PermissionOutcome, QuestionOutcome } from "../chat/types";
import { ConversationNotFoundError } from "../chat/workspace";
import { ConversationRenameUnsupportedError, QueuedMessageNotHeldError } from "../chat/adapter";
import { buildRoutes } from "./routes";

const TOKEN = "chat-test-token";

class FakeChatService implements WorkspaceChatService {
  readonly conversation: ConversationSummary = { id: "local", title: "Local", createdAt: 1, updatedAt: 1, status: "idle" };
  readonly replay = new ConversationReplay("generation", "local", 10_000);
  prompts = 0;
  retries = 0;
  renames = 0;
  private promptResult: { messageId: string; held: boolean } | undefined;
  selectedModel: ModelSelection | undefined;
  selectedAgent: string | undefined;
  questionResponses: QuestionOutcome[] = [];
  removals: string[] = [];

  async status(): Promise<ChatAvailability> { return { state: "ready", version: "test" }; }
  async retry(): Promise<ChatAvailability> { this.retries += 1; return this.status(); }
  async models() { return [{ selection: { providerId: "anthropic", modelId: "claude" }, provider: "Anthropic", name: "Claude" }]; }
  async modes() { return [{ name: "build", description: "Full read-write mode" }, { name: "plan", description: "Read-only planning mode" }]; }
  async commands() { return [{ name: "review", description: "Review", argumentHint: "[focus]", kind: "command" as const }]; }
  async listConversations() { return [this.conversation]; }
  async createConversation() { return this.snapshot(); }
  async history(id: string) { this.require(id); return this.snapshot(); }
  async subscribe(id: string, options: { cursor?: string; signal?: AbortSignal } = {}) {
    this.require(id);
    const handoff = this.replay.handoff(() => this.snapshot(), options.cursor, options.signal);
    return { snapshot: handoff.snapshot, events: handoff.subscription };
  }
  async prompt(id: string, requestId: string, _text: string, model?: ModelSelection, agent?: string) {
    this.require(id);
    this.selectedModel = model;
    this.selectedAgent = agent;
    if (!this.promptResult) {
      this.prompts += 1;
      this.promptResult = { messageId: requestId, held: false };
    }
    return { ...this.promptResult, configuration: { ...(model ? { model } : {}), ...(agent ? { mode: agent } : {}) } };
  }
  async removeQueued(id: string, messageId: string, _requestId: string) {
    this.require(id);
    if (messageId === "delivered") throw new QueuedMessageNotHeldError();
    this.removals.push(messageId);
    return { removed: true } as const;
  }
  async renameConversation(id: string, _requestId: string, title: string) {
    this.require(id);
    this.renames += 1;
    return { conversation: { ...this.conversation, title } };
  }
  async cancel(id: string) { this.require(id); return { cancelled: true } as const; }
  async respondPermission(id: string, _interactionId: string, _requestId: string, outcome: PermissionOutcome) { this.require(id); return { outcome }; }
  async respondQuestion(id: string, _interactionId: string, _requestId: string, outcome: QuestionOutcome) { this.require(id); this.questionResponses.push(outcome); return { outcome }; }
  async dispose() {}

  private snapshot(): ConversationSnapshot {
    return { conversation: this.conversation, configuration: {}, generation: "generation", cursor: this.replay.latestCursor(), items: [] };
  }
  private require(id: string) { if (id !== "local") throw new ConversationNotFoundError(); }
}

function routes(chatService = new FakeChatService(), basePath = "/") {
  const repo = path.resolve(import.meta.dir, "..", "..");
  return buildRoutes({
    mode: "prod",
    basePath,
    assets: {
      mermaid: path.join(repo, "node_modules/mermaid/dist/mermaid.min.js"),
      logo: path.join(repo, "src/assets/uatu-logo.svg"),
      icon192: path.join(repo, "src/assets/icon-192.png"),
      icon512: path.join(repo, "src/assets/icon-512.png"),
      manifest: path.join(repo, "src/assets/manifest.webmanifest"),
      fonts: {
        hackMono: path.join(repo, "src/assets/fonts/HackNerdFontMono-Regular.woff2"),
        hackLicense: path.join(repo, "src/assets/fonts/LICENSE-hack.md"),
        nerdFontsLicense: path.join(repo, "src/assets/fonts/LICENSE-nerdfonts.txt"),
        notices: path.join(repo, "src/assets/fonts/NOTICES.md"),
      },
    },
    getSession: (() => { throw new Error("unused"); }) as never,
    chatService,
    getWorkspaceCredential: () => TOKEN,
    debug: false,
    getMetricsSnapshot: () => ({}),
  });
}

function request(pathname: string, init: RequestInit = {}, params?: Record<string, string>) {
  const separator = pathname.includes("?") ? "&" : "?";
  const value = new Request(`http://127.0.0.1:4711${pathname}${separator}t=${TOKEN}`, init) as Request & { params?: Record<string, string> };
  value.params = params;
  return value;
}

describe("workspace chat routes", () => {
  test("requires the child credential for every read without starting chat", async () => {
    let calls = 0;
    const service = new FakeChatService();
    service.status = async () => { calls += 1; return { state: "ready", version: "test" }; };
    service.models = async () => { calls += 1; return []; };
    const table = routes(service);
    service.commands = async () => { calls += 1; return []; };
    for (const pathname of ["/api/chat/status", "/api/chat/models", "/api/chat/commands"]) {
      const handler = table[pathname] as { GET(request: Request): Promise<Response> };
      expect((await handler.GET(new Request(`http://127.0.0.1:4711${pathname}`))).status).toBe(401);
    }
    expect(calls).toBe(0);
  });

  test("serves status, inventory, creation, and snapshot under a relocated base path", async () => {
    const table = routes(new FakeChatService(), "/s/project/");
    expect(Object.keys(table).filter(key => key.includes("/api/chat/")).every(key => key.startsWith("/s/project/"))).toBe(true);
    const status = table["/s/project/api/chat/status"] as { GET(request: Request): Promise<Response> };
    expect(await (await status.GET(request("/s/project/api/chat/status"))).json()).toEqual({ state: "ready", version: "test" });
    const models = table["/s/project/api/chat/models"] as { GET(request: Request): Promise<Response> };
    expect(await (await models.GET(request("/s/project/api/chat/models"))).json()).toEqual({ models: [expect.objectContaining({ name: "Claude" })] });
    const commands = table["/s/project/api/chat/commands"] as { GET(request: Request): Promise<Response> };
    expect(await (await commands.GET(request("/s/project/api/chat/commands"))).json()).toEqual({ commands: [expect.objectContaining({ name: "review" })] });
    const inventory = table["/s/project/api/chat/conversations"] as { GET(request: Request): Promise<Response>; POST(request: Request): Promise<Response> };
    expect(await (await inventory.GET(request("/s/project/api/chat/conversations"))).json()).toEqual({ conversations: [expect.objectContaining({ id: "local" })] });
    const created = await inventory.POST(request("/s/project/api/chat/conversations", {
      method: "POST", headers: { origin: "http://127.0.0.1:4711", "content-type": "application/json" }, body: "{}",
    }));
    expect(created.status).toBe(201);
    const snapshot = table["/s/project/api/chat/conversations/:conversationId"] as { GET(request: Request & { params: Record<string, string> }): Promise<Response> };
    expect((await (await snapshot.GET(request("/s/project/api/chat/conversations/local?limit=50", {}, { conversationId: "local" }) as never)).json() as { conversation: { id: string } }).conversation.id).toBe("local");
  });

  test("rejects foreign origins and malformed bodies before mutation, and joins retried prompts", async () => {
    const service = new FakeChatService();
    const handler = routes(service)["/api/chat/conversations/:conversationId/prompts"] as { POST(request: Request & { params: Record<string, string> }): Promise<Response> };
    const send = (body: unknown, origin = "http://127.0.0.1:4711") => handler.POST(request("/api/chat/conversations/local/prompts", {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
    }, { conversationId: "local" }) as never);
    expect((await send({ requestId: "r1", text: "hello" }, "https://attacker.example")).status).toBe(403);
    expect((await send({ requestId: "r1", text: "hello", directory: "/tmp/foreign" })).status).toBe(400);
    const first = await send({ requestId: "r1", text: "hello" });
    const duplicate = await send({ requestId: "r1", text: "hello" });
    expect(first.status).toBe(202);
    expect(await duplicate.json()).toEqual(await first.json());
    expect(service.prompts).toBe(1);
  });

  test("removes a held message, guards the origin, and maps a delivered message to conflict", async () => {
    const service = new FakeChatService();
    const handler = routes(service)["/api/chat/conversations/:conversationId/queue/:messageId"] as { DELETE(request: Request & { params: Record<string, string> }): Promise<Response> };
    const send = (messageId: string, body: unknown = { requestId: "remove-1" }, origin = "http://127.0.0.1:4711") => handler.DELETE(request(`/api/chat/conversations/local/queue/${messageId}`, {
      method: "DELETE", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
    }, { conversationId: "local", messageId }) as never);

    expect((await send("held-1", { requestId: "remove-1" }, "https://attacker.example")).status).toBe(403);
    expect((await send("held-1", { messageId: "held-1" })).status).toBe(400);
    const removed = await send("held-1");
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true });
    expect(service.removals).toEqual(["held-1"]);

    // A message the workspace already delivered is refused, and the client
    // learns it is no longer held.
    const conflict = await send("delivered");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "message is no longer held" });

    const foreign = handler.DELETE(request("/api/chat/conversations/other/queue/held-1", {
      method: "DELETE", headers: { origin: "http://127.0.0.1:4711", "content-type": "application/json" }, body: JSON.stringify({ requestId: "remove-2" }),
    }, { conversationId: "other", messageId: "held-1" }) as never);
    expect((await foreign).status).toBe(404);
  });

  test("accepts only a strict model selection and forwards it to the service", async () => {
    const service = new FakeChatService();
    const handler = routes(service)["/api/chat/conversations/:conversationId/prompts"] as { POST(request: Request & { params: Record<string, string> }): Promise<Response> };
    const send = (model: unknown) => handler.POST(request("/api/chat/conversations/local/prompts", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:4711", "content-type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), text: "hello", model }),
    }, { conversationId: "local" }) as never);
    expect((await send({ providerId: "anthropic", modelId: "claude", variant: "fast" })).status).toBe(400);
    expect((await send({ providerId: "anthropic", modelId: "claude" })).status).toBe(202);
    expect(service.selectedModel).toEqual({ providerId: "anthropic", modelId: "claude" });
  });

  test("lists modes and forwards a well-formed mode selection to the service", async () => {
    const service = new FakeChatService();
    const table = routes(service);
    const modes = table["/api/chat/modes"] as { GET(request: Request): Promise<Response> };
    expect(await (await modes.GET(request("/api/chat/modes"))).json()).toEqual({
      modes: [expect.objectContaining({ name: "build" }), expect.objectContaining({ name: "plan" })],
    });
    const handler = table["/api/chat/conversations/:conversationId/prompts"] as { POST(request: Request & { params: Record<string, string> }): Promise<Response> };
    const send = (mode: unknown) => handler.POST(request("/api/chat/conversations/local/prompts", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:4711", "content-type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), text: "hello", mode }),
    }, { conversationId: "local" }) as never);
    expect((await send(42)).status).toBe(400);
    expect((await send("")).status).toBe(400);
    expect((await send("build")).status).toBe(202);
    expect(service.selectedAgent).toBe("build");
  });

  test("returns identical non-revealing errors for unknown and foreign conversation identities", async () => {
    const handler = routes()["/api/chat/conversations/:conversationId"] as { GET(request: Request & { params: Record<string, string> }): Promise<Response> };
    const unknown = await handler.GET(request("/api/chat/conversations/unknown", {}, { conversationId: "unknown" }) as never);
    const foreign = await handler.GET(request("/api/chat/conversations/foreign", {}, { conversationId: "foreign" }) as never);
    expect(unknown.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(await unknown.text()).toBe(await foreign.text());
  });

  test("renames through the authenticated same-origin conversation mutation with a strict bounded body", async () => {
    const service = new FakeChatService();
    const handler = routes(service)["/api/chat/conversations/:conversationId"] as {
      PATCH(request: Request & { params: Record<string, string> }): Promise<Response>;
    };
    const send = (body: unknown, origin = "http://127.0.0.1:4711") => handler.PATCH(request("/api/chat/conversations/local", {
      method: "PATCH",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    }, { conversationId: "local" }) as never);

    expect((await send({ requestId: "r1", title: "Renamed" }, "https://attacker.example")).status).toBe(403);
    expect((await send({ requestId: "r1", title: "Renamed", directory: "/tmp" })).status).toBe(400);
    expect((await send({ requestId: "r1", title: "   " })).status).toBe(400);
    expect((await send({ requestId: "r1", title: "é".repeat(101) })).status).toBe(400);
    expect((await send({ title: "Missing receipt" })).status).toBe(400);
    const renamed = await send({ requestId: "r1", title: "  Renamed  " });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ conversation: expect.objectContaining({ id: "local", title: "Renamed" }) });
    expect(service.renames).toBe(1);

    const unauthenticated = new Request("http://127.0.0.1:4711/api/chat/conversations/local", {
      method: "PATCH",
      headers: { origin: "http://127.0.0.1:4711", "content-type": "application/json" },
      body: JSON.stringify({ requestId: "r2", title: "No" }),
    }) as Request & { params: Record<string, string> };
    unauthenticated.params = { conversationId: "local" };
    expect((await handler.PATCH(unauthenticated)).status).toBe(401);
  });

  test("normalizes rename not-found and unsupported errors", async () => {
    const service = new FakeChatService();
    const handler = routes(service)["/api/chat/conversations/:conversationId"] as {
      PATCH(request: Request & { params: Record<string, string> }): Promise<Response>;
    };
    const send = () => handler.PATCH(request("/api/chat/conversations/local", {
      method: "PATCH",
      headers: { origin: "http://127.0.0.1:4711", "content-type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), title: "Title" }),
    }, { conversationId: "local" }) as never);

    service.renameConversation = async () => { throw new ConversationRenameUnsupportedError(); };
    expect((await send()).status).toBe(409);
    service.renameConversation = async () => { throw new ConversationNotFoundError(); };
    expect((await send()).status).toBe(404);
  });

  test("rejects empty and whitespace-only question answers before calling the service", async () => {
    const service = new FakeChatService();
    const handler = routes(service)["/api/chat/conversations/:conversationId/questions/:interactionId"] as {
      POST(request: Request & { params: Record<string, string> }): Promise<Response>;
    };
    const send = (answers: string[][]) => handler.POST(request("/api/chat/conversations/local/questions/question-1", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:4711", "content-type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), outcome: { kind: "answered", answers } }),
    }, { conversationId: "local", interactionId: "question-1" }) as never);

    expect((await send([[]])).status).toBe(400);
    expect((await send([["   "]])).status).toBe(400);
    expect(service.questionResponses).toEqual([]);
  });

  test("streams retained events immediately with replay IDs and no-buffering headers", async () => {
    const service = new FakeChatService();
    const cursor = encodeReplayCursor({ generation: "generation", sequence: 0 });
    service.replay.publish({ type: "conversation.status", status: "running" });
    const handler = routes(service)["/api/chat/conversations/:conversationId/events"] as { GET(request: Request & { params: Record<string, string> }): Promise<Response> };
    const response = await handler.GET(request("/api/chat/conversations/local/events", {
      headers: { "last-event-id": cursor },
    }, { conversationId: "local" }) as never);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const reader = response.body!.getReader();
    const first = await reader.read();
    const frame = new TextDecoder().decode(first.value);
    expect(frame).toContain("event: chat");
    expect(frame).toContain("id: ");
    expect(JSON.parse(frame.match(/data: (.+)\n/)![1]!)).toEqual(expect.objectContaining({ type: "conversation.status", sequence: 1 }));
    await reader.cancel();
  });
});
