import { OpenCode } from "@opencode/client";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { OpenCodeNotificationLifecycle } from "../notification-lifecycle";
import { OPENCODE_PERMISSION_SCOPE_NOTE } from "../permission-scope";
import { stableProviderId } from "../message-id";
import { measureChatWork } from "../../performance";
import { HistoryReuse, historyPageCursor, historyPageEnd, historyVersion } from "../../history-reuse";
import { InvalidQuestionAnswerError, ReversibleHistoryTargetError } from "../../provider";
import type {
  ChatProvider,
  NormalizedProviderEvent,
  PendingPermission,
  PendingQuestion,
  ProviderAttachment,
  ProviderHistoryPage,
  ProviderPermissionReply,
  ProviderSession,
  StoredMessageAccounting,
} from "../../provider";
import { pendingPermissionFields } from "../normalization";
import { createOpenCodeV2Memory, createOpenCodeV2Normalizer, formPresentation, modelSelection, normalizeStoredMessage, storedAccounting, storedPromptId, supportedFormFields } from "./normalization";
import type { ChatAgent, ChatCommand, ChatMode, ChatModel, ConversationConfiguration, ModelSelection, RestoredDraft, ReversibleHistoryResult, ReversibleHistoryState } from "../../types";

/**
 * The OpenCode 2.x provider: the same `ChatProvider` seam as the 1.x stack,
 * over `@opencode/client`. Every route is under `/api/…`, every call that
 * can be scoped carries `location: { directory }`, and the one server may
 * serve other directories of the same database — so sessions from elsewhere
 * are refused and their events dropped (see the 2.x mapper).
 */
export type OpenCodeV2Client = ReturnType<typeof OpenCode.make>;

type StoredMessage = Record<string, unknown>;
type SessionRecord = Record<string, unknown>;
type ReversibleTurn = { id: string; providerId: string; draft: RestoredDraft; summary: string };
type ReversibleHistoryContext = { turns: ReversibleTurn[]; boundaryIndex?: number; state: ReversibleHistoryState };

export function createOpenCodeV2Provider(options: {
  endpoint: string;
  password: string;
  directory: string;
  fetch?: typeof globalThis.fetch;
  commandAdmissionMs?: number;
}): ChatProvider {
  const authorization = `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}`;
  const client = OpenCode.make({
    baseUrl: options.endpoint,
    headers: { authorization },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return new OpenCodeV2Provider(client, options.directory, options.commandAdmissionMs);
}

export class OpenCodeV2Provider implements ChatProvider {
  private readonly historyReuse = new HistoryReuse<StoredMessage[]>();
  private readonly notificationLifecycle = new OpenCodeNotificationLifecycle();
  private readonly normalize: ReturnType<typeof createOpenCodeV2Normalizer>;
  private readonly workspace: string;
  // Slash-command admissions waiting for the stream to name their row: one
  // per session, since the adapter admits one send per conversation at a
  // time. Only a consumed `events()` can settle one.
  private readonly enqueuedUserWaiters = new Map<string, (messageId: string) => void>();
  private streaming = false;

  constructor(
    private readonly client: OpenCodeV2Client,
    private readonly directory: string,
    private readonly commandAdmissionMs = 1_000,
  ) {
    this.workspace = path.resolve(directory);
    this.normalize = createOpenCodeV2Normalizer(directory);
  }

  private get scope() {
    return { location: { directory: this.directory } };
  }

  // Everything below is implemented against a live OpenCode 2.0.13 server
  // (sandboxed home, free public model). Usage reporting has no 2.x
  // equivalent found yet, so it stays undeclared.
  describe(): ChatAgent {
    return {
      id: "opencode",
      name: "OpenCode",
      capabilities: ["modes", "models", "commands", "questions", "permissions", "subagents", "variants", "context", "conversation-rename", "attachments", "reversible-history"],
      permissionScopeNote: OPENCODE_PERMISSION_SCOPE_NOTE,
    };
  }

  async listCommands(): Promise<ChatCommand[]> {
    const { data } = await this.client.command.list(this.scope);
    const result: ChatCommand[] = [];
    const names = new Set<string>();
    for (const command of data) {
      if (!/^[^\s/]+$/.test(command.name) || names.has(command.name)) continue;
      names.add(command.name);
      result.push({ name: command.name, description: command.description ?? "", argumentHint: "", kind: "command" });
    }
    for (const builtin of BUILTIN_COMMANDS) if (!names.has(builtin.name)) result.push(builtin);
    return result;
  }

  async listModes(): Promise<ChatMode[]> {
    const { data } = await this.client.agent.list(this.scope);
    const modes: ChatMode[] = [];
    const names = new Set<string>();
    for (const agent of data) {
      // OpenCode calls these agents; this codebase calls them modes. A 2.x
      // agent has an id (`build`) and a display name (`Build`); the id is
      // what `switchAgent` takes and what a session reports, so it is the
      // mode's name on the seam. Subagents are spawned by the task tool,
      // never chosen for a prompt, and the system agents (title, compaction,
      // summary) are hidden.
      if (!agent.id || names.has(agent.id) || agent.mode === "subagent" || agent.hidden) continue;
      names.add(agent.id);
      modes.push({ name: agent.id, description: agent.description ?? agent.name ?? "" });
    }
    return modes;
  }

  async listModels(): Promise<ChatModel[]> {
    const [models, providers] = await this.catalog();
    const providerNames = new Map(providers.map(provider => [provider.id, provider.name]));
    return models
      .filter(model => model.enabled !== false && model.status !== "deprecated")
      .map(model => {
        const variants = model.variants.map(variant => variant.id);
        const imageInput = model.capabilities.input.includes("image");
        return {
          selection: { providerId: model.providerID, modelId: model.modelID },
          provider: providerNames.get(model.providerID) ?? model.providerID,
          name: model.name,
          ...(variants.length ? { variants } : {}),
          ...(model.limit.context ? { contextLimit: model.limit.context } : {}),
          ...(imageInput ? { imageInput } : {}),
        };
      })
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name));
  }

  /**
   * A 2.x server answers its first catalog requests after start with an
   * empty model and provider list while it is still loading them (observed
   * on 2.0.13: empty, then the whole catalog a moment later). An empty
   * answer is retried briefly rather than reported as "no models", which
   * would refuse the very selection a client just listed.
   */
  private async catalog(): Promise<[Awaited<ReturnType<OpenCodeV2Client["model"]["list"]>>["data"], Awaited<ReturnType<OpenCodeV2Client["provider"]["list"]>>["data"]]> {
    for (let attempt = 0; ; attempt += 1) {
      const [models, providers] = await Promise.all([this.client.model.list(this.scope), this.client.provider.list(this.scope)]);
      if (models.data.length > 0 || attempt >= CATALOG_ATTEMPTS - 1) return [models.data, providers.data];
      await new Promise(resolve => setTimeout(resolve, CATALOG_RETRY_MS));
    }
  }

  async newConversationConfiguration(): Promise<ConversationConfiguration> {
    const [fallback, agents] = await Promise.all([this.client.model.default(this.scope), this.client.agent.list(this.scope)]);
    const primary = agents.data.filter(agent => agent.mode !== "subagent" && !agent.hidden && agent.id);
    const selectedAgent = primary.find(agent => agent.id === "build") ?? primary[0];
    const model = modelSelection(selectedAgent?.model) ?? (fallback.data ? { providerId: fallback.data.providerID, modelId: fallback.data.modelID } : undefined);
    return {
      ...(model ? { model } : {}),
      ...(selectedAgent ? { mode: selectedAgent.id } : {}),
    };
  }

  async switchModel(sessionId: string, selection: ModelSelection, variant?: string): Promise<void> {
    // The reasoning variant rides on the model reference. The UI re-sends the
    // model every prompt, so this runs every turn and the variant is
    // reapplied — or reset — every turn.
    await this.client.session.switchModel({
      sessionID: sessionId,
      model: { id: selection.modelId, providerID: selection.providerId, ...(variant ? { variant } : {}) },
    });
  }

  async renameSession(sessionId: string, title: string): Promise<ProviderSession> {
    await this.client.session.update({ sessionID: sessionId, title });
    const session = await this.getSession(sessionId);
    if (!session) throw new Error("OpenCode session disappeared after rename");
    return session;
  }

  async listSessions(): Promise<ProviderSession[]> {
    const sessions: ProviderSession[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.session.list(cursor
        ? { directory: this.directory, limit: 100, cursor }
        : { directory: this.directory, order: "desc", limit: 100 });
      for (const info of page.data) if (this.owns(info)) sessions.push(toSession(info));
      cursor = page.data.length > 0 ? page.cursor.next ?? undefined : undefined;
    } while (cursor);
    return sessions;
  }

  async createSession(_id: string, configuration: ConversationConfiguration = {}): Promise<ProviderSession> {
    const info = await this.client.session.create({
      location: { directory: this.directory },
      ...(configuration.mode ? { agent: configuration.mode } : {}),
      ...(configuration.model ? { model: {
        id: configuration.model.modelId,
        providerID: configuration.model.providerId,
        ...(configuration.variant ? { variant: configuration.variant } : {}),
      } } : {}),
    });
    return toSession(info);
  }

  async getSession(id: string): Promise<ProviderSession | null> {
    const info = await this.lookupSession(id);
    return info ? toSession(info) : null;
  }

  async getConversationConfiguration(sessionId: string): Promise<ConversationConfiguration> {
    const info = await this.lookupSession(sessionId);
    if (!info) return {};
    const model = modelSelection(info.model);
    const mode = stringValue(info.agent);
    const rawVariant = stringValue(asRecord(info.model).variant);
    // "default" means no explicit reasoning override; it is not a variant.
    const variant = model && rawVariant && rawVariant !== "default" ? rawVariant : undefined;
    return { ...(model ? { model } : {}), ...(mode ? { mode } : {}), ...(variant ? { variant } : {}) };
  }

  /**
   * History is read whole and paged locally, as on 1.x: the revert boundary
   * hides the reverted suffix, and each assistant record is paired with the
   * newest user record before it (2.x names no prompt on an assistant
   * record either).
   */
  async listMessages(sessionId: string, options: { cursor?: string; limit: number }): Promise<ProviderHistoryPage> {
    const complete = await this.allMessages(sessionId);
    const info = await this.lookupSession(sessionId);
    const boundaryId = stringValue(asRecord(asRecord(info).revert).messageID);
    const boundaryIndex = boundaryId ? complete.findIndex(message => messageIdentity(message) === boundaryId) : -1;
    const visible = boundaryIndex >= 0 ? complete.slice(0, boundaryIndex) : complete;
    const version = historyVersion([visible, boundaryId]);
    const end = historyPageEnd(options.cursor, version, visible.length);
    const start = Math.max(0, end - Math.max(1, options.limit));
    const page = visible.slice(start, end);
    const accounting: StoredMessageAccounting[] = [];
    let newestPrompt: string | undefined;
    for (let index = 0; index < end; index += 1) {
      const message = visible[index]!;
      newestPrompt = storedPromptId(message) ?? newestPrompt;
      if (index < start) continue;
      const reported = storedAccounting(message);
      if (reported) accounting.push(newestPrompt === undefined ? reported : { ...reported, promptId: newestPrompt });
    }
    return {
      items: page.flatMap(message => normalizeStoredMessage(message)),
      accounting,
      completeItems: visible.flatMap(message => normalizeStoredMessage(message)),
      nextCursor: historyPageCursor(start, version),
    };
  }

  private async allMessages(sessionId: string): Promise<StoredMessage[]> {
    return this.historyReuse.read(sessionId, undefined, () => this.readAllMessages(sessionId));
  }

  private async readAllMessages(sessionId: string): Promise<StoredMessage[]> {
    const finish = measureChatWork("opencode-read");
    try {
      const byId = new Map<string, StoredMessage>();
      let cursor: string | undefined;
      do {
        // The cursor encodes the direction, so `order` is sent only for the
        // first page.
        const page = await this.client.message.list(cursor
          ? { sessionID: sessionId, limit: 100, cursor }
          : { sessionID: sessionId, order: "asc", limit: 100 });
        for (const item of page.data as StoredMessage[]) byId.set(messageIdentity(item), item);
        cursor = page.data.length > 0 ? page.cursor.next ?? undefined : undefined;
      } while (cursor);
      return [...byId.values()].sort((left, right) => messageCreatedAt(left) - messageCreatedAt(right));
    } finally { finish(); }
  }

  async *events(signal: AbortSignal): AsyncIterable<NormalizedProviderEvent> {
    this.historyReuse.invalidate();
    // Memory scoped to the subscription: one pump, one memory.
    const memory = createOpenCodeV2Memory();
    this.streaming = true;
    try {
      for await (const event of this.client.event.subscribe({ signal })) {
        // Normalization resolves every failure to an outcome, and anything
        // that still escapes must cost one event rather than ending the stream.
        let normalized: NormalizedProviderEvent;
        try {
          normalized = this.normalize(event, memory);
          const notificationTurns = this.notificationLifecycle.observe(event, normalized);
          if (notificationTurns.length > 0) { normalized.notificationTurns = notificationTurns; normalized.outcome = "handled"; }
          this.historyReuse.invalidate(normalized.conversationId);
        } catch {
          normalized = { updates: [], outcome: "unparseable", eventType: "" };
        }
        yield normalized;
        // After the yield, not before: the consumer has applied this event
        // by the time the generator resumes, so a command admission settled
        // here returns after the streamed row landed — and the caller's own
        // upsert, the text the user typed, lands last.
        this.reportEnqueuedUser(normalized);
      }
    } catch (error) {
      // Cancellation ends the stream quietly; anything else must reach the
      // pump's supervisor so it reconnects.
      if (!signal.aborted) throw error;
    } finally {
      this.streaming = false;
    }
  }

  private reportEnqueuedUser(event: NormalizedProviderEvent): void {
    if (event.eventType !== "session.inbox.enqueued" || !event.conversationId) return;
    const resolve = this.enqueuedUserWaiters.get(event.conversationId);
    if (!resolve) return;
    for (const update of event.updates) {
      if (update.kind !== "upsert" || update.item.type !== "user_message") continue;
      resolve(update.item.id.slice("message:".length));
      return;
    }
  }

  private awaitEnqueuedUser(sessionId: string): { promise: Promise<string>; release: () => void } {
    let resolve!: (messageId: string) => void;
    const promise = new Promise<string>(settle => { resolve = settle; });
    this.enqueuedUserWaiters.set(sessionId, resolve);
    return { promise, release: () => { if (this.enqueuedUserWaiters.get(sessionId) === resolve) this.enqueuedUserWaiters.delete(sessionId); } };
  }

  async dispose(): Promise<void> {
    this.historyReuse.dispose();
  }

  async prompt(sessionId: string, input: { id: string; text: string; delivery: "queue"; attachments?: ProviderAttachment[]; model?: ModelSelection; mode?: string; variant?: string }): Promise<{ messageId: string }> {
    this.historyReuse.invalidate(sessionId);
    // Session-level, not prompt fields: the prompt input carries neither a
    // model nor an agent.
    if (input.model) await this.switchModel(sessionId, input.model, input.variant);
    if (input.mode) await this.client.session.switchAgent({ sessionID: sessionId, agent: input.mode });
    const files = (input.attachments ?? []).map(attachment => ({
      // `file:` over `data:` because the processes share a disk: no base64
      // inflation, and the stored record echoes the uri as the attachment's
      // source, which is what replay linkage keys on.
      uri: pathToFileURL(attachment.absolutePath).href,
      name: attachment.name,
    }));
    const admitted = await this.client.session.prompt({
      sessionID: sessionId,
      id: stableProviderId("msg", input.id),
      text: input.text,
      ...(files.length ? { files } : {}),
      delivery: input.delivery,
      resume: true,
    });
    return { messageId: admitted.id };
  }

  /**
   * A command is a turn like any other, so it runs at the model and
   * reasoning effort the user picked. The dispatch races a short admission
   * window: an invalid command or unavailable provider rejects immediately
   * and reaches the caller's draft-restoration path, while a healthy turn
   * outlives the window, detaches, and reports through the event stream.
   *
   * The row's id differs by route. Compaction takes the stable id, as a
   * prompt does. A slash command cannot: `session.command` accepts no id
   * and answers no content, so the server mints the inbox item's id and
   * names it only in `session.inbox.enqueued`. The stream hands that id
   * back here within the window, so the caller's optimistic row and the
   * streamed one converge on one item; without a live stream the local id
   * stands. That is also why a retry of an accepted command whose response
   * was lost can run twice on 2.x: the API carries no key to dedupe on.
   */
  async command(sessionId: string, input: { id: string; name: string; arguments: string; model?: ModelSelection; mode?: string; variant?: string }): Promise<{ messageId: string }> {
    this.historyReuse.invalidate(sessionId);
    const messageId = stableProviderId("msg", input.id);
    if (input.model) await this.switchModel(sessionId, input.model, input.variant);
    if (input.mode) await this.client.session.switchAgent({ sessionID: sessionId, agent: input.mode });
    const compacts = input.name === "compact" || input.name === "summarize";
    const dispatch: Promise<unknown> = compacts
      ? this.client.session.compact({ sessionID: sessionId, id: messageId, delivery: "queue" })
      : this.client.session.command({ sessionID: sessionId, name: input.name, text: input.arguments, delivery: "queue" });
    const enqueued = !compacts && this.streaming ? this.awaitEnqueuedUser(sessionId) : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reported = await new Promise<string | undefined>((resolve, reject) => {
        timer = setTimeout(() => resolve(undefined), this.commandAdmissionMs);
        enqueued?.promise.then(resolve);
        // A 204 says the command was accepted, not what its row is called:
        // with a stream listening, the id can still arrive inside the window.
        dispatch.then(() => { if (!enqueued) resolve(undefined); }, reject);
      });
      return { messageId: reported ?? messageId };
    } finally {
      clearTimeout(timer);
      enqueued?.release();
      dispatch.catch(() => undefined);
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.client.session.interrupt({ sessionID: sessionId });
  }

  async replyPermission(sessionId: string, requestId: string, reply: ProviderPermissionReply): Promise<void> {
    await this.client.permission.reply({ sessionID: sessionId, requestID: requestId, decision: reply });
  }

  async listPermissions(): Promise<PendingPermission[]> {
    // The workspace-scoped pending list, with the owning session on each row:
    // filtering is the adapter's job, so a parent can find its children's.
    const { data } = await this.client.permission.request.list(this.scope);
    return data.flatMap(request => {
      if (!request.id || !request.sessionID) return [];
      const fields = pendingPermissionFields(request as Record<string, unknown>);
      return [{ requestId: request.id, conversationId: request.sessionID, ...fields, action: fields.action || "permission" }];
    });
  }

  async listQuestions(): Promise<PendingQuestion[]> {
    // The workspace's pending forms only: an answered or cancelled form
    // leaves this list (verified against 2.0.13), and the list record carries
    // no state — only `form.get` does — so every row here is answerable.
    const { data } = await this.client.form.list(this.scope);
    return data.flatMap(form => {
      if (!form.id || !form.sessionID) return [];
      const presentation = formPresentation(form as Record<string, unknown>);
      return [{
        requestId: form.id,
        conversationId: form.sessionID,
        questions: presentation.questions,
        ...(form.title ? { intro: form.title } : {}),
        ...(presentation.link ? { link: presentation.link } : {}),
      }];
    });
  }

  async replyQuestion(sessionId: string, requestId: string, answers: string[][]): Promise<void> {
    const detail = await this.client.session.form.get({ sessionID: sessionId, formID: requestId });
    // The same filter the questions were built with, so answer i is field i.
    const fields = supportedFormFields(detail.fields);
    // A form with nothing to collect here was shown with one option, to
    // cancel it; that is what its "answer" means.
    if (fields.length === 0) {
      await this.client.session.form.cancel({ sessionID: sessionId, formID: requestId });
      return;
    }
    const answer = formAnswerFromChoices(fields, answers);
    await this.client.session.form.reply({ sessionID: sessionId, formID: requestId, answer });
  }

  async rejectQuestion(sessionId: string, requestId: string): Promise<void> {
    await this.client.session.form.cancel({ sessionID: sessionId, formID: requestId });
  }

  async getReversibleHistoryState(sessionId: string): Promise<ReversibleHistoryState> {
    return (await this.reversibleHistoryContext(sessionId)).state;
  }

  async undo(sessionId: string): Promise<ReversibleHistoryResult> {
    const context = await this.reversibleHistoryContext(sessionId);
    const index = context.boundaryIndex ?? context.turns.length;
    if (!context.turns[index - 1]) return { outcome: "nothing-to-undo", state: context.state };
    return this.stageRevert(sessionId, context, index - 1);
  }

  async redo(sessionId: string): Promise<ReversibleHistoryResult> {
    const context = await this.reversibleHistoryContext(sessionId);
    if (context.boundaryIndex === undefined) return { outcome: "nothing-to-redo", state: context.state };
    return this.restoreThrough(sessionId, context, context.boundaryIndex);
  }

  async revert(sessionId: string, messageId: string): Promise<ReversibleHistoryResult> {
    const context = await this.reversibleHistoryContext(sessionId);
    const index = context.turns.findIndex(turn => turn.id === messageId);
    const visibleEnd = context.boundaryIndex ?? context.turns.length;
    if (index < 0 || index >= visibleEnd) throw new ReversibleHistoryTargetError();
    return this.stageRevert(sessionId, context, index);
  }

  async restore(sessionId: string, messageId: string): Promise<ReversibleHistoryResult> {
    const context = await this.reversibleHistoryContext(sessionId);
    const index = context.turns.findIndex(turn => turn.id === messageId);
    if (context.boundaryIndex === undefined || index < context.boundaryIndex) throw new ReversibleHistoryTargetError();
    return this.restoreThrough(sessionId, context, index);
  }

  private async restoreThrough(sessionId: string, context: ReversibleHistoryContext, index: number): Promise<ReversibleHistoryResult> {
    this.historyReuse.invalidate(sessionId);
    if (context.turns[index + 1]) return this.stageRevert(sessionId, context, index + 1);
    await this.client.session.revert.clear({ sessionID: sessionId });
    return { outcome: "changed", state: reversibleState(context.turns) };
  }

  private async stageRevert(sessionId: string, context: ReversibleHistoryContext, index: number): Promise<ReversibleHistoryResult> {
    this.historyReuse.invalidate(sessionId);
    const target = context.turns[index];
    if (!target) throw new ReversibleHistoryTargetError();
    await this.client.session.revert.stage({ sessionID: sessionId, messageID: target.providerId });
    return { outcome: "changed", state: reversibleState(context.turns, index), restoredDraft: target.draft };
  }

  private async reversibleHistoryContext(sessionId: string): Promise<ReversibleHistoryContext> {
    const messages = await this.allMessages(sessionId);
    const info = await this.lookupSession(sessionId);
    if (!info) throw new Error("OpenCode session disappeared while reading reversible history");
    const turns = messages.flatMap((message): ReversibleTurn[] => {
      try {
        const item = normalizeStoredMessage(message).find(candidate => candidate.type === "user_message");
        if (!item || item.type !== "user_message") return [];
        const providerId = messageIdentity(message);
        if (!providerId) return [];
        return [{
          id: item.id,
          providerId,
          draft: { text: item.text, ...(item.attachments?.length ? { attachments: item.attachments } : {}) },
          summary: item.text.trim() || item.attachments?.map(attachment => attachment.name).join(", ") || "Message",
        }];
      } catch {
        return [];
      }
    });
    const boundaryId = stringValue(asRecord(info.revert).messageID);
    const boundaryIndex = boundaryId ? turns.findIndex(turn => turn.providerId === boundaryId) : undefined;
    const knownBoundary = boundaryIndex !== undefined && boundaryIndex >= 0 ? boundaryIndex : undefined;
    const state = reversibleState(turns, knownBoundary, boundaryId !== undefined);
    return { turns, ...(knownBoundary === undefined ? {} : { boundaryIndex: knownBoundary }), state };
  }

  /**
   * A session by id, or null for one that does not exist or belongs to
   * another directory (the workspace never sees a foreign session). Only a
   * not-found answer is a miss; auth and server failures propagate.
   */
  private async lookupSession(sessionId: string): Promise<SessionRecord | null> {
    let info: SessionRecord;
    try {
      info = await this.client.session.get({ sessionID: sessionId }) as unknown as SessionRecord;
    } catch (error) {
      if (isLookupMiss(error)) return null;
      throw new Error(`OpenCode session lookup failed: ${stringify(error)}`);
    }
    return this.owns(info) ? info : null;
  }

  private owns(info: unknown): boolean {
    const directory = stringValue(asRecord(asRecord(info).location).directory);
    return directory !== undefined && path.resolve(directory) === this.workspace;
  }
}

/**
 * The seam's ordered answers, one list per question, folded back into the
 * form's `{ [key]: value }`. Choices are answered by label and sent by value;
 * a free-form answer is sent as typed; a Yes/No is a boolean; a number is
 * parsed and checked against the field's bounds. An answer the field refuses
 * is an `InvalidQuestionAnswerError`, so the card stays pending.
 */
export function formAnswerFromChoices(fields: Array<Record<string, unknown>>, answers: string[][]): Record<string, string | number | boolean | string[]> {
  const answer: Record<string, string | number | boolean | string[]> = {};
  fields.forEach((field, index) => {
    const key = stringValue(field.key);
    if (!key) return;
    const given = answers[index] ?? [];
    const required = field.required === true;
    const options = asArray(field.options).map(asRecord);
    const valueOf = (label: string): string | undefined => {
      const match = options.find(option => option.label === label || option.value === label);
      return match ? stringValue(match.value) ?? label : undefined;
    };
    const label = stringValue(given[0]);
    switch (field.type) {
      case "multiselect": {
        const values = given.map(item => valueOf(item) ?? (field.custom === true ? item : undefined));
        if (values.some(value => value === undefined)) throw new InvalidQuestionAnswerError(`"${key}" accepts only its listed choices`);
        if (values.length === 0 && required) throw new InvalidQuestionAnswerError(`"${key}" needs at least one choice`);
        if (values.length === 0) return;
        // The form's own cardinality, checked here rather than learned from
        // the server's refusal: the card shows the count, so the reply must
        // hold to it.
        const minItems = typeof field.minItems === "number" ? field.minItems : undefined;
        const maxItems = typeof field.maxItems === "number" ? field.maxItems : undefined;
        if (minItems !== undefined && values.length < minItems) throw new InvalidQuestionAnswerError(`"${key}" needs at least ${minItems} choices`);
        if (maxItems !== undefined && values.length > maxItems) throw new InvalidQuestionAnswerError(`"${key}" accepts at most ${maxItems} choices`);
        answer[key] = values as string[];
        return;
      }
      case "boolean": {
        if (label === undefined) { if (required) throw new InvalidQuestionAnswerError(`"${key}" needs an answer`); return; }
        if (/^(yes|true)$/i.test(label)) answer[key] = true;
        else if (/^(no|false)$/i.test(label)) answer[key] = false;
        else throw new InvalidQuestionAnswerError(`"${key}" is a yes/no question`);
        return;
      }
      case "number":
      case "integer": {
        if (label === undefined || label.trim() === "") { if (required) throw new InvalidQuestionAnswerError(`"${key}" needs a number`); return; }
        const value = Number(label.trim());
        if (!Number.isFinite(value)) throw new InvalidQuestionAnswerError(`"${key}" must be a number`);
        if (field.type === "integer" && !Number.isInteger(value)) throw new InvalidQuestionAnswerError(`"${key}" must be a whole number`);
        const minimum = typeof field.minimum === "number" ? field.minimum : undefined;
        const maximum = typeof field.maximum === "number" ? field.maximum : undefined;
        if (minimum !== undefined && value < minimum) throw new InvalidQuestionAnswerError(`"${key}" must be at least ${minimum}`);
        if (maximum !== undefined && value > maximum) throw new InvalidQuestionAnswerError(`"${key}" must be at most ${maximum}`);
        answer[key] = value;
        return;
      }
      default: {
        if (label === undefined || label === "") { if (required) throw new InvalidQuestionAnswerError(`"${key}" needs an answer`); return; }
        const value = options.length > 0 ? valueOf(label) ?? (field.custom !== false ? label : undefined) : label;
        if (value === undefined) throw new InvalidQuestionAnswerError(`"${key}" accepts only its listed choices`);
        answer[key] = value;
      }
    }
  });
  return answer;
}

function reversibleState(turns: ReversibleTurn[], boundaryIndex?: number, staged = boundaryIndex !== undefined): ReversibleHistoryState {
  return {
    staged,
    canUndo: staged ? boundaryIndex !== undefined && boundaryIndex > 0 : turns.length > 0,
    canRedo: staged && boundaryIndex !== undefined,
    revertedMessages: boundaryIndex === undefined ? [] : turns.slice(boundaryIndex).map(turn => ({ id: turn.id, text: turn.summary })),
  };
}

const CATALOG_ATTEMPTS = 8;
const CATALOG_RETRY_MS = 250;

const BUILTIN_COMMANDS: ChatCommand[] = [
  { name: "compact", description: "Compact the conversation context", argumentHint: "", kind: "command" },
];

// The 2.x server answers a missing session with a tagged error (`_tag`
// naming the not-found case, `message` "Session not found: …"); anything
// else — expired auth, a restarting server, a transport failure — is a
// provider failure.
function isLookupMiss(error: unknown): boolean {
  const record = asRecord(error);
  const tag = stringValue(record._tag);
  if (tag && /notfound/i.test(tag)) return true;
  const message = error instanceof Error ? error.message : stringValue(record.message);
  return message !== undefined && /\bnot found\b/i.test(message);
}

function toSession(info: unknown): ProviderSession {
  const session = asRecord(info);
  const time = asRecord(session.time);
  const parentId = stringValue(session.parentID);
  return {
    id: String(session.id),
    title: stringValue(session.title) ?? "",
    directory: stringValue(asRecord(session.location).directory) ?? "",
    createdAt: typeof time.created === "number" ? time.created : 0,
    updatedAt: typeof time.updated === "number" ? time.updated : 0,
    ...(parentId ? { parentId } : {}),
  };
}

function messageIdentity(value: unknown): string {
  return stringValue(asRecord(value).id) ?? "";
}

function messageCreatedAt(value: unknown): number {
  const created = asRecord(asRecord(value).time).created;
  return typeof created === "number" && Number.isFinite(created) ? created : 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringify(value: unknown): string {
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
