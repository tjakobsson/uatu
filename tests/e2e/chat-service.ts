import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConversationReplay } from "../../src/chat/replay";
import { deriveConversationTitle, QueuedMessageNotHeldError, UnknownAttachmentError } from "../../src/chat/adapter";
import { createAttachmentStore } from "../../src/chat/attachment-store";
import { ConversationInventoryBroadcaster, type ConversationInventorySubscription } from "../../src/chat/inventory-broadcaster";
import type { WorkspaceChatService } from "../../src/chat/service";
import { ConversationNotFoundError } from "../../src/chat/workspace";
import type {
  ChatCapability,
  ChatModel,
  ChatEvent,
  ChatAvailability,
  ConversationConfiguration,
  ConversationItem,
  ConversationSnapshot,
  ConversationSummary,
  MessageAttachment,
  ModelSelection,
  PermissionOutcome,
  QueuedMessage,
  QuestionOutcome,
} from "../../src/chat/types";

export class FakeE2EChatService implements WorkspaceChatService {
  private generation = "e2e-chat-1";
  private nextId = 1;
  private readonly conversations = new Map<string, ConversationSummary>();
  private readonly items = new Map<string, Map<string, ConversationItem>>();
  private readonly replay = new Map<string, ConversationReplay>();
  private readonly configurations = new Map<string, ConversationConfiguration>();
  private readonly receipts = new Map<string, unknown>();
  private readonly olderItems = new Map<string, ConversationItem[]>();
  // Mirrors the real adapter's workspace-held queue: busy submissions wait
  // here, deliver on the turn's own end, pause on cancellation.
  private readonly queues = new Map<string, QueuedMessage[]>();
  private readonly dormant = new Set<string>();
  private nextCreatedConfiguration: ConversationConfiguration = {};
  // Conversations a subagent runs as. The real adapter keeps them out of the
  // picker (a child session has a parentId), and Chat's drill-down navigation
  // depends on that, so the fake has to keep the same shape.
  private readonly children = new Set<string>();
  private readonly subscriptions = new Set<{ cancel(): void }>();
  private inventory = new ConversationInventoryBroadcaster();
  private readonly inventorySubscriptions = new Set<ConversationInventorySubscription>();
  private readonly pendingInventorySubscriptions = new Set<() => void>();
  private inventoryTransportInterrupted = false;
  private inventoryListGate: { pending: boolean; promise: Promise<void>; release(): void } | null = null;
  private inventoryListCalls = 0;
  private inventoryListCompleted = 0;
  private inventoryInvalidations = 0;
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
  promptConfigurations: ConversationConfiguration[] = [];
  // When set, the next prompt stalls half a second and then rejects —
  // enough of a window for a test to deterministically switch conversations
  // while the request is in flight.
  private failNextPrompt = false;
  private failNextHistory = false;
  private failNextOlderHistory = false;
  // When set, status() reports a failed startup carrying diagnostics, so the
  // suite can drive the unavailable surface. A retry clears it, which is the
  // recovery path a user takes after fixing their environment.
  private unavailable: Extract<ChatAvailability, { state: "unavailable" }> | null = null;
  // The capabilities this fake declares. A test can narrow them to drive the
  // surface an agent that offers less produces — the one path a workspace with
  // a single real agent can never reach on its own.
  private static readonly DEFAULT_CAPABILITIES: ChatCapability[] = ["modes", "models", "commands", "questions", "permissions", "subagents", "variants", "context", "conversation-rename", "attachments"];
  private capabilities: ChatCapability[] = [...FakeE2EChatService.DEFAULT_CAPABILITIES];
  private modelInventory: ChatModel[] = FakeE2EChatService.defaultModels();
  // The real store against a throwaway root: e2e uploads exercise the real
  // sniffing, caps, and id policy rather than a parallel fake.
  private readonly attachmentStore = createAttachmentStore({
    workspacePath: "uatu-e2e",
    root: mkdtempSync(path.join(os.tmpdir(), "uatu-e2e-attachments-")),
  });

  private static defaultModels(): ChatModel[] {
    return [
      { selection: { providerId: "anthropic", modelId: "claude-sonnet" }, provider: "Anthropic", name: "Claude Sonnet", variants: ["high", "xhigh"], contextLimit: 200000, imageInput: true },
      { selection: { providerId: "openai", modelId: "gpt-5" }, provider: "OpenAI", name: "GPT-5", contextLimit: 100000 },
    ];
  }

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

  setModels(models: ChatModel[]): void {
    this.modelInventory = structuredClone(models);
  }

  configureNextConversation(configuration: ConversationConfiguration): void {
    this.nextCreatedConfiguration = structuredClone(configuration);
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

  failHistory(older = false): void {
    if (older) this.failNextOlderHistory = true;
    else this.failNextHistory = true;
  }

  async models() {
    return structuredClone(this.modelInventory);
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
    this.inventoryListCalls += 1;
    const result = [...this.conversations.values()]
      .filter(conversation => !this.children.has(conversation.id))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const gate = this.inventoryListGate;
    if (gate && !gate.pending) {
      gate.pending = true;
      await gate.promise;
      if (this.inventoryListGate === gate) this.inventoryListGate = null;
    }
    this.inventoryListCompleted += 1;
    return result;
  }

  async subscribeInventory(options: { signal?: AbortSignal } = {}) {
    if (!this.inventoryTransportInterrupted) return this.trackInventorySubscription(options.signal);
    return new Promise<ConversationInventorySubscription>(resolve => {
      let settled = false;
      const resume = () => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", resume);
        this.pendingInventorySubscriptions.delete(resume);
        resolve(this.trackInventorySubscription(options.signal));
      };
      this.pendingInventorySubscriptions.add(resume);
      options.signal?.addEventListener("abort", resume, { once: true });
    });
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
    this.configurations.set(id, this.nextCreatedConfiguration);
    this.nextCreatedConfiguration = {};
    this.replay.set(id, new ConversationReplay(this.generation, id, 64 * 1024));
    this.invalidateInventory();
    return this.snapshot(id);
  }

  async history(id: string, options: { cursor?: string } = {}): Promise<ConversationSnapshot> {
    if (options.cursor === "older" && this.failNextOlderHistory) {
      this.failNextOlderHistory = false;
      await new Promise(resolve => setTimeout(resolve, 300));
      throw new Error("older transcript unavailable");
    }
    if (!options.cursor && this.failNextHistory) {
      this.failNextHistory = false;
      throw new Error("conversation unavailable");
    }
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

  async saveAttachment(bytes: Uint8Array) {
    const stored = await this.attachmentStore.save(bytes);
    return { id: stored.id, mimeType: stored.mimeType, sizeBytes: stored.sizeBytes };
  }

  async resolveAttachment(id: string) {
    return this.attachmentStore.resolve(id);
  }

  async prompt(id: string, requestId: string, text: string, model?: ModelSelection, mode?: string, variant?: string, attachments?: MessageAttachment[]): Promise<{
    messageId: string;
    held: boolean;
    conversation?: ConversationSummary;
    configuration: ConversationConfiguration;
  }> {
    if (mode) this.promptModes.push(mode);
    if (variant) this.promptVariants.push(variant);
    const key = `prompt:${id}:${requestId}`;
    const existing = this.receipts.get(key) as { messageId: string; held: boolean; configuration: ConversationConfiguration; conversation?: ConversationSummary } | undefined;
    if (existing) return existing;
    const conversation = this.require(id);
    const previousConfiguration = this.configurations.get(id) ?? {};
    const configuration: ConversationConfiguration = {
      ...previousConfiguration,
      ...(model ? { model } : {}),
      ...(mode ? { mode } : {}),
    };
    if (model) {
      if (variant) configuration.variant = variant;
      else delete configuration.variant;
    } else if (variant) configuration.variant = variant;
    this.promptConfigurations.push(structuredClone(configuration));
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
    // Same admission-time contract as the adapter: every reference must
    // resolve to stored bytes, and the store's sniffed type wins.
    const attachmentRefs: MessageAttachment[] = [];
    for (const attachment of attachments ?? []) {
      const stored = attachment.id ? await this.attachmentStore.resolve(attachment.id) : null;
      if (!stored) throw new UnknownAttachmentError();
      attachmentRefs.push({ id: stored.id, name: attachment.name, mimeType: stored.mimeType });
    }
    this.configurations.set(id, configuration);
    this.nextCreatedConfiguration = structuredClone(configuration);
    if (JSON.stringify(previousConfiguration) !== JSON.stringify(configuration)) {
      this.replay.get(id)!.publish({ type: "conversation.configuration", configuration });
    }
    // A busy conversation — or one with a backlog, which preserves order —
    // holds the message instead of delivering it, exactly like the adapter.
    const queue = this.queues.get(id) ?? [];
    if (conversation.status === "running" || conversation.status === "sending" || queue.length > 0) {
      const held: QueuedMessage = { id: `held-${this.nextId++}`, text, queuedAt: Date.now(), requestId, ...(attachmentRefs.length ? { attachments: attachmentRefs } : {}) };
      queue.push(held);
      this.queues.set(id, queue);
      this.dormant.delete(id);
      this.publishQueue(id, { kind: "held", messageId: held.id });
      // A submission onto an idle conversation with a backlog reactivates
      // the queue, exactly like the adapter's schedule-on-hold.
      if (conversation.status !== "running" && conversation.status !== "sending") this.deliverNext(id);
      const result = { messageId: held.id, held: true, configuration };
      this.receipts.set(key, result);
      return result;
    }
    let renamed: ConversationSummary | undefined;
    if (/^New session - /.test(conversation.title) && this.items.get(id)!.size === 0) {
      renamed = { ...conversation, title: deriveConversationTitle(text), updatedAt: this.nextId };
      this.conversations.set(id, renamed);
    }
    const messageId = this.dispatch(id, text, requestId, attachmentRefs);
    const result = { messageId, held: false, configuration, ...(renamed ? { conversation: renamed } : {}) };
    this.receipts.set(key, result);
    return result;
  }

  async removeQueued(id: string, messageId: string, requestId: string): Promise<{ removed: true }> {
    const key = `unqueue:${id}:${requestId}`;
    const existing = this.receipts.get(key) as { removed: true } | undefined;
    if (existing) return existing;
    this.require(id);
    const queue = this.queues.get(id) ?? [];
    const index = queue.findIndex(held => held.id === messageId);
    if (index < 0) throw new QueuedMessageNotHeldError();
    queue.splice(index, 1);
    if (queue.length === 0) this.queues.delete(id);
    this.publishQueue(id, { kind: "removed", messageId });
    const result = { removed: true } as const;
    this.receipts.set(key, result);
    return result;
  }

  private dispatch(id: string, text: string, requestId?: string, attachments?: MessageAttachment[]): string {
    const messageId = `message-${this.nextId++}`;
    const item: ConversationItem = { id: `message:${messageId}`, type: "user_message", createdAt: Date.now(), text, ...(requestId ? { requestId } : {}), ...(attachments?.length ? { attachments } : {}) };
    this.items.get(id)!.set(item.id, item);
    this.replay.get(id)!.publish({ type: "item.upsert", item });
    this.setStatus(id, "running");
    return messageId;
  }

  private deliverNext(id: string): void {
    if (this.dormant.has(id)) return;
    const queue = this.queues.get(id);
    const held = queue?.[0];
    if (!queue || !held) return;
    queue.shift();
    if (queue.length === 0) this.queues.delete(id);
    this.dispatch(id, held.text, held.requestId, held.attachments);
    this.publishQueue(id, { kind: "delivered", messageId: held.id });
  }

  private publishQueue(id: string, change: { kind: "held" | "removed" | "delivered"; messageId: string }): void {
    this.replay.get(id)!.publish({ type: "conversation.queue", queued: structuredClone(this.queues.get(id) ?? []), change });
  }

  async renameConversation(id: string, requestId: string, rawTitle: string): Promise<{ conversation: ConversationSummary }> {
    const key = `rename:${id}:${requestId}`;
    const existing = this.receipts.get(key) as { conversation: ConversationSummary } | undefined;
    if (existing) return existing;
    const current = this.require(id);
    const conversation = { ...current, title: rawTitle.trim(), updatedAt: this.nextId++ };
    this.conversations.set(id, conversation);
    const result = { conversation };
    this.receipts.set(key, result);
    this.replay.get(id)!.publish({ type: "conversation.updated", conversation });
    this.invalidateInventory();
    return result;
  }

  async cancel(id: string, requestId: string): Promise<{ cancelled: true }> {
    const key = `cancel:${id}:${requestId}`;
    const existing = this.receipts.get(key) as { cancelled: true } | undefined;
    if (existing) return existing;
    this.require(id);
    // Cancel pauses the queue before the status transition can deliver.
    if (this.queues.get(id)?.length) this.dormant.add(id);
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

  async dispose(): Promise<void> {
    for (const subscription of [...this.inventorySubscriptions]) subscription.cancel();
    this.inventory.dispose();
    this.inventoryTransportInterrupted = false;
    for (const resume of [...this.pendingInventorySubscriptions]) resume();
  }

  reset(): void {
    this.disconnect();
    for (const subscription of [...this.inventorySubscriptions]) subscription.cancel();
    this.inventory.dispose();
    this.inventory = new ConversationInventoryBroadcaster();
    this.inventoryTransportInterrupted = false;
    for (const resume of [...this.pendingInventorySubscriptions]) resume();
    this.inventoryListGate?.release();
    this.inventoryListGate = null;
    this.inventoryListCalls = 0;
    this.inventoryListCompleted = 0;
    this.inventoryInvalidations = 0;
    this.statusCalls = 0;
    this.promptAttempts = [];
    this.promptModes = [];
    this.promptVariants = [];
    this.promptConfigurations = [];
    this.failNextPrompt = false;
    this.failNextHistory = false;
    this.failNextOlderHistory = false;
    this.generation = `e2e-chat-${this.nextId++}`;
    this.conversations.clear();
    this.items.clear();
    this.replay.clear();
    this.configurations.clear();
    this.receipts.clear();
    this.olderItems.clear();
    this.queues.clear();
    this.dormant.clear();
    this.nextCreatedConfiguration = {};
    this.children.clear();
    // A narrowed agent is one test's setup, not the fixture's resting state:
    // left in place it reaches whichever test boots against this worker next.
    this.capabilities = [...FakeE2EChatService.DEFAULT_CAPABILITIES];
    this.modelInventory = FakeE2EChatService.defaultModels();
  }

  seed(title: string, items: ConversationItem[], older: ConversationItem[] = [], child = false, configuration: ConversationConfiguration = {}): ConversationSnapshot {
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
    this.configurations.set(id, configuration);
    this.replay.set(id, new ConversationReplay(this.generation, id, 64 * 1024));
    if (older.length) this.olderItems.set(id, older);
    this.invalidateInventory();
    return this.snapshot(id);
  }

  externalCreate(title: string, options: { child?: boolean; invalidate?: boolean } = {}): ConversationSnapshot {
    const id = `conversation-${this.nextId++}`;
    const conversation: ConversationSummary = {
      id,
      title,
      createdAt: this.nextId,
      updatedAt: this.nextId,
      status: "idle",
    };
    this.conversations.set(id, conversation);
    this.items.set(id, new Map());
    this.configurations.set(id, {});
    this.replay.set(id, new ConversationReplay(this.generation, id, 64 * 1024));
    if (options.child) this.children.add(id);
    if (!options.child && options.invalidate !== false) this.invalidateInventory();
    return this.snapshot(id);
  }

  externalRename(id: string, title: string, invalidate = true): ConversationSummary {
    const current = this.require(id);
    const conversation = { ...current, title, updatedAt: this.nextId++ };
    this.conversations.set(id, conversation);
    if (invalidate) this.invalidateInventory();
    return conversation;
  }

  externalDelete(id: string, invalidate = true): ConversationSummary {
    const conversation = this.require(id);
    this.conversations.delete(id);
    this.items.delete(id);
    this.configurations.delete(id);
    this.olderItems.delete(id);
    this.queues.delete(id);
    this.dormant.delete(id);
    this.children.delete(id);
    this.replay.delete(id);
    if (invalidate) this.invalidateInventory();
    return conversation;
  }

  invalidateInventory(): void {
    this.inventoryInvalidations += 1;
    this.inventory.invalidate();
  }

  interruptInventoryTransport(): void {
    this.inventoryTransportInterrupted = true;
    for (const subscription of [...this.inventorySubscriptions]) subscription.cancel();
  }

  resumeInventoryTransport(): void {
    this.inventoryTransportInterrupted = false;
    for (const resume of [...this.pendingInventorySubscriptions]) resume();
  }

  restartProviderPump(): void {
    this.invalidateInventory();
  }

  delayNextInventoryList(): void {
    if (this.inventoryListGate) throw new Error("an inventory list delay is already armed");
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    this.inventoryListGate = { pending: false, promise, release };
  }

  releaseInventoryList(): void {
    this.inventoryListGate?.release();
  }

  inventoryStats() {
    return {
      inventoryListCalls: this.inventoryListCalls,
      inventoryListCompleted: this.inventoryListCompleted,
      inventoryListPending: this.inventoryListGate?.pending ?? false,
      inventoryInvalidations: this.inventoryInvalidations,
      inventorySubscribers: this.inventory.subscriberCount(),
      inventoryTransportInterrupted: this.inventoryTransportInterrupted,
      pendingInventorySubscriptions: this.pendingInventorySubscriptions.size,
    };
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

  publishStatus(id: string, status: ConversationSummary["status"], message?: string): void {
    this.setStatus(id, status, message);
  }

  publishConfiguration(id: string, configuration: ConversationConfiguration): ChatEvent {
    this.require(id);
    this.configurations.set(id, configuration);
    return this.replay.get(id)!.publish({ type: "conversation.configuration", configuration });
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

  restart(): void {
    this.rotateGeneration();
  }

  private trackInventorySubscription(signal?: AbortSignal): ConversationInventorySubscription {
    const source = this.inventory.subscribe(signal);
    let tracked: ConversationInventorySubscription;
    const forget = () => { this.inventorySubscriptions.delete(tracked); };
    tracked = {
      next: async () => {
        const result = await source.next();
        if (result.done) forget();
        return result;
      },
      cancel: () => {
        source.cancel();
        forget();
      },
      return: async () => {
        const result = await source.return();
        forget();
        return result;
      },
      [Symbol.asyncIterator]: () => tracked,
    };
    this.inventorySubscriptions.add(tracked);
    return tracked;
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
      configuration: this.configurations.get(id) ?? {},
      generation: this.generation,
      cursor: this.replay.get(id)!.latestCursor(),
      items: [...this.items.get(id)!.values()],
      queued: structuredClone(this.queues.get(id) ?? []),
    };
  }

  private setStatus(id: string, status: ConversationSummary["status"], message?: string): void {
    const conversation = this.require(id);
    this.conversations.set(id, { ...conversation, status, updatedAt: this.nextId });
    this.replay.get(id)!.publish({ type: "conversation.status", status, ...(message ? { message } : {}) });
    // A turn that ended on its own releases the next held message.
    if (status === "completed" || status === "idle") this.deliverNext(id);
  }
}
