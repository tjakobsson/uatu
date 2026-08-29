import { OpenCodeChatAdapter, type ChatAdapterOptions, type ChatEventMetrics } from "./adapter";
import { createAttachmentStore, type AttachmentStore, type StoredAttachment } from "./attachment-store";
import { OpenCodeService, type OpenCodeServiceOptions } from "./opencode-service";
import type { ConversationInventorySubscription } from "./inventory-broadcaster";
import { createSdkV2Provider } from "./sdk-v2-provider";
import type { OpenCodeProvider } from "./provider";
import type { ReplaySubscription } from "./replay";
import type {
  ChatMode,
  ChatAvailability,
  ChatCommand,
  ChatModel,
  ConversationConfiguration,
  ConversationSnapshot,
  ConversationSummary,
  MessageAttachment,
  PermissionOutcome,
  ModelSelection,
  QuestionOutcome,
  ReversibleHistoryResult,
} from "./types";

export interface WorkspaceChatService {
  status(): Promise<ChatAvailability>;
  retry(): Promise<ChatAvailability>;
  models(): Promise<ChatModel[]>;
  modes(): Promise<ChatMode[]>;
  commands(): Promise<ChatCommand[]>;
  listConversations(): Promise<ConversationSummary[]>;
  subscribeInventory(options?: { signal?: AbortSignal }): Promise<ConversationInventorySubscription>;
  createConversation(): Promise<ConversationSnapshot>;
  history(id: string, options?: { cursor?: string; limit?: number }): Promise<ConversationSnapshot>;
  subscribe(id: string, options?: { cursor?: string; signal?: AbortSignal }): Promise<{
    snapshot: ConversationSnapshot;
    events: ReplaySubscription;
  }>;
  prompt(id: string, requestId: string, text: string, model?: ModelSelection, mode?: string, variant?: string, attachments?: MessageAttachment[]): Promise<{
    messageId: string;
    held: boolean;
    configuration: ConversationConfiguration;
    conversation?: ConversationSummary;
  }>;
  removeQueued(id: string, messageId: string, requestId: string): Promise<{ removed: true }>;
  // The attachment store is workspace state, not agent state: uploads and
  // serving work regardless of whether the agent runtime is up.
  saveAttachment(bytes: Uint8Array): Promise<{ id: string; mimeType: string; sizeBytes: number }>;
  resolveAttachment(id: string): Promise<StoredAttachment | null>;
  renameConversation(id: string, requestId: string, title: string): Promise<{ conversation: ConversationSummary }>;
  cancel(id: string, requestId: string): Promise<{ cancelled: true }>;
  undo(id: string, requestId: string): Promise<ReversibleHistoryResult>;
  redo(id: string, requestId: string): Promise<ReversibleHistoryResult>;
  revert(id: string, messageId: string, requestId: string): Promise<ReversibleHistoryResult>;
  restore(id: string, messageId: string, requestId: string): Promise<ReversibleHistoryResult>;
  respondPermission(id: string, interactionId: string, requestId: string, outcome: PermissionOutcome): Promise<{ outcome: PermissionOutcome }>;
  respondQuestion(id: string, interactionId: string, requestId: string, outcome: QuestionOutcome): Promise<{ outcome: QuestionOutcome }>;
  dispose(): Promise<void>;
}

export class ChatUnavailableError extends Error {
  constructor() {
    super("chat is unavailable");
    this.name = "ChatUnavailableError";
  }
}

export type LazyOpenCodeChatServiceOptions = OpenCodeServiceOptions & {
  runtime?: OpenCodeService;
  createProvider?: (options: { endpoint: string; password: string; directory: string }) => OpenCodeProvider;
  createAdapter?: (options: ChatAdapterOptions) => OpenCodeChatAdapter;
  // Overrides the XDG-resolved store; the e2e harness points this at a
  // temporary directory.
  attachmentStore?: AttachmentStore;
  // Passed through to the adapter's event pump so discarded-event counts land
  // in the workspace's diagnostic registry.
  metrics?: ChatEventMetrics;
};

export class LazyOpenCodeChatService implements WorkspaceChatService {
  private readonly runtime: OpenCodeService;
  private readonly workspacePath: string;
  private readonly createProvider: NonNullable<LazyOpenCodeChatServiceOptions["createProvider"]>;
  private readonly createAdapter: NonNullable<LazyOpenCodeChatServiceOptions["createAdapter"]>;
  private readonly attachmentStore: AttachmentStore;
  private readonly metrics: ChatEventMetrics | undefined;
  private adapterPromise: Promise<OpenCodeChatAdapter> | null = null;
  private adapter: OpenCodeChatAdapter | null = null;
  private retryPromise: Promise<ChatAvailability> | null = null;
  private disposed = false;

  constructor(options: LazyOpenCodeChatServiceOptions) {
    this.workspacePath = options.workspacePath;
    this.runtime = options.runtime ?? new OpenCodeService(options);
    this.createProvider = options.createProvider ?? createSdkV2Provider;
    this.createAdapter = options.createAdapter ?? (adapterOptions => new OpenCodeChatAdapter(adapterOptions));
    this.attachmentStore = options.attachmentStore ?? createAttachmentStore({ workspacePath: options.workspacePath });
    this.metrics = options.metrics;
  }

  async status(): Promise<ChatAvailability> {
    const availability = await this.runtime.status();
    if (availability.state !== "ready") return availability;
    try {
      // The agent is attached here rather than in the runtime: the runtime
      // knows a process is up, and only the adapter's provider knows who it
      // is and what it offers.
      const adapter = await this.ensureAdapter();
      return { ...availability, agent: adapter.agent() };
    } catch (error) {
      // Deliberately not cached: ensureAdapter forgets a rejected attempt, so
      // the next status() call rebuilds and re-probes. A transient failure — a
      // connection race right after the runtime reports ready, a dropped
      // request — must not lock chat into "unavailable" for the process
      // lifetime; a genuinely incompatible server just fails the probe again.
      if (error instanceof ChatUnavailableError) {
        return { state: "unavailable", reason: "startup-failed", message: "OpenCode is restarting; chat will retry." };
      }
      return {
        state: "unavailable",
        reason: "unsupported",
        message: "The installed OpenCode version is not compatible with chat.",
      };
    }
  }

  // User-initiated recovery from a cached startup failure. Drops the adapter
  // built against the dead runtime so the next call rebuilds against whatever
  // the retry produced — and retires it first, or its supervisor would keep
  // reconnecting the dead endpoint forever, one leaked loop per retry.
  //
  // Coalesced across the WHOLE sequence: runtime-level joining cannot help
  // two retries that reach it at different times — the first can stall on
  // pump shutdown and then restart the runtime the second one just built.
  retry(): Promise<ChatAvailability> {
    this.retryPromise ??= this.performRetry().finally(() => {
      this.retryPromise = null;
    });
    return this.retryPromise;
  }

  private async performRetry(): Promise<ChatAvailability> {
    const previous = this.adapter;
    this.adapterPromise = null;
    this.adapter = null;
    await previous?.dispose().catch(() => undefined);
    // A full restart, not a bare runtime retry: an adapter-level failure
    // (compatibility probe, startup race) leaves the runtime "ready", and
    // re-probing the same process can never pick up a replaced binary.
    await this.runtime.restart();
    // Any adapter another request built while the runtime was being torn
    // down bound to the old, now-dead endpoint. Retire it too — otherwise
    // the status() below would reuse its adapterPromise and report Chat
    // ready on a connection that no longer exists.
    // Not narrowed to null by the assignment above: ensureAdapter can have
    // repopulated the reference while the awaits yielded.
    const stray = this.adapter as OpenCodeChatAdapter | null;
    this.adapterPromise = null;
    this.adapter = null;
    await stray?.dispose().catch(() => undefined);
    return this.status();
  }

  async listConversations() { return (await this.requireAdapter()).listConversations(); }
  async models() { return (await this.requireAdapter()).models(); }
  async modes() { return (await this.requireAdapter()).modes(); }
  async commands() { return (await this.requireAdapter()).commands(); }
  async subscribeInventory(options: { signal?: AbortSignal } = {}) { return (await this.requireAdapter()).subscribeInventory(options.signal); }
  async createConversation() { return (await this.requireAdapter()).createConversation(); }
  async history(id: string, options?: { cursor?: string; limit?: number }) { return (await this.requireAdapter()).history(id, options); }
  async subscribe(id: string, options?: { cursor?: string; signal?: AbortSignal }) { return (await this.requireAdapter()).subscribe(id, options); }
  async prompt(id: string, requestId: string, text: string, model?: ModelSelection, mode?: string, variant?: string, attachments?: MessageAttachment[]) { return (await this.requireAdapter()).prompt(id, requestId, text, model, mode, variant, attachments); }
  async removeQueued(id: string, messageId: string, requestId: string) { return (await this.requireAdapter()).removeQueued(id, messageId, requestId); }
  async saveAttachment(bytes: Uint8Array) {
    const stored = await this.attachmentStore.save(bytes);
    return { id: stored.id, mimeType: stored.mimeType, sizeBytes: stored.sizeBytes };
  }
  async resolveAttachment(id: string) { return this.attachmentStore.resolve(id); }
  async cancel(id: string, requestId: string) { return (await this.requireAdapter()).abort(id, requestId); }
  async undo(id: string, requestId: string) { return (await this.requireAdapter()).undo(id, requestId); }
  async redo(id: string, requestId: string) { return (await this.requireAdapter()).redo(id, requestId); }
  async revert(id: string, messageId: string, requestId: string) { return (await this.requireAdapter()).revert(id, messageId, requestId); }
  async restore(id: string, messageId: string, requestId: string) { return (await this.requireAdapter()).restore(id, messageId, requestId); }
  async renameConversation(id: string, requestId: string, title: string) { return (await this.requireAdapter()).renameConversation(id, requestId, title); }
  async respondPermission(id: string, interactionId: string, requestId: string, outcome: PermissionOutcome) {
    return (await this.requireAdapter()).respondPermission(id, interactionId, requestId, outcome);
  }
  async respondQuestion(id: string, interactionId: string, requestId: string, outcome: QuestionOutcome) {
    return (await this.requireAdapter()).respondQuestion(id, interactionId, requestId, outcome);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const runtimeDisposal = this.runtime.dispose();
    await this.adapter?.dispose().catch(() => undefined);
    await runtimeDisposal;
  }

  private async requireAdapter(): Promise<OpenCodeChatAdapter> {
    const availability = await this.status();
    if (availability.state !== "ready") throw new ChatUnavailableError();
    return this.ensureAdapter();
  }

  private ensureAdapter(): Promise<OpenCodeChatAdapter> {
    const pending = this.adapterPromise ??= (async () => {
      const connection = this.runtime.currentConnection();
      if (!connection) throw new ChatUnavailableError();
      const provider = this.createProvider({
        endpoint: connection.endpoint,
        password: connection.password,
        directory: this.workspacePath,
      });
      // A passing health check says nothing about SDK compatibility, and event
      // pump failures are swallowed by the supervisor — without a probe an
      // incompatible server reports "ready" and then fails every operation.
      await provider.listModels();
      const adapter = this.createAdapter({
        provider,
        workspacePath: this.workspacePath,
        resolveAttachment: id => this.attachmentStore.resolve(id),
        metrics: this.metrics,
      });
      this.adapter = adapter;
      this.superviseEventPump(adapter);
      return adapter;
    })();
    pending.catch(() => { if (this.adapterPromise === pending) this.adapterPromise = null; });
    return pending;
  }

  /**
   * The event pump ends whenever the provider stream dies (OpenCode restart,
   * SDK error). Without supervision that failure is silent: HTTP keeps
   * working and SSE keepalives keep flowing while agent events never arrive
   * again. Restart with capped backoff until the service is disposed.
   */
  private superviseEventPump(adapter: OpenCodeChatAdapter): void {
    void (async () => {
      let failures = 0;
      // `this.adapter === adapter` retires the loop when retry() replaces the
      // adapter: dispose() is not the only way an adapter stops being current.
      while (!this.disposed && this.adapter === adapter) {
        const startedAt = Date.now();
        try {
          await adapter.startEventPump();
        } catch {
          // fall through to the retry delay
        }
        if (this.disposed || this.adapter !== adapter) return;
        failures = Date.now() - startedAt > 60_000 ? 0 : failures + 1;
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, Math.min(1_000 * 2 ** (failures - 1), 30_000));
          (timer as unknown as { unref?: () => void }).unref?.();
        });
      }
    })();
  }
}
