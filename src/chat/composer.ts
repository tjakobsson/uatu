import { boundedSet } from "../shared/bounded-map";
import { ChatTransportError, ChatConnectionInterruptedError, STEER_ALREADY_DELIVERED_CODE, STEER_WITHDRAWAL_UNCONFIRMED_CODE } from "./client";
import type { ChatApiClient } from "./client";
import { AutomaticBackgroundNotices, actionOrigin, automaticBackgroundNote } from "./automatic-background";
import { newRequestId } from "./ids";
import { addAcceptedDraft, confirmAcceptedDraft, dropQueuedMessage, markDraftUnconfirmed, noteQueuedMessage, projectionFromSnapshot, removeAcceptedDraft, type ChatProjection } from "./projection";
import { localHistoryOperation, parsePromptSlashCommand, sideQuestionOperation } from "./slash-commands";
import { CHAT_ATTACHMENT_MAX_BYTES, CHAT_ATTACHMENT_MIME_TYPES, CHAT_ATTACHMENTS_PER_MESSAGE, isLiveConversationStatus } from "./types";
import type { AutomaticBackgroundFeedback, ChatCapability, ChatCommand, ChatEvent, ConversationConfiguration, ConversationSnapshot, MessageAttachment, MessageDelivery, QueuedMessage, ReversibleHistoryResult } from "./types";

export type PendingAttachment = MessageAttachment & { id: string; previewUrl: string };
export type PendingAction = "remove" | "edit" | "queue" | "steer" | "send-now" | "discard";
export type HistoryOperation = "undo" | "redo" | "revert" | "restore";
export type PendingQueueAction = { terminal?: boolean };
const TOO_LATE = "Too late — already delivered";
const messageOf = (error: unknown) => error instanceof Error ? error.message : "Chat failed";

/** Projection stays with its existing owner. These operations run synchronously;
 * committed events must be observed before any awaiting mutation can settle. */
export interface ComposerConversation {
  selected(): string | null;
  read(): ChatProjection | null;
  write(projection: ChatProjection): void;
  epoch(): number;
  cancelling(): boolean;
  declares(capability: ChatCapability): boolean;
  commands(): ChatCommand[];
  commandsAvailable(): boolean;
  reloadCommands(): Promise<boolean>;
  agentId(): string | undefined;
  refreshCommands(agentId: string): void;
  configuration(): { value: ConversationConfiguration; stage: unknown };
  consumeConfiguration(id: string, stage: unknown): void;
  imageSupport(): { supported: true } | { supported: false; modelName: string };
  refresh(id: string, pending?: { id: string; action: PendingQueueAction }): Promise<boolean>;
}

/** Storage adapter owns persistence and the visible textarea, never capture or
 * restoration policy. Writes to another conversation must not touch its field. */
export interface ComposerDrafts {
  read(id: string): string;
  write(id: string, text: string): void;
}

export type ComposerChange = "state" | "attachments" | "pending" | "projection" | "accepted" | "restored" | "draft" | "submit" | "edit" | "history";
export interface ComposerPresentation {
  changed(change: ComposerChange, id?: string): void;
  error(message: string | null, id?: string): void;
  note(message: string | null, error?: boolean): void;
  announce(message: string, error?: boolean): void;
  accepted(result: Awaited<ReturnType<ChatApiClient["prompt"]>>): void;
  heldByHold(): void;
}

/** An operation-owned, one-shot confirmation. Presentation owns showing or
 * cancelling it. False means stale/refused, so presentation must not report
 * completion or restore focus as if the mutation succeeded. */
export type ComposerConfirmation = { title: string; explanation: string; acceptLabel: string; confirm(): Promise<boolean> };
type Resources = { create(file: File): string; release(url: string): void; id(): string };
export type ComposerTransport = Pick<ChatApiClient, "prompt" | "uploadAttachment" | "attachmentUrl" | "generate" | "removeQueued" | "changeDelivery" | "sendNow" | "discardUnconfirmedSteer" | "undo" | "redo" | "revert" | "restore">;

/** Browser-facing composer. Workflows below are private, not caller closures.
 * No teardown on pagehide: that event does not end the document lifetime. */
export class Composer {
  // Only browser-owned resources and operation evidence live here. Queue,
  // timeline, configuration revisions and history truth remain in the projection.
  private readonly attachments = new Map<string, PendingAttachment[]>();
  private readonly unavailable = new Map<string, MessageAttachment[]>();
  private readonly staging = new Map<string, Promise<void>>();
  private readonly generations = new Map<string, number>();
  private readonly reserves = new Map<string, number>();
  private readonly refusals = new Map<string, number>();
  private readonly retries = new Map<string, { text: string; requestId: string; attachments: string }>();
  private readonly withdrawals = new Map<string, Map<string, { operation: string; entry: QueuedMessage }>>();
  private readonly actions = new Map<string, Map<string, PendingQueueAction>>();
  private readonly unknown = new Map<string, ChatProjection["acceptedDrafts"]>();
  private readonly notices = new AutomaticBackgroundNotices();
  private readonly answers = new Map<string, { question: string; text: string; failed?: boolean }>();
  private readonly generating = new Set<string>();
  private readonly histories = new Set<string>();
  private readonly historyResyncs = new Set<string>();
  private readonly historyRefresh = new Set<string>();
  private readonly historyRetries = new Map<string, { operation: HistoryOperation; messageId?: string; requestId: string; result?: ReversibleHistoryResult }>();
  // A held /reload refreshes its owning agent's catalogs only when its own
  // turn completes. An early completion before acceptance conservatively
  // refreshes without retiring the still-unnamed operation.
  private readonly reloads = new Map<string, Array<{ agentId: string; messageId?: string }>>();
  private readonly previews = new Set<string>();
  private busy = false;
  private disposed = false;

  constructor(private readonly conversation: ComposerConversation, private readonly transport: ComposerTransport,
    private readonly drafts: ComposerDrafts, private readonly presentation: ComposerPresentation,
    private readonly resources: Resources = { create: file => URL.createObjectURL(file), release: url => URL.revokeObjectURL(url), id: newRequestId }) {}

  get submitting(): boolean { return this.busy; }
  edit(text: string): void { const id = this.conversation.selected(); if (id) this.drafts.write(id, text); }
  pendingAttachments(id = this.conversation.selected()): readonly PendingAttachment[] { return id ? this.attachments.get(id) ?? [] : []; }
  unavailableAttachments(id = this.conversation.selected()): readonly MessageAttachment[] { return id ? this.unavailable.get(id) ?? [] : []; }
  uploading(id: string): boolean { return this.staging.has(id); }
  withdrawalRetries(id: string): Pick<ReadonlySet<string>, "has"> | undefined { return this.withdrawals.get(id); }
  pendingActions(id: string): Pick<ReadonlySet<string>, "has"> | undefined { return this.actions.get(id); }
  feedback(id: string): string { return this.notices.text(id); }
  sideAnswer(id: string) { return this.answers.get(id); }
  sideGenerating(id: string): boolean { return this.generating.has(id); }
  historyBusy(id: string): boolean { return this.histories.has(id); }
  needsHistoryRefresh(id: string): boolean { return this.historyRefresh.has(id); }
  historyResync(id: string): boolean { if (!this.histories.has(id)) return false; this.historyResyncs.add(id); return true; }
  acceptedDrafts(id: string) { return [...(this.unknown.get(id) ?? [])]; }
  acceptSnapshot(snapshot: ConversationSnapshot, acceptedDrafts: ChatProjection["acceptedDrafts"]): ChatProjection {
    const current = this.protect(projectionFromSnapshot(snapshot, acceptedDrafts));
    const unknown = current.acceptedDrafts.filter(draft => draft.unconfirmed);
    if (unknown.length) boundedSet(this.unknown, current.conversationId, unknown.slice(-20), 100);
    else this.unknown.delete(current.conversationId);
    this.historyRefresh.delete(current.conversationId);
    return current;
  }
  /** Called only after the projection owner classified the event. The module
   * consumes positive settlement evidence, never infers it from queue absence. */
  observe(event: ChatEvent, applied: boolean): void {
    if (event.type === "conversation.status") this.statusChanged(event.conversationId, event.status);
    if (!applied) return;
    if (event.type === "conversation.queue" && (event.change.kind === "removed" || event.change.kind === "delivered")) this.terminal(event.conversationId, event.change.messageId);
    if (event.type === "conversation.queue" || event.type === "item.upsert") this.update(event.conversationId, current => this.protect(current));
  }
  checkedSnapshot(id: string, snapshot: ConversationSnapshot, pending?: { id: string; action: PendingQueueAction }): ConversationSnapshot {
    if (!pending) return snapshot;
    if (snapshot.conversation.id !== id || !Array.isArray(snapshot.queued)) throw new Error("Pending status check did not include the conversation queue.");
    return pending.action.terminal ? { ...snapshot, queued: snapshot.queued.filter(entry => entry.id !== pending.id) } : snapshot;
  }
  private terminal(id: string, messageId: string): void {
    const action = this.actions.get(id)?.get(messageId);
    if (action) action.terminal = true;
    const entries = this.withdrawals.get(id);
    const notice = entries?.get(messageId);
    if (notice) this.notices.record(id, notice.operation, "not-needed");
    entries?.delete(messageId);
    if (!entries?.size) this.withdrawals.delete(id);
  }
  private statusChanged(id: string, status: ChatProjection["status"]): void {
    const reloads = this.reloads.get(id);
    if (!reloads || status !== "completed" && status !== "failed" && status !== "interrupted") return;
    const queued = new Set(this.conversation.read()?.queued.map(entry => entry.id));
    const index = reloads.findIndex(entry => entry.messageId === undefined || !queued.has(entry.messageId));
    const reload = reloads[index];
    if (!reload) return;
    if (reload.messageId !== undefined) reloads.splice(index, 1);
    if (!reloads.length) this.reloads.delete(id);
    if (status === "completed") this.conversation.refreshCommands(reload.agentId);
  }
  private converted(current: ChatProjection, entry: QueuedMessage): boolean {
    return !!entry.submissionId && !current.queued.some(candidate => candidate.id === entry.id)
      && current.queued.some(candidate => candidate.submissionId === entry.submissionId && candidate.delivery === "queue" && !candidate.unconfirmed);
  }
  private protect(current: ChatProjection): ChatProjection {
    const withdrawals = this.withdrawals.get(current.conversationId);
    if (!withdrawals) return current;
    const queued = [...current.queued];
    for (const [id, notice] of withdrawals) {
      if (current.items.some(item => item.id === `message:${id}`) || this.converted(current, notice.entry)) this.terminal(current.conversationId, id);
      else if (!queued.some(entry => entry.id === id)) queued.push(notice.entry);
    }
    return { ...current, queued: queued.map(entry => withdrawals.has(entry.id) ? { ...entry, unconfirmed: true as const } : entry) };
  }
  private update(id: string, update: (current: ChatProjection) => ChatProjection): void {
    const current = this.conversation.read();
    if (current?.conversationId === id) this.conversation.write(update(current));
  }
  private changed(change: ComposerChange = "state", id?: string): void { if (!this.disposed) this.presentation.changed(change, id); }
  private putAttachments(id: string, entries: PendingAttachment[]): void { if (entries.length) this.attachments.set(id, entries); else this.attachments.delete(id); }
  private putUnavailable(id: string, entries: MessageAttachment[]): void { if (entries.length) this.unavailable.set(id, entries); else this.unavailable.delete(id); }
  noteAttachmentRefusal(id: string, count = 1): void { if (count > 0) this.refusals.set(id, (this.refusals.get(id) ?? 0) + count); }
  removeAttachment(entry: MessageAttachment): void {
    const id = this.conversation.selected(); if (!id) return;
    const available = this.attachments.get(id) ?? [];
    if (available.includes(entry as PendingAttachment)) {
      this.release((entry as PendingAttachment).previewUrl);
      this.putAttachments(id, available.filter(candidate => candidate !== entry));
    } else this.putUnavailable(id, (this.unavailable.get(id) ?? []).filter(candidate => candidate !== entry));
    this.changed("attachments");
  }
  private release(url: string): void { if (this.previews.delete(url)) this.resources.release(url); }
  async attach(files: readonly File[]): Promise<void> {
    const id = this.conversation.selected();
    if (!id || !files.length || !this.conversation.declares("attachments") || this.disposed) return;
    const support = this.conversation.imageSupport();
    if (!support.supported) { this.presentation.error(`${support.modelName} cannot see images. Pick a model with image support to attach.`); return; }
    const generation = this.generations.get(id) ?? 0;
    const task = (this.staging.get(id) ?? Promise.resolve()).then(async () => {
      for (const file of files) {
        if (this.disposed || (this.generations.get(id) ?? 0) !== generation) return;
        if ((this.attachments.get(id)?.length ?? 0) + (this.reserves.get(id) ?? 0) >= CHAT_ATTACHMENTS_PER_MESSAGE) {
          this.presentation.error(`A message can carry at most ${CHAT_ATTACHMENTS_PER_MESSAGE} images.`, id); this.noteAttachmentRefusal(id); break;
        }
        let refusal: string | undefined;
        if (file.type && !(CHAT_ATTACHMENT_MIME_TYPES as readonly string[]).includes(file.type.toLowerCase())) refusal = `${file.name || "That file"} is not a supported image (PNG, JPEG, GIF, WebP).`;
        else if (file.size > CHAT_ATTACHMENT_MAX_BYTES) refusal = `${file.name || "That image"} is larger than the ${Math.round(CHAT_ATTACHMENT_MAX_BYTES / (1024 * 1024))} MiB limit.`;
        if (refusal) { this.presentation.error(refusal, id); this.noteAttachmentRefusal(id); continue; }
        try {
          const stored = await this.transport.uploadAttachment(id, file);
          if (this.disposed || (this.generations.get(id) ?? 0) !== generation) return;
          let name = file.name.trim() ? file.name : "image";
          while (new TextEncoder().encode(name).length > 200) name = name.slice(0, -1);
          if (/[\uD800-\uDBFF]$/.test(name)) name = name.slice(0, -1);
          const previewUrl = this.resources.create(file);
          this.previews.add(previewUrl);
          this.putAttachments(id, [...this.pendingAttachments(id), { id: stored.id, name: name || "image", mimeType: stored.mimeType, previewUrl }]);
        } catch (error) { this.presentation.error(`Could not attach ${file.name || "image"}: ${messageOf(error)}`, id); this.noteAttachmentRefusal(id); }
      }
    });
    this.staging.set(id, task); this.changed();
    try { await task; } finally { if (this.staging.get(id) === task) this.staging.delete(id); }
    this.changed("attachments");
  }
  private merge(id: string, text: string): void {
    if (!text.trim()) return;
    const newer = this.drafts.read(id);
    this.drafts.write(id, newer.trim() ? `${text}\n${newer}` : text);
  }
  private recordBackground(id: string, operation: string, result: AutomaticBackgroundFeedback, action: string, text: string): void {
    if (result.automaticBackground === "unknown") { void this.checkUnknown(id, operation, action, text, "automatic backgrounding"); return; }
    if (result.automaticBackground && result.automaticBackground !== "accepted" && result.automaticBackground !== "not-needed") this.notices.unconfirmed(id, operation, `${actionOrigin(action, text)}: ${automaticBackgroundNote(result.automaticBackground)}`);
    else this.notices.record(id, operation, result.automaticBackground);
    this.changed();
  }
  private async checkUnknown(id: string, operation: string, action: string, text: string, subject = "acceptance"): Promise<void> {
    this.notices.unconfirmed(id, operation, action, text, subject); this.changed();
    const available = await this.conversation.refresh(id);
    this.notices.checked(id, operation, available); this.changed();
  }
  async submit(options: { delivery?: MessageDelivery; byHold?: boolean } = {}): Promise<void> {
    const current = this.conversation.read();
    if (!current) { this.presentation.note("Conversation history is not loaded. Nothing was sent; your draft was kept. Use Retry read or select another conversation.", true); return; }
    if (this.busy || this.conversation.cancelling() || this.disposed) return;
    const id = current.conversationId, text = this.drafts.read(id);
    const side = sideQuestionOperation(text);
    if (side) { await this.askSide(id, text, side.question); return; }
    const history = localHistoryOperation(text, this.conversation.commands(), this.conversation.declares("reversible-history"));
    if (history) {
      if (!this.conversation.commandsAvailable()) {
        this.busy = true; this.presentation.note("Reloading commands..."); this.changed();
        const loaded = await this.conversation.reloadCommands(); this.busy = false;
        if (!loaded) { const message = `Chat commands could not be loaded. Submit /${history} again to retry; the command and attachments were kept.`; this.presentation.error(message, id); this.presentation.note(this.conversation.selected() === id ? message : null); this.changed(); return; }
        if (this.conversation.selected() !== id) { this.changed(); return; }
      }
      await this.history(history, id); return;
    }
    if (!text.trim() && !this.pendingAttachments(id).length && !this.staging.has(id)) return;
    await this.send(id, text, options);
  }
  private async send(id: string, text: string, options: { delivery?: MessageDelivery; byHold?: boolean }): Promise<void> {
    const refusals = this.refusals.get(id) ?? 0;
    // Clear before any yield: edits while uploads drain belong to the next draft.
    this.busy = true; this.presentation.error(null); this.drafts.write(id, ""); this.changed("draft", id);
    try {
      let tail = this.staging.get(id);
      if (tail) {
        this.presentation.note("Uploading images...");
        while (tail) { await tail.catch(() => undefined); const next = this.staging.get(id); tail = next === tail ? undefined : next; }
        if (this.disposed) return;
        if (this.conversation.read()?.conversationId !== id) { this.merge(id, text); return; }
      }
      if ((this.refusals.get(id) ?? 0) !== refusals) { this.merge(id, text); this.presentation.note("Message not sent; draft kept"); return; }
      if (!text.trim() && !this.pendingAttachments(id).length) { if (!this.drafts.read(id).trim() && text) this.drafts.write(id, text); return; }
      const support = this.conversation.imageSupport();
      if (!support.supported && this.pendingAttachments(id).length) { this.merge(id, text); this.presentation.error(`${support.modelName} cannot see images. Remove them or pick a model with image support.`); return; }
      await this.dispatch(id, text, options);
    } finally { this.busy = false; this.changed(); }
  }
  private async dispatch(id: string, text: string, options: { delivery?: MessageDelivery; byHold?: boolean }): Promise<void> {
    const staged = [...this.pendingAttachments(id)], missing = [...this.unavailableAttachments(id)];
    const refs = staged.map(({ id, name, mimeType }) => ({ id, name, mimeType }));
    // Captured attachments still consume draft capacity until accepted or
    // restored; otherwise intake during a refusal could create an unsendable draft.
    this.reserves.set(id, (this.reserves.get(id) ?? 0) + staged.length);
    const releaseReserve = () => { const count = (this.reserves.get(id) ?? 0) - staged.length; if (count > 0) this.reserves.set(id, count); else this.reserves.delete(id); };
    const key = staged.map(entry => entry.id).join("\n"), retry = this.retries.get(id);
    const retried = retry?.text === text && retry.attachments === key;
    const requestId = retried ? retry!.requestId : this.resources.id();
    const { value: configuration, stage } = this.conversation.configuration();
    const current = this.conversation.read()!;
    const epoch = this.conversation.epoch(), queueRevision = current.queueRevision, configurationRevision = current.configurationRevision;
    const delivery = this.conversation.declares("steering") ? refs.length ? "queue" : options.delivery ?? "steer" : undefined;
    const nativeSteer = this.conversation.declares("steering") && !parsePromptSlashCommand(text, this.conversation.commands()) && (current.reversibleHistory?.staged === true || delivery === "steer" && (isLiveConversationStatus(current.status) || current.queued.length > 0));
    this.update(id, p => addAcceptedDraft(p, { requestId, messageId: `pending:${requestId}`, text, ...(refs.length ? { attachments: refs } : {}) }));
    this.putAttachments(id, []); this.putUnavailable(id, []); this.presentation.note("Sending..."); this.changed("submit", id);
    const agentId = this.conversation.agentId();
    const reload = agentId && /^\/reload(?:\s|$)/.test(text.trim()) ? { agentId } as { agentId: string; messageId?: string } : undefined;
    if (reload) this.reloads.set(id, [...(this.reloads.get(id) ?? []), reload]);
    const retireReload = () => {
      if (!reload) return;
      const rest = (this.reloads.get(id) ?? []).filter(entry => entry !== reload);
      if (rest.length) this.reloads.set(id, rest); else this.reloads.delete(id);
    };
    try {
      const accepted = await this.transport.prompt(id, requestId, text, configuration.model, configuration.mode, configuration.variant, refs.length ? refs : undefined, delivery);
      if (this.disposed) return;
      if (reload) { reload.messageId = accepted.messageId; if (!accepted.pending && accepted.operation !== "reload") retireReload(); }
      this.retries.delete(id);
      if (accepted.delivery !== "steer") this.conversation.consumeConfiguration(id, stage);
      this.presentation.accepted(accepted);
      this.update(id, p => {
        if (accepted.delivery !== "steer" && !retried && this.conversation.epoch() === epoch && p.configurationRevision === configurationRevision) p = { ...p, configuration: accepted.configuration };
        // Receipts bridge only a fresh acceptance. Streamed queue/configuration
        // evidence or a replacement projection outranks that local bridge.
        return accepted.pending
          ? !retried && this.conversation.epoch() === epoch ? noteQueuedMessage(p, { id: accepted.messageId, text, queuedAt: Date.now(), delivery: accepted.delivery, requestId, ...(refs.length ? { attachments: refs } : {}) }, queueRevision) : removeAcceptedDraft(p, requestId)
          : confirmAcceptedDraft(p, { requestId, messageId: accepted.messageId, text, ...(refs.length ? { attachments: refs } : {}) }, { insert: accepted.operation !== "reload" });
      });
      this.changed("accepted", id);
      this.presentation.note(null);
      if (options.byHold && accepted.pending && accepted.delivery === "queue") this.presentation.heldByHold();
      this.recordBackground(id, requestId, accepted, "Steer", text); this.presentation.error(null, id);
      for (const entry of staged) this.release(entry.previewUrl);
    } catch (error) {
      if (this.disposed) return;
      retireReload();
      const unknown = error instanceof ChatTransportError && error.code === "operation_outcome_unknown" || nativeSteer && (error instanceof ChatConnectionInterruptedError || error instanceof ChatTransportError && (error.status === undefined || error.status >= 500));
      if (unknown) {
        // The operation may have applied. Retain original identity and refs as
        // uncertain input, not a restored draft that invites another submission.
        this.retries.delete(id);
        const draft = { requestId, messageId: `pending:${requestId}`, text, ...(refs.length ? { attachments: refs } : {}), unconfirmed: true as const };
        const retained = [...(this.unknown.get(id) ?? []).filter(entry => entry.requestId !== requestId), draft].slice(-20);
        boundedSet(this.unknown, id, retained, 100);
        this.update(id, p => { p = markDraftUnconfirmed(p, requestId); const ids = new Set(retained.map(entry => entry.requestId)); return { ...p, acceptedDrafts: p.acceptedDrafts.filter(entry => !entry.unconfirmed || ids.has(entry.requestId)) }; });
        this.changed("projection", id);
        for (const entry of staged) this.release(entry.previewUrl);
        void this.checkUnknown(id, requestId, `Steer (${requestId})`, text);
      } else {
        const message = messageOf(error); this.presentation.announce(message, true);
        this.retries.set(id, { text, requestId, attachments: key });
        this.putAttachments(id, [...staged, ...this.pendingAttachments(id)]); this.putUnavailable(id, [...missing, ...this.unavailableAttachments(id)]);
        this.update(id, p => removeAcceptedDraft(p, requestId)); this.merge(id, text);
        this.changed("restored", id);
        this.presentation.error(`${message}. Draft restored.`, id); this.presentation.note("Message not accepted; draft restored");
      }
    } finally { releaseReserve(); }
  }

  private async askSide(id: string, captured: string, question: string): Promise<void> {
    if (!this.conversation.declares("side-generation")) { this.presentation.error("/btw side answers are not supported by this agent. Nothing was sent."); return; }
    if (!question) { this.presentation.error("Add a side question after /btw. Nothing was sent."); return; }
    if (this.pendingAttachments(id).length || this.staging.has(id)) { this.presentation.error("/btw uses existing conversation context only. Remove pending images before asking a side question."); return; }
    if (this.generating.has(id)) { this.presentation.error("A side answer is already in progress for this conversation."); return; }
    this.generating.add(id); this.drafts.write(id, ""); this.presentation.error(null); this.changed("draft", id);
    try { const answer = await this.transport.generate(id, this.resources.id(), question); if (!this.disposed) boundedSet(this.answers, id, { question, text: answer.text }, 200); }
    catch (error) {
      if (this.disposed) return;
      const failure = `Side answer failed: ${messageOf(error)}. No conversation message was sent. No automatic retry was made.`;
      boundedSet(this.answers, id, { question, text: failure, failed: true }, 200);
      this.drafts.write(id, this.drafts.read(id) || captured); this.presentation.error(failure, id);
    } finally { this.generating.delete(id); this.changed(); }
  }

  /** Confirmation questions are synchronous, preserving native dialog activation.
   * A direct action acquires its lock synchronously and settles asynchronously. */
  pending(messageId: string, action: PendingAction): ComposerConfirmation | Promise<void> | undefined {
    const current = this.conversation.read(); if (!current || this.disposed) return;
    const id = current.conversationId, entry = current.queued.find(entry => entry.id === messageId);
    if (!entry || !this.eligible(id, entry, action)) return;
    const token = entry.admissionUncertaintyId;
    const paused = current.queued.filter(entry => entry.delivery === "steer" && entry.paused).length;
    const question = action === "discard" ? { title: "Discard local record?", explanation: "Delivery of this message is unconfirmed. Removing Uatu’s local record does not cancel or resend it; the original may still arrive. Other messages will stay queued until you choose Send now or submit a new message, or a later normal idle transition occurs.", acceptLabel: "Discard local record" }
      : (action === "send-now" || action === "steer") && entry.delivery === "queue" && paused ? { title: "Send queued message now?", explanation: `This also sends all ${paused} paused steer${paused === 1 ? "" : "s"}. Other queued messages stay held.`, acceptLabel: "Send now" } : undefined;
    if (question) {
      let consumed = false;
      return { ...question, confirm: async () => {
        if (consumed) return false; consumed = true;
        const now = this.conversation.read();
        const currentEntry = now?.conversationId === id ? now.queued.find(candidate => candidate.id === messageId) : undefined;
        if (this.disposed || !currentEntry || !this.eligible(id, currentEntry, action) || action === "discard" && currentEntry.admissionUncertaintyId !== token) return false;
        return this.runPending(id, entry, action);
      } };
    }
    return this.runPending(id, entry, action).then(() => undefined);
  }
  private eligible(id: string, entry: QueuedMessage, action: PendingAction): boolean {
    if (this.actions.get(id)?.has(entry.id)) return false;
    const withdrawal = this.withdrawals.get(id)?.has(entry.id);
    if (action === "discard") return entry.unconfirmed === true && !!entry.admissionUncertaintyId && !withdrawal;
    return !(entry.unconfirmed || withdrawal) || action === "remove" && !!withdrawal;
  }
  private async runPending(id: string, entry: QueuedMessage, action: PendingAction): Promise<boolean> {
    const messageId = entry.id, withdrawalUnknown = this.withdrawals.get(id)?.has(messageId);
    // Classify the initiating operation before presentation callbacks or transport
    // can switch the selected conversation and its advertised capabilities.
    const uncertainty = entry.delivery === "steer" && (action === "remove" || action === "edit" || action === "queue") ? "withdrawal"
      : this.conversation.declares("steering") && (action === "steer" || action === "send-now") ? "steer" : undefined;
    // A terminal fence belongs to this outstanding action. Never evict it or
    // replace it with a historical cache while its transport/read is pending.
    const inFlight = this.actions.get(id) ?? new Map<string, PendingQueueAction>(), pending: PendingQueueAction = {};
    inFlight.set(messageId, pending); this.actions.set(id, inFlight); this.changed("pending", id);
    const operation = this.resources.id();
    const label = action === "steer" ? "Queue → Steer" : action === "send-now" ? "Send now" : action === "queue" ? "Steer → Queue" : action === "edit" ? "Edit pending message" : "Remove pending message";
    try {
      if (action === "discard") {
        await this.transport.discardUnconfirmedSteer(id, messageId, operation, entry.admissionUncertaintyId!);
        if (this.disposed) return false;
        this.notices.unconfirmed(id, `discard:${operation}`, `Delivery remains unconfirmed; the original may still arrive. ${actionOrigin("Local record discarded", entry.text)}. Discard did not cancel or resend it. Other messages were left queued.`);
        this.update(id, p => { const remaining = p.queued.find(candidate => candidate.id === messageId); return remaining && remaining.admissionUncertaintyId === entry.admissionUncertaintyId && this.eligibleDiscard(id, remaining) ? dropQueuedMessage(p, messageId) : p; });
        return true;
      }
      const result = action === "remove" || action === "edit" ? await this.transport.removeQueued(id, messageId, operation)
        : action === "queue" || action === "steer" ? await this.transport.changeDelivery(id, messageId, operation, action) : await this.transport.sendNow(id, messageId, operation);
      if (this.disposed) return false;
      if (action === "edit") {
        if (this.withdrawals.get(id)?.has(messageId)) throw new ChatTransportError("Withdrawal is still unconfirmed", 409, STEER_WITHDRAWAL_UNCONFIRMED_CODE);
        this.loadPending(id, entry);
      }
      if (action === "remove" && withdrawalUnknown && "removed" in result && result.removed === true) { this.terminal(id, messageId); this.update(id, p => dropQueuedMessage(p, messageId)); }
      this.recordBackground(id, operation, result as AutomaticBackgroundFeedback, action === "steer" || action === "send-now" ? label : "Pending action", entry.text);
      if (this.conversation.selected() === id) this.presentation.note(null);
      return true;
    } catch (error) {
      if (this.disposed) return false;
      if (action === "discard") { await this.conversation.refresh(id); if (this.conversation.selected() === id) this.presentation.announce(`${messageOf(error)} Delivery remains unconfirmed; no message was cancelled or resent.`, true); }
      else await this.pendingFailed(error, id, entry, uncertainty, operation, label, pending);
      return false;
    } finally { inFlight.delete(messageId); if (!inFlight.size) this.actions.delete(id); this.changed("pending", id); }
  }
  private eligibleDiscard(id: string, entry: QueuedMessage): boolean { return entry.unconfirmed === true && !!entry.admissionUncertaintyId && !this.withdrawals.get(id)?.has(entry.id); }
  private convertStoredAttachments(attachments: readonly MessageAttachment[]) {
    const available: PendingAttachment[] = [], unavailable: MessageAttachment[] = [];
    for (const attachment of attachments) {
      if (attachment.id) available.push({ ...attachment, id: attachment.id, previewUrl: this.transport.attachmentUrl(attachment.id) }); else unavailable.push(attachment);
    }
    // Authenticated stored URLs are borrowed, never added to owned blob previews.
    return { available, unavailable };
  }
  private loadPending(id: string, entry: QueuedMessage): void {
    const { available, unavailable } = this.convertStoredAttachments(entry.attachments ?? []);
    this.putAttachments(id, [...this.pendingAttachments(id), ...available]); this.putUnavailable(id, [...this.unavailableAttachments(id), ...unavailable]);
    if (entry.text) { const newer = this.drafts.read(id); this.drafts.write(id, newer.trim() ? `${entry.text}\n${newer}` : entry.text); }
    this.changed("edit", id);
  }
  private async pendingFailed(error: unknown, id: string, entry: QueuedMessage, uncertainty: "withdrawal" | "steer" | undefined, operation: string, label: string, pending: PendingQueueAction): Promise<void> {
    const withdrawal = uncertainty === "withdrawal", steer = uncertainty === "steer";
    if (error instanceof ChatTransportError && (error.code === STEER_WITHDRAWAL_UNCONFIRMED_CODE || withdrawal && (error.status === undefined || error.status >= 500 || error.code === "operation_outcome_unknown"))) {
      if (pending.terminal || this.conversation.read()?.conversationId === id && this.converted(this.conversation.read()!, entry)) return;
      const entries = this.withdrawals.get(id) ?? new Map<string, { operation: string; entry: QueuedMessage }>();
      const previous = entries.get(entry.id); if (previous) this.notices.record(id, previous.operation, "not-needed");
      boundedSet(entries, entry.id, { operation, entry }, 20); boundedSet(this.withdrawals, id, entries, 100);
      this.update(id, p => ({ ...p, queued: p.queued.map(candidate => candidate.id === entry.id ? { ...candidate, unconfirmed: true as const } : candidate) }));
      await this.checkUnknown(id, operation, label, entry.text, "withdrawal"); return;
    }
    if (error instanceof ChatTransportError && (error.code === "operation_outcome_unknown" || steer && (error.status === undefined || error.status >= 500)) || error instanceof ChatConnectionInterruptedError) { await this.checkUnknown(id, operation, label, entry.text); return; }
    if (error instanceof ChatTransportError && error.status === 409) {
      if (error.code === STEER_ALREADY_DELIVERED_CODE) { this.terminal(id, entry.id); this.update(id, p => this.protect(dropQueuedMessage(p, entry.id))); this.presentation.error(TOO_LATE, id); if (this.conversation.selected() === id) this.presentation.note(TOO_LATE); return; }
      if (pending.terminal) return;
      const available = await this.conversation.refresh(id, { id: entry.id, action: pending });
      const message = `${messageOf(error)}${available ? "" : " Pending status could not be checked; no message was resent."}`;
      this.presentation.error(message, id); if (this.conversation.selected() === id) this.presentation.announce(message, true); return;
    }
    if (this.conversation.selected() === id) this.presentation.announce(messageOf(error), true);
  }

  async history(operation: HistoryOperation, id: string, messageId?: string): Promise<void> {
    if (this.busy || this.disposed) return;
    const label = operation[0]!.toUpperCase() + operation.slice(1);
    this.busy = true; this.histories.add(id); this.presentation.error(null, id);
    this.presentation.note(operation === "restore" ? "Restoring..." : `${label}ing...`); this.changed("draft", id);
    const instruction = operation === "undo" || operation === "redo" ? `Submit /${operation} again` : `Choose ${label} message again`;
    const preserved = operation === "undo" || operation === "redo" ? "command and attachments" : "composer and attachments";
    try {
      const pending = this.historyRetries.get(id);
      if (pending?.result && pending.operation === operation && pending.messageId === messageId) { await this.installHistory(operation, id, pending.result); return; }
      if (this.historyRefresh.has(id) && !await this.conversation.refresh(id)) {
        const message = `The conversation could not be refreshed. ${instruction} to retry; the ${preserved} were kept.`;
        this.presentation.error(message, id); this.presentation.note(message); return;
      }
      const retry = pending?.operation === operation && pending.messageId === messageId ? pending : { operation, ...(messageId ? { messageId } : {}), requestId: this.resources.id(), result: undefined as ReversibleHistoryResult | undefined };
      this.historyRetries.set(id, retry);
      const result = operation === "undo" || operation === "redo" ? await this.transport[operation](id, retry.requestId) : await this.transport[operation](id, messageId!, retry.requestId);
      if (this.disposed) return;
      if (result.outcome !== "changed") {
        this.historyRetries.delete(id);
        if (this.historyResyncs.delete(id) && !await this.conversation.refresh(id) && this.conversation.selected() === id) {
          this.historyRefresh.add(id); const message = `${result.outcome === "nothing-to-undo" ? "Nothing more to undo" : "Nothing to redo"}, but the conversation could not be refreshed. Submit /${operation} again to reconnect.`;
          this.presentation.error(message, id); this.presentation.note(message); return;
        }
        this.presentation.note(this.conversation.selected() === id ? result.outcome === "nothing-to-undo" ? "Nothing more to undo" : "Nothing to redo" : null); return;
      }
      retry.result = result; await this.installHistory(operation, id, result);
    } catch (error) {
      if (this.disposed) return;
      let message = `${label} failed: ${messageOf(error)}. ${preserved[0]!.toUpperCase()}${preserved.slice(1)} kept.`;
      if (this.historyResyncs.delete(id) && !await this.conversation.refresh(id) && this.conversation.selected() === id) { this.historyRefresh.add(id); message += ` The conversation also needs to reconnect; ${instruction} to retry.`; }
      this.presentation.error(message, id); this.presentation.note(this.conversation.selected() === id ? message : null);
    } finally { this.histories.delete(id); this.busy = false; this.changed(); }
  }
  private async installHistory(operation: HistoryOperation, id: string, result: ReversibleHistoryResult): Promise<void> {
    const label = operation[0]!.toUpperCase() + operation.slice(1);
    this.retries.delete(id); this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    if (this.conversation.selected() === id) {
      const refreshed = await this.conversation.refresh(id); this.historyResyncs.delete(id);
      if (this.disposed) return;
      if (this.conversation.selected() === id && !refreshed) {
        this.historyRefresh.add(id);
        const instruction = operation === "undo" || operation === "redo" ? `Submit /${operation} again` : `Choose ${label} message again`;
        const preserved = operation === "undo" || operation === "redo" ? "command and attachments" : "composer and attachments";
        const message = `${label} completed, but the conversation could not be refreshed. ${instruction} to reconnect; the ${preserved} were kept.`;
        this.presentation.error(message, id); this.presentation.note(message); return;
      }
    }
    for (const entry of this.pendingAttachments(id)) this.release(entry.previewUrl);
    this.putAttachments(id, []); this.putUnavailable(id, []);
    const restored = result.restoredDraft ?? { text: "" };
    // History deliberately replaces, rather than merges, this conversation's draft.
    this.drafts.write(id, restored.text);
    const { available, unavailable } = this.convertStoredAttachments(restored.attachments ?? []);
    this.putAttachments(id, available); this.putUnavailable(id, unavailable); this.historyRetries.delete(id);
    const count = this.unavailableAttachments(id).length;
    const message = count ? `${count} restored ${count === 1 ? "attachment is" : "attachments are"} unavailable and will not be sent.` : null;
    if (this.conversation.selected() !== id) { if (message) this.presentation.error(message, id); this.presentation.note(null); return; }
    this.presentation.error(message, id);
    const current = this.conversation.read();
    const steers = operation === "undo" && this.conversation.declares("steering") && current?.conversationId === id ? current.queued.filter(entry => entry.delivery === "steer").length : 0;
    const steerNote = steers ? ` ${steers} pending steer${steers === 1 ? "" : "s"} will be delivered together with your replacement.` : "";
    this.presentation.note(`${message ? `${label} complete. ${message}` : `${label} complete`}${steerNote}`);
    this.changed("history", id);
  }
  dispose(): void {
    this.disposed = true;
    for (const url of this.previews) this.release(url);
    this.attachments.clear();
  }
}
