import { createAttachmentStore, type AttachmentStore, type StoredAttachment } from "./attachment-store";
import { VisualStore, type VisualFileReader, type StoredVisual } from "./visual-store";
import { getChatVisuals } from "./visual-markdown";
import { VISUAL_MAX_COUNT } from "./visual-types";
import { CLAUDE_TEXT_BLOCKS, CLAUDE_TURN, claudeVisualIdentity, type ClaudeTextIdentity } from "./claude/normalization-types";
import { CHAT_VISUAL_MESSAGE, visualAdmissionIdentity } from "./visual-identity";
import { decodeReplayCursor } from "./replay";
import { isLiveConversationStatus } from "./types";
import { ConversationInventoryBroadcaster, type ConversationInventorySubscription } from "./inventory-broadcaster";
import { NotificationFeed } from "./notification-feed";
import type { ChatActionContext, AutomaticBackgroundFeedback } from "./types";
import { qualifyNotificationEvent } from "./notifications";
import type { WorkspaceChatService } from "./service";
import { ConversationNotFoundError } from "./workspace";
import { BackgroundTasksUnsupportedError, SideGenerationUnsupportedError } from "./adapter";
import type {
  AgentChatStatus,
  BackgroundTaskOutput,
  ChatActivity,
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
  MessageDelivery,
  ModelSelection,
  PermissionOutcome,
  QuestionOutcome,
  ReversibleHistoryResult, AgentUsageReport, UsageReadMode, UsageReadResult, ChatAccountChange } from "./types";

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

type VisualHistorySubscriber = {
  read(page: Promise<AgentConversationSnapshot>): void;
  cancel(): void;
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
  visualStore?: VisualStore;
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
  /** A login change made through the Hub's Agent accounts (internal route). */
  accountsChanged(agentId: string, change: ChatAccountChange): Promise<void>;
  readonly notificationFeed?: NotificationFeed;
  agents(): ChatAgentDescriptor[];
  defaultAgentId(): string;
  status(): Promise<AgentChatStatus[]>;
  retry(agentId: string): Promise<AgentChatStatus>;
  models(agentId: string): Promise<ChatModel[]>;
  modes(agentId: string): Promise<ChatMode[]>;
  commands(agentId: string): Promise<ChatCommand[]>;
  listConversations(): Promise<AgentConversationSummary[]>;
  subscribeInventory(options?: { signal?: AbortSignal }): Promise<ConversationInventorySubscription>;
  // The workspace activity summary over every agent, and its change ticks.
  // Neither starts an agent runtime.
  activity(): Promise<ChatActivity>;
  subscribeActivity(options?: { signal?: AbortSignal }): Promise<ConversationInventorySubscription>;
  createConversation(agentId?: string): Promise<AgentConversationSnapshot>;
  history(id: string, options?: { cursor?: string; limit?: number }): Promise<AgentConversationSnapshot>;
  workerEvidence?(id: string): Promise<import("./worker-dismissal-evidence").WorkerEvidenceSnapshot>;
  // The existing transport-recovery hint is false for fresh history attachments.
  subscribe(id: string, options?: { cursor?: string; signal?: AbortSignal; reconnect?: boolean }): Promise<{
    snapshot: AgentConversationSnapshot;
    events: ChatEventSubscription;
  }>;
  prompt(id: string, requestId: string, text: string, model?: ModelSelection, mode?: string, variant?: string, attachments?: MessageAttachment[], delivery?: MessageDelivery, context?: ChatActionContext, operationReceipt?: string): Promise<{
    messageId: string;
    pending: boolean;
    delivery: MessageDelivery;
    configuration: ConversationConfiguration;
    conversation?: AgentConversationSummary;
  } & AutomaticBackgroundFeedback>;
  removeQueued(id: string, messageId: string, requestId: string): Promise<{ removed: true }>;
  discardUnconfirmedSteer(id: string, messageId: string, requestId: string, uncertaintyId: string): Promise<{ discarded: true; outcomeUnconfirmed: true }>;
  changeDelivery(id: string, messageId: string, requestId: string, delivery: MessageDelivery, context?: ChatActionContext, operationReceipt?: string): Promise<{ messageId: string; delivery: MessageDelivery } & AutomaticBackgroundFeedback>;
  sendNow(id: string, messageId: string, requestId: string, context?: ChatActionContext, operationReceipt?: string): Promise<{ messageId: string; delivery: MessageDelivery } & AutomaticBackgroundFeedback>;
  saveAttachment(bytes: Uint8Array): Promise<{ id: string; mimeType: string; sizeBytes: number }>;
  resolveAttachment(id: string): Promise<StoredAttachment | null>;
  configureVisualReader?(reader: VisualFileReader): void;
  resolveVisual?(id: string): Promise<StoredVisual | null>;
  renameConversation(id: string, requestId: string, title: string): Promise<{ conversation: AgentConversationSummary }>;
  cancel(id: string, requestId: string): Promise<{ cancelled: true }>;
  undo(id: string, requestId: string): Promise<ReversibleHistoryResult>;
  redo(id: string, requestId: string): Promise<ReversibleHistoryResult>;
  revert(id: string, messageId: string, requestId: string): Promise<ReversibleHistoryResult>;
  restore(id: string, messageId: string, requestId: string): Promise<ReversibleHistoryResult>;
  respondPermission(id: string, interactionId: string, requestId: string, outcome: PermissionOutcome, choiceId?: string): Promise<{ outcome: PermissionOutcome }>;
  respondQuestion(id: string, interactionId: string, requestId: string, outcome: QuestionOutcome): Promise<{ outcome: QuestionOutcome }>;
  stopTask(id: string, taskId: string, requestId: string): Promise<{ stopped: true }>;
  backgroundBlockingWork?(id: string, requestId: string): Promise<{ accepted: true }>;
  generate?(id: string, requestId: string, question: string): Promise<{ text: string }>;
  release(id: string, requestId: string): Promise<{ released: true }>;
  cancelWakeup(id: string, wakeupId: string, requestId: string): Promise<{ cancelled: true }>;
  taskOutput(id: string, taskId: string, options: { tailBytes: number }): Promise<BackgroundTaskOutput | null>;
  usage(agentId: string): Promise<AgentUsageReport | null>;
  readUsage(agentId: string, requestId: string, mode: UsageReadMode): Promise<UsageReadResult>;
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
  readonly notificationFeed = new NotificationFeed();
  private readonly notificationUnsubscribes: Array<() => void> = [];
  private readonly agentsById = new Map<string, RegisteredChatAgent>();
  private readonly order: RegisteredChatAgent[];
  private readonly attachmentStore: AttachmentStore;
  private readonly visualStore: VisualStore;
  // Entries exist only while a conversation has active event subscriptions.
  // History contributes pending assistant rows, never a second event stream.
  private readonly visualHistorySubscribers = new Map<string, Set<VisualHistorySubscriber>>();
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
    for (const agent of this.order) {
      const feed = agent.service.notificationFeed;
      if (!feed) continue;
      const publish = (event: import("./notifications").AgentNotificationEvent) => this.notificationFeed.publish(qualifyNotificationEvent(agent.descriptor.id, event));
      for (const notification of feed.snapshot()) publish({ type: "notification", notification });
      this.notificationUnsubscribes.push(feed.listen(publish));
    }
    // The store is workspace state shared across agents — same backing
    // directory the per-agent stacks resolve, one authority for routes.
    this.attachmentStore = options.attachmentStore ?? createAttachmentStore({ workspacePath: options.workspacePath });
    this.visualStore = options.visualStore ?? new VisualStore(options.workspacePath);
    this.inventoryContributionTimeoutMs = options.inventoryContributionTimeoutMs ?? 4_000;
  }

  private readonly inventoryContributionTimeoutMs: number;
  private readonly activitySubscriptions = new Set<MergedActivitySubscription>();

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

  /**
   * A login change made through the Hub's Agent accounts. The agent re-reads
   * and replays it, then every client is ticked: a client re-reads status on
   * an inventory tick, sees the agent's `accountsRevision` move, and re-reads
   * that agent's catalogs.
   */
  async accountsChanged(agentId: string, change: ChatAccountChange): Promise<void> {
    const agent = this.requireAgent(agentId);
    await agent.service.accountsChanged?.(change);
    this.inventoryHub.tick();
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

  /**
   * Working or awaiting in any agent. An agent that cannot answer counts as
   * idle rather than failing the summary: one agent's outage must not blank
   * another's working or awaiting state.
   */
  async activity(): Promise<ChatActivity> {
    const summaries = await Promise.all(this.order.map(agent =>
      Promise.resolve()
        .then(() => agent.service.activity())
        .catch((): ChatActivity => ({ working: false, awaiting: false, unresolved: false }))));
    return {
      working: summaries.some(summary => summary.working === true),
      awaiting: summaries.some(summary => summary.awaiting === true),
      unresolved: summaries.some(summary => summary.unresolved === true),
    };
  }

  /**
   * One change bit over every agent's activity. The merged subscription opens
   * with its own tick, so the first read reports the current summary; each
   * agent's ticks attach as that agent's subscription arrives, so a slow or
   * failing agent neither delays nor breaks the others.
   */
  async subscribeActivity(options: { signal?: AbortSignal } = {}): Promise<ConversationInventorySubscription> {
    const merged = new MergedActivitySubscription(options.signal, () => this.activitySubscriptions.delete(merged));
    if (merged.closed) return merged;
    this.activitySubscriptions.add(merged);
    for (const agent of this.order) {
      void Promise.resolve()
        .then(() => agent.service.subscribeActivity({ signal: merged.signal }))
        .then(source => merged.attach(source), () => undefined);
    }
    return merged;
  }

  async createConversation(agentId?: string): Promise<AgentConversationSnapshot> {
    const agent = this.requireAgent(agentId ?? this.defaultAgentId());
    return this.qualifySnapshot(agent.descriptor, await agent.service.createConversation());
  }

  async history(id: string, options?: { cursor?: string; limit?: number }): Promise<AgentConversationSnapshot> {
    const { agent, conversationId } = this.resolve(id);
    const page = agent.service.history(conversationId, options).then(snapshot =>
      this.enrichSnapshot(this.qualifySnapshot(agent.descriptor, snapshot), !options?.cursor));
    for (const subscriber of this.visualHistorySubscribers.get(id) ?? []) subscriber.read(page);
    return page;
  }

  async workerEvidence(id: string): Promise<import("./worker-dismissal-evidence").WorkerEvidenceSnapshot> {
    const { agent, conversationId } = this.resolve(id);
    if (!agent.service.workerEvidence) throw new Error("authoritative worker evidence unavailable");
    const snapshot = await agent.service.workerEvidence(conversationId);
    if (snapshot.conversationId !== conversationId) throw new Error("authoritative conversation identity mismatch");
    return { ...snapshot, conversationId: id };
  }

  async subscribe(id: string, options?: { cursor?: string; signal?: AbortSignal; reconnect?: boolean }): Promise<{
    snapshot: AgentConversationSnapshot;
    events: ChatEventSubscription;
  }> {
    const { agent, conversationId } = this.resolve(id);
    const { snapshot, events } = await agent.service.subscribe(conversationId, options);
    let qualified: AgentConversationSnapshot;
    try {
      qualified = await this.enrichSnapshot(this.qualifySnapshot(agent.descriptor, snapshot));
    } catch (error) {
      events.cancel();
      throw error;
    }
    let boundary = decodeReplayCursor(snapshot.cursor);
    const requestedCursor = options?.cursor ? decodeReplayCursor(options.cursor) : null;
    const hasVisualMetadata = qualified.items.some(item => item.type === "assistant_message" && item.visuals?.length);
    let replayNeedsVisualResync = Boolean(boundary && requestedCursor
      && boundary.generation === requestedCursor.generation && requestedCursor.sequence < boundary.sequence
      && hasVisualMetadata);
    // A terminal status and its visual resync deliberately share a native
    // sequence. Losing the latter leaves an equal cursor but stale visuals.
    // Only transport recovery needs this initial invalidation: a fresh stream
    // opened from enriched history at the same cursor must not resync-loop.
    const initialVisualResync: ChatEvent | undefined = options?.reconnect && boundary && requestedCursor
      && boundary.generation === requestedCursor.generation && requestedCursor.sequence === boundary.sequence && hasVisualMetadata
      ? { generation: boundary.generation, sequence: boundary.sequence, conversationId: qualified.conversation.id, type: "resync", reason: "conversation-rewritten" }
      : undefined;
    type Assistant = Extract<ConversationItem, { type: "assistant_message" }>;
    type Tracked = { item: Assistant; live: boolean; enrichedAt: number; historyBoundary?: ReturnType<typeof decodeReplayCursor> };
    // No tool output or other timeline rows belong in the visual accumulator.
    const items = new Map<string, Tracked>();
    const pendingPages = new Set<Promise<void>>();
    let cancelPendingPages!: () => void;
    const cancelledPages = new Promise<void>(resolve => { cancelPendingPages = resolve; });
    let closed = false;
    let historyEpoch = 0;
    let streaming = isLiveConversationStatus(snapshot.conversation.status);
    const seed = (current: AgentConversationSnapshot) => {
      items.clear();
      streaming = isLiveConversationStatus(current.conversation.status);
      const lastTurn = current.items.findLastIndex(item => item.type === "turn_status");
      for (const [index, item] of current.items.entries()) {
        if (item.type === "assistant_message") {
          const turn = (item as typeof item & ClaudeTextIdentity)[CLAUDE_TURN];
          items.set(item.id, { item, live: streaming && (turn ? !turn.completed : index > lastTurn), enrichedAt: -Infinity });
        }
      }
    };
    seed(qualified);
    const coveredByHistory = (tracked: Tracked, event: ChatEvent) => Boolean(tracked.historyBoundary
      && tracked.historyBoundary.generation === event.generation && event.sequence <= tracked.historyBoundary.sequence);
    // Bound the actual Markdown parse and store work, not just highlighting.
    // Deltas remain lossless and ordered; turn/message completion always flushes.
    const enrichmentCadenceMs = 100;
    const completesVisualSyntax = (previous: Assistant, delta: string) => {
      // Inspect only a bounded suffix plus the new content. A delimiter must
      // actually finish in the new content, not merely remain in the suffix.
      // In particular, ordinary code newlines and parentheses do not flush.
      const suffix = previous.markdown.slice(-512);
      const added = suffix + delta;
      const completes = (pattern: RegExp) => {
        for (const match of added.matchAll(pattern)) {
          if (match.index! + match[0].length > suffix.length) return true;
        }
        return false;
      };
      const closesImageCandidate = () => {
        if (!added.includes("![")) return false;
        // This is a bounded candidate trigger, not another Markdown parser.
        // Balance delimiters and skip escapes/quoted or angle destinations so
        // an inner ']' or ')' cannot hide the eventual outer close. Validity,
        // code contexts and reference resolution still belong to the parser.
        let state: "label" | "after-label" | "reference" | "destination" | undefined;
        let depth = 0;
        let angle = false;
        let quote = "";
        for (let index = 0; index < added.length; index++) {
          const char = added[index]!;
          if (char === "\\") { index++; continue; }
          if (state === undefined) {
            if (char === "!" && added[index + 1] === "[") { state = "label"; depth = 1; index++; }
          } else if (state === "label" || state === "reference") {
            if (char === "[") depth++;
            if (char === "]" && --depth === 0) {
              if (index >= suffix.length) return true; // Includes shorthand.
              state = state === "label" ? "after-label" : undefined;
            }
          } else if (state === "after-label") {
            if (char === "(" || char === "[") {
              state = char === "(" ? "destination" : "reference";
              depth = 1;
              angle = false;
              quote = "";
            } else { state = undefined; index--; }
          } else {
            if (angle) { if (char === ">") angle = false; continue; }
            if (quote) { if (char === quote) quote = ""; continue; }
            if (char === "<") { angle = true; continue; }
            if ((char === '"' || char === "'") && /\s/.test(added[index - 1] ?? "")) { quote = char; continue; }
            if (char === "(") depth++;
            if (char === ")" && --depth === 0) {
              if (index >= suffix.length) return true;
              state = undefined;
            }
          }
        }
        return false;
      };
      return completes(/(?:`{3,}|~{3,})[ \t]*svg\b/gi)
        || (Boolean(previous.visuals?.some(visual => visual.status === "pending")) && completes(/`{3}|~{3}/g))
        || closesImageCandidate()
        || completes(/(?:^|\n)[ \t]{0,3}\[[^\]\n]+\]:[^\n]*\r?\n/g)
        || completes(/<(?:img|image)\b[^>]*>/gi);
    };
    const enrich = async (tracked: Tracked, force = false) => {
      if (!force && Date.now() - tracked.enrichedAt < enrichmentCadenceMs) return false;
      const previous = tracked.item;
      tracked.item = await this.enrichItem(id, previous, tracked.live, true) as Assistant;
      tracked.enrichedAt = tracked.item.markdown.length ? Date.now() : -Infinity;
      return JSON.stringify(previous.visuals) !== JSON.stringify(tracked.item.visuals);
    };
    const finish = async (event: ChatEvent) => {
      // A page read can be enriching a missing file when the native end is
      // queued. Enroll that read before deciding which pending slots to flush.
      while (!closed && pendingPages.size) await Promise.race([Promise.all([...pendingPages]), cancelledPages]);
      if (closed) return false;
      let changed = false;
      for (const [itemId, tracked] of items) {
        if (!tracked.live || coveredByHistory(tracked, event)) continue;
        tracked.live = false;
        changed = await enrich(tracked, true) || changed;
        if (tracked.historyBoundary !== undefined) items.delete(itemId);
      }
      return changed;
    };
    const wrapped = new QualifyingEventSubscription(events, async raw => {
        const event = this.qualifyEvent(agent.descriptor, raw);
        if (event.type === "resync") {
          // Rewrites can replace text without an upsert. Never append a future
          // delta to the pre-rewrite accumulator. A covered history read may
          // include already-queued events, so advance its replay fence too.
          items.clear();
          historyEpoch++;
          replayNeedsVisualResync = false;
          try {
            const current = await this.enrichSnapshot(this.qualifySnapshot(agent.descriptor, await agent.service.history(conversationId)));
            seed(current);
            boundary = decodeReplayCursor(current.cursor);
          } catch {
            // The client must still receive its recovery signal if the read
            // fails. Remain empty until authoritative upserts reseed rows.
          }
          return [event];
        }
        // The handoff snapshot is current, while a reconnect may replay older
        // events. Never apply history again to snapshot-seeded state. The HTTP
        // reconnect handshake sends only a cursor, so finish visual-bearing
        // replay with a resync at its existing boundary event: the client must
        // fetch the enriched snapshot even when no later live event arrives.
        if (boundary && event.generation === boundary.generation && event.sequence <= boundary.sequence) {
          if (replayNeedsVisualResync && event.sequence === boundary.sequence) {
            replayNeedsVisualResync = false;
            return [event, { generation: event.generation, sequence: event.sequence, conversationId: event.conversationId, type: "resync", reason: "conversation-rewritten" }];
          }
          return [event];
        }
        const itemId = event.type === "item.upsert" ? event.item.id
          : event.type === "item.text_delta" || event.type === "item.remove" ? event.itemId : undefined;
        const tracked = itemId === undefined ? undefined : items.get(itemId);
        // Paging can cover native events still queued behind the handoff.
        // Use one full-text event at that native sequence: older-page merges
        // do not advance the browser's replay cursor, so forwarding a covered
        // delta would append it twice even if our accumulator stayed correct.
        if (tracked && coveredByHistory(tracked, event)) {
          if (event.type === "item.text_delta" || event.type === "item.upsert" && event.item.type === "assistant_message") {
            return [{ generation: event.generation, sequence: event.sequence, conversationId: event.conversationId, type: "item.upsert", item: tracked.item }];
          }
          return [event];
        }
        const base = { generation: event.generation, sequence: event.sequence, conversationId: event.conversationId };
        const resync: ChatEvent = { ...base, type: "resync", reason: "conversation-rewritten" };
        if (event.type === "item.remove") items.delete(event.itemId);
        if (event.type === "conversation.status" || event.type === "conversation.updated") {
          streaming = isLiveConversationStatus(event.type === "conversation.status" ? event.status : event.conversation.status);
          // Status errors, /reload refreshes and label changes are authoritative
          // events, not replaceable invalidations. Visual resync is additional.
          if (!streaming && await finish(event)) return [event, resync];
        }
        if (event.type === "item.upsert") {
          if (event.item.type === "turn_status") {
            if (await finish(event)) return [event, resync];
          } else if (event.item.type === "assistant_message") {
            const previous = items.get(event.item.id);
            const tracked: Tracked = {
              item: { ...event.item, ...(previous?.item.visuals ? { visuals: previous.item.visuals } : {}) },
              live: previous?.live === false ? false : streaming,
              enrichedAt: previous?.enrichedAt ?? -Infinity,
              historyBoundary: previous?.historyBoundary,
            };
            items.set(event.item.id, tracked);
            const appended = previous && event.item.markdown.startsWith(previous.item.markdown)
              ? event.item.markdown.slice(previous.item.markdown.length) : undefined;
            const syntaxCompleted = previous && (appended === undefined || completesVisualSyntax(previous.item, appended));
            await enrich(tracked, !this.visualItemLive(event.item, tracked.live, true) || Boolean(syntaxCompleted));
            // Normal events are sequence-deduplicated by the client. Enrich
            // this one native upsert, retaining all its text and other fields.
            return [{ ...event, item: tracked.item }];
          } else items.delete(event.item.id);
        }
        if (event.type === "item.text_delta") {
          const tracked = items.get(event.itemId);
          if (tracked) {
            const syntaxCompleted = completesVisualSyntax(tracked.item, event.delta);
            tracked.item = { ...tracked.item, markdown: tracked.item.markdown + event.delta };
            // A replacement upsert carries exactly the accumulated delta text
            // at the native sequence; a second same-sequence item is ignored.
            if (await enrich(tracked, syntaxCompleted)) return [{ ...base, type: "item.upsert", item: tracked.item }];
          }
        }
        return [event];
      }, () => {
        closed = true;
        cancelPendingPages();
        historyEpoch++;
        items.clear();
        pendingPages.clear();
        options?.signal?.removeEventListener("abort", onAbort);
        subscribers.delete(historySubscriber);
        if (!subscribers.size) this.visualHistorySubscribers.delete(id);
      }, initialVisualResync);
    const subscribers = this.visualHistorySubscribers.get(id) ?? new Set<VisualHistorySubscriber>();
    const historySubscriber: VisualHistorySubscriber = {
      read: page => {
        const epoch = historyEpoch;
        const pending: Promise<void> = page.then(current => {
          if (closed || epoch !== historyEpoch || !isLiveConversationStatus(current.conversation.status)) return;
          const cursor = decodeReplayCursor(current.cursor);
          if (boundary && cursor && cursor.generation !== boundary.generation) return;
          for (const item of current.items) {
            // Completed old turns were enriched terminally and cannot enroll.
            // Do not overwrite an existing live accumulator with paged text.
            if (item.type !== "assistant_message" || items.has(item.id) || !item.visuals?.some(visual => visual.status === "pending")) continue;
            items.set(item.id, { item, live: true, enrichedAt: Date.now(), historyBoundary: cursor });
          }
        }, () => undefined).finally(() => pendingPages.delete(pending));
        pendingPages.add(pending);
      },
      cancel: () => wrapped.cancel(),
    };
    subscribers.add(historySubscriber);
    this.visualHistorySubscribers.set(id, subscribers);
    const onAbort = () => wrapped.cancel();
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    if (options?.signal?.aborted) wrapped.cancel();
    return { snapshot: qualified, events: wrapped };
  }

  async prompt(id: string, requestId: string, text: string, model?: ModelSelection, mode?: string, variant?: string, attachments?: MessageAttachment[], delivery?: MessageDelivery, context?: ChatActionContext, operationReceipt?: string) {
    const { agent, conversationId } = this.resolve(id);
    const { conversation, ...accepted } = await agent.service.prompt(conversationId, requestId, text, model, mode, variant, attachments, delivery, context, operationReceipt);
    return {
      ...accepted,
      ...(conversation ? { conversation: this.qualifySummary(agent.descriptor, conversation) } : {}),
    };
  }

  async removeQueued(id: string, messageId: string, requestId: string) {
    const { agent, conversationId } = this.resolve(id);
    return agent.service.removeQueued(conversationId, messageId, requestId);
  }

  async discardUnconfirmedSteer(id: string, messageId: string, requestId: string, uncertaintyId: string) {
    const { agent, conversationId } = this.resolve(id);
    return agent.service.discardUnconfirmedSteer(conversationId, messageId, requestId, uncertaintyId);
  }

  async changeDelivery(id: string, messageId: string, requestId: string, delivery: MessageDelivery, context?: ChatActionContext, operationReceipt?: string) {
    const { agent, conversationId } = this.resolve(id);
    return agent.service.changeDelivery(conversationId, messageId, requestId, delivery, context, operationReceipt);
  }

  async sendNow(id: string, messageId: string, requestId: string, context?: ChatActionContext, operationReceipt?: string) {
    const { agent, conversationId } = this.resolve(id);
    return agent.service.sendNow(conversationId, messageId, requestId, context, operationReceipt);
  }

  async saveAttachment(bytes: Uint8Array): Promise<{ id: string; mimeType: string; sizeBytes: number }> {
    const stored = await this.attachmentStore.save(bytes);
    return { id: stored.id, mimeType: stored.mimeType, sizeBytes: stored.sizeBytes };
  }

  async resolveAttachment(id: string): Promise<StoredAttachment | null> {
    return this.attachmentStore.resolve(id);
  }

  configureVisualReader(reader: VisualFileReader): void { this.visualStore.setReader(reader); }
  resolveVisual(id: string): Promise<StoredVisual | null> { return this.visualStore.resolve(id); }

  private async enrichItem(conversationId: string, item: ConversationItem, streaming: boolean, orderedTurnState = false): Promise<ConversationItem> {
    if (item.type !== "assistant_message") return item;
    const live = this.visualItemLive(item, streaming, orderedTurnState);
    // Deliberately overinclusive: any image opener or Markdown fence may
    // produce a visual, including reference syntax, raw HTML, nested/indented
    // fences and whitespace before the SVG info string. Plain prose needs no
    // Markdown parse/highlight on every streamed token.
    const inputs = /!\[|<(?:img|image|pre)\b|`{3}|~{3}/i.test(item.markdown) ? getChatVisuals(item.markdown, live) : [];
    if (!inputs.length) {
      const { visuals: _visuals, ...rest } = item;
      return rest;
    }
    const requests = function* () {
      for (const input of inputs) {
        const identity = claudeVisualIdentity(item, input.key);
        yield { messageId: identity.messageId, input: { ...input, key: identity.key } };
      }
    };
    const visuals = await this.visualStore.captureMany(conversationId, visualAdmissionIdentity(item), requests(), live)
      .catch(() => inputs.slice(0, VISUAL_MAX_COUNT).map(input => ({ index: input.index, status: "unavailable" as const, message: "Image snapshot could not be stored" })));
    return { ...item, visuals };
  }

  private visualItemLive(item: Extract<ConversationItem, { type: "assistant_message" }>, streaming: boolean, orderedTurnState = false): boolean {
    // Claude's completedAt closes a text block/API response, not the agent
    // turn: a subsequent tool can still create the referenced file. OpenCode's
    // native parent-message completedAt, in contrast, really seals its parts.
    const identity = item as typeof item & ClaudeTextIdentity;
    // Queued Claude frames share a token the provider may already have sealed.
    // Live projection must instead wait for its ordered status/turn boundary;
    // history/snapshot reads still use the authoritative native token.
    if (identity[CLAUDE_TURN]) return streaming && (orderedTurnState || !identity[CLAUDE_TURN].completed);
    const claudeBlock = Boolean(identity[CLAUDE_TEXT_BLOCKS]?.length || identity[CHAT_VISUAL_MESSAGE]?.startsWith("claude:message:"));
    return streaming && (claudeBlock || item.completedAt === undefined);
  }

  private async enrichSnapshot(snapshot: AgentConversationSnapshot, newestPage = true): Promise<AgentConversationSnapshot> {
    // Native Claude turn metadata is computed before pagination: an older
    // page can still belong to the same running turn. Without authoritative
    // metadata, keep older pages terminal rather than inferring from a user
    // row or a page-local footer.
    const lastTurn = snapshot.items.findLastIndex(item => item.type === "turn_status");
    const items: ConversationItem[] = [];
    for (const [index, item] of snapshot.items.entries()) {
      const turn = item.type === "assistant_message" ? (item as typeof item & ClaudeTextIdentity)[CLAUDE_TURN] : undefined;
      const live = isLiveConversationStatus(snapshot.conversation.status) && (turn ? !turn.completed : newestPage && index > lastTurn);
      items.push(await this.enrichItem(snapshot.conversation.id, item, live));
    }
    return { ...snapshot, items };
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

  async backgroundBlockingWork(id: string, requestId: string) {
    const { agent, conversationId } = this.resolve(id);
    if (!agent.service.backgroundBlockingWork) throw new BackgroundTasksUnsupportedError();
    return agent.service.backgroundBlockingWork(conversationId, requestId);
  }
  async generate(id: string, requestId: string, question: string) {
    const { agent, conversationId } = this.resolve(id);
    if (!agent.service.generate) throw new SideGenerationUnsupportedError();
    return agent.service.generate(conversationId, requestId, question);
  }

  async release(id: string, requestId: string) {
    const { agent, conversationId } = this.resolve(id);
    return agent.service.release(conversationId, requestId);
  }

  async cancelWakeup(id: string, wakeupId: string, requestId: string) {
    const { agent, conversationId } = this.resolve(id);
    return agent.service.cancelWakeup(conversationId, wakeupId, requestId);
  }

  async taskOutput(id: string, taskId: string, options: { tailBytes: number }) {
    const { agent, conversationId } = this.resolve(id);
    return agent.service.taskOutput(conversationId, taskId, options);
  }

  async usage(agentId: string): Promise<AgentUsageReport | null> { return this.requireAgent(agentId).service.usage(); }
  async readUsage(agentId: string, requestId: string, mode: UsageReadMode): Promise<UsageReadResult> { return this.requireAgent(agentId).service.readUsage(requestId, mode); }

  async dispose(): Promise<void> {
    for (const unsubscribe of this.notificationUnsubscribes) unsubscribe();
    this.notificationFeed.dispose();
    this.inventoryHub.dispose();
    for (const subscription of [...this.activitySubscriptions]) subscription.cancel();
    for (const subscribers of [...this.visualHistorySubscribers.values()]) {
      for (const subscriber of [...subscribers]) subscriber.cancel();
    }
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
    if ((next.type === "tool" || next.type === "background_task") && next.childConversationId) {
      // A subagent child belongs to the same agent as its parent; the
      // drill-down opens it through the same qualified addressing. A
      // background task names the same child as its launching tool row —
      // and names it first, from the start edge, which is what makes a
      // still-running run openable — so it must be qualified alike.
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
  private cancelled = false;
  private closed = false;
  constructor(
    private readonly source: ChatEventSubscription,
    private readonly map: (event: ChatEvent) => ChatEvent[] | Promise<ChatEvent[]>,
    private readonly onClose: () => void = () => {},
    private initial?: ChatEvent,
  ) {}

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.close();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
    this.source.cancel();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ChatEvent> {
    // Natural source closure drains every queued native and mapped event.
    // Consumer return()/throw(), unlike exhaustion, cancels queued delivery.
    let exhausted = false;
    try {
      const initial = this.initial;
      this.initial = undefined;
      if (initial && !this.cancelled) yield initial;
      for await (const event of this.source) {
        if (this.cancelled) return;
        for (const mapped of await this.map(event)) {
          if (this.cancelled) return;
          yield mapped;
        }
      }
      exhausted = true;
    } finally {
      if (exhausted) this.close();
      else this.cancel();
    }
  }
}

/**
 * Every agent's activity ticks poured into one one-bit broadcaster, whose
 * coalescing collapses a burst across agents into one re-read. Cancelling it
 * — directly, through return(), or through the caller's signal — cancels
 * every agent subscription it holds.
 */
class MergedActivitySubscription implements ConversationInventorySubscription {
  private readonly broadcaster = new ConversationInventoryBroadcaster();
  private readonly merged: ConversationInventorySubscription;
  private readonly stop = new AbortController();
  private readonly sources = new Set<ConversationInventorySubscription>();
  private readonly onAbort = () => this.cancel();

  constructor(private readonly signal_: AbortSignal | undefined, private readonly onClose: () => void) {
    this.merged = this.broadcaster.subscribe(signal_);
    if (signal_?.aborted) this.cancel();
    else signal_?.addEventListener("abort", this.onAbort, { once: true });
  }

  /** Aborts when this subscription ends; agent subscriptions ride it. */
  get signal(): AbortSignal { return this.stop.signal; }
  get closed(): boolean { return this.stop.signal.aborted; }

  attach(source: ConversationInventorySubscription): void {
    if (this.closed) {
      source.cancel();
      return;
    }
    this.sources.add(source);
    void (async () => {
      try {
        while (!(await source.next()).done) this.broadcaster.invalidate();
      } catch {
        // A dead source stops ticking; the other agents carry on.
      } finally {
        this.sources.delete(source);
      }
    })();
  }

  next(): Promise<IteratorResult<void>> {
    return this.merged.next();
  }

  async return(): Promise<IteratorResult<void>> {
    this.cancel();
    return { value: undefined, done: true };
  }

  cancel(): void {
    if (this.closed) return;
    this.stop.abort();
    this.signal_?.removeEventListener("abort", this.onAbort);
    for (const source of this.sources) source.cancel();
    this.sources.clear();
    this.broadcaster.dispose();
    this.onClose();
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<void> {
    return this;
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
