import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";

import type { ContentBlock, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";

import { historyPageCursor, historyPageEnd } from "../history-reuse";
import { settlesWithin } from "../managed-process";
import { PendingInteractions, INTERRUPTED_REASON } from "../pending-interactions";
import { OperationOutcomeUnknownError, UnsupportedVariantSelectionError, type ChatProvider, type NormalizedProviderEvent, type PendingPermission, type ProviderAttachment, type ProviderHistoryPage, type ProviderPermissionReply, type ProviderSession, type StoredMessageAccounting } from "../provider";
import { PushQueue } from "../push-queue";
import { provisionalTurn, type ChatTurnToken } from "../turn-liveness";
import { LOGIN_FAILED_NOTICE_CODE, type ChatAgent, type ChatCapability, type ChatCommand, type ChatLoginState, type ChatMode, type ChatModel, type ConversationConfiguration, type ConversationItem, type ConversationStatus, type MessageAttachment, type MessageDelivery, type ModelSelection, type PermissionRequest, type TokenUsage } from "../types";
import { ConversationNotFoundError } from "../workspace";
import { catalogFromSession, variantFor, type AcpCatalog } from "./catalog";
import { AcpProcess, AUTH_REQUIRED_CODE, rpcErrorCode, type AcpSpawn } from "./connection";
import { ANTIGRAVITY_AGENT } from "./descriptor";
import { ANTIGRAVITY_PRICES } from "./prices";
import { priceTurn, ratesFor, type AntigravityPriceTable } from "./pricing";
import { enrichReplay, readTranscript, transcriptModelFamily, transcriptPath, transcriptTurns } from "./transcript";
import { ANTIGRAVITY_PROVIDER_ID, configurationFromOptions, createAcpMemory, nextUserMessage, normalizeAcpUpdate, sealOpenBlock, toolItems, userMessageId, type AcpMemory } from "./normalization";

// A conversation with no turn, no open permission and no history read in
// progress gives its process back after this long (design D2).
const IDLE_RELEASE_MS = 5 * 60_000;
const DEFAULT_TITLE = "New conversation";
const LIST_PAGE_LIMIT = 20;
// How long a prompt whose connection closed waits to learn whether its
// process exited, which names the failure.
const PROCESS_EXIT_WAIT_MS = 1_000;

type Turn = {
  readonly id: string;
  readonly token: ChatTurnToken;
  // The user message that opened it: its usage carrier is named after it.
  readonly userIndex: number;
  readonly startedAt: number;
  // Prompts sent into it, counting steers; only the latest one's end is the turn's.
  latest: number;
  // Each prompt's ACP request, which settles when agy ends that prompt.
  readonly requests: Map<number, Promise<unknown>>;
  // A steer sent but not yet taken: its end is held until agy's evidence decides it.
  pendingSteer?: { index: number; ended?: { result?: { stopReason: string; usage?: unknown }; error?: unknown } };
  usage: TokenUsage;
  ended: boolean;
};

type Conversation = {
  readonly sessionId: string;
  readonly memory: AcpMemory;
  readonly items: ConversationItem[];
  readonly accounting: StoredMessageAccounting[];
  // Replay has filled the store (or the conversation started here).
  seeded: boolean;
  // Names this store for history cursors: a reseeded store is another history.
  version: string;
  process?: AcpProcess;
  starting?: Promise<AcpProcess>;
  loading: boolean;
  // What the user chose, and what agy is known to run in the current process.
  configuration: ConversationConfiguration;
  applied: ConversationConfiguration | null;
  turn?: Turn;
  // History reads and prompts being prepared: the process is in use.
  holds: number;
  idle?: ReturnType<typeof setTimeout>;
  readonly cancels: Set<() => void>;
  permissions: number;
};

type PermissionDetail = { options: RequestPermissionRequest["options"] };

export type AntigravityProviderOptions = {
  workspacePath: string;
  executable: string;
  env?: NodeJS.ProcessEnv;
  idleReleaseMs?: number;
  now?: () => number;
  spawn?: AcpSpawn;
  stdinCloseGraceMs?: number;
  termGraceMs?: number;
  // The built-in price table unless a test supplies its own.
  prices?: AntigravityPriceTable;
  // Where agy keeps its transcripts (`~/.gemini/...`): the home directory of
  // the workspace process unless a test supplies its own.
  homeDirectory?: string;
};

const STOP_FAILURES: Record<string, string> = {
  max_tokens: "Antigravity stopped: the reply reached its token limit.",
  max_turn_requests: "Antigravity stopped: the turn reached its request limit.",
  refusal: "Antigravity refused to continue.",
};

/**
 * The Antigravity chat provider (add-antigravity-chat): one `agy acp`
 * process per live conversation, a short-lived one for listing, ACP through
 * the official SDK, and history from `session/load` replay kept in a store
 * the live stream extends.
 */
export class AntigravityProvider implements ChatProvider {
  private readonly workspacePath: string;
  private readonly executable: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly idleReleaseMs: number;
  private readonly now: () => number;
  private readonly spawn?: AcpSpawn;
  private readonly stdinCloseGraceMs?: number;
  private readonly termGraceMs?: number;
  private readonly prices: AntigravityPriceTable;
  private readonly homeDirectory: string;
  private readonly events_ = new PushQueue<NormalizedProviderEvent>();
  private readonly interactions = new PendingInteractions<PermissionDetail>((conversationId, event) => this.publish({ ...event, conversationId }));
  private readonly conversations = new Map<string, Conversation>();
  private readonly sessions = new Map<string, ProviderSession>();
  private readonly released = new WeakSet<AcpProcess>();
  private readonly processes = new Set<AcpProcess>();
  private catalog: AcpCatalog | undefined;
  private commands: ChatCommand[] = [];
  private imageInput: boolean | undefined;
  private login: ChatLoginState | undefined;
  private permissionClock = 0;
  private disposed = false;

  constructor(options: AntigravityProviderOptions) {
    this.workspacePath = options.workspacePath;
    this.executable = options.executable;
    this.env = options.env ?? process.env;
    this.idleReleaseMs = options.idleReleaseMs ?? IDLE_RELEASE_MS;
    this.now = options.now ?? (() => Date.now());
    this.spawn = options.spawn;
    this.stdinCloseGraceMs = options.stdinCloseGraceMs;
    this.termGraceMs = options.termGraceMs;
    this.prices = options.prices ?? ANTIGRAVITY_PRICES;
    this.homeDirectory = options.homeDirectory ?? os.homedir();
  }

  describe(): ChatAgent {
    const capabilities: ChatCapability[] = ["models", "variants", "modes", "commands", "permissions", "context", "immediate-steering", "send-now"];
    if (this.imageInput) capabilities.push("attachments");
    return { id: ANTIGRAVITY_AGENT.id, name: ANTIGRAVITY_AGENT.name, capabilities };
  }

  loginState(): ChatLoginState {
    return this.login ?? "unknown";
  }

  async listCommands(): Promise<ChatCommand[]> {
    return this.commands;
  }

  async listModels(): Promise<ChatModel[]> {
    return this.catalog?.models ?? [];
  }

  async listModes(): Promise<ChatMode[]> {
    return this.catalog?.modes ?? [];
  }

  async newConversationConfiguration(): Promise<ConversationConfiguration> {
    return {};
  }

  // ---- sessions -----------------------------------------------------------

  /** agy's sessions for the workspace, from a short-lived listing process. */
  async listSessions(): Promise<ProviderSession[]> {
    const listed = await this.withListingProcess(async process => {
      const sessions: ProviderSession[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < LIST_PAGE_LIMIT; page++) {
        const answer = await process.agent.request("session/list", { cwd: this.workspacePath, ...(cursor ? { cursor } : {}) });
        for (const session of answer.sessions) {
          const updatedAt = Date.parse(session.updatedAt ?? "") || this.now();
          sessions.push({ id: session.sessionId, title: session.title || DEFAULT_TITLE, directory: session.cwd, createdAt: updatedAt, updatedAt });
        }
        cursor = answer.nextCursor ?? undefined;
        if (!cursor) break;
      }
      return sessions;
    });
    if (listed === "login-missing") return [...this.sessions.values()];
    for (const session of listed) {
      const known = this.sessions.get(session.id);
      this.sessions.set(session.id, known ? { ...session, createdAt: Math.min(known.createdAt, session.createdAt) } : session);
    }
    const ids = new Set(listed.map(session => session.id));
    // Sessions this provider created that agy does not list yet.
    return [...[...this.sessions.values()].filter(session => !ids.has(session.id) && this.conversations.has(session.id)), ...listed];
  }

  async getSession(id: string): Promise<ProviderSession | null> {
    return this.sessions.get(id) ?? (await this.listSessions()).find(session => session.id === id) ?? null;
  }

  async createSession(_id: string, configuration: ConversationConfiguration = {}): Promise<ProviderSession> {
    const process = await this.startProcess();
    let answer: Awaited<ReturnType<AcpProcess["agent"]["request"]>> & { sessionId: string };
    try {
      answer = await process.agent.request("session/new", { cwd: this.workspacePath, mcpServers: [] }) as typeof answer;
      this.setLogin("ok");
    } catch (error) {
      await this.closeProcess(process);
      if (rpcErrorCode(error) === AUTH_REQUIRED_CODE) this.setLogin("missing");
      throw error;
    }
    this.learnCatalog(answer);
    const created = this.now();
    const session: ProviderSession = { id: answer.sessionId, title: DEFAULT_TITLE, directory: this.workspacePath, createdAt: created, updatedAt: created };
    this.sessions.set(session.id, session);
    const conversation = this.conversation(session.id);
    conversation.seeded = true;
    conversation.process = process;
    conversation.applied = catalogFromSession(answer, false).current;
    conversation.configuration = { ...conversation.applied, ...configuration };
    this.watch(conversation, process);
    this.scheduleIdle(conversation);
    this.publish({ conversationId: session.id, updates: [], outcome: "handled", eventType: "session/new", sessionLifecycle: { kind: "created", id: session.id, directory: this.workspacePath, title: session.title } });
    return session;
  }

  async getConversationConfiguration(sessionId: string): Promise<ConversationConfiguration> {
    return this.conversations.get(sessionId)?.configuration ?? {};
  }

  async switchModel(sessionId: string, selection: ModelSelection, variant?: string): Promise<void> {
    if (variant !== undefined && !variantFor(this.catalog, selection.modelId, variant)) {
      throw new UnsupportedVariantSelectionError(`model ${selection.modelId} does not offer thinking level ${variant}`);
    }
    const conversation = this.conversation(sessionId);
    const { variant: _previous, ...rest } = conversation.configuration;
    conversation.configuration = { ...rest, model: selection, ...(variant ? { variant } : {}) };
    const process = conversation.process;
    if (process?.alive && !conversation.turn) await this.applyConfiguration(conversation, process, {});
  }

  // ---- history ------------------------------------------------------------

  async listMessages(sessionId: string, options: { cursor?: string; limit: number }): Promise<ProviderHistoryPage> {
    const conversation = this.conversation(sessionId);
    if (!conversation.seeded) {
      conversation.holds += 1;
      try { await this.ensureProcess(conversation); }
      finally { conversation.holds -= 1; this.scheduleIdle(conversation); }
    }
    const items = conversation.items;
    const end = historyPageEnd(options.cursor, conversation.version, items.length);
    const start = Math.max(0, end - Math.max(1, options.limit));
    const page = items.slice(start, end);
    const ids = new Set(page.map(item => item.id));
    return {
      items: page,
      accounting: conversation.accounting.filter(entry => ids.has(`usage:${entry.messageId}`)),
      completeItems: [...items],
      nextCursor: historyPageCursor(start, conversation.version),
    };
  }

  // ---- events -------------------------------------------------------------

  async *events(signal: AbortSignal): AsyncIterable<NormalizedProviderEvent> {
    const stop = () => this.events_.detachWaiters();
    signal.addEventListener("abort", stop, { once: true });
    try {
      while (!signal.aborted) {
        const next = await this.events_.take();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }

  // ---- turns --------------------------------------------------------------

  async prompt(sessionId: string, input: { id: string; text: string; delivery: MessageDelivery; attachments?: ProviderAttachment[]; model?: ModelSelection; mode?: string; variant?: string }): Promise<{ messageId: string; createdAt: number }> {
    const conversation = this.conversation(sessionId);
    if (input.delivery === "steer") return this.steer(conversation, input);
    if (conversation.turn) throw new Error("Antigravity is still answering this conversation");
    // A login made through `agy` since the last listing clears the notice.
    if (this.login === "missing") await this.listSessions().catch(() => undefined);
    // Held while it is prepared, so idle release cannot end the process
    // between loading it and sending the prompt.
    conversation.holds += 1;
    try {
      return await this.startTurn(conversation, input);
    } finally {
      conversation.holds -= 1;
      this.scheduleIdle(conversation);
    }
  }

  private async startTurn(conversation: Conversation, input: { text: string; attachments?: ProviderAttachment[]; model?: ModelSelection; mode?: string; variant?: string }): Promise<{ messageId: string; createdAt: number }> {
    const sessionId = conversation.sessionId;
    const process = await this.ensureProcess(conversation);
    await this.applyConfiguration(conversation, process, input);
    const blocks = await this.promptBlocks(input);
    if (conversation.turn) throw new Error("Antigravity is still answering this conversation");
    const now = this.now();
    const memory = conversation.memory;
    const user = nextUserMessage(memory, input.text, now, { attachments: attachmentRefs(input.attachments) });
    const turn: Turn = { id: `${sessionId}.t${memory.userCount}`, token: provisionalTurn(), userIndex: memory.userCount, startedAt: now, latest: 0, requests: new Map(), usage: {}, ended: false };
    conversation.turn = turn;
    memory.turn = turn.token;
    memory.live = true;
    memory.model = conversation.applied?.model ?? conversation.configuration.model;
    this.store(conversation, [{ kind: "upsert", item: user }]);
    this.publish({ conversationId: sessionId, updates: [], outcome: "handled", eventType: "session/prompt", notificationTurns: [{ sourceId: turn.id, phase: "started", createdAt: now }] });
    clearTimeout(conversation.idle);
    this.send(conversation, process, turn, blocks);
    return { messageId: userMessageId(memory, memory.userCount), createdAt: user.createdAt };
  }

  /**
   * A steer joins the running turn as a further prompt (design D9). ACP has
   * no acknowledgement for a prompt, so agy's evidence decides: the earlier
   * prompt ending means agy took the steer (it ends the earlier prompt when
   * one arrives), and only then does the steer's row appear. An error answer
   * to the steer first is a definite refusal; the connection ending first
   * leaves the outcome unknown.
   */
  private async steer(conversation: Conversation, input: { text: string; attachments?: ProviderAttachment[] }): Promise<{ messageId: string; createdAt: number }> {
    const turn = conversation.turn;
    const process = conversation.process;
    if (!turn || turn.ended || !process?.alive) throw new Error("Antigravity is not answering this conversation, so there is nothing to steer");
    const blocks = await this.promptBlocks(input);
    if (conversation.turn !== turn || turn.ended || !process.alive || turn.pendingSteer) throw new Error("Antigravity finished its turn before the steer was sent");
    const superseded = turn.latest;
    const previous = turn.requests.get(superseded)!;
    const index = this.send(conversation, process, turn, blocks, true);
    const request = turn.requests.get(index)!;
    const outcome = await Promise.race([
      previous.then(() => "accepted" as const, error => rpcErrorCode(error) === undefined ? "unknown" as const : "accepted" as const),
      request.then(() => "accepted" as const, error => rpcErrorCode(error) === undefined ? "unknown" as const : { refused: error }),
    ]);
    const ended = (turn.pendingSteer as Turn["pendingSteer"])?.ended;
    turn.pendingSteer = undefined;
    if (outcome === "unknown") throw new OperationOutcomeUnknownError();
    if (outcome !== "accepted") {
      // agy kept running the earlier prompt; its end is the turn's again.
      turn.latest = superseded;
      throw outcome.refused instanceof Error ? outcome.refused : new Error(String(outcome.refused));
    }
    const memory = conversation.memory;
    const user = nextUserMessage(memory, input.text, this.now(), { attachments: attachmentRefs(input.attachments) });
    this.emit(conversation, { updates: [...sealOpenBlock(memory, this.now()), { kind: "upsert", item: user }], outcome: "handled", eventType: "session/prompt" });
    if (ended) this.promptEnded(conversation, process, turn, index, ended);
    return { messageId: userMessageId(memory, memory.userCount), createdAt: user.createdAt };
  }

  async command(sessionId: string, input: { id: string; name: string; arguments: string; model?: ModelSelection; mode?: string; variant?: string }): Promise<{ messageId: string }> {
    // agy reads a slash command from the prompt text (design D8).
    const text = input.arguments ? `/${input.name} ${input.arguments}` : `/${input.name}`;
    return this.prompt(sessionId, { id: input.id, text, delivery: "queue", model: input.model, mode: input.mode, variant: input.variant });
  }

  async interrupt(sessionId: string): Promise<void> {
    const conversation = this.conversations.get(sessionId);
    const process = conversation?.process;
    if (!conversation?.turn || !process?.alive) return;
    // A pending permission resolves as cancelled, as ACP requires before
    // the prompt can answer `cancelled`.
    for (const cancel of [...conversation.cancels]) cancel();
    await process.agent.notify("session/cancel", { sessionId });
  }

  private send(conversation: Conversation, process: AcpProcess, turn: Turn, prompt: ContentBlock[], steer = false): number {
    const index = ++turn.latest;
    if (steer) turn.pendingSteer = { index };
    const request = process.agent.request("session/prompt", { sessionId: conversation.sessionId, prompt });
    turn.requests.set(index, request);
    void request.then(
      result => this.promptEnded(conversation, process, turn, index, { result: result as { stopReason: string; usage?: unknown } }),
      error => this.promptEnded(conversation, process, turn, index, { error }),
    );
    return index;
  }

  private promptEnded(conversation: Conversation, process: AcpProcess, turn: Turn, index: number, outcome: { result?: { stopReason: string; usage?: unknown }; error?: unknown }): void {
    // A steer not yet decided: steer() replays its end once agy's evidence is in.
    if (turn.pendingSteer?.index === index) { turn.pendingSteer.ended = outcome; return; }
    addUsage(turn.usage, outcome.result?.usage);
    // An earlier prompt that a steer superseded resolves `end_turn`; the
    // turn goes on in the steered prompt (design D9).
    if (turn.ended || index < turn.latest) return;
    if (outcome.result) {
      const reason = outcome.result.stopReason;
      if (reason === "cancelled") this.endTurn(conversation, turn, "interrupted");
      else if (STOP_FAILURES[reason]) this.endTurn(conversation, turn, "failed", STOP_FAILURES[reason]);
      else this.endTurn(conversation, turn, "completed");
      return;
    }
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    const code = rpcErrorCode(outcome.error);
    if (code === undefined) {
      // Not agy's answer but the connection ending: when the process is
      // going away, the turn fails as its exit (and watch() may get there first).
      void settlesWithin(process.exited, PROCESS_EXIT_WAIT_MS, milliseconds => Bun.sleep(milliseconds)).then(exited => {
        if (!this.released.has(process)) this.endTurn(conversation, turn, "failed", exited ? exitMessage(process) : `Antigravity could not answer: ${message}`);
      });
    } else if (code === AUTH_REQUIRED_CODE) {
      this.setLogin("missing");
      this.endTurn(conversation, turn, "failed", message, { id: `notice:login:${turn.id}`, type: "notice", createdAt: this.now(), level: "error", code: LOGIN_FAILED_NOTICE_CODE, message });
    } else {
      this.endTurn(conversation, turn, "failed", `Antigravity could not answer: ${message}`);
    }
  }

  private endTurn(conversation: Conversation, turn: Turn, status: ConversationStatus, message?: string, notice?: ConversationItem): void {
    if (turn.ended) return;
    turn.ended = true;
    turn.token.completed = true;
    const now = this.now();
    const memory = conversation.memory;
    const updates = sealOpenBlock(memory, now);
    const carrierId = `${conversation.sessionId}.t${turn.userIndex}`;
    const model = memory.model;
    const hasUsage = Object.keys(turn.usage).length > 0;
    // agy reports tokens only; the built-in table prices them (design D11).
    // An unpriced model leaves the cost absent, which is not zero.
    const costUsd = hasUsage ? priceTurn(turn.usage, model?.modelId, this.prices) : undefined;
    if (costUsd !== undefined) turn.usage.costUsd = costUsd;
    if (hasUsage) {
      updates.push({ kind: "upsert", item: { id: `usage:${carrierId}`, type: "assistant_message", createdAt: now, markdown: "", usage: { ...turn.usage }, ...(model ? { model } : {}) } });
      conversation.accounting.push({ messageId: carrierId, createdAt: now, usage: { ...turn.usage }, ...(model ? { model: model.modelId } : {}) });
    }
    if (notice) updates.push({ kind: "upsert", item: notice });
    updates.push({ kind: "status", status, ...(message ? { message } : {}) });
    if (conversation.turn === turn) conversation.turn = undefined;
    memory.turn = undefined;
    memory.live = false;
    const phase = status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : "failed";
    this.emit(conversation, {
      updates, outcome: "handled", eventType: "session/prompt.result",
      notificationTurns: [{ sourceId: turn.id, phase, createdAt: now }],
      ...(hasUsage ? { assistantUsage: { messageId: carrierId, usage: { ...turn.usage } } } : {}),
    });
    this.scheduleIdle(conversation);
  }

  // ---- permissions --------------------------------------------------------

  private permission(request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    const conversation = this.conversations.get(request.sessionId);
    if (!conversation || this.disposed) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const requestId = `permission-${++this.permissionClock}`;
    const toolCallId = request.toolCall.toolCallId;
    const memory = conversation.memory;
    memory.awaitingPermission.add(toolCallId);
    const merged = { ...(memory.tools.get(toolCallId) ?? { createdAt: this.now() }) } as Record<string, unknown>;
    for (const [key, value] of Object.entries(request.toolCall)) if (value !== undefined && value !== null && key !== "sessionUpdate") merged[key] = value;
    memory.tools.set(toolCallId, merged);
    this.emit(conversation, { updates: toolItems(memory, toolCallId, this.now()).map(item => ({ kind: "upsert" as const, item })), outcome: "handled", eventType: "session/request_permission" });
    const item: PermissionRequest = {
      id: `permission:${requestId}`, type: "permission", createdAt: this.now(), requestId,
      action: request.toolCall.title ?? "Antigravity wants to use a tool",
      // What the tool touches: its file locations, or the call itself (a
      // command line) when agy names none. A card with no resource cannot be
      // shown or answered.
      resources: permissionResources(request.toolCall, merged),
      status: "pending",
      // Only the choices agy offers, and none that approves future requests.
      choices: request.options.filter(option => option.kind === "allow_once").map(option => ({ id: option.optionId, label: "Allow once" })),
      sourceToolId: `tool:${toolCallId}`,
    };
    conversation.permissions += 1;
    clearTimeout(conversation.idle);
    const settled = this.interactions.await<RequestPermissionResponse>({
      conversationId: conversation.sessionId,
      item,
      detail: { options: request.options },
      cancellation: cancel => {
        if (signal.aborted) return "cancelled";
        signal.addEventListener("abort", cancel, { once: true });
        conversation.cancels.add(cancel);
        return () => { signal.removeEventListener("abort", cancel); conversation.cancels.delete(cancel); };
      },
      abandoned: () => ({ outcome: { outcome: "cancelled" } }),
    });
    return settled.finally(() => {
      conversation.permissions -= 1;
      memory.awaitingPermission.delete(toolCallId);
      if (memory.tools.has(toolCallId)) this.emit(conversation, { updates: toolItems(memory, toolCallId, this.now()).map(item => ({ kind: "upsert" as const, item })), outcome: "handled", eventType: "session/request_permission.settled" });
      this.scheduleIdle(conversation);
    });
  }

  async replyPermission(sessionId: string, requestId: string, reply: ProviderPermissionReply, choiceId?: string): Promise<void> {
    await this.interactions.answer(sessionId, requestId, "permission", (pending): RequestPermissionResponse => {
      const options = pending.detail.options;
      const option = reply === "reject"
        ? options.find(candidate => candidate.kind === "reject_once") ?? options.find(candidate => candidate.kind === "reject_always")
        : options.find(candidate => candidate.optionId === choiceId) ?? options.find(candidate => candidate.kind === "allow_once");
      return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
    });
  }

  async listPermissions(): Promise<PendingPermission[]> {
    return this.interactions.list("permission") as PendingPermission[];
  }

  async replyQuestion(): Promise<void> {
    throw new Error("Antigravity does not ask questions");
  }

  async rejectQuestion(): Promise<void> {
    throw new Error("Antigravity does not ask questions");
  }

  // ---- processes ----------------------------------------------------------

  private async startProcess(): Promise<AcpProcess> {
    if (this.disposed) throw new Error("Antigravity chat has shut down");
    const process = AcpProcess.spawn({
      executable: this.executable,
      cwd: this.workspacePath,
      env: this.env,
      spawn: this.spawn,
      stdinCloseGraceMs: this.stdinCloseGraceMs,
      termGraceMs: this.termGraceMs,
      handlers: {
        update: params => this.update(params),
        permission: (request, signal) => this.permission(request, signal),
      },
    });
    // Owned from spawn until it and its group are gone, so dispose() ends a
    // child still in `initialize` and whatever a crashed leader left behind.
    this.processes.add(process);
    void process.settled.then(() => this.processes.delete(process));
    try {
      await process.ready;
    } catch (error) {
      await this.closeProcess(process);
      throw error;
    }
    this.imageInput = process.initialized.agentCapabilities?.promptCapabilities?.image === true;
    if (this.disposed) { await this.closeProcess(process); throw new Error("Antigravity chat has shut down"); }
    return process;
  }

  private async closeProcess(process: AcpProcess): Promise<void> {
    this.released.add(process);
    await process.close();
  }

  private async withListingProcess<T>(read: (process: AcpProcess) => Promise<T>): Promise<T | "login-missing"> {
    const process = await this.startProcess();
    try {
      const value = await read(process);
      this.setLogin("ok");
      return value;
    } catch (error) {
      if (rpcErrorCode(error) === AUTH_REQUIRED_CODE) {
        this.setLogin("missing");
        return "login-missing";
      }
      throw error;
    } finally {
      await this.closeProcess(process);
    }
  }

  /** The conversation's process, starting one and loading its session when it has none. */
  private ensureProcess(conversation: Conversation): Promise<AcpProcess> {
    if (conversation.process?.alive) return Promise.resolve(conversation.process);
    conversation.starting ??= (async () => {
      // agy answers a load of an unknown id and fails the next prompt, so the
      // id must be one agy lists (design D10).
      if (!this.sessions.has(conversation.sessionId) && !(await this.listSessions()).some(session => session.id === conversation.sessionId)) {
        throw new ConversationNotFoundError();
      }
      const process = await this.startProcess();
      conversation.loading = true;
      try {
        const answer = await process.agent.request("session/load", { sessionId: conversation.sessionId, cwd: this.workspacePath, mcpServers: [] });
        this.setLogin("ok");
        this.learnCatalog(answer);
        // agy starts a loaded session on its own defaults (design D7).
        conversation.applied = catalogFromSession(answer, false).current;
        conversation.configuration = { ...conversation.applied, ...conversation.configuration };
      } catch (error) {
        await this.closeProcess(process);
        if (rpcErrorCode(error) === AUTH_REQUIRED_CODE) this.setLogin("missing");
        throw error;
      } finally {
        conversation.loading = false;
      }
      if (!conversation.seeded) {
        sealOpenBlock(conversation.memory, this.now()).forEach(update => this.store(conversation, [update]));
        await this.enrichFromTranscript(conversation);
        conversation.seeded = true;
      }
      conversation.process = process;
      this.watch(conversation, process);
      this.scheduleIdle(conversation);
      return process;
    })().finally(() => { conversation.starting = undefined; });
    return conversation.starting;
  }

  /** Add what replay omits from agy's transcript, or leave replay as it is (design D10). */
  private async enrichFromTranscript(conversation: Conversation): Promise<void> {
    const read = await readTranscript(transcriptPath(this.homeDirectory, conversation.sessionId));
    const known = (id: string) => this.catalog?.models.some(model => model.selection.modelId === id) === true || ratesFor(id, this.prices) !== undefined;
    const enriched = "steps" in read ? enrichReplay(conversation.items, conversation.sessionId, transcriptTurns(read.steps), {
      family: model => transcriptModelFamily(model, known),
      price: (usage, modelId) => priceTurn(usage, modelId, this.prices),
    }) : null;
    if (!enriched) {
      if (process.env.UATU_DEBUG) console.debug("[antigravity transcript]", conversation.sessionId, "skipped" in read ? read.skipped : "foreign");
      return;
    }
    conversation.items.splice(0, conversation.items.length, ...enriched.items);
    conversation.accounting.push(...enriched.accounting);
  }

  private watch(conversation: Conversation, process: AcpProcess): void {
    void process.exited.then(() => {
      if (conversation.process !== process) return;
      conversation.process = undefined;
      conversation.applied = null;
      if (this.released.has(process)) return;
      // An unexpected exit stays in this conversation (spec).
      this.interactions.abandon(conversation.sessionId, "The Antigravity process ended before the user answered.");
      const turn = conversation.turn;
      if (turn) this.endTurn(conversation, turn, "failed", exitMessage(process));
    });
  }

  private scheduleIdle(conversation: Conversation): void {
    clearTimeout(conversation.idle);
    conversation.idle = undefined;
    if (!conversation.process || conversation.turn || conversation.permissions > 0 || conversation.holds > 0 || this.disposed) return;
    const timer = setTimeout(() => {
      const process = conversation.process;
      if (!process || conversation.turn || conversation.permissions > 0 || conversation.holds > 0) return;
      conversation.process = undefined;
      conversation.applied = null;
      void this.closeProcess(process);
    }, this.idleReleaseMs);
    (timer as { unref?: () => void }).unref?.();
    conversation.idle = timer;
  }

  private async applyConfiguration(conversation: Conversation, process: AcpProcess, input: { model?: ModelSelection; mode?: string; variant?: string }): Promise<void> {
    const chosen = conversation.configuration;
    const model = input.model ?? chosen.model;
    const variant = model ? variantFor(this.catalog, model.modelId, input.model ? input.variant : input.variant ?? chosen.variant) : undefined;
    const mode = input.mode ?? chosen.mode;
    const sessionId = conversation.sessionId;
    let applied = conversation.applied ?? {};
    const modelChanged = model !== undefined && applied.model?.modelId !== model.modelId;
    if (modelChanged) {
      const answer = await process.agent.request("session/set_config_option", { sessionId, configId: "model", value: model.modelId });
      applied = { ...applied, ...configurationFromOptions(answer.configOptions) };
    }
    if (variant && (modelChanged || applied.variant !== variant)) {
      const answer = await process.agent.request("session/set_config_option", { sessionId, configId: "thought_level", value: variant });
      applied = { ...applied, ...configurationFromOptions(answer.configOptions) };
    }
    if (mode && applied.mode !== mode) {
      await process.agent.request("session/set_mode", { sessionId, modeId: mode });
      applied = { ...applied, mode };
    }
    conversation.applied = applied;
    conversation.configuration = { ...(model ? { model } : {}), ...(variant ? { variant } : {}), ...(mode ? { mode } : {}) };
  }

  private async promptBlocks(input: { text: string; attachments?: ProviderAttachment[] }): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = [];
    if (input.text) blocks.push({ type: "text", text: input.text });
    if (input.attachments?.length) {
      if (!this.imageInput) throw new Error("Antigravity does not accept images");
      for (const attachment of input.attachments) {
        const bytes = await fs.readFile(attachment.absolutePath);
        blocks.push({ type: "image", mimeType: attachment.mimeType, data: bytes.toString("base64") });
      }
    }
    return blocks;
  }

  // ---- update routing -----------------------------------------------------

  private update(params: unknown): void {
    const sessionId = (params as { sessionId?: unknown } | null)?.sessionId;
    const update = (params as { update?: { sessionUpdate?: unknown; availableCommands?: unknown } } | null)?.update;
    if (update?.sessionUpdate === "available_commands_update" && Array.isArray(update.availableCommands)) {
      this.commands = update.availableCommands.flatMap(entry => {
        const command = entry as { name?: unknown; description?: unknown; input?: { hint?: unknown } | null };
        return typeof command.name === "string" && command.name && !/\s|\//.test(command.name)
          ? [{ name: command.name, description: typeof command.description === "string" ? command.description : "", argumentHint: typeof command.input?.hint === "string" ? command.input.hint : "", kind: "command" as const }]
          : [];
      });
    }
    if (typeof sessionId !== "string") return;
    const conversation = this.conversations.get(sessionId);
    if (!conversation) return;
    if (conversation.loading) {
      // Replay: the store's history when it has none yet, otherwise
      // already known and dropped.
      if (conversation.seeded) return;
      const normalized = normalizeAcpUpdate(params, conversation.memory, this.now());
      this.store(conversation, normalized.updates);
      if (normalized.sessionLifecycle) this.retitle(conversation, normalized.sessionLifecycle.title);
      return;
    }
    const normalized = normalizeAcpUpdate(params, conversation.memory, this.now());
    if (normalized.sessionLifecycle) this.retitle(conversation, normalized.sessionLifecycle.title);
    if (normalized.configuration) conversation.applied = { ...conversation.applied ?? {}, ...normalized.configuration };
    this.emit(conversation, normalized);
  }

  private retitle(conversation: Conversation, title: string): void {
    const session = this.sessions.get(conversation.sessionId);
    if (session) this.sessions.set(session.id, { ...session, title, updatedAt: this.now() });
  }

  private learnCatalog(answer: unknown): void {
    const catalog = catalogFromSession(answer, this.imageInput === true);
    if (catalog.models.length === 0 && catalog.modes.length === 0) return;
    const changed = JSON.stringify(catalog.models) !== JSON.stringify(this.catalog?.models) || JSON.stringify(catalog.modes) !== JSON.stringify(this.catalog?.modes);
    this.catalog = catalog;
    if (changed) this.publish({ updates: [], outcome: "handled", eventType: "catalog", catalogsChanged: true });
  }

  private setLogin(login: ChatLoginState): void {
    if (this.login === login) return;
    this.login = login;
    this.publish({ updates: [], outcome: "handled", eventType: "login", catalogsChanged: true });
  }

  // ---- store and stream ---------------------------------------------------

  private conversation(sessionId: string): Conversation {
    let conversation = this.conversations.get(sessionId);
    if (!conversation) {
      conversation = {
        sessionId, memory: createAcpMemory(sessionId, this.workspacePath), items: [], accounting: [], seeded: false, version: randomUUID(),
        loading: false, configuration: {}, applied: null, holds: 0, cancels: new Set(), permissions: 0,
      };
      this.conversations.set(sessionId, conversation);
    }
    return conversation;
  }

  private store(conversation: Conversation, updates: NormalizedProviderEvent["updates"]): void {
    for (const update of updates) {
      if (update.kind === "upsert") {
        const index = conversation.items.findIndex(item => item.id === update.item.id);
        if (index >= 0) conversation.items[index] = update.item;
        else conversation.items.push(update.item);
      } else if (update.kind === "remove") {
        const index = conversation.items.findIndex(item => item.id === update.itemId);
        if (index >= 0) conversation.items.splice(index, 1);
      }
    }
  }

  private emit(conversation: Conversation, event: Omit<NormalizedProviderEvent, "conversationId">): void {
    this.store(conversation, event.updates);
    this.publish({ ...event, conversationId: conversation.sessionId });
  }

  private publish(event: NormalizedProviderEvent): void {
    if (!this.disposed) this.events_.push(event);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const conversation of this.conversations.values()) {
      clearTimeout(conversation.idle);
      this.interactions.abandon(conversation.sessionId, INTERRUPTED_REASON);
    }
    const processes = [...this.processes];
    await Promise.all(processes.map(process => this.closeProcess(process)));
    await Promise.all(processes.map(process => process.settled));
    this.events_.close();
  }
}

function permissionResources(toolCall: RequestPermissionRequest["toolCall"], merged: Record<string, unknown>): string[] {
  const paths = (toolCall.locations ?? []).map(location => location.path);
  if (paths.length) return paths;
  const rawInput = merged.rawInput as Record<string, unknown> | undefined;
  const command = typeof rawInput?.CommandLine === "string" ? rawInput.CommandLine : undefined;
  return [command ?? toolCall.title ?? (typeof merged.title === "string" ? merged.title : undefined) ?? toolCall.kind ?? "tool"];
}

function attachmentRefs(attachments: ProviderAttachment[] | undefined): MessageAttachment[] | undefined {
  return attachments?.map(({ id, name, mimeType }) => ({ id, name, mimeType }));
}

/** ACP's per-prompt usage (unstable schema), added into a turn's tokens. */
function addUsage(total: TokenUsage, usage: unknown): void {
  if (!usage || typeof usage !== "object") return;
  const value = usage as Record<string, unknown>;
  const add = (key: keyof TokenUsage, source: string) => {
    const amount = value[source];
    if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) total[key] = (total[key] ?? 0) + amount;
  };
  add("input", "inputTokens");
  add("output", "outputTokens");
  add("reasoning", "thoughtTokens");
  add("cacheRead", "cachedReadTokens");
  add("cacheWrite", "cachedWriteTokens");
}

function exitMessage(process: AcpProcess): string {
  const stderr = process.stderr().split("\n").filter(Boolean).slice(-3).join(" ");
  return `Antigravity stopped unexpectedly${stderr ? `: ${stderr}` : "."}`;
}

export { ANTIGRAVITY_PROVIDER_ID };
