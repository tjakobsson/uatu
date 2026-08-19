import { ConversationReplay } from "../../src/chat/replay";
import { deriveConversationTitle } from "../../src/chat/adapter";
import type { WorkspaceChatService } from "../../src/chat/service";
import { ConversationNotFoundError } from "../../src/chat/workspace";
import type {
  ChatCapability,
  ChatEvent,
  ChatAvailability,
  ConversationItem,
  ConversationSnapshot,
  ConversationSummary,
  ModelSelection,
  PermissionOutcome,
  QuestionOutcome,
} from "../../src/chat/types";

export class FakeE2EChatService implements WorkspaceChatService {
  private generation = "e2e-chat-1";
  private nextId = 1;
  private readonly conversations = new Map<string, ConversationSummary>();
  private readonly items = new Map<string, Map<string, ConversationItem>>();
  private readonly replay = new Map<string, ConversationReplay>();
  private readonly receipts = new Map<string, unknown>();
  private readonly olderItems = new Map<string, ConversationItem[]>();
  // Conversations a subagent runs as. The real adapter keeps them out of the
  // picker (a child session has a parentId), and Chat's drill-down navigation
  // depends on that, so the fake has to keep the same shape.
  private readonly children = new Set<string>();
  private readonly subscriptions = new Set<{ cancel(): void }>();
  // Counted so the suite can assert Chat's lazy backend startup: in production
  // status() launches the OpenCode server, so a page load that never opens
  // Chat must never call it.
  statusCalls = 0;
  // Every prompt attempt's request id, in arrival order — lets the suite
  // assert that a retry after an ambiguous failure reuses the id (the
  // at-most-once contract) instead of minting a fresh one.
  promptAttempts: string[] = [];
  promptModes: string[] = [];
  promptVariants: string[] = [];
  // When set, the next prompt stalls half a second and then rejects —
  // enough of a window for a test to deterministically switch conversations
  // while the request is in flight.
  private failNextPrompt = false;
  // When set, status() reports a failed startup carrying diagnostics, so the
  // suite can drive the unavailable surface. A retry clears it, which is the
  // recovery path a user takes after fixing their environment.
  private unavailable: Extract<ChatAvailability, { state: "unavailable" }> | null = null;
  // The capabilities this fake declares. A test can narrow them to drive the
  // surface an agent that offers less produces — the one path a workspace with
  // a single real agent can never reach on its own.
  private static readonly DEFAULT_CAPABILITIES: ChatCapability[] = ["modes", "models", "commands", "questions", "permissions", "subagents", "variants", "context"];
  private capabilities: ChatCapability[] = [...FakeE2EChatService.DEFAULT_CAPABILITIES];

  async status(): Promise<ChatAvailability> {
    this.statusCalls += 1;
    return this.unavailable ?? {
      state: "ready",
      version: "e2e",
      agent: { id: "e2e", name: "Fixture Agent", capabilities: this.capabilities },
    };
  }

  declareOnly(capabilities: ChatCapability[]): void {
    this.capabilities = capabilities;
  }

  async retry(): Promise<ChatAvailability> {
    this.unavailable = null;
    return this.status();
  }

  failStartup(): void {
    this.unavailable = {
      state: "unavailable",
      reason: "startup-failed",
      message: "OpenCode did not become ready. OpenCode never accepted a health request at http://127.0.0.1:41823 within 30000ms (connection refused).",
      diagnostics: {
        executable: "/mnt/c/Users/x/AppData/Roaming/npm/opencode",
        shadowedExecutables: ["/home/linuxbrew/.linuxbrew/bin/opencode"],
        version: null,
        endpoint: "http://127.0.0.1:41823",
        elapsedMs: 30_000,
        probes: 97,
        lastProbe: { kind: "refused" },
        stdout: "opencode server listening on http://127.0.0.1:41823",
        stderr: "",
      },
    };
  }

  failPrompt(): void {
    this.failNextPrompt = true;
  }

  async models() {
    return [
      { selection: { providerId: "anthropic", modelId: "claude-sonnet" }, provider: "Anthropic", name: "Claude Sonnet", variants: ["high", "xhigh"], contextLimit: 200000 },
      { selection: { providerId: "openai", modelId: "gpt-5" }, provider: "OpenAI", name: "GPT-5", contextLimit: 100000 },
    ];
  }

  async modes() {
    return [
      { name: "build", description: "Full read-write mode" },
      { name: "plan", description: "Read-only planning mode" },
    ];
  }

  async commands() {
    return [
      { name: "review", description: "Review the current work", argumentHint: "[focus]", kind: "command" as const },
      { name: "compact", description: "Compact the conversation context", argumentHint: "", kind: "command" as const },
      { name: "summarize", description: "Summarize and compact the conversation context", argumentHint: "", kind: "command" as const },
    ];
  }

  async listConversations(): Promise<ConversationSummary[]> {
    return [...this.conversations.values()]
      .filter(conversation => !this.children.has(conversation.id))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }

  async createConversation(): Promise<ConversationSnapshot> {
    const id = `conversation-${this.nextId++}`;
    const conversation: ConversationSummary = {
      id,
      title: `New session - ${Date.now()}`,
      createdAt: this.nextId,
      updatedAt: this.nextId,
      status: "idle",
    };
    this.conversations.set(id, conversation);
    this.items.set(id, new Map());
    this.replay.set(id, new ConversationReplay(this.generation, id, 64 * 1024));
    return this.snapshot(id);
  }

  async history(id: string, options: { cursor?: string } = {}): Promise<ConversationSnapshot> {
    if (options.cursor === "older") {
      const snapshot = this.snapshot(id);
      return { ...snapshot, items: this.olderItems.get(id) ?? [] };
    }
    const snapshot = this.snapshot(id);
    return this.olderItems.has(id) ? { ...snapshot, olderCursor: "older" } : snapshot;
  }

  async subscribe(id: string, options: { cursor?: string; signal?: AbortSignal } = {}) {
    this.require(id);
    const handoff = this.replay.get(id)!.handoff(() => this.snapshot(id), options.cursor, options.signal);
    this.subscriptions.add(handoff.subscription);
    return { snapshot: await handoff.snapshot, events: handoff.subscription };
  }

  async prompt(id: string, requestId: string, text: string, model?: ModelSelection, mode?: string, variant?: string): Promise<{
    messageId: string;
    delivery: "steer" | "queue";
    conversation?: ConversationSummary;
  }> {
    if (mode) this.promptModes.push(mode);
    if (variant) this.promptVariants.push(variant);
    const key = `prompt:${id}:${requestId}`;
    const existing = this.receipts.get(key) as { messageId: string; delivery: "steer" | "queue"; conversation?: ConversationSummary } | undefined;
    if (existing) return existing;
    const conversation = this.require(id);
    this.promptAttempts.push(requestId);
    if (this.failNextPrompt) {
      this.failNextPrompt = false;
    this.unavailable = null;
      await new Promise(resolve => setTimeout(resolve, 500));
      throw new Error("prompt rejected by fixture");
    }
    await new Promise(resolve => setTimeout(resolve, 75));
    if (model && !(await this.models()).some(candidate =>
      candidate.selection.providerId === model.providerId && candidate.selection.modelId === model.modelId)) {
      throw new Error("selected model is not available");
    }
    let renamed: ConversationSummary | undefined;
    if (/^New session - /.test(conversation.title) && this.items.get(id)!.size === 0) {
      renamed = { ...conversation, title: deriveConversationTitle(text), updatedAt: this.nextId };
      this.conversations.set(id, renamed);
    }
    const messageId = `message-${this.nextId++}`;
    const delivery: "steer" | "queue" = conversation.status === "running" ? "steer" : "queue";
    const item: ConversationItem = { id: `message:${messageId}`, type: "user_message", createdAt: Date.now(), text, requestId };
    this.items.get(id)!.set(item.id, item);
    this.replay.get(id)!.publish({ type: "item.upsert", item });
    this.setStatus(id, "running");
    const result = { messageId, delivery, ...(renamed ? { conversation: renamed } : {}) };
    this.receipts.set(key, result);
    return result;
  }

  async cancel(id: string, requestId: string): Promise<{ cancelled: true }> {
    const key = `cancel:${id}:${requestId}`;
    const existing = this.receipts.get(key) as { cancelled: true } | undefined;
    if (existing) return existing;
    this.require(id);
    this.setStatus(id, "interrupted");
    const result = { cancelled: true } as const;
    this.receipts.set(key, result);
    return result;
  }

  async respondPermission(id: string, interactionId: string, requestId: string, outcome: PermissionOutcome) {
    this.require(id);
    const key = `permission:${id}:${interactionId}:${requestId}`;
    const existing = this.receipts.get(key) as { outcome: PermissionOutcome } | undefined;
    if (existing) return existing;
    const result = { outcome };
    const item = this.items.get(id)!.get(`permission:${interactionId}`);
    if (item?.type === "permission") this.publishItem(id, { ...item, status: "resolved", outcome });
    this.receipts.set(key, result);
    return result;
  }

  async respondQuestion(id: string, interactionId: string, requestId: string, outcome: QuestionOutcome) {
    this.require(id);
    const key = `question:${id}:${interactionId}:${requestId}`;
    const existing = this.receipts.get(key) as { outcome: QuestionOutcome } | undefined;
    if (existing) return existing;
    const result = { outcome };
    const item = this.items.get(id)!.get(`question:${interactionId}`);
    if (item?.type === "question") this.publishItem(id, { ...item, status: "resolved", outcome });
    this.receipts.set(key, result);
    return result;
  }

  async dispose(): Promise<void> {}

  reset(): void {
    this.disconnect();
    this.statusCalls = 0;
    this.promptAttempts = [];
    this.promptModes = [];
    this.promptVariants = [];
    this.failNextPrompt = false;
    this.generation = `e2e-chat-${this.nextId++}`;
    this.conversations.clear();
    this.items.clear();
    this.replay.clear();
    this.receipts.clear();
    this.olderItems.clear();
    this.children.clear();
    // A narrowed agent is one test's setup, not the fixture's resting state:
    // left in place it reaches whichever test boots against this worker next.
    this.capabilities = [...FakeE2EChatService.DEFAULT_CAPABILITIES];
  }

  seed(title: string, items: ConversationItem[], older: ConversationItem[] = [], child = false): ConversationSnapshot {
    const id = `conversation-${this.nextId++}`;
    const conversation: ConversationSummary = {
      id,
      title,
      createdAt: this.nextId,
      updatedAt: this.nextId,
      status: "idle",
    };
    this.conversations.set(id, conversation);
    if (child) this.children.add(id);
    this.items.set(id, new Map(items.map(item => [item.id, item])));
    this.replay.set(id, new ConversationReplay(this.generation, id, 64 * 1024));
    if (older.length) this.olderItems.set(id, older);
    return this.snapshot(id);
  }

  publishItem(id: string, item: ConversationItem): ChatEvent {
    this.require(id);
    this.items.get(id)!.set(item.id, item);
    return this.replay.get(id)!.publish({ type: "item.upsert", item });
  }

  publishDelta(id: string, itemId: string, delta: string): ChatEvent {
    const item = this.items.get(id)?.get(itemId);
    if (item?.type === "assistant_message") this.items.get(id)!.set(itemId, { ...item, markdown: item.markdown + delta });
    if (item?.type === "reasoning") this.items.get(id)!.set(itemId, { ...item, text: item.text + delta });
    return this.replay.get(id)!.publish({ type: "item.text_delta", itemId, delta });
  }

  publishStatus(id: string, status: ConversationSummary["status"]): void {
    this.setStatus(id, status);
  }

  disconnect(): void {
    for (const subscription of this.subscriptions) subscription.cancel();
    this.subscriptions.clear();
  }

  rotateGeneration(): void {
    this.disconnect();
    this.generation = `e2e-chat-${this.nextId++}`;
    for (const id of this.conversations.keys()) {
      this.replay.set(id, new ConversationReplay(this.generation, id, 64 * 1024));
    }
  }

  private require(id: string): ConversationSummary {
    const conversation = this.conversations.get(id);
    if (!conversation) throw new ConversationNotFoundError();
    return conversation;
  }

  private snapshot(id: string): ConversationSnapshot {
    const conversation = this.require(id);
    return {
      conversation,
      generation: this.generation,
      cursor: this.replay.get(id)!.latestCursor(),
      items: [...this.items.get(id)!.values()],
    };
  }

  private setStatus(id: string, status: ConversationSummary["status"]): void {
    const conversation = this.require(id);
    this.conversations.set(id, { ...conversation, status, updatedAt: this.nextId });
    this.replay.get(id)!.publish({ type: "conversation.status", status });
  }
}
