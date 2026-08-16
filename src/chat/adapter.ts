import { randomBytes, randomUUID } from "node:crypto";

import { ProviderUpdateCoalescer } from "./coalescer";
import { normalizeProviderEvent, normalizeProviderMessage, type NormalizedProviderUpdate } from "./normalization";
import type { OpenCodeProvider, ProviderPermissionReply, ProviderSession } from "./provider";
import { IdempotencyReceipts } from "./receipts";
import { ConversationReplay, type ReplaySubscription } from "./replay";
import { ProviderTextReconciler } from "./text-reconciler";
import type {
  ChatEvent,
  ChatCommand,
  ChatModel,
  ConversationItem,
  ConversationSnapshot,
  ConversationStatus,
  ConversationSummary,
  PermissionOutcome,
  ModelSelection,
  QuestionOutcome,
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
  private readonly maxProjections: number;
  private readonly coalesceWindowMs: number | undefined;
  private readonly lastModel = new Map<string, ModelSelection>();
  private readonly providerMessageRoles = new Map<string, string>();
  private pumpController: AbortController | null = null;
  private pumpPromise: Promise<void> | null = null;

  constructor(options: ChatAdapterOptions) {
    this.provider = options.provider;
    this.workspacePath = options.workspacePath;
    this.generation = options.generation ?? randomBytes(16).toString("base64url");
    this.replayBytes = options.replayBytes ?? 256 * 1024;
    this.maxProjections = options.maxProjections ?? 64;
    this.coalesceWindowMs = options.coalesceWindowMs;
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
    // OpenCode 1.18 never emits `question.v2.asked`, so a pending question is
    // invisible to the event stream and only the provider knows about it.
    // Asking here is what makes an open question answerable at all.
    const pendingNow = await this.pendingQuestions(id);
    for (const pending of pendingNow) {
      if (items.some(item => item.id === pending.id)) continue;
      items.push(pending);
    }
    if (pendingNow.length > 0) this.publishedQuestions.set(id, new Set(pendingNow.map(item => item.id)));
    else this.publishedQuestions.delete(id);
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

  async prompt(conversationId: string, requestId: string, text: string, model?: ModelSelection): Promise<{
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
      let conversation: ConversationSummary | undefined;
      if (this.provider.renameSession && isDefaultConversationTitle(session.title)) {
        const page = await this.provider.listMessages(conversationId, { limit: 1 });
        if (page.items.length === 0) {
          session = await this.provider.renameSession(conversationId, deriveConversationTitle(text));
          if (!await isSessionInWorkspace(session.directory, this.workspacePath)) throw new ConversationNotFoundError();
          conversation = this.summary(session, "sending");
        }
      }
      projection.statusUpdate("sending");
      try {
        const slash = text.startsWith("/")
          ? parseSlashCommand(text, await this.provider.listCommands().catch(() => []))
          : undefined;
        const accepted = slash
          ? await this.provider.command(conversationId, { id: messageId, name: slash.name, arguments: slash.arguments, model })
          : await this.provider.prompt(conversationId, { id: messageId, text, delivery, model });
        projection.upsert({ id: `message:${accepted.messageId}`, type: "user_message", createdAt: Date.now(), text, requestId });
        projection.statusUpdate("running");
        return { messageId: accepted.messageId, delivery, ...(conversation ? { conversation } : {}) };
      } catch (error) {
        projection.statusUpdate("failed", errorMessage(error));
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
      await this.requireSession(conversationId);
      const projection = this.projection(conversationId);
      projection.requirePending(requestId, "permission");
      const reply: ProviderPermissionReply = outcome === "approved-once" ? "once" : outcome === "approved-session" ? "always" : "reject";
      await this.provider.replyPermission(conversationId, requestId, reply);
      projection.resolvePermission(requestId, outcome);
      return { outcome };
    });
  }

  respondQuestion(conversationId: string, requestId: string, clientRequestId: string, outcome: QuestionOutcome): Promise<{ outcome: QuestionOutcome }> {
    return this.receipts.run(`question:${conversationId}:${requestId}:${clientRequestId}`, async () => {
      await this.requireSession(conversationId);
      const projection = this.projection(conversationId);
      projection.requirePending(requestId, "question");
      projection.validateQuestionOutcome(requestId, outcome);
      if (outcome.kind === "rejected") await this.provider.rejectQuestion(conversationId, requestId);
      else await this.provider.replyQuestion(conversationId, requestId, outcome.answers);
      projection.resolveQuestion(requestId, outcome);
      return { outcome };
    });
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
      const normalized = normalizeProviderEvent(event, this.providerMessageRoles);
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
  private async pendingQuestions(id: string): Promise<ConversationItem[]> {
    if (!this.provider.listQuestions) return [];
    const pending = await this.provider.listQuestions(id).catch(() => []);
    return pending.map(request => {
      const itemId = `question:${request.requestId}`;
      // First-seen time, remembered: the provider gives no timestamp, and a
      // fresh Date.now() on every republish would keep moving the question
      // down the timeline as its tool part ticks over.
      const createdAt = this.questionCreatedAt.get(itemId) ?? Date.now();
      this.questionCreatedAt.set(itemId, createdAt);
      return {
        id: itemId,
        type: "question" as const,
        createdAt,
        requestId: request.requestId,
        questions: request.questions,
        status: "pending" as const,
      };
    });
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
        if (updates.length > 0) coalescer.push(conversationId, updates);
      } catch { /* a failed refresh leaves the next tool update to retry */ }
      finally { this.questionRefreshes.delete(conversationId); }
    })();
  }

  private async requireSession(id: string): Promise<ProviderSession> {
    const session = await this.provider.getSession(id).catch(() => null);
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
    const projection = new ConversationProjection(new ConversationReplay(this.generation, id, this.replayBytes));
    this.projections.set(id, projection);
    for (const [candidateId, candidate] of this.projections) {
      if (this.projections.size <= this.maxProjections) break;
      if (candidateId === id || candidate.replay.subscriberCount() > 0) continue;
      // Evicted conversations lose their replay ring; a returning client's
      // stale cursor resolves to a retention-gap resync, which is safe.
      this.projections.delete(candidateId);
      this.lastModel.delete(candidateId);
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

  constructor(readonly replay: ConversationReplay) {}

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
      return this.upsert({ ...textItem, text: currentText, status });
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

  upsert(item: ConversationItem): ChatEvent {
    const current = this.timeline.get(item.id);
    const merged = mergeInteraction(current, item);
    this.timeline.set(item.id, merged);
    if (merged.type === "assistant_message") this.text.seed(merged.id.replace(/^part:/, ""), merged.markdown);
    if (merged.type === "reasoning") this.text.seed(merged.id.replace(/^part:|^reasoning:/, ""), merged.text);
    return this.replay.publish({ type: "item.upsert", item: merged });
  }

  statusUpdate(status: ConversationStatus, message?: string): ChatEvent {
    this.status = status;
    return this.replay.publish({ type: "conversation.status", status, message });
  }

  requirePending(requestId: string, type: "permission" | "question"): void {
    const item = this.timeline.get(`${type}:${requestId}`);
    const pending = [...this.timeline.values()]
      .filter(candidate => (candidate.type === "permission" || candidate.type === "question") && candidate.status === "pending")
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
    if (!item || item.type !== type || item.status !== "pending" || pending[0]?.id !== item.id) throw new InteractionConflictError();
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

function mergeInteraction(current: ConversationItem | undefined, incoming: ConversationItem): ConversationItem {
  if (!current || current.type !== incoming.type) return incoming;
  if (current.type === "user_message" && incoming.type === "user_message") {
    if (current.requestId && !incoming.requestId) return { ...incoming, text: current.text, requestId: current.requestId };
    // A history-loaded message carries no requestId, and message.updated events
    // normalize with empty parts — an empty incoming text is "no new content",
    // not a blanking instruction.
    if (!incoming.text) return { ...incoming, text: current.text };
  }
  if (current.type === "permission" && incoming.type === "permission") {
    return { ...current, ...incoming, action: incoming.action === "permission" ? current.action : incoming.action, resources: incoming.resources.length ? incoming.resources : current.resources };
  }
  if (current.type === "question" && incoming.type === "question") {
    return { ...current, ...incoming, questions: incoming.questions.length ? incoming.questions : current.questions };
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
