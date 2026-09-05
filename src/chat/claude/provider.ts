import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HistoryReuse, historyPageCursor, historyPageEnd, historyVersion } from "../history-reuse";

import type {
  ChatProvider,
  NormalizedProviderEvent,
  NormalizedProviderUpdate,
  PendingBackgroundTask,
  PendingPermission,
  PendingQuestion,
  ProviderAttachment,
  ProviderHistoryPage,
  ProviderPermissionReply,
  ProviderSession,
} from "../provider";
import type { ChatAgent, ChatCommand, ChatMode, ChatModel, ConversationConfiguration, ModelSelection, PermissionRequest, PlanExtraUsage, PlanModelWindow, PlanUtilization, PlanUtilizationWindow, QuestionRequest, ReversibleHistoryResult, ReversibleHistoryState, SessionModelTotals, SessionTotals, StructuredQuestion } from "../types";
import { BackgroundTaskUnavailableError, InvalidQuestionAnswerError, ReversibleHistoryTargetError, UnsupportedVariantSelectionError } from "../provider";
import { CLAUDE_MODELS, claudeContextWindow, findClaudeModel, stripWindowMarker, versionedModelName, withMoreModels } from "./models";
import { createClaudeEventMemory, markTasksBackgrounded, normalizeClaudeMessage, normalizeContextUsage, normalizeTranscriptEntries, claudeModelSelection } from "./normalization";
import { listTranscriptSessions, readSessionTranscript, readTranscriptTitles, sessionTranscriptPath, subagentTranscriptPath, claudeConfigDir } from "./transcript";

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
  /** The CLI's own context breakdown (the `/context` data), structurally. */
  getContextUsage?(): Promise<unknown>;
  /** Stop one background task; the CLI reports a stopped task_notification. */
  stopTask?(taskId: string): Promise<void>;
  /** The `/usage` data: session cost and claude.ai plan rate-limit windows. The SDK's own (experimental) name. */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(): Promise<unknown>;
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
    /** Stream assistant text as it arrives (D10). */
    includePartialMessages?: boolean;
    canUseTool?: (toolName: string, input: Record<string, unknown>, options: ClaudeCanUseToolOptions) => Promise<ClaudePermissionResult>;
    /** MCP elicitations (structurally the SDK's OnElicitation). */
    onElicitation?: (request: ClaudeElicitationRequest, options: { signal: AbortSignal; requestId: string }) => Promise<ClaudeElicitationResult | null>;
    /** Tool-driven blocking dialogs (structurally the SDK's OnUserDialog). */
    onUserDialog?: (request: ClaudeUserDialogRequest, options: { signal: AbortSignal; requestId: string }) => Promise<ClaudeUserDialogResult | null>;
    /** The dialog kinds this host renders; the CLI emits no other. */
    supportedDialogKinds?: string[];
    /**
     * This host renders a per-task stop control, so an interrupt aborts the
     * turn only and spares running background tasks (the CLI's documented
     * behaviour when declared).
     */
    perTaskStopAffordance?: boolean;
  };
};

/** The SDK's ElicitationRequest, structurally. */
export type ClaudeElicitationRequest = {
  serverName: string;
  message: string;
  mode?: "form" | "url";
  url?: string;
  elicitationId?: string;
  requestedSchema?: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
};

/** The MCP ElicitResult, structurally. */
export type ClaudeElicitationResult = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

/** The SDK's UserDialogRequest / UserDialogResult, structurally. */
export type ClaudeUserDialogRequest = { dialogKind: string; payload: Record<string, unknown>; toolUseID?: string };
export type ClaudeUserDialogResult = { behavior: "completed"; result: unknown } | { behavior: "cancelled" };

/**
 * The dialog kinds this host renders and answers (D6). The CLI emits only
 * declared kinds and degrades the rest to their no-dialog behaviour, so a
 * kind is listed here only once it has a tailored card.
 */
export const CLAUDE_SUPPORTED_DIALOG_KINDS = ["refusal_fallback_prompt"];

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
  forkSession?: (sessionId: string, options: { upToMessageId: string; dir: string; title?: string }) => Promise<{ sessionId: string }>;
  /** A user rename: appends a custom-title entry to the native session (D12). */
  renameNativeSession?: (sessionId: string, title: string, options: { dir: string }) => Promise<void>;
  /**
   * Durable per-workspace state (conversation configurations, fork
   * redirections) — uatu's own XDG state home by default; never Claude
   * Code's storage.
   */
  stateFile?: string;
  now?: () => number;
  /**
   * How long a session whose background set emptied with nothing pending
   * waits for the CLI's own follow-up turn before it is idle for good (D9).
   * Tests shorten it.
   */
  backgroundGraceMs?: number;
  // Re-read delays for a generated title that lands after the result.
  titleRefreshDelaysMs?: number[];
};

const DEFAULT_TITLE = "New conversation";
/**
 * What "Allow always" actually does under Claude Code, as brokerToolUse
 * implements it: the reply returns only the SDK's session-destination
 * suggestions, so the CLI adds an allow rule for the rest of that live
 * process — and an idle conversation holds no process, so the rule lasts
 * the turn (a process kept up for background work carries it a little
 * further, which the sentence deliberately does not promise). Nothing is
 * written to the user's settings. The spec forbids asserting more.
 */
export const CLAUDE_PERMISSION_SCOPE_NOTE = "“Allow always” also covers similar requests for the rest of this turn. Nothing is saved to your settings.";
const CATALOG_PROBE_TIMEOUT_MS = 20_000;
const CATALOG_PROBE_COOLDOWN_MS = 60_000;
// One control round-trip after each turn; a CLI that never answers must not
// hold the session open past this.
const CONTEXT_REPORT_TIMEOUT_MS = 3_000;
// The CLI generates its title from an un-awaited side call that can land
// after the first result; a short turn is re-read a few times for it.
const TITLE_REFRESH_DELAYS_MS = [1_000, 3_000, 8_000];
// When the background set empties with no turn pending, the CLI starts its
// own follow-up turn within a fraction of a second (D9). A session whose set
// emptied and that shows no follow-up inside this window is idle for good.
const BACKGROUND_FOLLOW_UP_GRACE_MS = 5_000;
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
  // The latest context probe's turn; an older probe's answer is discarded.
  reportGeneration?: number;
  // The login answered the usage read with no windows: later reads are for
  // the conversation's running totals only, the plan stays stated as empty.
  planUnavailable?: boolean;
  // Results seen on this process: an unprompted turn can only follow one.
  resultsSeen: number;
  // User sends the CLI reported still queued on its last result.
  queuedTurns: number;
  // Live background work, replaced on every background_tasks_changed level
  // signal (ambient ids excluded) and reset when the process starts (D7).
  // A non-empty set keeps the session alive past its turn's result.
  backgroundTasks: Map<string, { description: string; taskType?: string; toolUseId?: string; startedAt: number }>;
  // A turn the CLI started by itself — the follow-up after a settled
  // background task (D9) — so its messages report running/completed like an
  // accepted prompt's, and retirement waits for its result.
  unpromptedTurn: boolean;
  // Armed when the set empties with nothing pending: retires the session if
  // no follow-up turn starts within the grace window.
  idleTimer?: ReturnType<typeof setTimeout>;
  // This query's own running totals as last read: folded into the
  // conversation's ledger when the query retires, since a resumed query
  // starts its counters fresh (SDK: "resumed sessions start fresh").
  lastTotals?: SessionTotals;
};

// What retired queries of one conversation spent, and when this process began
// observing it. The SDK's `/usage` session counters cover the current query
// only, and an idle conversation's next turn resumes a fresh one, so "this
// conversation" is the sum over the generations this process saw.
type SessionTotalsLedger = { settled?: SessionTotals; since: number };

/** Sums two tallies: scalars added, per-model rows merged by model id. */
export function mergeSessionTotals(base: SessionTotals | undefined, next: SessionTotals): SessionTotals {
  if (!base) return next;
  const models = base.models.map(model => ({ ...model }));
  for (const model of next.models) {
    const known = models.find(entry => entry.id === model.id);
    if (!known) { models.push({ ...model }); continue; }
    known.input += model.input;
    known.output += model.output;
    known.cacheRead += model.cacheRead;
    known.cacheWrite += model.cacheWrite;
    known.costUsd += model.costUsd;
  }
  return {
    costUsd: base.costUsd + next.costUsd,
    apiDurationMs: base.apiDurationMs + next.apiDurationMs,
    durationMs: base.durationMs + next.durationMs,
    linesAdded: base.linesAdded + next.linesAdded,
    linesRemoved: base.linesRemoved + next.linesRemoved,
    models,
  };
}

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
  private readonly historyReuse = new HistoryReuse<ReturnType<typeof normalizeTranscriptEntries>>();
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
  private readonly staged = new Map<string, { boundaryIndex: number; tipSnapshot: Map<string, SnapshotEntry>; commit?: { fork: string; prior?: string } }>();
  private readonly activeNative = new Map<string, string>();
  private readonly hiddenNative = new Set<string>();
  // Restart durability: modes/models/variants and fork redirections must
  // survive the workspace process, or a resumed conversation silently runs
  // the wrong mode and a committed revert resurrects its discarded turns.
  private readonly stateFile: string;
  private durableRestore: Promise<void> | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  private readonly forkSession: NonNullable<ClaudeProviderOptions["forkSession"]>;
  private readonly renameNativeSession: NonNullable<ClaudeProviderOptions["renameNativeSession"]>;
  // The generated title last announced per conversation, so a refresh after
  // a turn announces a change once rather than on every result.
  private readonly announcedTitles = new Map<string, string>();
  // Bumped by every user rename: a transcript read that was in flight
  // across one is stale and must not announce over the user's title.
  private readonly renameGenerations = new Map<string, number>();
  private readonly events_ = new PushQueue<NormalizedProviderEvent>();
  private readonly backgroundGraceMs: number;
  private readonly titleRefreshDelaysMs: number[];
  // Conversations whose last rate-limit signal was a standing (warning or
  // rejection): carried across processes so the eventual "allowed" clears it.
  private readonly rateLimitedSessions = new Set<string>();
  // Per conversation, the totals of the queries this process has retired and
  // when it began observing the conversation: process memory, like the
  // rate-limit standing, so a restart truthfully starts a new "since".
  private readonly sessionLedgers = new Map<string, SessionTotalsLedger>();
  // A rename asked for before the native transcript existed: written to it
  // once the first turn has created it.
  private readonly deferredRenames = new Map<string, string>();
  private readonly titleRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(options: ClaudeProviderOptions) {
    this.workspacePath = options.workspacePath;
    this.executable = options.executable;
    this.configDir = options.configDir ?? claudeConfigDir();
    this.queryFactory = options.queryFactory ?? defaultQueryFactory;
    this.offerBypassPermissions = options.offerBypassPermissions === true;
    this.catalogProbe = options.catalogProbe !== false;
    this.forkSession = options.forkSession ?? defaultForkSession;
    this.renameNativeSession = options.renameNativeSession ?? defaultRenameSession;
    this.stateFile = options.stateFile ?? defaultStateFile(options.workspacePath);
    this.now = options.now ?? (() => Date.now());
    this.backgroundGraceMs = options.backgroundGraceMs ?? BACKGROUND_FOLLOW_UP_GRACE_MS;
    this.titleRefreshDelaysMs = options.titleRefreshDelaysMs ?? TITLE_REFRESH_DELAYS_MS;
  }

  describe(): ChatAgent {
    // Extended one capability at a time by the task that implements it.
    return {
      id: "claude",
      name: "Claude Code",
      capabilities: ["context", "permissions", "questions", "models", "modes", "variants", "commands", "attachments", "reversible-history", "subagents", "custom-model-id", "background-tasks", "conversation-rename"],
      permissionScopeNote: CLAUDE_PERMISSION_SCOPE_NOTE,
    };
  }

  async listCommands(): Promise<ChatCommand[]> {
    // The command inventory lives on the control channel too: hydrate so a
    // cold read serves the real list rather than banking an empty one.
    await this.hydrateCatalog();
    return this.commands;
  }
  async listModels(): Promise<ChatModel[]> {
    await this.hydrateCatalog();
    // The catalog's own rows first, then UatuCode's app-only set under its
    // own group (D3) — never shadowing an id the catalog already offers.
    return withMoreModels(this.liveModels ?? CLAUDE_MODELS);
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
      const model = withMoreModels(this.liveModels ?? CLAUDE_MODELS).find(candidate => candidate.selection.modelId === selection.modelId)
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
        // A UatuCode rename wins, then Claude Code's own generated title,
        // then the first prompt (D12).
        title: summary.customTitle ?? summary.generatedTitle ?? deriveTitle(summary.firstPrompt),
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
      // out of the picker and routes its interactions to the parent. The
      // parent must itself be an accepted session — the encoded project
      // directory collides across paths, and a foreign parent excluded by
      // its recorded cwd must not leak its children through a crafted id.
      if (!(await this.getSession(child.parentSessionId))) return null;
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
    // A catalog can enrich later reads. Native history remains readable while
    // the optional probe is pending; unresolved model readouts stay unknown.
    const child = parseSubagentId(sessionId);
    // Same confinement as getSession: no accepted parent, no child read.
    if (child && !(await this.getSession(child.parentSessionId))) {
      throw new Error(`unknown Claude subagent transcript: ${sessionId}`);
    }
    const sourcePath = () => child
      ? subagentTranscriptPath(this.workspacePath, this.nativeId(child.parentSessionId), child.agentId, this.configDir)
      : sessionTranscriptPath(this.workspacePath, this.nativeId(sessionId), this.configDir);
    const signature = async () => {
      const file = await fs.realpath(sourcePath());
      const stat = await fs.stat(file, { bigint: true });
      return historyVersion([file, stat.dev.toString(), stat.ino.toString(), stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString(),
        sessionId, this.staged.get(sessionId)?.boundaryIndex, [...this.modelAliases]]);
    };
    let normalized: ReturnType<typeof normalizeTranscriptEntries> = { items: [], accounting: [] };
    let version = "empty";
    const deadline = Date.now() + 30_000;
    while (true) {
      try {
        version = await signature();
        normalized = await this.historyReuse.read(sessionId, version, async () => {
          const { entries } = await readSessionTranscript(sourcePath());
          let mainline = child ? entries : entries.filter(entry => !entry.isSidechain);
          const staged = this.staged.get(sessionId);
          if (staged) {
            const boundary = reversibleTurns(mainline)[staged.boundaryIndex];
            if (boundary) mainline = mainline.slice(0, boundary.entryIndex);
          }
          return normalizeTranscriptEntries(mainline, child ? undefined : sessionId, id => this.modelAliases.get(id) ?? id);
        });
        if (await signature() === version) break;
        this.historyReuse.invalidate(sessionId);
        if (Date.now() >= deadline) throw new Error("Claude transcript kept changing during the read. Retry the read.");
      } catch (error) {
        this.historyReuse.invalidate(sessionId);
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (child) throw new Error(`unknown Claude subagent transcript: ${sessionId}`);
        if (!this.pending.has(sessionId) && !this.live.has(sessionId)) throw new Error(`unknown Claude conversation: ${sessionId}`);
        normalized = { items: [], accounting: [] };
        version = "empty";
        break;
      }
    }
    const { items, accounting } = normalized;
    const end = historyPageEnd(options.cursor, version, items.length);
    const start = Math.max(0, end - Math.max(1, options.limit));
    const ids = new Set(items.slice(start, end).map(item => item.id));
    return {
      items: items.slice(start, end),
      accounting: accounting.filter(entry => ids.has(`usage:${entry.messageId}`) || ids.has(`message:${entry.messageId}`)),
      completeItems: items,
      nextCursor: historyPageCursor(start, version),
    };
  }

  async *events(signal: AbortSignal): AsyncIterable<NormalizedProviderEvent> {
    // Abort ends this subscription only: the supervised pump restarts with
    // a fresh events() over the same queue, so closing it here would leave
    // every later emit discarded and live updates silent. Only dispose
    // closes the shared queue.
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
    // The commit's bookkeeping is reversible until the replacement is
    // actually accepted: a failure between fork and queue would otherwise
    // leave the workspace rewound with Redo already forfeited.
    const stagedBefore = this.staged.get(sessionId);
    const nativeBefore = this.activeNative.get(sessionId);
    const configurationBefore = this.configurations.get(sessionId);
    const modeBeforePlanBefore = this.modeBeforePlan.get(sessionId);
    if (stagedBefore) await this.commitStagedRevert(sessionId);
    let session: LiveSession;
    let started: LiveSession | undefined;
    const content: Array<Record<string, unknown>> = [];
    // Everything before the queue push can fail; the rollback must cover it
    // all — an attachment that vanished after admission is as much a
    // pre-acceptance failure as a spawn that never came up.
    try {
      const alreadyLive = this.live.get(sessionId);
      session = await this.ensureLive(sessionId, input.model, input.mode, input.variant);
      if (!alreadyLive) started = session;
      if (input.model) await this.switchModel(sessionId, input.model, input.variant);
      if (input.mode !== undefined) {
        const previousMode = this.configurations.get(sessionId)?.mode;
        if (input.mode === "plan" && previousMode !== "plan") {
          this.modeBeforePlan.set(sessionId, previousMode ?? "auto");
          this.persistDurableState();
        }
        const configuration = { ...this.configurations.get(sessionId), mode: input.mode };
        this.configurations.set(sessionId, configuration);
        // Awaited: an accepted turn must not run under a mode the restarted
        // provider would deny ever was selected.
        await this.queuePersist(this.durableSnapshot());
        // A session that already existed switches live; a fresh one was
        // created with the mode in its options. An install that rejects
        // the mode value (an older CLI) keeps the turn alive; the
        // configuration event still reflects the request and the session
        // keeps its previous mode.
        if (alreadyLive) await alreadyLive.query.setPermissionMode?.(input.mode).catch(() => undefined);
      }
      // Images ride the prompt as base64 blocks read from the workspace's
      // attachment store; the store, bounds, and upload routes are shared
      // across agents (D5) — only this delivery is Claude-shaped.
      for (const attachment of input.attachments ?? []) {
        const bytes = await fs.readFile(attachment.absolutePath);
        content.push({
          type: "image",
          source: { type: "base64", media_type: attachment.mimeType, data: bytes.toString("base64") },
        });
      }
      // The stream can die during any of the awaits above; accepting into
      // a dead session's queue would strand the turn with no reader left
      // to end it. Everything after this check is synchronous.
      if (this.live.get(sessionId) !== session) {
        throw new Error("Claude Code session ended before the prompt was accepted");
      }
    } catch (error) {
      // A session this failed prompt started holds no accepted turn — and
      // after a rollback it is bound to the fork the routing just left.
      // Retire it: keeping it would send the next prompt into the wrong
      // transcript and park an idle process.
      if (started && this.live.get(sessionId) === started && started.pendingTurns === 0) {
        await this.retireSession(started);
      }
      // The failed prompt's model/mode selection was never accepted: the
      // configuration (and a surviving session's live controls) return to
      // what the conversation actually ran.
      if (input.model || input.mode !== undefined || input.variant !== undefined) {
        if (configurationBefore === undefined) this.configurations.delete(sessionId);
        else this.configurations.set(sessionId, configurationBefore);
        if (modeBeforePlanBefore === undefined) this.modeBeforePlan.delete(sessionId);
        else this.modeBeforePlan.set(sessionId, modeBeforePlanBefore);
        const survivor = this.live.get(sessionId);
        if (survivor) {
          const priorModel = configurationBefore?.model?.modelId;
          if (input.model) await survivor.query.setModel?.(priorModel === undefined || priorModel === "default" ? undefined : priorModel).catch(() => undefined);
          // Unset resolves to the declared default (auto) — the mode the
          // session actually runs — not "leave whatever the failed request
          // applied".
          if (input.mode !== undefined) await survivor.query.setPermissionMode?.(configurationBefore?.mode ?? "auto").catch(() => undefined);
          if (input.variant !== undefined || input.model) {
            await survivor.query.applyFlagSettings?.({ effortLevel: configurationBefore?.variant ?? null }).catch(() => undefined);
          }
        }
      }
      if (stagedBefore) {
        // The fork stays hidden and unused; the conversation returns to
        // its pre-commit identity with the boundary and tip bytes intact.
        if (nativeBefore === undefined) this.activeNative.delete(sessionId);
        else this.activeNative.set(sessionId, nativeBefore);
        delete stagedBefore.commit;
        this.staged.set(sessionId, stagedBefore);
      }
      // The rollback is only real once recorded: the commit's redirect may
      // already be durable, and a lost corrective write would hand the next
      // process the unused fork with Redo gone.
      try {
        await this.queuePersist(this.durableSnapshot());
      } catch (persistError) {
        throw new Error(`${error instanceof Error ? error.message : "prompt failed"}; additionally the rollback could not be recorded: ${persistError instanceof Error ? persistError.message : "write failed"}`);
      }
      throw error;
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
    // Acceptance finalizes a committed revert: the staged record and its
    // commit marker are dropped; a lost write here is healed by the
    // un-commit recovery on the next start.
    if (stagedBefore && this.staged.get(sessionId) === stagedBefore) {
      this.staged.delete(sessionId);
      await this.queuePersist(this.durableSnapshot()).catch(() => undefined);
    }
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
    // Nothing mid-turn to cancel: a session kept up only for background work
    // (D7) has no result to attribute the cancellation to, and latching it
    // would mark the NEXT turn's result as interrupted. Background tasks
    // have their own stop control; an interrupt does not touch them.
    if (session.pendingTurns === 0 && !session.unpromptedTurn) return;
    session.interrupted = true;
    try {
      await session.query.interrupt();
    } catch (error) {
      // The turn continues; its eventual result must report its real
      // outcome, not a cancellation that never took.
      session.interrupted = false;
      throw error;
    }
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
    // Each question kind maps the shared answer shape onto its own result:
    // the question tool's keyed record, an elicitation's content, a
    // dialog's choice.
    pending.settle(pending.onAnswer!(answers));
  }

  async rejectQuestion(sessionId: string, requestId: string): Promise<void> {
    const pending = this.requireInteraction(sessionId, requestId, "question");
    pending.settle(pending.onReject!());
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
      .map(pending => {
        const item = pending.item as QuestionRequest;
        return {
          requestId: pending.requestId,
          conversationId: pending.conversationId,
          questions: item.questions,
          ...(item.source === undefined ? {} : { source: item.source }),
          ...(item.intro === undefined ? {} : { intro: item.intro }),
          ...(item.link === undefined ? {} : { link: item.link }),
          ...(item.schema === undefined ? {} : { schema: item.schema }),
        };
      });
  }

  /**
   * Ends every live session and its child process. Dispose is the only exit
   * that skips the SDK's own turn-completion path, so it interrupts first
   * and then closes the input stream — the generator ending is what lets
   * the SDK shut the child down (leak test: no process outlives this).
   */
  async dispose(): Promise<void> {
    this.historyReuse.dispose();
    this.disposed = true;
    for (const timer of this.titleRefreshTimers.values()) clearTimeout(timer);
    this.titleRefreshTimers.clear();
    // Nothing durable may still be in flight when the workspace stops.
    await this.persistChain.catch(() => undefined);
    await this.probeQuery?.return?.().catch(() => undefined);
    await this.hydration?.catch(() => undefined);
    const sessions = [...this.live.values()];
    this.live.clear();
    for (const session of sessions) {
      this.clearIdleTimer(session);
      this.abandonInteractions(session.id, "The workspace shut down before the user answered.");
    }
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
        // Assistant text streams as it arrives (D10).
        includePartialMessages: true,
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
        // Dialogs and elicitations are pending interactions like a tool
        // approval: a card in the owning conversation, answered through the
        // same registry, abandoned visibly when the session ends (D6).
        onElicitation: (request, options) => this.brokerElicitation(sessionId, request, options),
        onUserDialog: (request, options) => this.brokerDialog(sessionId, request, options),
        supportedDialogKinds: [...CLAUDE_SUPPORTED_DIALOG_KINDS],
        perTaskStopAffordance: true,
      },
    });
    const session: LiveSession = { id: sessionId, queue, query, reader: Promise.resolve(), pendingTurns: 0, backgroundTasks: new Map(), unpromptedTurn: false, resultsSeen: 0, queuedTurns: 0 };
    session.reader = this.readSession(session);
    this.live.set(sessionId, session);
    // Observation begins with the conversation's first query in this
    // process: everything that query and its successors spend is counted.
    // The adapter stamps the prompt's user message after this call, so a
    // conversation that starts here has no message older than `since`.
    if (!this.sessionLedgers.has(sessionId)) {
      if (this.sessionLedgers.size >= 4_096) this.sessionLedgers.delete(this.sessionLedgers.keys().next().value!);
      this.sessionLedgers.set(sessionId, { since: this.now() });
    }
    // Fire-and-forget: the catalog answers when the session is up, and a
    // failure just leaves the manifest fallback in place until the next one.
    // Catalogs change under a running workspace — a CLI update ships new
    // models, skills appear mid-session — so every session start re-reads
    // both (captureModels also refreshes the command inventory).
    void this.captureModels(query);
    return session;
  }

  private async readSession(session: LiveSession): Promise<void> {
    const memory = createClaudeEventMemory();
    memory.resolveModel = id => this.modelAliases.get(id) ?? id;
    memory.rateLimited = this.rateLimitedSessions.has(session.id);
    try {
      for await (const message of session.query) {
        this.captureCommands(message);
        this.trackSessionLevel(session, message, memory);
        const normalized = normalizeClaudeMessage(message, memory, "live", session.id);
        if (memory.rateLimited) this.rateLimitedSessions.add(session.id); else this.rateLimitedSessions.delete(session.id);
        this.adoptRefusalFallback(session.id, message);
        // A retry or a compaction names a state of the conversation's own
        // turn. Outside one (a background subagent's retry, the CLI's side
        // title call) there is no turn to hold prompts for: the state is
        // dropped, and with it the resume that would follow.
        if (session.pendingTurns === 0 && !session.unpromptedTurn && normalized.updates.some(update => update.kind === "status" && (update.status === "retrying" || update.status === "compacting"))) {
          normalized.updates = normalized.updates.filter(update => !(update.kind === "status" && (update.status === "retrying" || update.status === "compacting")));
          memory.transient = undefined;
        }
        // The level signal precedes the start edge (spike, D9): the edge is
        // what carries the tool-use link, so the live entry learns it here.
        if (normalized.eventType === "system" && (message as { subtype?: unknown }).subtype === "task_started") {
          const started = message as { task_id?: unknown; tool_use_id?: unknown };
          const entry = typeof started.task_id === "string" ? session.backgroundTasks.get(started.task_id) : undefined;
          if (entry && typeof started.tool_use_id === "string" && started.tool_use_id) entry.toolUseId = started.tool_use_id;
        }
        // A turn the CLI started by itself (the follow-up after a settled
        // background task, D9): report it running so the composer and the
        // held-message queue treat it like any turn.
        // Only a session that has already finished a turn can be woken (a
        // fresh control session's boot init is not a turn), and only by the
        // conversation's own frames: a backgrounded subagent keeps streaming
        // frames tagged with its parent tool use, and those are not a turn.
        const ownFrame = !(message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
        if (session.pendingTurns === 0 && !session.unpromptedTurn && session.resultsSeen > 0 && ownFrame && this.live.get(session.id) === session
          && (normalized.eventType === "assistant" || normalized.eventType === "stream_event" || (normalized.eventType === "system" && (message as { subtype?: unknown }).subtype === "init"))) {
          session.unpromptedTurn = true;
          this.clearIdleTimer(session);
          this.emit(session.id, { updates: [{ kind: "status", status: "running" }], outcome: "handled", eventType: "turn.unprompted" });
        }
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
        // for this very session — or background work is still live (D7) —
        // retire the query; the next prompt resumes fresh.
        if (normalized.eventType === "result") {
          session.pendingTurns = Math.max(0, session.pendingTurns - 1);
          session.unpromptedTurn = false;
          session.resultsSeen += 1;
          // The CLI's own count of user sends still queued behind this
          // result (a prompt accepted while the CLI ran its follow-up turn):
          // those turns are pending whatever this counter says, so the
          // session must not retire under them.
          const queued = (message as { queued_turn_count?: unknown }).queued_turn_count;
          session.queuedTurns = typeof queued === "number" && queued > 0 ? queued : 0;
          // The turn's status is already out; the authoritative breakdown
          // follows it as a context report (D1). Not awaited here: the
          // reader must stay free to consume a next turn the adapter may
          // already have delivered on the completed status, or the CLI's
          // own follow-up (D9). Bounded and best-effort: a failure leaves
          // the per-message carrier as the readout's source.
          // Retirement follows the report but never holds the reader: a held
          // prompt the completed status released can land in this very
          // session meanwhile, and its events must be read as they come.
          // The idle check is made once the report is in, against the
          // counters and the background set as they stand then; a retired
          // query ends this loop.
          const report = this.reportContextUsage(session, memory.lastModel);
          // Claude Code assigns its own title after a turn; the chooser
          // follows it unless the user renamed the conversation (D12). A
          // transcript read, independent of the process: never awaited.
          void this.refreshGeneratedTitle(session.id);
          if (session.backgroundTasks.size > 0 && session.pendingTurns === 0) {
            // Not idle: the composer shows background work, prompting stays
            // possible, and the process stays up for the tasks (spec).
            this.emit(session.id, { updates: [{ kind: "status", status: "background" }], outcome: "handled", eventType: "turn.background" });
          }
          void report.then(async generation => {
            // A set that emptied while the report was out has armed the
            // follow-up grace timer (D9); retirement is that timer's call.
            // A probe a later turn overtook is not the one to retire on:
            // that turn's own continuation decides, once its read is in.
            if (session.idleTimer !== undefined || session.reportGeneration !== generation) return;
            if (this.sessionIsIdle(session) && this.live.get(session.id) === session) await this.retireSession(session);
          });
        }
      }
      // The stream ended without dispose: the session's process is gone.
      if (!this.disposed && this.live.get(session.id) === session) {
        this.live.delete(session.id);
        this.foldSessionTotals(session);
        // A grace window in flight means the conversation still reads as
        // background work with an empty set: this exit is its idle edge.
        const inGrace = session.idleTimer !== undefined;
        this.clearIdleTimer(session);
        this.abandonInteractions(session.id, "The session ended before the user answered.");
        // A clean CLI exit mid-turn still ends the turn: without a terminal
        // status the adapter keeps the conversation running, prompts stay
        // held, and cancellation finds nothing to interrupt. Background
        // work died with the process: its rows settle and the state clears.
        const settled = this.settleBackgroundTasks(session, "The Claude Code session ended before this task finished.", memory);
        // A turn the CLI reported queued behind its follow-up is lost with
        // the process too: it was accepted, so it fails rather than vanishes.
        if (session.pendingTurns > 0 || session.unpromptedTurn || session.queuedTurns > 0) {
          this.emit(session.id, {
            updates: [...settled, { kind: "status", status: session.interrupted ? "interrupted" : "failed", message: "Claude Code session ended before finishing the turn" }],
            outcome: "handled",
            eventType: "result",
          });
        } else if (settled.length > 0 || inGrace) {
          this.emit(session.id, { updates: [...settled, { kind: "status", status: "idle" }], outcome: "handled", eventType: "turn.background-cleared" });
        }
      }
    } catch (error) {
      if (this.disposed || this.live.get(session.id) !== session) return;
      this.live.delete(session.id);
      this.foldSessionTotals(session);
      this.clearIdleTimer(session);
      this.abandonInteractions(session.id, "The session failed before the user answered.");
      this.emit(session.id, {
        updates: [
          ...this.settleBackgroundTasks(session, "The Claude Code session failed before this task finished.", memory),
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
    this.historyReuse.invalidate(sessionId);
    const target = context.turns[index]!;
    const session = await this.ensureLive(sessionId);
    if (!session.query.rewindFiles) throw new ReversibleHistoryTargetError();
    try {
      return await this.stageBoundaryOn(session, sessionId, context, target, index);
    } finally {
      // A session started only for this control call holds no turn; an idle
      // conversation keeps no process behind after a rewind, refused or not.
      if (this.sessionIsIdle(session)) await this.retireSession(session);
    }
  }

  private async stageBoundaryOn(session: LiveSession, sessionId: string, context: { turns: ReversibleClaudeTurn[]; state: ReversibleHistoryState }, target: ReversibleClaudeTurn, index: number): Promise<ReversibleHistoryResult> {
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
    // A clone on purpose: the stored snapshot must not gain entries until
    // the rewind has actually succeeded — a capture failure or a refused
    // non-dry rewind would otherwise leave the staged state polluted with
    // bytes captured from the intermediate workspace.
    const tipSnapshot = new Map<string, SnapshotEntry>(existing?.tipSnapshot ?? []);
    for (const filePath of preview.filesChanged ?? []) {
      const absolute = path.isAbsolute(filePath) ? filePath : path.join(this.workspacePath, filePath);
      if (tipSnapshot.has(absolute)) continue;
      tipSnapshot.set(absolute, await captureFileState(absolute));
    }
    // Write-ahead: the boundary and its tip bytes are durable BEFORE the
    // destructive rewind runs. A process killed between record and rewind
    // leaves a staged claim over tip-state files — a redo then restores
    // tip over tip, idempotently — whereas rewinding first risked changed
    // files with no recoverable record.
    // The corrective record is awaited like the write-ahead itself: a
    // refusal whose rollback never lands would leave the sidecar hiding
    // turns and advertising a redo this operation said did not happen.
    const stagedRollback = async () => {
      if (existing) this.staged.set(sessionId, existing);
      else this.staged.delete(sessionId);
      await this.queuePersist(this.durableSnapshot());
    };
    this.staged.set(sessionId, { boundaryIndex: index, tipSnapshot });
    try {
      await this.queuePersist(this.durableSnapshot());
    } catch (error) {
      if (existing) this.staged.set(sessionId, existing);
      else this.staged.delete(sessionId);
      throw new ReversibleHistoryTargetError(`the rewind could not be recorded (${error instanceof Error ? error.message : "write failed"}); nothing was changed`);
    }
    let result;
    try {
      result = await session.query.rewindFiles(target.uuid, { dryRun: false });
    } catch (error) {
      try {
        await stagedRollback();
      } catch (persistError) {
        throw new ReversibleHistoryTargetError(`${error instanceof Error ? error.message : "rewind failed"}; additionally the rollback could not be recorded: ${persistError instanceof Error ? persistError.message : "write failed"}`);
      }
      throw error;
    }
    if (!result.canRewind) {
      try {
        await stagedRollback();
      } catch (persistError) {
        throw new ReversibleHistoryTargetError(`${rewindRefusal(result.error)}; additionally the rollback could not be recorded: ${persistError instanceof Error ? persistError.message : "write failed"}`);
      }
      throw new ReversibleHistoryTargetError(rewindRefusal(result.error));
    }
    return {
      outcome: "changed",
      state: reversibleState(context.turns, index),
      restoredDraft: { text: target.text },
    };
  }

  /** Terminal redo: every hidden turn returns and the tip's bytes come back. */
  private async clearBoundary(sessionId: string, context: { turns: ReversibleClaudeTurn[]; state: ReversibleHistoryState }, stagedState: { boundaryIndex: number; tipSnapshot: Map<string, SnapshotEntry> }): Promise<ReversibleHistoryResult> {
    this.historyReuse.invalidate(sessionId);
    await this.restoreSnapshot(stagedState.tipSnapshot);
    this.staged.delete(sessionId);
    try {
      await this.queuePersist(this.durableSnapshot());
    } catch (error) {
      // The sidecar still claims the boundary; keep memory consistent with
      // it and refuse — the files are at tip and a retried redo restores
      // them idempotently once the record can be written.
      this.staged.set(sessionId, stagedState);
      throw new ReversibleHistoryTargetError(`the restore could not be recorded (${error instanceof Error ? error.message : "write failed"}); retry redo`);
    }
    return { outcome: "changed", state: reversibleState(context.turns, undefined) };
  }

  private async restoreSnapshot(snapshot: Map<string, SnapshotEntry>): Promise<void> {
    for (const [absolute, entry] of snapshot) {
      if (entry === null) {
        await fs.rm(absolute, { force: true });
        continue;
      }
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      // A legacy sidecar holds bare base64: bytes with the default mode.
      if (typeof entry === "string") {
        await fs.writeFile(absolute, Buffer.from(entry, "base64"));
        continue;
      }
      if (entry.kind === "symlink") {
        await fs.rm(absolute, { force: true });
        await fs.symlink(entry.target, absolute);
        continue;
      }
      await fs.rm(absolute, { force: true });
      await fs.writeFile(absolute, Buffer.from(entry.base64, "base64"), { mode: entry.mode });
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
    // The SDK names a fork "<title> (fork)" as a custom title unless told
    // otherwise; the conversation keeps the title it already shows.
    const title = (await this.getSession(sessionId))?.title;
    const replacement = lastVisible
      ? (await this.forkSession(previousNative, { upToMessageId: lastVisible.uuid, dir: this.workspacePath, ...(title ? { title } : {}) })).sessionId
      : randomUUID();
    const nativeBefore = this.activeNative.get(sessionId);
    const hadHidden = this.hiddenNative.has(replacement);
    this.activeNative.set(sessionId, replacement);
    this.hiddenNative.add(replacement);
    // Two-phase: the staged record survives, stamped with the commit, and
    // is deleted only once the replacement prompt is actually accepted. A
    // restart in between un-commits and keeps Redo real.
    stagedState.commit = { fork: replacement, ...(nativeBefore !== undefined ? { prior: nativeBefore } : {}) };
    try {
      // The redirect must be durable before the replacement is accepted —
      // a lost record would reattach the public id to its pre-fork history
      // while the continuation lands invisibly on the fork.
      await this.queuePersist(this.durableSnapshot());
    } catch (error) {
      if (nativeBefore === undefined) this.activeNative.delete(sessionId);
      else this.activeNative.set(sessionId, nativeBefore);
      if (!hadHidden) this.hiddenNative.delete(replacement);
      delete stagedState.commit;
      throw new ReversibleHistoryTargetError(`the revert could not be recorded (${error instanceof Error ? error.message : "write failed"}); the staged state was kept`);
    }
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
          staged?: Record<string, { boundaryIndex: number; tipSnapshot: Record<string, SnapshotEntry>; commit?: { fork: string; prior?: string } }>;
          modeBeforePlan?: Record<string, string>;
          deferredRenames?: Record<string, string>;
          pending?: Record<string, { title: string; createdAt: number; updatedAt: number }>;
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
            this.staged.set(id, { boundaryIndex: staged.boundaryIndex, tipSnapshot: new Map(Object.entries(staged.tipSnapshot)), ...(staged.commit ? { commit: staged.commit } : {}) });
          }
        }
        // Two-phase commit recovery: a staged entry still carrying its
        // commit marker means the replacement prompt was never accepted —
        // un-commit by restoring the pre-fork routing (the fork stays
        // hidden and unused) so the boundary and Redo remain real.
        for (const [id, staged] of this.staged) {
          if (!staged.commit) continue;
          let accepted = false;
          try {
            const { entries } = await readSessionTranscript(sessionTranscriptPath(this.workspacePath, staged.commit.fork, this.configDir));
            accepted = reversibleTurns(entries.filter(entry => !entry.isSidechain)).length > staged.boundaryIndex;
          } catch {
            // No fork transcript: nothing was accepted.
          }
          if (accepted) {
            // The continuation happened; the lost finalization is replayed.
            this.staged.delete(id);
            continue;
          }
          if (this.activeNative.get(id) === staged.commit.fork) {
            if (staged.commit.prior === undefined) this.activeNative.delete(id);
            else this.activeNative.set(id, staged.commit.prior);
          }
          delete staged.commit;
        }
        // Without it, a restart mid-plan loses the "implement and return
        // to <mode>" intent the conversation still deserves.
        // A rename asked for before the first turn survives a restart the
        // same way the pending session it names does.
        for (const [id, title] of Object.entries(stored.deferredRenames ?? {})) {
          if (typeof title === "string" && title && !this.deferredRenames.has(id)) this.deferredRenames.set(id, title);
        }
        for (const [id, mode] of Object.entries(stored.modeBeforePlan ?? {})) {
          if (!this.modeBeforePlan.has(id)) this.modeBeforePlan.set(id, mode);
        }
        // A created-but-unprompted conversation has no native transcript
        // yet; without this its successful creation vanishes on restart.
        for (const [id, summary] of Object.entries(stored.pending ?? {})) {
          if (!this.pending.has(id)) {
            this.pending.set(id, { id, title: summary.title, directory: this.workspacePath, createdAt: summary.createdAt, updatedAt: summary.updatedAt });
          }
        }
      } catch {
        // A corrupt sidecar is dropped; the next persist rewrites it.
      }
    })();
    return this.durableRestore;
  }

  /**
   * The serialized, atomic write behind every persist. Returned so a
   * critical mutation (a rewind that already changed files) can await the
   * record instead of acknowledging on a swallowed failure.
   */
  private queuePersist(snapshot: string): Promise<void> {
    const write = this.persistChain.then(async () => {
      await fs.mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
      const temporary = `${this.stateFile}.tmp`;
      await fs.writeFile(temporary, snapshot);
      await fs.rename(temporary, this.stateFile);
    });
    this.persistChain = write.catch(() => undefined);
    return write;
  }

  private durableSnapshot(): string {
    return JSON.stringify({
      configurations: Object.fromEntries(this.configurations),
      activeNative: Object.fromEntries(this.activeNative),
      hiddenNative: [...this.hiddenNative],
      staged: Object.fromEntries([...this.staged].map(([id, staged]) =>
        [id, { boundaryIndex: staged.boundaryIndex, tipSnapshot: Object.fromEntries(staged.tipSnapshot), ...(staged.commit ? { commit: staged.commit } : {}) }])),
      modeBeforePlan: Object.fromEntries(this.modeBeforePlan),
      deferredRenames: Object.fromEntries(this.deferredRenames),
      pending: Object.fromEntries([...this.pending.values()].map(session =>
        [session.id, { title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt }])),
    });
  }

  /** Serialized write-behind; the last snapshot wins. */
  private persistDurableState(): void {
    this.queuePersist(this.durableSnapshot()).catch(() => undefined);
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
    return this.awaitInteraction<ClaudePermissionResult>(sessionId, {
      requestId,
      kind: questions ? "question" : "permission",
      item,
      input,
      suggestions: options.suggestions,
      signal: options.signal,
      abandoned: reason => ({ behavior: "deny", message: reason }),
      ...(questions ? {
        // AskUserQuestion expects answers keyed by the full question text on
        // its own input; a multi-select answer joins its labels.
        onAnswer: answers => {
          const record: Record<string, string> = {};
          questions.forEach((question, index) => { record[question.prompt] = (answers[index] ?? []).join(", "); });
          return { behavior: "allow", updatedInput: { ...input, answers: record } };
        },
        onReject: () => ({ behavior: "deny", message: "The user declined to answer." }),
      } : {}),
    });
  }

  /**
   * An MCP server's elicitation (D6): a form-mode request becomes one
   * question step per schema property (enum and boolean fields as choices,
   * the rest free-form), a URL-mode request a single "done" confirmation
   * with the link to open. Accept returns the coerced values; decline and
   * a dead session return their own MCP actions.
   */
  private brokerElicitation(sessionId: string, request: ClaudeElicitationRequest, options: { signal: AbortSignal; requestId: string }): Promise<ClaudeElicitationResult | null> {
    const requestId = options.requestId || randomUUID();
    const createdAt = this.now();
    const { questions, coerce } = elicitationQuestions(request);
    const item: QuestionRequest = {
      id: `question:${requestId}`,
      type: "question",
      createdAt,
      requestId,
      questions,
      status: "pending",
      source: "elicitation",
      intro: `${request.title ?? request.displayName ?? request.serverName} asks: ${request.message}`,
      ...(request.mode === "url" && request.url && /^https?:\/\//i.test(request.url) ? { link: request.url } : {}),
      ...(request.requestedSchema ? { schema: request.requestedSchema } : {}),
    };
    return this.awaitInteraction<ClaudeElicitationResult>(sessionId, {
      requestId,
      kind: "question",
      item,
      input: {},
      suggestions: undefined,
      signal: options.signal,
      abandoned: () => ({ action: "cancel" }),
      onAnswer: answers => request.mode === "url" ? { action: "accept" } : { action: "accept", content: coerce(answers) },
      onReject: () => ({ action: "decline" }),
    });
  }

  /**
   * A tool-driven blocking dialog (D6): a known kind renders as choices with
   * its own result vocabulary; an undeclared kind — which the CLI should
   * never send — gets a card that can only dismiss it, the CLI's documented
   * answer for a kind the host does not render.
   */
  private brokerDialog(sessionId: string, request: ClaudeUserDialogRequest, options: { signal: AbortSignal; requestId: string }): Promise<ClaudeUserDialogResult | null> {
    const requestId = options.requestId || request.toolUseID || randomUUID();
    const createdAt = this.now();
    const dialog = dialogQuestions(request);
    const item: QuestionRequest = {
      id: `question:${requestId}`,
      type: "question",
      createdAt,
      requestId,
      questions: dialog.questions,
      status: "pending",
      source: "dialog",
      intro: dialog.intro,
      schema: { dialogKind: request.dialogKind, payload: request.payload },
    };
    return this.awaitInteraction<ClaudeUserDialogResult>(sessionId, {
      requestId,
      kind: "question",
      item,
      input: request.payload,
      suggestions: undefined,
      signal: options.signal,
      abandoned: () => ({ behavior: "cancelled" }),
      onAnswer: answers => dialog.result(answers),
      onReject: () => ({ behavior: "cancelled" }),
    });
  }

  /**
   * Registers one pending interaction and resolves with the request's own
   * result when the user answers, when the turn is interrupted (the SDK
   * aborts the signal), or when the session ends — never left hanging.
   */
  private awaitInteraction<T>(sessionId: string, registration: {
    requestId: string;
    kind: "permission" | "question";
    item: PermissionRequest | QuestionRequest;
    input: Record<string, unknown>;
    suggestions: unknown[] | undefined;
    signal: AbortSignal;
    abandoned: (reason: string) => T;
    onAnswer?: (answers: string[][]) => T;
    onReject?: () => T;
  }): Promise<T> {
    const { requestId, item } = registration;
    return new Promise<T>(resolve => {
      const settle = (result: T, resolution?: "answered") => {
        if (!this.interactions.has(requestId)) return;
        this.interactions.delete(requestId);
        registration.signal.removeEventListener("abort", onAbort);
        // The adapter publishes resolutions it brokered itself; only an
        // unanswered end (abort, session death) must resolve the card here.
        if (resolution !== "answered") {
          this.emit(sessionId, {
            updates: [{ kind: "upsert", item: item.type === "question"
              ? { ...item, status: "resolved", outcome: { kind: "rejected" } }
              : { ...item, status: "resolved", outcome: "rejected" } }],
            outcome: "handled",
            eventType: "interaction.abandoned",
          });
        }
        resolve(result);
      };
      const onAbort = () => settle(registration.abandoned("The turn was interrupted before the user answered."));
      // Registration precedes abort observation: settle() is a no-op until
      // the map holds this request, so an abort firing between the two
      // would strand a permanently pending card while Claude waits on the
      // callback. An already-aborted signal settles immediately.
      this.interactions.set(requestId, {
        requestId,
        conversationId: sessionId,
        kind: registration.kind,
        item,
        input: registration.input,
        suggestions: registration.suggestions,
        ...(registration.onAnswer ? { onAnswer: registration.onAnswer as (answers: string[][]) => unknown } : {}),
        ...(registration.onReject ? { onReject: registration.onReject as () => unknown } : {}),
        settle: result => settle(result as T, "answered"),
        abandon: reason => settle(registration.abandoned(reason)),
      });
      if (registration.signal.aborted) {
        onAbort();
        return;
      }
      registration.signal.addEventListener("abort", onAbort, { once: true });
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

  /**
   * A session-scoped refusal fallback is the CLI swapping the session's
   * model for good: the conversation's configuration follows, so the picker
   * tells the truth and the next process starts on the fallback rather than
   * handing the refused model back through the model option. A local
   * fallback (a subagent's) leaves the conversation alone.
   */
  private adoptRefusalFallback(sessionId: string, message: unknown): void {
    const record = message as { type?: unknown; subtype?: unknown; scope?: unknown; fallback_model?: unknown };
    if (record.type !== "system" || record.subtype !== "model_refusal_fallback" || record.scope === "local") return;
    if (typeof record.fallback_model !== "string" || !record.fallback_model) return;
    const modelId = this.modelAliases.get(record.fallback_model) ?? record.fallback_model;
    const current = this.configurations.get(sessionId);
    if (current?.model?.modelId === modelId) return;
    const configuration = { ...current, model: claudeModelSelection(modelId) };
    this.configurations.set(sessionId, configuration);
    this.persistDurableState();
    this.emit(sessionId, { updates: [], outcome: "handled", eventType: "model.fallback", configuration: { model: configuration.model } });
  }

  private requireInteraction(sessionId: string, requestId: string, kind: "permission" | "question"): PendingInteraction {
    const pending = this.interactions.get(requestId);
    if (!pending || pending.conversationId !== sessionId || pending.kind !== kind) {
      throw new Error(`no pending ${kind} ${requestId} for this conversation`);
    }
    return pending;
  }

  /**
   * The level signals the normalizer does not turn into items: the live
   * background set (replace semantics, ambient ids dropped) and the CLI's own
   * session state. Both feed retirement (D7); the set also decides when the
   * conversation reports the background state and when it returns to idle.
   */
  private trackSessionLevel(session: LiveSession, message: unknown, memory: ReturnType<typeof createClaudeEventMemory>): void {
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (record.type !== "system") return;
    // `session_state_changed` is deliberately not a retirement input: the
    // spike showed this CLI never emits it, and a level signal that can
    // arrive out of step with the result and the background set would only
    // add a second, unobserved path to retirement. Results and the
    // background set decide.
    if (record.subtype !== "background_tasks_changed" || !Array.isArray(record.tasks)) return;
    const next = new Map<string, { description: string; taskType?: string; toolUseId?: string; startedAt: number }>();
    // Every id the payload names, ambient ones included: a task that turned
    // ambient is still running and must not read as dropped.
    const named = new Set<string>();
    const ambient = new Set<string>();
    for (const value of record.tasks) {
      if (!value || typeof value !== "object") continue;
      const task = value as Record<string, unknown>;
      if (typeof task.task_id !== "string" || !task.task_id) continue;
      named.add(task.task_id);
      if (task.ambient === true) { ambient.add(task.task_id); continue; }
      const known = session.backgroundTasks.get(task.task_id) ?? memory.tasks.get(task.task_id);
      next.set(task.task_id, {
        description: typeof task.description === "string" && task.description ? task.description : known?.description ?? "Background task",
        ...(typeof task.task_type === "string" && task.task_type ? { taskType: task.task_type } : known?.taskType ? { taskType: known.taskType } : {}),
        ...(known?.toolUseId ? { toolUseId: known.toolUseId } : {}),
        startedAt: known && "startedAt" in known ? (known as { startedAt: number }).startedAt : (known as { createdAt?: number } | undefined)?.createdAt ?? this.now(),
      });
    }
    const previous = session.backgroundTasks;
    session.backgroundTasks = next;
    // The normalizer shows a task only once it is known to run in the
    // background; the level signal is that knowledge for tasks whose start
    // edge has not said so (or has not arrived).
    markTasksBackgrounded(memory, [...next].map(([taskId, task]) => ({ taskId, description: task.description, ...(task.taskType ? { taskType: task.taskType } : {}) })), this.now());
    // The level signal has replace semantics precisely so a missed bookend
    // cannot wedge a stale row: a task it names that never announced itself
    // gets its running row here, and one it dropped is settled here — the
    // notification that normally follows refines the outcome and summary.
    const reconciled: NormalizedProviderUpdate[] = [];
    for (const [taskId, task] of next) {
      if (previous.has(taskId) || memory.tasks.get(taskId)?.announced) continue;
      reconciled.push({ kind: "upsert", item: { id: `task:${taskId}`, type: "background_task", createdAt: task.startedAt, taskId, description: task.description, ...(task.taskType ? { taskType: task.taskType } : {}), ...(task.toolUseId ? { toolUseId: task.toolUseId } : {}), status: "running" } });
    }
    for (const taskId of ambient) {
      // Ambient is not user work, whether the task turned so or its start
      // edge simply beat this snapshot: its row leaves the list without an
      // outcome, and its progress edges (which carry no ambient flag) stay
      // out until a later level lists the task as user work again.
      memory.ambientTasks.add(taskId);
      const known = memory.tasks.get(taskId);
      if (!previous.has(taskId) && !(known?.announced && !known.settled)) continue;
      reconciled.push({ kind: "remove", itemId: `task:${taskId}` });
      if (known) known.announced = false;
    }
    for (const [taskId, task] of previous) {
      if (next.has(taskId) || ambient.has(taskId)) continue;
      // Already settled by its own notification: nothing to guess at.
      if (memory.tasks.get(taskId)?.settled) continue;
      // The level says only that the task ended, not how: the row closes as
      // stopped and says so, and the notification (when it comes) supplies
      // the real outcome and summary — a terminal row takes any but running.
      reconciled.push({ kind: "upsert", item: { id: `task:${taskId}`, type: "background_task", createdAt: task.startedAt, taskId, description: task.description, ...(task.taskType ? { taskType: task.taskType } : {}), ...(task.toolUseId ? { toolUseId: task.toolUseId } : {}), status: "stopped", summary: "The task left Claude Code's task list without reporting an outcome." } });
    }
    if (reconciled.length > 0) this.emit(session.id, { updates: reconciled, outcome: "handled", eventType: "background.reconciled" });
    if (next.size === 0 && session.pendingTurns === 0 && !session.unpromptedTurn) {
      // The set emptied with nothing pending. The CLI's own follow-up turn
      // (D9) arrives within a fraction of a second; a session that shows
      // none inside the grace window returns to idle and retires.
      this.clearIdleTimer(session);
      session.idleTimer = setTimeout(() => {
        session.idleTimer = undefined;
        if (this.live.get(session.id) !== session || !this.sessionIsIdle(session)) return;
        this.emit(session.id, { updates: [{ kind: "status", status: "idle" }], outcome: "handled", eventType: "turn.background-cleared" });
        void this.retireSession(session);
      }, this.backgroundGraceMs);
      (session.idleTimer as unknown as { unref?: () => void }).unref?.();
    } else if (next.size > 0) {
      this.clearIdleTimer(session);
    }
  }

  /** The live background rows of a session whose process is gone, settled as stopped. */
  private settleBackgroundTasks(session: LiveSession, summary: string, memory: ReturnType<typeof createClaudeEventMemory>): NormalizedProviderUpdate[] {
    const updates: NormalizedProviderUpdate[] = [];
    const live = new Map(session.backgroundTasks);
    // A start edge that beat its first level snapshot published a running
    // row the level set never held: it died with the process all the same.
    for (const [taskId, task] of memory.tasks) {
      if (live.has(taskId) || !task.announced || task.settled || memory.ambientTasks.has(taskId)) continue;
      live.set(taskId, { description: task.description, ...(task.taskType ? { taskType: task.taskType } : {}), ...(task.toolUseId ? { toolUseId: task.toolUseId } : {}), startedAt: task.createdAt });
    }
    for (const [taskId, task] of live) {
      const known = memory.tasks.get(taskId);
      if (known) known.settled = true;
      updates.push({ kind: "upsert", item: {
        id: `task:${taskId}`,
        type: "background_task",
        createdAt: task.startedAt,
        taskId,
        description: task.description,
        ...(task.taskType ? { taskType: task.taskType } : {}),
        ...(task.toolUseId ? { toolUseId: task.toolUseId } : {}),
        status: "stopped",
        summary,
      } });
    }
    session.backgroundTasks = new Map();
    return updates;
  }

  private clearIdleTimer(session: LiveSession): void {
    if (session.idleTimer === undefined) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
  }

  /** No accepted turn pending, no follow-up in flight, no live background work. */
  private sessionIsIdle(session: LiveSession): boolean {
    return session.pendingTurns === 0 && session.queuedTurns === 0 && !session.unpromptedTurn && session.backgroundTasks.size === 0;
  }

  /** Every live background task, for a reopened conversation's live list. */
  async listBackgroundTasks(): Promise<PendingBackgroundTask[]> {
    const tasks: PendingBackgroundTask[] = [];
    for (const session of this.live.values()) {
      for (const [taskId, task] of session.backgroundTasks) {
        tasks.push({ conversationId: session.id, taskId, description: task.description, ...(task.taskType ? { taskType: task.taskType } : {}), ...(task.toolUseId ? { toolUseId: task.toolUseId } : {}), startedAt: task.startedAt });
      }
    }
    return tasks;
  }

  /** Stop one background task; the CLI settles its row as stopped. */
  async stopTask(sessionId: string, taskId: string): Promise<void> {
    const session = this.live.get(sessionId);
    // A task that just settled is the common case: the stop button stays
    // until its row leaves the list. Not an error of the caller's making.
    if (!session || !session.backgroundTasks.has(taskId)) throw new BackgroundTaskUnavailableError("that background task is no longer running");
    if (!session.query.stopTask) throw new BackgroundTaskUnavailableError("this Claude Code install cannot stop background tasks");
    await session.query.stopTask(taskId);
  }

  /**
   * The `/usage` read: the plan windows when the login has plan limits, and
   * the session's own running totals; bounded like the context read.
   */
  private async readPlanUtilization(session: LiveSession): Promise<{ plan: PlanUtilization; session?: SessionTotals } | undefined> {
    const read = session.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (!read || this.live.get(session.id) !== session) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        read.call(session.query),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), CONTEXT_REPORT_TIMEOUT_MS); }),
      ]);
      // Answered with no windows (an API-key login): an explicit empty plan,
      // so the report states it rather than staying silent like a timeout.
      // That answer holds for the life of the process, so the plan is not
      // re-read; the call still goes out, because the same answer carries
      // the conversation's running totals, which change with every turn and
      // are the figure such a login budgets by.
      if (raw === null) return undefined;
      const plan = session.planUnavailable ? undefined : normalizePlanUtilization(raw);
      if (!plan) session.planUnavailable = true;
      const totals = this.accumulateSessionTotals(session, normalizeSessionTotals(raw));
      return { plan: plan ?? {}, ...(totals ? { session: totals } : {}) };
    } catch {
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * The conversation's totals as the readout states them: what this
   * process's retired queries spent plus the current query's own count,
   * from `since`. The read is remembered per query so retirement can fold
   * it; a count that went down is the CLI's own reset (a `/clear`), and
   * what stood before it is folded rather than lost.
   */
  private accumulateSessionTotals(session: LiveSession, read: SessionTotals | undefined): SessionTotals | undefined {
    const ledger = this.sessionLedgers.get(session.id);
    if (!ledger) return read;
    if (read) {
      if (session.lastTotals && read.costUsd < session.lastTotals.costUsd) this.foldSessionTotals(session);
      session.lastTotals = read;
    }
    const current = session.lastTotals ?? read;
    if (!current && !ledger.settled) return undefined;
    return { ...(current ? mergeSessionTotals(ledger.settled, current) : ledger.settled!), since: ledger.since };
  }

  /** A query that ends takes its counters with it: its last read joins the ledger. */
  private foldSessionTotals(session: LiveSession): void {
    const ledger = this.sessionLedgers.get(session.id);
    if (!ledger || !session.lastTotals) return;
    ledger.settled = mergeSessionTotals(ledger.settled, session.lastTotals);
    session.lastTotals = undefined;
  }

  /** Announces Claude Code's own title when it changed and no user rename stands. */
  private async refreshGeneratedTitle(sessionId: string, attempt = 0): Promise<void> {
    const timer = this.titleRefreshTimers.get(sessionId);
    if (timer !== undefined) { clearTimeout(timer); this.titleRefreshTimers.delete(sessionId); }
    try {
      const generation = this.renameGenerations.get(sessionId) ?? 0;
      const file = sessionTranscriptPath(this.workspacePath, this.nativeId(sessionId), this.configDir);
      // A rename asked for before the transcript existed is written now that
      // the first turn has created it, ahead of reading what it says.
      const deferred = this.deferredRenames.get(sessionId);
      // A newer rename during the existence check supersedes this one: the
      // native write must not land after it and overwrite it.
      if (deferred !== undefined && await fileExists(file) && (this.renameGenerations.get(sessionId) ?? 0) === generation && this.deferredRenames.get(sessionId) === deferred) {
        this.deferredRenames.delete(sessionId);
        await this.renameNativeSession(this.nativeId(sessionId), deferred, { dir: this.workspacePath }).catch(() => {
          if (!this.deferredRenames.has(sessionId)) this.deferredRenames.set(sessionId, deferred);
        });
        this.persistDurableState();
      }
      const titles = await readTranscriptTitles(file);
      if ((this.renameGenerations.get(sessionId) ?? 0) !== generation || this.disposed) return;
      const title = titles.customTitle ?? titles.generatedTitle;
      if (!title && attempt < this.titleRefreshDelaysMs.length && !this.deferredRenames.has(sessionId)) {
        // Not there yet: the CLI's title call may still be in flight.
        const handle = setTimeout(() => { this.titleRefreshTimers.delete(sessionId); void this.refreshGeneratedTitle(sessionId, attempt + 1); }, this.titleRefreshDelaysMs[attempt]);
        (handle as unknown as { unref?: () => void }).unref?.();
        this.titleRefreshTimers.set(sessionId, handle);
        return;
      }
      if (!title || this.announcedTitles.get(sessionId) === title) return;
      this.announcedTitles.set(sessionId, title);
      if (this.announcedTitles.size > 4_096) this.announcedTitles.clear();
      const pending = this.pending.get(sessionId);
      if (pending) this.pending.set(sessionId, { ...pending, title, updatedAt: this.now() });
      this.emit(sessionId, {
        updates: [],
        outcome: "handled",
        eventType: "session.updated",
        sessionLifecycle: { kind: "updated", id: sessionId, directory: this.workspacePath, title },
      });
    } catch {
      // No transcript, no title: the prompt-derived one stands.
    }
  }

  /**
   * A UatuCode rename: recorded in the native session as a custom title, so
   * it outlives the workspace and outranks Claude Code's generated one.
   */
  async renameSession(sessionId: string, title: string): Promise<ProviderSession> {
    await this.restoreDurableState();
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`unknown Claude conversation: ${sessionId}`);
    if (session.parentId) throw new Error("a subagent transcript cannot be renamed");
    const trimmed = title.trim();
    this.renameGenerations.set(sessionId, (this.renameGenerations.get(sessionId) ?? 0) + 1);
    if (this.renameGenerations.size > 4_096) this.renameGenerations.clear();
    // A conversation that has not run a turn has no native transcript yet
    // (the SDK's rename throws on one): the title is kept here and written
    // to the transcript once the first turn has created it.
    if (await fileExists(sessionTranscriptPath(this.workspacePath, this.nativeId(sessionId), this.configDir))) {
      await this.renameNativeSession(this.nativeId(sessionId), trimmed, { dir: this.workspacePath });
      this.deferredRenames.delete(sessionId);
    } else {
      this.deferredRenames.set(sessionId, trimmed);
      this.persistDurableState();
    }
    this.announcedTitles.set(sessionId, trimmed);
    const pending = this.pending.get(sessionId);
    const renamed: ProviderSession = { ...session, title: trimmed, updatedAt: this.now() };
    if (pending) {
      this.pending.set(sessionId, renamed);
      this.persistDurableState();
    }
    this.emit(sessionId, {
      updates: [],
      outcome: "handled",
      eventType: "session.updated",
      sessionLifecycle: { kind: "updated", id: sessionId, directory: this.workspacePath, title: trimmed },
    });
    return renamed;
  }

  /** The CLI's own context breakdown, emitted as a report item after a turn. */
  private async reportContextUsage(session: LiveSession, model: string | undefined): Promise<number> {
    // One probe per turn; a probe a later turn's probe has overtaken says
    // nothing current and is dropped, so the newest report is the newest
    // turn's (newest-wins in the readout relies on that). The generation
    // is returned so the caller's continuation can tell whether it is
    // still the latest probe before acting on the session.
    const generation = (session.reportGeneration = (session.reportGeneration ?? 0) + 1);
    await this.probeContextUsage(session, model, generation);
    return generation;
  }

  private async probeContextUsage(session: LiveSession, model: string | undefined, generation: number): Promise<void> {
    if (!session.query.getContextUsage || this.live.get(session.id) !== session) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Plan utilization rides the same report when the login reports it
      // (claude.ai plans); an API-key session states an empty plan, and a
      // read that failed says nothing, leaving the previous report's plan.
      // Both reads go out together under one timer: they are independent.
      const planRead = this.readPlanUtilization(session);
      const raw = await Promise.race([
        session.query.getContextUsage(),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), CONTEXT_REPORT_TIMEOUT_MS); }),
      ]);
      if (raw === null || session.reportGeneration !== generation) return;
      const item = normalizeContextUsage(raw, this.now(), model);
      if (!item) return;
      const usage = await planRead;
      if (session.reportGeneration !== generation) return;
      this.emit(session.id, { updates: [{ kind: "upsert", item: usage !== undefined ? { ...item, ...usage } : item }], outcome: "handled", eventType: "context.reported" });
    } catch {
      // The per-message carrier stands.
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** An idle session holds no process: retire its query and its cards. */
  private async retireSession(session: LiveSession): Promise<void> {
    if (this.live.get(session.id) !== session) return;
    this.clearIdleTimer(session);
    this.live.delete(session.id);
    this.foldSessionTotals(session);
    this.abandonInteractions(session.id, "The turn ended before the user answered.");
    session.queue.close();
    await session.query.return?.().catch(() => undefined);
  }

  /** A session that ends cannot answer: its pending cards resolve visibly. */
  private abandonInteractions(sessionId: string, reason: string): void {
    for (const pending of [...this.interactions.values()]) {
      if (pending.conversationId === sessionId) pending.abandon(reason);
    }
  }

  private emit(conversationId: string, normalized: Omit<NormalizedProviderEvent, "conversationId">): void {
    this.historyReuse.invalidate(conversationId);
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
      this.commands = commands;
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
      // An empty replacement is a valid inventory — the last workspace
      // command may just have been removed.
      this.commands = commands;
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
    const description = typeof info.description === "string" && info.description ? info.description : undefined;
    const displayName = typeof info.displayName === "string" && info.displayName ? info.displayName : info.value;
    // Every surface names the model from this one field, so the version is
    // derived here once (D2). The default row keeps the CLI's own label;
    // surfaces name what it resolves to.
    const name = isDefault ? displayName : versionedModelName(displayName, description, resolvedModel);
    const variants = Array.isArray(info.supportedEffortLevels)
      ? info.supportedEffortLevels.filter((level): level is string => typeof level === "string")
      : undefined;
    if (resolvedModel) resolvedByIndex.set(models.length, resolvedModel);
    models.push({
      selection: { providerId: "anthropic", modelId: info.value },
      provider: "Anthropic",
      name,
      ...(variants && variants.length > 0 ? { variants } : {}),
      ...(description ? { detail: description } : {}),
      ...(isDefault ? { default: true } : {}),
      ...(resolvedModel && resolvedModel !== info.value ? { resolvesTo: { providerId: "anthropic", modelId: resolvedModel } } : {}),
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
    const stripped = stripWindowMarker(resolved);
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

/**
 * What a rewind snapshot remembers about one path: enough to put back the
 * file type, mode, and symlink target — not only the bytes. A bare base64
 * string is the legacy sidecar form (bytes, default mode); null records
 * that the path did not exist at the tip.
 */
type SnapshotEntry =
  | { kind: "file"; mode: number; base64: string }
  | { kind: "symlink"; target: string }
  | string
  | null;

async function captureFileState(absolute: string): Promise<SnapshotEntry> {
  try {
    const stats = await fs.lstat(absolute);
    if (stats.isSymbolicLink()) return { kind: "symlink", target: await fs.readlink(absolute) };
    return { kind: "file", mode: stats.mode & 0o777, base64: await fs.readFile(absolute, "base64") };
  } catch (error) {
    // Only nonexistence means "restore by deleting". Any other failure
    // (unreadable mode, I/O error) must abort the rewind before it runs —
    // recording null here would make a later redo delete a file that
    // exists.
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw new ReversibleHistoryTargetError(`cannot snapshot ${absolute} before rewinding: ${error instanceof Error ? error.message : "read failed"}`);
  }
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

/**
 * `/usage` → everything the readout shows about the plan: the base
 * windows the composer summary reads, the per-model weekly windows, the
 * server-labelled model buckets, extra-usage credits, and the plan name.
 * Undefined when the login reports neither a window nor extra usage (an
 * API key), which the caller states as an empty plan; extra usage alone is
 * still a plan, since every time window is optional on the wire. Every field is read defensively: the
 * SDK marks this method experimental, and a shape change must cost a field,
 * not the report. `behaviors` is deliberately left behind (design D6).
 */
export function normalizePlanUtilization(raw: unknown): PlanUtilization | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  if (record.rate_limits_available !== true || !record.rate_limits || typeof record.rate_limits !== "object") return undefined;
  const limits = record.rate_limits as Record<string, unknown>;
  const fiveHour = planWindow(limits.five_hour);
  const sevenDay = planWindow(limits.seven_day);
  const sevenDayOpus = planWindow(limits.seven_day_opus);
  const sevenDaySonnet = planWindow(limits.seven_day_sonnet);
  const sevenDayOauthApps = planWindow(limits.seven_day_oauth_apps);
  const modelScoped = Array.isArray(limits.model_scoped)
    ? limits.model_scoped.flatMap((entry): PlanModelWindow[] => {
      const label = entry && typeof entry === "object" ? (entry as Record<string, unknown>).display_name : undefined;
      const window = planWindow(entry);
      return typeof label === "string" && label.trim() && window ? [{ label: label.trim(), ...window }] : [];
    })
    : [];
  const extraUsage = planExtraUsage(limits.extra_usage);
  if (!fiveHour && !sevenDay && !sevenDayOpus && !sevenDaySonnet && !sevenDayOauthApps && modelScoped.length === 0 && !extraUsage) return undefined;
  return {
    ...(typeof record.subscription_type === "string" && record.subscription_type ? { subscription: record.subscription_type } : {}),
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    ...(sevenDayOpus ? { sevenDayOpus } : {}),
    ...(sevenDaySonnet ? { sevenDaySonnet } : {}),
    ...(sevenDayOauthApps ? { sevenDayOauthApps } : {}),
    ...(modelScoped.length ? { modelScoped } : {}),
    ...(extraUsage ? { extraUsage } : {}),
  };
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function planWindow(value: unknown): PlanUtilizationWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  const utilization = nonNegativeNumber(entry.utilization);
  const resetsAt = typeof entry.resets_at === "string" ? Date.parse(entry.resets_at) : typeof entry.resets_at === "number" ? (entry.resets_at < 1e12 ? entry.resets_at * 1000 : entry.resets_at) : NaN;
  if (utilization === undefined && Number.isNaN(resetsAt)) return undefined;
  return { ...(utilization === undefined ? {} : { utilization }), ...(Number.isNaN(resetsAt) ? {} : { resetsAt: Math.round(resetsAt) }) };
}

function planExtraUsage(value: unknown): PlanExtraUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  if (typeof entry.is_enabled !== "boolean") return undefined;
  const usedCredits = nonNegativeNumber(entry.used_credits);
  const monthlyLimit = nonNegativeNumber(entry.monthly_limit);
  const utilization = nonNegativeNumber(entry.utilization);
  return {
    enabled: entry.is_enabled,
    ...(usedCredits === undefined ? {} : { usedCredits }),
    ...(monthlyLimit === undefined ? {} : { monthlyLimit }),
    ...(utilization === undefined ? {} : { utilization }),
    ...(typeof entry.currency === "string" && entry.currency ? { currency: entry.currency } : {}),
  };
}

/**
 * `/usage` → the session's own running totals. Present only when the agent
 * states a cost; counters it left out read as zero, and a model row whose
 * tally is not numbers is dropped rather than shown as zeros.
 */
export function normalizeSessionTotals(raw: unknown): SessionTotals | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const session = (raw as Record<string, unknown>).session;
  if (!session || typeof session !== "object") return undefined;
  const entry = session as Record<string, unknown>;
  const costUsd = nonNegativeNumber(entry.total_cost_usd);
  if (costUsd === undefined) return undefined;
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const models: SessionModelTotals[] = [];
  if (entry.model_usage && typeof entry.model_usage === "object") {
    for (const [id, value] of Object.entries(entry.model_usage as Record<string, unknown>)) {
      if (!id || !value || typeof value !== "object") continue;
      const usage = value as Record<string, unknown>;
      const fields = [usage.inputTokens, usage.outputTokens, usage.cacheReadInputTokens, usage.cacheCreationInputTokens, usage.costUSD];
      if (!fields.every(field => typeof field === "number" && Number.isFinite(field))) continue;
      const [input, output, cacheRead, cacheWrite, modelCost] = fields as number[];
      models.push({ id, input: input!, output: output!, cacheRead: cacheRead!, cacheWrite: cacheWrite!, costUsd: modelCost! });
    }
  }
  return {
    costUsd,
    apiDurationMs: count(entry.total_api_duration_ms),
    durationMs: count(entry.total_duration_ms),
    linesAdded: count(entry.total_lines_added),
    linesRemoved: count(entry.total_lines_removed),
    models,
  };
}

function defaultRenameSession(sessionId: string, title: string, options: { dir: string }): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { renameSession } = require("@anthropic-ai/claude-agent-sdk") as typeof import("@anthropic-ai/claude-agent-sdk");
  return renameSession(sessionId, title, { dir: options.dir });
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

function defaultForkSession(sessionId: string, options: { upToMessageId: string; dir: string; title?: string }): Promise<{ sessionId: string }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { forkSession } = require("@anthropic-ai/claude-agent-sdk") as typeof import("@anthropic-ai/claude-agent-sdk");
  return forkSession(sessionId, { upToMessageId: options.upToMessageId, dir: options.dir, ...(options.title ? { title: options.title } : {}) });
}

type PendingInteraction = {
  requestId: string;
  conversationId: string;
  kind: "permission" | "question";
  item: PermissionRequest | QuestionRequest;
  input: Record<string, unknown>;
  suggestions: unknown[] | undefined;
  // For a question: how the shared answer shape becomes this request's own
  // result (a tool allow, an MCP accept, a dialog choice), and what a
  // rejection returns.
  onAnswer?: (answers: string[][]) => unknown;
  onReject?: () => unknown;
  settle: (result: unknown) => void;
  abandon: (reason: string) => void;
};

/**
 * An elicitation's JSON schema → question steps, one per property, with a
 * coercion back to the schema's types on answer. Enum and boolean fields
 * are choices; everything else is free-form. A schema without properties
 * asks for one confirmation.
 */
function elicitationQuestions(request: ClaudeElicitationRequest): { questions: StructuredQuestion[]; coerce: (answers: string[][]) => Record<string, unknown> } {
  if (request.mode === "url") {
    // A link the card can offer is http(s); any other scheme (an app's
    // OAuth callback) is spelled out in the prompt so the user can still
    // open it by hand.
    const linkable = typeof request.url === "string" && /^https?:\/\//i.test(request.url);
    return {
      questions: [{
        prompt: !request.url ? "Continue?" : linkable ? "Open the link to continue, then confirm here." : `Open ${request.url} to continue, then confirm here.`,
        header: "Open link",
        options: [{ label: "Done", description: "I finished the step in my browser" }],
        multiple: false,
        allowFreeForm: false,
      }],
      coerce: () => ({}),
    };
  }
  const schema = request.requestedSchema ?? {};
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? Object.entries(schema.properties as Record<string, unknown>) : [];
  if (properties.length === 0) {
    return {
      questions: [{ prompt: request.message, header: "Confirm", options: [{ label: "Accept", description: "" }], multiple: false, allowFreeForm: false }],
      coerce: () => ({}),
    };
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === "string") : []);
  // An optional field is an optional question: the form may submit it with
  // no answer, and the content then leaves that key out rather than
  // inventing a value. Nothing in-band — a user value can be any string.
  const fields = properties.map(([key, value]) => {
    const field = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const type = typeof field.type === "string" ? field.type : "string";
    // MCP's multi-select shape is an array whose items carry the enum; the
    // titled-enum shape is an anyOf of const/title entries. Both become
    // choices, the array one with several allowed.
    const items = type === "array" && field.items && typeof field.items === "object" && !Array.isArray(field.items) ? field.items as Record<string, unknown> : undefined;
    const source = items ?? field;
    const choices = enumChoices(source);
    return {
      key,
      type: items ? (typeof items.type === "string" ? items.type : "string") : type,
      multiple: items !== undefined,
      enumValues: choices.map(choice => choice.value),
      // Positional: a title supplied for only some choices must not slide
      // onto its neighbour.
      enumNames: choices.map(choice => choice.name),
      integer: type === "integer" || (items !== undefined && items.type === "integer"),
      minimum: typeof field.minimum === "number" ? field.minimum : undefined,
      maximum: typeof field.maximum === "number" ? field.maximum : undefined,
      minLength: typeof field.minLength === "number" ? field.minLength : undefined,
      maxLength: typeof field.maxLength === "number" ? field.maxLength : undefined,
      format: typeof field.format === "string" ? field.format : undefined,
      minItems: typeof field.minItems === "number" ? field.minItems : undefined,
      maxItems: typeof field.maxItems === "number" ? field.maxItems : undefined,
      optional: !required.has(key),
      title: typeof field.title === "string" && field.title ? field.title : key,
      description: typeof field.description === "string" ? field.description : "",
    };
  });
  // Every option needs a non-empty, distinct label (the wire rejects an
  // empty one, and two alike could not be told apart on answer): an empty
  // enum value is named, and repeats are numbered. Answers map back by
  // position in this list, never by parsing the label.
  const enumLabels = (field: typeof fields[number]): string[] => {
    const seen = new Map<string, number>();
    return field.enumValues.map((entry, index) => {
      const base = field.enumNames[index] ?? (String(entry).trim() || "(empty)");
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      return count > 1 ? `${base} (${count})` : base;
    });
  };
  const questions: StructuredQuestion[] = fields.map(field => {
    const options = field.enumValues.length > 0
      ? enumLabels(field).map(label => ({ label, description: "" }))
      : field.type === "boolean"
        ? [{ label: "Yes", description: "" }, { label: "No", description: "" }]
        : [];
    // The constraints the answer will be checked against, said up front.
    const constraints = field.type === "number" || field.integer
      ? [field.integer ? "whole number" : "number", field.minimum !== undefined ? `at least ${field.minimum}` : "", field.maximum !== undefined ? `at most ${field.maximum}` : ""]
      : field.multiple
        ? [field.minItems !== undefined ? `choose at least ${field.minItems}` : "", field.maxItems !== undefined ? `choose at most ${field.maxItems}` : ""]
        : [field.format ? formatLabel(field.format) : "", field.minLength !== undefined ? `at least ${field.minLength} characters` : "", field.maxLength !== undefined ? `at most ${field.maxLength} characters` : ""];
    const hint = constraints.filter(Boolean).join(", ");
    return {
      prompt: `${field.description || field.title}${hint ? ` (${hint})` : ""}`,
      header: field.title,
      options,
      multiple: field.multiple && options.length > 0,
      allowFreeForm: field.enumValues.length === 0 && field.type !== "boolean",
      ...(field.optional ? { optional: true } : {}),
    };
  });
  // Answers are checked against the schema before the interaction settles:
  // MCP validates the content and a rejected reply would land after the card
  // is gone, with no way to correct it. A refusal keeps the card pending.
  const coerce = (answers: string[][]): Record<string, unknown> => {
    const content: Record<string, unknown> = {};
    fields.forEach((field, index) => {
      const given = answers[index] ?? [];
      if (given.length === 0) return;
      const labels = enumLabels(field);
      const pick = (answer: string): unknown => {
        const chosen = labels.indexOf(answer);
        if (chosen >= 0) return field.enumValues[chosen];
        if (field.enumValues.length > 0) throw new InvalidQuestionAnswerError(`${field.title}: choose one of the offered values`);
        if (field.type === "boolean") return answer === "Yes";
        if (field.type === "string") {
          if (field.minLength !== undefined && answer.length < field.minLength) throw new InvalidQuestionAnswerError(`${field.title}: enter at least ${field.minLength} characters`);
          if (field.maxLength !== undefined && answer.length > field.maxLength) throw new InvalidQuestionAnswerError(`${field.title}: enter at most ${field.maxLength} characters`);
          if (field.format && !matchesFormat(field.format, answer)) throw new InvalidQuestionAnswerError(`${field.title}: enter ${formatLabel(field.format)}`);
          return answer;
        }
        if (field.type === "number" || field.type === "integer") {
          const parsed = Number(answer.trim());
          if (!Number.isFinite(parsed) || answer.trim() === "") throw new InvalidQuestionAnswerError(`${field.title}: enter a number`);
          if (field.integer && !Number.isInteger(parsed)) throw new InvalidQuestionAnswerError(`${field.title}: enter a whole number`);
          if (field.minimum !== undefined && parsed < field.minimum) throw new InvalidQuestionAnswerError(`${field.title}: enter at least ${field.minimum}`);
          if (field.maximum !== undefined && parsed > field.maximum) throw new InvalidQuestionAnswerError(`${field.title}: enter at most ${field.maximum}`);
          return parsed;
        }
        return answer;
      };
      if (field.multiple) {
        if (field.minItems !== undefined && given.length < field.minItems) throw new InvalidQuestionAnswerError(`${field.title}: choose at least ${field.minItems}`);
        if (field.maxItems !== undefined && given.length > field.maxItems) throw new InvalidQuestionAnswerError(`${field.title}: choose at most ${field.maxItems}`);
      }
      content[field.key] = field.multiple ? given.map(pick) : pick(given[0]!);
    });
    return content;
  };
  return { questions, coerce };
}

/** The string formats MCP elicitation schemas may name, as the user reads them. */
function formatLabel(format: string): string {
  return ({ email: "an email address", uri: "a URL", date: "a date (YYYY-MM-DD)", "date-time": "a date and time (ISO 8601)" } as Record<string, string>)[format] ?? `a ${format}`;
}

/** A real calendar day, or null: Date.parse would quietly roll 2025-02-30 into March. */
function calendarDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

/** A conservative check for the formats the MCP spec allows on elicitation strings; unknown formats pass. */
function matchesFormat(format: string, value: string): boolean {
  switch (format) {
    case "email": return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case "uri": try { new URL(value); return true; } catch { return false; }
    case "date": return calendarDate(value) !== null;
    case "date-time": {
      // RFC 3339: full date, "T", time with seconds, optional fraction, zone.
      const match = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.exec(value);
      return match !== null && calendarDate(match[1]!) !== null && !Number.isNaN(Date.parse(value));
    }
    default: return true;
  }
}

/** The enum a schema (or an array's items) offers, in either MCP spelling. */
function enumChoices(schema: Record<string, unknown>): Array<{ value: string | number | boolean; name?: string }> {
  const scalar = (entry: unknown): entry is string | number | boolean => ["string", "number", "boolean"].includes(typeof entry);
  if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return schema.enum.filter(scalar).map((value, index) => ({ value, ...(typeof names[index] === "string" ? { name: names[index] as string } : {}) }));
  }
  const variants = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : [];
  return variants.flatMap(variant => {
    if (!variant || typeof variant !== "object" || Array.isArray(variant)) return [];
    const record = variant as Record<string, unknown>;
    if (!scalar(record.const)) return [];
    return [{ value: record.const, ...(typeof record.title === "string" && record.title ? { name: record.title } : {}) }];
  });
}

/**
 * A dialog kind → its card and result vocabulary. `refusal_fallback_prompt`
 * (the one kind declared) offers the retry and the edit; anything else can
 * only be dismissed, which the CLI treats as its default behaviour.
 */
function dialogQuestions(request: ClaudeUserDialogRequest): { intro: string; questions: StructuredQuestion[]; result: (answers: string[][]) => ClaudeUserDialogResult } {
  const payload = request.payload;
  if (request.dialogKind === "refusal_fallback_prompt") {
    const original = typeof payload.originalModel === "string" && payload.originalModel ? payload.originalModel : "the current model";
    const fallback = typeof payload.fallbackModel === "string" && payload.fallbackModel ? payload.fallbackModel : "the fallback model";
    const retry = `Retry on ${fallback}`;
    const edit = "Edit the prompt";
    return {
      intro: `Claude Code asks how to continue after ${original} declined this request.`,
      questions: [{
        prompt: typeof payload.guidanceText === "string" && payload.guidanceText ? payload.guidanceText : `${original} declined to continue. The turn can be retried on ${fallback}.`,
        header: "Refusal",
        options: [
          { label: retry, description: "Rerun this turn on the fallback model" },
          { label: edit, description: "Stop this turn so the request can be changed" },
        ],
        multiple: false,
        allowFreeForm: false,
      }],
      // The result vocabulary is the CLI's own for this kind: its dialog
      // registry declares `result: enum(["retry_fallback", "edit_prompt",
      // "cancelled"])` with `cancelled` as the default (Claude Code 2.1.258;
      // not surfaced in the SDK's types, read from the CLI bundle).
      result: answers => {
        const answer = answers[0]?.[0];
        if (answer === retry) return { behavior: "completed", result: "retry_fallback" };
        if (answer === edit) return { behavior: "completed", result: "edit_prompt" };
        return { behavior: "cancelled" };
      },
    };
  }
  const kind = request.dialogKind.replaceAll("_", " ");
  return {
    intro: `Claude Code asks for a "${kind}" dialog this client cannot render; dismissing applies the dialog's default.`,
    questions: [{
      prompt: JSON.stringify(payload).slice(0, 400) || "(no details)",
      header: kind.charAt(0).toUpperCase() + kind.slice(1),
      options: [{ label: "Dismiss", description: "Apply the dialog's default behaviour" }],
      multiple: false,
      allowFreeForm: false,
    }],
    result: () => ({ behavior: "cancelled" }),
  };
}

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
  // An MCP or custom tool's input rarely uses the conventional keys; a
  // resource-less non-plan card would be suppressed by the projection and
  // leave the SDK's callback waiting unanswerable. Describe the input
  // compactly instead — the arguments ARE the resource.
  if (resources.length === 0) {
    const compact = JSON.stringify(input);
    resources.push(compact && compact !== "{}" ? (compact.length > 200 ? `${compact.slice(0, 199)}…` : compact) : "(no arguments)");
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

  /**
   * Ends every outstanding read without closing: banked values stay for
   * the next consumer. What an aborted subscriber's replacement needs.
   */
  detachWaiters(): void {
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  take(): Promise<IteratorResult<T>> {
    return this[Symbol.asyncIterator]().next();
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
