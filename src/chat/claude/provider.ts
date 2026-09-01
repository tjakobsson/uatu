import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

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
import type { ChatAgent, ChatCommand, ChatMode, ChatModel, ConversationConfiguration, ModelSelection, PermissionRequest, QuestionRequest, ReversibleHistoryResult, ReversibleHistoryState, StructuredQuestion } from "../types";
import { ReversibleHistoryTargetError, UnsupportedVariantSelectionError } from "../provider";
import { CLAUDE_MODELS, claudeContextWindow, findClaudeModel } from "./models";
import { createClaudeEventMemory, normalizeClaudeMessage, normalizeTranscriptEntries } from "./normalization";
import { listTranscriptSessions, readSessionTranscript, sessionTranscriptPath, subagentTranscriptPath, claudeConfigDir } from "./transcript";

/**
 * The slice of an SDK `Query` this provider drives. Narrow on purpose: tests
 * stage sessions with fakes, and the compiled binary talks to the user's own
 * `claude` through exactly these calls.
 */
export type ClaudeRewindFilesResult = {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
};

export type ClaudeQueryHandle = AsyncIterable<unknown> & {
  interrupt(): Promise<unknown>;
  setPermissionMode?(mode: string): Promise<void>;
  setModel?(model?: string): Promise<void>;
  applyFlagSettings?(settings: Record<string, unknown>): Promise<void>;
  supportedModels?(): Promise<unknown>;
  supportedCommands?(): Promise<unknown>;
  rewindFiles?(userMessageId: string, options?: { dryRun?: boolean }): Promise<ClaudeRewindFilesResult>;
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
  /**
   * Hydrate the model catalog from a short-lived promptless probe session
   * on the first picker read (on by default; tests stage catalogs
   * explicitly instead).
   */
  catalogProbe?: boolean;
  /** Conversation rewind: fork the native session up to a boundary (D8). */
  forkSession?: (sessionId: string, options: { upToMessageId: string; dir: string }) => Promise<{ sessionId: string }>;
  /**
   * Durable per-workspace state (conversation configurations, fork
   * redirections) — uatu's own XDG state home by default; never Claude
   * Code's storage.
   */
  stateFile?: string;
  now?: () => number;
};

const DEFAULT_TITLE = "New conversation";
const CATALOG_PROBE_TIMEOUT_MS = 20_000;
const CATALOG_PROBE_COOLDOWN_MS = 60_000;
const TITLE_LIMIT = 80;

type LiveSession = {
  id: string;
  queue: PushQueue<ClaudeUserEnvelope>;
  query: ClaudeQueryHandle;
  reader: Promise<void>;
  // Turns accepted but not yet terminally reported. The queue cannot be
  // peeked for this — the SDK consumes envelopes eagerly — so the provider
  // counts what it accepted and what results retired.
  pendingTurns: number;
  // Set by interrupt(): the turn's terminal result reports the user's
  // cancellation, not a failure of its own.
  interrupted?: boolean;
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
  // The CLI's own model catalog, captured from the first live session. It is
  // the authority on context windows (including the [1m] variants) and
  // per-model effort levels; the static manifest only covers the moment
  // before any session has run.
  private liveModels: ChatModel[] | null = null;
  private modelAliases = new Map<string, string>();
  private readonly catalogProbe: boolean;
  private hydration: Promise<void> | null = null;
  private probeFailedAt: number | null = null;
  private probeQuery: ClaudeQueryHandle | null = null;

  private readonly live = new Map<string, LiveSession>();
  // Sessions created but never prompted: they exist only here until the SDK
  // writes their first transcript entry.
  private readonly pending = new Map<string, ProviderSession>();
  private readonly configurations = new Map<string, ConversationConfiguration>();
  // Tool approvals the SDK is waiting on, held here (the inverse of
  // OpenCode's server-held list — D5). Keyed by request id; each remembers
  // how to settle its callback and the card it published.
  private readonly interactions = new Map<string, PendingInteraction>();
  // The mode a conversation ran before entering plan, for the
  // "implement and return to the previous mode" intent (D5).
  private readonly modeBeforePlan = new Map<string, string>();
  // Reversible history (D8). A staged revert hides turns and has already
  // rewound files to the boundary checkpoint; the tip snapshot holds the
  // bytes the first undo displaced, so a terminal redo can put the newest
  // state back truthfully. A committed revert forks the native session:
  // `activeNative` redirects the conversation to its fork, and the fork
  // itself stays out of the inventory.
  private readonly staged = new Map<string, { boundaryIndex: number; tipSnapshot: Map<string, string | null> }>();
  private readonly activeNative = new Map<string, string>();
  private readonly hiddenNative = new Set<string>();
  // Restart durability: modes/models/variants and fork redirections must
  // survive the workspace process, or a resumed conversation silently runs
  // the wrong mode and a committed revert resurrects its discarded turns.
  private readonly stateFile: string;
  private durableRestore: Promise<void> | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  private readonly forkSession: NonNullable<ClaudeProviderOptions["forkSession"]>;
  private readonly events_ = new PushQueue<NormalizedProviderEvent>();
  private disposed = false;

  constructor(options: ClaudeProviderOptions) {
    this.workspacePath = options.workspacePath;
    this.executable = options.executable;
    this.configDir = options.configDir ?? claudeConfigDir();
    this.queryFactory = options.queryFactory ?? defaultQueryFactory;
    this.offerBypassPermissions = options.offerBypassPermissions === true;
    this.catalogProbe = options.catalogProbe !== false;
    this.forkSession = options.forkSession ?? defaultForkSession;
    this.stateFile = options.stateFile ?? defaultStateFile(options.workspacePath);
    this.now = options.now ?? (() => Date.now());
  }

  describe(): ChatAgent {
    // Extended one capability at a time by the task that implements it.
    return { id: "claude", name: "Claude Code", capabilities: ["context", "permissions", "questions", "models", "modes", "variants", "commands", "attachments", "reversible-history", "subagents"] };
  }

  async listCommands(): Promise<ChatCommand[]> {
    // The command inventory lives on the control channel too: hydrate so a
    // cold read serves the real list rather than banking an empty one.
    await this.hydrateCatalog();
    return this.commands;
  }
  async listModels(): Promise<ChatModel[]> {
    await this.hydrateCatalog();
    return this.liveModels ?? CLAUDE_MODELS;
  }

  /**
   * The catalog only exists inside a running session (D5), so the first
   * picker read hydrates it from a promptless probe session: the picker is
   * live before any conversation has run, and the manifest is only the
   * failure fallback. Single-flight; a failed probe latches for a cooldown
   * so a broken install cannot be re-probed on every read.
   */
  private async hydrateCatalog(): Promise<void> {
    if (this.liveModels !== null || !this.catalogProbe || this.disposed) return;
    if (this.probeFailedAt !== null && this.now() - this.probeFailedAt < CATALOG_PROBE_COOLDOWN_MS) return;
    this.hydration ??= this.runCatalogProbe()
      .then(() => { this.probeFailedAt = null; })
      .catch(() => { this.probeFailedAt = this.now(); })
      .finally(() => { this.hydration = null; });
    await this.hydration;
  }

  private async runCatalogProbe(): Promise<void> {
    const queue = new PushQueue<ClaudeUserEnvelope>();
    try {
      // The workspace cwd on purpose: a promptless probe writes no
      // transcript (nothing to enumerate), and the command inventory must
      // include the workspace's own project commands.
      const query = this.queryFactory({
        prompt: queue,
        options: {
          cwd: this.workspacePath,
          pathToClaudeCodeExecutable: this.executable,
          enableFileCheckpointing: false,
        },
      });
      this.probeQuery = query;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // The control channel answers before any turn starts; a promptless
        // stream never emits init, so the catalog is requested immediately
        // while the message stream is merely drained to keep the pump alive.
        const drain = (async () => { for await (const message of query) this.captureCommands(message); })();
        drain.catch(() => undefined);
        await Promise.race([
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("catalog probe timed out")), CATALOG_PROBE_TIMEOUT_MS);
          }),
          this.captureModels(query),
        ]);
        // captureModels swallows its own failure; an empty catalog after a
        // "successful" probe is still a failed probe for latching purposes.
        if (this.liveModels === null) throw new Error("catalog probe answered nothing");
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        await query.return?.().catch(() => undefined);
      }
    } finally {
      this.probeQuery = null;
      queue.close();
    }
  }

  /**
   * Permission modes are the ways of working (D5). `bypassPermissions` is
   * offered only behind the serve-level operator opt-in.
   */
  async listModes(): Promise<ChatMode[]> {
    // Claude Code's own presentation vocabulary; names are the wire values.
    return [
      { name: "auto", description: "Claude handles permission decisions", default: true },
      { name: "default", description: "Always ask before making changes" },
      { name: "acceptEdits", description: "Automatically accept all file edits" },
      { name: "plan", description: "Create a plan before making changes" },
      ...(this.offerBypassPermissions
        ? [{ name: "bypassPermissions", description: "Run every tool without permission prompts (operator-enabled)" }]
        : []),
    ];
  }

  async switchModel(sessionId: string, selection: ModelSelection, variant?: string): Promise<void> {
    await this.restoreDurableState();
    if (variant !== undefined) {
      const model = (this.liveModels ?? CLAUDE_MODELS).find(candidate => candidate.selection.modelId === selection.modelId)
        ?? findClaudeModel(selection.modelId);
      if (!model?.variants?.includes(variant)) {
        throw new UnsupportedVariantSelectionError(`model ${selection.modelId} does not offer effort level ${variant}`);
      }
    }
    const previous = this.configurations.get(sessionId);
    const configuration = { ...previous, model: selection, ...(variant ? { variant } : {}) };
    if (!variant) delete configuration.variant;
    this.configurations.set(sessionId, configuration);
    this.persistDurableState();
    const live = this.live.get(sessionId);
    if (!live) return;
    // The "default" sentinel is the CLI's own pick on the live path too:
    // reset instead of sending an id session start deliberately omits.
    await live.query.setModel?.(selection.modelId === "default" ? undefined : selection.modelId);
    // Effort applies to the live session as well — `effort` at spawn only
    // covers a fresh one. Clearing the variant clears the flag layer so
    // lower-precedence settings resume. Best-effort: a CLI without the
    // control keeps the documented next-session behavior.
    if (variant !== previous?.variant) {
      await live.query.applyFlagSettings?.({ effortLevel: variant ?? null }).catch(() => undefined);
    }
  }

  async listSessions(): Promise<ProviderSession[]> {
    await this.restoreDurableState();
    const { sessions } = await listTranscriptSessions(this.workspacePath, this.configDir);
    // A redirected conversation keeps its public id but lives on its fork:
    // the summary (title, timestamps) must describe the fork's transcript,
    // or later turns never update the chooser and a reverted first prompt
    // stays on as the title.
    const byNative = new Map(sessions.map(session => [session.id, session]));
    const stored = sessions.filter(session => !this.hiddenNative.has(session.id)).map(session => {
      const summary = byNative.get(this.nativeId(session.id)) ?? session;
      return {
        id: session.id,
        title: deriveTitle(summary.firstPrompt),
        directory: this.workspacePath,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
      };
    });
    const onDisk = new Set(stored.map(session => session.id));
    const fresh = [...this.pending.values()].filter(session => !onDisk.has(session.id));
    return [...fresh, ...stored];
  }

  async newConversationConfiguration(): Promise<ConversationConfiguration> {
    return {};
  }

  async createSession(_id: string, configuration: ConversationConfiguration = {}): Promise<ProviderSession> {
    await this.restoreDurableState();
    // The SDK requires a UUID session id; the adapter's suggestion is not
    // one, so the provider mints its own (same as the OpenCode provider).
    const id = randomUUID();
    const created = this.now();
    const session: ProviderSession = { id, title: DEFAULT_TITLE, directory: this.workspacePath, createdAt: created, updatedAt: created };
    this.pending.set(id, session);
    // Claude Code's own default: a fresh conversation runs in Auto unless
    // the creator chose otherwise.
    this.configurations.set(id, { mode: "auto", ...configuration });
    this.persistDurableState();
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
    await this.restoreDurableState();
    // Subagent links carry the public parent id; resolution goes through the
    // active native id so a fork-committed conversation's subagents load
    // from where Claude actually stored them.
    const child = parseSubagentId(id);
    if (child) {
      // Synthetic and read-only: a subagent run is reached from its parent's
      // row, never started or listed on its own. `parentId` is what keeps it
      // out of the picker and routes its interactions to the parent.
      let entries;
      try {
        entries = (await readSessionTranscript(subagentTranscriptPath(this.workspacePath, this.nativeId(child.parentSessionId), child.agentId, this.configDir))).entries;
      } catch {
        return null;
      }
      if (entries.length === 0) return null;
      return {
        id,
        title: "Subagent",
        directory: this.workspacePath,
        createdAt: entries[0]!.timestamp,
        updatedAt: entries[entries.length - 1]!.timestamp,
        parentId: child.parentSessionId,
      };
    }
    const fresh = this.pending.get(id);
    if (fresh) return fresh;
    return (await this.listSessions()).find(session => session.id === id) ?? null;
  }

  async getConversationConfiguration(sessionId: string): Promise<ConversationConfiguration> {
    await this.restoreDurableState();
    return this.configurations.get(sessionId) ?? {};
  }

  async listMessages(sessionId: string, options: { cursor?: string; limit: number }): Promise<ProviderHistoryPage> {
    await this.restoreDurableState();
    // History joins model ids on the catalog aliases; hydrate them first so
    // a cold read does not serve raw ids the gauge cannot match (no-op once
    // the catalog is live).
    await this.hydrateCatalog();
    const child = parseSubagentId(sessionId);
    let entries: Awaited<ReturnType<typeof readSessionTranscript>>["entries"] = [];
    try {
      entries = child
        ? (await readSessionTranscript(subagentTranscriptPath(this.workspacePath, this.nativeId(child.parentSessionId), child.agentId, this.configDir))).entries
        : (await readSessionTranscript(sessionTranscriptPath(this.workspacePath, this.nativeId(sessionId), this.configDir))).entries;
    } catch {
      // No transcript yet: a fresh conversation's history is empty. A child
      // whose file is gone has nothing to show and no fallback.
      if (child) throw new Error(`unknown Claude subagent transcript: ${sessionId}`);
      if (!this.pending.has(sessionId) && !this.live.has(sessionId)) throw new Error(`unknown Claude conversation: ${sessionId}`);
    }
    // A child transcript IS the sidechain; a parent's history excludes it.
    let mainline = child ? entries : entries.filter(entry => !entry.isSidechain);
    // A staged revert hides the boundary turn and everything after it.
    const stagedState = this.staged.get(sessionId);
    if (stagedState) {
      const turns = reversibleTurns(mainline);
      const boundary = turns[stagedState.boundaryIndex];
      if (boundary) mainline = mainline.slice(0, boundary.entryIndex);
    }
    const { items, accounting } = normalizeTranscriptEntries(mainline, child ? undefined : this.nativeId(sessionId), id => this.modelAliases.get(id) ?? id);
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
    await this.restoreDurableState();
    if (this.disposed) throw new Error("Claude provider is disposed");
    if (parseSubagentId(sessionId)) throw new Error("a subagent transcript is read-only");
    if (input.mode !== undefined) {
      const modes = await this.listModes();
      if (!modes.some(candidate => candidate.name === input.mode)) {
        throw new Error(`Claude Code does not offer the mode ${input.mode}`);
      }
    }
    // A replacement prompt while a revert is staged commits the reverted
    // history first: the native session forks at the boundary and the
    // conversation continues on the fork (D8). The hidden turns can no
    // longer be restored after this.
    if (this.staged.has(sessionId)) await this.commitStagedRevert(sessionId);
    const alreadyLive = this.live.get(sessionId);
    const session = await this.ensureLive(sessionId, input.model, input.mode, input.variant);
    if (input.model) await this.switchModel(sessionId, input.model, input.variant);
    if (input.mode !== undefined) {
      const previousMode = this.configurations.get(sessionId)?.mode;
      if (input.mode === "plan" && previousMode !== "plan") {
        this.modeBeforePlan.set(sessionId, previousMode ?? "auto");
        this.persistDurableState();
      }
      const configuration = { ...this.configurations.get(sessionId), mode: input.mode };
      this.configurations.set(sessionId, configuration);
      this.persistDurableState();
      // A session that already existed switches live; a fresh one was
      // created with the mode in its options.
      if (alreadyLive) {
        // An install that rejects the mode value (an older CLI) keeps the
        // turn alive; the configuration event still reflects the request
        // and the session keeps its previous mode.
        await alreadyLive.query.setPermissionMode?.(input.mode).catch(() => undefined);
      }
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
    session.pendingTurns += 1;
    session.queue.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: sessionId,
    });
    return { messageId: input.id };
  }

  async command(sessionId: string, input: { id: string; name: string; arguments: string; model?: ModelSelection; mode?: string; variant?: string }): Promise<{ messageId: string }> {
    // A slash command is a turn: the CLI parses "/name args" from the user
    // message and runs the command inside the session, so dispatch rides the
    // ordinary prompt path with everything that entails (mode/model staging,
    // the minted user item, the running status).
    const text = input.arguments ? `/${input.name} ${input.arguments}` : `/${input.name}`;
    return this.prompt(sessionId, {
      id: input.id,
      text,
      delivery: "queue",
      ...(input.model ? { model: input.model } : {}),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.variant !== undefined ? { variant: input.variant } : {}),
    });
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.live.get(sessionId);
    if (!session) return;
    session.interrupted = true;
    await session.query.interrupt();
    this.emit(sessionId, {
      updates: [{ kind: "status", status: "interrupted" }],
      outcome: "handled",
      eventType: "turn.interrupted",
    });
  }

  async replyPermission(sessionId: string, requestId: string, reply: ProviderPermissionReply, choiceId?: string): Promise<void> {
    const pending = this.requireInteraction(sessionId, requestId, "permission");
    if (reply === "reject") {
      // Rejecting a plan keeps the conversation planning (spec): the deny
      // returns to the turn, which continues refining under plan mode.
      pending.settle({ behavior: "deny", message: (pending.item as PermissionRequest).plan !== undefined
        ? "The user did not approve this plan. Keep planning and present a revised plan."
        : "The user denied this action." });
      return;
    }
    if ((pending.item as PermissionRequest).plan !== undefined) {
      await this.approvePlan(sessionId, pending, choiceId);
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
      .map(pending => {
        const item = pending.item as PermissionRequest;
        return {
          requestId: pending.requestId,
          conversationId: pending.conversationId,
          action: item.action,
          resources: item.resources,
          // A recovered plan card must still show the plan and its intent
          // choices — the reader this path exists for missed the live one.
          ...(item.plan === undefined ? {} : { plan: item.plan }),
          ...(item.choices === undefined ? {} : { choices: item.choices }),
        };
      });
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
    // Nothing durable may still be in flight when the workspace stops.
    await this.persistChain.catch(() => undefined);
    await this.probeQuery?.return?.().catch(() => undefined);
    await this.hydration?.catch(() => undefined);
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
    const nativeId = this.nativeId(sessionId);
    const hasTranscript = await fs.access(sessionTranscriptPath(this.workspacePath, nativeId, this.configDir)).then(() => true, () => false);
    const queue = new PushQueue<ClaudeUserEnvelope>();
    const configuration = this.configurations.get(sessionId) ?? {};
    const query = this.queryFactory({
      prompt: queue,
      options: {
        cwd: this.workspacePath,
        // Resume continues the native session (or its committed fork); a
        // never-prompted conversation claims its pre-minted id instead so
        // the transcript lands under it.
        ...(hasTranscript ? { resume: nativeId } : { sessionId: nativeId }),
        pathToClaudeCodeExecutable: this.executable,
        enableFileCheckpointing: true,
        // Unset resolves to the declared default (auto) so the session
        // actually runs the mode the picker presents as active.
        permissionMode: mode ?? configuration.mode ?? "auto",
        // Choosing "default" IS choosing the CLI's own pick: omit the
        // option and let it resolve, same as an unset model.
        ...((model ?? configuration.model) && (model ?? configuration.model)!.modelId !== "default"
          ? { model: (model ?? configuration.model)!.modelId } : {}),
        // Effort is applied when the session starts; a variant staged while
        // the session is live takes effect on the next session start.
        ...((variant ?? configuration.variant) ? { effort: (variant ?? configuration.variant)! } : {}),
        canUseTool: (toolName, input, options) => this.brokerToolUse(sessionId, toolName, input, options),
      },
    });
    const session: LiveSession = { id: sessionId, queue, query, reader: Promise.resolve(), pendingTurns: 0 };
    session.reader = this.readSession(session);
    this.live.set(sessionId, session);
    // Fire-and-forget: the catalog answers when the session is up, and a
    // failure just leaves the manifest fallback in place until the next one.
    if (this.liveModels === null) void this.captureModels(query);
    // Commands can change mid-session (skills discovered as the agent
    // works); every session start re-reads the latest list.
    else void this.captureSlashCommands(query);
    return session;
  }

  private async readSession(session: LiveSession): Promise<void> {
    const memory = createClaudeEventMemory();
    memory.resolveModel = id => this.modelAliases.get(id) ?? id;
    try {
      for await (const message of session.query) {
        this.captureCommands(message);
        const normalized = normalizeClaudeMessage(message, memory, "live", session.id);
        // A result that lands after the user cancelled is the cancellation's
        // own echo: report interrupted, not a turn failure.
        if (session.interrupted && normalized.eventType === "result") {
          session.interrupted = false;
          normalized.updates = normalized.updates.map(update =>
            update.kind === "status" ? { kind: "status", status: "interrupted" } : update);
        }
        this.emit(session.id, normalized);
        // A terminal result ends the turn; an idle conversation holds no
        // process (spec). Unless another accepted prompt is still pending
        // for this very session, retire the query — the next prompt
        // resumes fresh.
        if (normalized.eventType === "result") session.pendingTurns = Math.max(0, session.pendingTurns - 1);
        if (normalized.eventType === "result" && session.pendingTurns === 0 && this.live.get(session.id) === session) {
          this.live.delete(session.id);
          this.abandonInteractions(session.id, "The turn ended before the user answered.");
          session.queue.close();
          await session.query.return?.().catch(() => undefined);
          return;
        }
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

  async getReversibleHistoryState(sessionId: string): Promise<ReversibleHistoryState> {
    await this.restoreDurableState();
    return (await this.reversibleContext(sessionId)).state;
  }

  async undo(sessionId: string): Promise<ReversibleHistoryResult> {
    await this.restoreDurableState();
    const context = await this.reversibleContext(sessionId);
    const index = (this.staged.get(sessionId)?.boundaryIndex ?? context.turns.length) - 1;
    if (index < 0 || !context.turns[index]) return { outcome: "nothing-to-undo", state: context.state };
    return this.stageBoundary(sessionId, context, index);
  }

  async redo(sessionId: string): Promise<ReversibleHistoryResult> {
    await this.restoreDurableState();
    const context = await this.reversibleContext(sessionId);
    const stagedState = this.staged.get(sessionId);
    if (!stagedState) return { outcome: "nothing-to-redo", state: context.state };
    const next = stagedState.boundaryIndex + 1;
    if (next >= context.turns.length) return this.clearBoundary(sessionId, context, stagedState);
    return this.stageBoundary(sessionId, context, next);
  }

  async revert(sessionId: string, messageId: string): Promise<ReversibleHistoryResult> {
    await this.restoreDurableState();
    const context = await this.reversibleContext(sessionId);
    const index = context.turns.findIndex(turn => `message:${turn.uuid}` === messageId);
    if (index < 0) throw new ReversibleHistoryTargetError();
    return this.stageBoundary(sessionId, context, index);
  }

  async restore(sessionId: string, messageId: string): Promise<ReversibleHistoryResult> {
    await this.restoreDurableState();
    const context = await this.reversibleContext(sessionId);
    const stagedState = this.staged.get(sessionId);
    if (!stagedState) return { outcome: "nothing-to-redo", state: context.state };
    const index = context.turns.findIndex(turn => `message:${turn.uuid}` === messageId);
    if (index < 0) throw new ReversibleHistoryTargetError();
    const next = index + 1;
    if (next >= context.turns.length) return this.clearBoundary(sessionId, context, stagedState);
    return this.stageBoundary(sessionId, context, next);
  }

  private async reversibleContext(sessionId: string): Promise<{ turns: ReversibleClaudeTurn[]; state: ReversibleHistoryState }> {
    let turns: ReversibleClaudeTurn[] = [];
    try {
      const { entries } = await readSessionTranscript(sessionTranscriptPath(this.workspacePath, this.nativeId(sessionId), this.configDir));
      turns = reversibleTurns(entries.filter(entry => !entry.isSidechain));
    } catch {
      // No transcript: nothing to revert.
    }
    const boundaryIndex = this.staged.get(sessionId)?.boundaryIndex;
    return { turns, state: reversibleState(turns, boundaryIndex) };
  }

  /**
   * Moves the revert boundary to `index`: files rewind to that turn's
   * checkpoint through the live session's control channel, and the tip's
   * displaced bytes are snapshotted on the first staging so a terminal redo
   * can put the newest state back without inventing a forward checkpoint.
   * A rewind the checkpoint store refuses changes nothing (spec: report,
   * never claim).
   */
  private async stageBoundary(sessionId: string, context: { turns: ReversibleClaudeTurn[]; state: ReversibleHistoryState }, index: number): Promise<ReversibleHistoryResult> {
    const target = context.turns[index]!;
    const session = await this.ensureLive(sessionId);
    if (!session.query.rewindFiles) throw new ReversibleHistoryTargetError();
    const existing = this.staged.get(sessionId);
    const preview = await session.query.rewindFiles(target.uuid, { dryRun: true });
    if (!preview.canRewind) throw new ReversibleHistoryTargetError(rewindRefusal(preview.error));
    // The snapshot grows as the boundary moves: a file enters it at the
    // shallowest boundary that touches it — the moment its bytes are still
    // the tip's, before any rewind reaches it. A deeper undo therefore
    // adds files the earlier boundary never affected; files already
    // captured keep their first (tip) bytes, so a later shallower preview
    // cannot poison the snapshot with rewound content.
    const tipSnapshot = existing?.tipSnapshot ?? new Map<string, string | null>();
    for (const filePath of preview.filesChanged ?? []) {
      const absolute = path.isAbsolute(filePath) ? filePath : path.join(this.workspacePath, filePath);
      if (tipSnapshot.has(absolute)) continue;
      tipSnapshot.set(absolute, await fs.readFile(absolute, "base64").catch(() => null));
    }
    const result = await session.query.rewindFiles(target.uuid, { dryRun: false });
    if (!result.canRewind) throw new ReversibleHistoryTargetError(rewindRefusal(result.error));
    this.staged.set(sessionId, { boundaryIndex: index, tipSnapshot });
    this.persistDurableState();
    return {
      outcome: "changed",
      state: reversibleState(context.turns, index),
      restoredDraft: { text: target.text },
    };
  }

  /** Terminal redo: every hidden turn returns and the tip's bytes come back. */
  private async clearBoundary(sessionId: string, context: { turns: ReversibleClaudeTurn[]; state: ReversibleHistoryState }, stagedState: { tipSnapshot: Map<string, string | null> }): Promise<ReversibleHistoryResult> {
    await this.restoreSnapshot(stagedState.tipSnapshot);
    this.staged.delete(sessionId);
    this.persistDurableState();
    return { outcome: "changed", state: reversibleState(context.turns, undefined) };
  }

  private async restoreSnapshot(snapshot: Map<string, string | null>): Promise<void> {
    for (const [absolute, content] of snapshot) {
      if (content === null) {
        await fs.rm(absolute, { force: true });
        continue;
      }
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, Buffer.from(content, "base64"));
    }
  }

  /**
   * Commit: the conversation's native session forks at the last visible
   * turn and the conversation continues on the fork; the original keeps
   * every turn but no longer serves this conversation. A boundary at the
   * very first turn starts a fresh native session instead — there is no
   * "empty fork".
   */
  private async commitStagedRevert(sessionId: string): Promise<void> {
    const stagedState = this.staged.get(sessionId);
    if (!stagedState) return;
    const context = await this.reversibleContext(sessionId);
    const lastVisible = context.turns[stagedState.boundaryIndex - 1];
    const previousNative = this.nativeId(sessionId);
    const replacement = lastVisible
      ? (await this.forkSession(previousNative, { upToMessageId: lastVisible.uuid, dir: this.workspacePath })).sessionId
      : randomUUID();
    this.activeNative.set(sessionId, replacement);
    this.hiddenNative.add(replacement);
    this.staged.delete(sessionId);
    this.persistDurableState();
    // The live session is bound to the pre-fork history; the next prompt
    // resumes the fork instead.
    const live = this.live.get(sessionId);
    if (live) {
      this.live.delete(sessionId);
      await live.query.interrupt().catch(() => undefined);
      live.queue.close();
      await live.query.return?.().catch(() => undefined);
    }
  }

  private nativeId(sessionId: string): string {
    return this.activeNative.get(sessionId) ?? sessionId;
  }

  /** One lazy read per provider; in-memory state is newer and wins. */
  private restoreDurableState(): Promise<void> {
    this.durableRestore ??= (async () => {
      let raw: string;
      try {
        raw = await fs.readFile(this.stateFile, "utf8");
      } catch {
        return;
      }
      try {
        const stored = JSON.parse(raw) as {
          configurations?: Record<string, ConversationConfiguration>;
          activeNative?: Record<string, string>;
          hiddenNative?: string[];
          staged?: Record<string, { boundaryIndex: number; tipSnapshot: Record<string, string | null> }>;
          modeBeforePlan?: Record<string, string>;
        };
        for (const [id, configuration] of Object.entries(stored.configurations ?? {})) {
          if (!this.configurations.has(id)) this.configurations.set(id, configuration);
        }
        for (const [id, native] of Object.entries(stored.activeNative ?? {})) {
          if (!this.activeNative.has(id)) this.activeNative.set(id, native);
        }
        for (const native of stored.hiddenNative ?? []) this.hiddenNative.add(native);
        // A staged revert holds the displaced tip bytes; losing it across a
        // restart would strand the files rewound with no way back.
        for (const [id, staged] of Object.entries(stored.staged ?? {})) {
          if (!this.staged.has(id)) {
            this.staged.set(id, { boundaryIndex: staged.boundaryIndex, tipSnapshot: new Map(Object.entries(staged.tipSnapshot)) });
          }
        }
        // Without it, a restart mid-plan loses the "implement and return
        // to <mode>" intent the conversation still deserves.
        for (const [id, mode] of Object.entries(stored.modeBeforePlan ?? {})) {
          if (!this.modeBeforePlan.has(id)) this.modeBeforePlan.set(id, mode);
        }
      } catch {
        // A corrupt sidecar is dropped; the next persist rewrites it.
      }
    })();
    return this.durableRestore;
  }

  /** Serialized write-behind; the last snapshot wins. */
  private persistDurableState(): void {
    const snapshot = JSON.stringify({
      configurations: Object.fromEntries(this.configurations),
      activeNative: Object.fromEntries(this.activeNative),
      hiddenNative: [...this.hiddenNative],
      staged: Object.fromEntries([...this.staged].map(([id, staged]) =>
        [id, { boundaryIndex: staged.boundaryIndex, tipSnapshot: Object.fromEntries(staged.tipSnapshot) }])),
      modeBeforePlan: Object.fromEntries(this.modeBeforePlan),
    });
    this.persistChain = this.persistChain.then(async () => {
      await fs.mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
      await fs.writeFile(this.stateFile, snapshot);
    }).catch(() => undefined);
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
      // A completed plan asks for its own kind of approval: the card carries
      // the plan and intents rather than the generic allow pair (D5).
      const plan = toolName === "ExitPlanMode" && typeof input.plan === "string" ? input.plan : null;
      const returnMode = this.modeBeforePlan.get(sessionId);
      const item: PermissionRequest | QuestionRequest = questions
        ? { id: `question:${requestId}`, type: "question", createdAt, requestId, questions, status: "pending" }
        : plan !== null
          ? {
            id: `permission:${requestId}`,
            type: "permission",
            createdAt,
            requestId,
            action: "Review the plan",
            resources: [],
            status: "pending",
            plan,
            choices: [
              { id: "implement", label: "Approve and implement" },
              ...(returnMode && returnMode !== "plan"
                ? [{ id: "implement-and-restore", label: `Approve, then return to ${returnMode}`, description: "Implement the plan, then go back to the mode this conversation used before planning." }]
                : []),
            ],
          }
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

  /**
   * Plan approval: allow the ExitPlanMode call, then set the conversation's
   * next mode by the chosen intent — the default intent leaves planning for
   * the agent's normal implementing mode, the restore intent returns to the
   * mode used before planning. Either way the picker learns the new mode
   * through a configuration event, without a separate user mode change.
   */
  private async approvePlan(sessionId: string, pending: PendingInteraction, choiceId?: string): Promise<void> {
    // Plain approval lands in the declared default mode (auto) — the same
    // mode a fresh conversation runs — while the restore intent returns to
    // whatever the conversation used before planning.
    const returnMode = choiceId === "implement-and-restore"
      ? this.modeBeforePlan.get(sessionId) ?? "auto"
      : "auto";
    pending.settle({ behavior: "allow", updatedInput: pending.input });
    this.modeBeforePlan.delete(sessionId);
    this.persistDurableState();
    const configuration = { ...this.configurations.get(sessionId), mode: returnMode };
    this.configurations.set(sessionId, configuration);
    this.persistDurableState();
    // The plan is already approved and the interaction settled; a CLI that
    // rejects the return-mode switch must not turn that success into a
    // failed permission response (same degradation as the ordinary live
    // mode-switch path — the mode applies at the next session start).
    await this.live.get(sessionId)?.query.setPermissionMode?.(returnMode).catch(() => undefined);
    this.emit(sessionId, {
      updates: [],
      outcome: "handled",
      eventType: "plan.approved",
      configuration: { mode: returnMode },
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

  private async captureModels(query: ClaudeQueryHandle): Promise<void> {
    if (!query.supportedModels) return;
    try {
      const raw = await query.supportedModels();
      const { models, aliases } = modelsFromCatalog(raw);
      if (models.length > 0) {
        this.liveModels = models;
        this.modelAliases = aliases;
      }
    } catch {
      // The manifest fallback stands; the next session retries.
    }
    await this.captureSlashCommands(query);
  }

  /**
   * The control channel's command list carries descriptions and argument
   * hints (init's `slash_commands` is bare names), and it tracks the CLI's
   * own mid-session pushes — a re-fetch returns the latest list.
   */
  private async captureSlashCommands(query: ClaudeQueryHandle): Promise<void> {
    if (!query.supportedCommands) return;
    try {
      const raw = await query.supportedCommands();
      if (!Array.isArray(raw)) return;
      const commands = raw.flatMap((value): ChatCommand[] => {
        if (!value || typeof value !== "object") return [];
        const info = value as Record<string, unknown>;
        if (typeof info.name !== "string" || !info.name) return [];
        return [{
          name: info.name.startsWith("/") ? info.name.slice(1) : info.name,
          description: typeof info.description === "string" ? info.description : "",
          argumentHint: typeof info.argumentHint === "string" ? info.argumentHint : "",
          kind: "command" as const,
        }];
      });
      if (commands.length > 0) this.commands = commands;
    } catch {
      // Init's bare names (captureCommands) remain the fallback.
    }
  }

  /**
   * The init message names the session's slash commands (bare names), and a
   * mid-session `commands_changed` push carries the full replacement list —
   * the CLI's own instruction is to replace the cached inventory with it.
   */
  private captureCommands(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (record.type !== "system") return;
    if (record.subtype === "commands_changed" && Array.isArray(record.commands)) {
      const commands = record.commands.flatMap((value): ChatCommand[] => {
        if (!value || typeof value !== "object") return [];
        const info = value as Record<string, unknown>;
        if (typeof info.name !== "string" || !info.name) return [];
        return [{
          name: info.name.startsWith("/") ? info.name.slice(1) : info.name,
          description: typeof info.description === "string" ? info.description : "",
          argumentHint: typeof info.argumentHint === "string" ? info.argumentHint : "",
          kind: "command" as const,
        }];
      });
      if (commands.length > 0) this.commands = commands;
      return;
    }
    if (record.subtype !== "init" || !Array.isArray(record.slash_commands)) return;
    // Bare names only fill an empty inventory; they never downgrade the
    // control channel's described list.
    if (this.commands.length > 0) return;
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

/** The CLI's ModelInfo list → the shared model shape + resolved-id joins. */
function modelsFromCatalog(raw: unknown): { models: ChatModel[]; aliases: Map<string, string> } {
  const models: ChatModel[] = [];
  const aliases = new Map<string, string>();
  const resolvedByIndex = new Map<number, string>();
  if (!Array.isArray(raw)) return { models, aliases };
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const info = value as Record<string, unknown>;
    if (typeof info.value !== "string" || !info.value) continue;
    // "default" is the CLI's own recommended pick — offered first-class,
    // exactly as Claude Code itself presents it. It never joins the alias
    // map: session-reported ids belong to the concrete entries.
    const isDefault = info.value === "default";
    // The session reports resolved ids ("claude-sonnet-5") while the
    // catalog keys by alias ("sonnet", "opus[1m]"); the join is what lets
    // the context gauge find the window actually in effect.
    const resolvedModel = typeof info.resolvedModel === "string" && info.resolvedModel ? info.resolvedModel : undefined;
    const name = typeof info.displayName === "string" && info.displayName ? info.displayName : info.value;
    const variants = Array.isArray(info.supportedEffortLevels)
      ? info.supportedEffortLevels.filter((level): level is string => typeof level === "string")
      : undefined;
    if (resolvedModel) resolvedByIndex.set(models.length, resolvedModel);
    models.push({
      selection: { providerId: "anthropic", modelId: info.value },
      provider: "Anthropic",
      name,
      ...(variants && variants.length > 0 ? { variants } : {}),
      ...(typeof info.description === "string" && info.description ? { detail: info.description } : {}),
      ...(isDefault ? { default: true } : {}),
      // No ModelInfo field carries the window; derive it from the ids
      // unless the CLI starts reporting one.
      contextLimit: typeof info.contextWindow === "number" && info.contextWindow > 0
        ? info.contextWindow
        : claudeContextWindow(info.value, resolvedModel),
      imageInput: true,
    });
  }
  // The alias join in two passes: exact resolved-id joins first, then the
  // stripped spelling (assistant messages report "claude-opus-5" while
  // running "opus[1m]") only into vacant keys — a stripped heuristic from
  // one entry must never shadow another entry's exact join.
  for (const [index, model] of models.entries()) {
    if (model.default) continue;
    const resolved = resolvedByIndex.get(index);
    if (resolved && resolved !== model.selection.modelId && !aliases.has(resolved)) aliases.set(resolved, model.selection.modelId);
  }
  for (const [index, model] of models.entries()) {
    if (model.default) continue;
    const resolved = resolvedByIndex.get(index);
    if (!resolved) continue;
    const stripped = resolved.replace(/\[[^\]]*\]$/, "");
    if (stripped !== resolved && stripped !== model.selection.modelId && !aliases.has(stripped)) aliases.set(stripped, model.selection.modelId);
  }
  // Name the default's resolution: the concrete entry sharing its resolved
  // model is what the agent would actually run.
  const defaultIndex = models.findIndex(model => model.default);
  if (defaultIndex >= 0) {
    const resolved = resolvedByIndex.get(defaultIndex);
    const concreteIndex = models.findIndex((model, index) => index !== defaultIndex && !model.default && resolvedByIndex.get(index) === resolved);
    if (resolved && concreteIndex >= 0) models[defaultIndex] = { ...models[defaultIndex]!, resolvesTo: models[concreteIndex]!.selection };
  }
  return { models, aliases };
}

function rewindRefusal(error: string | undefined): string {
  return error ? `the checkpoint store refused the rewind: ${error}` : "reversible-history message is no longer available";
}

function parseSubagentId(id: string): { parentSessionId: string; agentId: string } | null {
  const match = id.match(/^sub:([A-Za-z0-9-]+):([A-Za-z0-9-]+)$/);
  return match ? { parentSessionId: match[1]!, agentId: match[2]! } : null;
}

type ReversibleClaudeTurn = { uuid: string; text: string; entryIndex: number };

/** Visible user turns, in order, with their transcript positions. */
function reversibleTurns(entries: Array<{ kind: string; uuid: string; message: Record<string, unknown> }>): ReversibleClaudeTurn[] {
  const turns: ReversibleClaudeTurn[] = [];
  entries.forEach((entry, index) => {
    if (entry.kind !== "user") return;
    const content = entry.message.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content) && !content.some(block => (block as { type?: string })?.type === "tool_result")
        ? content.filter(block => (block as { type?: string })?.type === "text").map(block => (block as { text?: string }).text ?? "").join("\n")
        : "";
    // Interrupt markers are recorded as user entries but are not prompts:
    // no checkpoint is keyed to them and no draft is worth restoring.
    if (text.trim() && !/^\[Request interrupted/.test(text.trim())) turns.push({ uuid: entry.uuid, text, entryIndex: index });
  });
  return turns;
}

function reversibleState(turns: ReversibleClaudeTurn[], boundaryIndex: number | undefined): ReversibleHistoryState {
  const staged = boundaryIndex !== undefined;
  return {
    staged,
    canUndo: (boundaryIndex ?? turns.length) > 0,
    canRedo: staged,
    revertedMessages: staged
      ? turns.slice(boundaryIndex).map(turn => ({ id: `message:${turn.uuid}`, text: turn.text }))
      : [],
  };
}

function defaultForkSession(sessionId: string, options: { upToMessageId: string; dir: string }): Promise<{ sessionId: string }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { forkSession } = require("@anthropic-ai/claude-agent-sdk") as typeof import("@anthropic-ai/claude-agent-sdk");
  return forkSession(sessionId, { upToMessageId: options.upToMessageId, dir: options.dir });
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

/** Mirrors the attachment store's home: uatu's state, keyed by workspace. */
function defaultStateFile(workspacePath: string): string {
  const stateHome = process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.trim() !== ""
    ? process.env.XDG_STATE_HOME
    : path.join(os.homedir(), ".local", "state");
  const workspaceKey = createHash("sha256").update(path.resolve(workspacePath)).digest("hex").slice(0, 16);
  return path.join(stateHome, "uatu", "chat-claude", `${workspaceKey}.json`);
}

function defaultQueryFactory(input: ClaudeQueryInput): ClaudeQueryHandle {
  // Imported lazily-by-name at module scope would pull the SDK into every
  // consumer; the provider is only constructed when the Claude agent is
  // registered, so a direct import here is the bundle boundary.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { query } = require("@anthropic-ai/claude-agent-sdk") as typeof import("@anthropic-ai/claude-agent-sdk");
  return query(input as never) as unknown as ClaudeQueryHandle;
}
