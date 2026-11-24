import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";

import type { ContentBlock, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";

import { historyPageCursor, historyPageEnd } from "../history-reuse";
import { settlesWithin } from "../managed-process";
import { PendingInteractions, INTERRUPTED_REASON } from "../pending-interactions";
import { AgentLoginRequiredError, UnsupportedVariantSelectionError, type ChatProvider, type SteerConfirmation, type NormalizedProviderEvent, type PendingPermission, type ProviderAttachment, type ProviderHistoryPage, type ProviderPermissionReply, type ProviderSession, type StoredMessageAccounting } from "../provider";
import { PushQueue } from "../push-queue";
import { provisionalTurn, type ChatTurnToken } from "../turn-liveness";
import { LOGIN_FAILED_NOTICE_CODE, type ChatAgent, type ChatCapability, type ChatCommand, type ChatLoginState, type ChatMode, type ChatModel, type ConversationConfiguration, type ConversationItem, type ConversationStatus, type MessageAttachment, type MessageDelivery, type ModelSelection, type PermissionRequest, type TokenUsage } from "../types";
import { ConversationNotFoundError } from "../workspace";
import { catalogFromSession, legacyModelId, variantFor, withAdvertisedLevels, type AcpCatalog } from "./catalog";
import { AcpProcess, AUTH_REQUIRED_CODE, rpcErrorCode, type AcpSpawn } from "./connection";
import { ANTIGRAVITY_AGENT } from "./descriptor";
import { ANTIGRAVITY_PRICES } from "./prices";
import { priceTurn, ratesFor, type AntigravityPriceTable } from "./pricing";
import { enrichReplay, historyFromTranscript, readSessionTranscript, transcriptModelFamily, transcriptTurns } from "./transcript";
import { ANTIGRAVITY_PROVIDER_ID, configurationFromOptions, createAcpMemory, nextUserMessage, normalizeAcpUpdate, sealOpenBlock, toolItems, userMessageId, type AcpMemory } from "./normalization";

// A conversation with no turn, no open permission and no history read in
// progress gives its process back after this long (design D2).
const IDLE_RELEASE_MS = 5 * 60_000;
const DEFAULT_TITLE = "New conversation";
const LOGIN_REQUIRED_MESSAGE = "Antigravity is not logged in. Run agy where UatuCode runs and sign in.";
const NO_TRANSCRIPT_MESSAGE = `${LOGIN_REQUIRED_MESSAGE} agy keeps no transcript of this conversation to read meanwhile.`;
// How long agy may take to answer `initialize`, a listing, `session/new` or
// `session/load` before its process is ended, so a hung agy can neither pile
// up children nor leave a conversation waiting on a stuck start.
const SETUP_DEADLINE_MS = 30_000;
// How long a prompt whose connection closed waits to learn whether its
// process exited, which names the failure.
const PROCESS_EXIT_WAIT_MS = 1_000;

type Turn = {
  readonly id: string;
  readonly token: ChatTurnToken;
  // The user message that opened it: its usage carrier is named after it,
  // and its words identify the turn in agy's transcript.
  readonly userIndex: number;
  readonly request: string;
  readonly startedAt: number;
  // Prompts sent into it, counting steers, by send order.
  latest: number;
  readonly prompts: Map<number, PromptState>;
  usage: TokenUsage;
  ended: boolean;
};

type PromptOutcome = { result?: { stopReason: string; usage?: unknown }; error?: unknown };

// One `session/prompt` in a turn: its ACP request (settled when agy ends
// that prompt) and, once settled, how it ended. A steer also carries what
// its row needs and the promise its sender waits on for confirmation.
type PromptState = { request: Promise<unknown>; outcome?: PromptOutcome; steer?: SteerState };
type SteerState = {
  // Its user position, taken when agy takes it in (the prompt before it
  // answers), so a steer agy refuses first never moves the running reply.
  position?: number;
  // The row it was taken in after, if any: its own row goes there once accepted.
  after?: string;
  sentAt: number;
  text: string;
  attachments?: MessageAttachment[];
  decided?: SteerConfirmation["outcome"];
  confirm: (confirmation: SteerConfirmation) => void;
};

type Conversation = {
  readonly sessionId: string;
  readonly memory: AcpMemory;
  readonly items: ConversationItem[];
  readonly accounting: StoredMessageAccounting[];
  // Replay has filled the store (or the conversation started here).
  seeded: boolean;
  // The history came from agy's transcript alone (logged out): the next
  // successful load replaces it with agy's replay.
  fromTranscript?: true;
  // Names this store for history cursors: a reseeded store is another history.
  version: string;
  process?: AcpProcess;
  starting?: Promise<AcpProcess>;
  loading: boolean;
  // Replay being read by a load: committed to the store only once the load
  // succeeds, so a load that fails part-way leaves no partial history.
  replay?: { memory: AcpMemory; items: ConversationItem[] };
  // What the user chose, and what agy is known to run in the current process.
  configuration: ConversationConfiguration;
  applied: ConversationConfiguration | null;
  turn?: Turn;
  // History reads and prompts being prepared: the process is in use.
  holds: number;
  // Cancels the pending idle release, if any.
  idle?: () => void;
  readonly cancels: Set<() => void>;
  permissions: number;
};

type PermissionDetail = { options: RequestPermissionRequest["options"] };

export type AntigravityProviderOptions = {
  workspacePath: string;
  executable: string;
  env?: NodeJS.ProcessEnv;
  idleReleaseMs?: number;
  // Arms the idle release and answers its cancel: a timer unless a test
  // fires it by hand.
  idleTimer?: (release: () => void, milliseconds: number) => () => void;
  now?: () => number;
  spawn?: AcpSpawn;
  stdinCloseGraceMs?: number;
  termGraceMs?: number;
  // The built-in price table unless a test supplies its own.
  prices?: AntigravityPriceTable;
  setupDeadlineMs?: number;
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
  private readonly idleTimer: (release: () => void, milliseconds: number) => () => void;
  private readonly now: () => number;
  private readonly spawn?: AcpSpawn;
  private readonly stdinCloseGraceMs?: number;
  private readonly termGraceMs?: number;
  private readonly prices: AntigravityPriceTable;
  private readonly homeDirectory: string;
  private readonly setupDeadlineMs: number;
  private readonly events_ = new PushQueue<NormalizedProviderEvent>();
  private readonly interactions = new PendingInteractions<PermissionDetail>((conversationId, event) => this.publish({ ...event, conversationId }));
  private readonly conversations = new Map<string, Conversation>();
  private readonly sessions = new Map<string, ProviderSession>();
  // Sessions created here that agy has not listed yet.
  private readonly created = new Set<string>();
  private readonly released = new WeakSet<AcpProcess>();
  private readonly processes = new Set<AcpProcess>();
  private catalog: AcpCatalog | undefined;
  private commands: ChatCommand[] = [];
  private imageInput: boolean | undefined;
  private login: ChatLoginState | undefined;
  private permissionClock = 0;
  private loginNotices = 0;
  private disposed = false;

  constructor(options: AntigravityProviderOptions) {
    this.workspacePath = options.workspacePath;
    this.executable = options.executable;
    this.env = options.env ?? process.env;
    this.idleReleaseMs = options.idleReleaseMs ?? IDLE_RELEASE_MS;
    this.idleTimer = options.idleTimer ?? armIdleTimer;
    this.now = options.now ?? (() => Date.now());
    this.spawn = options.spawn;
    this.stdinCloseGraceMs = options.stdinCloseGraceMs;
    this.termGraceMs = options.termGraceMs;
    this.prices = options.prices ?? ANTIGRAVITY_PRICES;
    this.homeDirectory = options.homeDirectory ?? os.homedir();
    this.setupDeadlineMs = options.setupDeadlineMs ?? SETUP_DEADLINE_MS;
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
    return this.inventory();
  }

  /**
   * agy's sessions for the workspace, all of them: the listing follows
   * agy's cursors to the end, bounded by the listing deadline rather than a
   * page count, and a listing that cannot finish fails (unavailable) rather
   * than standing for the whole inventory. While the login is missing, the
   * sessions already known stand in.
   */
  private async inventory(): Promise<ProviderSession[]> {
    const listed = await this.withListingProcess(async process => {
      const sessions: ProviderSession[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const answer = await process.agent.request("session/list", { cwd: this.workspacePath, ...(cursor ? { cursor } : {}) });
        for (const session of answer.sessions) {
          const updatedAt = Date.parse(session.updatedAt ?? "") || this.now();
          sessions.push({ id: session.sessionId, title: session.title || DEFAULT_TITLE, directory: session.cwd, createdAt: updatedAt, updatedAt });
        }
        cursor = answer.nextCursor ?? undefined;
        if (cursor !== undefined && seen.has(cursor)) throw new Error("Antigravity's session list repeated a page");
        if (cursor !== undefined) seen.add(cursor);
      } while (cursor !== undefined);
      return sessions;
    });
    if (listed === "login-missing") return [...this.sessions.values()];
    for (const session of listed) {
      const known = this.sessions.get(session.id);
      this.sessions.set(session.id, known ? { ...session, createdAt: Math.min(known.createdAt, session.createdAt) } : session);
    }
    const ids = new Set(listed.map(session => session.id));
    for (const id of ids) this.created.delete(id);
    // The whole listing is the inventory: what it no longer holds is gone,
    // except sessions created here that agy does not list yet.
    for (const id of [...this.sessions.keys()]) if (!ids.has(id) && !this.created.has(id)) this.sessions.delete(id);
    return [...[...this.created].flatMap(id => this.sessions.get(id) ?? []), ...listed];
  }

  async getSession(id: string): Promise<ProviderSession | null> {
    return this.sessions.get(id) ?? (await this.listSessions()).find(session => session.id === id) ?? null;
  }

  async createSession(_id: string, configuration: ConversationConfiguration = {}): Promise<ProviderSession> {
    const process = await this.startProcess();
    let answer: Awaited<ReturnType<AcpProcess["agent"]["request"]>> & { sessionId: string };
    try {
      answer = await withDeadline(process.agent.request("session/new", { cwd: this.workspacePath, mcpServers: [] }), this.setupDeadlineMs, "session/new") as typeof answer;
      this.setLogin("ok");
    } catch (error) {
      await this.closeProcess(process);
      if (rpcErrorCode(error) === AUTH_REQUIRED_CODE) {
        this.setLogin("missing");
        throw new AgentLoginRequiredError(LOGIN_REQUIRED_MESSAGE);
      }
      throw error;
    }
    this.learnCatalog(answer);
    const created = this.now();
    const session: ProviderSession = { id: answer.sessionId, title: DEFAULT_TITLE, directory: this.workspacePath, createdAt: created, updatedAt: created };
    this.sessions.set(session.id, session);
    this.created.add(session.id);
    const conversation = this.conversation(session.id);
    conversation.seeded = true;
    conversation.process = process;
    conversation.applied = catalogFromSession(answer, false, id => this.knownModel(id)).current;
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
    if (this.login === "missing" && !conversation.turn) {
      // Logged out, the transcript is the only history (D10), reread on every
      // read: never a replay seeded earlier, and nothing once the file is gone.
      if (!await this.seedFromTranscript(conversation)) {
        this.forgetHistory(conversation);
        throw new AgentLoginRequiredError(NO_TRANSCRIPT_MESSAGE);
      }
    } else if (!conversation.seeded) {
      conversation.holds += 1;
      try { await this.ensureProcess(conversation); }
      catch (error) {
        // A listed conversation stays readable when agy's login has expired:
        // its transcript is read on its own (spec: login-missing state).
        // Without one, the read says how to sign in, as later reads do.
        if (rpcErrorCode(error) !== AUTH_REQUIRED_CODE) throw error;
        if (!await this.seedFromTranscript(conversation)) throw new AgentLoginRequiredError(NO_TRANSCRIPT_MESSAGE);
      } finally { conversation.holds -= 1; this.scheduleIdle(conversation); }
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

  async prompt(sessionId: string, input: { id: string; text: string; delivery: MessageDelivery; attachments?: ProviderAttachment[]; model?: ModelSelection; mode?: string; variant?: string }): Promise<{ messageId: string; createdAt: number; confirmation?: Promise<SteerConfirmation> }> {
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
    } catch (error) {
      // agy refusing the load or a setting for its login is the same login
      // failure as a turn's, and shows the same notice (spec: login failed).
      if (rpcErrorCode(error) === AUTH_REQUIRED_CODE) {
        this.setLogin("missing");
        const message = error instanceof Error ? error.message : String(error);
        this.emit(conversation, { updates: [{ kind: "upsert", item: { id: `notice:login:${sessionId}.p${++this.loginNotices}`, type: "notice", createdAt: this.now(), level: "error", code: LOGIN_FAILED_NOTICE_CODE, message } }], outcome: "handled", eventType: "session/load" });
      }
      throw error;
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
    const turn: Turn = { id: `${sessionId}.t${memory.userCount}`, token: provisionalTurn(), userIndex: memory.userCount, request: input.text, startedAt: now, latest: 0, prompts: new Map(), usage: {}, ended: false };
    conversation.turn = turn;
    memory.turn = turn.token;
    memory.live = true;
    memory.model = conversation.applied?.model ?? conversation.configuration.model;
    this.store(conversation, [{ kind: "upsert", item: user }]);
    this.publish({ conversationId: sessionId, updates: [], outcome: "handled", eventType: "session/prompt", notificationTurns: [{ sourceId: turn.id, phase: "started", createdAt: now }] });
    conversation.idle?.();
    this.send(conversation, process, turn, blocks);
    return { messageId: userMessageId(memory, memory.userCount), createdAt: user.createdAt };
  }

  /**
   * A steer joins the running turn as a further prompt (design D9). It is
   * sent and answered at once: `confirmation` settles later, from agy's own
   * answer to it, because ACP has no acknowledgement for a prompt and agy
   * ends the earlier prompt with an ordinary `end_turn` (the trial showed no
   * other stop reason for it). A result other than `cancelled` accepts the
   * steer, and its row then appears at the place it was sent; an error
   * answer refuses it; anything else (a cancelled result, the connection
   * ending) leaves the outcome unknown. Several steers can be awaiting at once.
   */
  private async steer(conversation: Conversation, input: { text: string; attachments?: ProviderAttachment[] }): Promise<{ messageId: string; createdAt: number; confirmation: Promise<SteerConfirmation> }> {
    const turn = conversation.turn;
    const process = conversation.process;
    if (!turn || turn.ended || !process?.alive) throw new Error("Antigravity is not answering this conversation, so there is nothing to steer");
    const blocks = await this.promptBlocks(input);
    if (conversation.turn !== turn || turn.ended || !process.alive) throw new Error("Antigravity finished its turn before the steer was sent");
    // Sending moves nothing: the reply agy is streaming continues where it
    // is until agy takes the steer in (settleTurn).
    const sentAt = this.now();
    let confirm!: (confirmation: SteerConfirmation) => void;
    const confirmation = new Promise<SteerConfirmation>(resolve => { confirm = resolve; });
    const index = this.send(conversation, process, turn, blocks, { sentAt, text: input.text, attachments: attachmentRefs(input.attachments), confirm });
    // A provisional id: the confirmation names the row's own.
    return { messageId: `${turn.id}.s${index}`, createdAt: sentAt, confirmation };
  }

  // agy takes a steer in when the prompt before it answers; from then on
  // what it streams answers the steer, numbered after the steer's user
  // position as replay numbers it.
  private placeSteer(conversation: Conversation, steer: SteerState): void {
    const memory = conversation.memory;
    this.emit(conversation, { updates: sealOpenBlock(memory, this.now()), outcome: "handled", eventType: "session/prompt" });
    memory.userCount += 1;
    memory.blockCount = 0;
    steer.position = memory.userCount;
    steer.after = conversation.items.at(-1)?.id;
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

  private send(conversation: Conversation, process: AcpProcess, turn: Turn, prompt: ContentBlock[], steer?: SteerState): number {
    const index = ++turn.latest;
    const request = process.agent.request("session/prompt", { sessionId: conversation.sessionId, prompt });
    turn.prompts.set(index, { request, ...(steer ? { steer } : {}) });
    void request.then(
      result => this.promptEnded(conversation, process, turn, index, { result: result as { stopReason: string; usage?: unknown } }),
      error => this.promptEnded(conversation, process, turn, index, { error }),
    );
    return index;
  }

  private promptEnded(conversation: Conversation, process: AcpProcess, turn: Turn, index: number, outcome: PromptOutcome): void {
    const state = turn.prompts.get(index);
    if (!state || state.outcome) return;
    state.outcome = outcome;
    // Every prompt that ran counts toward the turn's tokens.
    addUsage(turn.usage, outcome.result?.usage);
    this.settleTurn(conversation, process, turn);
  }

  /**
   * Decide the steers whose own answers are in, then end the turn when the
   * prompt that carries it has ended (design D9). That prompt is the latest
   * one agy did not refuse: a superseded prompt's `end_turn` never ends the
   * turn, and a refused steer hands the turn back to the prompt before it,
   * whose own end is then reported as it came.
   */
  private settleTurn(conversation: Conversation, process: AcpProcess, turn: Turn): void {
    // The latest prompt before this one that agy did not refuse.
    let previous: PromptState | undefined;
    for (const state of turn.prompts.values()) {
      const steer = state.steer;
      if (steer && !steer.decided) this.decideSteer(conversation, steer, state.outcome, previous);
      if (steer?.decided !== "refused") previous = state;
    }
    if (turn.ended) return;
    const carrying = [...turn.prompts.entries()].reverse().find(([, state]) => state.steer?.decided !== "refused");
    if (!carrying || !carrying[1].outcome) return;
    this.finishTurn(conversation, process, turn, carrying[1].outcome);
  }

  private decideSteer(conversation: Conversation, steer: SteerState, outcome: PromptOutcome | undefined, previous: PromptState | undefined): void {
    const memory = conversation.memory;
    const taken = previous?.outcome?.result && previous.outcome.result.stopReason !== "cancelled";
    if (steer.position === undefined && taken) this.placeSteer(conversation, steer);
    if (!outcome) return;
    const { result, error } = outcome;
    if (result && result.stopReason !== "cancelled") {
      steer.decided = "accepted";
      if (steer.position === undefined) this.placeSteer(conversation, steer);
      const position = steer.position!;
      const user: ConversationItem = { id: `message:${userMessageId(memory, position)}`, type: "user_message", createdAt: steer.sentAt, text: steer.text, ...(steer.attachments?.length ? { attachments: steer.attachments } : {}) };
      // After the row it was taken in after, and after steers taken in before it there.
      let at = steer.after === undefined ? 0 : conversation.items.findIndex(item => item.id === steer.after) + 1;
      const earlier = (item: ConversationItem | undefined) => item?.type === "user_message" && Number(item.id.match(/\.u(\d+)$/)?.[1] ?? Infinity) < position;
      while (at > 0 && at < conversation.items.length && earlier(conversation.items[at])) at += 1;
      conversation.items.splice(at > 0 ? at : conversation.items.length, 0, user);
      this.publish({ conversationId: conversation.sessionId, updates: [{ kind: "upsert", item: user }], outcome: "handled", eventType: "session/prompt" });
      steer.confirm({ outcome: "accepted", messageId: userMessageId(memory, position), createdAt: steer.sentAt });
    } else if (error !== undefined && rpcErrorCode(error) !== undefined) {
      steer.decided = "refused";
      // Taken in with nothing numbered after it: give its position back.
      if (steer.position !== undefined && memory.userCount === steer.position && memory.blockCount === 0) memory.userCount -= 1;
      steer.confirm({ outcome: "refused", reason: error instanceof Error ? error.message : String(error) });
    } else {
      steer.decided = "unknown";
      steer.confirm({ outcome: "unknown" });
    }
  }

  private finishTurn(conversation: Conversation, process: AcpProcess, turn: Turn, outcome: PromptOutcome): void {
    if (turn.ended) return;
    if (outcome.result) {
      // A cancelled carrying prompt is the observed Stop: the whole turn,
      // steered part included, ends interrupted.
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
    // Steers still undecided when the turn ends (its process exited) were
    // never answered: their outcome stays unknown.
    for (const state of turn.prompts.values()) if (state.steer && !state.steer.decided) { state.steer.decided = "unknown"; state.steer.confirm({ outcome: "unknown" }); }
    turn.token.completed = true;
    const now = this.now();
    const memory = conversation.memory;
    const updates = sealOpenBlock(memory, now);
    const carrierId = `${conversation.sessionId}.t${turn.userIndex}`;
    const model = memory.model;
    const hasUsage = Object.keys(turn.usage).length > 0;
    if (hasUsage) updates.push(this.usageCarrier(conversation, carrierId, turn.usage, model, now));
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
    // ACP's per-prompt usage is unstable; when agy reported none for the
    // turn, its transcript's tokens for the same request stand in (D10).
    // Never both, so nothing is counted twice.
    if (!hasUsage) void this.usageFromTranscript(conversation, turn, carrierId, model);
    this.scheduleIdle(conversation);
  }

  /** A turn's usage carrier, priced from the built-in table (D11), with its accounting. */
  private usageCarrier(conversation: Conversation, carrierId: string, tokens: TokenUsage, model: ModelSelection | undefined, now: number): NormalizedProviderEvent["updates"][number] {
    // An unpriced model leaves the cost absent, which is not zero.
    const costUsd = priceTurn(tokens, model?.modelId, this.prices);
    const usage: TokenUsage = { ...tokens, ...(costUsd !== undefined ? { costUsd } : {}) };
    conversation.accounting.push({ messageId: carrierId, createdAt: now, usage, ...(model ? { model: model.modelId } : {}) });
    return { kind: "upsert", item: { id: `usage:${carrierId}`, type: "assistant_message", createdAt: now, markdown: "", usage, ...(model ? { model } : {}) } };
  }

  private async usageFromTranscript(conversation: Conversation, turn: Turn, carrierId: string, model: ModelSelection | undefined): Promise<void> {
    const read = await readSessionTranscript(this.homeDirectory, conversation.sessionId);
    if (!("steps" in read) || this.disposed) return;
    // Every input the turn carried: its opening prompt and each steer agy
    // took, each a turn of its own in the transcript, matched by its words.
    const inputs = [{ position: turn.userIndex, text: turn.request }, ...[...turn.prompts.values()]
      .flatMap(state => state.steer?.decided === "accepted" && state.steer.position !== undefined ? [{ position: state.steer.position, text: state.steer.text }] : [])];
    const recordedTurns = transcriptTurns(read.steps);
    const tokens: TokenUsage = {};
    let recordedModelId: string | undefined;
    for (const input of inputs) {
      const recorded = recordedTurns[input.position - 1];
      if (!recorded || recorded.request !== input.text.trim()) return;
      for (const key of ["input", "output", "cacheRead"] as const) {
        if (recorded.usage?.[key] !== undefined) tokens[key] = (tokens[key] ?? 0) + recorded.usage[key]!;
      }
      recordedModelId = recorded.model ?? recordedModelId;
    }
    if (Object.keys(tokens).length === 0) return;
    const recordedModel = recordedModelId ? { providerId: ANTIGRAVITY_PROVIDER_ID, modelId: transcriptModelFamily(recordedModelId, id => this.knownModel(id)) } : model;
    const update = this.usageCarrier(conversation, carrierId, tokens, recordedModel, this.now());
    this.emit(conversation, { updates: [update], outcome: "handled", eventType: "transcript.usage", assistantUsage: { messageId: carrierId, usage: (update as { item: { usage: TokenUsage } }).item.usage } });
  }

  private knownModel(id: string): boolean {
    return this.catalog?.models.some(model => model.selection.modelId === id) === true || ratesFor(id, this.prices) !== undefined;
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
    conversation.idle?.();
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
      await withDeadline(process.ready, this.setupDeadlineMs, "initialize");
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
      const value = await withDeadline(read(process), this.setupDeadlineMs, "session/list");
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
      // Checked against a fresh listing, not the cache: a cached id agy has
      // since dropped would load "successfully" and break the next prompt.
      // Positive evidence only: agy must list the id (an unavailable
      // listing fails the load rather than vouching for it).
      if (!(await this.inventory()).some(session => session.id === conversation.sessionId)) {
        throw new ConversationNotFoundError();
      }
      const process = await this.startProcess();
      conversation.loading = true;
      if (!conversation.seeded || conversation.fromTranscript) conversation.replay = { memory: createAcpMemory(conversation.sessionId, this.workspacePath), items: [] };
      try {
        const answer = await withDeadline(process.agent.request("session/load", { sessionId: conversation.sessionId, cwd: this.workspacePath, mcpServers: [] }), this.setupDeadlineMs, "session/load");
        this.setLogin("ok");
        this.learnCatalog(answer);
        // agy starts a loaded session on its own defaults (design D7).
        conversation.applied = catalogFromSession(answer, false, id => this.knownModel(id)).current;
        conversation.configuration = { ...conversation.applied, ...conversation.configuration };
      } catch (error) {
        conversation.replay = undefined;
        await this.closeProcess(process);
        if (rpcErrorCode(error) === AUTH_REQUIRED_CODE) this.setLogin("missing");
        throw error;
      } finally {
        conversation.loading = false;
      }
      const replay = conversation.replay;
      conversation.replay = undefined;
      if (replay) {
        conversation.fromTranscript = undefined;
        conversation.version = randomUUID();
        applyUpdates(replay.items, sealOpenBlock(replay.memory, this.now()));
        conversation.items.splice(0, conversation.items.length, ...replay.items);
        conversation.accounting.splice(0);
        Object.assign(conversation.memory, replay.memory);
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

  /** History from the transcript alone, when agy cannot load the conversation. */
  private async seedFromTranscript(conversation: Conversation): Promise<boolean> {
    const read = await readSessionTranscript(this.homeDirectory, conversation.sessionId);
    if (!("steps" in read)) return false;
    const items = historyFromTranscript(read.steps, conversation.sessionId, this.now());
    // The same transcript gives the same history, so cursors stay valid
    // between reads; a changed one is another history.
    conversation.version = `transcript:${Bun.hash(JSON.stringify(read.steps))}`;
    conversation.items.splice(0, conversation.items.length, ...items);
    conversation.accounting.splice(0);
    const memory = conversation.memory;
    memory.userCount = items.filter(item => item.type === "user_message").length;
    memory.blockCount = 0;
    await this.enrichFromTranscript(conversation);
    conversation.seeded = true;
    conversation.fromTranscript = true;
    return true;
  }

  /** Add what replay omits from agy's transcript, or leave replay as it is (design D10). */
  private async enrichFromTranscript(conversation: Conversation): Promise<void> {
    const read = await readSessionTranscript(this.homeDirectory, conversation.sessionId);
    const known = (id: string) => this.knownModel(id);
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
      // As on release: the history went with the process, and the next read
      // loads it again rather than serving rows that may have shifted.
      this.forgetHistory(conversation);
    });
  }

  private scheduleIdle(conversation: Conversation): void {
    conversation.idle?.();
    conversation.idle = undefined;
    if (!conversation.process || conversation.turn || conversation.permissions > 0 || conversation.holds > 0 || this.disposed) return;
    conversation.idle = this.idleTimer(() => {
      const process = conversation.process;
      if (!process || conversation.turn || conversation.permissions > 0 || conversation.holds > 0) return;
      conversation.process = undefined;
      conversation.applied = null;
      // uatu keeps no copy of its own (D10): the history goes with the
      // process, and the next read loads it again, replay and transcript.
      this.forgetHistory(conversation);
      void this.closeProcess(process);
    }, this.idleReleaseMs);
  }

  private refreshAdvertisedLevels(configOptions: unknown): void {
    if (!this.catalog) return;
    const next = withAdvertisedLevels(this.catalog, configOptions);
    if (next === this.catalog || JSON.stringify(next.models) === JSON.stringify(this.catalog.models)) return;
    this.catalog = next;
    this.publish({ updates: [], outcome: "handled", eventType: "catalog", catalogsChanged: true });
  }

  private forgetHistory(conversation: Conversation): void {
    conversation.seeded = false;
    conversation.fromTranscript = undefined;
    conversation.items.splice(0);
    conversation.accounting.splice(0);
    conversation.version = randomUUID();
    Object.assign(conversation.memory, createAcpMemory(conversation.sessionId, this.workspacePath));
  }

  private async applyConfiguration(conversation: Conversation, process: AcpProcess, input: { model?: ModelSelection; mode?: string; variant?: string }): Promise<void> {
    const chosen = conversation.configuration;
    const model = input.model ?? chosen.model;
    const wantedVariant = input.model ? input.variant : input.variant ?? chosen.variant;
    let variant = model ? variantFor(this.catalog, model.modelId, wantedVariant) : undefined;
    const mode = input.mode ?? chosen.mode;
    const sessionId = conversation.sessionId;
    let applied = conversation.applied ?? {};
    const modelChanged = model !== undefined && applied.model?.modelId !== model.modelId;
    if (model && this.catalog?.selection === "legacy") {
      // No config options: the legacy id names the model and its level (D7).
      if (modelChanged || applied.variant !== variant) {
        const legacyId = legacyModelId(this.catalog, model.modelId, variant);
        if (!legacyId) throw new UnsupportedVariantSelectionError(`Antigravity offers no model id for ${model.modelId}`);
        await process.agent.request<unknown>("session/set_model", { sessionId, modelId: legacyId });
        applied = { ...applied, model, ...(variant ? { variant } : {}) };
        if (!variant) delete applied.variant;
      }
    } else if (modelChanged) {
      const answer = await process.agent.request("session/set_config_option", { sessionId, configId: "model", value: model.modelId });
      applied = { ...applied, ...configurationFromOptions(answer.configOptions) };
      // The answer advertises the new model's thinking levels.
      this.refreshAdvertisedLevels(answer.configOptions);
      variant = variantFor(this.catalog, model.modelId, wantedVariant);
    }
    if (this.catalog?.selection !== "legacy" && variant && (modelChanged || applied.variant !== variant)) {
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
      const replay = conversation.replay;
      if (!replay) return;
      const normalized = normalizeAcpUpdate(params, replay.memory, this.now());
      applyUpdates(replay.items, normalized.updates);
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
    const fresh = catalogFromSession(answer, this.imageInput === true, id => this.knownModel(id));
    if (fresh.models.length === 0 && fresh.modes.length === 0) return;
    // Config options advertise only the current model's thinking levels:
    // levels learned earlier for another model stay with it.
    const learned = new Map((this.catalog?.models ?? []).flatMap(model => model.variants ? [[model.selection.modelId, model.variants] as const] : []));
    const catalog = fresh.legacyIds.length ? fresh : { ...fresh, models: fresh.models.map(model => model.variants || !learned.has(model.selection.modelId) ? model : { ...model, variants: learned.get(model.selection.modelId)! }) };
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
    applyUpdates(conversation.items, updates);
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
      conversation.idle?.();
      this.interactions.abandon(conversation.sessionId, INTERRUPTED_REASON);
    }
    const processes = [...this.processes];
    await Promise.all(processes.map(process => this.closeProcess(process)));
    await Promise.all(processes.map(process => process.settled));
    this.events_.close();
  }
}

/** The idle release on a timer that does not keep the process alive. */
function armIdleTimer(release: () => void, milliseconds: number): () => void {
  const timer = setTimeout(release, milliseconds);
  (timer as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
}

/** The promise's outcome, or a failure naming the step once the deadline passes. */
function withDeadline<T>(promise: Promise<T>, milliseconds: number, step: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Antigravity did not answer ${step} within ${Math.round(milliseconds / 1000)}s`)), milliseconds);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function applyUpdates(items: ConversationItem[], updates: NormalizedProviderEvent["updates"]): void {
  for (const update of updates) {
    if (update.kind === "upsert") {
      const index = items.findIndex(item => item.id === update.item.id);
      if (index >= 0) items[index] = update.item;
      else items.push(update.item);
    } else if (update.kind === "remove") {
      const index = items.findIndex(item => item.id === update.itemId);
      if (index >= 0) items.splice(index, 1);
    }
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
