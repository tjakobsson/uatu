import { createAttachmentStore, type AttachmentStore, type StoredAttachment } from "./attachment-store";
import { ConversationInventoryBroadcaster, type ConversationInventorySubscription } from "./inventory-broadcaster";
import type { WorkspaceChatService } from "./service";
import { ConversationNotFoundError } from "./workspace";
import type {
  AgentChatStatus,
  ChatAgentDescriptor,
  ChatAvailability,
  ChatEvent,
  ChatMode,
  ChatCommand,
  ChatModel,
  ConversationConfiguration,
  ConversationItem,
  ConversationSnapshot,
  ConversationSummary,
  MessageAttachment,
  ModelSelection,
  PermissionOutcome,
  QuestionOutcome,
  ReversibleHistoryResult,
} from "./types";

export type { AgentChatStatus, ChatAgentDescriptor } from "./types";

export type AgentConversationSummary = ConversationSummary & { agent: ChatAgentDescriptor };
export type AgentConversationSnapshot = Omit<ConversationSnapshot, "conversation"> & {
  conversation: AgentConversationSummary;
};

// What routes actually need from an event subscription; both the per-agent
// ReplaySubscription and the router's qualifying wrapper satisfy it.
export type ChatEventSubscription = AsyncIterable<ChatEvent> & { cancel(): void };

export type RegisteredChatAgent = {
  descriptor: ChatAgentDescriptor;
  service: WorkspaceChatService;
};

export class UnknownAgentError extends Error {
  constructor(agentId: string) {
    super(`unknown chat agent: ${agentId}`);
    this.name = "UnknownAgentError";
  }
}

/**
 * `<agentId>:<conversationId>` — the wire form of a conversation id (D3).
 * Agent ids never contain a colon (the registry enforces it), so the first
 * colon is always the boundary. Provider ids pass through untouched behind
 * it, which is what keeps existing OpenCode conversations addressable.
 */
export function qualifyConversationId(agentId: string, conversationId: string): string {
  return `${agentId}:${conversationId}`;
}

export function parseQualifiedConversationId(qualified: string): { agentId: string; conversationId: string } | null {
  const boundary = qualified.indexOf(":");
  if (boundary <= 0 || boundary === qualified.length - 1) return null;
  return { agentId: qualified.slice(0, boundary), conversationId: qualified.slice(boundary + 1) };
}

export type MultiAgentChatServiceOptions = {
  workspacePath: string;
  // Presentation order; the first entry is the server's default agent.
  agents: RegisteredChatAgent[];
  attachmentStore?: AttachmentStore;
  // How long one agent's enumeration may hold up the merged list before
  // the others are served without it (its late arrival ticks the
  // inventory so clients re-fetch). Tests shorten it.
  inventoryContributionTimeoutMs?: number;
};

/**
 * The workspace chat surface routes consume: every conversation id on this
 * interface is agent-qualified, agent-scoped reads name their agent, and
 * status is per-agent. Implemented by the router below and by test fakes.
 */
export interface MultiAgentWorkspaceChatService {
  agents(): ChatAgentDescriptor[];
  defaultAgentId(): string;
  status(): Promise<AgentChatStatus[]>;
  retry(agentId: string): Promise<AgentChatStatus>;
  models(agentId: string): Promise<ChatModel[]>;
  modes(agentId: string): Promise<ChatMode[]>;
  commands(agentId: string): Promise<ChatCommand[]>;
  listConversations(): Promise<AgentConversationSummary[]>;
  subscribeInventory(options?: { signal?: AbortSignal }): Promise<ConversationInventorySubscription>;
  createConversation(agentId?: string): Promise<AgentConversationSnapshot>;
  history(id: string, options?: { cursor?: string; limit?: number }): Promise<AgentConversationSnapshot>;
  subscribe(id: string, options?: { cursor?: string; signal?: AbortSignal }): Promise<{
    snapshot: AgentConversationSnapshot;
    events: ChatEventSubscription;
  }>;
  prompt(id: string, requestId: string, text: string, model?: ModelSelection, mode?: string, variant?: string, attachments?: MessageAttachment[]): Promise<{
    messageId: string;
    held: boolean;
    configuration: ConversationConfiguration;
    conversation?: AgentConversationSummary;
  }>;
  removeQueued(id: string, messageId: string, requestId: string): Promise<{ removed: true }>;
  saveAttachment(bytes: Uint8Array): Promise<{ id: string; mimeType: string; sizeBytes: number }>;
  resolveAttachment(id: string): Promise<StoredAttachment | null>;
  renameConversation(id: string, requestId: string, title: string): Promise<{ conversation: AgentConversationSummary }>;
  cancel(id: string, requestId: string): Promise<{ cancelled: true }>;
  undo(id: string, requestId: string): Promise<ReversibleHistoryResult>;
  redo(id: string, requestId: string): Promise<ReversibleHistoryResult>;
  revert(id: string, messageId: string, requestId: string): Promise<ReversibleHistoryResult>;
  restore(id: string, messageId: string, requestId: string): Promise<ReversibleHistoryResult>;
  respondPermission(id: string, interactionId: string, requestId: string, outcome: PermissionOutcome, choiceId?: string): Promise<{ outcome: PermissionOutcome }>;
  respondQuestion(id: string, interactionId: string, requestId: string, outcome: QuestionOutcome): Promise<{ outcome: QuestionOutcome }>;
  stopTask(id: string, taskId: string, requestId: string): Promise<{ stopped: true }>;
  dispose(): Promise<void>;
}

/**
 * The workspace's chat surface over N agents: a thin router (D3). Every
 * conversation-scoped call parses the qualified id, delegates to the owning
 * agent's stack with the bare id, and re-qualifies every conversation id in
 * the result. Status and inventory fan out and merge; one agent failing
 * affects only its own entries.
 */
export class MultiAgentChatService implements MultiAgentWorkspaceChatService {
  private readonly agentsById = new Map<string, RegisteredChatAgent>();
  private readonly order: RegisteredChatAgent[];
  private readonly attachmentStore: AttachmentStore;
  private readonly inventoryHub = new MergedInventoryHub(async () =>
    (await Promise.all(this.order.map(agent => {
      const subscribe = agent.service.subscribeInventory().catch(() => null);
      // Same bound as the REST inventory path: one agent's stalled startup
      // must not hold the merged SSE subscription (and its abort cleanup)
      // hostage. A late subscription is cancelled and the hub refreshed so
      // the healed agent re-enters the merge.
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        subscribe,
        new Promise<null>(resolve => {
          timer = setTimeout(() => resolve(null), this.inventoryContributionTimeoutMs);
          (timer as unknown as { unref?: () => void }).unref?.();
        }),
      ]).then(source => {
        if (timer !== undefined) clearTimeout(timer);
        if (source === null) {
          void subscribe.then(late => {
            if (!late) return;
            late.cancel();
            this.inventoryHub.refresh();
          });
        }
        return source;
      });
    }))).filter((source): source is ConversationInventorySubscription => source !== null));

  constructor(options: MultiAgentChatServiceOptions) {
    if (options.agents.length === 0) throw new Error("at least one chat agent is required");
    for (const agent of options.agents) {
      if (agent.descriptor.id.includes(":")) throw new Error(`agent id must not contain ":": ${agent.descriptor.id}`);
      if (this.agentsById.has(agent.descriptor.id)) throw new Error(`duplicate agent id: ${agent.descriptor.id}`);
      this.agentsById.set(agent.descriptor.id, agent);
    }
    this.order = [...options.agents];
    // The store is workspace state shared across agents — same backing
    // directory the per-agent stacks resolve, one authority for routes.
    this.attachmentStore = options.attachmentStore ?? createAttachmentStore({ workspacePath: options.workspacePath });
    this.inventoryContributionTimeoutMs = options.inventoryContributionTimeoutMs ?? 4_000;
  }

  private readonly inventoryContributionTimeoutMs: number;

  agents(): ChatAgentDescriptor[] {
    return this.order.map(agent => agent.descriptor);
  }

  defaultAgentId(): string {
    return this.order[0]!.descriptor.id;
  }

  async status(): Promise<AgentChatStatus[]> {
    return Promise.all(this.order.map(async agent => ({
      agent: agent.descriptor,
      availability: await agent.service.status().catch((error): ChatAvailability => ({
        state: "unavailable",
        reason: "startup-failed",
        message: error instanceof Error ? error.message : "agent status failed",
      })),
    })));
  }

  async retry(agentId: string): Promise<AgentChatStatus> {
    const agent = this.requireAgent(agentId);
    const availability = await agent.service.retry();
    // The merged inventory may have dropped this agent at connect time;
    // a repaired agent's conversations must re-enter the chooser.
    if (availability.state === "ready") this.inventoryHub.refresh();
    return { agent: agent.descriptor, availability };
  }

  async models(agentId: string): Promise<ChatModel[]> { return this.requireAgent(agentId).service.models(); }
  async modes(agentId: string): Promise<ChatMode[]> { return this.requireAgent(agentId).service.modes(); }
  async commands(agentId: string): Promise<ChatCommand[]> { return this.requireAgent(agentId).service.commands(); }

  /**
   * Merged across agents, newest first. An agent that cannot enumerate
   * contributes nothing — its outage must not hide another agent's entries
   * (spec: a failing agent does not empty the chooser).
   */
  async listConversations(): Promise<AgentConversationSummary[]> {
    const lists = await Promise.all(this.order.map(async agent => {
      const read = (async () => {
        const conversations = await agent.service.listConversations();
        return conversations.map(summary => this.qualifySummary(agent.descriptor, summary));
      })();
      read.catch(() => undefined);
      // One agent's stalled startup (a cold probe can run to its timeout)
      // must not withhold another agent's already-answered list: the
      // straggler is bounded, and its late arrival ticks the inventory so
      // clients re-fetch and see it.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bounded = await Promise.race([
        read.catch(() => [] as AgentConversationSummary[]),
        new Promise<null>(resolve => {
          timer = setTimeout(() => resolve(null), this.inventoryContributionTimeoutMs);
          (timer as unknown as { unref?: () => void }).unref?.();
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (bounded !== null) return bounded;
      void read.then(late => { if (late.length > 0) this.inventoryHub.tick(); }, () => undefined);
      return [] as AgentConversationSummary[];
    }));
    return lists.flat().sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  }

  /**
   * One inventory bit over all agents: any agent's tick surfaces as a tick
   * here, re-coalesced by the hub. An agent whose subscription cannot be
   * established is skipped — the hub still serves the agents that could.
   */
  async subscribeInventory(options: { signal?: AbortSignal } = {}): Promise<ConversationInventorySubscription> {
    return this.inventoryHub.subscribe(options.signal);
  }

  async createConversation(agentId?: string): Promise<AgentConversationSnapshot> {
    const agent = this.requireAgent(agentId ?? this.defaultAgentId());
    return this.qualifySnapshot(agent.descriptor, await agent.service.createConversation());
  }

  async history(id: string, options?: { cursor?: string; limit?: number }): Promise<AgentConversationSnapshot> {
    const { agent, conversationId } = this.resolve(id);
    return this.qualifySnapshot(agent.descriptor, await agent.service.history(conversationId, options));
  }

  async subscribe(id: string, options?: { cursor?: string; signal?: AbortSignal }): Promise<{
    snapshot: AgentConversationSnapshot;
    events: ChatEventSubscription;
  }> {
    const { agent, conversationId } = this.resolve(id);
    const { snapshot, events } = await agent.service.subscribe(conversationId, options);
    return {
      snapshot: this.qualifySnapshot(agent.descriptor, snapshot),
      events: new QualifyingEventSubscription(events, event => this.qualifyEvent(agent.descriptor, event)),
    };
  }

  async prompt(id: string, requestId: string, text: string, model?: ModelSelection, mode?: string, variant?: string, attachments?: MessageAttachment[]) {
    const { agent, conversationId } = this.resolve(id);
    const { conversation, ...accepted } = await agent.service.prompt(conversationId, requestId, text, model, mode, variant, attachments);
    return {
      ...accepted,
      ...(conversation ? { conversation: this.qualifySummary(agent.descriptor, conversation) } : {}),
    };
  }

  async removeQueued(id: string, messageId: string, requestId: string) {
    const { agent, conversationId } = this.resolve(id);
    return agent.service.removeQueued(conversationId, messageId, requestId);
  }

  async saveAttachment(bytes: Uint8Array): Promise<{ id: string; mimeType: string; sizeBytes: number }> {
    const stored = await this.attachmentStore.save(bytes);
    return { id: stored.id, mimeType: stored.mimeType, sizeBytes: stored.sizeBytes };
  }

  async resolveAttachment(id: string): Promise<StoredAttachment | null> {
    return this.attachmentStore.resolve(id);
  }

  async renameConversation(id: string, requestId: string, title: string): Promise<{ conversation: AgentConversationSummary }> {
    const { agent, conversationId } = this.resolve(id);
    const renamed = await agent.service.renameConversation(conversationId, requestId, title);
    return { conversation: this.qualifySummary(agent.descriptor, renamed.conversation) };
  }

  async cancel(id: string, requestId: string) {
    const { agent, conversationId } = this.resolve(id);
    return agent.service.cancel(conversationId, requestId);
  }

  async undo(id: string, requestId: string): Promise<ReversibleHistoryResult> {
    const { agent, conversationId } = this.resolve(id);
    return agent.service.undo(conversationId, requestId);
  }

  async redo(id: string, requestId: string): Promise<ReversibleHistoryResult> {
    const { agent, conversationId } = this.resolve(id);
    return agent.service.redo(conversationId, requestId);
  }

  async revert(id: string, messageId: string, requestId: string): Promise<ReversibleHistoryResult> {
    const { agent, conversationId } = this.resolve(id);
    return agent.service.revert(conversationId, messageId, requestId);
  }

  async restore(id: string, messageId: string, requestId: string): Promise<ReversibleHistoryResult> {
    const { agent, conversationId } = this.resolve(id);
    return agent.service.restore(conversationId, messageId, requestId);
  }

  async respondPermission(id: string, interactionId: string, requestId: string, outcome: PermissionOutcome, choiceId?: string) {
    const { agent, conversationId } = this.resolve(id);
    return agent.service.respondPermission(conversationId, interactionId, requestId, outcome, choiceId);
  }

  async respondQuestion(id: string, interactionId: string, requestId: string, outcome: QuestionOutcome) {
    const { agent, conversationId } = this.resolve(id);
    return agent.service.respondQuestion(conversationId, interactionId, requestId, outcome);
  }

  async stopTask(id: string, taskId: string, requestId: string) {
    const { agent, conversationId } = this.resolve(id);
    return agent.service.stopTask(conversationId, taskId, requestId);
  }

  async dispose(): Promise<void> {
    this.inventoryHub.dispose();
    await Promise.all(this.order.map(agent => agent.service.dispose().catch(() => undefined)));
  }

  private requireAgent(agentId: string): RegisteredChatAgent {
    const agent = this.agentsById.get(agentId);
    if (!agent) throw new UnknownAgentError(agentId);
    return agent;
  }

  /**
   * A conversation id that names no registered agent — including a bare
   * provider id that was never qualified — resolves to no conversation at
   * all. Rejecting here means a wrong-agent request never reaches another
   * agent's stack to be answered by coincidence.
   */
  private resolve(id: string): { agent: RegisteredChatAgent; conversationId: string } {
    const parsed = parseQualifiedConversationId(id);
    if (!parsed) throw new ConversationNotFoundError();
    const agent = this.agentsById.get(parsed.agentId);
    if (!agent) throw new ConversationNotFoundError();
    return { agent, conversationId: parsed.conversationId };
  }

  private qualifySummary(descriptor: ChatAgentDescriptor, summary: ConversationSummary): AgentConversationSummary {
    return { ...summary, id: qualifyConversationId(descriptor.id, summary.id), agent: descriptor };
  }

  private qualifyItem(descriptor: ChatAgentDescriptor, item: ConversationItem): ConversationItem {
    let next = item;
    if ((next.type === "permission" || next.type === "question") && next.conversationId) {
      next = { ...next, conversationId: qualifyConversationId(descriptor.id, next.conversationId) };
    }
    if (next.type === "tool" && next.childConversationId) {
      // A subagent child belongs to the same agent as its parent; the
      // drill-down opens it through the same qualified addressing.
      next = { ...next, childConversationId: qualifyConversationId(descriptor.id, next.childConversationId) };
    }
    return next;
  }

  private qualifySnapshot(descriptor: ChatAgentDescriptor, snapshot: ConversationSnapshot): AgentConversationSnapshot {
    return {
      ...snapshot,
      conversation: this.qualifySummary(descriptor, snapshot.conversation),
      items: snapshot.items.map(item => this.qualifyItem(descriptor, item)),
    };
  }

  private qualifyEvent(descriptor: ChatAgentDescriptor, event: ChatEvent): ChatEvent {
    const qualified: ChatEvent = { ...event, conversationId: qualifyConversationId(descriptor.id, event.conversationId) };
    if (qualified.type === "item.upsert") {
      return { ...qualified, item: this.qualifyItem(descriptor, qualified.item) };
    }
    if (qualified.type === "conversation.updated") {
      return { ...qualified, conversation: this.qualifySummary(descriptor, qualified.conversation) };
    }
    return qualified;
  }
}

class QualifyingEventSubscription implements AsyncIterable<ChatEvent> {
  constructor(
    private readonly source: ChatEventSubscription,
    private readonly map: (event: ChatEvent) => ChatEvent,
  ) {}

  cancel(): void {
    this.source.cancel();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ChatEvent> {
    // Consumer return()/throw() unwinds this generator's for-await, which
    // returns the source iterator — cancellation propagates without a
    // separate teardown path.
    for await (const event of this.source) yield this.map(event);
  }
}

/**
 * One inventory bit re-coalesced over all agents. Per-source pumps are
 * always-outstanding readers, which can split one source's coalesced burst
 * into two ticks — so ticks are not forwarded to subscribers directly but
 * poured into this hub's own broadcaster, whose one-bit semantics collapse
 * them again. Pumps are reference-counted: they exist only while someone is
 * subscribed, and the last unsubscribe (or abort) cancels every source.
 */
class MergedInventoryHub {
  private readonly broadcaster = new ConversationInventoryBroadcaster();
  private sources: ConversationInventorySubscription[] = [];
  private connecting: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly connect: () => Promise<ConversationInventorySubscription[]>) {}

  async subscribe(signal?: AbortSignal): Promise<ConversationInventorySubscription> {
    const subscription = this.broadcaster.subscribe(signal);
    if (this.disposed || signal?.aborted) return subscription;
    await this.ensureSources();
    const release = () => this.releaseIfIdle();
    signal?.addEventListener("abort", release, { once: true });
    return new Proxy(subscription, {
      get: (target, property, receiver) => {
        if (property === "cancel") {
          return () => {
            target.cancel();
            release();
          };
        }
        if (property === "return") {
          return async () => {
            const result = await target.return?.();
            release();
            return result ?? { value: undefined, done: true as const };
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  private async ensureSources(): Promise<void> {
    if (this.sources.length > 0) return;
    this.connecting ??= (async () => {
      const sources = await this.connect();
      if (this.disposed || this.broadcaster.subscriberCount() === 0) {
        for (const source of sources) source.cancel();
        return;
      }
      this.sources = sources;
      for (const source of sources) {
        void this.pump(source).finally(() => this.handlePumpEnd(source));
      }
    })().finally(() => { this.connecting = null; });
    await this.connecting;
  }

  /**
   * Forwards a source's ticks into the hub broadcaster, absorbing bursts.
   * The pump is an always-outstanding reader, so one burst on the source
   * splits into a resolved read plus a banked bit; forwarding both would
   * un-coalesce what the source deliberately collapsed. After each received
   * tick the pump keeps draining while the source can answer synchronously,
   * then forwards a single invalidation for the whole burst.
   */
  private async pump(source: ConversationInventorySubscription): Promise<void> {
    const MARKER = Symbol("no-immediate-tick");
    const marker = () => Promise.resolve().then(() => Promise.resolve()).then(() => MARKER as typeof MARKER);
    try {
      // Every source subscription opens with an initial "reconcile now" tick,
      // and so does the hub's own broadcaster toward each subscriber.
      // Forwarding the source's initial tick would double it: a subscriber
      // that consumed the hub's initial bit would receive a second frame
      // that announces nothing new. Swallow each source's first burst.
      let initial = true;
      let inflight = source.next();
      while (true) {
        let result = await inflight;
        if (result.done) return;
        while (true) {
          inflight = source.next();
          const drained = await Promise.race([inflight, marker()]);
          if (drained === MARKER) break;
          result = drained as IteratorResult<void>;
          if (result.done) {
            if (!initial) this.broadcaster.invalidate();
            return;
          }
        }
        if (!initial) this.broadcaster.invalidate();
        initial = false;
      }
    } catch {
      // A dead source stops ticking; the hub stays alive for the rest.
    }
  }

  /**
   * A source that ends while subscribers remain is a lost agent: its adapter
   * was replaced, its pump died, its runtime restarted. Reconnect every
   * source after a short delay and tick once so clients reconcile whatever
   * the dead window missed. Without this, one agent's transport interruption
   * silences that agent's inventory for the rest of the page's life.
   */
  private handlePumpEnd(source: ConversationInventorySubscription): void {
    const index = this.sources.indexOf(source);
    // A source no longer tracked was cancelled deliberately (a reconnect or
    // refresh spliced it out first); scheduling on its end would cancel the
    // replacements and churn the merge forever.
    if (index < 0) return;
    this.sources.splice(index, 1);
    if (this.disposed || this.broadcaster.subscriberCount() === 0 || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed || this.broadcaster.subscriberCount() === 0) return;
      for (const stale of this.sources.splice(0)) stale.cancel();
      void this.ensureSources().then(() => this.broadcaster.invalidate());
    }, 250);
    (this.reconnectTimer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * A repaired agent re-enters the merge. The initial connect drops an agent
   * whose subscription fails, and no pump exists to notice it healed — so a
   * successful retry reconnects every source and ticks once, the same
   * recovery a pump death gets.
   */
  /** One tick toward every subscriber: reconcile now. */
  tick(): void {
    this.broadcaster.invalidate();
  }

  refresh(): void {
    if (this.disposed || this.broadcaster.subscriberCount() === 0) return;
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    for (const stale of this.sources.splice(0)) stale.cancel();
    void this.ensureSources().then(() => this.broadcaster.invalidate());
  }

  private releaseIfIdle(): void {
    if (this.broadcaster.subscriberCount() > 0) return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const source of this.sources.splice(0)) source.cancel();
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.broadcaster.dispose();
    for (const source of this.sources.splice(0)) source.cancel();
  }
}
