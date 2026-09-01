import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";

import type {
  ChatProvider,
  NormalizedProviderEvent,
  PendingPermission,
  PendingQuestion,
  ProviderAttachment,
  ProviderHistoryPage,
  ProviderPermissionReply,
  ProviderSession,
} from "../provider";
import type { ChatAgent, ChatCommand, ChatMode, ChatModel, ConversationConfiguration, ModelSelection, PermissionRequest, QuestionRequest, StructuredQuestion } from "../types";
import { UnsupportedVariantSelectionError } from "../provider";
import { CLAUDE_MODELS, findClaudeModel } from "./models";
import { createClaudeEventMemory, normalizeClaudeMessage, normalizeTranscriptEntries } from "./normalization";
import { listTranscriptSessions, readSessionTranscript, sessionTranscriptPath, claudeConfigDir } from "./transcript";

/**
 * The slice of an SDK `Query` this provider drives. Narrow on purpose: tests
 * stage sessions with fakes, and the compiled binary talks to the user's own
 * `claude` through exactly these calls.
 */
export type ClaudeQueryHandle = AsyncIterable<unknown> & {
  interrupt(): Promise<unknown>;
  setPermissionMode?(mode: string): Promise<void>;
  setModel?(model?: string): Promise<void>;
  return?(value?: unknown): Promise<IteratorResult<unknown, void>>;
};

/** The SDK's PermissionResult, structurally. */
export type ClaudePermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export type ClaudeCanUseToolOptions = {
  signal: AbortSignal;
  suggestions?: unknown[];
  blockedPath?: string;
  title?: string;
  displayName?: string;
  toolUseID?: string;
};

export type ClaudeQueryInput = {
  prompt: AsyncIterable<ClaudeUserEnvelope>;
  options: {
    cwd: string;
    resume?: string;
    sessionId?: string;
    pathToClaudeCodeExecutable?: string;
    enableFileCheckpointing: boolean;
    permissionMode?: string;
    model?: string;
    effort?: string;
    canUseTool?: (toolName: string, input: Record<string, unknown>, options: ClaudeCanUseToolOptions) => Promise<ClaudePermissionResult>;
  };
};

export type ClaudeUserEnvelope = {
  type: "user";
  message: { role: "user"; content: Array<Record<string, unknown>> };
  parent_tool_use_id: null;
  session_id: string;
};

export type ClaudeProviderOptions = {
  workspacePath: string;
  /** The user's own `claude`, from the runtime's discovery — never the SDK's vendored sidecar (D1/1.2). */
  executable: string;
  configDir?: string;
  /**
   * Serve-level operator opt-in (spec: modes that bypass permission
   * prompting MUST NOT be offered without it). Off by default.
   */
  offerBypassPermissions?: boolean;
  queryFactory?: (input: ClaudeQueryInput) => ClaudeQueryHandle;
  now?: () => number;
};

const DEFAULT_TITLE = "New conversation";
const TITLE_LIMIT = 80;

type LiveSession = {
  id: string;
  queue: PushQueue<ClaudeUserEnvelope>;
  query: ClaudeQueryHandle;
  reader: Promise<void>;
};

/**
 * The Claude Code chat provider: one SDK `query()` session per live
 * conversation, resumed by native session id; idle conversations hold no
 * process (spec: a Claude Code conversation runs as its own agent session).
 * Enumeration and history read native session storage (D6); the live path
 * never does.
 */
export class ClaudeProvider implements ChatProvider {
  private readonly workspacePath: string;
  private readonly executable: string;
  private readonly configDir: string;
  private readonly queryFactory: (input: ClaudeQueryInput) => ClaudeQueryHandle;
  private readonly offerBypassPermissions: boolean;
  private readonly now: () => number;
  // Slash commands as the last session's init message reported them; empty
  // until a session has run — a normal declared-but-empty state.
  private commands: ChatCommand[] = [];

  private readonly live = new Map<string, LiveSession>();
  // Sessions created but never prompted: they exist only here until the SDK
  // writes their first transcript entry.
  private readonly pending = new Map<string, ProviderSession>();
  private readonly configurations = new Map<string, ConversationConfiguration>();
  // Tool approvals the SDK is waiting on, held here (the inverse of
  // OpenCode's server-held list — D5). Keyed by request id; each remembers
  // how to settle its callback and the card it published.
  private readonly interactions = new Map<string, PendingInteraction>();
  private readonly events_ = new PushQueue<NormalizedProviderEvent>();
  private disposed = false;

  constructor(options: ClaudeProviderOptions) {
    this.workspacePath = options.workspacePath;
    this.executable = options.executable;
    this.configDir = options.configDir ?? claudeConfigDir();
    this.queryFactory = options.queryFactory ?? defaultQueryFactory;
    this.offerBypassPermissions = options.offerBypassPermissions === true;
    this.now = options.now ?? (() => Date.now());
  }

  describe(): ChatAgent {
    // Extended one capability at a time by the task that implements it.
    return { id: "claude", name: "Claude Code", capabilities: ["context", "permissions", "questions", "models", "modes", "variants", "commands", "attachments"] };
  }

  async listCommands(): Promise<ChatCommand[]> { return this.commands; }
  async listModels(): Promise<ChatModel[]> { return CLAUDE_MODELS; }

  /**
   * Permission modes are the ways of working (D5). `bypassPermissions` is
   * offered only behind the serve-level operator opt-in.
   */
  async listModes(): Promise<ChatMode[]> {
    return [
      { name: "default", description: "Ask before running tools that need permission" },
      { name: "acceptEdits", description: "Apply file edits without asking; other tools still prompt" },
      { name: "plan", description: "Read-only planning; present a plan before making changes" },
      ...(this.offerBypassPermissions
        ? [{ name: "bypassPermissions", description: "Run every tool without permission prompts (operator-enabled)" }]
        : []),
    ];
  }

  async switchModel(sessionId: string, selection: ModelSelection, variant?: string): Promise<void> {
    if (variant !== undefined) {
      const model = findClaudeModel(selection.modelId);
      if (!model?.variants?.includes(variant)) {
        throw new UnsupportedVariantSelectionError(`model ${selection.modelId} does not offer effort level ${variant}`);
      }
    }
    const previous = this.configurations.get(sessionId);
    const configuration = { ...previous, model: selection, ...(variant ? { variant } : {}) };
    if (!variant) delete configuration.variant;
    this.configurations.set(sessionId, configuration);
    await this.live.get(sessionId)?.query.setModel?.(selection.modelId);
  }

  async listSessions(): Promise<ProviderSession[]> {
    const { sessions } = await listTranscriptSessions(this.workspacePath, this.configDir);
    const stored = sessions.map(session => ({
      id: session.id,
      title: deriveTitle(session.firstPrompt),
      directory: this.workspacePath,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }));
    const onDisk = new Set(stored.map(session => session.id));
    const fresh = [...this.pending.values()].filter(session => !onDisk.has(session.id));
    return [...fresh, ...stored];
  }

  async newConversationConfiguration(): Promise<ConversationConfiguration> {
    return {};
  }

  async createSession(_id: string, configuration: ConversationConfiguration = {}): Promise<ProviderSession> {
    // The SDK requires a UUID session id; the adapter's suggestion is not
    // one, so the provider mints its own (same as the OpenCode provider).
    const id = randomUUID();
    const created = this.now();
    const session: ProviderSession = { id, title: DEFAULT_TITLE, directory: this.workspacePath, createdAt: created, updatedAt: created };
    this.pending.set(id, session);
    this.configurations.set(id, configuration);
    this.events_.push({
      conversationId: id,
      updates: [],
      outcome: "handled",
      eventType: "session.created",
      sessionLifecycle: { kind: "created", id, directory: this.workspacePath, title: session.title },
    });
    return session;
  }

  async getSession(id: string): Promise<ProviderSession | null> {
    const fresh = this.pending.get(id);
    if (fresh) return fresh;
    return (await this.listSessions()).find(session => session.id === id) ?? null;
  }

  async getConversationConfiguration(sessionId: string): Promise<ConversationConfiguration> {
    return this.configurations.get(sessionId) ?? {};
  }

  async listMessages(sessionId: string, options: { cursor?: string; limit: number }): Promise<ProviderHistoryPage> {
    let entries: Awaited<ReturnType<typeof readSessionTranscript>>["entries"] = [];
    try {
      entries = (await readSessionTranscript(sessionTranscriptPath(this.workspacePath, sessionId, this.configDir))).entries;
    } catch {
      // No transcript yet: a fresh conversation's history is empty.
      if (!this.pending.has(sessionId) && !this.live.has(sessionId)) throw new Error(`unknown Claude conversation: ${sessionId}`);
    }
    const mainline = entries.filter(entry => !entry.isSidechain);
    const { items, accounting } = normalizeTranscriptEntries(mainline);
    // Local paging over the fully read transcript, same shape as the
    // OpenCode provider: cursor is the exclusive end index.
    const end = clampIndex(options.cursor, items.length);
    const start = Math.max(0, end - Math.max(1, options.limit));
    const ids = new Set(items.slice(start, end).map(item => item.id));
    return {
      items: items.slice(start, end),
      accounting: accounting.filter(entry => ids.has(`usage:${entry.messageId}`) || ids.has(`message:${entry.messageId}`)),
      completeItems: items,
      nextCursor: start > 0 ? String(start) : undefined,
    };
  }

  async *events(signal: AbortSignal): AsyncIterable<NormalizedProviderEvent> {
    const stop = () => this.events_.close();
    signal.addEventListener("abort", stop, { once: true });
    try {
      yield* this.events_;
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }

  async prompt(sessionId: string, input: { id: string; text: string; delivery: "queue"; attachments?: ProviderAttachment[]; model?: ModelSelection; mode?: string; variant?: string }): Promise<{ messageId: string }> {
    if (this.disposed) throw new Error("Claude provider is disposed");
    if (input.mode !== undefined) {
      const modes = await this.listModes();
      if (!modes.some(candidate => candidate.name === input.mode)) {
        throw new Error(`Claude Code does not offer the mode ${input.mode}`);
      }
    }
    const alreadyLive = this.live.get(sessionId);
    const session = await this.ensureLive(sessionId, input.model, input.mode, input.variant);
    if (input.model) await this.switchModel(sessionId, input.model, input.variant);
    if (input.mode !== undefined) {
      const configuration = { ...this.configurations.get(sessionId), mode: input.mode };
      this.configurations.set(sessionId, configuration);
      // A session that already existed switches live; a fresh one was
      // created with the mode in its options.
      if (alreadyLive) await alreadyLive.query.setPermissionMode?.(input.mode);
    }
    // Images ride the prompt as base64 blocks read from the workspace's
    // attachment store; the store, bounds, and upload routes are shared
    // across agents (D5) — only this delivery is Claude-shaped.
    const content: Array<Record<string, unknown>> = [];
    for (const attachment of input.attachments ?? []) {
      const bytes = await fs.readFile(attachment.absolutePath);
      content.push({
        type: "image",
        source: { type: "base64", media_type: attachment.mimeType, data: bytes.toString("base64") },
      });
    }
    if (input.text) content.push({ type: "text", text: input.text });
    if (content.length === 0) content.push({ type: "text", text: "" });
    const acceptedAt = this.now();
    // The provider mints the user's timeline item at accept time; the SDK's
    // own echo is skipped by the live normalizer.
    this.emit(sessionId, {
      updates: [
        { kind: "upsert", item: {
          id: `message:${input.id}`,
          type: "user_message",
          createdAt: acceptedAt,
          text: input.text,
          requestId: input.id,
          ...(input.attachments?.length
            ? { attachments: input.attachments.map(attachment => ({ id: attachment.id, name: attachment.name, mimeType: attachment.mimeType })) }
            : {}),
        } },
        { kind: "status", status: "running" },
      ],
      outcome: "handled",
      eventType: "prompt.accepted",
    });
    this.retitleFromFirstPrompt(sessionId, input.text);
    session.queue.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: sessionId,
    });
    return { messageId: input.id };
  }

  async command(): Promise<{ messageId: string }> {
    throw new Error("Claude Code slash commands are not supported yet");
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.live.get(sessionId);
    if (!session) return;
    await session.query.interrupt();
    this.emit(sessionId, {
      updates: [{ kind: "status", status: "interrupted" }],
      outcome: "handled",
      eventType: "turn.interrupted",
    });
  }

  async replyPermission(sessionId: string, requestId: string, reply: ProviderPermissionReply): Promise<void> {
    const pending = this.requireInteraction(sessionId, requestId, "permission");
    if (reply === "reject") {
      pending.settle({ behavior: "deny", message: "The user denied this action." });
      return;
    }
    // "Always" returns the SDK's own suggestions, but only those scoped to
    // the session: an approval uatu brokered must never outlive the session
    // it was given in (D5: map conservatively).
    const updatedPermissions = reply === "always" ? sessionScopedSuggestions(pending.suggestions) : undefined;
    pending.settle({
      behavior: "allow",
      updatedInput: pending.input,
      ...(updatedPermissions && updatedPermissions.length > 0 ? { updatedPermissions } : {}),
    });
  }

  async replyQuestion(sessionId: string, requestId: string, answers: string[][]): Promise<void> {
    const pending = this.requireInteraction(sessionId, requestId, "question");
    // AskUserQuestion expects answers keyed by the full question text on its
    // own input; a multi-select answer joins its labels.
    const record: Record<string, string> = {};
    (pending.questionTexts ?? []).forEach((text, index) => {
      record[text] = (answers[index] ?? []).join(", ");
    });
    pending.settle({ behavior: "allow", updatedInput: { ...pending.input, answers: record } });
  }

  async rejectQuestion(sessionId: string, requestId: string): Promise<void> {
    const pending = this.requireInteraction(sessionId, requestId, "question");
    pending.settle({ behavior: "deny", message: "The user declined to answer." });
  }

  /**
   * The pending sets, for the adapter's reconnect recovery: a request whose
   * live announcement a client missed is otherwise unknowable.
   */
  async listPermissions(): Promise<PendingPermission[]> {
    return [...this.interactions.values()]
      .filter(pending => pending.kind === "permission")
      .map(pending => ({
        requestId: pending.requestId,
        conversationId: pending.conversationId,
        action: (pending.item as PermissionRequest).action,
        resources: (pending.item as PermissionRequest).resources,
      }));
  }

  async listQuestions(): Promise<PendingQuestion[]> {
    return [...this.interactions.values()]
      .filter(pending => pending.kind === "question")
      .map(pending => ({
        requestId: pending.requestId,
        conversationId: pending.conversationId,
        questions: (pending.item as QuestionRequest).questions,
      }));
  }

  /**
   * Ends every live session and its child process. Dispose is the only exit
   * that skips the SDK's own turn-completion path, so it interrupts first
   * and then closes the input stream — the generator ending is what lets
   * the SDK shut the child down (leak test: no process outlives this).
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    const sessions = [...this.live.values()];
    this.live.clear();
    for (const session of sessions) this.abandonInteractions(session.id, "The workspace shut down before the user answered.");
    await Promise.all(sessions.map(async session => {
      await session.query.interrupt().catch(() => undefined);
      session.queue.close();
      await session.query.return?.().catch(() => undefined);
      await session.reader.catch(() => undefined);
    }));
    this.events_.close();
  }

  /** Exposed for the service seam: how many sessions hold a live process. */
  liveSessionCount(): number {
    return this.live.size;
  }

  private async ensureLive(sessionId: string, model?: ModelSelection, mode?: string, variant?: string): Promise<LiveSession> {
    const existing = this.live.get(sessionId);
    if (existing) return existing;
    const known = this.pending.has(sessionId) || await this.getSession(sessionId);
    if (!known) throw new Error(`unknown Claude conversation: ${sessionId}`);
    const hasTranscript = await fs.access(sessionTranscriptPath(this.workspacePath, sessionId, this.configDir)).then(() => true, () => false);
    const queue = new PushQueue<ClaudeUserEnvelope>();
    const configuration = this.configurations.get(sessionId) ?? {};
    const query = this.queryFactory({
      prompt: queue,
      options: {
        cwd: this.workspacePath,
        // Resume continues the native session; a never-prompted conversation
        // instead claims its pre-minted id so the transcript lands under it.
        ...(hasTranscript ? { resume: sessionId } : { sessionId }),
        pathToClaudeCodeExecutable: this.executable,
        enableFileCheckpointing: true,
        ...((mode ?? configuration.mode) ? { permissionMode: (mode ?? configuration.mode)! } : {}),
        ...((model ?? configuration.model) ? { model: (model ?? configuration.model)!.modelId } : {}),
        // Effort is applied when the session starts; a variant staged while
        // the session is live takes effect on the next session start.
        ...((variant ?? configuration.variant) ? { effort: (variant ?? configuration.variant)! } : {}),
        canUseTool: (toolName, input, options) => this.brokerToolUse(sessionId, toolName, input, options),
      },
    });
    const session: LiveSession = { id: sessionId, queue, query, reader: Promise.resolve() };
    session.reader = this.readSession(session);
    this.live.set(sessionId, session);
    return session;
  }

  private async readSession(session: LiveSession): Promise<void> {
    const memory = createClaudeEventMemory();
    try {
      for await (const message of session.query) {
        this.captureCommands(message);
        const normalized = normalizeClaudeMessage(message, memory, "live");
        this.emit(session.id, normalized);
      }
      // The stream ended without dispose: the session's process is gone.
      if (!this.disposed && this.live.get(session.id) === session) {
        this.live.delete(session.id);
        this.abandonInteractions(session.id, "The session ended before the user answered.");
      }
    } catch (error) {
      if (this.disposed || this.live.get(session.id) !== session) return;
      this.live.delete(session.id);
      this.abandonInteractions(session.id, "The session failed before the user answered.");
      this.emit(session.id, {
        updates: [
          { kind: "upsert", item: { id: `notice:session-error:${this.now()}`, type: "notice", createdAt: this.now(), level: "error", message: error instanceof Error ? error.message : "Claude Code session failed" } },
          { kind: "status", status: "failed", message: "Claude Code session ended unexpectedly" },
        ],
        outcome: "handled",
        eventType: "session.failed",
      });
    }
  }

  /**
   * The SDK's tool-approval callback, classified (D5): `AskUserQuestion`
   * becomes a structured question card; everything else a permission card.
   * The returned promise settles when the user answers, when the turn is
   * interrupted (the SDK aborts the signal), or when the session ends.
   */
  private brokerToolUse(sessionId: string, toolName: string, input: Record<string, unknown>, options: ClaudeCanUseToolOptions): Promise<ClaudePermissionResult> {
    const requestId = options.toolUseID ?? randomUUID();
    const createdAt = this.now();
    return new Promise<ClaudePermissionResult>(resolve => {
      const questions = toolName === "AskUserQuestion" ? normalizeAskUserQuestions(input) : null;
      const item: PermissionRequest | QuestionRequest = questions
        ? { id: `question:${requestId}`, type: "question", createdAt, requestId, questions, status: "pending" }
        : {
          id: `permission:${requestId}`,
          type: "permission",
          createdAt,
          requestId,
          action: options.title ?? options.displayName ?? toolName,
          resources: permissionResources(input, options),
          status: "pending",
        };
      const settle = (result: ClaudePermissionResult, resolution?: "answered") => {
        if (!this.interactions.has(requestId)) return;
        this.interactions.delete(requestId);
        options.signal.removeEventListener("abort", onAbort);
        // The adapter publishes resolutions it brokered itself; only an
        // unanswered end (abort, session death) must resolve the card here.
        if (resolution !== "answered") {
          this.emit(sessionId, {
            updates: [{ kind: "upsert", item: questions
              ? { ...(item as QuestionRequest), status: "resolved", outcome: { kind: "rejected" } }
              : { ...(item as PermissionRequest), status: "resolved", outcome: "rejected" } }],
            outcome: "handled",
            eventType: "interaction.abandoned",
          });
        }
        resolve(result);
      };
      const onAbort = () => settle({ behavior: "deny", message: "The turn was interrupted before the user answered." });
      options.signal.addEventListener("abort", onAbort, { once: true });
      this.interactions.set(requestId, {
        requestId,
        conversationId: sessionId,
        kind: questions ? "question" : "permission",
        item,
        input,
        suggestions: options.suggestions,
        ...(questions ? { questionTexts: questions.map(question => question.prompt) } : {}),
        settle: result => settle(result, "answered"),
        abandon: reason => settle({ behavior: "deny", message: reason }),
      });
      this.emit(sessionId, { updates: [{ kind: "upsert", item }], outcome: "handled", eventType: "interaction.requested" });
    });
  }

  private requireInteraction(sessionId: string, requestId: string, kind: "permission" | "question"): PendingInteraction {
    const pending = this.interactions.get(requestId);
    if (!pending || pending.conversationId !== sessionId || pending.kind !== kind) {
      throw new Error(`no pending ${kind} ${requestId} for this conversation`);
    }
    return pending;
  }

  /** A session that ends cannot answer: its pending cards resolve visibly. */
  private abandonInteractions(sessionId: string, reason: string): void {
    for (const pending of [...this.interactions.values()]) {
      if (pending.conversationId === sessionId) pending.abandon(reason);
    }
  }

  private emit(conversationId: string, normalized: Omit<NormalizedProviderEvent, "conversationId">): void {
    this.events_.push({ ...normalized, conversationId });
  }

  /** The init message names the session's slash commands; keep the latest. */
  private captureCommands(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (record.type !== "system" || record.subtype !== "init" || !Array.isArray(record.slash_commands)) return;
    this.commands = record.slash_commands
      .filter((name): name is string => typeof name === "string" && name.length > 0)
      .map(name => ({ name, description: "", argumentHint: "", kind: "command" as const }));
  }

  private retitleFromFirstPrompt(sessionId: string, text: string): void {
    const pending = this.pending.get(sessionId);
    if (!pending || pending.title !== DEFAULT_TITLE) return;
    const title = deriveTitle(text);
    const updated = { ...pending, title, updatedAt: this.now() };
    this.pending.set(sessionId, updated);
    this.emit(sessionId, {
      updates: [],
      outcome: "handled",
      eventType: "session.updated",
      sessionLifecycle: { kind: "updated", id: sessionId, directory: this.workspacePath, title },
    });
  }
}

function deriveTitle(firstPrompt: string | null): string {
  const collapsed = (firstPrompt ?? "").replace(/\s+/g, " ").trim();
  if (!collapsed) return DEFAULT_TITLE;
  return collapsed.length > TITLE_LIMIT ? `${collapsed.slice(0, TITLE_LIMIT - 1)}…` : collapsed;
}

function clampIndex(cursor: string | undefined, length: number): number {
  if (cursor === undefined) return length;
  const parsed = Number.parseInt(cursor, 10);
  if (Number.isNaN(parsed)) throw new Error("invalid history cursor");
  return Math.max(0, Math.min(parsed, length));
}

type PendingInteraction = {
  requestId: string;
  conversationId: string;
  kind: "permission" | "question";
  item: PermissionRequest | QuestionRequest;
  input: Record<string, unknown>;
  suggestions: unknown[] | undefined;
  questionTexts?: string[];
  settle: (result: ClaudePermissionResult) => void;
  abandon: (reason: string) => void;
};

/** Only session-destination suggestions survive: never persist an allow. */
function sessionScopedSuggestions(suggestions: unknown[] | undefined): unknown[] | undefined {
  if (!suggestions) return undefined;
  return suggestions.filter(suggestion =>
    Boolean(suggestion) && typeof suggestion === "object"
    && (suggestion as { destination?: unknown }).destination === "session");
}

/** AskUserQuestion input → the shared structured-question shape. */
function normalizeAskUserQuestions(input: Record<string, unknown>): StructuredQuestion[] | null {
  if (!Array.isArray(input.questions) || input.questions.length === 0) return null;
  const questions: StructuredQuestion[] = [];
  for (const value of input.questions) {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (typeof record.question !== "string") return null;
    const options = Array.isArray(record.options)
      ? record.options.flatMap(option => {
        if (!option || typeof option !== "object") return [];
        const optionRecord = option as Record<string, unknown>;
        if (typeof optionRecord.label !== "string") return [];
        return [{ label: optionRecord.label, description: typeof optionRecord.description === "string" ? optionRecord.description : "" }];
      })
      : [];
    questions.push({
      prompt: record.question,
      header: typeof record.header === "string" ? record.header : "",
      options,
      multiple: record.multiSelect === true,
      // Claude Code's "Other" free-form entry is host-provided, not an
      // option in the schema — the host always offers it.
      allowFreeForm: true,
    });
  }
  return questions;
}

function permissionResources(input: Record<string, unknown>, options: ClaudeCanUseToolOptions): string[] {
  const resources: string[] = [];
  if (typeof options.blockedPath === "string") resources.push(options.blockedPath);
  for (const key of ["file_path", "path", "notebook_path", "url", "command"]) {
    if (typeof input[key] === "string" && input[key]) resources.push(input[key] as string);
  }
  return [...new Set(resources)];
}

/** An async queue that producers push into and one consumer iterates. */
class PushQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise(resolve => this.waiters.push(resolve));
      },
      return: async (): Promise<IteratorResult<T>> => {
        this.close();
        return { value: undefined as never, done: true };
      },
    };
  }
}

function defaultQueryFactory(input: ClaudeQueryInput): ClaudeQueryHandle {
  // Imported lazily-by-name at module scope would pull the SDK into every
  // consumer; the provider is only constructed when the Claude agent is
  // registered, so a direct import here is the bundle boundary.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { query } = require("@anthropic-ai/claude-agent-sdk") as typeof import("@anthropic-ai/claude-agent-sdk");
  return query(input as never) as unknown as ClaudeQueryHandle;
}
