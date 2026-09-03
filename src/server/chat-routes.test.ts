import { describe, expect, test } from "bun:test";
import path from "node:path";

import { ConversationReplay, encodeReplayCursor } from "../chat/replay";
import { AttachmentStoreError, sniffImageMime, type StoredAttachment } from "../chat/attachment-store";
import { ConversationInventoryBroadcaster } from "../chat/inventory-broadcaster";
import type { WorkspaceChatService } from "../chat/service";
import type { ChatAvailability, ConversationSnapshot, ConversationSummary, MessageAttachment, ModelSelection, PermissionOutcome, QuestionOutcome, ReversibleHistoryResult } from "../chat/types";
import { ConversationNotFoundError } from "../chat/workspace";
import { ConversationRenameUnsupportedError, QueuedMessageNotHeldError, ReversibleHistoryUnsupportedError } from "../chat/adapter";
import { ReversibleHistoryTargetError, InvalidQuestionAnswerError } from "../chat/provider";
import { MetricsRegistry } from "../debug/metrics";
import { activeGauge, closedCounter, openedCounter, reconnectedCounter } from "../debug/stream-metrics";
import { buildRoutes } from "./routes";
import { MultiAgentChatService } from "../chat/agents";

const TOKEN = "chat-test-token";

class FakeChatService implements WorkspaceChatService {
  readonly conversation: ConversationSummary = { id: "local", title: "Local", createdAt: 1, updatedAt: 1, status: "idle" };
  readonly replay = new ConversationReplay("generation", "local", 10_000);
  readonly inventory = new ConversationInventoryBroadcaster();
  prompts = 0;
  retries = 0;
  renames = 0;
  private promptResult: { messageId: string; held: boolean } | undefined;
  selectedModel: ModelSelection | undefined;
  selectedAgent: string | undefined;
  questionResponses: QuestionOutcome[] = [];
  rejectAnswers: Error | null = null;
  stoppedTasks: string[] = [];
  removals: string[] = [];
  reversibleMutations = { undo: 0, redo: 0, revert: 0, restore: 0 };
  private readonly reversibleReceipts = new Map<string, ReversibleHistoryResult>();

  async status(): Promise<ChatAvailability> { return { state: "ready", version: "test" }; }
  async retry(): Promise<ChatAvailability> { this.retries += 1; return this.status(); }
  async models() { return [{ selection: { providerId: "anthropic", modelId: "claude" }, provider: "Anthropic", name: "Claude" }]; }
  async modes() { return [{ name: "build", description: "Full read-write mode" }, { name: "plan", description: "Read-only planning mode" }]; }
  async commands() { return [{ name: "review", description: "Review", argumentHint: "[focus]", kind: "command" as const }]; }
  async listConversations() { return [this.conversation]; }
  async subscribeInventory(options: { signal?: AbortSignal } = {}) { return this.inventory.subscribe(options.signal); }
  async createConversation() { return this.snapshot(); }
  async history(id: string) { this.require(id); return this.snapshot(); }
  async subscribe(id: string, options: { cursor?: string; signal?: AbortSignal } = {}) {
    this.require(id);
    const handoff = this.replay.handoff(() => this.snapshot(), options.cursor, options.signal);
    return { snapshot: handoff.snapshot, events: handoff.subscription };
  }
  async prompt(id: string, requestId: string, _text: string, model?: ModelSelection, agent?: string, _variant?: string, attachments?: MessageAttachment[]) {
    this.require(id);
    this.selectedModel = model;
    this.selectedAgent = agent;
    this.promptAttachments = attachments;
    if (!this.promptResult) {
      this.prompts += 1;
      this.promptResult = { messageId: requestId, held: false };
    }
    return { ...this.promptResult, configuration: { ...(model ? { model } : {}), ...(agent ? { mode: agent } : {}) } };
  }
  // Real sniffing with a tiny cap, so the route's error mapping is exercised
  // without megabyte test bodies.
  async saveAttachment(bytes: Uint8Array) {
    const mimeType = sniffImageMime(bytes);
    if (mimeType === null) throw new AttachmentStoreError("unsupported-type", "attachments must be PNG, JPEG, GIF, or WebP images");
    if (bytes.byteLength > 4096) throw new AttachmentStoreError("too-large", "attachments are limited to 4096 bytes");
    const id = `00000000-0000-4000-8000-00000000000${++this.uploads}`;
    return { id, mimeType, sizeBytes: bytes.byteLength };
  }
  async resolveAttachment(id: string): Promise<StoredAttachment | null> { return this.storedAttachments.get(id) ?? null; }
  uploads = 0;
  promptAttachments: MessageAttachment[] | undefined;
  readonly storedAttachments = new Map<string, StoredAttachment>();
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
  async undo(id: string, requestId: string): Promise<ReversibleHistoryResult> {
    this.require(id);
    const key = `undo:${id}:${requestId}`;
    const existing = this.reversibleReceipts.get(key);
    if (existing) return existing;
    this.reversibleMutations.undo += 1;
    const result: ReversibleHistoryResult = {
      outcome: "changed",
      state: { staged: true, canUndo: false, canRedo: true, revertedMessages: [{ id: "message:restored", text: "Restored prompt" }] },
      restoredDraft: { text: "Restored prompt" },
    };
    this.reversibleReceipts.set(key, result);
    return result;
  }
  async redo(id: string, requestId: string): Promise<ReversibleHistoryResult> {
    this.require(id);
    const key = `redo:${id}:${requestId}`;
    const existing = this.reversibleReceipts.get(key);
    if (existing) return existing;
    this.reversibleMutations.redo += 1;
    const result: ReversibleHistoryResult = {
      outcome: "nothing-to-redo",
      state: { staged: false, canUndo: true, canRedo: false, revertedMessages: [] },
    };
    this.reversibleReceipts.set(key, result);
    return result;
  }
  async revert(id: string, messageId: string, requestId: string): Promise<ReversibleHistoryResult> {
    this.require(id);
    const key = `revert:${id}:${requestId}`;
    const existing = this.reversibleReceipts.get(key);
    if (existing) return existing;
    this.reversibleMutations.revert += 1;
    const result: ReversibleHistoryResult = {
      outcome: "changed",
      state: { staged: true, canUndo: true, canRedo: true, revertedMessages: [{ id: messageId, text: "Selected prompt" }] },
      restoredDraft: { text: "Selected prompt" },
    };
    this.reversibleReceipts.set(key, result);
    return result;
  }
  async restore(id: string, messageId: string, requestId: string): Promise<ReversibleHistoryResult> {
    this.require(id);
    const key = `restore:${id}:${requestId}`;
    const existing = this.reversibleReceipts.get(key);
    if (existing) return existing;
    this.reversibleMutations.restore += 1;
    const result: ReversibleHistoryResult = {
      outcome: "changed",
      state: { staged: false, canUndo: true, canRedo: false, revertedMessages: [] },
    };
    this.reversibleReceipts.set(key, result);
    return result;
  }
  async respondPermission(id: string, _interactionId: string, _requestId: string, outcome: PermissionOutcome) { this.require(id); return { outcome }; }
  async respondQuestion(id: string, _interactionId: string, _requestId: string, outcome: QuestionOutcome) {
    if (this.rejectAnswers) throw this.rejectAnswers; this.require(id); this.questionResponses.push(outcome); return { outcome }; }
  async dispose() { this.inventory.dispose(); }

  private snapshot(): ConversationSnapshot {
    return { conversation: this.conversation, configuration: {}, generation: "generation", cursor: this.replay.latestCursor(), items: [] };
  }
  async stopTask(id: string, taskId: string) {
    this.require(id);
    this.stoppedTasks.push(taskId);
    return { stopped: true as const };
  }
  private require(id: string) { if (id !== "local") throw new ConversationNotFoundError(); }
}

function routes(chatService = new FakeChatService(), basePath = "/", chatKeepaliveMs?: number, metrics?: MetricsRegistry) {
  const repo = path.resolve(import.meta.dir, "..", "..");
  // The real router over the single-agent fake: route tests exercise the
  // qualifying seam exactly as production does. The fake keeps owning the
  // attachment behavior through the store adapter.
  const routed = new MultiAgentChatService({
    workspacePath: repo,
    agents: [{ descriptor: { id: "opencode", name: "OpenCode" }, service: chatService }],
    attachmentStore: {
      directory: '/dev/null',
      save: async bytes => {
        const stored = await chatService.saveAttachment(bytes);
        return { ...stored, name: stored.id, absolutePath: "/dev/null" } as StoredAttachment;
      },
      resolve: id => chatService.resolveAttachment(id),
    },
  });
  return buildRoutes({
    mode: "prod",
    basePath,
    ...(chatKeepaliveMs === undefined ? {} : { chatKeepaliveMs }),
    ...(metrics === undefined ? {} : { metrics }),
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
    chatService: routed,
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
    for (const pathname of ["/api/chat/status", "/api/chat/models", "/api/chat/commands", "/api/chat/conversations/events"]) {
      const handler = table[pathname] as { GET(request: Request): Promise<Response> };
      expect((await handler.GET(new Request(`http://127.0.0.1:4711${pathname}`))).status).toBe(401);
    }
    expect(calls).toBe(0);
    expect(service.inventory.subscriberCount()).toBe(0);
  });

  test("serves status, inventory, creation, and snapshot under a relocated base path", async () => {
    const table = routes(new FakeChatService(), "/s/project/");
    expect(Object.keys(table).filter(key => key.includes("/api/chat/")).every(key => key.startsWith("/s/project/"))).toBe(true);
    const status = table["/s/project/api/chat/status"] as { GET(request: Request): Promise<Response> };
    expect(await (await status.GET(request("/s/project/api/chat/status"))).json()).toEqual({
      agents: [{ agent: { id: "opencode", name: "OpenCode" }, availability: { state: "ready", version: "test" } }],
    });
    const models = table["/s/project/api/chat/models"] as { GET(request: Request): Promise<Response> };
    expect(await (await models.GET(request("/s/project/api/chat/models?agent=opencode"))).json()).toEqual({ models: [expect.objectContaining({ name: "Claude" })] });
    const commands = table["/s/project/api/chat/commands"] as { GET(request: Request): Promise<Response> };
    expect(await (await commands.GET(request("/s/project/api/chat/commands?agent=opencode"))).json()).toEqual({ commands: [expect.objectContaining({ name: "review" })] });
    const inventory = table["/s/project/api/chat/conversations"] as { GET(request: Request): Promise<Response>; POST(request: Request): Promise<Response> };
    expect(await (await inventory.GET(request("/s/project/api/chat/conversations"))).json()).toEqual({ conversations: [expect.objectContaining({ id: "opencode:local", agent: { id: "opencode", name: "OpenCode" } })] });
    const created = await inventory.POST(request("/s/project/api/chat/conversations", {
      method: "POST", headers: { origin: "http://127.0.0.1:4711", "content-type": "application/json" }, body: "{}",
    }));
    expect(created.status).toBe(201);
    const snapshot = table["/s/project/api/chat/conversations/:conversationId"] as { GET(request: Request & { params: Record<string, string> }): Promise<Response> };
    expect((await (await snapshot.GET(request("/s/project/api/chat/conversations/opencode:local?limit=50", {}, { conversationId: "opencode:local" }) as never)).json() as { conversation: { id: string } }).conversation.id).toBe("opencode:local");
  });

  test("streams the normalized initial inventory signal under a relocated base path", async () => {
    const service = new FakeChatService();
    const table = routes(service, "/s/project/");
    const keys = Object.keys(table);
    expect(keys.indexOf("/s/project/api/chat/conversations/events"))
      .toBeLessThan(keys.indexOf("/s/project/api/chat/conversations/:conversationId"));
    const handler = table["/s/project/api/chat/conversations/events"] as { GET(request: Request): Promise<Response> };

    const response = await handler.GET(request("/s/project/api/chat/conversations/events"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('event: inventory\ndata: {"type":"conversation.inventory"}\n\n');
    expect(new TextDecoder().decode(first.value)).not.toContain("id:");
    await reader.cancel();
    expect(service.inventory.subscriberCount()).toBe(0);
  });

  test("coalesces inventory invalidations while the client is not pulling", async () => {
    const service = new FakeChatService();
    const handler = routes(service)["/api/chat/conversations/events"] as { GET(request: Request): Promise<Response> };
    const response = await handler.GET(request("/api/chat/conversations/events"));
    const reader = response.body!.getReader();
    const frame = 'event: inventory\ndata: {"type":"conversation.inventory"}\n\n';
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(frame);

    service.inventory.invalidate();
    service.inventory.invalidate();
    service.inventory.invalidate();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(frame);

    let settled = false;
    const waiting = reader.read().then(result => {
      settled = true;
      return result;
    });
    await Bun.sleep(5);
    expect(settled).toBe(false);
    service.inventory.invalidate();
    expect(new TextDecoder().decode((await waiting).value)).toBe(frame);
    await reader.cancel();
  });

  test("an idle inventory stream emits comment keepalives that carry no event", async () => {
    const service = new FakeChatService();
    const handler = routes(service, "/", 10)["/api/chat/conversations/events"] as { GET(request: Request): Promise<Response> };
    const response = await handler.GET(request("/api/chat/conversations/events"));
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('event: inventory\ndata: {"type":"conversation.inventory"}\n\n');

    // Nothing invalidates, so every following frame is a comment: no `event:`
    // line for a listener to fire on and no `data:` line to parse. Presentation
    // cannot move on one of these.
    for (let index = 0; index < 3; index += 1) {
      const frame = new TextDecoder().decode((await reader.read()).value);
      expect(frame).toBe(": keepalive\n\n");
    }
    await reader.cancel();
    expect(service.inventory.subscriberCount()).toBe(0);
  });

  test("an idle conversation stream emits comment keepalives without advancing the cursor", async () => {
    const service = new FakeChatService();
    const handler = routes(service, "/", 10)["/api/chat/conversations/:conversationId/events"] as {
      GET(request: Request & { params: Record<string, string> }): Promise<Response>;
    };
    const response = await handler.GET(request("/api/chat/conversations/opencode:local/events", {}, { conversationId: "opencode:local" }) as never);
    const reader = response.body!.getReader();

    for (let index = 0; index < 3; index += 1) {
      const frame = new TextDecoder().decode((await reader.read()).value);
      expect(frame).toBe(": keepalive\n\n");
      // No `id:` line, so a keepalive cannot move the replay cursor a
      // reconnect would resume from.
      expect(frame).not.toContain("id:");
    }
    await reader.cancel();
  });

  test("Chat stream metrics separate first connects, resumes, cancellations, and completions", async () => {
    const metrics = new MetricsRegistry();
    const service = new FakeChatService();
    const table = routes(service, "/", undefined, metrics);
    const inventory = table["/api/chat/conversations/events"] as { GET(request: Request): Promise<Response> };
    const conversation = table["/api/chat/conversations/:conversationId/events"] as {
      GET(request: Request & { params: Record<string, string> }): Promise<Response>;
    };

    const inventoryReader = (await inventory.GET(request("/api/chat/conversations/events"))).body!.getReader();
    await inventoryReader.read();
    expect(metrics.get(openedCounter("chat-inventory"))).toBe(1);
    expect(metrics.get(activeGauge("chat-inventory"))).toBe(1);

    const fresh = (await conversation.GET(
      request("/api/chat/conversations/opencode:local/events", {}, { conversationId: "opencode:local" }) as never,
    )).body!.getReader();
    expect(metrics.get(openedCounter("chat-conversation"))).toBe(1);
    expect(metrics.get(reconnectedCounter("chat-conversation"))).toBe(0);

    // A cursor means the client is resuming; only that fact is recorded.
    const resumed = (await conversation.GET(
      request("/api/chat/conversations/opencode:local/events?cursor=abc", {}, { conversationId: "opencode:local" }) as never,
    )).body!.getReader();
    expect(metrics.get(openedCounter("chat-conversation"))).toBe(2);
    expect(metrics.get(reconnectedCounter("chat-conversation"))).toBe(1);
    expect(metrics.get(activeGauge("chat-conversation"))).toBe(2);

    await inventoryReader.cancel();
    await fresh.cancel();
    await resumed.cancel();
    expect(metrics.get(closedCounter("chat-inventory", "cancelled"))).toBe(1);
    // The resumed stream's cursor is unknown to the replay, so it answers with
    // a resync and ends — a completion. The one still waiting for events is a
    // client cancellation. Two endings, two different counters.
    expect(metrics.get(closedCounter("chat-conversation", "completed"))).toBe(1);
    expect(metrics.get(closedCounter("chat-conversation", "cancelled"))).toBe(1);
    expect(metrics.get(activeGauge("chat-inventory"))).toBe(0);
    expect(metrics.get(activeGauge("chat-conversation"))).toBe(0);

    // No counter name carries the cursor value or the conversation id.
    const names = Object.keys(metrics.snapshot().counters);
    expect(names.some(name => name.includes("abc") || name.includes("opencode:local"))).toBe(false);
  });

  test("cleans up inventory subscriptions on request abort", async () => {
    const service = new FakeChatService();
    const handler = routes(service)["/api/chat/conversations/events"] as { GET(request: Request): Promise<Response> };
    const controller = new AbortController();
    const response = await handler.GET(request("/api/chat/conversations/events", { signal: controller.signal }));
    const reader = response.body!.getReader();
    await reader.read();
    expect(service.inventory.subscriberCount()).toBe(1);
    const waiting = reader.read();

    controller.abort();

    expect((await waiting).done).toBe(true);
    expect(service.inventory.subscriberCount()).toBe(0);
  });

  test("rejects foreign origins and malformed bodies before mutation, and joins retried prompts", async () => {
    const service = new FakeChatService();
    const handler = routes(service)["/api/chat/conversations/:conversationId/prompts"] as { POST(request: Request & { params: Record<string, string> }): Promise<Response> };
    const send = (body: unknown, origin = "http://127.0.0.1:4711") => handler.POST(request("/api/chat/conversations/opencode:local/prompts", {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
    }, { conversationId: "opencode:local" }) as never);
    expect((await send({ requestId: "r1", text: "hello" }, "https://attacker.example")).status).toBe(403);
    expect((await send({ requestId: "r1", text: "hello", directory: "/tmp/foreign" })).status).toBe(400);
    const first = await send({ requestId: "r1", text: "hello" });
    const duplicate = await send({ requestId: "r1", text: "hello" });
    expect(first.status).toBe(202);
    expect(await duplicate.json()).toEqual(await first.json());
    expect(service.prompts).toBe(1);
  });

  test("runs idempotent reversible-history mutations through the standard mutation gate", async () => {
    const service = new FakeChatService();
    const table = routes(service);
    type Handler = { POST(request: Request & { params: Record<string, string> }): Promise<Response> };
    const undo = table["/api/chat/conversations/:conversationId/undo"] as Handler;
    const redo = table["/api/chat/conversations/:conversationId/redo"] as Handler;
    const revert = table["/api/chat/conversations/:conversationId/revert"] as Handler;
    const restore = table["/api/chat/conversations/:conversationId/restore"] as Handler;
    const send = (handler: Handler, requestId: string, body: Record<string, unknown> = { requestId }, origin = "http://127.0.0.1:4711") => handler.POST(request("/api/chat/conversations/opencode:local/history", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    }, { conversationId: "opencode:local" }) as never);

    expect((await send(undo, "undo-1", { requestId: "undo-1" }, "https://attacker.example")).status).toBe(403);
    expect((await send(undo, "undo-1", { requestId: "undo-1", direction: "back" })).status).toBe(400);
    expect((await send(undo, "")).status).toBe(400);

    const changed = await send(undo, "undo-1");
    const retry = await send(undo, "undo-1");
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({
      outcome: "changed",
      state: { staged: true, canUndo: false, canRedo: true, revertedMessages: [{ id: "message:restored", text: "Restored prompt" }] },
      restoredDraft: { text: "Restored prompt" },
    });
    expect(await retry.json()).toEqual({
      outcome: "changed",
      state: { staged: true, canUndo: false, canRedo: true, revertedMessages: [{ id: "message:restored", text: "Restored prompt" }] },
      restoredDraft: { text: "Restored prompt" },
    });
    expect(service.reversibleMutations.undo).toBe(1);

    const noOp = await send(redo, "redo-1");
    expect(noOp.status).toBe(200);
    expect(await noOp.json()).toEqual({
      outcome: "nothing-to-redo",
      state: { staged: false, canUndo: true, canRedo: false, revertedMessages: [] },
    });
    expect(service.reversibleMutations.redo).toBe(1);

    expect((await send(revert, "revert-1", { requestId: "revert-1" })).status).toBe(400);
    expect((await send(restore, "restore-1", { requestId: "restore-1", messageId: "", extra: true })).status).toBe(400);
    const reverted = await send(revert, "revert-1", { requestId: "revert-1", messageId: "message:selected" });
    const revertedRetry = await send(revert, "revert-1", { requestId: "revert-1", messageId: "message:selected" });
    expect(await reverted.json()).toEqual({
      outcome: "changed",
      state: { staged: true, canUndo: true, canRedo: true, revertedMessages: [{ id: "message:selected", text: "Selected prompt" }] },
      restoredDraft: { text: "Selected prompt" },
    });
    expect(await revertedRetry.json()).toEqual({
      outcome: "changed",
      state: { staged: true, canUndo: true, canRedo: true, revertedMessages: [{ id: "message:selected", text: "Selected prompt" }] },
      restoredDraft: { text: "Selected prompt" },
    });
    expect(service.reversibleMutations.revert).toBe(1);

    const restored = await send(restore, "restore-1", { requestId: "restore-1", messageId: "message:selected" });
    expect(await restored.json()).toEqual({
      outcome: "changed",
      state: { staged: false, canUndo: true, canRedo: false, revertedMessages: [] },
    });
    expect(service.reversibleMutations.restore).toBe(1);
  });

  test("maps unsupported reversible history to conflict and provider failures to 500", async () => {
    const service = new FakeChatService();
    const table = routes(service);
    type Handler = { POST(request: Request & { params: Record<string, string> }): Promise<Response> };
    const undo = table["/api/chat/conversations/:conversationId/undo"] as Handler;
    const send = () => undo.POST(request("/api/chat/conversations/opencode:local/undo", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:4711", "content-type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID() }),
    }, { conversationId: "opencode:local" }) as never);

    const unsupported = new ReversibleHistoryUnsupportedError();
    service.undo = async () => { throw unsupported; };
    const conflict = await send();
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: unsupported.message });

    service.undo = async () => { throw new Error("provider failed"); };
    const failed = await send();
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "chat operation failed" });

    service.revert = async () => { throw new ReversibleHistoryTargetError(); };
    const revert = table["/api/chat/conversations/:conversationId/revert"] as Handler;
    const stale = await revert.POST(request("/api/chat/conversations/opencode:local/revert", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:4711", "content-type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), messageId: "message:stale" }),
    }, { conversationId: "opencode:local" }) as never);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "reversible-history message is no longer available" });
  });

  test("removes a held message, guards the origin, and maps a delivered message to conflict", async () => {
    const service = new FakeChatService();
    const handler = routes(service)["/api/chat/conversations/:conversationId/queue/:messageId"] as { DELETE(request: Request & { params: Record<string, string> }): Promise<Response> };
    const send = (messageId: string, body: unknown = { requestId: "remove-1" }, origin = "http://127.0.0.1:4711") => handler.DELETE(request(`/api/chat/conversations/opencode:local/queue/${messageId}`, {
      method: "DELETE", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
    }, { conversationId: "opencode:local", messageId }) as never);

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
    const send = (model: unknown) => handler.POST(request("/api/chat/conversations/opencode:local/prompts", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:4711", "content-type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), text: "hello", model }),
    }, { conversationId: "opencode:local" }) as never);
    expect((await send({ providerId: "anthropic", modelId: "claude", variant: "fast" })).status).toBe(400);
    expect((await send({ providerId: "anthropic", modelId: "claude" })).status).toBe(202);
    expect(service.selectedModel).toEqual({ providerId: "anthropic", modelId: "claude" });
  });

  test("lists modes and forwards a well-formed mode selection to the service", async () => {
    const service = new FakeChatService();
    const table = routes(service);
    const modes = table["/api/chat/modes"] as { GET(request: Request): Promise<Response> };
    expect(await (await modes.GET(request("/api/chat/modes?agent=opencode"))).json()).toEqual({
      modes: [expect.objectContaining({ name: "build" }), expect.objectContaining({ name: "plan" })],
    });
    const handler = table["/api/chat/conversations/:conversationId/prompts"] as { POST(request: Request & { params: Record<string, string> }): Promise<Response> };
    const send = (mode: unknown) => handler.POST(request("/api/chat/conversations/opencode:local/prompts", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:4711", "content-type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), text: "hello", mode }),
    }, { conversationId: "opencode:local" }) as never);
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
    const send = (body: unknown, origin = "http://127.0.0.1:4711") => handler.PATCH(request("/api/chat/conversations/opencode:local", {
      method: "PATCH",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    }, { conversationId: "opencode:local" }) as never);

    expect((await send({ requestId: "r1", title: "Renamed" }, "https://attacker.example")).status).toBe(403);
    expect((await send({ requestId: "r1", title: "Renamed", directory: "/tmp" })).status).toBe(400);
    expect((await send({ requestId: "r1", title: "   " })).status).toBe(400);
    expect((await send({ requestId: "r1", title: "é".repeat(101) })).status).toBe(400);
    expect((await send({ title: "Missing receipt" })).status).toBe(400);
    const renamed = await send({ requestId: "r1", title: "  Renamed  " });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ conversation: expect.objectContaining({ id: "opencode:local", title: "Renamed" }) });
    expect(service.renames).toBe(1);

    const unauthenticated = new Request("http://127.0.0.1:4711/api/chat/conversations/opencode:local", {
      method: "PATCH",
      headers: { origin: "http://127.0.0.1:4711", "content-type": "application/json" },
      body: JSON.stringify({ requestId: "r2", title: "No" }),
    }) as Request & { params: Record<string, string> };
    unauthenticated.params = { conversationId: "opencode:local" };
    expect((await handler.PATCH(unauthenticated)).status).toBe(401);
  });

  test("normalizes rename not-found and unsupported errors", async () => {
    const service = new FakeChatService();
    const handler = routes(service)["/api/chat/conversations/:conversationId"] as {
      PATCH(request: Request & { params: Record<string, string> }): Promise<Response>;
    };
    const send = () => handler.PATCH(request("/api/chat/conversations/opencode:local", {
      method: "PATCH",
      headers: { origin: "http://127.0.0.1:4711", "content-type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), title: "Title" }),
    }, { conversationId: "opencode:local" }) as never);

    service.renameConversation = async () => { throw new ConversationRenameUnsupportedError(); };
    expect((await send()).status).toBe(409);
    service.renameConversation = async () => { throw new ConversationNotFoundError(); };
    expect((await send()).status).toBe(404);
  });

  test("stops a background task through the chat service and refuses a request without an id", async () => {
    const service = new FakeChatService();
    const handler = routes(service)["/api/chat/conversations/:conversationId/tasks/:taskId/stop"] as {
      POST(request: Request & { params: Record<string, string> }): Promise<Response>;
    };
    const send = (body: Record<string, unknown>) => handler.POST(request("/api/chat/conversations/opencode:local/tasks/b2f6/stop", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:4711", "content-type": "application/json" },
      body: JSON.stringify(body),
    }, { conversationId: "opencode:local", taskId: "b2f6" }) as never);

    const response = await send({ requestId: crypto.randomUUID() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopped: true });
    expect(service.stoppedTasks).toEqual(["b2f6"]);
    expect((await send({})).status).toBe(400);
    expect((await send({ requestId: crypto.randomUUID(), extra: 1 })).status).toBe(400);
    expect(service.stoppedTasks).toEqual(["b2f6"]);
  });

  test("rejects empty and whitespace-only question answers before calling the service", async () => {
    const service = new FakeChatService();
    const handler = routes(service)["/api/chat/conversations/:conversationId/questions/:interactionId"] as {
      POST(request: Request & { params: Record<string, string> }): Promise<Response>;
    };
    const send = (answers: string[][]) => handler.POST(request("/api/chat/conversations/opencode:local/questions/question-1", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:4711", "content-type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), outcome: { kind: "answered", answers } }),
    }, { conversationId: "opencode:local", interactionId: "question-1" }) as never);

    // An empty array is the adapter's to judge (an optional question
    // allows it); a blank string never is.
    expect((await send([["   "]])).status).toBe(400);
    expect((await send([[""]])).status).toBe(400);
    expect(service.questionResponses).toEqual([]);
    expect((await send([[]])).status).toBe(200);
    // An answer the request's schema refuses is the caller's to correct.
    service.rejectAnswers = new InvalidQuestionAnswerError("count: enter a whole number");
    const refused = await send([["1.5"]]);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "count: enter a whole number" });
  });

  test("streams retained events immediately with replay IDs and no-buffering headers", async () => {
    const service = new FakeChatService();
    const cursor = encodeReplayCursor({ generation: "generation", sequence: 0 });
    service.replay.publish({ type: "conversation.status", status: "running" });
    const handler = routes(service)["/api/chat/conversations/:conversationId/events"] as { GET(request: Request & { params: Record<string, string> }): Promise<Response> };
    const response = await handler.GET(request("/api/chat/conversations/opencode:local/events", {
      headers: { "last-event-id": cursor },
    }, { conversationId: "opencode:local" }) as never);
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

describe("chat attachment routes", () => {
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const ORIGIN = { origin: "http://127.0.0.1:4711" };
  type Handler = { POST(request: Request & { params?: Record<string, string> }): Promise<Response> };
  type GetHandler = { GET(request: Request & { params?: Record<string, string> }): Promise<Response> };

  function uploadRequest(body: FormData | string, headers: Record<string, string> = {}) {
    return request("/api/chat/conversations/opencode:local/attachments", {
      method: "POST",
      headers: { ...ORIGIN, ...headers },
      body,
    }, { conversationId: "opencode:local" });
  }

  test("stores a supported multipart upload and reports the sniffed type", async () => {
    const service = new FakeChatService();
    const handler = routes(service)["/api/chat/conversations/:conversationId/attachments"] as Handler;
    const form = new FormData();
    form.append("file", new File([PNG], "shot.png", { type: "image/png" }));
    const response = await handler.POST(uploadRequest(form));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "00000000-0000-4000-8000-000000000001", mimeType: "image/png", sizeBytes: PNG.byteLength });
  });

  test("refuses non-image bytes with a client-visible reason and stores nothing", async () => {
    const service = new FakeChatService();
    const handler = routes(service)["/api/chat/conversations/:conversationId/attachments"] as Handler;
    const form = new FormData();
    form.append("file", new File([Buffer.from("%PDF-1.4")], "doc.pdf", { type: "application/pdf" }));
    const response = await handler.POST(uploadRequest(form));
    expect(response.status).toBe(415);
    expect((await response.json() as { error: string }).error).toContain("PNG, JPEG, GIF, or WebP");
    expect(service.uploads).toBe(0);
  });

  test("refuses an oversized upload as too large", async () => {
    const service = new FakeChatService();
    const handler = routes(service)["/api/chat/conversations/:conversationId/attachments"] as Handler;
    const form = new FormData();
    form.append("file", new File([Buffer.concat([PNG, Buffer.alloc(8192)])], "big.png", { type: "image/png" }));
    const response = await handler.POST(uploadRequest(form));
    expect(response.status).toBe(413);
  });

  test("refuses uploads that are not multipart, cross-origin, or unauthenticated", async () => {
    const handler = routes(new FakeChatService())["/api/chat/conversations/:conversationId/attachments"] as Handler;
    const json = await handler.POST(uploadRequest("{}", { "content-type": "application/json" }));
    expect(json.status).toBe(415);
    const form = new FormData();
    form.append("file", new File([PNG], "shot.png", { type: "image/png" }));
    const foreign = await handler.POST(request("/api/chat/conversations/opencode:local/attachments", {
      method: "POST", headers: { origin: "https://evil.example" }, body: form,
    }, { conversationId: "opencode:local" }));
    expect(foreign.status).toBe(403);
    const anonymous = await handler.POST(Object.assign(
      new Request("http://127.0.0.1:4711/api/chat/conversations/opencode:local/attachments", { method: "POST", headers: ORIGIN, body: form }),
      { params: { conversationId: "opencode:local" } },
    ));
    expect(anonymous.status).toBe(401);
  });

  test("serves stored bytes with the sniffed content type under authentication", async () => {
    const service = new FakeChatService();
    const id = "11111111-2222-4333-8444-555555555555";
    const filePath = `${import.meta.dir}/../assets/icon-192.png`;
    service.storedAttachments.set(id, { id, mimeType: "image/png", sizeBytes: 1, absolutePath: filePath });
    const handler = routes(service)["/api/chat/attachments/:attachmentId"] as GetHandler;
    const response = await handler.GET(request(`/api/chat/attachments/${id}`, {}, { attachmentId: id }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("private");
    const anonymous = await handler.GET(Object.assign(
      new Request(`http://127.0.0.1:4711/api/chat/attachments/${id}`),
      { params: { attachmentId: id } },
    ));
    expect(anonymous.status).toBe(401);
  });

  test("answers 404 for unknown and hostile attachment identifiers", async () => {
    const handler = routes(new FakeChatService())["/api/chat/attachments/:attachmentId"] as GetHandler;
    for (const hostile of ["99999999-0000-4000-8000-000000000000", "..%2F..%2Fetc%2Fpasswd", "not-issued"]) {
      const response = await handler.GET(request(`/api/chat/attachments/${hostile}`, {}, { attachmentId: hostile }));
      expect(response.status).toBe(404);
    }
  });

  test("accepts prompt attachment references and hands them to the service", async () => {
    const service = new FakeChatService();
    const handler = routes(service)["/api/chat/conversations/:conversationId/prompts"] as Handler;
    const attachments = [{ id: "11111111-2222-4333-8444-555555555555", name: "shot.png", mimeType: "image/png" }];
    const response = await handler.POST(request("/api/chat/conversations/opencode:local/prompts", {
      method: "POST",
      headers: { ...ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ requestId: "r-1", text: "look at this", attachments }),
    }, { conversationId: "opencode:local" }));
    expect(response.status).toBe(202);
    expect(service.promptAttachments).toEqual(attachments);
  });

  test("refuses malformed prompt attachment references", async () => {
    const service = new FakeChatService();
    const handler = routes(service)["/api/chat/conversations/:conversationId/prompts"] as Handler;
    const send = (attachments: unknown) => handler.POST(request("/api/chat/conversations/opencode:local/prompts", {
      method: "POST",
      headers: { ...ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ requestId: "r-1", text: "hello", attachments }),
    }, { conversationId: "opencode:local" }));
    expect((await send("nope")).status).toBe(400);
    expect((await send([{ id: "a", name: "n.png", mimeType: "image/tiff" }])).status).toBe(400);
    expect((await send([{ id: "a", name: "n.png", mimeType: "image/png", url: "data:x" }])).status).toBe(400);
    expect((await send([{ id: "a", name: "", mimeType: "image/png" }])).status).toBe(400);
    expect((await send(Array.from({ length: 9 }, (_, index) => ({ id: `id-${index}`, name: "n.png", mimeType: "image/png" })))).status).toBe(400);
    expect(service.prompts).toBe(0);
  });
});

describe("image-only prompts", () => {
  const ORIGIN = { origin: "http://127.0.0.1:4711" };
  type Handler = { POST(request: Request & { params?: Record<string, string> }): Promise<Response> };
  const send = (handler: Handler, body: Record<string, unknown>) => handler.POST(request("/api/chat/conversations/opencode:local/prompts", {
    method: "POST",
    headers: { ...ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  }, { conversationId: "opencode:local" }));

  test("empty text with attachments is accepted; without them it is still refused", async () => {
    const service = new FakeChatService();
    const handler = routes(service)["/api/chat/conversations/:conversationId/prompts"] as Handler;
    const attachments = [{ id: "11111111-2222-4333-8444-555555555555", name: "shot.png", mimeType: "image/png" }];
    expect((await send(handler, { requestId: "r-1", text: "", attachments })).status).toBe(202);
    expect(service.promptAttachments).toEqual(attachments);
    expect((await send(handler, { requestId: "r-2", text: "   " })).status).toBe(400);
    expect((await send(handler, { requestId: "r-3", text: "", attachments: [] })).status).toBe(400);
    expect(service.prompts).toBe(1);
  });
});

describe("upload body streaming limit", () => {
  test("a chunked oversized body is refused without a content-length header", async () => {
    const service = new FakeChatService();
    const handler = routes(service)["/api/chat/conversations/:conversationId/attachments"] as { POST(request: Request & { params?: Record<string, string> }): Promise<Response> };
    // 11 MiB body, no declared length: the streaming gate must refuse it
    // before parsing, regardless of what the client claims.
    const oversized = new Uint8Array(11 * 1024 * 1024);
    const request_ = Object.assign(new Request(`http://127.0.0.1:4711/api/chat/conversations/opencode:local/attachments?t=${TOKEN}`, {
      method: "POST",
      headers: { origin: "http://127.0.0.1:4711", "content-type": "multipart/form-data; boundary=x" },
      body: oversized,
    }), { params: { conversationId: "opencode:local" } });
    const response = await handler.POST(request_);
    expect(response.status).toBe(413);
    expect(service.uploads).toBe(0);
  });
});
