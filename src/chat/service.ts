import { OpenCodeChatAdapter, type ChatAdapterOptions, type ChatEventMetrics } from "./adapter";
import { OpenCodeService, type OpenCodeServiceOptions } from "./opencode-service";
import { createSdkV2Provider } from "./sdk-v2-provider";
import type { OpenCodeProvider } from "./provider";
import type { ReplaySubscription } from "./replay";
import type {
  ChatAvailability,
  ChatCommand,
  ChatModel,
  ConversationSnapshot,
  ConversationSummary,
  PermissionOutcome,
  ModelSelection,
  QuestionOutcome,
} from "./types";

export interface WorkspaceChatService {
  status(): Promise<ChatAvailability>;
  retry(): Promise<ChatAvailability>;
  models(): Promise<ChatModel[]>;
  commands(): Promise<ChatCommand[]>;
  listConversations(): Promise<ConversationSummary[]>;
  createConversation(): Promise<ConversationSnapshot>;
  history(id: string, options?: { cursor?: string; limit?: number }): Promise<ConversationSnapshot>;
  subscribe(id: string, options?: { cursor?: string; signal?: AbortSignal }): Promise<{
    snapshot: ConversationSnapshot;
    events: ReplaySubscription;
  }>;
  prompt(id: string, requestId: string, text: string, model?: ModelSelection): Promise<{
    messageId: string;
    delivery: "steer" | "queue";
    conversation?: ConversationSummary;
  }>;
  cancel(id: string, requestId: string): Promise<{ cancelled: true }>;
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
  // Passed through to the adapter's event pump so discarded-event counts land
  // in the workspace's diagnostic registry.
  metrics?: ChatEventMetrics;
};

export class LazyOpenCodeChatService implements WorkspaceChatService {
  private readonly runtime: OpenCodeService;
  private readonly workspacePath: string;
  private readonly createProvider: NonNullable<LazyOpenCodeChatServiceOptions["createProvider"]>;
  private readonly createAdapter: NonNullable<LazyOpenCodeChatServiceOptions["createAdapter"]>;
  private readonly metrics: ChatEventMetrics | undefined;
  private adapterPromise: Promise<OpenCodeChatAdapter> | null = null;
  private adapter: OpenCodeChatAdapter | null = null;
  private disposed = false;

  constructor(options: LazyOpenCodeChatServiceOptions) {
    this.workspacePath = options.workspacePath;
    this.runtime = options.runtime ?? new OpenCodeService(options);
    this.createProvider = options.createProvider ?? createSdkV2Provider;
    this.createAdapter = options.createAdapter ?? (adapterOptions => new OpenCodeChatAdapter(adapterOptions));
    this.metrics = options.metrics;
  }

  async status(): Promise<ChatAvailability> {
    const availability = await this.runtime.status();
    if (availability.state !== "ready") return availability;
    try {
      await this.ensureAdapter();
      return availability;
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
  // the retry produced.
  async retry(): Promise<ChatAvailability> {
    this.adapterPromise = null;
    this.adapter = null;
    await this.runtime.retry();
    return this.status();
  }

  async listConversations() { return (await this.requireAdapter()).listConversations(); }
  async models() { return (await this.requireAdapter()).models(); }
  async commands() { return (await this.requireAdapter()).commands(); }
  async createConversation() { return (await this.requireAdapter()).createConversation(); }
  async history(id: string, options?: { cursor?: string; limit?: number }) { return (await this.requireAdapter()).history(id, options); }
  async subscribe(id: string, options?: { cursor?: string; signal?: AbortSignal }) { return (await this.requireAdapter()).subscribe(id, options); }
  async prompt(id: string, requestId: string, text: string, model?: ModelSelection) { return (await this.requireAdapter()).prompt(id, requestId, text, model); }
  async cancel(id: string, requestId: string) { return (await this.requireAdapter()).abort(id, requestId); }
  async respondPermission(id: string, interactionId: string, requestId: string, outcome: PermissionOutcome) {
    return (await this.requireAdapter()).respondPermission(id, interactionId, requestId, outcome);
  }
  async respondQuestion(id: string, interactionId: string, requestId: string, outcome: QuestionOutcome) {
    return (await this.requireAdapter()).respondQuestion(id, interactionId, requestId, outcome);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const runtimeDisposal = this.runtime.dispose();
    await this.adapter?.stopEventPump().catch(() => undefined);
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
      const adapter = this.createAdapter({ provider, workspacePath: this.workspacePath, metrics: this.metrics });
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
      while (!this.disposed) {
        const startedAt = Date.now();
        try {
          await adapter.startEventPump();
        } catch {
          // fall through to the retry delay
        }
        if (this.disposed) return;
        failures = Date.now() - startedAt > 60_000 ? 0 : failures + 1;
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, Math.min(1_000 * 2 ** (failures - 1), 30_000));
          (timer as unknown as { unref?: () => void }).unref?.();
        });
      }
    })();
  }
}
