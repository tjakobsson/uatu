import { OpenCode } from "@opencode/client";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { OpenCodeNotificationLifecycle } from "../notification-lifecycle";
import { McpServerNames, annotateMcpPermission, looksLikeMcpPermission, mcpToolFromAction } from "../mcp-tools";
import { OPENCODE_PERMISSION_SCOPE_NOTE } from "../permission-scope";
import { stableProviderId } from "../message-id";
import { measureChatWork } from "../../performance";
import { HistoryReuse, historyPageCursor, historyPageEnd, historyVersion } from "../../history-reuse";
import { BackgroundTaskUnavailableError, InterruptNotAppliedError, OperationOutcomeUnknownError, InvalidQuestionAnswerError, ReversibleHistoryTargetError, type PendingInboxEntry } from "../../provider";
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
import { pendingPermissionFields, number as numberField } from "../normalization";
import { BackgroundControls, BackgroundWorkers, launcherChanged, retainLauncherEvidence, sameLauncherIdentity, shellCommandFingerprint, workerExecutionIds, type ControlRead, type LauncherEvidence, type WorkerOccurrenceEvidence } from "./background";
import { createOpenCodeV2Memory, createOpenCodeV2Normalizer, formPresentation, modelSelection, normalizeStoredMessage, pendingInboxEntry, prepareStoredMessage, storedAccounting, storedPromptId, supportedFormFields, type V2Evidence } from "./normalization";
import type { ChatAccountChange, ChatAgent, ChatCommand, ChatLoginState, ChatMode, ChatModel, ConversationConfiguration, MessageDelivery, ModelSelection, RestoredDraft, ReversibleHistoryResult, ReversibleHistoryState } from "../../types";
import { TASK_OUTPUT_TAIL_MAX_BYTES } from "../../types";

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
type StopValidation = {
  parent: string; taskId: string; child?: string; changed: boolean;
  launchCalls?: readonly string[];
  pendingChanges: Set<string>;
  pendingLaunches: Map<string, { child?: string; call?: string; background?: boolean; selectedOnly?: boolean; evidence?: LauncherEvidence }>;
  occurrence?: WorkerOccurrenceEvidence;
  pendingChangeBytes: number;
  pendingLaunchBytes: number;
  pendingBytes: number;
};
type OwnershipCheck = { child: string; parent: string; changed: boolean };
type ControlBasis = { basis: WorkerOccurrenceEvidence; revision: number };
type BackgroundSnapshot = { tasks: import("../../types").BackgroundTaskItem[]; occurrences: ReadonlyMap<string, WorkerOccurrenceEvidence>; controls: ReadonlyMap<string, ControlBasis> };

export function createOpenCodeV2Provider(options: {
  endpoint: string;
  password: string;
  directory: string;
  fetch?: typeof globalThis.fetch;
  commandAdmissionMs?: number;
  reloadSettleMs?: number;
}): ChatProvider {
  const authorization = `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}`;
  const client = OpenCode.make({
    baseUrl: options.endpoint,
    headers: { authorization },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return new OpenCodeV2Provider(client, options.directory, options.commandAdmissionMs, options.reloadSettleMs);
}

export class OpenCodeV2Provider implements ChatProvider {
  private readonly historyReuse = new HistoryReuse<StoredMessage[]>();
  // Only verified, workspace-confined parentage is reusable; never session
  // status, cost, timestamps, or failed checks. Match the live worker budget.
  private readonly childParents = new HistoryReuse<readonly [string, string]>(4 * 1024 * 1024, 8_192);
  private readonly childParentReads = new Map<string, { controller: AbortController; promise: Promise<readonly [string, string]>; users: number; settled: boolean }>();
  // Provider-wide admission, including recovery and final Stop validation.
  // Timed-out wrappers do not free slots held by an uncooperative transport.
  private childLookupsOutstanding = 0;
  // Only in-flight read-side authorizations, never a retained event ledger.
  private readonly stopValidations = new Set<StopValidation>();
  private readonly ownershipChecks = new Set<OwnershipCheck>();
  private readonly readLifetime = new AbortController();
  private streamReads?: AbortController;
  private readonly backgroundReads = new Map<string, Promise<BackgroundSnapshot>>();
  private readonly controls = new BackgroundControls({ changed: () => this.eventMemory?.workers.enforceBudget() });
  private eventMemory?: ReturnType<typeof createOpenCodeV2Memory>;
  private readonly notificationLifecycle = new OpenCodeNotificationLifecycle();
  // How many models the last catalog read offered; null before the first.
  private offeredModels: number | null = null;
  private readonly mcpServers = new McpServerNames(() => this.mcpServerNames());
  private readonly normalize: ReturnType<typeof createOpenCodeV2Normalizer>;
  private readonly workspace: string;
  // Slash-command admissions waiting for the stream to name their row: one
  // per session, since the adapter admits one send per conversation at a
  // time. Only a consumed `events()` can settle one.
  private readonly enqueuedUserWaiters = new Map<string, { resolve: (messageId: string) => void; generation: number }>();
  // An `events()` run is in progress: from entry to exit, handshake or not.
  // A waiter registered under an open run can match a row the run delivers
  // once its first frame has arrived.
  private streamOpen = false;
  // Counts `events()` runs. A waiter or a late record belongs to the stream
  // that could deliver its row; when that stream ends, neither may act on a
  // later stream's rows.
  private streamGeneration = 0;
  // Admissions whose window closed before the stream named the row: the
  // caller's optimistic row went in under the local id, and the server's
  // row, when it lands, retires it.
  private readonly lateAdmissions = new Map<string, Array<{ localId: string; until: number }>>();
  private static readonly LATE_ADMISSION_MS = 60_000;
  private streaming = false;
  private streamConnected = false;
  private streamSignal?: AbortSignal;
  private readonly streamReadyWaiters = new Set<(connected: boolean) => void>();
  // Ids this process minted itself (prompts, compactions). A row under one
  // of them is never a slash command's, however many admissions are
  // waiting: the server mints those.
  private readonly promptIds = new Set<string>();
  private static readonly PROMPT_ID_LIMIT = 512;
  // Events the provider itself has to put on the stream — a command refused
  // after its admission was reported — drained ahead of the next frame. They
  // are facts about this process's admissions, not about a stream, so they
  // wait out a disconnect and go out on the next stream. Bounded: with no
  // stream ever coming they must not grow without limit.
  private readonly injected: NormalizedProviderEvent[] = [];
  private static readonly INJECTED_LIMIT = 64;
  private wake: (() => void) | undefined;
  // Reloads waiting for the workspace's rebuilt catalogs to be announced.
  private readonly reloadWaiters = new Set<ReloadWaiter>();
  // Reloads run one at a time: a waiter armed while another reload is in
  // flight would be satisfied by that reload's rebuild, not its own.
  private reloadChain: Promise<unknown> = Promise.resolve();


  constructor(
    private readonly client: OpenCodeV2Client,
    private readonly directory: string,
    private readonly commandAdmissionMs = 1_000,
    // How long a reload waits for OpenCode to announce its rebuilt catalogs
    // before reporting success anyway (see `reload()`).
    private readonly reloadSettleMs = 10_000,
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
      // `steering` and `send-now` ride the 2.x session inbox: a steer is an
      // inbox entry OpenCode delivers at the next step boundary and can
      // cancel before then (opencode-v2-steering D2).
      capabilities: ["modes", "models", "commands", "questions", "permissions", "subagents", "variants", "context", "conversation-rename", "attachments", "reversible-history", "steering", "send-now", "background-tasks", "background-blocking-work", "side-generation"],
      permissionScopeNote: OPENCODE_PERMISSION_SCOPE_NOTE,
    };
  }

  /**
   * 2.x keeps skills in a catalog of their own: `command.list` answers only
   * config commands. The inventory is their union, then the built-ins, and
   * a name already taken is skipped in that order — config command, skill,
   * built-in — the precedence 1.x's server applies when it folds skills
   * into its command list. A skill is listed under its id, the token its
   * `@` mention and its prompt attachment key on.
   */
  async listCommands(): Promise<ChatCommand[]> {
    const [commands, skills] = await Promise.all([this.client.command.list(this.scope), this.client.skill.list(this.scope)]);
    const result: ChatCommand[] = [];
    const names = new Set<string>();
    const add = (command: ChatCommand) => {
      if (!/^[^\s/]+$/.test(command.name) || names.has(command.name)) return;
      names.add(command.name);
      result.push(command);
    };
    for (const command of commands.data) add({ name: command.name, description: command.description ?? "", argumentHint: "", kind: "command" });
    for (const skill of skills.data) add({ name: skill.id, description: skillDescription(skill), argumentHint: "", kind: "skill" });
    // The built-ins go in as the module's own objects: a caller handing one
    // back to `command()` as `listed` is recognised by identity.
    for (const builtin of BUILTIN_COMMANDS) add(builtin);
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
    const offered = models
      .filter(model => model.enabled !== false && model.status !== "deprecated")
      .map(model => {
        const variants = model.variants.map(variant => variant.id);
        const imageInput = model.capabilities.input.includes("image");
        return {
          selection: { providerId: model.providerID, modelId: model.modelID },
          provider: providerNames.get(model.providerID) ?? model.providerID,
          name: model.name,
          ...(variants.length ? { variants } : {}),
          ...(model.limit.context ? { contextLimit: model.limit.context, contextWindow: { source: "catalog" as const, freshness: "current" as const } } : {}),
          ...(imageInput ? { imageInput } : {}),
        };
      })
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name));
    this.offeredModels = offered.length;
    return offered;
  }

  // 2.x lists only models it can run: its free models need no login, and a
  // provider's models appear once it is logged in. So "missing" means no
  // model at all; unknown until the catalog has been read once.
  loginState(): ChatLoginState {
    if (this.offeredModels === null) return "unknown";
    return this.offeredModels > 0 ? "ok" : "missing";
  }

  /**
   * A login saved through another OpenCode server shows here on the next
   * read. A removal or switch is replayed on this server by credential id:
   * the store already reflects it, so the replay only updates what this
   * server holds in memory. A server without credential routes (2.0.13)
   * answers 404, which is ignored.
   */
  async accountsChanged(change: ChatAccountChange): Promise<void> {
    if (change.kind === "removed") {
      await this.client.credential.remove({ credentialID: change.credential } as Parameters<OpenCodeV2Client["credential"]["remove"]>[0]).catch(() => undefined);
    } else if (change.kind === "activated") {
      await this.client.credential.activate({ credentialID: change.credential } as Parameters<OpenCodeV2Client["credential"]["activate"]>[0]).catch(() => undefined);
    }
    await this.listModels().catch(() => undefined);
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
  async listMessages(sessionId: string, options: { cursor?: string; limit: number; signal?: AbortSignal }): Promise<ProviderHistoryPage> {
    const controlRead = this.beginControlRead(sessionId);
    let completeRead = false;
    try {
    const signal = this.readSignal(options.signal);
    const { complete, info, boundaryId, visible, normalized, excludedItemIds, version, end } = await this.readHistoryVisibility(sessionId, signal, controlRead, options.cursor);
    const start = Math.max(0, end - Math.max(1, options.limit));
    const page = visible.slice(start, end);
    const reversible = reversibleContext(complete, info);
    signal.throwIfAborted();
    const liveLaunches = new Set([...normalized.values()].flatMap(({ item }) => item.type === "background_task" && item.status === "running"
      ? [...(item.toolUseIds ?? []), ...(item.toolUseId ? [item.toolUseId] : [])].map(id => `tool:${id}`) : []));
    const accounting: StoredMessageAccounting[] = [];
    let newestPrompt: string | undefined;
    for (let index = 0; index < end; index += 1) {
      const message = visible[index]!;
      newestPrompt = storedPromptId(message) ?? newestPrompt;
      if (index < start) continue;
      const reported = storedAccounting(message);
      if (reported) accounting.push(newestPrompt === undefined ? reported : { ...reported, promptId: newestPrompt });
    }
    completeRead = true;
    return {
      items: [...normalized.values()].filter(({ item, index }) => index >= start && index < end
        || options.cursor === undefined && (item.type === "background_task" && item.status === "running" || liveLaunches.has(item.id))).map(({ item }) => item),
      accounting,
      ...(typeof info?.cost === "number" && Number.isFinite(info.cost) && info.cost >= 0 ? { sessionCostUsd: info.cost } : {}),
      completeItems: [...normalized.values()].map(({ item }) => item),
      revertVisibility: { boundaryId: boundaryId ?? null, state: reversible.state, excludedItemIds },
      ...(boundaryId ? { deliveryHistoryIncomplete: true as const } : {}),
      nextCursor: historyPageCursor(start, version),
    };
    } finally { this.controls.endRead(controlRead, completeRead); }
  }

  private async readHistoryVisibility(sessionId: string, signal: AbortSignal, controlRead: ControlRead, cursor?: string) {
    const complete = await this.allMessages(sessionId, signal);
    const info = await this.lookupSession(sessionId, signal);
    const boundaryId = stringValue(asRecord(asRecord(info).revert).messageID);
    const boundaryIndex = boundaryId ? complete.findIndex(message => messageIdentity(message) === boundaryId) : -1;
    const visible = boundaryIndex >= 0 ? complete.slice(0, boundaryIndex) : complete;
    const version = historyVersion([visible, boundaryId]);
    const end = historyPageEnd(cursor, version, visible.length);
    const normalized = await this.backgroundHistory(sessionId, visible, signal, controlRead);
    const allNormalized = boundaryIndex >= 0 ? await this.backgroundHistory(sessionId, complete, signal, controlRead) : normalized;
    const excludedItemIds = [...allNormalized.keys()].filter(id => !normalized.has(id));
    signal.throwIfAborted();
    return { complete, info, boundaryId, visible, normalized, allNormalized, excludedItemIds, version, end };
  }

  async getHistoryRevertBoundary(sessionId: string, options: { signal: AbortSignal; expectedBoundary?: string | null }): Promise<string | null> {
    const info = await this.lookupSession(sessionId, this.readSignal(options.signal));
    if (!info) throw new Error("OpenCode session disappeared while reading revert boundary");
    const boundary = stringValue(asRecord(info.revert).messageID) ?? null;
    if (options.expectedBoundary !== undefined && options.expectedBoundary !== boundary) this.historyReuse.invalidate(sessionId);
    return boundary;
  }

  private async backgroundHistory(sessionId: string, visible: StoredMessage[], signal = this.readSignal(), controlRead?: ControlRead, overlay = true) {
    signal = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
    // A finite complete-history fold is discarded after this read; only
    // long-lived stream memory uses the retention budget/fallback.
    const executionHistory = new Map<string, readonly number[]>();
    const workers = new BackgroundWorkers({ entries: Infinity, bytes: Infinity, executionHistory });
    const unavailableChildren = new Set<string>();
    // Only scoped session records establish child ownership. Tool metadata
    // supplies an identity to verify, never permission to read a foreign child.
    const prepared = visible.map(prepareStoredMessage);
    const children = new Set(prepared.flatMap(message => message.notificationChild ? [message.notificationChild] : [...message.tools.values()].flatMap(tool => {
        const child = tool.fact.reportedChild;
        const call = tool.fact.call;
        // Bind identity before the execution-history await, not ownership:
        // scoped session verification below still authorizes all reads.
        if (child && call) for (const validation of this.stopValidations) {
          if (validation.parent === sessionId && validation.taskId === `v2:${sessionId}:${call}`) this.bindStopChild(validation, child);
        }
        return child ? [child] : [];
      })));
    const verified = new Set<string>();
    await this.verifyChildren(children, sessionId, signal, child => verified.add(child));
    // Unverified ownership filters out the worker row below. That omission
    // cannot discharge inventory for a native background launch still in history.
    if (controlRead && prepared.some(message => [...message.tools.values()].some(tool => tool.name === "subagent" && tool.fact.background === true
      && tool.fact.reportedChild && !verified.has(tool.fact.reportedChild)))) this.controls.incompleteRead(controlRead);
    for (const child of verified) {
      workers.verifyChild(child, sessionId);
      const launches = prepared.flatMap(message => [...message.tools.values()]).filter(tool => tool.fact.reportedChild === child);
      if (launches.length > 1 || launches.some(tool => tool.fact.background === true)) {
        // An idle record is an execution boundary, not a worker report. It
        // constrains old-task authorization even before a newer foreground
        // launcher completes (or when another client continued the child).
        // An active child alone cannot verify that old occurrence.
        try {
          const idle = (await this.allMessages(child, signal)).filter(message => message.type === "idle");
          const ends = idle.map(message => numberField(asRecord(message.time).created));
          for (const end of ends) if (end !== undefined && end >= 0) workers.executionEnded(child, end);
          if (ends.every((end): end is number => end !== undefined && end >= 0)) executionHistory.set(child, ends);
          else unavailableChildren.add(child);
        } catch { unavailableChildren.add(child); }
      }
    }
    signal.throwIfAborted();
    const normalized = new Map<string, { item: import("../../types").ConversationItem; index: number }>();
    visible.forEach((message, index) => {
      for (const item of normalizeStoredMessage(message, true, { workers, parent: sessionId }, prepared[index])) {
        // The stored-message seam returns items rather than remove operations.
        // Retire the notification-first placeholder as soon as the same
        // provider result has acquired its canonical launch identity.
        if (item.type === "background_task" && item.resultId && item.toolUseId) {
          for (const [id, previous] of normalized) {
            if (previous.item.type === "background_task" && previous.item.resultId === item.resultId && id !== item.id) normalized.delete(id);
          }
        }
        const unavailable = item.type === "background_task" && item.status === "running" && item.childConversationId && unavailableChildren.has(item.childConversationId);
        if (unavailable && controlRead) this.controls.incompleteRead(controlRead);
        normalized.set(item.id, { item: unavailable ? { ...item, stateUncertain: true } : item, index });
      }
    });
    for (const update of workers.finishHistory()) if (update.kind === "upsert") {
      const entry = normalized.get(update.item.id);
      if (entry) normalized.set(update.item.id, { ...entry, item: update.item });
    }
    for (const [id, entry] of normalized) if (entry.item.type === "background_task" && entry.item.status !== "running") normalized.set(id, { ...entry,
      item: { ...entry.item, activity: this.terminalWorkerActivity(entry.item.taskId, workers.occurrence(entry.item.taskId)) } });
    if (overlay) for (const [id, entry] of normalized) if (entry.item.type === "background_task") normalized.set(id, { ...entry,
      item: this.controls.project(entry.item, workers.occurrence(entry.item.taskId), controlRead, workers.controlWitnesses(entry.item.taskId)) });
    this.eventMemory?.workers.enforceBudget();
    return Object.assign(normalized, { occurrences: workers.evidenceSnapshot(), workers });
  }

  async reconcileBackgroundTasks(sessionId: string, options?: { fresh?: boolean; signal?: AbortSignal }): Promise<import("../../types").BackgroundTaskItem[]> {
    const signal = this.readSignal(AbortSignal.any([AbortSignal.timeout(5_000), ...(options?.signal ? [options.signal] : [])]));
    const generation = this.streamGeneration;
    // Stop still reads the complete private snapshot, including hidden native
    // occurrences and their negative/control evidence. Only this public view
    // uses the same exact exclusions and alias fold as transcript recovery.
    const snapshot = await this.coveredRead(signal, () => this.backgroundSnapshot(sessionId, { ...options, signal }));
    const initialBoundary = await this.coveredRead(signal, () => this.getHistoryRevertBoundary(sessionId, { signal }));
    signal.throwIfAborted();
    if (generation !== this.streamGeneration) throw new Error("Background visibility changed during recovery");
    const copy = (item: import("../../types").BackgroundTaskItem) => ({ ...item, ...(item.toolUseIds ? { toolUseIds: [...item.toolUseIds] } : {}) });
    if (initialBoundary === null || snapshot.tasks.length === 0) return snapshot.tasks.map(copy);
    const controlRead = this.beginControlRead(sessionId);
    let completeRead = false;
    try {
      const { boundaryId, normalized, allNormalized, excludedItemIds } = await this.coveredRead(signal, () => this.readHistoryVisibility(sessionId, signal, controlRead));
      signal.throwIfAborted();
      if (generation !== this.streamGeneration || initialBoundary !== boundaryId) throw new Error("Background visibility changed during recovery");
      const excluded = new Set(excludedItemIds);
      const tasks = snapshot.tasks.filter(task => !excluded.has(task.id)).map(task => {
        const prefix = normalized.get(task.id)?.item;
        // Failed/partial ownership coverage is not permission to republish an
        // unclassified private row while native history is staged.
        if (prefix?.type !== "background_task") throw new Error("Background visibility unavailable");
        const fullOccurrence = snapshot.occurrences.get(task.taskId), visibleOccurrence = normalized.occurrences.get(task.taskId);
        // Preserve newer pending/live results for an exactly retained native
        // invocation. A reused id or folded hidden alias instead takes only
        // its visible prefix; neither path changes the full private basis.
        const sameOccurrence = fullOccurrence && visibleOccurrence && fullOccurrence.parent === visibleOccurrence.parent
          && fullOccurrence.worker === visibleOccurrence.worker && fullOccurrence.kind === visibleOccurrence.kind
          && fullOccurrence.launches.length === visibleOccurrence.launches.length
          && fullOccurrence.launches.every(launch => visibleOccurrence.launches.some(visible => sameLauncherIdentity(launch, visible)));
        const item = sameOccurrence && !(task.status === "running" && prefix.status !== "running") ? task : prefix;
        const projected = item.status === "running" && sameOccurrence && (task.stateUncertain || prefix.stateUncertain)
          ? { ...item, stateUncertain: true } : item;
        // The complete fold may have revoked this prefix's control after its
        // first projection. Respect that evidence without changing its basis.
        return copy(this.controls.project(projected, visibleOccurrence, controlRead, normalized.workers.controlWitnesses(task.taskId)));
      });
      // History authority excludes transcript rows, not an independently live
      // detached invocation. Its complete native identity must still match;
      // current native state alone never restores a missing/revoked Stop basis.
      const live: Array<{ item: import("../../types").BackgroundTaskItem; proof?: ControlBasis }> = [];
      let active: Awaited<ReturnType<OpenCodeV2Client["session"]["active"]>> | undefined;
      for (const task of snapshot.tasks) {
        if (!excluded.has(task.id) || task.status !== "running" || task.foreground) continue;
        const occurrence = snapshot.occurrences.get(task.taskId), currentOccurrence = allNormalized.occurrences.get(task.taskId);
        const canonical = allNormalized.get(task.id)?.item, proof = snapshot.controls.get(task.taskId), current = this.controls.proof(task.taskId);
        if (!occurrence || occurrence.uncertain || !currentOccurrence || currentOccurrence.uncertain
          || canonical?.type !== "background_task" || canonical.status !== "running"
          || occurrence.parent !== currentOccurrence.parent || occurrence.worker !== currentOccurrence.worker || occurrence.kind !== currentOccurrence.kind
          || occurrence.launches.length !== currentOccurrence.launches.length
          || !occurrence.launches.every(launch => currentOccurrence.launches.some(candidate => sameLauncherIdentity(launch, candidate)))) continue;
        let confirmed = false;
        if (task.taskType === "agent" && task.childConversationId === occurrence.worker) {
          const child = await this.lookupChild(occurrence.worker, signal);
          if (child?.parentID !== sessionId) throw new Error("Background visibility ownership unavailable");
          active ??= await this.coveredRead(signal, () => this.client.session.active({ signal }));
          confirmed = active[occurrence.worker] !== undefined;
        } else if (task.taskType === "shell" && task.outputFile === `shell:${occurrence.worker}`) {
          const shell = await this.coveredRead(signal, () => this.client.shell.get({ id: occurrence.worker, ...this.scope }, { signal }));
          confirmed = shell.data.metadata.sessionID === sessionId;
        }
        signal.throwIfAborted();
        // Visibility is not authorization. A gap/revocation can leave a known
        // native worker inspectable, but must never recreate its Stop proof.
        live.push({ item: { ...task, stateUncertain: !confirmed || canonical.stateUncertain === true || !proof || !current
          || current.basis !== proof.basis || current.revision !== proof.revision }, proof });
      }
      const boundary = await this.coveredRead(signal, () => this.getHistoryRevertBoundary(sessionId, { signal, expectedBoundary: boundaryId ?? null }));
      signal.throwIfAborted();
      if (generation !== this.streamGeneration || boundary !== boundaryId) throw new Error("Background visibility changed during recovery");
      for (const { item, proof } of live) {
        const current = this.controls.proof(item.taskId);
        tasks.push(copy(proof && current?.basis === proof.basis && current.revision === proof.revision ? item : { ...item, stateUncertain: true }));
      }
      completeRead = true;
      return tasks;
    } finally { this.controls.endRead(controlRead, completeRead); }
  }

  private backgroundSnapshot(sessionId: string, options?: { fresh?: boolean; signal?: AbortSignal }): Promise<BackgroundSnapshot> {
    if (options?.fresh) {
      const read = () => {
        // An older in-flight inventory is not post-action evidence. Invalidate
        // reuse (including child execution boundaries) before the new read.
        options.signal?.throwIfAborted();
        this.historyReuse.invalidate();
        return this.backgroundSnapshot(sessionId, { signal: options.signal });
      };
      const previous = this.backgroundReads.get(sessionId);
      return previous ? previous.catch(() => undefined).then(read) : read();
    }
    const pending = this.backgroundReads.get(sessionId);
    if (pending) return pending;
    const lifetime = new AbortController();
    const signal = this.readSignal(AbortSignal.any([lifetime.signal, ...(options?.signal ? [options.signal] : [])]));
    if (signal.aborted) return Promise.reject(new Error("Background recovery unavailable"));
    const timer = setTimeout(() => lifetime.abort(), 5_000);
    const controlRead = this.beginControlRead(sessionId, true);
    let completeRead = false;
    const read = this.coveredRead(signal, () => this.readBackgroundTasks(sessionId, signal, controlRead)).then(snapshot => {
      completeRead = true;
      return snapshot;
    }).finally(() => {
      this.controls.endRead(controlRead, completeRead);
      clearTimeout(timer);
      lifetime.abort();
      if (this.backgroundReads.get(sessionId) === read) this.backgroundReads.delete(sessionId);
    });
    this.backgroundReads.set(sessionId, read);
    return read;
  }

  private async readBackgroundTasks(sessionId: string, signal: AbortSignal, controlRead: ControlRead): Promise<BackgroundSnapshot> {
    if (!await this.lookupSession(sessionId, signal)) throw new Error("Background parent is unavailable");
    const [history, pending, active] = await Promise.all([
      this.allMessages(sessionId, signal),
      this.client.session.inbox.list({ sessionID: sessionId }, { signal }),
      this.client.session.active({ signal }).catch(() => undefined),
    ]);
    const stored = new Set(history.map(message => message.id));
    const notifications = (pending as unknown as StoredMessage[]).filter(entry => entry.type === "synthetic" && !stored.has(entry.id))
      .map(entry => ({ ...asRecord(entry.payload), id: entry.id, type: "synthetic", time: entry.time }));
    const folded = await this.backgroundHistory(sessionId, [...history, ...notifications], signal, controlRead, false);
    const retainedRequests = [...folded.occurrences.keys()].flatMap(id => {
      const request = this.eventMemory?.workers.linkedRequest(id, folded.occurrences.get(id));
      return request ? [request] : [];
    });
    const [pendingPermissions, pendingForms] = await Promise.all([
      retainedRequests.some(request => request.kind === "permission")
        ? this.client.permission.request.list(this.scope, { signal }).then(result => result.data).catch(() => undefined) : undefined,
      retainedRequests.some(request => request.kind === "question")
        ? this.client.form.list(this.scope, { signal }).then(result => result.data).catch(() => undefined) : undefined,
    ]);
    const tasks: import("../../types").BackgroundTaskItem[] = [];
    const observedAt = Date.now();
    for (const { item } of folded.values()) {
      if (item.type !== "background_task") continue;
      if (item.status !== "running") { tasks.push({ ...item, stateUncertain: false, activity: this.terminalWorkerActivity(item.taskId, folded.occurrences.get(item.taskId)) }); continue; }
      const occurrence = folded.occurrences.get(item.taskId);
      let confirmed = !!item.childConversationId && active?.[item.childConversationId] !== undefined;
      let shellExecuting = false;
      let shellEndedAt: number | undefined;
      if (item.taskType === "shell" && item.outputFile?.startsWith("shell:")) {
        const shell = await this.client.shell.get({ id: item.outputFile.slice(6), ...this.scope }, { signal }).catch(() => undefined);
        // Exit is not job settlement: capture may still be pending. The
        // unique owned shell remains controllable until its job result arrives.
        confirmed = shell?.data.metadata.sessionID === sessionId;
        const native = asRecord(shell?.data), time = asRecord(native.time);
        const command = shellCommandFingerprint(native.command);
        const matched = confirmed && command !== undefined && occurrence?.launches.every(launch => launch.commandFingerprint === command);
        shellExecuting = matched === true && native.status === "running";
        shellEndedAt = matched && ["exited", "timeout", "killed"].includes(String(native.status)) ? numberField(time.completed) : undefined;
      }
      // Neither a successful but inconclusive lookup nor an absent active
      // child is positive verification for an overlapping transcript caller.
      if (!confirmed) this.controls.incompleteRead(controlRead);
      const live = occurrence && this.eventMemory?.workers.activityEvidence(occurrence);
      // A complete scoped fold with one compatible occurrence plus fresh native
      // inventory is independent positive evidence, even without Stop retention.
      // Missing child history, intervening boundaries and live contradictions
      // keep this path closed; historical running metadata alone never opens it.
      const unique = occurrence && !occurrence.uncertain && !item.stateUncertain
        && [...folded.occurrences.values()].filter(other => other.worker === occurrence.worker && other.kind === occurrence.kind).length === 1;
      const liveOccurrence = occurrence && this.eventMemory?.workers.hasRetainedReference(occurrence);
      const coveredColdRead = this.streamGeneration === 0 || this.streamGeneration === 1 && this.streamConnected;
      const compatibleCurrent = !liveOccurrence && coveredColdRead || !!live && !live.uncertain;
      const verified = confirmed && unique && compatibleCurrent
        && (item.taskType === "shell" ? shellExecuting : true);
      const lastSeen = this.eventMemory?.workers.lastActivity(item.taskId, occurrence)?.observedAt;
      const executionAliases = workerExecutionIds(occurrence), executionId = executionAliases[0];
      const activity: import("../../types").WorkerActivity = live?.executionEnd || shellEndedAt !== undefined
        ? { kind: "ended", observedAt: lastSeen, endedAt: live?.executionEnd?.created ?? shellEndedAt, executionId, generation: this.streamGeneration }
        : verified || confirmed && live && !live.uncertain && live.executionStart
          ? { kind: "working", observedAt, executionId, generation: this.streamGeneration }
          : { kind: confirmed && item.taskType === "agent" ? "session-active" : "unavailable", observedAt: lastSeen, executionId, generation: this.streamGeneration };
      if (executionAliases.length) activity.executionAliases = executionAliases;
      const request = live && this.eventMemory?.workers.linkedRequest(item.taskId, occurrence);
      const pendingRequests = request?.kind === "permission" ? pendingPermissions : pendingForms;
      if (request && pendingRequests?.some(entry => entry.id === request.id && entry.sessionID === occurrence?.worker)
        && activity.kind !== "ended") { activity.kind = "needs-answer"; activity.request = request; activity.observedAt = observedAt; }
      else if (request && pendingRequests && !pendingRequests.some(entry => entry.id === request.id && entry.sessionID === occurrence?.worker)) this.eventMemory?.workers.resolveRequest(request.id, request.kind, occurrence?.worker);
      if (live) this.eventMemory?.workers.rememberActivity(item.taskId, activity, occurrence);
      tasks.push({ ...item, activity, stateUncertain: item.stateUncertain === true || !confirmed });
    }
    signal.throwIfAborted();
    const projected = tasks.map(original => {
      let item = original;
      // Later shell/ownership awaits can overlap a newer child boundary. Keep
      // that independent activity fence as well as the control read guard.
      const occurrence = folded.occurrences.get(item.taskId);
      const raw = occurrence && this.eventMemory?.workers.hasRetainedReference(occurrence);
      const current = occurrence && this.eventMemory?.workers.activityEvidence(occurrence);
      if (item.activity?.kind === "needs-answer") {
        const request = this.eventMemory?.workers.linkedRequest(item.taskId, occurrence);
        if (!request || request.id !== item.activity.request?.id || request.kind !== item.activity.request?.kind)
          item = { ...item, activity: { ...item.activity, kind: "working", request: undefined } };
      }
      if ((item.activity?.kind === "working" || item.activity?.kind === "needs-answer") && raw && (!current || current.uncertain)) item = { ...item,
        activity: { ...item.activity, kind: current?.executionEnd ? "ended" : item.taskType === "agent" && active?.[item.childConversationId ?? ""] ? "session-active" : "unavailable",
          request: undefined,
          ...(current?.executionEnd ? { endedAt: current.executionEnd.created } : {}) } };
      const projected = this.controls.project(item, folded.occurrences.get(item.taskId), controlRead, folded.workers.controlWitnesses(item.taskId));
      return { ...projected, control: { available: item.status === "running" && !projected.stateUncertain,
        ...(projected.stateUncertain ? { reason: "Worker control is unverified" } : {}) } };
    });
    this.eventMemory?.workers.enforceBudget();
    return { tasks: projected, occurrences: folded.occurrences, controls: new Map(projected.flatMap(item => {
      const proof = this.controls.proof(item.taskId);
      return proof ? [[item.taskId, proof] as const] : [];
    })) };
  }

  private terminalWorkerActivity(taskId: string, occurrence?: WorkerOccurrenceEvidence): import("../../types").WorkerActivity {
    const executionAliases = workerExecutionIds(occurrence);
    const live = occurrence && this.eventMemory?.workers.activityEvidence(occurrence);
    return { kind: "ended", executionId: executionAliases[0], ...(executionAliases.length ? { executionAliases } : {}),
      observedAt: this.eventMemory?.workers.lastActivity(taskId, occurrence)?.observedAt,
      endedAt: live?.executionEnd?.created ?? occurrence?.executionEnd?.created, generation: this.streamGeneration };
  }

  private beginControlRead(parent: string, inventory = false): ControlRead {
    const read = this.controls.beginRead(parent, this.controls.activeReads + this.ownershipChecks.size < 16, this.streamConnected, inventory);
    this.eventMemory?.workers.enforceBudget();
    return read;
  }

  private readSignal(signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([this.readLifetime.signal, ...(this.streamReads ? [this.streamReads.signal] : []), ...(signal ? [signal] : [])]);
  }

  private invalidateChildParents(child?: string): void {
    this.childParents.invalidate(child);
    // Existing readers retain their independent lifecycle/ownership guards.
    // Invalidating reuse for a sibling event must not cancel their requests.
    if (child === undefined) this.childParentReads.clear();
    else this.childParentReads.delete(child);
  }

  private bindStopChild(validation: StopValidation, child: string): void {
    if (validation.child && validation.child !== child || validation.pendingChanges.has(child)) validation.changed = true;
    validation.child = child;
    validation.pendingChanges.clear();
    validation.pendingBytes -= validation.pendingChangeBytes;
    validation.pendingChangeBytes = 0;
    for (const [key, launch] of validation.pendingLaunches) {
      if (launch.child !== child && validation.occurrence && validation.launchCalls && !this.selectedStopCall(validation, launch.call)) {
        const bytes = JSON.stringify([key, launch]).length * 2 + (validation.pendingLaunches.size > 1 ? 2 : 0);
        validation.pendingLaunches.delete(key);
        validation.pendingLaunchBytes -= bytes;
        validation.pendingBytes -= bytes;
      }
    }
    this.refreshStopBytes(validation);
  }

  private bindStopTask(validation: StopValidation, task: import("../../types").BackgroundTaskItem, occurrence?: WorkerOccurrenceEvidence, authoritative = false): void {
    if (occurrence && (validation.occurrence || authoritative)) {
      if (validation.occurrence && occurrence.launches.some(fact => launcherChanged(fact, validation.occurrence))) validation.changed = true;
      // Freeze the first occurrence, never replace it with a later read/fold.
      validation.occurrence ??= occurrence;
      const additional = occurrence.launches.filter(fact => !validation.occurrence!.launches.some(prior => prior.call === fact.call));
      if (additional.length) validation.occurrence = Object.freeze({ ...validation.occurrence, launches: Object.freeze([...validation.occurrence.launches, ...additional]) });
      if (occurrence.uncertain) validation.changed = true;
    }
    validation.launchCalls = (validation.occurrence ?? occurrence)?.launches.map(launch => launch.call)
      ?? (task.toolUseIds ? [...task.toolUseIds] : task.toolUseId ? [task.toolUseId] : []);
    this.refreshStopBytes(validation);
    if (task.childConversationId) this.bindStopChild(validation, task.childConversationId);
    // A restated alias of this same occurrence is not a replacement launch.
    // Only the provider's folded aliases establish that equivalence.
    if (this.stopLaunchChanged(validation)) validation.changed = true;
    // Until fresh recovery binds the selected occurrence, a stream row may
    // already describe its replacement. Keep candidates for that comparison.
    if (validation.occurrence || authoritative) this.clearStopEvidence(validation);
    else this.refreshStopBytes(validation);
  }

  private stopLaunchChanged(validation: StopValidation): boolean {
    return [...validation.pendingLaunches.values()].some(launch => launch.evidence && launcherChanged(launch.evidence, validation.occurrence)
      || !!validation.child && (this.selectedStopCall(validation, launch.call)
        ? launch.child !== validation.child || launch.background === false
        : !launch.selectedOnly && !!validation.launchCalls && launch.child === validation.child));
  }

  private selectedStopCall(validation: StopValidation, call?: string): boolean {
    return `v2:${validation.parent}:${call}` === validation.taskId || !!validation.launchCalls?.includes(call ?? "");
  }

  private clearStopEvidence(validation: StopValidation): void {
    validation.pendingChanges.clear();
    validation.pendingLaunches.clear();
    validation.pendingChangeBytes = 0;
    validation.pendingLaunchBytes = 0;
    this.refreshStopBytes(validation);
  }

  private refreshStopBytes(validation: StopValidation): void {
    // Exact logical retained payload, not JavaScript heap usage. Include the
    // frozen baseline, aliases, identities, latch and every candidate field.
    const base = () => JSON.stringify([validation.parent, validation.taskId, validation.child ?? null, validation.launchCalls ?? null, validation.occurrence ?? null, validation.changed, [], []]).length * 2;
    validation.pendingBytes = base() + validation.pendingChangeBytes + validation.pendingLaunchBytes;
    if (validation.pendingBytes <= 1024 * 1024 && this.stopEvidenceEntries(validation) <= 2_048) return;
    validation.changed = true;
    validation.occurrence = undefined;
    validation.launchCalls = undefined;
    validation.pendingChanges.clear(); validation.pendingLaunches.clear();
    validation.pendingChangeBytes = validation.pendingLaunchBytes = 0;
    validation.pendingBytes = base();
  }

  private stopEvidenceEntries(validation: StopValidation): number {
    return validation.pendingChanges.size + validation.pendingLaunches.size + (validation.launchCalls?.length ?? 0) + (validation.occurrence?.launches.length ?? 0);
  }

  private revokeStop(validation: StopValidation): void { validation.changed = true; this.refreshStopBytes(validation); }

  private reserveStopEvidence(validation: StopValidation, bytes: number, entries = 1): boolean {
    // Four validations together stay within 8,192 entries / 4 MiB; overflow
    // refuses authorization instead of forgetting a potentially relevant fact.
    // The base above accounts identities, frozen occurrence, aliases and latch;
    // candidates add their complete UTF-16 JSON entries and array separators.
    // Each write accounts one complete entry plus its array separator.
    if (this.stopEvidenceEntries(validation) + entries > 2_048 || validation.pendingBytes + bytes > 1024 * 1024) {
      validation.changed = true;
      this.clearStopEvidence(validation);
      return false;
    }
    validation.pendingBytes += bytes;
    return true;
  }

  private noteStopChange(validation: StopValidation, child: unknown): void {
    if (validation.changed || typeof child !== "string" || !child || child.length > 512) return;
    if (validation.child) { if (validation.child === child) this.revokeStop(validation); return; }
    if (validation.pendingChanges.has(child)) return;
    const bytes = JSON.stringify(child).length * 2 + (validation.pendingChanges.size ? 2 : 0);
    // Before history identifies the child, retain candidate identities only.
    if (!this.reserveStopEvidence(validation, bytes)) return;
    validation.pendingChanges.add(child);
    validation.pendingChangeBytes += bytes;
  }

  private noteStopLaunch(validation: StopValidation, child: unknown, call: unknown, background?: boolean, selectedOnly?: boolean, evidence?: LauncherEvidence): void {
    if (validation.changed) return;
    if (evidence?.historical) return;
    if (evidence && launcherChanged(evidence, validation.occurrence)) { this.revokeStop(validation); return; }
    const callId = typeof call === "string" && call.length <= 512 ? call : undefined;
    const selected = this.selectedStopCall(validation, callId);
    if (selected && background === false) { this.revokeStop(validation); return; }
    if (selected && validation.child && typeof child === "string" && child !== validation.child) { this.revokeStop(validation); return; }
    const childId = typeof child === "string" && child.length > 0 && child.length <= 512 ? child : undefined;
    // A foreground restatement can omit the child. Retain its call identity
    // until the authoritative fold tells us whether it is a selected alias.
    if (!childId && (background !== false || !callId)) return;
    if (validation.child) {
      if (selected) {
        if (childId !== validation.child || background === false) this.revokeStop(validation);
        if (validation.occurrence?.launches.some(launch => launch.call === callId)) return;
      }
      if (validation.launchCalls && childId !== validation.child) return;
    }
    const key = JSON.stringify([childId, callId]);
    const previous = validation.pendingLaunches.get(key);
    const next = { child: childId, call: callId, background: previous?.background === false ? false : background ?? previous?.background,
      selectedOnly: previous && !previous.selectedOnly ? undefined : selectedOnly,
      evidence: evidence ? retainLauncherEvidence(previous?.evidence, { ...evidence, child: undefined, reportedChild: undefined, requestedChild: undefined, background: undefined, selectedOnly: undefined }) : previous?.evidence };
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return;
    const bytes = JSON.stringify([key, next]).length * 2 - (previous ? JSON.stringify([key, previous]).length * 2 : 0)
      + (!previous && validation.pendingLaunches.size ? 2 : 0);
    if (!this.reserveStopEvidence(validation, bytes, previous ? 0 : 1)) return;
    validation.pendingLaunches.set(key, next);
    validation.pendingLaunchBytes += bytes;
  }

  private observeStopEvent(evidence: V2Evidence): void {
    if (this.stopValidations.size === 0 && this.ownershipChecks.size === 0) return;
    const location = evidence.directory, parent = evidence.session;
    const shutdown = evidence.shutdown && (!location || path.resolve(location) === this.workspace);
    const lifecycle = evidence.lifecycle?.kind === "session.created" && this.controls.historical("created", evidence.lifecycle.proof) ? undefined : evidence.lifecycle;
    // Cache eviction is global and conservative; authorization revocation is
    // about the selected parent/child, even when its new location is foreign.
    for (const check of this.ownershipChecks) {
      if (shutdown || lifecycle && (lifecycle.id === check.parent || lifecycle.id === check.child)) check.changed = true;
    }
    for (const validation of this.stopValidations) {
      if (shutdown || lifecycle && lifecycle.id === validation.parent) this.revokeStop(validation);
      else if (lifecycle) this.noteStopChange(validation, lifecycle.id);
    }
    if (this.stopValidations.size === 0 || location && path.resolve(location) !== this.workspace) return;
    for (const validation of this.stopValidations) {
      if (evidence.execution && !evidence.execution.historical) this.noteStopChange(validation, parent);
      if (parent !== validation.parent) continue;
      if (evidence.notification && !evidence.notification.historical) this.noteStopChange(validation, evidence.notification.child);
      for (const reference of evidence.launchers) {
        if (reference.child || !reference.requestedChild) this.noteStopLaunch(validation, reference.child, reference.call, reference.background, reference.selectedOnly, reference);
        if (reference.requestedChild && reference.requestedChild !== reference.child) this.noteStopLaunch(validation, reference.requestedChild, reference.call, reference.background, reference.requestedSelectedOnly, reference);
      }
    }
  }

  private observeStopWorkerUpdates(event: NormalizedProviderEvent, memory: ReturnType<typeof createOpenCodeV2Memory>): void {
    for (const validation of this.stopValidations) {
      if (event.conversationId !== validation.parent) continue;
      for (const update of event.updates) {
        if (update.kind !== "upsert" || update.item.type !== "background_task") continue;
        const item = update.item;
        if (item.taskId === validation.taskId) this.bindStopTask(validation, item, memory.workers.occurrence(item.taskId));
        if (item.taskId === validation.taskId && (item.status !== "running" || item.stateUncertain)) this.revokeStop(validation);
        // A cold stream can discover an alias before recovery finds its first
        // launcher. Compare the retained facts after canonical identity binds.
        if (validation.occurrence && validation.child && item.childConversationId === validation.child && item.taskId !== validation.taskId) {
          const candidate = memory.workers.occurrence(item.taskId), basis = validation.occurrence;
          const provenAlias = candidate && candidate.parent === basis.parent && candidate.worker === basis.worker && candidate.kind === basis.kind
            && candidate.launches.length > 0 && candidate.launches.every(fact => basis.launches.some(prior => prior.call === fact.call
            && prior.message !== undefined && fact.message === prior.message && prior.workerType === fact.workerType) && !launcherChanged(fact, basis));
          if (!provenAlias) this.revokeStop(validation);
        }
      }
    }
  }

  private lookupChild(sessionId: string, signal: AbortSignal): Promise<SessionRecord | null> {
    signal.throwIfAborted();
    // No pending queue: at capacity the stream preserves unrelated parts and
    // history recovery reports unavailable until a real read settles.
    if (this.childLookupsOutstanding >= 4) throw new Error("Child ownership lookup capacity unavailable");
    this.childLookupsOutstanding++;
    const read = this.lookupSession(sessionId, signal).finally(() => { this.childLookupsOutstanding--; });
    // The actual SDK request owns the slot across deadline, reconnect, and
    // disposal. Observe late rejection even if its caller already retired.
    void read.catch(() => undefined);
    return this.coveredRead(signal, () => read);
  }

  private async verifiedChild(child: string, parent: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    if (child.length > 512 || parent.length > 512) return false;
    // Four recovery batches of four readers; no pending guard queue. These
    // scoped guards retire with their wrappers, not the underlying I/O slots.
    if (this.ownershipChecks.size + this.controls.activeReads >= 16) throw new Error("Child ownership check capacity unavailable");
    const check: OwnershipCheck = { child, parent, changed: false };
    let read = this.childParentReads.get(child), joined = false;
    this.ownershipChecks.add(check);
    try {
      if (!read) {
        // The shared lookup belongs to its readers collectively, not the first
        // caller's deadline or expected parent. Each reader checks its own parent.
        const controller = new AbortController();
        const sharedSignal = this.readSignal(controller.signal);
        const promise = this.childParents.read(child, this.streamConnected ? String(this.streamGeneration) : undefined, async () => {
          const info = await this.lookupChild(child, sharedSignal);
          const actualParent = stringValue(info?.parentID);
          if (!actualParent || ![...this.ownershipChecks].some(check => check.child === child && check.parent === actualParent && !check.changed)) throw UNVERIFIED_CHILD;
          return [child, actualParent] as const;
        });
        read = { controller, promise, users: 0, settled: false };
        this.childParentReads.set(child, read);
        const owned = read;
        void promise.finally(() => {
          owned.settled = true;
          if (this.childParentReads.get(child) === owned) this.childParentReads.delete(child);
        }).catch(() => undefined);
      }
      read.users++;
      joined = true;
      const joinedRead = read;
      try {
        const owner = await this.coveredRead(signal, () => joinedRead.promise);
        if (check.changed) throw new Error("Child ownership changed during read");
        return owner[1] === parent;
      } catch (error) {
        if (error === UNVERIFIED_CHILD) return false;
        throw error;
      }
    } finally {
      this.ownershipChecks.delete(check);
      if (joined && read && --read.users === 0 && !read.settled) {
        read.controller.abort();
        if (this.childParentReads.get(child) === read) {
          this.childParentReads.delete(child);
          this.childParents.invalidate(child);
        }
      }
    }
  }

  private async verifyChildren(children: Set<string>, parent: string, signal: AbortSignal, verified: (child: string) => void, tolerateUnavailable = false): Promise<void> {
    const pending = children.values();
    // One deadline for the whole batch, not one timeout per child. Four
    // readers match background recovery's concurrency budget.
    await Promise.all(Array.from({ length: Math.min(4, children.size) }, async () => {
      for (const child of pending) {
        if (signal.aborted) break;
        try {
          if (await this.verifiedChild(child, parent, signal)) verified(child);
        } catch (error) {
          // Stream lookup failures must not eat unrelated parts of the frame;
          // recovery retains its stronger failed-read-is-unknown contract.
          if (!tolerateUnavailable) throw error;
        }
      }
    }));
    if (!tolerateUnavailable) signal.throwIfAborted();
  }

  private async coveredRead<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    let aborted!: () => void;
    const unavailable = new Promise<never>((_resolve, reject) => { aborted = () => reject(new Error("Native recovery unavailable")); });
    signal.addEventListener("abort", aborted, { once: true });
    // Retire the shared owner even if a transport ignores cancellation. The
    // underlying read also checks this same signal before returning a value.
    try {
      const value = await Promise.race([read(), unavailable]);
      signal.throwIfAborted();
      return value;
    } finally { signal.removeEventListener("abort", aborted); }
  }

  private async allMessages(sessionId: string, signal = this.readSignal()): Promise<StoredMessage[]> {
    // Reuse only inside a connected stream generation. Every normalized
    // session event invalidates its entry (including an in-flight read),
    // and reconnect starts cold because V2 offers no provider event replay.
    signal.throwIfAborted();
    const messages = await this.historyReuse.read(sessionId, this.streamConnected ? String(this.streamGeneration) : undefined,
      () => this.coveredRead(signal, () => this.readAllMessages(sessionId, signal)));
    signal.throwIfAborted();
    return messages;
  }

  private async readAllMessages(sessionId: string, signal: AbortSignal): Promise<StoredMessage[]> {
    const finish = measureChatWork("opencode-read");
    try {
      const byId = new Map<string, StoredMessage>();
      let cursor: string | undefined;
      do {
        // The cursor encodes the direction, so `order` is sent only for the
        // first page.
        const page = await this.client.message.list(cursor
          ? { sessionID: sessionId, limit: 100, cursor }
          : { sessionID: sessionId, order: "asc", limit: 100 }, { signal });
        signal.throwIfAborted();
        for (const item of page.data as StoredMessage[]) byId.set(messageIdentity(item), item);
        cursor = page.data.length > 0 ? page.cursor.next ?? undefined : undefined;
      } while (cursor);
      return [...byId.values()].sort((left, right) => messageCreatedAt(left) - messageCreatedAt(right));
    } finally { finish(); }
  }

  waitForEventStream(signal: AbortSignal): Promise<void> {
    signal = AbortSignal.any([signal, this.readLifetime.signal, ...(this.streamSignal ? [this.streamSignal] : [])]);
    if (signal.aborted || !this.streamOpen) return Promise.reject(new Error("Event stream unavailable"));
    if (this.streamConnected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const finish = (connected: boolean) => {
        signal.removeEventListener("abort", aborted);
        this.streamReadyWaiters.delete(finish);
        if (connected) resolve(); else reject(new Error("Event stream unavailable"));
      };
      const aborted = () => finish(false);
      this.streamReadyWaiters.add(finish);
      signal.addEventListener("abort", aborted, { once: true });
    });
  }

  async *events(signal: AbortSignal): AsyncIterable<NormalizedProviderEvent> {
    this.historyReuse.invalidate();
    this.invalidateChildParents();
    this.backgroundReads.clear();
    const reads = new AbortController();
    this.streamReads = reads;
    const streamReadSignal = this.readSignal(AbortSignal.any([signal, reads.signal]));
    // Memory scoped to the subscription: one pump, one memory.
    const memory = createOpenCodeV2Memory({ controls: this.controls });
    this.eventMemory = memory;
    // Live only once a frame has arrived: until the subscription's first
    // frame (`server.connected`), a row broadcast may not have reached this
    // listener at all, so an admission from that gap may wait for a row
    // that arrives, but must not be remembered for one that may be lost.
    this.streamGeneration += 1;
    this.streamOpen = true;
    this.streamConnected = false;
    this.streamSignal = signal;
    const source = this.client.event.subscribe({ signal })[Symbol.asyncIterator]();
    let next: ReturnType<typeof source.next> | undefined;
    try {
      while (true) {
        // The provider's own events go first: a refusal reported here must
        // not queue behind a stream that may stay quiet.
        while (this.injected.length > 0) yield this.injected.shift()!;
        next ??= source.next();
        const woken = new Promise<undefined>(resolve => { this.wake = () => resolve(undefined); });
        const arrived = await Promise.race([next, woken]);
        this.wake = undefined;
        if (!arrived) continue;
        next = undefined;
        if (arrived.done) break;
        if (streamReadSignal.aborted) break;
        this.streaming = true;
        const event = arrived.value;
        // Only the native handshake establishes readiness, never an injected
        // event or merely constructing the subscription's async iterator.
        if (asRecord(event).type === "server.connected") {
          this.streamConnected = true;
          for (const ready of this.streamReadyWaiters) ready(true);
        }
        this.observeReload(event);
        // Normalization resolves every failure to an outcome, and anything
        // that still escapes must cost one event rather than ending the stream.
        let normalized: NormalizedProviderEvent;
        let controlUpdates: ReturnType<BackgroundControls["observe"]> = [];
        try {
          // One synchronous canonical read precedes every ownership await.
          const prepared = this.normalize.prepare(event, memory, this.controls);
          const evidence = prepared.evidence;
          controlUpdates = this.controls.observe(evidence, (!evidence.directory || path.resolve(evidence.directory) === this.workspace)
            && (!evidence.lifecycle?.directory || path.resolve(evidence.lifecycle.directory) === this.workspace),
            prepared.notification, prepared.notificationProof);
          memory.workers.enforceBudget();
          this.observeStopEvent(evidence);
          if (evidence.lifecycle?.kind === "session.created") {
            const id = evidence.lifecycle.id;
            if (id) this.invalidateChildParents(id);
            if (id && evidence.lifecycle.parent && evidence.lifecycle.directory && path.resolve(evidence.lifecycle.directory) === this.workspace) {
              memory.workers.observeBirth(id, evidence.lifecycle.parent, evidence.lifecycle.proof);
            } else if (id) memory.workers.invalidateActivity(id);
          }
          if (evidence.shellBirth?.parent && (!evidence.directory || path.resolve(evidence.directory) === this.workspace)) {
            memory.workers.observeBirth(evidence.shellBirth.id, evidence.shellBirth.parent, evidence.shellBirth.proof, evidence.shellBirth.commandFingerprint);
          } else if (evidence.shellBirth) memory.workers.invalidateActivity(evidence.shellBirth.id);
          if (evidence.shellExit && (!evidence.directory || path.resolve(evidence.directory) === this.workspace)) memory.workers.shellEnded(evidence.shellExit.id, evidence.shellExit.proof);
          // Membership changes invalidate even when the new location is
          // foreign or absent; a sparse deletion cannot authorize old facts.
          // Revoke ownership only: terminal occurrences, consumed notices,
          // and the recovery-only latch must survive until this stream ends.
          if (evidence.shutdown || evidence.lifecycle && evidence.lifecycle.kind !== "session.created") {
            this.invalidateChildParents();
            memory.workers.invalidateOwnership(evidence.shutdown ? undefined : evidence.lifecycle?.id);
            memory.workers.invalidateActivity(evidence.shutdown ? undefined : evidence.lifecycle?.id);
          }
          const location = evidence.directory;
          if (!location || path.resolve(location) === this.workspace) {
            const parent = evidence.session;
            // Persist negative evidence before any ownership await, including
            // when Stop starts while that read is still pending. This never
            // establishes ownership of a requested/replacement child.
            if (parent) for (const launcher of evidence.launchers) memory.workers.observeLauncher(parent, launcher);
            if (parent && evidence.notification) memory.workers.observeNotification(parent, evidence.notification.id, prepared.notification, evidence.notification.proof);
            const children = new Set<string>();
            if (evidence.notification) children.add(evidence.notification.child);
            // Requested input.sessionID is only a veto hint, never ownership
            // proof. Only reported child metadata enters scoped verification.
            for (const launcher of evidence.launchers) if (launcher.reportedChild) children.add(launcher.reportedChild);
            if (parent && children.size > 0) await this.verifyChildren(children, parent,
              AbortSignal.any([streamReadSignal, AbortSignal.timeout(1_000)]), child => memory.workers.verifyChild(child, parent), true);
          }
          if (streamReadSignal.aborted) break;
          normalized = this.normalize.prepared(prepared, memory);
          const requestChanges = new Set<string>();
          if (!evidence.directory || path.resolve(evidence.directory) === this.workspace) {
            if (evidence.directory && evidence.requestTool) memory.workers.observeRequestTool(evidence.requestTool.child, evidence.requestTool.source, evidence.requestTool.proof);
            for (const update of normalized.updates) {
              if (update.kind === "upsert" && (update.item.type === "permission" || update.item.type === "question")) {
                const item = update.item;
                if (item.status === "resolved") for (const child of memory.workers.resolveRequest(item.requestId, item.type, normalized.conversationId)) requestChanges.add(child);
                else if (evidence.directory && item.status === "pending" && evidence.requestSource?.kind === item.type
                  && normalized.conversationId === evidence.requestSource.child && item.conversationId === evidence.requestSource.child
                  && memory.workers.linkRequest(evidence.requestSource.child, item.requestId, item.type, evidence.requestSource.source)) requestChanges.add(evidence.requestSource.child);
              } else if (update.kind === "remove") {
                for (const kind of ["permission", "question"] as const) if (update.itemId.startsWith(`${kind}:`))
                  for (const child of memory.workers.resolveRequest(update.itemId.slice(kind.length + 1), kind, normalized.conversationId)) requestChanges.add(child);
              }
            }
          }
          const projectWorker = (item: import("../../types").BackgroundTaskItem) => {
            const occurrence = memory.workers.occurrence(item.taskId);
            const live = occurrence && memory.workers.activityEvidence(occurrence);
            const executionAliases = workerExecutionIds(occurrence), executionId = executionAliases[0];
            const lastSeen = memory.workers.lastActivity(item.taskId, occurrence)?.observedAt;
            const projected = this.controls.project(item, occurrence, undefined, memory.workers.controlWitnesses(item.taskId));
            const activity: import("../../types").WorkerActivity = live?.executionEnd
              ? { kind: "ended", observedAt: lastSeen, endedAt: live.executionEnd.created, executionId, generation: this.streamGeneration }
              : live && !live.uncertain && (live.executionStart || memory.workers.shellActivity(live))
                ? { kind: "working", observedAt: Date.now(), executionId, generation: this.streamGeneration }
                : { kind: evidence.execution?.phase === "started" ? "session-active" : "unavailable", observedAt: lastSeen, executionId, generation: this.streamGeneration };
            if (executionAliases.length) activity.executionAliases = executionAliases;
            const request = live && memory.workers.linkedRequest(item.taskId, occurrence);
            if (request && activity.kind === "working") { activity.kind = "needs-answer"; activity.request = request; }
            if (item.status === "running") memory.workers.rememberActivity(item.taskId, activity, occurrence);
            return { ...projected, activity: item.status === "running" ? activity : this.terminalWorkerActivity(item.taskId, occurrence),
              control: { available: item.status === "running" && !projected.stateUncertain,
                ...(projected.stateUncertain ? { reason: "Worker control is unverified" } : {}) } };
          };
          normalized.updates = normalized.updates.map(update => update.kind === "upsert" && update.item.type === "background_task"
            ? { ...update, item: projectWorker(update.item) } : update);
          const workerChange = evidence.execution ? evidence.session : evidence.shellExit?.id;
          if (workerChange) requestChanges.add(workerChange);
          for (const child of requestChanges) for (const task of memory.workers.childTasks(child)) {
            const item = projectWorker(task.item);
            const prior = controlUpdates.findIndex(update => update.item.taskId === item.taskId);
            if (prior >= 0) controlUpdates[prior] = { parent: task.parent, item };
            else controlUpdates.push({ parent: task.parent, item });
          }
          controlUpdates = controlUpdates.map(update => ({ ...update, item: projectWorker(update.item) }));
          for (const { parent, item } of controlUpdates) if (parent === normalized.conversationId && !normalized.updates.some(update => update.kind === "upsert" && update.item.id === item.id)) normalized.updates.push({ kind: "upsert", item });
          memory.workers.enforceBudget();
          this.observeStopWorkerUpdates(normalized, memory);
          const notificationTurns = this.notificationLifecycle.observe(event, normalized);
          if (notificationTurns.length > 0) { normalized.notificationTurns = notificationTurns; normalized.outcome = "handled"; }
          this.historyReuse.invalidate(normalized.conversationId);
          // A permission for an MCP tool names its server and tool, resolved
          // against the servers this OpenCode reports (mcp-tools.ts).
          if (McpServerNames.changedBy(normalized.eventType)) this.mcpServers.invalidate();
          normalized.updates = await Promise.all(normalized.updates.map(update => annotateMcpPermission(update, this.mcpServers)));
        } catch {
          normalized = { updates: [], outcome: "unparseable", eventType: "" };
        }
        yield normalized;
        // Child execution and workspace lifecycle facts revoke rows on their
        // owning parent's timeline, never on the child's conversation.
        for (const parent of new Set(controlUpdates.map(update => update.parent))) if (parent !== normalized.conversationId) yield {
          conversationId: parent, outcome: "handled", eventType: normalized.eventType,
          updates: controlUpdates.filter(update => update.parent === parent).map(({ item }) => ({ kind: "upsert" as const, item })),
        };
        // After the yield, not before: the consumer has applied this event
        // by the time the generator resumes, so a command admission settled
        // here returns after the streamed row landed — and the caller's own
        // upsert, the text the user typed, lands last.
        const retirement = this.reportEnqueuedUser(normalized);
        if (retirement) yield retirement;
      }
    } catch (error) {
      // Cancellation ends the stream quietly; anything else must reach the
      // pump's supervisor so it reconnects.
      if (!signal.aborted) throw error;
    } finally {
      reads.abort();
      if (!this.readLifetime.signal.aborted) this.controls.observationGap();
      if (this.eventMemory === memory) this.eventMemory = undefined;
      if (this.streamReads === reads) this.streamReads = undefined;
      this.historyReuse.invalidate();
      this.invalidateChildParents();
      this.backgroundReads.clear();
      this.streaming = false;
      this.streamOpen = false;
      this.streamConnected = false;
      this.streamSignal = undefined;
      for (const ready of this.streamReadyWaiters) ready(false);
      this.wake = undefined;
      // A row this stream never delivered is not coming on the next one:
      // the 2.x stream has no replay, so an admission still waiting would
      // only ever claim some later row that is not its own.
      this.lateAdmissions.clear();
      this.enqueuedUserWaiters.clear();
      // A frame still pending when the consumer stops would reject unheard.
      next?.catch(() => undefined);
      await source.return?.().catch(() => undefined);
    }
  }

  /**
   * What a slash name runs, with `listCommands()`'s precedence. With the
   * entry the caller classified the text against, it runs as that entry —
   * so a catalog entry removed or shadowed since is still sent as what the
   * user chose (and refused by OpenCode if gone), never falling through to
   * a built-in of the same name. Without one, the catalogs are read fresh.
   */
  private async commandTarget(name: string, listed?: ChatCommand): Promise<{ kind: "command" } | { kind: "compact" } | { kind: "reload" } | { kind: "skill"; skill: { id: string } }> {
    if (listed) {
      if (BUILTIN_COMMANDS.includes(listed)) return name === "reload" ? { kind: "reload" } : { kind: "compact" };
      if (listed.kind === "skill") return { kind: "skill", skill: { id: name } };
      return { kind: "command" };
    }
    const [commands, skills] = await Promise.all([this.client.command.list(this.scope), this.client.skill.list(this.scope)]);
    if (commands.data.some(command => command.name === name)) return { kind: "command" };
    const skill = skills.data.find(candidate => candidate.id === name);
    if (skill) return { kind: "skill", skill: { id: skill.id } };
    if (name === "reload") return { kind: "reload" };
    if (name === "compact" || name === "summarize") return { kind: "compact" };
    return { kind: "command" };
  }

  /**
   * A skill runs the way OpenCode's own 2.x clients run one: a prompt
   * carrying the skill as an attachment, whose text opens with the skill's
   * `@` mention. The server loads the skill into the turn by id; the text
   * is what the timeline, and history, show.
   */
  private async promptSkill(sessionId: string, messageId: string, skill: { id: string }, args: string): Promise<{ messageId: string; text: string }> {
    const mention = `@${skill.id}`;
    const text = args ? `${mention} ${args}` : mention;
    this.rememberPromptId(messageId);
    const admitted = await this.client.session.prompt({
      sessionID: sessionId,
      id: messageId,
      text,
      skills: [{ id: skill.id, mention: { start: 0, end: mention.length, text: mention } }],
      delivery: "queue",
      resume: true,
    });
    if (admitted.id !== messageId) this.rememberPromptId(admitted.id);
    // The row reads as what was sent, not as the typed `/skill`.
    return { messageId: admitted.id, text };
  }

  /**
   * `/reload`: OpenCode rebuilds its configuration for every location it
   * serves and continues any running turn under the new one. The call can
   * take seconds, so it is not raced against the admission window: the
   * caller hears "admitted" at once and the outcome arrives as events — a
   * notice that says the reload is running, then what came of it. The
   * `/reload` row is retired with the outcome, never before: the caller
   * puts it in only once this returns.
   *
   * Success is not the `204`. OpenCode answers once the old location is
   * shut down (`location.shutdown`) and rebuilds it after: until the burst
   * of `*.updated` events that follows, even its built-in skills are
   * missing, and a client that re-read its catalogs on the `204` would lose
   * every skill from the palette. So success waits for the workspace's
   * `command.updated` and `skill.updated` after its shutdown — bounded, so
   * a stream that is down, or a server that announces differently, still
   * gets an answer (the reload did happen; the idle refresh catches up).
   */
  private reload(sessionId: string, messageId: string): { messageId: string; operation: "reload" } {
    const noticeId = `notice:${messageId}:reload`;
    this.inject({ conversationId: sessionId, outcome: "handled", eventType: "location.reload.started", updates: [
      { kind: "upsert", item: { id: noticeId, type: "notice", createdAt: Date.now(), level: "info", message: "Reloading OpenCode configuration…" } },
    ] });
    // One at a time, each armed before its own call: the rebuild can be
    // announced before the reply, and must be this reload's rebuild.
    const outcome = this.reloadChain.then((): Promise<ReloadOutcome> => {
      const settled = this.awaitReloadSettled();
      return this.client.location.reload().then(
        async () => (await settled.promise) ? { kind: "reloaded" } : { kind: "unconfirmed" },
        (error: unknown) => { settled.cancel(); return { kind: "failed", error: error ?? new Error("The reload failed") }; },
      );
    });
    this.reloadChain = outcome;
    void outcome.then(async result => {
      // The row goes in on the caller's continuation; a macrotask later it
      // is certainly there to retire.
      await new Promise(resolve => setTimeout(resolve, 0));
      // Only a confirmed rebuild is success: an unconfirmed one may still be
      // rebuilding, so it is not reported as reloaded, and the failed status
      // keeps the invoking client from banking catalogs mid-rebuild (the
      // palette and picker re-read when next opened).
      const seconds = Math.round(this.reloadSettleMs / 1000);
      const message = result.kind === "reloaded"
        ? "Configuration reloaded"
        : result.kind === "unconfirmed"
          ? `Reload sent, but OpenCode did not confirm its reloaded configuration within ${seconds} s. Run /reload again if commands, skills, models, or modes look out of date.`
          : `Reloading the configuration failed: ${failureText(result.error)}`;
      const level = result.kind === "reloaded" ? "info" : result.kind === "unconfirmed" ? "warning" : "error";
      this.inject({ conversationId: sessionId, outcome: "handled", eventType: `location.reload.${result.kind}`, updates: [
        { kind: "remove", itemId: `message:${messageId}` },
        { kind: "upsert", item: { id: noticeId, type: "notice", createdAt: Date.now(), level, message } },
        result.kind === "reloaded" ? { kind: "status", status: "completed" } : { kind: "status", status: "failed", message },
      ] });
    });
    return { messageId, operation: "reload" };
  }

  /** Resolves true once the rebuild is announced, false when the bound passes first. */
  private awaitReloadSettled(): { promise: Promise<boolean>; cancel: () => void } {
    let waiter: ReloadWaiter | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer);
      if (waiter) this.reloadWaiters.delete(waiter);
    };
    const promise = new Promise<boolean>(resolve => {
      waiter = { armed: false, pending: new Set(RELOAD_CATALOG_EVENTS), resolve: () => { done(); resolve(true); } };
      this.reloadWaiters.add(waiter);
      timer = setTimeout(() => { done(); resolve(false); }, this.reloadSettleMs);
    });
    return { promise, cancel: done };
  }

  /** Feeds waiting reloads the workspace's shutdown and catalog announcements. */
  private observeReload(event: unknown): void {
    if (this.reloadWaiters.size === 0) return;
    const { type, location } = (event ?? {}) as { type?: unknown; location?: { directory?: unknown } };
    if (typeof type !== "string" || typeof location?.directory !== "string" || path.resolve(location.directory) !== this.workspace) return;
    for (const waiter of [...this.reloadWaiters]) {
      if (type === "location.shutdown") { waiter.armed = true; continue; }
      if (!waiter.armed) continue;
      waiter.pending.delete(type);
      if (waiter.pending.size === 0) waiter.resolve();
    }
  }

  private inject(event: NormalizedProviderEvent): void {
    this.injected.push(event);
    if (this.injected.length > OpenCodeV2Provider.INJECTED_LIMIT) this.injected.shift();
    this.wake?.();
  }

  private reportEnqueuedUser(event: NormalizedProviderEvent): NormalizedProviderEvent | undefined {
    if (event.eventType !== "session.inbox.enqueued" || !event.conversationId) return;
    // The enqueue carries no timeline row any more (opencode-v2-steering
    // D4): the server-minted id is read from the pending inbox delta, and
    // the row itself lands when the inbox delivers the entry.
    const pending = event.updates.find(update => update.kind === "inbox" && update.delta.kind === "pending");
    if (!pending || pending.kind !== "inbox") return;
    const serverId = pending.delta.id;
    // A prompt's row carries the id this process gave it; no command
    // admission, however old, is waiting for that one.
    if (this.promptIds.has(serverId)) return;
    // Admission order is wire order: a row belongs to the oldest admission
    // still waiting for one. An admission whose window closed is older than
    // any waiter registered since, so it takes this row and the waiter takes
    // the next.
    const late = this.takeLateAdmission(event.conversationId);
    if (late) {
      if (late.localId !== serverId) {
        // The server's row is on the timeline now; the placeholder under
        // the local id is the same message twice. Retired rather than
        // re-keyed — an update cannot rename an item — so the row reads as
        // the server stored it.
        return { conversationId: event.conversationId, updates: [{ kind: "remove", itemId: `message:${late.localId}` }], outcome: "handled", eventType: event.eventType };
      }
    }
    const waiter = this.enqueuedUserWaiters.get(event.conversationId);
    if (waiter && waiter.generation === this.streamGeneration) waiter.resolve(serverId);
    return undefined;
  }

  // The oldest admission still waiting for its row; expired ones are dropped.
  private takeLateAdmission(sessionId: string): { localId: string; until: number } | undefined {
    const queue = this.lateAdmissions.get(sessionId);
    if (!queue) return undefined;
    const now = Date.now();
    while (queue.length > 0 && queue[0]!.until < now) queue.shift();
    const oldest = queue.shift();
    if (queue.length === 0) this.lateAdmissions.delete(sessionId);
    return oldest;
  }

  private forgetLateAdmission(sessionId: string, localId: string): void {
    const queue = this.lateAdmissions.get(sessionId);
    if (!queue) return;
    const remaining = queue.filter(entry => entry.localId !== localId);
    if (remaining.length === 0) this.lateAdmissions.delete(sessionId);
    else this.lateAdmissions.set(sessionId, remaining);
  }

  private awaitEnqueuedUser(sessionId: string): { promise: Promise<string>; release: () => void; generation: number; liveAtDispatch: boolean } {
    let resolve!: (messageId: string) => void;
    const promise = new Promise<string>(settle => { resolve = settle; });
    const waiter = { resolve, generation: this.streamGeneration };
    this.enqueuedUserWaiters.set(sessionId, waiter);
    return { promise, generation: waiter.generation, liveAtDispatch: this.streaming, release: () => { if (this.enqueuedUserWaiters.get(sessionId) === waiter) this.enqueuedUserWaiters.delete(sessionId); } };
  }

  async dispose(): Promise<void> {
    this.readLifetime.abort();
    for (const ready of this.streamReadyWaiters) ready(false);
    this.historyReuse.dispose();
    this.childParents.dispose();
    await Promise.allSettled(this.backgroundReads.values());
    this.controls.clear();
  }

  promptIdentity(identity: string): string { return stableProviderId("msg", identity); }

  async prompt(sessionId: string, input: { id: string; text: string; delivery: MessageDelivery; attachments?: ProviderAttachment[]; model?: ModelSelection; mode?: string; variant?: string }): Promise<{ messageId: string }> {
    this.historyReuse.invalidate(sessionId);
    // Session-level, not prompt fields: the prompt input carries neither a
    // model nor an agent. Applied only for a queue delivery — a steer runs
    // under the session's configuration at delivery, because a mid-turn
    // switch would retarget the very turn being steered (D6).
    if (input.delivery === "queue") {
      if (input.model) await this.switchModel(sessionId, input.model, input.variant);
      if (input.mode) await this.client.session.switchAgent({ sessionID: sessionId, agent: input.mode });
    }
    const files = (input.attachments ?? []).map(attachment => ({
      // `file:` over `data:` because the processes share a disk: no base64
      // inflation, and the stored record echoes the uri as the attachment's
      // source, which is what replay linkage keys on.
      uri: pathToFileURL(attachment.absolutePath).href,
      name: attachment.name,
    }));
    const messageId = stableProviderId("msg", input.id);
    // Known before the request goes out: the server can announce the row
    // before it answers, and the row must already read as a prompt's.
    this.rememberPromptId(messageId);
    const dispatch = () => this.client.session.prompt({
      sessionID: sessionId,
      id: messageId,
      text: input.text,
      ...(files.length ? { files } : {}),
      delivery: input.delivery,
      resume: true,
    });
    const admitted = input.delivery === "steer" ? await this.backgroundMutation(dispatch) : await dispatch();
    if (admitted.id !== messageId) this.rememberPromptId(admitted.id);
    return { messageId: admitted.id };
  }

  private rememberPromptId(id: string): void {
    this.promptIds.add(id);
    if (this.promptIds.size > OpenCodeV2Provider.PROMPT_ID_LIMIT) {
      const oldest = this.promptIds.values().next().value;
      if (oldest !== undefined) this.promptIds.delete(oldest);
    }
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
  async command(sessionId: string, input: { id: string; name: string; arguments: string; listed?: ChatCommand; model?: ModelSelection; mode?: string; variant?: string }): Promise<{ messageId: string; text?: string; operation?: "reload" }> {
    const messageId = stableProviderId("msg", input.id);
    // Decided from the live catalogs, not the palette the user chose from,
    // and before any built-in: a config command or skill named `compact`
    // runs as what the palette listed. A skill dropped since then falls
    // through to `session.command`, whose refusal reaches the conversation
    // like any invalid command's.
    const target = await this.commandTarget(input.name, input.listed);
    const compacts = target.kind === "compact";
    this.historyReuse.invalidate(sessionId);
    // Staged selections are applied first, whatever the command: the adapter
    // commits them as the conversation's configuration once this returns,
    // so a `/reload` must not skip them either.
    if (input.model) await this.switchModel(sessionId, input.model, input.variant);
    if (input.mode) await this.client.session.switchAgent({ sessionID: sessionId, agent: input.mode });
    // A reload touches the server's configuration, not this conversation.
    if (target.kind === "reload") return this.reload(sessionId, messageId);
    if (target.kind === "skill") return this.promptSkill(sessionId, messageId, target.skill, input.arguments);
    // A compaction's id is this process's own; its inbox item is a
    // `compaction`, which the stream never presents as a user row, but the
    // id is registered as minted all the same.
    if (compacts) this.rememberPromptId(messageId);
    const dispatch: Promise<unknown> = compacts
      ? this.client.session.compact({ sessionID: sessionId, id: messageId, delivery: "queue" })
      : this.client.session.command({ sessionID: sessionId, name: input.name, text: input.arguments, delivery: "queue" });
    const enqueued = !compacts && this.streamOpen ? this.awaitEnqueuedUser(sessionId) : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reported = await new Promise<string | undefined>((resolve, reject) => {
        timer = setTimeout(() => resolve(undefined), this.commandAdmissionMs);
        enqueued?.promise.then(resolve);
        // A 204 says the command was accepted, not what its row is called:
        // with a stream listening, the id can still arrive inside the window.
        // A rejection is an answer when the server gave it (a tagged error)
        // or when nothing reached the server (a refused connection). A lost
        // response is neither — the command may be running — so with a
        // stream listening the row or the window decides, and without one
        // the caller hears the failure, having nothing else to wait for.
        dispatch.then(() => { if (!enqueued) resolve(undefined); }, (error: unknown) => {
          if (!enqueued || isServerRefusal(error) || isMutationNotApplied(error)) reject(error);
        });
      });
      // The window closed without a decision: the caller was told
      // "admitted" on the strength of the timer alone.
      if (reported === undefined) {
        // With a stream listening, remember the local id so the late row
        // can retire it — but only while that same stream is still running:
        // a stream that ended during the window cannot deliver the row, and
        // a record left for a later stream would claim a row that is not
        // its own. And only if the stream was live before the dispatch: a
        // row broadcast before the subscription's first frame may never
        // have reached it, and a record for a lost row would claim the next
        // command's. A duplicate row is the lesser harm there.
        if (enqueued && enqueued.liveAtDispatch && this.streaming && enqueued.generation === this.streamGeneration) {
          const queue = this.lateAdmissions.get(sessionId) ?? [];
          queue.push({ localId: messageId, until: Date.now() + OpenCodeV2Provider.LATE_ADMISSION_MS });
          this.lateAdmissions.set(sessionId, queue);
        }
        // A refusal that lands after the window means no row is coming. The
        // caller, already told the command was admitted, learns of it the
        // way it learns everything else: as an event — on this stream or,
        // since the queue outlives a disconnect, the next one, which is
        // also how it reaches a command dispatched with no stream at all. The placeholder
        // goes, the refusal shows, and the turn that never started ends as
        // failed. Only the server's own refusal, though: a lost response is
        // not a refusal — the command may be running — so the admission
        // stays and its row, if it comes, retires the placeholder as usual.
        dispatch.catch((error: unknown) => {
          // The server's refusal, or the socket's: either way no row is
          // coming. A lost response is neither.
          if (!isServerRefusal(error) && !isMutationNotApplied(error)) return;
          this.forgetLateAdmission(sessionId, messageId);
          const message = error instanceof Error && error.message ? error.message : "The command was refused";
          this.inject({ conversationId: sessionId, outcome: "handled", eventType: "session.command.refused", updates: [
            { kind: "remove", itemId: `message:${messageId}` },
            { kind: "upsert", item: { id: `notice:${messageId}:refused`, type: "notice", createdAt: Date.now(), level: "error", message } },
            { kind: "status", status: "failed", message },
          ] });
        });
      }
      return { messageId: reported ?? messageId };
    } finally {
      clearTimeout(timer);
      enqueued?.release();
      dispatch.catch(() => undefined);
    }
  }

  async interrupt(sessionId: string, options?: { resume?: boolean }): Promise<{ interrupted: boolean }> {
    // `resume: true` wakes steer-scope input only; omitted or false wakes
    // nothing. Pending input is never deleted by an interrupt (2.0.28).
    const dispatch = () => this.client.session.interrupt({ sessionID: sessionId, ...(options?.resume === undefined ? {} : { resume: options.resume }) });
    if (options?.resume === true) return await this.backgroundMutation(dispatch);
    try { return await dispatch(); }
    catch (error) {
      // Only explicit request/auth/session refusals or a socket that never
      // connected prove non-application. A generic error, 5xx, or other native
      // failure may follow side effects and must preserve Stop's queue intent.
      if (isMutationNotApplied(error)) {
        throw new InterruptNotAppliedError(failureText(error));
      }
      throw error;
    }
  }

  async backgroundBlockingWork(sessionId: string): Promise<void> {
    if (!await this.getSession(sessionId)) throw new BackgroundTaskUnavailableError("Background parent is unavailable");
    await this.backgroundMutation(() => this.client.session.background({ sessionID: sessionId }));
  }

  async generate(sessionId: string, prompt: string): Promise<string> {
    const result = await this.client.session.generate({ sessionID: sessionId, prompt });
    return result.text;
  }

  async stopTask(sessionId: string, taskId: string): Promise<void> {
    if (sessionId.length > 512 || taskId.length > 512) throw new BackgroundTaskUnavailableError("Invalid worker identity");
    if (this.controls.unavailable(taskId)) throw new BackgroundTaskUnavailableError("Worker is no longer confirmed: control evidence is unavailable");
    if (this.stopValidations.size >= 4) throw new BackgroundTaskUnavailableError("Stop validation capacity unavailable");
    const validation: StopValidation = { parent: sessionId, taskId, changed: false, pendingChanges: new Set(), pendingLaunches: new Map(),
      pendingChangeBytes: 0, pendingLaunchBytes: 0, pendingBytes: 0, occurrence: this.controls.basis(taskId) ?? this.eventMemory?.workers.occurrence(taskId) };
    if (validation.occurrence) {
      validation.child = validation.occurrence.worker;
      validation.launchCalls = validation.occurrence.launches.map(launch => launch.call);
    }
    this.refreshStopBytes(validation);
    this.stopValidations.add(validation);
    const stream = this.streamGeneration;
    const signal = this.readSignal(AbortSignal.timeout(5_000));
    let controlBasis = this.controls.proof(taskId);
    const assertAuthorizationCurrent = () => {
      const current = this.controls.proof(taskId);
      if (this.controls.unavailable(taskId) || controlBasis && (!current || current.basis !== controlBasis.basis || current.revision !== controlBasis.revision)
        || task && controlBasis && (task.taskType !== controlBasis.basis.kind
          || (controlBasis.basis.kind === "agent" ? task.childConversationId !== controlBasis.basis.worker
            : task.childConversationId !== undefined || task.outputFile !== `shell:${controlBasis.basis.worker}`))
        || validation.changed || validation.occurrence?.uncertain || this.stopLaunchChanged(validation) || signal.aborted || stream !== this.streamGeneration) {
        throw new BackgroundTaskUnavailableError("Worker is no longer confirmed: ownership or execution changed while validating Stop");
      }
    };
    // An inventory recovery begun before this request cannot authorize a
    // destructive mutation. Wait for it, then revalidate against fresh parent
    // evidence; concurrent stop requests may share that newer read.
    let task: import("../../types").BackgroundTaskItem | undefined;
    try {
      await this.coveredRead(signal, async () => { await this.backgroundReads.get(sessionId)?.catch(() => undefined); });
      assertAuthorizationCurrent();
      // Child execution boundaries authorize the occurrence too, so none of
      // the parent/child histories used for this mutation may predate it.
      this.historyReuse.invalidate();
      const snapshot = await this.backgroundSnapshot(sessionId, { signal });
      controlBasis ??= snapshot.controls.get(taskId);
      const selected = snapshot.tasks.find(task => task.taskId === taskId);
      task = selected ? { ...selected, ...(selected.toolUseIds ? { toolUseIds: [...selected.toolUseIds] } : {}) } : undefined;
      if (task) this.bindStopTask(validation, task, snapshot.occurrences.get(taskId), true);
      assertAuthorizationCurrent();
      if (!task || task.status !== "running" || task.stateUncertain || !controlBasis) throw new BackgroundTaskUnavailableError("Worker is no longer confirmed running");
      if (task.childConversationId) {
        // A cached immutable relationship helps reads, not destructive
        // authorization. Re-read confinement after all execution evidence.
        const child = await this.lookupChild(task.childConversationId, signal);
        assertAuthorizationCurrent();
        if (child?.parentID !== sessionId) throw new BackgroundTaskUnavailableError("Worker ownership is no longer confirmed");
      }
    } catch (error) {
      assertAuthorizationCurrent();
      throw error;
    } finally {
      this.stopValidations.delete(validation);
      validation.launchCalls = undefined;
      validation.occurrence = undefined;
      this.clearStopEvidence(validation);
    }
    // No await separates this fence from dispatch. Revocation observed at
    // any earlier await refuses the action rather than replaying validation.
    assertAuthorizationCurrent();
    if (task.childConversationId) {
      // Native interrupt has no generation-conditional precondition. This
      // refuses known stale occurrences, not an external continuation racing
      // between the final read and the session-scoped mutation.
      await this.backgroundMutation(() => this.client.session.interrupt({ sessionID: task.childConversationId!, resume: false }));
      return;
    }
    if (task.taskType === "shell" && task.outputFile?.startsWith("shell:")) {
      await this.backgroundMutation(() => this.client.shell.remove({ id: task.outputFile!.slice(6), ...this.scope }));
      return;
    }
    throw new BackgroundTaskUnavailableError("Worker cannot be stopped");
  }

  async taskOutput(sessionId: string, taskId: string, options: { tailBytes: number }): Promise<import("../../types").BackgroundTaskOutput | null> {
    const task = (await this.reconcileBackgroundTasks(sessionId)).find(task => task.taskId === taskId);
    if (!task || task.taskType !== "shell" || !task.outputFile?.startsWith("shell:")) throw new BackgroundTaskUnavailableError("Shell output is unavailable");
    const id = task.outputFile.slice(6);
    try {
      const shell = await this.client.shell.get({ id, ...this.scope });
      if (shell.data.metadata.sessionID !== sessionId) throw new BackgroundTaskUnavailableError("Shell output is unavailable");
      const limit = Math.min(TASK_OUTPUT_TAIL_MAX_BYTES, Math.max(1, Math.floor(options.tailBytes)));
      const latest = await this.client.shell.output({ id, ...this.scope, cursor: Number.MAX_SAFE_INTEGER });
      const cursor = Math.max(0, latest.data.size - limit);
      const page = await this.client.shell.output({ id, ...this.scope, cursor, limit });
      return { text: page.data.output, truncated: cursor > 0 || page.data.truncated, settled: task.status !== "running" };
    } catch (error) {
      if (asRecord(error)._tag === "ShellNotFoundError") return null;
      throw error;
    }
  }

  private async backgroundMutation<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      // Only explicit non-application responses are ordinary retryable errors.
      // An unknown/server/transport failure after dispatch might follow effects.
      if (isMutationNotApplied(error)) throw error;
      throw new OperationOutcomeUnknownError();
    }
  }

  /**
   * The session's pending user steers, in enqueue order. OpenCode's own
   * entries (synthetic, compaction, move) and natively queued input are not
   * the dock's: Uatu's queue is held in the workspace, never in this inbox.
   */
  async listPendingInbox(sessionId: string, options?: { signal?: AbortSignal }): Promise<PendingInboxEntry[]> {
    const signal = options?.signal ? AbortSignal.any([options.signal, this.readLifetime.signal]) : this.readLifetime.signal;
    const entries = await this.client.session.inbox.list({ sessionID: sessionId }, { signal });
    return (entries as Array<Record<string, unknown>>).flatMap(entry => {
      if (entry.type !== "user" || entry.delivery !== "steer") return [];
      const pending = pendingInboxEntry(entry);
      return pending ? [pending] : [];
    });
  }

  async cancelInbox(sessionId: string, inboxId: string): Promise<void> {
    // Missing-entry cancellation is a successful no-op, so only history
    // read after the response can establish non-delivery. Fence reads on
    // both sides: a read started during the request is not fresh evidence
    // either, even if it completes after cancellation (or response loss).
    this.historyReuse.invalidate(sessionId);
    try { await this.client.session.inbox.cancel({ sessionID: sessionId, inboxID: inboxId }); }
    finally { this.historyReuse.invalidate(sessionId); }
  }

  async replyPermission(sessionId: string, requestId: string, reply: ProviderPermissionReply): Promise<void> {
    await this.client.permission.reply({ sessionID: sessionId, requestID: requestId, decision: reply });
  }

  async listPermissions(): Promise<PendingPermission[]> {
    // The workspace-scoped pending list, with the owning session on each row:
    // filtering is the adapter's job, so a parent can find its children's.
    const { data } = await this.client.permission.request.list(this.scope);
    const pending: PendingPermission[] = data.flatMap(request => {
      if (!request.id || !request.sessionID) return [];
      const fields = pendingPermissionFields(request as Record<string, unknown>);
      return [{ requestId: request.id, conversationId: request.sessionID, ...fields, action: fields.action || "permission" }];
    });
    // The recovered card names the server as a live one would.
    const candidates = pending.filter(entry => looksLikeMcpPermission(entry.action, entry.resources));
    const servers = candidates.length ? await this.mcpServerNames().catch(() => []) : [];
    return pending.map(entry => {
      const mcp = candidates.includes(entry) ? mcpToolFromAction(entry.action, servers) : undefined;
      return mcp ? { ...entry, mcp } : entry;
    });
  }

  // The reported MCP servers, by the names the user registered.
  private async mcpServerNames(): Promise<string[]> {
    const { data } = await this.client.mcp.list(this.scope);
    return data.map(server => server.name);
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
    return reversibleContext(messages, info);
  }

  /**
   * A session by id, or null for one that does not exist or belongs to
   * another directory (the workspace never sees a foreign session). Only a
   * not-found answer is a miss; auth and server failures propagate.
   */
  private async lookupSession(sessionId: string, signal = this.readLifetime.signal): Promise<SessionRecord | null> {
    let info: SessionRecord;
    try {
      info = await this.client.session.get({ sessionID: sessionId }, { signal }) as unknown as SessionRecord;
      signal.throwIfAborted();
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

function reversibleContext(messages: StoredMessage[], info: SessionRecord | null): ReversibleHistoryContext {
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
  const boundaryId = stringValue(asRecord(info?.revert).messageID);
  const boundaryIndex = boundaryId ? turns.findIndex(turn => turn.providerId === boundaryId) : undefined;
  const knownBoundary = boundaryIndex !== undefined && boundaryIndex >= 0 ? boundaryIndex : undefined;
  const state = reversibleState(turns, knownBoundary, boundaryId !== undefined);
  return { turns, ...(knownBoundary === undefined ? {} : { boundaryIndex: knownBoundary }), state };
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
const UNVERIFIED_CHILD = Symbol("Unverified child ownership");

const BUILTIN_COMMANDS: ChatCommand[] = [
  { name: "compact", description: "Compact the conversation context", argumentHint: "", kind: "command" },
  { name: "reload", description: "Reload OpenCode's configuration for this workspace", argumentHint: "", kind: "command" },
];

type ReloadWaiter = { armed: boolean; pending: Set<string>; resolve: () => void };
type ReloadOutcome = { kind: "reloaded" } | { kind: "unconfirmed" } | { kind: "failed"; error: unknown };

// The rebuilt location's announcements a reload waits for: every catalog the
// palette and pickers show (commands, skills, models, agents as modes). A
// real 2.x server announces them in one burst after the rebuild.
const RELOAD_CATALOG_EVENTS = ["command.updated", "skill.updated", "model.updated", "agent.updated"];

/** Listed under its id; a display name that says something else leads the description. */
function skillDescription(skill: { id: string; name: string; description?: string }): string {
  const description = skill.description ?? "";
  if (skill.name === skill.id) return description;
  return description ? `${skill.name} — ${description}` : skill.name;
}

// The 2.x server answers a missing session with a tagged error (`_tag`
// naming the not-found case, `message` "Session not found: …"); anything
// else — expired auth, a restarting server, a transport failure — is a
// provider failure.
// The client wraps what happened in a `ClientError` whose `cause` is the
// original failure; the facts sit somewhere down that chain.
function* causes(error: unknown): Generator<Record<string, unknown>> {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const record = asRecord(current);
    yield record;
    current = record.cause;
  }
}

// The server's answer, as the client throws it: a tagged error
// (`CommandNotFoundError`, `SessionNotFoundError`, …) is a decision the
// server made. An untagged failure never reached one — the socket, a
// timeout, an aborted fetch — and decides nothing.
// The client rejects with the server's decoded tagged error — a plain
// object carrying `message` — or with an Error for a transport failure.
function failureText(error: unknown): string {
  const message = typeof error === "object" && error !== null ? (error as { message?: unknown }).message : undefined;
  return typeof message === "string" && message ? message : String(error);
}

function isServerRefusal(error: unknown): boolean {
  for (const record of causes(error)) if (stringValue(record._tag) !== undefined) return true;
  return false;
}

// The socket's own refusal: nothing was sent, so nothing was accepted.
function isConnectionRefused(error: unknown): boolean {
  for (const record of causes(error)) if (record.code === "ConnectionRefused" || record.code === "ECONNREFUSED") return true;
  return false;
}

function isMutationNotApplied(error: unknown): boolean {
  return isConnectionRefused(error) || [...causes(error)].some(record =>
    ["InvalidRequestError", "UnauthorizedError", "ForbiddenError", "SessionNotFoundError"].includes(String(record._tag))
    // The pinned client does not declare 403 on these routes, so it keeps
    // the status in ClientError.cause rather than decoding the server tag.
    || record.name === "ClientError" && record.reason === "UnexpectedStatus" && asRecord(record.cause).status === 403);
}

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
