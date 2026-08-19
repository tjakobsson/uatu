import { randomBytes, randomUUID } from "node:crypto";

import { ProviderUpdateCoalescer } from "./coalescer";
import { createProviderEventMemory, normalizeProviderEvent, normalizeProviderMessage, storedMessageUsage, type NormalizedProviderUpdate } from "./normalization";
import type { OpenCodeProvider, ProviderPermissionReply, ProviderSession } from "./provider";
import { IdempotencyReceipts } from "./receipts";
import { ConversationReplay, type ReplaySubscription } from "./replay";
import { ProviderTextReconciler } from "./text-reconciler";
import type {
  ChatAgent,
  ChatMode,
  ChatEvent,
  ChatCommand,
  ChatModel,
  ConversationItem,
  ConversationSnapshot,
  ConversationStatus,
  ConversationSummary,
  PermissionOutcome,
  PermissionRequest,
  ModelSelection,
  QuestionOutcome,
  QuestionRequest,
  TokenUsage,
} from "./types";
import { ConversationNotFoundError, isSessionInWorkspace } from "./workspace";

const DEFAULT_PAGE_SIZE = 50;

export class InteractionConflictError extends Error {
  constructor(message = "interaction request is stale or already resolved") {
    super(message);
    this.name = "InteractionConflictError";
  }
}

export class InvalidModelSelectionError extends Error {
  constructor() {
    super("selected model is not available");
    this.name = "InvalidModelSelectionError";
  }
}

export class InvalidModeSelectionError extends Error {
  constructor() {
    super("selected mode is not available");
    this.name = "InvalidModeSelectionError";
  }
}

export class InvalidVariantSelectionError extends Error {
  constructor() {
    super("selected variant is not available");
    this.name = "InvalidVariantSelectionError";
  }
}

// Just the slice of MetricsRegistry the adapter needs, so chat does not depend
// on the debug module's shape.
export type ChatEventMetrics = { inc(name: string, delta?: number): void };

// Event type strings come from a local trusted process, but the counter key
// space must still be bounded — a future OpenCode emitting per-request type
// names must not grow the registry without limit.
const MAX_COUNTED_EVENT_TYPES = 64;

export type ChatAdapterOptions = {
  provider: OpenCodeProvider;
  workspacePath: string;
  generation?: string;
  replayBytes?: number;
  receiptEntries?: number;
  receiptBytes?: number;
  receiptTtlMs?: number;
  maxProjections?: number;
  coalesceWindowMs?: number;
  // Optional diagnostic sink. When present the pump counts events it could not
  // use, so an operator can discover what a live workspace is discarding.
  metrics?: ChatEventMetrics;
  now?: () => number;
  id?: () => string;
};

export class OpenCodeChatAdapter {
  readonly generation: string;
  private readonly provider: OpenCodeProvider;
  private readonly workspacePath: string;
  private readonly replayBytes: number;
  private readonly id: () => string;
  private readonly projections = new Map<string, ConversationProjection>();
  private readonly receipts: IdempotencyReceipts;
  // Question item ids currently published per conversation, so a question that
  // stops being pending can be withdrawn from the timeline.
  private readonly publishedQuestions = new Map<string, Set<string>>();
  private readonly questionRefreshes = new Set<string>();
  private readonly questionCreatedAt = new Map<string, number>();
  private readonly permissionCreatedAt = new Map<string, number>();
  private readonly sessionParents = new Map<string, string | null>();
  // Conversations with a turn in flight, tracked at the adapter so the fact
  // survives projection eviction. This is what distinguishes "the store says
  // running because OpenCode died mid-turn" from "running right now".
  private readonly liveTurns = new Set<string>();
  private readonly maxProjections: number;
  private readonly coalesceWindowMs: number | undefined;
  private readonly metrics: ChatEventMetrics | undefined;
  private readonly countedEventTypes = new Set<string>();
  private readonly lastModel = new Map<string, ModelSelection>();
  private readonly lastMode = new Map<string, string>();
  // A subagent's own cost, kept per message within the child session. Per
  // message because `message.updated` restates a message's growing tokens
  // rather than adding to them — summing every event would multiply the same
  // turn.
  //
  // Keyed by parent AND child (`attributionKey`), not by child alone: the
  // tally exists to decorate a row in the parent's timeline, so it should live
  // exactly as long as that timeline does. Keyed by the child, eviction would
  // never fire — the LRU evicts conversations, and a child session usually has
  // no projection of its own. A ceiling backstops both maps besides.
  private readonly childUsage = new Map<string, Map<string, TokenUsage>>();
  private readonly childModel = new Map<string, string>();
  private readonly providerEventMemory = createProviderEventMemory();
  private pumpController: AbortController | null = null;
  private pumpPromise: Promise<void> | null = null;

  constructor(options: ChatAdapterOptions) {
    this.provider = options.provider;
    this.workspacePath = options.workspacePath;
    this.generation = options.generation ?? randomBytes(16).toString("base64url");
    this.replayBytes = options.replayBytes ?? 256 * 1024;
    this.maxProjections = options.maxProjections ?? 64;
    this.coalesceWindowMs = options.coalesceWindowMs;
    this.metrics = options.metrics;
    this.id = options.id ?? randomUUID;
    this.receipts = new IdempotencyReceipts({
      maxEntries: options.receiptEntries ?? 1_000,
      maxBytes: options.receiptBytes ?? 512 * 1024,
      ttlMs: options.receiptTtlMs ?? 15 * 60_000,
      now: options.now,
    });
  }

  async listConversations(): Promise<ConversationSummary[]> {
    const sessions = await this.provider.listSessions();
    const accepted: ConversationSummary[] = [];
    for (let session of sessions) {
      if (!await isSessionInWorkspace(session.directory, this.workspacePath)) continue;
      // Subagent children stay out of the picker: they are reached from the
      // parent's subagent rows, and listing them as peers buries the real
      // conversations under machine-titled entries.
      if (session.parentId) continue;
      if (this.provider.renameSession && isDefaultConversationTitle(session.title)) {
        try {
          const page = await this.provider.listMessages(session.id, { limit: 100 });
          const firstUserMessage = page.items
            .flatMap(normalizeProviderMessage)
            .filter(item => item.type === "user_message" && item.text.trim())
            .sort((left, right) => left.createdAt - right.createdAt)[0];
          if (firstUserMessage?.type === "user_message") {
            session = await this.provider.renameSession(session.id, deriveConversationTitle(firstUserMessage.text));
          }
        } catch {
          // A title repair must not make an otherwise usable conversation disappear.
        }
      }
      accepted.push(this.summary(session));
    }
    return accepted.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  }

  models(): Promise<ChatModel[]> {
    return this.provider.listModels();
  }

  agent(): ChatAgent {
    return this.provider.describe();
  }

  async modes(): Promise<ChatMode[]> {
    return this.provider.listModes ? this.provider.listModes() : [];
  }

  commands(): Promise<ChatCommand[]> {
    return this.provider.listCommands();
  }

  async createConversation(): Promise<ConversationSnapshot> {
    const session = await this.provider.createSession(this.id());
    await this.requireSession(session.id);
    const projection = this.projection(session.id);
    return {
      conversation: this.summary(session),
      generation: this.generation,
      cursor: projection.replay.latestCursor(),
      items: [],
    };
  }

  async getConversation(id: string): Promise<ConversationSummary> {
    return this.summary(await this.requireSession(id));
  }

  async history(id: string, options: { cursor?: string; limit?: number } = {}): Promise<ConversationSnapshot> {
    const session = await this.requireSession(id);
    // Captured before the provider reads: a pump event landing during them
    // advances the replay log, and a cursor taken afterwards would tell the
    // client's SSE handshake the event was already delivered when the items
    // below may not contain it. Replaying from this earlier boundary instead
    // re-applies such events idempotently.
    const replayCursor = this.projection(id).replay.latestCursor();
    const cursor = options.cursor ? decodeHistoryCursor(options.cursor) : undefined;
    const page = await this.provider.listMessages(id, { cursor: cursor?.provider, limit: options.limit ?? DEFAULT_PAGE_SIZE });
    const items = page.items.flatMap(normalizeProviderMessage);
    // Stable sort with no id tiebreaker: parts of one message share the
    // message's timestamp, so ties must fall back to the provider's own part
    // order (the order `flatMap` already produced). Comparing ids instead
    // reorders a turn alphabetically on replay.
    items.sort((left, right) => left.createdAt - right.createdAt);
    // The store is not the truth about liveness: a tool part stays "running"
    // forever when OpenCode dies before writing a terminal state (quitting the
    // hub mid-turn), and on reload that renders agents as still working. A
    // turn cannot outlive the server, so when no turn is live here the stale
    // activity is closed out as cancelled. Liveness comes from the adapter's
    // own set rather than the projection's status, because a projection can
    // be LRU-evicted mid-turn and come back fresh while the turn still runs.
    if (!this.liveTurns.has(id)) {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]!;
        if ((item.type === "tool" || item.type === "command" || item.type === "reasoning") && (item.status === "running" || item.status === "pending")) {
          items[index] = { ...item, status: "cancelled" };
        }
      }
    }
    // A subagent's attribution reached the parent as a live upsert, and the
    // parent's own store has no memory of it — so a reopened conversation
    // would show costs that simply vanished. The child's stored messages do
    // still carry them, so a tally this adapter no longer holds is rebuilt
    // from there, once, and banked. Paid per parent-open for a subagent never
    // seen live rather than on every open (the aggregate is still computed
    // here, not fetched per render) — and in parallel, so a fan-out costs one
    // round trip rather than one each.
    const unattributed = [...new Set(items.flatMap(item =>
      item.type === "tool" && item.childConversationId && !this.childUsage.has(attributionKey(id, item.childConversationId))
        ? [item.childConversationId]
        : []))];
    await Promise.all(unattributed.map(childId => this.reconstructAttribution(id, childId)));
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      if (item.type !== "tool" || !item.childConversationId) continue;
      const key = attributionKey(id, item.childConversationId);
      const model = this.childModel.get(key);
      const usage = sumUsage(this.childUsage.get(key));
      if (model === undefined && usage === undefined) continue;
      items[index] = {
        ...item,
        ...(model === undefined ? {} : { model }),
        ...(usage === undefined ? {} : { usage }),
      };
    }
    // OpenCode 1.18 never emits `question.v2.asked`, so a pending question is
    // invisible to the event stream and only the provider knows about it.
    // Asking here is what makes an open question answerable at all. A failed
    // list degrades the snapshot (the next refresh republishes) but must not
    // rewrite the published set — that would erase live questions.
    let questionsReconciled = false;
    try {
      const pendingNow = await this.pendingQuestions(id);
      for (const pending of pendingNow) {
        if (items.some(item => item.id === pending.id)) continue;
        items.push(pending);
      }
      if (this.provider.listQuestions) {
        questionsReconciled = true;
        // A successful read is authoritative: it carries this conversation's
        // own questions and its children's, so one absent from it was
        // answered elsewhere while its only live signal was missed.
        const live = new Set(pendingNow.map(item => item.id));
        const projection = this.projection(id);
        for (const existing of projection.items()) {
          if (existing.type !== "question" || existing.status !== "pending" || live.has(existing.id)) continue;
          projection.apply({ kind: "remove", itemId: existing.id });
          this.questionCreatedAt.delete(existing.id);
        }
      }
      if (pendingNow.length > 0) {
        this.publishedQuestions.set(id, new Set(pendingNow.map(item => item.id)));
        // A recovered child question is ALSO recorded under its owning child:
        // the child's next question-tool update computes removals against
        // that set, and the pump mirrors them into this conversation. Keyed
        // only under the parent, an answer given elsewhere left the parent
        // offering a question OpenCode no longer had — 409 until reload.
        // The sweep is child-inclusive, so each subset is that child's full
        // current pending set and overwriting is safe.
        const byChild = new Map<string, Set<string>>();
        for (const item of pendingNow) {
          if (item.type !== "question") continue;
          const owner = item.conversationId ?? id;
          if (owner === id) continue;
          const set = byChild.get(owner) ?? new Set<string>();
          set.add(item.id);
          byChild.set(owner, set);
        }
        for (const [owner, ids] of byChild) this.publishedQuestions.set(owner, ids);
      } else this.publishedQuestions.delete(id);
    } catch { /* unknown, not empty */ }
    // A permission is otherwise knowable only from a live event: it has no
    // history representation, so one raised while the pump was restarting
    // would strand its turn with nothing on screen. Reconciling here — the
    // moment a user is actually looking at the conversation — makes it
    // answerable. Ids match the event path's, so a request that also arrives
    // live converges on one entry instead of rendering twice.
    try {
      const pendingNow = await this.pendingPermissions(id);
      for (const pending of pendingNow) {
        if (items.some(item => item.id === pending.id)) continue;
        items.push(pending);
      }
      // A successful read is authoritative the other way too: a known pending
      // permission absent from it was answered somewhere else while its reply
      // event was missed, and the card must be revoked — otherwise a
      // reconnecting client could answer a request OpenCode no longer has.
      // Skipped entirely when the provider cannot list at all: that is
      // unknown, not empty. Mirrored child copies survive correctly because
      // pendingPermissions includes the children's requests.
      if (this.provider.listPermissions) {
        const live = new Set(pendingNow.map(item => item.id));
        const projection = this.projection(id);
        for (const existing of projection.items()) {
          if (existing.type !== "permission" || existing.status !== "pending" || live.has(existing.id)) continue;
          projection.apply({ kind: "remove", itemId: existing.id });
          this.permissionCreatedAt.delete(existing.id);
        }
      }
    } catch {
      // Unknown, not empty. `seed` replaces the timeline from history, and
      // history carries no interaction requests at all — so without carrying
      // the live ones over, a failed list would erase a request the event
      // stream established and strand the turn waiting on it. But this
      // failure only vouches for what its own read governs: permissions,
      // plus questions only when the question read failed too. A question a
      // successful read just retired stays retired.
      for (const existing of this.projection(id).items()) {
        if ((existing.type !== "permission" && existing.type !== "question") || existing.status !== "pending") continue;
        const vouchedGone = existing.type === "question" && questionsReconciled;
        if (!vouchedGone && !items.some(item => item.id === existing.id)) items.push(existing);
      }
    }
    const projection = this.projection(id);
    projection.seed(items);
    return {
      conversation: this.summary(session, projection.status),
      generation: this.generation,
      cursor: replayCursor,
      items,
      olderCursor: page.nextCursor ? encodeHistoryCursor({ provider: page.nextCursor }) : undefined,
    };
  }

  async subscribe(id: string, options: { cursor?: string; signal?: AbortSignal } = {}): Promise<{
    snapshot: ConversationSnapshot;
    events: ReplaySubscription;
  }> {
    const session = await this.requireSession(id);
    const projection = this.projection(id);
    const handoff = projection.replay.handoff(cursor => ({
      conversation: this.summary(session, projection.status),
      generation: this.generation,
      cursor,
      items: projection.items(),
    }), options.cursor, options.signal);
    return { snapshot: handoff.snapshot, events: handoff.subscription };
  }

  startEventPump(): Promise<void> {
    if (this.pumpPromise) return this.pumpPromise;
    const controller = new AbortController();
    this.pumpController = controller;
    this.pumpPromise = this.pump(controller.signal).finally(() => {
      // Abort on every exit, not just stopEventPump: when one merged provider
      // stream dies the other survives on this signal, and the supervisor's
      // restart would stack a fresh pair of subscriptions on top of it.
      controller.abort();
      this.pumpController = null;
      this.pumpPromise = null;
    });
    return this.pumpPromise;
  }

  async stopEventPump(): Promise<void> {
    this.pumpController?.abort();
    await this.pumpPromise?.catch(error => {
      if (!isAbortError(error)) throw error;
    });
  }

  async prompt(conversationId: string, requestId: string, text: string, model?: ModelSelection, mode?: string, variant?: string): Promise<{
    messageId: string;
    delivery: "steer" | "queue";
    conversation?: ConversationSummary;
  }> {
    if (!text.trim()) throw new Error("prompt must not be empty");
    return this.receipts.run(`prompt:${conversationId}:${requestId}`, async () => {
      let session = await this.requireSession(conversationId);
      const projection = this.projection(conversationId);
      const delivery = projection.status === "running" ? "steer" : "queue";
      const messageId = this.id();
      const previousModel = model ? this.lastModel.get(conversationId) : undefined;
      if (model && (!previousModel || !sameSelection(previousModel, model))) {
        const models = await this.provider.listModels();
        if (!models.some(candidate => sameSelection(candidate.selection, model))) throw new InvalidModelSelectionError();
        this.lastModel.set(conversationId, model);
      }
      // Same freshness rule as the model: only a change pays the list round
      // trip, and an unknown name is refused rather than passed through for
      // OpenCode to interpret.
      if (mode && this.lastMode.get(conversationId) !== mode) {
        const modes = await this.modes();
        if (!modes.some(candidate => candidate.name === mode)) throw new InvalidModeSelectionError();
        this.lastMode.set(conversationId, mode);
      }
      // A variant is refused unless the selected model advertises it. Checked
      // against the model, since variants are per-model — an unknown one passed
      // through would silently do nothing on the wire.
      if (variant) {
        const models = await this.provider.listModels();
        const selected = model && models.find(candidate => sameSelection(candidate.selection, model));
        if (!selected?.variants?.includes(variant)) throw new InvalidVariantSelectionError();
      }
      // Emptiness is checked before dispatch (afterwards the store already
      // holds this prompt), but the rename itself waits for admission — a
      // rejected first prompt must not permanently title the conversation
      // from a message that was never accepted.
      let renameToFirstPrompt = false;
      if (this.provider.renameSession && isDefaultConversationTitle(session.title)) {
        const page = await this.provider.listMessages(conversationId, { limit: 1 });
        renameToFirstPrompt = page.items.length === 0;
      }
      let conversation: ConversationSummary | undefined;
      // A steer targets a turn that is already running — the projection keeps
      // saying so. Downgrading it to "sending" (and to "failed" on a rejected
      // steer) would hide cancellation for a turn that never stopped.
      const steering = projection.status === "running";
      if (!steering) projection.statusUpdate("sending");
      try {
        // A failed command listing propagates: classifying "/compact" as
        // plain prose because the list was momentarily unavailable would
        // send the text as a message and report it accepted.
        const slash = text.startsWith("/")
          ? parseSlashCommand(text, await this.provider.listCommands())
          : undefined;
        const accepted = slash
          ? await this.provider.command(conversationId, { id: messageId, name: slash.name, arguments: slash.arguments, model, mode, variant })
          : await this.provider.prompt(conversationId, { id: messageId, text, delivery, model, mode, variant });
        if (renameToFirstPrompt) {
          try {
            session = await this.provider.renameSession!(conversationId, deriveConversationTitle(text));
            if (!await isSessionInWorkspace(session.directory, this.workspacePath)) throw new ConversationNotFoundError();
            conversation = this.summary(session, projection.status);
          } catch { /* cosmetic — listConversations repairs default titles later */ }
        }
        projection.upsert({ id: `message:${accepted.messageId}`, type: "user_message", createdAt: Date.now(), text, requestId });
        // A fast command can finish its whole turn while the dispatch
        // resolves; the pump's terminal status then outranks our optimistic
        // promotion, or the turn sticks at "working" forever.
        if (projection.status === "sending") projection.statusUpdate("running");
        return { messageId: accepted.messageId, delivery, ...(conversation ? { conversation } : {}) };
      } catch (error) {
        if (!steering && projection.status === "sending") projection.statusUpdate("failed", errorMessage(error));
        throw error;
      }
    });
  }

  async abort(conversationId: string, requestId: string): Promise<{ cancelled: true }> {
    return this.receipts.run(`cancel:${conversationId}:${requestId}`, async () => {
      await this.requireSession(conversationId);
      const projection = this.projection(conversationId);
      try {
        await this.provider.interrupt(conversationId);
        projection.statusUpdate("interrupted");
        return { cancelled: true };
      } catch (error) {
        projection.statusUpdate("failed", errorMessage(error));
        throw error;
      }
    });
  }

  respondPermission(conversationId: string, requestId: string, clientRequestId: string, outcome: PermissionOutcome): Promise<{ outcome: PermissionOutcome }> {
    return this.receipts.run(`permission:${conversationId}:${requestId}:${clientRequestId}`, async () => {
      const session = await this.requireSession(conversationId);
      const projection = this.projection(conversationId);
      // A subagent's request can be answered from the parent without its own
      // transcript ever having been opened, so the owning projection may be
      // empty. Reconcile it against OpenCode's pending set before judging the
      // request stale — otherwise the card is visible, answerable, and refused.
      if (!projection.has(`permission:${requestId}`)) await this.seedPendingPermissions(conversationId);
      projection.requirePending(requestId, "permission");
      const reply: ProviderPermissionReply = outcome === "approved-once" ? "once" : outcome === "approved-session" ? "always" : "reject";
      await this.provider.replyPermission(conversationId, requestId, reply);
      projection.resolvePermission(requestId, outcome);
      this.resolveMirroredCopy(session.parentId, `permission:${requestId}`, parent => parent.resolvePermission(requestId, outcome));
      return { outcome };
    });
  }

  respondQuestion(conversationId: string, requestId: string, clientRequestId: string, outcome: QuestionOutcome): Promise<{ outcome: QuestionOutcome }> {
    return this.receipts.run(`question:${conversationId}:${requestId}:${clientRequestId}`, async () => {
      const session = await this.requireSession(conversationId);
      const projection = this.projection(conversationId);
      // Same reconciliation as permissions: a subagent's question answered
      // from the parent may target a projection that was never populated (the
      // child transcript never opened, or LRU-evicted). The card is visible
      // and answerable, so judge it against OpenCode's pending set, not
      // against an empty projection.
      if (!projection.has(`question:${requestId}`)) await this.seedPendingQuestions(conversationId);
      projection.requirePending(requestId, "question");
      projection.validateQuestionOutcome(requestId, outcome);
      if (outcome.kind === "rejected") await this.provider.rejectQuestion(conversationId, requestId);
      else await this.provider.replyQuestion(conversationId, requestId, outcome.answers);
      projection.resolveQuestion(requestId, outcome);
      this.resolveMirroredCopy(session.parentId, `question:${requestId}`, parent => parent.resolveQuestion(requestId, outcome));
      return { outcome };
    });
  }

  /**
   * Resolves the parent's mirrored copy of a subagent's request after the
   * provider accepted the answer. The live path mirrors resolutions through
   * the pump, but a request that was *recovered* from the pending list — its
   * events never reached us, which is why reconciliation exists — may produce
   * no replied event either. Without this the parent keeps counting an
   * already-answered request forever, and every further click conflicts.
   */
  private resolveMirroredCopy(parentId: string | undefined, itemId: string, resolve: (parent: ConversationProjection) => void): void {
    if (!parentId) return;
    const parent = this.projections.get(parentId);
    if (parent?.has(itemId)) resolve(parent);
  }

  // Counts an event the pump could not use, by type. Never records a payload:
  // a payload can carry file contents, and the count is what is actionable.
  private countDiscard(outcome: "unrecognized" | "unparseable", eventType: string): void {
    if (!this.metrics) return;
    const type = eventType || "unknown";
    let key = type;
    if (!this.countedEventTypes.has(type)) {
      if (this.countedEventTypes.size >= MAX_COUNTED_EVENT_TYPES) key = "other";
      else this.countedEventTypes.add(type);
    }
    this.metrics.inc(`chat.event.${outcome}.${key}`);
  }

  /**
   * Mirrors a subagent's interaction requests into the conversation that
   * launched it. The child stays the owner: the mirrored item keeps the child's
   * `conversationId`, so answering from either place addresses the child and
   * one `requirePending` guard and receipt key govern the reply.
   *
   * Resolutions mirror too, so answering in the child clears the parent's copy.
   */
  private async mirrorToParent(
    conversationId: string,
    updates: NormalizedProviderUpdate[],
    coalescer: ProviderUpdateCoalescer,
  ): Promise<void> {
    // Removals mirror too: a question withdrawn in the child (answered from
    // the CLI, no longer pending) must also leave the parent's timeline.
    const interactions = updates.filter(update =>
      (update.kind === "upsert" && (update.item.type === "permission" || update.item.type === "question"))
      || (update.kind === "remove" && /^(?:permission|question):/.test(update.itemId)));
    if (interactions.length === 0) return;
    let parentId: string | undefined;
    try {
      parentId = (await this.provider.getSession(conversationId))?.parentId;
    } catch {
      return; // Unknown parentage is not a reason to drop the child's own copy.
    }
    if (!parentId) return;
    coalescer.push(parentId, interactions.map(update => update.kind === "upsert"
      ? {
        ...update,
        // Owner preserved deliberately: this is a view of the child's request,
        // not a second request the parent owns.
        item: { ...update.item, conversationId },
      }
      : update));
  }

  /**
   * Rebuilds a subagent's cost from its own stored messages, for a parent
   * reopened after the live tally was lost — a workspace restart, or an
   * eviction of this parent.
   *
   * A failed read banks nothing: an errored list is unknown, not empty, and
   * caching it as empty would hide a subagent's cost permanently after one
   * transient provider error. A successful read banks even an empty result,
   * which is what stops a child that genuinely reported nothing from being
   * re-read on every open.
   */
  private async reconstructAttribution(parentId: string, childId: string): Promise<void> {
    const byMessage = new Map<string, TokenUsage>();
    let model: string | undefined;
    try {
      // Every page, not just the newest: banking a one-page tally would
      // permanently underreport any child longer than a page, and a banked
      // key is never re-read. Pages walk newest to oldest, so the first
      // page's last-reported model is the child's newest and is kept.
      let cursor: string | undefined;
      do {
        const page = await this.provider.listMessages(childId, { cursor, limit: DEFAULT_PAGE_SIZE });
        let pageModel: string | undefined;
        for (const message of page.items) {
          const reported = storedMessageUsage(message);
          if (!reported) continue;
          if (reported.usage) byMessage.set(reported.messageId, reported.usage);
          if (reported.model) pageModel = reported.model;
        }
        model ??= pageModel;
        cursor = page.nextCursor;
      } while (cursor !== undefined);
    } catch {
      return;
    }
    const key = attributionKey(parentId, childId);
    capped(this.childUsage, key, byMessage);
    if (model !== undefined) capped(this.childModel, key, model);
  }

  /**
   * A session's parent, cached. A failed lookup propagates rather than caching
   * as "no parent": a cached null would permanently hide a subagent from the
   * conversation that launched it after one transient provider error.
   */
  private async parentOf(id: string): Promise<string | null> {
    const known = this.sessionParents.get(id);
    if (known !== undefined) return known;
    const parentId = (await this.provider.getSession(id))?.parentId ?? null;
    this.sessionParents.set(id, parentId);
    return parentId;
  }

  /**
   * Attributes a subagent on the row that launched it: the model its own
   * session ran and the tokens it consumed, summed across its messages and
   * upserted onto the parent's `task` tool item.
   *
   * Materialized onto the parent's item rather than read on demand because the
   * client holds one conversation's projection and can never see a child's —
   * and computed from the events already flowing through this pump rather than
   * fetched per child, which would be a provider call per subagent per render.
   */
  private async attributeSubagent(
    conversationId: string,
    reported: { messageId: string; usage: TokenUsage } | undefined,
    assistantModel: string | undefined,
    coalescer: ProviderUpdateCoalescer,
  ): Promise<void> {
    if (reported === undefined && assistantModel === undefined) return;
    let parentId: string | null;
    try {
      parentId = await this.parentOf(conversationId);
    } catch {
      return; // Unknown parentage is not a reason to fail the child's own events.
    }
    if (!parentId) return;
    const key = attributionKey(parentId, conversationId);
    if (assistantModel !== undefined) capped(this.childModel, key, assistantModel);
    if (reported !== undefined) {
      // Keyed by the provider's message id, not by the part the usage
      // decorated: a message can produce several text parts, and its tokens
      // are cumulative for the message. Banking them per part would count one
      // message's spend once for every part it emitted.
      const byMessage = this.childUsage.get(key) ?? new Map<string, TokenUsage>();
      byMessage.set(reported.messageId, reported.usage);
      capped(this.childUsage, key, byMessage);
    }
    // Nothing to decorate if the parent is not projected — the row lives in
    // its timeline, and an unprojected parent has no row on screen to carry
    // the figure.
    const parent = this.projections.get(parentId);
    const row = parent?.items().find(item => item.type === "tool" && item.childConversationId === conversationId);
    if (!row || row.type !== "tool") return;
    const model = this.childModel.get(key);
    const usage = sumUsage(this.childUsage.get(key));
    coalescer.push(parentId, [{ kind: "upsert", item: {
      ...row,
      ...(model === undefined ? {} : { model }),
      ...(usage === undefined ? {} : { usage }),
    } }]);
  }

  projectionForTests(id: string): ConversationProjection {
    return this.projection(id);
  }

  private async pump(signal: AbortSignal): Promise<void> {
    const coalescer = new ProviderUpdateCoalescer({
      windowMs: this.coalesceWindowMs,
      onFlush: (conversationId, updates) => {
        // Not gated on the abort signal: a graceful stop still applies
        // whatever the coalescer buffered in its final window.
        const projection = this.projection(conversationId);
        for (const update of updates) projection.apply(update);
      },
    });
    try {
      for await (const event of this.provider.events(signal)) {
        if (signal.aborted) break;
        // Inside the loop, never above it: normalization resolves every failure
        // to an outcome, and anything that still escapes must cost one event
        // rather than ending the pump and losing the whole restart gap.
        let normalized;
        try {
          normalized = normalizeProviderEvent(event, this.providerEventMemory);
        } catch {
          this.countDiscard("unparseable", "");
          continue;
        }
        if (normalized.outcome === "unrecognized" || normalized.outcome === "unparseable") {
          this.countDiscard(normalized.outcome, normalized.eventType);
        }
        if (!normalized.conversationId || normalized.updates.length === 0) continue;
        // Confinement is checked per event as it arrives, never at flush time:
        // a session that moves out of the workspace must stop publishing from
        // that moment, and events received while it was confined stay valid.
        try {
          await this.requireSession(normalized.conversationId);
        } catch (error) {
          if (error instanceof ConversationNotFoundError) continue;
          throw error;
        }
        if (signal.aborted) break;
        coalescer.push(normalized.conversationId, normalized.updates);
        // OpenCode never emits `question.v2.asked`, so the arrival of the
        // `question` tool part is the only live signal that a question was
        // asked or answered. Ask the provider for the real pending set and
        // publish the difference; without this a question is invisible until
        // the next snapshot, which meant reloading the browser to see it.
        if (normalized.updates.some(isQuestionToolUpdate)) {
          this.refreshQuestions(normalized.conversationId, coalescer);
        }
        // A subagent's request is otherwise only visible inside the child's
        // transcript — excluded from the picker, reachable solely through the
        // parent's subagent row — so the parent shows a task running and no
        // sign that anything is waiting. Mirror it into the launching
        // conversation, carrying the child's id so the answer still goes to
        // the child.
        await this.mirrorToParent(normalized.conversationId, normalized.updates, coalescer);
        // The same reasoning as the mirror, for cost rather than requests: a
        // subagent's model and token spend live in its own session, which the
        // parent's client never sees.
        await this.attributeSubagent(normalized.conversationId, normalized.assistantUsage, normalized.assistantModel, coalescer);
      }
    } finally {
      coalescer.dispose();
      await coalescer.settled();
    }
  }

  /**
   * Pending questions as timeline items. Ids match the `question.v2.asked`
   * shape so an event-emitting provider and this fallback converge on one
   * item rather than rendering the same question twice.
   */
  /** Throws on provider failure — an errored list is unknown, not empty. */
  private async pendingPermissions(id: string): Promise<ConversationItem[]> {
    if (!this.provider.listPermissions) return [];
    const pending = await this.provider.listPermissions();
    const items: ConversationItem[] = [];
    for (const request of pending) {
      // This conversation's own request, or one owned by a subagent it
      // launched. OpenCode does not deliver a subagent's request on the main
      // event stream, so without the parentage check the parent shows a task
      // running and no sign that anything is waiting on the user.
      if (request.conversationId !== id && !await this.isChildOf(request.conversationId, id)) continue;
      const itemId = `permission:${request.requestId}`;
      // Stable createdAt for the same reason questions keep one: a fresh
      // Date.now() on every reconciliation would keep moving the card.
      const createdAt = this.permissionCreatedAt.get(itemId) ?? Date.now();
      this.permissionCreatedAt.set(itemId, createdAt);
      items.push({
        id: itemId,
        type: "permission" as const,
        createdAt,
        // The owner, never the conversation being rendered: this is what makes
        // an answer given from the parent reach the subagent.
        conversationId: request.conversationId,
        requestId: request.requestId,
        action: request.action,
        resources: request.resources,
        status: "pending" as const,
      });
    }
    return items;
  }

  /** Publishes a conversation's own pending permissions into its projection. */
  private async seedPendingPermissions(conversationId: string): Promise<void> {
    try {
      const projection = this.projection(conversationId);
      for (const item of await this.pendingPermissions(conversationId)) {
        if (!projection.has(item.id)) projection.apply({ kind: "upsert", item });
      }
    } catch { /* unknown, not empty — requirePending still decides */ }
  }

  /** Cached because a reconciliation may ask about the same session twice. */
  private async isChildOf(candidate: string, parentId: string): Promise<boolean> {
    if (candidate === parentId) return false;
    return (await this.parentOf(candidate)) === parentId;
  }

  /** Throws on provider failure — an errored list is unknown, not empty. */
  private async pendingQuestions(id: string): Promise<ConversationItem[]> {
    if (!this.provider.listQuestions) return [];
    const pending = await this.provider.listQuestions();
    const items: ConversationItem[] = [];
    for (const request of pending) {
      // This conversation's own, or a subagent's it launched — the same
      // parentage rule as permissions, and for the same reason: a question
      // asked while the pump was down is otherwise invisible in the only
      // conversation the user actually has open.
      if (request.conversationId !== id && !await this.isChildOf(request.conversationId, id)) continue;
      const itemId = `question:${request.requestId}`;
      // First-seen time, remembered: the provider gives no timestamp, and a
      // fresh Date.now() on every republish would keep moving the question
      // down the timeline as its tool part ticks over.
      const createdAt = this.questionCreatedAt.get(itemId) ?? Date.now();
      this.questionCreatedAt.set(itemId, createdAt);
      items.push({
        id: itemId,
        type: "question" as const,
        createdAt,
        // The owner, never the conversation being rendered — what routes an
        // answer given from the parent to the subagent.
        conversationId: request.conversationId,
        requestId: request.requestId,
        questions: request.questions,
        status: "pending" as const,
      });
    }
    return items;
  }

  /** Publishes a conversation's pending questions into its projection. */
  private async seedPendingQuestions(conversationId: string): Promise<void> {
    try {
      const projection = this.projection(conversationId);
      for (const item of await this.pendingQuestions(conversationId)) {
        if (!projection.has(item.id)) projection.apply({ kind: "upsert", item });
      }
    } catch { /* unknown, not empty — requirePending still decides */ }
  }

  /**
   * Republishes the pending-question set for one conversation: upserts what is
   * pending now and removes what no longer is (answered elsewhere, or from the
   * CLI). Fire-and-forget with one refresh in flight per conversation — a turn
   * emits many `question` tool updates and each must not become a round trip.
   */
  private refreshQuestions(conversationId: string, coalescer: ProviderUpdateCoalescer): void {
    if (!this.provider.listQuestions || this.questionRefreshes.has(conversationId)) return;
    this.questionRefreshes.add(conversationId);
    void (async () => {
      try {
        const items = await this.pendingQuestions(conversationId);
        const live = new Set(items.map(item => item.id));
        const previous = this.publishedQuestions.get(conversationId) ?? new Set<string>();
        const updates: NormalizedProviderUpdate[] = items.map(item => ({ kind: "upsert", item }));
        for (const id of previous) {
          if (live.has(id)) continue;
          updates.push({ kind: "remove", itemId: id });
          this.questionCreatedAt.delete(id);
        }
        if (live.size > 0) this.publishedQuestions.set(conversationId, live);
        else this.publishedQuestions.delete(conversationId);
        if (updates.length > 0) {
          coalescer.push(conversationId, updates);
          // This fallback is the only path that discovers a subagent's
          // question at all (no asked event exists), and the pump's mirror
          // only sees the original tool update — so without mirroring here
          // the parent shows a task running and no sign anything is waiting.
          await this.mirrorToParent(conversationId, updates, coalescer);
        }
      }
      // A failed refresh must reach THIS catch with the published set intact:
      // treating it as an empty pending list would remove live questions and
      // leave the agent blocked with nothing on screen to answer.
      catch { /* a failed refresh leaves the next tool update to retry */ }
      finally { this.questionRefreshes.delete(conversationId); }
    })();
  }

  private async requireSession(id: string): Promise<ProviderSession> {
    // A provider failure propagates as itself: the pump treats not-found as
    // "skip this frame" but must restart on transport errors, and the API
    // routes should answer 500, not 404, when the provider is unreachable.
    const session = await this.provider.getSession(id);
    if (!session || !await isSessionInWorkspace(session.directory, this.workspacePath)) throw new ConversationNotFoundError();
    return session;
  }

  private projection(id: string): ConversationProjection {
    const existing = this.projections.get(id);
    if (existing) {
      // Re-insert to record recency; the Map doubles as the LRU order.
      this.projections.delete(id);
      this.projections.set(id, existing);
      return existing;
    }
    const projection = new ConversationProjection(new ConversationReplay(this.generation, id, this.replayBytes), status => {
      if (status === "running" || status === "sending") this.liveTurns.add(id);
      else this.liveTurns.delete(id);
    });
    this.projections.set(id, projection);
    for (const [candidateId, candidate] of this.projections) {
      if (this.projections.size <= this.maxProjections) break;
      if (candidateId === id || candidate.replay.subscriberCount() > 0) continue;
      // Evicted conversations lose their replay ring; a returning client's
      // stale cursor resolves to a retention-gap resync, which is safe.
      this.projections.delete(candidateId);
      this.lastModel.delete(candidateId);
      this.lastMode.delete(candidateId);
      forgetAttributions(this.childUsage, candidateId);
      forgetAttributions(this.childModel, candidateId);
    }
    return projection;
  }

  private summary(session: ProviderSession, status: ConversationStatus = this.projections.get(session.id)?.status ?? "idle"): ConversationSummary {
    return { id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, status };
  }
}

/** A `question` tool part moving in any direction: asked, answered, or failed. */
function isQuestionToolUpdate(update: NormalizedProviderUpdate): boolean {
  return update.kind === "upsert" && update.item.type === "tool" && update.item.name.toLowerCase() === "question";
}

export function parseSlashCommand(text: string, commands: ChatCommand[]): { name: string; arguments: string } | undefined {
  if (!text.startsWith("/") || text.startsWith("//")) return undefined;
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match || !commands.some(command => command.name === match[1])) return undefined;
  return { name: match[1]!, arguments: match[2]?.trim() ?? "" };
}

export function deriveConversationTitle(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim().replace(/^(?:#{1,6}|>|[-*+]|\d+[.)])\s+/, "");
  if (compact.length <= 64) return compact || "Conversation";
  const prefix = compact.slice(0, 61);
  const boundary = prefix.lastIndexOf(" ");
  return `${(boundary >= 32 ? prefix.slice(0, boundary) : prefix).trimEnd()}...`;
}

function isDefaultConversationTitle(title: string): boolean {
  return !title || /^New session(?:\s+-\s+.*)?$/i.test(title);
}

function sameSelection(left: ModelSelection, right: ModelSelection): boolean {
  return left.providerId === right.providerId && left.modelId === right.modelId;
}

export class ConversationProjection {
  status: ConversationStatus = "idle";
  private readonly timeline = new Map<string, ConversationItem>();
  private readonly text = new ProviderTextReconciler();

  constructor(
    readonly replay: ConversationReplay,
    // Every status change flows through statusUpdate, so this single hook is
    // how the adapter keeps its eviction-proof live-turn set accurate.
    private readonly onStatus?: (status: ConversationStatus) => void,
  ) {}

  has(itemId: string): boolean {
    return this.timeline.has(itemId);
  }

  items(): ConversationItem[] {
    return [...this.timeline.values()].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  seed(items: ConversationItem[]): void {
    for (const item of items) {
      this.timeline.set(item.id, mergeInteraction(this.timeline.get(item.id), item));
      if (item.type === "assistant_message") this.text.seed(item.id.replace(/^part:/, ""), item.markdown);
      else if (item.type === "reasoning") this.text.seed(item.id.replace(/^part:|^reasoning:/, ""), item.text);
    }
  }

  apply(update: NormalizedProviderUpdate): ChatEvent | undefined {
    if (update.kind === "upsert") return this.upsert(update.item);
    if (update.kind === "remove") {
      this.timeline.delete(update.itemId);
      return this.replay.publish({ type: "item.remove", itemId: update.itemId });
    }
    if (update.kind === "status") return this.statusUpdate(update.status, update.message);
    const wasNew = update.item !== undefined && !this.timeline.has(update.itemId);
    if (wasNew && update.item) this.timeline.set(update.itemId, update.item);
    const before = this.text.value(update.identity);
    const delta = update.mode === "cumulative"
      ? this.text.cumulative(update.identity, update.text)
      : this.text.incremental(update.identity, update.text);
    const currentText = this.text.value(update.identity);
    const textItem = this.timeline.get(update.itemId);
    if (textItem?.type === "reasoning") {
      const status = update.item?.type === "reasoning" ? update.item.status : textItem.status;
      // The live stream never reports thinking time, so it is measured here:
      // the completing event's timestamp against the item's first appearance.
      const finishedNow = status === "completed" && textItem.status !== "completed" && update.item !== undefined;
      const durationMs = textItem.durationMs ?? (finishedNow ? Math.max(0, update.item!.createdAt - textItem.createdAt) : undefined);
      return this.upsert({ ...textItem, text: currentText, status, ...(durationMs === undefined ? {} : { durationMs }) });
    }
    if (wasNew && textItem?.type === "assistant_message") return this.upsert({ ...textItem, markdown: currentText });
    if (update.mode === "cumulative" && before !== currentText && !currentText.startsWith(before)) {
      const item = this.timeline.get(update.itemId);
      if (item?.type === "assistant_message") return this.upsert({ ...item, markdown: currentText });
      if (item?.type === "reasoning") return this.upsert({ ...item, text: currentText });
    }
    if (!delta) return undefined;
    const item = this.timeline.get(update.itemId);
    if (item?.type === "assistant_message") this.timeline.set(item.id, { ...item, markdown: currentText });
    else if (item?.type === "reasoning") this.timeline.set(item.id, { ...item, text: currentText });
    return this.replay.publish({ type: "item.text_delta", itemId: update.itemId, delta });
  }

  upsert(item: ConversationItem): ChatEvent | undefined {
    const current = this.timeline.get(item.id);
    const merged = mergeInteraction(current, item);
    // A resolution for a question this projection never saw (asked frame
    // missed, projection evicted) has no question content to render, and an
    // empty questions array fails client validation — publishing it would
    // trade one lost frame for a stream resync loop.
    if (merged.type === "question" && merged.questions.length === 0) return undefined;
    // Same for a permission resolution whose ask was never projected: the
    // classic `permission.replied` event carries no action or resources, and
    // an empty resources array fails client validation the same way.
    if (merged.type === "permission" && merged.resources.length === 0) return undefined;
    this.timeline.set(item.id, merged);
    if (merged.type === "assistant_message") this.text.seed(merged.id.replace(/^part:/, ""), merged.markdown);
    if (merged.type === "reasoning") this.text.seed(merged.id.replace(/^part:|^reasoning:/, ""), merged.text);
    return this.replay.publish({ type: "item.upsert", item: merged });
  }

  statusUpdate(status: ConversationStatus, message?: string): ChatEvent {
    this.status = status;
    this.onStatus?.(status);
    return this.replay.publish({ type: "conversation.status", status, message });
  }

  requirePending(requestId: string, type: "permission" | "question"): void {
    const item = this.timeline.get(`${type}:${requestId}`);
    if (!item || (item.type !== "permission" && item.type !== "question") || item.type !== type || item.status !== "pending") {
      throw new InteractionConflictError();
    }
    // Answerable is decided per owning conversation, matching the renderer: a
    // parent shows its own requests next to mirrored subagent ones, and a
    // newer mirrored request must not make the parent's own request refuse
    // the answer its enabled buttons just offered.
    const own = this.replay.conversationId;
    const owner = item.conversationId ?? own;
    const pending = [...this.timeline.values()]
      .filter((candidate): candidate is PermissionRequest | QuestionRequest =>
        (candidate.type === "permission" || candidate.type === "question") && candidate.status === "pending")
      .filter(candidate => (candidate.conversationId ?? own) === owner)
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
    if (pending[0]?.id !== item.id) throw new InteractionConflictError();
  }

  validateQuestionOutcome(requestId: string, outcome: QuestionOutcome): void {
    if (outcome.kind === "rejected") return;
    const item = this.timeline.get(`question:${requestId}`);
    if (!item || item.type !== "question" || outcome.answers.length !== item.questions.length) throw new InteractionConflictError("invalid question response");
    for (let index = 0; index < item.questions.length; index += 1) {
      const question = item.questions[index]!;
      const answers = outcome.answers[index]!;
      if (!question.multiple && answers.length > 1) throw new InteractionConflictError("question does not allow multiple answers");
      const labels = new Set(question.options.map(option => option.label));
      if (answers.some(answer => !labels.has(answer) && !question.allowFreeForm)) {
        throw new InteractionConflictError("question does not allow free-form answers");
      }
    }
  }

  resolvePermission(requestId: string, outcome: PermissionOutcome): void {
    const item = this.timeline.get(`permission:${requestId}`);
    if (!item || item.type !== "permission") throw new InteractionConflictError();
    this.upsert({ ...item, status: "resolved", outcome });
  }

  resolveQuestion(requestId: string, outcome: QuestionOutcome): void {
    const item = this.timeline.get(`question:${requestId}`);
    if (!item || item.type !== "question") throw new InteractionConflictError();
    this.upsert({ ...item, status: "resolved", outcome });
  }
}

const MAX_CHILD_ATTRIBUTIONS = 512;
// NUL: a session id cannot contain one, so the two halves stay unambiguous.
const ATTRIBUTION_SEPARATOR = "\u0000";

function attributionKey(parentId: string, childId: string): string {
  return `${parentId}${ATTRIBUTION_SEPARATOR}${childId}`;
}

function forgetAttributions(map: Map<string, unknown>, parentId: string): void {
  const prefix = `${parentId}${ATTRIBUTION_SEPARATOR}`;
  for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key);
}

/** Insert-ordered with a ceiling: the oldest child attributed drops out first. */
function capped<T>(map: Map<string, T>, key: string, value: T): void {
  map.set(key, value);
  if (map.size > MAX_CHILD_ATTRIBUTIONS) map.delete(map.keys().next().value!);
}

/**
 * A subagent's total, component by component. A component nothing reported
 * stays absent rather than summing to zero — the row must not assert a figure
 * the agent never gave.
 */
function sumUsage(byMessage: Map<string, TokenUsage> | undefined): TokenUsage | undefined {
  if (!byMessage || byMessage.size === 0) return undefined;
  const total: TokenUsage = {};
  for (const usage of byMessage.values()) {
    for (const key of ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const) {
      const value = usage[key];
      if (value !== undefined) total[key] = (total[key] ?? 0) + value;
    }
  }
  return Object.keys(total).length > 0 ? total : undefined;
}

function mergeInteraction(current: ConversationItem | undefined, incoming: ConversationItem): ConversationItem {
  if (!current || current.type !== incoming.type) return incoming;
  if (current.type === "user_message" && incoming.type === "user_message") {
    if (current.requestId && !incoming.requestId) return { ...incoming, text: current.text, requestId: current.requestId };
    // A history-loaded message carries no requestId, and message.updated events
    // normalize with empty parts — an empty incoming text is "no new content",
    // not a blanking instruction.
    if (!incoming.text) return { ...incoming, text: current.text };
  }
  if (current.type === "assistant_message" && incoming.type === "assistant_message") {
    // A usage-only upsert decorates a part that is already on screen: it
    // carries no text and no time of its own. Taking its empty markdown would
    // erase the answer mid-stream; taking its timestamp would resort the
    // timeline, which is ordered by `createdAt`.
    const usageOnly = incoming.markdown === "";
    return {
      ...current,
      ...incoming,
      createdAt: usageOnly ? current.createdAt : incoming.createdAt,
      markdown: incoming.markdown || current.markdown,
      ...(current.usage || incoming.usage ? { usage: { ...current.usage, ...incoming.usage } } : {}),
    };
  }
  // Resolved interactions are terminal. The merged provider streams preserve
  // order only within themselves, so a delayed classic alias of an ask can
  // land after the native reply — accepting its "pending" would reopen a card
  // OpenCode no longer accepts an answer for (and carry the old outcome onto
  // a pending item, which fails client validation).
  if (current.type === "permission" && incoming.type === "permission") {
    const reopened = current.status === "resolved" && incoming.status === "pending";
    return {
      ...current,
      ...incoming,
      action: incoming.action === "permission" ? current.action : incoming.action,
      resources: incoming.resources.length ? incoming.resources : current.resources,
      ...(reopened ? { status: "resolved" as const, outcome: current.outcome } : {}),
    };
  }
  if (current.type === "question" && incoming.type === "question") {
    const reopened = current.status === "resolved" && incoming.status === "pending";
    return {
      ...current,
      ...incoming,
      questions: incoming.questions.length ? incoming.questions : current.questions,
      ...(reopened ? { status: "resolved" as const, outcome: current.outcome } : {}),
    };
  }
  if (current.type === "tool" && incoming.type === "tool") {
    const keepTerminal = current.status === "completed" || current.status === "failed" || current.status === "cancelled";
    return {
      ...current,
      ...incoming,
      name: incoming.name === "tool" ? current.name : incoming.name,
      status: keepTerminal && (incoming.status === "pending" || incoming.status === "running") ? current.status : incoming.status,
      input: incoming.input ?? current.input,
      output: incoming.output ?? current.output,
      error: incoming.error ?? current.error,
      // A subagent's attribution is mirrored from its child session, so it
      // arrives on its own upsert and must survive the tool part's own
      // updates — which know nothing about it.
      childConversationId: incoming.childConversationId ?? current.childConversationId,
      model: incoming.model ?? current.model,
      ...(current.usage || incoming.usage ? { usage: { ...current.usage, ...incoming.usage } } : {}),
    };
  }
  if (current.type === "command" && incoming.type === "command") {
    const keepTerminal = current.status === "completed" || current.status === "failed" || current.status === "cancelled";
    return {
      ...current,
      ...incoming,
      command: incoming.command === "command" ? current.command : incoming.command,
      status: keepTerminal && (incoming.status === "pending" || incoming.status === "running") ? current.status : incoming.status,
      output: incoming.output ?? current.output,
      exitCode: incoming.exitCode ?? current.exitCode,
    };
  }
  return incoming;
}

type HistoryCursor = { provider: string };

function encodeHistoryCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, p: cursor.provider })).toString("base64url");
}

function decodeHistoryCursor(value: string): HistoryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString()) as { v?: unknown; p?: unknown };
    if (parsed.v !== 1 || typeof parsed.p !== "string" || !parsed.p) throw new Error();
    return { provider: parsed.p };
  } catch {
    throw new Error("invalid history cursor");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
