import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConversationReplay } from "../../src/chat/replay";
import { deriveConversationTitle, QueuedMessageNotHeldError, ReversibleHistoryUnsupportedError, UnknownAttachmentError } from "../../src/chat/adapter";
import { createAttachmentStore } from "../../src/chat/attachment-store";
import { ConversationInventoryBroadcaster, type ConversationInventorySubscription } from "../../src/chat/inventory-broadcaster";
import { ReversibleHistoryTargetError } from "../../src/chat/provider";
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
  ReversibleHistoryResult,
  ReversibleHistoryState,
} from "../../src/chat/types";

export type ReversibleFileFixture = {
  relativePath: string;
  baseline: string | null;
  versions: Record<string, string | null>;
};

type FakeE2EChatServiceOptions = {
  restoreFile?: (relativePath: string, contents: string | null) => Promise<void>;
  // The identity this fake declares; distinct per registered agent so the
  // surface's declaration-driven naming is observable in multi-agent specs.
  agentName?: string;
  agentId?: string;
  // The persistent-approval sentence this fake's permission cards carry —
  // per agent, exactly as the real descriptors declare their own.
  permissionScopeNote?: string;
  // Capabilities this fake declares beyond the shared default set (a
  // Claude-shaped fixture declares typed model ids; the OpenCode one does not).
  extraCapabilities?: ChatCapability[];
};

export class FakeE2EChatService implements WorkspaceChatService {
  private readonly agentName: string;
  private readonly agentId: string;
  private generation = "e2e-chat-1";
  private nextId = 1;
  private readonly conversations = new Map<string, ConversationSummary>();
  private readonly items = new Map<string, Map<string, ConversationItem>>();
  private readonly authoritativeItems = new Map<string, ConversationItem[]>();
  private readonly revertBoundaries = new Map<string, string>();
  private readonly reversibleFiles = new Map<string, ReversibleFileFixture[]>();
  private readonly replay = new Map<string, ConversationReplay>();
  private readonly configurations = new Map<string, ConversationConfiguration>();
  private readonly receipts = new Map<string, unknown>();
  private readonly reversibleLanes = new Map<string, Promise<void>>();
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
  reversibleAttempts: Array<{ direction: "undo" | "redo" | "revert" | "restore"; conversationId: string; requestId: string }> = [];
  // When set, the next prompt stalls half a second and then rejects —
  // enough of a window for a test to deterministically switch conversations
  // while the request is in flight.
  private failNextPrompt = false;
  private failNextReversible: "undo" | "redo" | null = null;
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
  private capabilities: ChatCapability[];
  private modelInventory: ChatModel[] = FakeE2EChatService.defaultModels();
  // The real store against a throwaway root: e2e uploads exercise the real
  // sniffing, caps, and id policy rather than a parallel fake.
  private readonly attachmentStore = createAttachmentStore({
    workspacePath: "uatu-e2e",
    root: mkdtempSync(path.join(os.tmpdir(), "uatu-e2e-attachments-")),
  });

  constructor(private readonly options: FakeE2EChatServiceOptions = {}) {
    this.agentName = options.agentName ?? "Fixture Agent";
    this.agentId = options.agentId ?? "e2e";
    this.capabilities = this.defaultCapabilities();
  }

  private defaultCapabilities(): ChatCapability[] {
    return [...FakeE2EChatService.DEFAULT_CAPABILITIES, ...(this.options.extraCapabilities ?? [])];
  }

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
      agent: {
        id: this.agentId,
        name: this.agentName,
        capabilities: this.capabilities,
        ...(this.options.permissionScopeNote ? { permissionScopeNote: this.options.permissionScopeNote } : {}),
      },
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

  failReversible(direction: "undo" | "redo"): void {
    this.failNextReversible = direction;
  }

  configureReversibleFiles(id: string, files: ReversibleFileFixture[]): void {
    this.require(id);
    this.reversibleFiles.set(id, structuredClone(files));
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
    const commands = [
      { name: "review", description: "Review the current work", argumentHint: "[focus]", kind: "command" as const },
      { name: "openspec-archive-change", description: "Archive a completed OpenSpec change", argumentHint: "[change]", kind: "skill" as const },
      { name: "compact", description: "Compact the conversation context", argumentHint: "", kind: "command" as const },
      { name: "summarize", description: "Summarize and compact the conversation context", argumentHint: "", kind: "command" as const },
    ];
    return this.capabilities.includes("reversible-history")
      ? [
          ...commands,
          { name: "undo", description: "Undo the latest user turn", argumentHint: "", kind: "local-operation" as const },
          { name: "redo", description: "Redo the next hidden user turn", argumentHint: "", kind: "local-operation" as const },
        ]
      : commands;
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
    this.authoritativeItems.set(id, []);
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
    // An agent that runs typed ids takes an unlisted selection verbatim,
    // exactly as the real adapter does for a declaring provider.
    if (model && !this.capabilities.includes("custom-model-id") && !(await this.models()).some(candidate =>
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
    // A restored draft starts a replacement branch. Commit the hidden suffix
    // first, then admit this prompt before any older held messages resume.
    if (this.revertBoundaries.has(id)) {
      this.commitRevertedBranch(id);
      const messageId = this.dispatch(id, text, requestId, attachmentRefs);
      const result = { messageId, held: false, configuration };
      this.receipts.set(key, result);
      return result;
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
    this.authoritativeItems.get(id)!.push(item);
    this.items.get(id)!.set(item.id, item);
    this.replay.get(id)!.publish({ type: "item.upsert", item });
    this.setStatus(id, "running");
    return messageId;
  }

  private deliverNext(id: string): void {
    if (this.dormant.has(id) || this.revertBoundaries.has(id)) return;
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

  async undo(id: string, requestId: string): Promise<ReversibleHistoryResult> {
    return this.reversibleHistoryMutation(id, requestId, "undo");
  }

  async redo(id: string, requestId: string): Promise<ReversibleHistoryResult> {
    return this.reversibleHistoryMutation(id, requestId, "redo");
  }

  async revert(id: string, messageId: string, requestId: string): Promise<ReversibleHistoryResult> {
    return this.reversibleHistoryMutation(id, requestId, "revert", messageId);
  }

  async restore(id: string, messageId: string, requestId: string): Promise<ReversibleHistoryResult> {
    return this.reversibleHistoryMutation(id, requestId, "restore", messageId);
  }

  async respondPermission(id: string, interactionId: string, requestId: string, outcome: PermissionOutcome, choiceId?: string) {
    this.require(id);
    const key = `permission:${id}:${interactionId}:${requestId}`;
    const existing = this.receipts.get(key) as { outcome: PermissionOutcome } | undefined;
    if (existing) return existing;
    const result = { outcome };
    this.permissionChoices.push({ interactionId, ...(choiceId ? { choiceId } : {}) });
    const item = this.items.get(id)!.get(`permission:${interactionId}`);
    if (item?.type === "permission") this.publishItem(id, { ...item, status: "resolved", outcome, ...(choiceId ? { choiceId } : {}) });
    this.receipts.set(key, result);
    return result;
  }

  // What each permission reply carried, for spec assertions.
  readonly permissionChoices: Array<{ interactionId: string; choiceId?: string }> = [];

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

  // What each stop request carried, for spec assertions.
  readonly stoppedTasks: string[] = [];

  async stopTask(id: string, taskId: string, requestId: string): Promise<{ stopped: true }> {
    this.require(id);
    const key = `stop-task:${id}:${taskId}:${requestId}`;
    const existing = this.receipts.get(key) as { stopped: true } | undefined;
    if (existing) return existing;
    this.stoppedTasks.push(taskId);
    // The agent reports the stop as the task settling: same row, stopped.
    const item = this.items.get(id)!.get(`task:${taskId}`);
    if (item?.type === "background_task") this.publishItem(id, { ...item, status: "stopped", summary: "Stopped by the user." });
    const result = { stopped: true } as const;
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
    this.reversibleAttempts = [];
    this.failNextPrompt = false;
    this.failNextReversible = null;
    this.failNextHistory = false;
    this.failNextOlderHistory = false;
    // A staged startup failure is one test's setup too: left in place it
    // makes the next test on this worker boot against an unavailable agent.
    this.unavailable = null;
    this.generation = `e2e-chat-${this.nextId++}`;
    this.conversations.clear();
    this.items.clear();
    this.authoritativeItems.clear();
    this.revertBoundaries.clear();
    this.reversibleFiles.clear();
    this.replay.clear();
    this.configurations.clear();
    this.receipts.clear();
    this.reversibleLanes.clear();
    this.olderItems.clear();
    this.queues.clear();
    this.dormant.clear();
    this.nextCreatedConfiguration = {};
    this.children.clear();
    // A narrowed agent is one test's setup, not the fixture's resting state:
    // left in place it reaches whichever test boots against this worker next.
    this.capabilities = this.defaultCapabilities();
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
    this.authoritativeItems.set(id, structuredClone(items));
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
    this.authoritativeItems.set(id, []);
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
    this.authoritativeItems.delete(id);
    this.revertBoundaries.delete(id);
    this.reversibleFiles.delete(id);
    this.configurations.delete(id);
    this.olderItems.delete(id);
    this.queues.delete(id);
    this.dormant.delete(id);
    this.children.delete(id);
    this.replay.delete(id);
    if (invalidate) this.invalidateInventory();
    return conversation;
  }

  externalSetChild(id: string, child: boolean, invalidate = true): ConversationSummary {
    const conversation = this.require(id);
    if (child) this.children.add(id);
    else this.children.delete(id);
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
    const authoritative = this.authoritativeItems.get(id)!;
    const existing = authoritative.findIndex(candidate => candidate.id === item.id);
    if (existing < 0) authoritative.push(item);
    else authoritative[existing] = item;
    const itemIndex = existing < 0 ? authoritative.length - 1 : existing;
    const boundaryIndex = this.boundaryIndex(id);
    if (boundaryIndex !== undefined && itemIndex >= boundaryIndex) {
      return this.replay.get(id)!.publish({ type: "resync", reason: "conversation-rewritten" });
    }
    this.items.get(id)!.set(item.id, item);
    return this.replay.get(id)!.publish({ type: "item.upsert", item });
  }

  publishDelta(id: string, itemId: string, delta: string): ChatEvent {
    const item = this.items.get(id)?.get(itemId);
    if (item?.type === "assistant_message") this.items.get(id)!.set(itemId, { ...item, markdown: item.markdown + delta });
    if (item?.type === "reasoning") this.items.get(id)!.set(itemId, { ...item, text: item.text + delta });
    const authoritative = this.authoritativeItems.get(id) ?? [];
    const sourceIndex = authoritative.findIndex(candidate => candidate.id === itemId);
    const source = authoritative[sourceIndex];
    if (source?.type === "assistant_message") authoritative[sourceIndex] = { ...source, markdown: source.markdown + delta };
    if (source?.type === "reasoning") authoritative[sourceIndex] = { ...source, text: source.text + delta };
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

  private reversibleHistoryMutation(id: string, requestId: string, direction: "undo" | "redo" | "revert" | "restore", messageId?: string): Promise<ReversibleHistoryResult> {
    this.require(id);
    const key = `${direction}:${id}:${requestId}`;
    const existing = this.receipts.get(key) as ReversibleHistoryResult | Promise<ReversibleHistoryResult> | undefined;
    if (existing) return Promise.resolve(existing);
    const previous = this.reversibleLanes.get(id) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(() => this.performReversibleHistoryMutation(id, requestId, direction, messageId));
    this.receipts.set(key, pending);
    const settled = pending.then(result => {
      this.receipts.set(key, result);
      return result;
    }, error => {
      this.receipts.delete(key);
      throw error;
    });
    const tail = settled.then(() => undefined, () => undefined);
    this.reversibleLanes.set(id, tail);
    void tail.then(() => { if (this.reversibleLanes.get(id) === tail) this.reversibleLanes.delete(id); });
    return settled;
  }

  private async performReversibleHistoryMutation(id: string, requestId: string, direction: "undo" | "redo" | "revert" | "restore", messageId?: string): Promise<ReversibleHistoryResult> {
    if (!this.capabilities.includes("reversible-history")) throw new ReversibleHistoryUnsupportedError();
    this.reversibleAttempts.push({ direction, conversationId: id, requestId });
    if ((direction === "undo" || direction === "redo") && this.failNextReversible === direction) {
      this.failNextReversible = null;
      throw new Error(`${direction} rejected by fixture`);
    }

    const authoritative = this.authoritativeItems.get(id)!;
    const currentBoundary = this.boundaryIndex(id);
    let restored: ConversationItem | undefined;
    if (direction === "undo" || direction === "revert") {
      const before = currentBoundary ?? authoritative.length;
      if (direction === "revert") {
        const index = authoritative.findIndex(item => item.id === messageId && item.type === "user_message");
        if (index < 0 || index >= before) throw new ReversibleHistoryTargetError();
        restored = authoritative[index];
        this.revertBoundaries.set(id, restored!.id);
      } else {
        for (let index = before - 1; index >= 0; index -= 1) {
          if (authoritative[index]?.type === "user_message") {
            restored = authoritative[index];
            this.revertBoundaries.set(id, restored.id);
            break;
          }
        }
      }
      if (!restored) {
        return { outcome: "nothing-to-undo", state: this.reversibleState(id) };
      }
      const status = this.require(id).status;
      if (status === "running" || status === "sending") this.setStatus(id, "interrupted");
    } else if (direction === "redo") {
      if (currentBoundary === undefined) {
        return { outcome: "nothing-to-redo", state: this.reversibleState(id) };
      }
      for (let index = currentBoundary + 1; index < authoritative.length; index += 1) {
        if (authoritative[index]?.type === "user_message") {
          restored = authoritative[index];
          this.revertBoundaries.set(id, restored.id);
          break;
        }
      }
      if (!restored) this.revertBoundaries.delete(id);
    } else {
      if (currentBoundary === undefined) throw new ReversibleHistoryTargetError();
      const target = authoritative.findIndex((item, index) => index >= currentBoundary && item.id === messageId && item.type === "user_message");
      if (target < 0) throw new ReversibleHistoryTargetError();
      for (let index = target + 1; index < authoritative.length; index += 1) {
        if (authoritative[index]?.type === "user_message") {
          restored = authoritative[index];
          this.revertBoundaries.set(id, restored.id);
          break;
        }
      }
      if (!restored) this.revertBoundaries.delete(id);
    }

    this.replaceVisibleHistory(id);
    await this.restoreReversibleFiles(id);
    this.replay.get(id)!.publish({ type: "resync", reason: "conversation-rewritten" });
    const state = this.reversibleState(id);
    const result: ReversibleHistoryResult = {
      outcome: "changed",
      state,
      ...(restored?.type === "user_message"
        ? { restoredDraft: { text: restored.text, ...(restored.attachments?.length ? { attachments: structuredClone(restored.attachments) } : {}) } }
        : {}),
    };
    if (!state.staged) this.deliverNext(id);
    return result;
  }

  private boundaryIndex(id: string): number | undefined {
    const boundary = this.revertBoundaries.get(id);
    if (!boundary) return undefined;
    const index = this.authoritativeItems.get(id)!.findIndex(item => item.id === boundary);
    return index < 0 ? undefined : index;
  }

  private reversibleState(id: string): ReversibleHistoryState {
    const authoritative = this.authoritativeItems.get(id) ?? [];
    const boundary = this.boundaryIndex(id);
    const visibleEnd = boundary ?? authoritative.length;
    return {
      staged: boundary !== undefined,
      canUndo: authoritative.slice(0, visibleEnd).some(item => item.type === "user_message"),
      canRedo: boundary !== undefined,
      revertedMessages: boundary === undefined
        ? []
        : authoritative.slice(boundary)
          .filter((item): item is Extract<ConversationItem, { type: "user_message" }> => item.type === "user_message")
          .map(item => ({ id: item.id, text: item.text.trim() || item.attachments?.map(attachment => attachment.name).join(", ") || "Message" })),
    };
  }

  private replaceVisibleHistory(id: string): void {
    const authoritative = this.authoritativeItems.get(id)!;
    const end = this.boundaryIndex(id) ?? authoritative.length;
    this.items.set(id, new Map(authoritative.slice(0, end).map(item => [item.id, structuredClone(item)])));
  }

  private commitRevertedBranch(id: string): void {
    const boundary = this.boundaryIndex(id);
    if (boundary === undefined) return;
    this.authoritativeItems.get(id)!.splice(boundary);
    this.revertBoundaries.delete(id);
    this.replaceVisibleHistory(id);
    this.replay.get(id)!.publish({ type: "resync", reason: "conversation-rewritten" });
  }

  private async restoreReversibleFiles(id: string): Promise<void> {
    if (!this.options.restoreFile) return;
    const visible = [...this.items.get(id)!.values()];
    for (const fixture of this.reversibleFiles.get(id) ?? []) {
      let contents = fixture.baseline;
      for (const item of visible) {
        if (item.type === "user_message" && Object.hasOwn(fixture.versions, item.id)) contents = fixture.versions[item.id]!;
      }
      await this.options.restoreFile(fixture.relativePath, contents);
    }
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
      ...(this.capabilities.includes("reversible-history")
        ? { reversibleHistory: this.reversibleState(id) }
        : {}),
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
