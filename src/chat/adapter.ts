import { createHash, randomBytes, randomUUID } from "node:crypto";
import { compactWorkerEvidence, validatedWorkerDismissalSource, workerDismissalSourceStrength, workerSourceIsProtected, WORKER_EVIDENCE_LIMIT, WorkerEvidenceError, type WorkerEvidenceSnapshot } from "./worker-dismissal-evidence";
import { AgentNotificationTracker, type AgentNotificationEvent } from "./notifications";

import { boundedSet } from "../shared/bounded-map";
import { ProviderUpdateCoalescer } from "./coalescer";
import { ConversationInventoryBroadcaster, type ConversationInventorySubscription } from "./inventory-broadcaster";
import type { InboxDelta, NormalizedProviderEvent, NormalizedProviderUpdate, NormalizedSessionLifecycle, StoredMessageAccounting, ProviderHistoryPage, WorkerSourceGuard, WorkerResultFallback, WorkerRecoverySource, WorkerAssociationWatch } from "./provider";
import { describeToolDetail } from "./tool-detail";
import { mergeAssistantMessage, sameUsage, TOKEN_USAGE_COMPONENTS } from "./usage";
import { CLAUDE_TURN, type ClaudeTextIdentity, type ClaudeTurn } from "./claude/normalization-types";
import { InterruptNotAppliedError, OperationOutcomeUnknownError, ReversibleHistoryTargetError, UnsupportedVariantSelectionError, type ChatProvider, type ProviderAttachment, type ProviderPermissionReply, type ProviderSession } from "./provider";
import { IdempotencyReceipts } from "./receipts";
import { ConversationReplay, type ReplaySubscription } from "./replay";
import { ProviderTextReconciler } from "./text-reconciler";
import { activeInteractionRequests, PermissionQueueOrder } from "./interaction-order";
import { parsePromptSlashCommand, sideQuestionOperation } from "./slash-commands";
import { isLiveConversationStatus } from "./types";
import { OPENCODE_ALIAS_LIVE, OPENCODE_COMPLETION_ALIAS, OPENCODE_EXECUTION_LIVE, OPENCODE_STEP_LIVE, OPENCODE_TEXT_START_FALLBACK, type OpenCodeCompletionAlias, type OpenCodeExecutionIdentity, type OpenCodeStepStatus, type OpenCodeTextStart } from "./opencode/normalization-types";
import type { ChatActionContext, AutomaticBackgroundOutcome, AutomaticBackgroundFeedback } from "./types";
import { hasVerifiedBlockingWork } from "./blocking-work";
import { workerSessionReport, type WorkerMessageModel } from "./worker-session";
import { unverifyWorkerTask, workerState } from "./worker-state";
import type {
  BackgroundTaskOutput,
  BackgroundTaskItem,
  ChatActivity,
  ChatAgent,
  ChatMode,
  ChatEvent,
  ChatCommand,
  ChatModel,
  ConversationConfiguration,
  ConversationItem,
  ConversationSnapshot,
  ConversationStatus,
  ConversationSummary,
  MessageAttachment,
  MessageDelivery,
  PermissionOutcome,
  PermissionRequest,
  ModelSelection,
  QueueChangeKind,
  QueuedMessage,
  QuestionOutcome,
  QuestionRequest,
  RestoredDraft,
  ReversibleHistoryResult,
  ReversibleHistoryState,
  SubagentLine,
  TokenUsage,
  ToolItem, AgentUsageReport, UsageReadMode, UsageReadResult, ChatAccountChange, ChatLoginState } from "./types";
import { ConversationNotFoundError, isSessionInWorkspace } from "./workspace";

const DEFAULT_PAGE_SIZE = 50;
class PrimarySteerOutcomeUnknownError extends OperationOutcomeUnknownError {
  constructor(readonly messageId?: string) { super(); }
}
// Sized so reconstructAttribution reads a whole subagent transcript in one
// call in practice; its cursor loop is the backstop, not the plan.
const RECONSTRUCTION_READ_LIMIT = 10_000;
const INVENTORY_SESSION_LIMIT = 2_048;
// Successful but unresolved evidence is not a failed read. Give each external
// recovery cycle an initial read and two delayed probes, then await new evidence.
const BACKGROUND_INCONCLUSIVE_READ_LIMIT = 3;
// Unrelated native chatter may rearm an exhausted cycle only after this floor.
// Exhaustion itself never schedules a timer. These are disposable scheduling
// records, not worker Stop/control evidence; all states share the inventory cap.
const BACKGROUND_EXHAUSTED_COOLDOWN_MS = 30_000;
// Cycle-owned invocation fingerprints survive split source removals. Both
// bounds are logical serialized payload; overflow retains a conservative gap.
const BACKGROUND_SOURCE_KEYS = 64;
const BACKGROUND_SOURCE_BYTES = 16 * 1024;
// A fixed throttle, not trailing debounce: new arrivals cannot postpone this
// deadline. Dirty reads share the same finite inconclusive-cycle budget.
const BACKGROUND_DIRTY_RETRY_MS = 100;

// Cycle-local high-water marks, never provider metadata. In particular,
// read-side uncertainty toggles cannot turn the same evidence into progress.
type WorkerRecoveryProgress = { startedAt: number; reportedAt: number; terminal: boolean };
type BackgroundRecovery = {
  dirty: boolean;
  running: boolean;
  failures: number;
  inconclusiveReads: number;
  progress: Map<string, WorkerRecoveryProgress>;
  exhaustedAt?: number;
  sourceProgress?: Map<string, WorkerRecoveryProgress>;
  sourceProgressBytes?: number;
  sourceProgressLost?: true;
  sourceStartedAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  checkingStarted?: true;
  checking?: { finish: () => void };
  readLifetime?: AbortController;
};

function workerRecoveryProgress(item: BackgroundTaskItem): WorkerRecoveryProgress {
  return { startedAt: item.createdAt, reportedAt: item.status === "running" ? -Infinity : item.terminalReportedAt ?? -Infinity, terminal: item.status !== "running" };
}

function mergeWorkerRecoveryProgress(previous: WorkerRecoveryProgress | undefined, incoming: WorkerRecoveryProgress): WorkerRecoveryProgress {
  if (!previous) return incoming;
  const startedAt = Math.max(previous.startedAt, incoming.startedAt);
  const reportedAt = Math.max(previous.reportedAt, incoming.reportedAt);
  const terminal = previous.startedAt === startedAt && previous.terminal || incoming.startedAt === startedAt && incoming.terminal;
  if (startedAt === previous.startedAt && reportedAt === previous.reportedAt && terminal === previous.terminal) return previous;
  return { startedAt, reportedAt, terminal };
}

function workerRecoveryAliases(item: BackgroundTaskItem): string[] {
  return [...(item.toolUseIds ?? []), ...(item.toolUseId ? [item.toolUseId] : [])].map(id => `call:${id}`)
    .concat(item.resultId ? [`result:${item.resultId}`] : []);
}

// Recovery can learn a canonical worker identity after a live placeholder.
// Share only alias matching; snapshot and stream callers own their distinct
// missing-worker uncertainty and publication policies.
function indexRecoveredBackgroundTasks(tasks: readonly BackgroundTaskItem[]) {
  const byId = new Map(tasks.map(item => [item.id, item]));
  const results = new Map(tasks.flatMap(item => item.resultId ? [[item.resultId, item.id] as const] : []));
  const launches = new Map(tasks.flatMap(item => [...(item.toolUseIds ?? []), ...(item.toolUseId ? [item.toolUseId] : [])].map(call => [call, item.id] as const)));
  return {
    byId,
    supersedes: (known: BackgroundTaskItem): boolean => Boolean(
      known.resultId && results.has(known.resultId) && results.get(known.resultId) !== known.id
      || known.toolUseId && launches.has(known.toolUseId) && launches.get(known.toolUseId) !== known.id),
  };
}

/** Covered native evidence may withdraw an inference, never an explicit report. */
function replacesHistoryOnlyOutcome(current: ConversationItem | undefined, source: ConversationItem | undefined): boolean {
  const executionIds = (item: ConversationItem | undefined) => item?.type === "background_task"
    ? [...(item.activity?.executionAliases ?? []), ...(item.activity?.executionId ? [item.activity.executionId] : [])] : [];
  const knownExecutions = new Set(executionIds(current));
  // Working evidence is independent of Stop proof: control projection may
  // mark the row uncertain without withdrawing its covered native activity.
  return current?.type === "background_task" && current.status !== "running" && !current.resultId
    && current.summary === undefined && current.terminalReportedAt === undefined
    && source?.type === "background_task" && source.status === "running"
    && source.id === current.id && source.taskId === current.taskId && source.taskType === current.taskType
    && source.childConversationId !== undefined && source.childConversationId === current.childConversationId
    && (source.activity?.kind === "unavailable" && source.stateUncertain === true
      || source.activity?.kind === "working" || source.activity?.kind === "needs-answer")
    && executionIds(source).some(id => knownExecutions.has(id));
}

type MessageModel = WorkerMessageModel;
type InventorySessionMetadata = {
  inWorkspace: boolean;
  parentId: string | null;
  title: string;
  deleted: boolean;
};
type CachedAssociationCounterproof = { parentId: string; childIds: readonly string[]; transcriptKeys: ReadonlySet<string> };
type HistoryCoverage = { signal: AbortSignal; projection: ConversationProjection; workerSources: WorkerSourceRead; cachedAssociations: readonly CachedAssociationCounterproof[]; refreshAttribution: boolean; assertCurrent: () => void; dirty: () => boolean; revertExclusions: Set<string>; merge: (items: ConversationItem[]) => ConversationItem[]; changed: (id: string) => boolean; conversation: () => ConversationSummary | undefined; inboxReconciled: boolean; markInboxReconciled: () => void; steerCorrelations: ReadonlyMap<string, string>; questionTick: number; replacement?: true };
class HistoryReadChangedError extends Error {}

/** Evidence flows from shared accounting owners to each enclosing read before
 * transport retirement. Followers own independent leases, including transitive
 * sources already collected before they joined. Nothing survives their signal. */
class WorkerSourceRead {
  private readonly guards: Array<{ guard: WorkerSourceGuard; accountingKey?: string }> = [];
  private readonly followers = new Set<WorkerSourceRead>();
  private readonly inventories = new Map<string, AccountingInventory>();
  readonly nestedPublications = new Map<string, NestedAllocationPublication>();
  constructor(private readonly signal: AbortSignal) {}
  observe(source: WorkerSourceGuard, accountingKey?: string): WorkerSourceGuard | undefined {
    if (this.signal.aborted) return;
    const guard = source.retain(this.signal);
    this.guards.push({ guard, accountingKey });
    for (const follower of this.followers) follower.observe(guard, accountingKey);
    return guard;
  }
  follow(read: WorkerSourceRead): () => void {
    for (const { guard, accountingKey } of this.guards) read.observe(guard, accountingKey);
    for (const [key, inventory] of this.inventories) read.inventory(key, inventory);
    this.followers.add(read);
    return () => { this.followers.delete(read); };
  }
  assertCurrent(): void {
    if (!this.isCurrent()) throw new HistoryReadChangedError();
  }
  isCurrent(): boolean { return !this.signal.aborted && this.guards.every(({ guard }) => guard.isCurrent()); }
  hasSources(): boolean { return this.guards.length > 0; }
  hasAccountingPage(key: string): boolean {
    return this.guards.some(({ accountingKey }) => accountingKey === key);
  }
  inventory(key: string, incoming?: AccountingInventory): AccountingInventory | undefined {
    if (incoming && !this.signal.aborted && (this.inventories.has(key) || this.inventories.size < MAX_CHILD_ATTRIBUTIONS)) {
      this.inventories.set(key, incoming);
      for (const follower of this.followers) follower.inventory(key, incoming);
    }
    return this.inventories.get(key);
  }
}

/** One enclosing read's growing presentation graph. New edges enter watches
 * before cache/projection publication, including while an attempt is awaiting
 * its final boundary. Only counterproof changes revisions or requests a retry. */
class CachedAssociationRead {
  private readonly groups = new Map<string, { watch: WorkerAssociationWatch; children: Set<string>; transcriptKeys: Set<string> }>();
  private readonly attempts = new Set<{ sources: WorkerSourceRead; evidence: CachedAssociationCounterproof[] }>();
  constructor(readonly id: string, private readonly signal: AbortSignal,
    private readonly create: NonNullable<ChatProvider["watchWorkerAssociations"]>) {}

  include(parentId: string, childId: string, ownerKey?: string): void {
    if (this.signal.aborted) return;
    let group = this.groups.get(parentId);
    if (!group) {
      group = { watch: this.create(parentId, [], { signal: this.signal }), children: new Set(), transcriptKeys: new Set() };
      this.groups.set(parentId, group);
      // Attach the empty revision first: cached counterproof found by include()
      // must also invalidate an attempt that has already reached its boundary.
      for (const attempt of this.attempts) this.attach(attempt, parentId, group);
    }
    if (ownerKey) group.transcriptKeys.add(ownerKey);
    if (group.children.has(childId)) return;
    group.children.add(childId);
    group.watch.include([childId]);
  }

  begin(sources: WorkerSourceRead) {
    const attempt = { sources, evidence: [] as CachedAssociationCounterproof[] };
    for (const [parentId, group] of this.groups) this.attach(attempt, parentId, group);
    this.attempts.add(attempt);
    return { evidence: attempt.evidence, release: () => { this.attempts.delete(attempt); } };
  }

  private attach(attempt: { sources: WorkerSourceRead; evidence: CachedAssociationCounterproof[] }, parentId: string,
    group: { watch: WorkerAssociationWatch; transcriptKeys: ReadonlySet<string> }): void {
    const snapshot = group.watch.snapshot();
    attempt.sources.observe(snapshot.workerSource);
    attempt.evidence.push({ parentId, transcriptKeys: group.transcriptKeys, childIds: snapshot.contradictedChildren });
  }
}

export class InteractionConflictError extends Error {
  constructor(message = "interaction request is stale or already resolved") {
    super(message);
    this.name = "InteractionConflictError";
  }
}

export class InvalidPermissionChoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPermissionChoiceError";
  }
}

export class UsageUnsupportedError extends Error {
  constructor() {
    super("this agent does not report plan usage");
    this.name = "UsageUnsupportedError";
  }
}

export class SideGenerationUnsupportedError extends Error {
  constructor(message = "Side answers are not supported by this agent") { super(message); this.name = "SideGenerationUnsupportedError"; }
}

export class BackgroundTasksUnsupportedError extends Error {
  constructor() {
    super("this agent does not run background tasks");
    this.name = "BackgroundTasksUnsupportedError";
  }
}

export class ScheduledWakeupsUnsupportedError extends Error {
  constructor() {
    super("this agent does not schedule wakeups");
    this.name = "ScheduledWakeupsUnsupportedError";
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
  constructor(message = "selected variant is not available") {
    super(message);
    this.name = "InvalidVariantSelectionError";
  }
}

export class InvalidConversationTitleError extends Error {
  constructor(message = "conversation title must be non-empty and at most 200 bytes") {
    super(message);
    this.name = "InvalidConversationTitleError";
  }
}

export class ConversationRenameUnsupportedError extends Error {
  constructor() {
    super("conversation rename is not supported");
    this.name = "ConversationRenameUnsupportedError";
  }
}

export class ReversibleHistoryUnsupportedError extends Error {
  constructor() {
    super("reversible conversation history is not supported");
    this.name = "ReversibleHistoryUnsupportedError";
  }
}

export class QueuedMessageNotHeldError extends Error {
  constructor() {
    super("message is no longer held");
    this.name = "QueuedMessageNotHeldError";
  }
}

export class ChatQueueFullError extends Error {
  constructor() {
    super("the message queue is full");
    this.name = "ChatQueueFullError";
  }
}

// opencode-v2-steering D7: the agent delivered the steer into its turn
// before the withdrawal reached it. The message stays delivered — never
// held, returned, or sent again — and the user is told it was too late.
export class SteerAlreadyDeliveredError extends Error {
  constructor() {
    super("the message was already delivered");
    this.name = "SteerAlreadyDeliveredError";
  }
}

// The agent neither confirmed nor denied a withdrawal within the bounded
// wait, and the available list/history cannot establish its outcome. The
// mutation refuses to return or requeue the input rather than guessing (D7).
export class SteerWithdrawalUnconfirmedError extends Error {
  constructor() {
    super("the agent has not confirmed the withdrawal; delivery is unconfirmed, so the message was not returned or queued again");
    this.name = "SteerWithdrawalUnconfirmedError";
  }
}

export class SteeringUnsupportedError extends Error {
  constructor() {
    super("this agent does not support steering");
    this.name = "SteeringUnsupportedError";
  }
}

export class SendNowUnsupportedError extends Error {
  constructor() {
    super("this agent does not support sending a held message now");
    this.name = "SendNowUnsupportedError";
  }
}

// Send now is refused while a turn runs on an agent without steering, and a
// steer cannot be woken while the turn it would join is still running.
export class SendNowUnavailableError extends Error {
  constructor() {
    super("a turn is running; the message is delivered when it ends");
    this.name = "SendNowUnavailableError";
  }
}

// Skills, slash commands, and /reload are always the workspace queue's:
// the agent's inbox cannot run them under Uatu's own built-ins.
export class CommandSteeringError extends Error {
  constructor() {
    super("a command cannot be steered; it stays queued");
    this.name = "CommandSteeringError";
  }
}

export class UnknownAttachmentError extends Error {
  constructor() {
    super("prompt references an attachment the workspace has not stored");
    this.name = "UnknownAttachmentError";
  }
}

// Attachments cannot ride a slash command: the provider's command dispatch
// has no attachment surface, and silently dropping images the user attached
// would be worse than refusing. Checked at admission against the live
// command list; dispatch pins attachment-bearing prompts to the prose route,
// so a held message can never fail on this at delivery time.
export class CommandAttachmentsError extends Error {
  constructor() {
    super("attachments cannot be sent with a slash command");
    this.name = "CommandAttachmentsError";
  }
}

// The queue is a short runway, not storage. Each prompt can carry 64 KiB and
// every queue change republishes the whole queue to every subscriber, so an
// unbounded queue lets one client grow both retained memory and per-event
// SSE payloads without limit.
const MAX_HELD_MESSAGES = 20;
const MAX_HELD_TEXT_BYTES = 256 * 1024;

// A held submission carries everything its eventual dispatch needs, resolved
// at submission time: the configuration the user saw when they sent it, not
// whatever the conversation drifts to while it waits.
type HeldMessage = QueuedMessage & {
  delivery: "queue";
  submissionId: string;
  submissionOrder: number;
  requestId: string;
  model?: ModelSelection;
  mode?: string;
  variant?: string;
  unconfirmedSteerId?: string;
};
type HeldQueue = HeldMessage[] & { deliveryEpoch?: object; awaitingFreshIdle?: true };

function heldDispatchInput(held: HeldMessage) {
  return {
    messageId: held.id,
    text: held.text,
    requestId: held.requestId,
    ...(held.attachments?.length ? { attachments: held.attachments } : {}),
    ...(held.model ? { model: held.model } : {}),
    ...(held.mode ? { mode: held.mode } : {}),
    ...(held.variant ? { variant: held.variant } : {}),
  };
}

function steerKey(conversationId: string, messageId: string): string {
  return JSON.stringify([conversationId, messageId]);
}

// A steer the agent holds in its own inbox (opencode-v2-steering D1). The
// workspace keeps only what the dock needs; the agent owns delivery.
// `queuedAt` is the inbox enqueue time, which the paused rule compares with
// the conversation's last settle (D3).
type PendingSteer = {
  // Native list/events establish inbox order. An HTTP-only admission is
  // provisional in that order, independently of its original held position.
  nativeOrderKnown?: true;
  unconfirmed?: true;
  admissionUncertaintyId?: string;
  resumeUnconfirmed?: true;
  withdrawalUnconfirmed?: true;
  id: string;
  submissionId: string;
  submissionOrder: number;
  text: string;
  queuedAt: number;
  requestId?: string;
  attachments?: MessageAttachment[];
  // When this adapter learned of the entry, as a running count: a
  // reconciliation keeps entries learned after its list read began, which a
  // list that old cannot vouch for either way.
  tick: number;
};

type SteerAdmission = { conversationId: string; id: string; submissionId: string; submissionOrder: number; requestId: string; held?: HeldMessage; terminal?: "delivered" | "cancelled"; retired?: true };

// Total withdrawal budget for cancellation, terminal events and bounded
// list/history recovery (D7).
const DEFAULT_STEER_WITHDRAW_TIMEOUT_MS = 5_000;
// Whole transcript/inbox/stream handoff, below the browser's ordinary 30s GET
// budget. Independent of the shorter mutation and worker-recovery deadlines.
const DEFAULT_HISTORY_READ_TIMEOUT_MS = 25_000;
// Steers known to have been delivered, so a late withdrawal of one is told
// "already delivered" rather than merely "not held".
const DELIVERED_STEERS_LIMIT = 64;
// Requests may outlive their admission deadline indefinitely. Retired fences
// ignore late acknowledgements rather than growing the registry without bound.
const STEER_ADMISSIONS_LIMIT = 64;

type RevertLifecycle = "staged" | "committed" | "cleared";
type RevertReconciliation = {
  revision: number;
  lifecycle: RevertLifecycle;
  failures: number;
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

// Retry forever, but cap the rate. Provider restarts routinely exceed a short
// fixed retry window, and no second lifecycle event is guaranteed afterwards.
const REVERT_RECONCILIATION_INITIAL_RETRY_MS = 50;
const REVERT_RECONCILIATION_MAX_RETRY_MS = 500;

// Just the slice of MetricsRegistry the adapter needs, so chat does not depend
// on the debug module's shape.
export type ChatEventMetrics = { inc(name: string, delta?: number): void };

// Event type strings come from a local trusted process, but the counter key
// space must still be bounded — a future OpenCode emitting per-request type
// names must not grow the registry without limit.
const MAX_COUNTED_EVENT_TYPES = 64;

export type ChatAdapterOptions = {
  provider: ChatProvider;
  workspacePath: string;
  // Resolves a workspace-issued attachment id to its stored bytes' location
  // and sniffed type. Absent (a harness without a store) means every
  // attachment-bearing prompt is refused as unknown.
  resolveAttachment?: (id: string) => Promise<{ id: string; mimeType: string; absolutePath: string } | null>;
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
  // Total deadline for cancellation, settlement and read-side recovery.
  steerWithdrawTimeoutMs?: number;
  historyReadTimeoutMs?: number;
  /** Optional native accounting enrichment; independent of required history. */
  accountingReadTimeoutMs?: number;
  automaticBackgroundTimeoutMs?: number;
  steerAdmissionTimeoutMs?: number;
  // Called when activity() may read differently than it last did (already
  // deduplicated here). The service forwards it to whoever watches the
  // workspace's activity summary.
  onActivityChange?: () => void;
  onNotification?: (event: AgentNotificationEvent) => void;
};

type QuestionSetObservation = { ids: Set<string>; age: number };
type QuestionSetCoverage = { parentId?: string; own?: QuestionSetObservation; children?: QuestionSetObservation };
type QuestionSetRead = { conversationId: string; parentId?: string; scope: Set<string>; sets: Map<string, QuestionSetCoverage>; age: number; conflicted: boolean; revision: number };

export class ChatAdapter {
  private readonly notifications: AgentNotificationTracker;
  readonly generation: string;
  private readonly provider: ChatProvider;
  private readonly workspacePath: string;
  private readonly resolveAttachment: ChatAdapterOptions["resolveAttachment"];
  private readonly replayBytes: number;
  private readonly id: () => string;
  private readonly projections = new Map<string, ConversationProjection>();
  private readonly replayClock = { next: 0 };
  private readonly permissionQueueOrder = new PermissionQueueOrder();
  private readonly receipts: IdempotencyReceipts;
  // Question item ids currently published per conversation, so a question that
  // stops being pending can be withdrawn from the timeline.
  private readonly publishedQuestions = new Map<string, Set<string>>();
  // Empty reconciliation authority belongs only to overlapping reads, never
  // to the adapter's retained conversation state.
  private readonly questionReads = new Set<QuestionSetRead>();
  private questionReadClock = 0;
  private readonly questionRefreshes = new Set<string>();
  private readonly questionCreatedAt = new Map<string, number>();
  private readonly permissionCreatedAt = new Map<string, number>();
  // What each pending question/permission was announced as, by item id: the
  // owning conversation and the launching conversation it appeared under. A
  // removal has no item to read these from, and the conversation reporting it
  // may be the parent — a subagent's request is answered from the parent's
  // transcript, or retired by a reconciliation — so the resolution is built
  // from this record, with no provider lookup that could fail and drop it.
  // The tick orders an announcement against an authoritative pending read: a
  // request announced after the read began is pending now whatever the older
  // snapshot lists.
  private interactionClock = 0;
  private readonly announced = new Map<string, { owner: string; destination: string; tick: number }>();
  private readonly sessionParents = new Map<string, string | null>();
  private readonly inventorySessions = new Map<string, InventorySessionMetadata>();
  // Ids this adapter has listed as visible conversations. A list fetch does
  // not acknowledge lifecycle metadata (see inventorySessions), but it does
  // establish what a later sparse deletion can have removed.
  private readonly listedSessions = new Map<string, true>();
  private readonly inventory = new ConversationInventoryBroadcaster();
  private catalogSequence = 0;

  catalogRevision(): string | undefined {
    return this.catalogSequence ? `${this.generation}:${this.catalogSequence}` : undefined;
  }
  // Conversations with a turn in flight, tracked at the adapter so the fact
  // survives projection eviction. This is what distinguishes "the store says
  // running because OpenCode died mid-turn" from "running right now".
  private readonly liveTurns = new Map<string, ConversationStatus>();
  // Request-scoped execution fences, not inbox/activity revisions. A native
  // parent wake can overtake an interrupt response (even across projection
  // eviction); its live status makes that old response stale. Only in-flight
  // Stops retain an observer, and the admission lane permits one per session.
  private readonly stoppingTurns = new Map<string, { resumed: boolean; status?: ConversationStatus }>();
  // Conversations holding live background work (`background` status) with no
  // turn in flight. Kept apart from liveTurns on purpose: liveTurns gates the
  // composer's Cancel and held prompts, and a background conversation must
  // still accept a prompt — while the hub's activity summary, by spec, counts
  // live background work as working.
  // Retain the evidence source alongside the existing per-conversation fact:
  // a stream gap must withdraw verified work even after projection eviction,
  // without changing providers' authoritative legacy background behavior.
  private readonly backgroundWork = new Map<string, { legacy: boolean; verified: boolean }>();
  private readonly unresolvedBackgroundWork = new Set<string>();
  private readonly backgroundRecoveries = new Map<string, BackgroundRecovery>();
  // Losing disposable scheduling ownership never waives an exhausted floor.
  // Scalars conservatively cover untracked conversations without a second
  // per-conversation registry or any timer.
  private backgroundRecoveryFloorUntil = 0;
  private backgroundRecoverySourceStartedAt = -Infinity;
  private backgroundRecoveryCount = 0;
  private readonly backgroundPending = new Set<Promise<void>>();
  private backgroundStreamGeneration = 0;
  private backgroundConnected = false;
  private backgroundReady?: Promise<void>;
  private backgroundReadyResolve?: () => void;
  // Pending permission and question item ids per conversation, adapter-level
  // like liveTurns: a conversation blocked on the user goes quiet and is
  // exactly the one an LRU pass evicts, and its request must still count.
  private readonly pendingInteractions = new Map<string, Set<string>>();
  private readonly onActivityChange: (() => void) | undefined;
  private lastActivity: ChatActivity = { working: false, awaiting: false, unresolved: false };
  private readonly maxProjections: number;
  private readonly coalesceWindowMs: number | undefined;
  private readonly metrics: ChatEventMetrics | undefined;
  private readonly countedEventTypes = new Set<string>();
  // Provider-owned state. This cache only avoids repeated reads while a
  // projection is warm; every miss recovers through the provider seam.
  private readonly configurations = new Map<string, ConversationConfiguration>();
  private readonly configurationReads = new Map<string, Promise<ConversationConfiguration>>();
  private readonly nativeHistoryReads = new Map<string, { stream: AbortController | null; promise: Promise<ConversationSnapshot>; recovery: { dirty: boolean } }>();
  // Unlike the reusable-read cache, this set also covers paging and reversible
  // replacement. Each bounded owner retires in readCoveredHistory's finally.
  private readonly nativeHistoryOwners = new Map<string, Set<{ stream: AbortController | null; recovery: { dirty: boolean }; replacement: boolean }>>();
  private readonly nativeAssociationReads = new Set<CachedAssociationRead>();
  private readonly promptAdmissions = new Map<string, Promise<void>>();
  private readonly reversibleHistory = new Map<string, ReversibleHistoryState>();
  // Set before an interrupt or rewrite read. Provider idle events can arrive
  // before those calls resolve, so delivery must consult this independently
  // of the eventual staged state.
  private readonly reversibleMutations = new Set<string>();
  private readonly revertReconciliations = new Map<string, RevertReconciliation>();
  // Messages accepted while the conversation was busy, held here until the
  // turn ends. Adapter-level like liveTurns, not projection state: a held
  // message must survive projection eviction, or an LRU pass would silently
  // drop text the user was promised would be delivered.
  private readonly heldQueues = new Map<string, HeldQueue>();
  // Queues a cancellation paused. A dormant queue keeps its messages visible
  // and removable but delivers nothing until the user's next submission
  // reactivates it — cancel means stop, not "start the next thing".
  private readonly dormantQueues = new Set<string>();
  // Steers pending in the agent's inbox, per conversation, in enqueue order
  // (opencode-v2-steering D3). Built from inbox deltas and this adapter's own
  // admissions; replaced from the agent's list on attach and reconnect.
  // Adapter-level like heldQueues, for the same eviction reason.
  private readonly pendingSteers = new Map<string, PendingSteer[]>();
  // Settlement owners survive projection eviction. A receipt may clear only
  // the owner it observed before dispatch, never a newer settlement. Identity,
  // not wall time, orders phases; queuedAt remains display metadata.
  private readonly settledTurns = new Map<string, object>();
  // Which entries were last published as paused, so a change publishes one
  // `paused` or `resumed` event per affected entry and nothing otherwise.
  private readonly publishedPaused = new Map<string, Set<string>>();
  // Withdrawals waiting for the agent's settlement of an inbox entry (D7).
  private readonly steerSettlements = new Map<string, Map<string, (outcome: "delivered" | "cancelled") => void>>();
  private readonly deliveredSteers = new Map<string, string | true>();
  // Only admissions currently awaiting acknowledgement: terminal events must
  // win even when there was no pending event, or the delivered-id cache evicts.
  private readonly admittingSteers = new Map<string, SteerAdmission>();
  // Terminal fences live only for concurrent inbox reads, not a permanent
  // tombstone cache. Each read releases its set on success or failure.
  private readonly inboxReads = new Map<string, Set<Set<string>>>();
  private readonly steerWithdrawTimeoutMs: number;
  private readonly historyReadTimeoutMs: number;
  private readonly accountingReadTimeoutMs: number;
  private readonly nativeAccountingReads = new Map<string, { controller: AbortController; promise: Promise<void>; callers: number; sources: WorkerSourceRead }>();
  private readonly automaticBackgroundTimeoutMs: number;
  private readonly steerAdmissionTimeoutMs: number;
  private inboxClock = 0;
  // Internal held-submission order survives delivery switches and uncertain
  // admissions. Retained only on bounded pending owners/admission fences, not
  // an identity/receipt registry. Timestamps remain display metadata. Entries
  // first recovered from native storage receive observed list/event order;
  // unavailable cross-client submission chronology cannot be reconstructed.
  private submissionClock = 0;
  // Mirrors a running OpenCode TUI: once this adapter accepts a prompt, the
  // next conversation starts from that process-local selection. A fresh
  // adapter falls back to OpenCode's durable config/recent-model policy.
  private newConversationDefaults: ConversationConfiguration | undefined;
  // A subagent's own cost and model, kept per message within the child session.
  // Per message because `message.updated` restates growing tokens rather than
  // adding to them, and removing the newest message must reveal the preceding
  // message's model rather than leave the deleted one attributed.
  //
  // Keyed by parent AND child (`attributionKey`), not by child alone: the
  // tally exists to decorate a row in the parent's timeline, so it should live
  // exactly as long as that timeline does. Keyed by the child, eviction would
  // never fire — the LRU evicts conversations, and a child session usually has
  // no projection of its own. A ceiling backstops both maps besides.
  private readonly childUsage = new Map<string, ChildUsage>();
  private readonly childModels = new Map<string, Map<string, MessageModel>>();
  // Which prompt each of the child's messages answers. A subagent handed a
  // further task (OpenCode's `task_id`) is one session with a prompt per task,
  // and two rows in the parent; the prompt is what says which row a message's
  // spend belongs on. Without it every row would restate the whole session.
  private readonly childPrompts = new Map<string, Map<string, string>>();
  // The child's prompts in order, and the subagents the child itself launched.
  // The k-th prompt pairs with the k-th row that launched the child; a nested
  // launcher belongs to the prompt it follows. Same key and lifetime as the
  // tallies, so an eviction re-arms the stored read for all of them together.
  private readonly childTranscripts = new Map<string, ChildTranscript>();
  // Exact provenance of generated lines, not an ID-based authority cache.
  // Weak keys follow existing projection/replay references through shallow merges.
  private readonly descendantBindings = new WeakMap<SubagentLine, DescendantBinding>();
  // Read-owned publication guards follow queued objects, not conversation IDs.
  // Consumed objects retain only a false tombstone, so replay cannot turn a
  // guarded update into an unguarded native update or retain its read owner.
  private readonly rewritePublications = new WeakMap<object, { original: ToolItem; cohort: readonly ToolItem[]; context: object; visible: boolean; current: () => boolean;
    accepted?: (before: ConversationItem | undefined, actual: ConversationItem | undefined) => void } | false>();
  // Sparse presentation merges keep the receipt's original immutable task.
  private readonly launcherAccounting = new WeakMap<object, Readonly<{ parentId: string; childId: string; task: TaskRow }>>();
  // Launchers removed before the tally was squared against the store. A
  // stored read in flight would otherwise hand the removed launcher back and
  // bank it — the same race `removedChildAttribution` closes for messages.
  private readonly removedLaunchers = new Map<string, Set<string>>();
  // Ordered live removals survive both refresh and inspection reads until a
  // later live upsert, explicit invalidation or bounded cache retirement.
  private readonly removedChildAttribution = new Map<string, Map<string, number>>();
  private readonly attributionReconstructions = new Map<string, Promise<void>>();
  private readonly attributionEpochs = new Map<string, AttributionOwner>();
  // When each live-banked figure arrived, as a running sequence, so a
  // reconstruction can tell an update that landed during its read (newer
  // than the store) from one banked before it began (which the store may
  // have overtaken — a partial figure seen before a disconnect, the child
  // finishing while the stream was down).
  private attributionSequence = 0;
  private readonly attributionArrivals = new Map<string, Map<string, number>>();
  // Attribution keys whose tally has been squared against the child's stored
  // history. A live tally alone is not proof of completeness: a parent evicted
  // mid-run loses its maps, and the child's next event recreates one holding
  // only the post-eviction message — present, but missing everything before.
  // Only a successful stored read (merged with whatever landed live) earns the
  // mark, and only the mark lets history() skip the read.
  private readonly completeAttributions = new Map<string, number>();
  private readonly childSessionCosts = new Map<string, { costUsd: number | null; highest: number; sequence: number }>();
  private eventCoalescer: ProviderUpdateCoalescer | null = null;
  private pumpController: AbortController | null = null;
  private pumpPromise: Promise<void> | null = null;
  private disposalPromise: Promise<void> | null = null;
  private disposed = false;

  constructor(options: ChatAdapterOptions) {
    this.notifications = new AgentNotificationTracker({ emit: options.onNotification ?? (() => {}), now: options.now });
    this.provider = options.provider;
    this.workspacePath = options.workspacePath;
    this.resolveAttachment = options.resolveAttachment;
    this.generation = options.generation ?? randomBytes(16).toString("base64url");
    this.replayBytes = options.replayBytes ?? 256 * 1024;
    this.maxProjections = options.maxProjections ?? 64;
    this.coalesceWindowMs = options.coalesceWindowMs;
    this.metrics = options.metrics;
    this.id = options.id ?? randomUUID;
    this.steerWithdrawTimeoutMs = options.steerWithdrawTimeoutMs ?? DEFAULT_STEER_WITHDRAW_TIMEOUT_MS;
    this.historyReadTimeoutMs = options.historyReadTimeoutMs ?? DEFAULT_HISTORY_READ_TIMEOUT_MS;
    this.accountingReadTimeoutMs = options.accountingReadTimeoutMs ?? 1_000;
    this.automaticBackgroundTimeoutMs = options.automaticBackgroundTimeoutMs ?? 15_000;
    this.steerAdmissionTimeoutMs = options.steerAdmissionTimeoutMs ?? 30_000;
    this.onActivityChange = options.onActivityChange;
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
      const metadata = await this.classifyInventorySession(session);
      if (!metadata.inWorkspace) continue;
      // Subagent children stay out of the picker: they are reached from the
      // parent's subagent rows, and listing them as peers buries the real
      // conversations under machine-titled entries.
      if (metadata.parentId) continue;
      if (this.provider.renameSession && isDefaultConversationTitle(session.title)) {
        try {
          let page = await this.provider.listMessages(session.id, { limit: 100 });
          let items = [...(page.completeItems ?? page.items)];
          while (!page.completeItems && page.nextCursor) {
            page = await this.provider.listMessages(session.id, { cursor: page.nextCursor, limit: 100 });
            if (page.completeItems) items = [...page.completeItems];
            else items.push(...page.items);
          }
          const firstUserMessage = items
            // A wakeup's prompt was the agent's, not a title the user gave.
            .filter(item => item.type === "user_message" && item.origin === undefined && item.text.trim())
            .sort((left, right) => left.createdAt - right.createdAt)[0];
          if (firstUserMessage?.type === "user_message") {
            const renamed = await this.provider.renameSession(session.id, deriveConversationTitle(firstUserMessage.text));
            const renamedMetadata = await this.classifyInventorySession(renamed);
            if (!renamedMetadata.inWorkspace) throw new ConversationNotFoundError();
            this.rememberInventorySession(renamed.id, renamedMetadata, true);
            session = renamed;
          }
        } catch {
          // A title repair must not make an otherwise usable conversation disappear.
        }
      }
      boundedSet(this.listedSessions, session.id, true, INVENTORY_SESSION_LIMIT);
      accepted.push(this.summary(session));
    }
    return accepted.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  }

  models(): Promise<ChatModel[]> {
    return this.provider.listModels();
  }

  /** Whether the machine's logins let the agent run a turn, as last read; undefined when the provider cannot say. */
  loginState(): ChatLoginState | undefined {
    return this.provider.loginState?.();
  }

  /** The machine's logins changed (Agent accounts): the provider re-reads and replays. */
  async accountsChanged(change: ChatAccountChange): Promise<void> {
    await this.provider.accountsChanged?.(change);
  }

  agent(): ChatAgent {
    const agent = this.provider.describe();
    const reversible = this.provider.getReversibleHistoryState
      && this.provider.undo && this.provider.redo && this.provider.revert && this.provider.restore;
    if (reversible || !agent.capabilities.includes("reversible-history")) return agent;
    return { ...agent, capabilities: agent.capabilities.filter(capability => capability !== "reversible-history") };
  }

  async modes(): Promise<ChatMode[]> {
    return this.provider.listModes ? this.provider.listModes() : [];
  }

  async commands(): Promise<ChatCommand[]> {
    const upstream = await this.provider.listCommands();
    const commands = this.agent().capabilities.includes("side-generation")
      ? [...upstream.filter(command => command.name !== "btw"), { name: "btw", description: "Ask a side question without changing the conversation", argumentHint: "question", kind: "local-operation" as const }]
      : upstream.filter(command => command.name !== "btw");
    if (!this.agent().capabilities.includes("reversible-history")) return commands;
    const localNames = new Set(REVERSIBLE_HISTORY_COMMANDS.map(command => command.name));
    return [...commands.filter(command => !localNames.has(command.name)), ...REVERSIBLE_HISTORY_COMMANDS];
  }

  async createConversation(): Promise<ConversationSnapshot> {
    const configuration = this.newConversationDefaults ?? await this.provider.newConversationConfiguration();
    const created = await this.provider.createSession(this.id(), configuration);
    const session = await this.requireSession(created.id);
    this.rememberInventorySession(session.id, await this.classifyInventorySession(session), true);
    const projection = this.projection(session.id);
    this.configurations.set(session.id, configuration);
    const reversibleHistory = await this.readReversibleHistoryState(session.id);
    return {
      conversation: this.summary(session),
      configuration,
      generation: this.generation,
      cursor: projection.replay.latestCursor(),
      items: [],
      queued: [],
      ...(reversibleHistory ? { reversibleHistory } : {}),
    };
  }

  async getConversation(id: string): Promise<ConversationSummary> {
    return this.summary(await this.requireSession(id));
  }

  async workerEvidence(id: string): Promise<WorkerEvidenceSnapshot> {
    let snapshot: ConversationSnapshot;
    if (!this.provider.waitForEventStream) snapshot = await this.readHistory(id, { workers: true });
    else {
      if (!this.pumpPromise) void this.startEventPump().catch(() => undefined);
      snapshot = await this.readCoveredHistory(id, { workers: true }, { dirty: false });
    }
    return { version: 1, conversationId: id, complete: true, entries: compactWorkerEvidence(snapshot.items) };
  }

  async history(id: string, options: { cursor?: string; limit?: number } = {}): Promise<ConversationSnapshot> {
    if (!this.provider.waitForEventStream) return this.readHistory(id, options);
    if (!this.pumpPromise) void this.startEventPump().catch(() => undefined);
    const reusable = !options.cursor && options.limit === undefined;
    const pending = this.nativeHistoryReads.get(id);
    if (reusable && pending?.stream === this.pumpController) return pending.promise;
    const recovery = { dirty: false };
    const promise = this.readCoveredHistory(id, options, recovery);
    if (reusable) {
      const owner = { stream: this.pumpController, promise, recovery };
      this.nativeHistoryReads.set(id, owner);
      void promise.finally(() => { if (this.nativeHistoryReads.get(id) === owner) this.nativeHistoryReads.delete(id); }).catch(() => undefined);
    }
    return promise;
  }

  private markNativeHistoryDirty(id: string, replacementsOnly = false): boolean {
    let marked = false;
    for (const owner of this.nativeHistoryOwners.get(id) ?? []) {
      if (owner.stream !== this.pumpController || replacementsOnly && !owner.replacement) continue;
      owner.recovery.dirty = true;
      marked = true;
    }
    return marked;
  }

  private async readCoveredHistory(id: string, options: { cursor?: string; limit?: number; workers?: true }, recovery: { dirty: boolean }, replacement?: { isCurrent?: () => boolean }): Promise<ConversationSnapshot> {
    // Pin only already-known native identities for this bounded read owner.
    // Pending owners can depart, and the global delivery cache can evict,
    // before a native history row (including a dirty reread) is applied.
    const steerCorrelations = this.snapshotSteerCorrelations(id);
    // Retain only already-projected exact exclusions across this owner's
    // dirty rereads. A new turn can commit the staged suffix out of storage
    // before the reread; a restore, in contrast, puts those ids back in the
    // complete visible source. Released with this bounded read, not cached.
    const revertExclusions = new Set<string>();
    const stream = this.pumpController;
    const owner = { stream, recovery, replacement: replacement !== undefined };
    let owners = this.nativeHistoryOwners.get(id);
    if (!owners) this.nativeHistoryOwners.set(id, owners = new Set());
    owners.add(owner);
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, ...(stream ? [stream.signal] : [])]);
    const timer = setTimeout(() => lifetime.abort(), this.historyReadTimeoutMs);
    let fence: ReturnType<ConversationProjection["beginHistoryRead"]> | undefined;
    let ready = false;
    let unavailable!: () => void;
    const expired = new Promise<never>((_resolve, reject) => { unavailable = () => reject(new Error("Inbox recovery unavailable")); });
    signal.addEventListener("abort", unavailable, { once: true });
    let associationRead: CachedAssociationRead | undefined;
    try {
      // Retained graph edges need a read-owned invalidation watch before any
      // transport can hang or expire. Accounting success is not a prerequisite.
      if (this.provider.watchWorkerAssociations) {
        associationRead = new CachedAssociationRead(id, signal, this.provider.watchWorkerAssociations.bind(this.provider));
        this.nativeAssociationReads.add(associationRead);
        this.watchCachedAssociations(associationRead);
        for (const item of this.projections.get(id)?.items() ?? []) this.watchProjectionAssociations(id, item);
      }
      return await Promise.race([(async () => {
        // V2 cannot replay the handshake gap. History AND inbox must be read
        // after the native server.connected frame, on the same owned stream.
        await this.provider.waitForEventStream!(signal);
        // The provider resolves its barrier before yielding the handshake;
        // let the adapter record that frame's generation before capturing it.
        if (this.provider.reconcileBackgroundTasks) await this.backgroundReady;
        signal.throwIfAborted();
        ready = true;
        for (const [nativeId, requestId] of this.snapshotSteerCorrelations(id)) steerCorrelations.set(nativeId, requestId);
        const generation = this.backgroundStreamGeneration;
        const assertCurrent = () => {
          if (signal.aborted || this.disposed || this.pumpController !== stream || generation !== this.backgroundStreamGeneration
            || replacement?.isCurrent && !replacement.isCurrent()) throw new Error("Inbox recovery unavailable");
        };
        // A delivery whose enqueue predates this subscription has no native
        // payload to replay. Reread storage, never invent a row from dock text.
        // The whole handoff, including rereads, shares one bounded lifetime.
        let inboxReconciled = false;
        let refreshAttribution = false;
        // Dirty replacement retries belong to the same read. They must not
        // turn its later accepted announcements into pre-read retirement targets.
        const questionTick = this.interactionClock;
        while (true) {
          recovery.dirty = false;
          const readProjection = this.projection(id);
          fence = readProjection.beginHistoryRead();
          const attempt = new AbortController();
          const attemptSignal = AbortSignal.any([signal, attempt.signal]);
          const workerSources = new WorkerSourceRead(attemptSignal);
          const associations = associationRead?.begin(workerSources);
          const cachedAssociations = associations?.evidence ?? [];
          try {
            const snapshot = await this.readHistory(id, options, { signal: attemptSignal, projection: readProjection, workerSources, cachedAssociations, refreshAttribution, assertCurrent, dirty: () => recovery.dirty, revertExclusions, merge: fence.merge, changed: fence.changed, conversation: fence.conversation, inboxReconciled, markInboxReconciled: () => { inboxReconciled = true; }, steerCorrelations, questionTick, ...(replacement ? { replacement: true } : {}) });
            inboxReconciled = true;
            assertCurrent();
            if (!recovery.dirty) return snapshot;
          } catch (error) {
            if (!(error instanceof HistoryReadChangedError)) throw error;
            // Retry current association proof without deleting another read's
            // banked accounting or completeness stamps.
            refreshAttribution = true;
          } finally { associations?.release(); attempt.abort(); fence.release(); }
        }
      })(), expired]);
    } catch (error) {
      if (!ready || signal.aborted) throw new Error("Inbox recovery unavailable");
      throw error;
    }
    finally {
      if (associationRead) this.nativeAssociationReads.delete(associationRead);
      owners.delete(owner);
      if (!owners.size && this.nativeHistoryOwners.get(id) === owners) this.nativeHistoryOwners.delete(id);
      clearTimeout(timer);
      signal.removeEventListener("abort", unavailable);
      fence?.release();
      lifetime.abort();
    }
  }

  private async readHistory(id: string, options: { cursor?: string; limit?: number; workers?: true }, coverage?: HistoryCoverage): Promise<ConversationSnapshot> {
    const questionTick = coverage?.questionTick ?? this.interactionClock;
    for (let attempt = 0; ; attempt++) {
      const questions: QuestionSetRead = { conversationId: id, scope: new Set(), sets: new Map(), age: 0, conflicted: false, revision: 0 };
      const release = () => { this.questionReads.delete(questions); };
      coverage?.signal.addEventListener("abort", release, { once: true });
      try { return await this.readHistoryWithQuestions(id, options, coverage, questions, questionTick); }
      catch (error) {
        // Covered reads retry under their existing bounded owner. Legacy
        // reads get at most two retries to include an older overlapping commit.
        if (coverage || !questions.conflicted || !(error instanceof HistoryReadChangedError) || attempt >= 2) throw error;
      }
      finally { release(); coverage?.signal.removeEventListener("abort", release); }
    }
  }

  private async readHistoryWithQuestions(id: string, options: { cursor?: string; limit?: number; workers?: true }, coverage: HistoryCoverage | undefined, questionRead: QuestionSetRead, questionTick: number): Promise<ConversationSnapshot> {
    const session = await this.requireSession(id);
    coverage?.assertCurrent();
    // Captured before the provider reads: a pump event landing during them
    // advances the replay log, and a cursor taken afterwards would tell the
    // client's SSE handshake the event was already delivered when the items
    // below may not contain it. Replaying from this earlier boundary instead
    // re-applies such events idempotently.
    const replayCursor = this.projection(id).replay.latestCursor();
    const cursor = options.cursor ? decodeHistoryCursor(options.cursor) : undefined;
    const readStartedAt = this.attributionSequence;
    const parentId = session.parentId;
    const attributionOwner = parentId ? this.projections.get(parentId) : undefined;
    const inspectionKey = parentId ? attributionKey(parentId, id) : undefined;
    const inspectionEpoch = inspectionKey ? this.attributionReadEpoch(inspectionKey) : undefined;
    let page = await this.provider.listMessages(id, { cursor: cursor?.provider, limit: options.limit ?? DEFAULT_PAGE_SIZE, ...(coverage ? { signal: coverage.signal } : {}) });
    coverage?.assertCurrent();
    if (page.isWorkerSourceCurrent && !page.isWorkerSourceCurrent()) throw new HistoryReadChangedError();
    // Capture the requested provider slice, not the later augmented snapshot:
    // accounting, launcher backfills and coverage.merge may add rows from far
    // outside this page. Only an actual page message establishes its frontier.
    const firstMessage = page.items.find(item => item.type === "user_message" || item.type === "assistant_message" && item.markdown !== "");
    const historyStart = firstMessage ? { id: this.correlateSteerMessage(id, firstMessage, coverage?.steerCorrelations).id, createdAt: firstMessage.createdAt } : undefined;
    if (options.workers && !page.completeItems) {
      // The compact read requires complete coverage, not a cached projection.
      // Native providers supply completeItems in one read. Legacy providers may
      // page under the original bounded fallback; no transcript bytes cross HTTP.
      const requireRowOnlyPage = (source: ProviderHistoryPage) => {
        // Association/origin/revert/accounting facts are source-scoped, not
        // independently unionable page decorations. Without completeItems we
        // cannot prove one combined provenance view. Refuse rather than drop
        // older counterproof (or misapply first-page authority to older rows).
        const rowKeys = ["items", "accounting", "nextCursor", "isWorkerSourceCurrent"];
        if (source.accounting.length || Object.entries(source).some(([key, value]) => value !== undefined && !rowKeys.includes(key))) {
          throw new WorkerEvidenceError("unavailable", "authoritative worker provenance requires complete source coverage");
        }
      };
      requireRowOnlyPage(page);
      const items = [...page.items], cursors = new Set<string>();
      const guards = page.isWorkerSourceCurrent ? [page.isWorkerSourceCurrent.bind(page)] : [];
      let next = page.nextCursor;
      for (let count = 1; next !== undefined; count++) {
        if (count >= 20 || cursors.has(next)) throw new WorkerEvidenceError("unavailable", "authoritative worker history exceeds read budget");
        cursors.add(next);
        const older = await this.provider.listMessages(id, { cursor: next, limit: DEFAULT_PAGE_SIZE, ...(coverage ? { signal: coverage.signal } : {}) });
        coverage?.assertCurrent();
        requireRowOnlyPage(older);
        if (older.isWorkerSourceCurrent && !older.isWorkerSourceCurrent()) throw new HistoryReadChangedError();
        if (older.revertVisibility?.boundaryId !== page.revertVisibility?.boundaryId) throw new HistoryReadChangedError();
        if (older.isWorkerSourceCurrent) guards.push(older.isWorkerSourceCurrent.bind(older));
        items.unshift(...older.items); next = older.nextCursor;
      }
      page = { ...page, completeItems: items, nextCursor: undefined, isWorkerSourceCurrent: () => guards.every(current => current()) };
    }
    // Current-source assertions must precede liveness normalization, recovery
    // indexing and any row-id collapse. Otherwise a terminal duplicate could
    // erase positive activity before the final compact evidence fold sees it.
    const workerSource = options.workers ? validatedWorkerDismissalSource(page.completeItems ?? page.items, page.items) : undefined;
    const workerStrength = workerSource && workerDismissalSourceStrength(workerSource);
    if (coverage?.replacement && !page.completeItems) {
      // Replacement needs the whole visible transcript, not just its newest
      // page. V2 normally supplies completeItems; other covered providers may
      // instead require paging under the same owner and native boundary.
      page = { ...page, items: [...page.items], accounting: [...page.accounting],
        ...(page.workerResultFallbacks ? { workerResultFallbacks: [...page.workerResultFallbacks] } : {}),
        ...(page.revertVisibility ? { revertVisibility: { ...page.revertVisibility, excludedItemIds: [...page.revertVisibility.excludedItemIds] } } : {}) };
      let next = page.nextCursor;
      while (next !== undefined) {
        const older = await this.provider.listMessages(id, { cursor: next, limit: RECONSTRUCTION_READ_LIMIT, signal: coverage.signal });
        coverage.assertCurrent();
        if (older.revertVisibility?.boundaryId !== page.revertVisibility?.boundaryId) throw new HistoryReadChangedError();
        page.items.unshift(...older.items);
        page.accounting.unshift(...older.accounting);
        if (older.workerResultFallbacks) (page.workerResultFallbacks ??= []).push(...older.workerResultFallbacks);
        if (older.revertVisibility) page.revertVisibility!.excludedItemIds.push(...older.revertVisibility.excludedItemIds);
        next = older.nextCursor;
      }
      page.completeItems = page.items;
    }
    if (coverage && page.revertVisibility && this.provider.getHistoryRevertBoundary) {
      for (const itemId of page.revertVisibility.excludedItemIds) if (this.projection(id).has(itemId)) coverage.revertExclusions.add(itemId);
    }
    // An inspection predating parent eviction/revert cannot repopulate its cleared cache.
    if (parentId && attributionOwner && this.projections.get(parentId) === attributionOwner && this.attributionEpochs.get(inspectionKey!)?.epoch === inspectionEpoch) {
      this.refreshInspectedChildAccounting(id, parentId, page.accounting, page.sessionCostUsd, readStartedAt);
    }
    // Attaching reconciles the pending steers with the agent's own list, so a
    // steer raised by another client or while the stream was down is listed
    // (opencode-v2-steering D3). Only the first page: an older page is not
    // an attach.
    // A missing-payload delivery only requires a newer transcript. The inbox
    // already reconciled under coverage keeps its newer ordered live deltas.
    if (!cursor && !coverage?.inboxReconciled) {
      await this.reconcilePendingSteers(id, page.completeItems ?? page.items, coverage);
      coverage?.markInboxReconciled();
    }
    coverage?.assertCurrent();
    // Some providers page locally after loading the complete transcript. Reuse
    // that complete source for recovery, never the bounded visible page.
    const configuration = await this.configuration(id);
    coverage?.assertCurrent();
    const items = (workerSource ?? (coverage?.replacement ? page.completeItems ?? page.items : page.items))
      .filter(item => !options.workers || item.type === "tool" || item.type === "background_task")
      .map(item => this.correlateSteerMessage(id, item, coverage?.steerCorrelations));
    if (options.workers && items.length > WORKER_EVIDENCE_LIMIT) throw new WorkerEvidenceError("capacity", "worker dismissal source capacity reached");
    const sourceProjection = this.projection(id);
    // Reads can still fail or lose admission after these decisions. Keep
    // their removals (and request retirement effects) private until the same
    // validated commit as the recovered rows. An early decision cannot remove
    // a newer native replacement that arrived during a subsequent await.
    const historyRemovals = new Map<string, { expected: ConversationItem | undefined; retired?: () => void }>();
    const stageHistoryRemoval = (itemId: string, retired?: () => void) => {
      historyRemovals.set(itemId, { expected: this.projection(id).get(itemId), retired: retired ?? historyRemovals.get(itemId)?.retired });
    };
    const revokedChildren = new Set(page.workerAssociationContradictions);
    const fallbackRelations = [...(page.workerResultFallbacks ?? [])];
    const positiveFallbacks = new Set<string>();
    const hiddenReports = new Set(page.hiddenWorkerResultIds);
    const positiveReports = new Set<string>();
    const resetReports = new Set<string>();
    const revokedRows = new Set<string>();
    for (const item of sourceProjection.items()) if (item.type === "background_task" && item.resultId) {
      if (page.workerOriginCoverage && sourceProjection.workerReportOriginAbsent(item, page.workerOriginCoverage)) hiddenReports.add(item.resultId);
      if (hiddenReports.has(item.resultId) && page.workerOriginCoverage && sourceProjection.workerLaunchOriginPresent(item, page.workerOriginCoverage)) resetReports.add(item.id);
    }
    // Source authority is applied before attribution and again after the live
    // merge. A launcher, a delivered report and a child association have
    // independent provenance; none can vouch for the others.
    const reconcileWorkerSource = () => {
      const retained: ConversationItem[] = [];
      for (const item of items) {
        if ((item.type === "tool" || item.type === "background_task") && item.childConversationId && revokedChildren.has(item.childConversationId)) {
          revokedRows.add(item.id);
          if (item.type === "background_task") {
            for (const relation of fallbackRelations) if (relation.resultId === item.resultId
              && relation.childConversationId === item.childConversationId && !hiddenReports.has(relation.resultId)) retained.push(relation.fallback);
            continue;
          }
          const { childConversationId: _child, usage: _usage, model: _model, descendants: _descendants, workerSession: _session, ...transcript } = item;
          retained.push(transcript);
          continue;
        }
        if (item.type === "background_task" && (item.resultId
          ? hiddenReports.has(item.resultId) && !positiveReports.has(item.resultId) && page.workerOriginCoverage && sourceProjection.workerLaunchOriginPresent(item, page.workerOriginCoverage)
          : resetReports.has(item.id))) {
          resetReports.add(item.id);
          const prefix = page.completeItems?.find(candidate => candidate.id === item.id && candidate.type === "background_task" && !candidate.resultId);
          const base = prefix?.type === "background_task" ? prefix : item;
          const { resultId: _result, summary: _summary, terminalReportedAt: _terminal, workerSession: _session, usage: _usage, activity: _activity, ...launch } = base;
          retained.push({ ...launch, status: "running", stateUncertain: true, activity: { kind: "unavailable" }, control: { available: false, reason: "Visible launch has no current execution proof" } });
          continue;
        }
        retained.push(item);
      }
      if (options.workers) validatedWorkerDismissalSource(retained);
      items.splice(0, items.length, ...new Map(retained.map(item => [item.id, item])).values());
    };
    const nativeToolChildren = new Map<string, string | undefined>();
    for (const origin of page.workerOriginCoverage ?? []) if (origin.taskType === "agent" && origin.toolUseId) {
      const key = `tool:${origin.toolUseId}`;
      // A reused native call across visible origins is not exact association proof.
      nativeToolChildren.set(key, nativeToolChildren.has(key) ? undefined : origin.childConversationId);
    }
    const sameToolAssociation = (item: ToolItem, prior: ToolItem): boolean => prior.childConversationId !== undefined
      && !revokedChildren.has(prior.childConversationId) && nativeToolChildren.get(item.id) === prior.childConversationId
      && item.name === prior.name && item.createdAt === prior.createdAt && item.input === prior.input
      && !(item.status === "completed" && prior.status === "completed" && item.completedAt !== prior.completedAt);
    const retainToolAssociation = (item: ToolItem, projection: ConversationProjection): ToolItem => {
      if (item.childConversationId || !coverage || !this.provider.watchWorkerAssociations || coverage.changed(item.id)) return item;
      const prior = projection.get(item.id);
      if (prior?.type !== "tool" || !prior.childConversationId) return item;
      if (!nativeToolChildren.has(item.id)) return item;
      if (!sameToolAssociation(item, prior)) {
        // Ordinary sparse upserts must not move the old association onto a
        // changed occurrence that a later replacement could mistake for proof.
        revokedRows.add(item.id);
        return item;
      }
      if (prior.name !== "subagent" || item.status !== "completed" || prior.status !== item.status) return item;
      // A current native occurrence plus its previously verified association
      // preserves inspection identity during optional enrichment loss. Raw
      // origins alone admit neither a new association nor control authority.
      return { ...item, childConversationId: prior.childConversationId };
    };
    const reconcileRetainedAccounting = (projection: ConversationProjection) => {
      const contradicted = new Map((coverage?.cachedAssociations ?? []).map(evidence => [evidence.parentId, new Set(evidence.childIds)]));
      const hasCounterproof = [...contradicted.values()].some(children => children.size);
      const reconcile = (item: ToolItem): { item: ToolItem; revoked: boolean } => {
        if (!hasCounterproof || !item.childConversationId || !item.descendants?.length) return { item, revoked: false };
        const byId = new Map(item.descendants.map(line => [line.id, line]));
        const allowed = new Map<string, boolean>();
        const current = (line: SubagentLine, ancestry = new Set<string>()): boolean => {
          if (ancestry.has(line.id)) return true; // A cycle alone is not scoped counterproof.
          const known = allowed.get(line.id);
          if (known !== undefined) return known;
          const parent = byId.get(line.parentId);
          const parentSession = parent?.conversationId ?? (line.parentId === item.id ? item.childConversationId : undefined);
          const retained = !(parentSession && contradicted.get(parentSession)?.has(line.conversationId))
            && (!parent || current(parent, new Set([...ancestry, line.id])));
          allowed.set(line.id, retained);
          return retained;
        };
        const descendants = item.descendants.filter(line => current(line));
        if (descendants.length === item.descendants.length) return { item, revoked: false };
        const { descendants: _prior, ...own } = item;
        return { item: { ...own, ...(descendants.length ? { descendants } : {}) }, revoked: true };
      };
      for (let index = 0; index < items.length; index++) {
        const item = items[index]!;
        if (item.type === "background_task" && item.taskType === "agent" && item.childConversationId) {
          const prior = projection.get(item.id);
          const key = attributionKey(id, item.childConversationId);
          const calls = (worker: BackgroundTaskItem) => [...new Set([...(worker.toolUseIds ?? []), ...(worker.toolUseId ? [worker.toolUseId] : [])])].sort();
          const sameOccurrence = prior?.type === "background_task" && prior.taskType === item.taskType
            && prior.taskId === item.taskId && prior.createdAt === item.createdAt
            && prior.childConversationId === item.childConversationId && prior.outputFile === item.outputFile
            && prior.resultId === item.resultId && JSON.stringify(calls(prior)) === JSON.stringify(calls(item))
            && !(prior.activity?.launchRef && item.activity?.launchRef && prior.activity.launchRef !== item.activity.launchRef);
          if (coverage && this.provider.watchWorkerAssociations && sameOccurrence && prior.workerSession
            && !coverage.workerSources.hasAccountingPage(key) && !resetReports.has(item.id)
            && !(item.resultId && hiddenReports.has(item.resultId) && !positiveReports.has(item.resultId))) {
            // Eviction plus failed enrichment is not a new unknown report.
            // Preserve only this surviving occurrence's session metadata; any
            // current cached component or returned accounting page wins. Never
            // copy result usage, summary, activity, visibility or Stop proof.
            const report = item.workerSession ?? workerSessionReport(this.childSessionCosts.get(key)?.costUsd, this.childModels.get(key));
            const priorModel = report.model === undefined && !this.childModels.has(key) && prior.workerSession.model !== undefined;
            items[index] = { ...item, workerSession: { ...report,
              ...(priorModel ? { model: prior.workerSession.model, effort: prior.workerSession.effort } : {}),
              costUsd: report.costUsd == null && !this.childSessionCosts.has(key) ? prior.workerSession.costUsd : report.costUsd,
            } };
          }
          continue;
        }
        if (item.type !== "tool" || !item.childConversationId) continue;
        const prior = projection.get(item.id);
        const sameAssociation = prior?.type === "tool" && prior.childConversationId === item.childConversationId && prior.createdAt === item.createdAt;
        let candidate = item;
        if (sameAssociation) {
          // Explicit current denial governs the materialized row even when the
          // sparse candidate has no lines and its accounting cache was evicted.
          if (reconcile(prior).revoked) revokedRows.add(item.id);
          const key = attributionKey(id, item.childConversationId);
          if (coverage && this.provider.watchWorkerAssociations && !this.childTranscripts.has(key) && !coverage.workerSources.hasAccountingPage(key)) {
            // No accounting page arrived: retain this exact row's known
            // presentation, including during replacement. A returned source
            // page instead keeps its own visibility authority, even if its
            // deeper accounting later expires before banking a transcript.
            const accounted = this.accountedTask(id, item.childConversationId, prior);
            const exact = accounted && sameLauncherBinding(launcherBinding(item), accounted.binding);
            candidate = { ...item,
              ...(item.workerSession === undefined && prior.workerSession ? { workerSession: prior.workerSession } : {}),
              ...(exact && item.model === undefined && prior.model ? { model: prior.model } : {}),
              ...(exact && item.usage === undefined && prior.usage ? { usage: prior.usage } : {}),
              ...(exact && item.descendants === undefined && prior.descendants ? { descendants: prior.descendants } : {}),
            };
            this.carryLauncherAccounting(candidate, prior);
          }
        }
        const reconciled = reconcile(candidate);
        items[index] = reconciled.item;
        if (reconciled.revoked) revokedRows.add(item.id);
      }
    };
    // A conversation's price is the sum of every message's, and the client
    // folds it from the usage carriers it holds — so the newest page alone
    // would present a partial figure that grows as older pages load. Where
    // the provider exposes the complete transcript, every priced carrier
    // rides the first page: hidden, small, keyed by message id, and
    // idempotent when an older page later restates it. Priced only — an
    // agent that prices nothing (Claude Code) has a carrier per assistant
    // frame, and shipping those would grow the first page with the whole
    // conversation for a fold that has nothing to sum. A subagent's spend
    // lives on the row that launched it, so those rows ride too — the
    // attribution pass below gives them their child's aggregate like any
    // row on the page. They render, as an out-of-page background task
    // already does, and merge in place when their page loads.
    if (page.completeItems && !cursor) {
      const held = new Set(items.map(item => item.id));
      for (const item of page.completeItems) {
        if (held.has(item.id)) continue;
        const pricedCarrier = item.type === "assistant_message" && item.markdown === "" && item.usage?.costUsd !== undefined;
        const launcher = item.type === "tool" && item.childConversationId !== undefined;
        if (pricedCarrier || launcher) items.push(item);
      }
    }
    // A foreground run's row (a typed command's review, design D13) exists
    // only as a live row: the store keeps no record of it, and it is not
    // background work the provider lists. A page opening mid-command must
    // still see the run listed, so the row this process holds rides along;
    // the liveness rule below closes one no turn is running any more.
    if (!cursor) {
      const held = new Set(items.map(item => item.id));
      for (const existing of this.projection(id).filter(item => item.type === "background_task" && item.foreground === true)) {
        if (!held.has(existing.id)) items.push(existing);
      }
    }
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
        // A foreground run (a typed command's) is part of the turn that ran
        // it, not background work the provider lists: with no turn live, it
        // is over whatever its row last said.
        if (item.type === "background_task" && item.foreground && item.status === "running") {
          items[index] = { ...item, status: "stopped" };
        }
      }
    }
    // Live background work is held by the provider, not the transcript: a
    // reopened conversation gets its running tasks from the provider's own
    // list so the composer shows the state it is actually in (spec).
    // V2 supplies positive evidence, not an authoritative live-only list.
    // An omitted worker or failed read must never manufacture cancellation.
    const nativeLiveTasks = new Set<string>();
    const recoveredWorkerIds = new Set<string>();
    if (this.provider.reconcileBackgroundTasks) {
      let recovered: BackgroundTaskItem[];
      let recoverySources: WorkerRecoverySource[] = [];
      try {
        if (this.pumpPromise && !this.backgroundConnected) {
          await this.backgroundReady;
          if (!this.backgroundConnected) throw new Error("Background stream is disconnected");
        }
        recovered = await this.provider.reconcileBackgroundTasks(id, coverage ? { signal: coverage.signal, onSource: source => {
          // Capture before the shared recovery transport retires. These leases
          // guard inbox/live associations through this read's final handoff.
          const guard = coverage.workerSources.observe(source.workerSource);
          recoverySources.push({ ...source, workerSource: guard ?? source.workerSource });
        } } : undefined);
      }
      catch {
        recovered = [];
        // An unavailable read does not settle independently running work.
        if (this.provider.waitForEventStream) for (const known of this.projection(id).items()) {
          if (known.type === "background_task" && known.status === "running" && !known.foreground) nativeLiveTasks.add(known.id);
        }
      }
      coverage?.assertCurrent();
      coverage?.workerSources.assertCurrent();
      if (coverage && recovered.length && recoverySources.some(source => source.workerResultFallbacks.length === 0 && source.workerSource.isCurrent())) {
        // Inventory owns actual explicit report content. Relinquish only exact
        // transcript inferences it replaces; text/ownership/revert/other-worker
        // fences and every inventory lease remain required through admission.
        const textSource = page.workerSource?.withoutInferredOutcomes?.(recovered);
        if (textSource?.isCurrent()) {
          const guard = textSource.retain(coverage.signal);
          page = { ...page, workerSource: guard, isWorkerSourceCurrent: guard.isCurrent };
        }
      }
      if (options.workers) recovered = validatedWorkerDismissalSource(recovered) as BackgroundTaskItem[];
      for (const source of recoverySources) {
        for (const child of source.workerAssociationContradictions) revokedChildren.add(child);
        fallbackRelations.push(...source.workerResultFallbacks);
        for (const relation of source.workerResultFallbacks) positiveFallbacks.add(relation.fallback.id);
      }
      for (const task of recovered) recoveredWorkerIds.add(task.id);
      for (const task of recovered) if (task.resultId) positiveReports.add(task.resultId);
      if (this.provider.waitForEventStream) for (const task of recovered) if (task.status === "running" && !task.foreground) nativeLiveTasks.add(task.id);
      const { byId, supersedes } = indexRecoveredBackgroundTasks(recovered);
      const currentIds = options.workers ? new Set(items.map(item => item.id)) : undefined;
      const knownRows = options.workers ? [...items, ...this.projection(id).items()] : [...this.projection(id).items(), ...items];
      for (const known of knownRows) {
        if (known.type !== "background_task" || byId.has(known.id)) continue;
        if (supersedes(known) && !coverage?.changed(known.id)) {
          if (currentIds?.has(known.id) && workerSourceIsProtected(known)) {
            // A weak launcher/result match cannot erase a current protected
            // source row, even before the final non-weakening assertion runs.
            throw new WorkerEvidenceError("unavailable", "authoritative worker source was weakened without newer evidence");
          }
          stageHistoryRemoval(known.id);
          const index = items.findIndex(item => item.id === known.id);
          if (index >= 0) items.splice(index, 1);
          continue;
        }
        // Missing/failed recovery can withdraw retained cache observations, not
        // the current complete source's positive or nondismissible evidence.
        byId.set(known.id, known.status === "running" && !currentIds?.has(known.id) ? unverifyWorkerTask(known) : known);
      }
      for (const task of byId.values()) {
        const index = items.findIndex(item => item.id === task.id);
        if (index < 0) items.push(task); else items[index] = task;
      }
      for (const source of recoverySources) for (const relation of source.workerResultFallbacks) {
        if (!items.some(item => item.id === relation.fallback.id) && !items.some(item => workerRepresentsFallback(item, relation)
          && !revokedChildren.has(relation.childConversationId))) items.push(relation.fallback);
      }
    }
    const liveTasks = this.provider.reconcileBackgroundTasks ? null : await this.liveBackgroundTasks(id);
    if (liveTasks !== null) {
      if (options.workers) validatedWorkerDismissalSource([...items, ...liveTasks]);
      const live = new Set(liveTasks.map(task => task.id));
      for (const task of liveTasks) {
        if (!items.some(item => item.id === task.id)) items.push(task);
      }
      // A row the provider no longer lists as live has settled or died with
      // its process; a stale "running" row — in this page or already in the
      // projection — would offer a Stop that errors.
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]!;
        if (item.type === "background_task" && !item.foreground && item.status === "running" && !live.has(item.id)) items[index] = { ...item, status: "stopped" };
      }
      for (const existing of this.projection(id).items()) {
        if (existing.type === "background_task" && !existing.foreground && existing.status === "running" && !live.has(existing.id) && !items.some(item => item.id === existing.id)) {
          items.push({ ...existing, status: "stopped" });
        }
      }
    }
    // Pending wakeups live in the provider's session, never in the
    // transcript (spec: a reopened conversation replays no pending row): a
    // reader opening a conversation that is scheduled right now gets its
    // rows from the provider's list, so the composer shows the held state.
    const liveWakeups = await this.liveScheduledWakeups(id);
    for (const wakeup of liveWakeups) {
      const index = items.findIndex(item => item.id === wakeup.id);
      if (index < 0) items.push(wakeup); else items[index] = wakeup;
    }
    // With no session holding them, the crons the agent rebuilds when the
    // conversation runs again are listed as paused (D11). The conversation
    // stays idle: nothing is held. A row this page already settled keeps
    // its settled state.
    if (liveWakeups.length === 0 && this.provider.listPausedWakeups) {
      try {
        for (const paused of await this.provider.listPausedWakeups(id)) {
          const index = items.findIndex(item => item.id === paused.id);
          const current = index >= 0 ? items[index] : this.projection(id).find(item => item.id === paused.id);
          if (current?.type === "scheduled_wakeup" && (current.status === "cancelled" || current.status === "fired")) {
            if (index < 0) items.push(current);
            continue;
          }
          if (index < 0) items.push(paused); else items[index] = paused;
        }
      } catch {
        // No paused list: the conversation reads as it would without one.
      }
    }
    // A subagent's attribution reached the parent as a live upsert, and the
    // parent's own store has no memory of it — so a reopened conversation
    // would show costs that simply vanished. The child's stored messages do
    // still carry them, so a tally not yet squared against that store is
    // rebuilt from there, once, and banked. The gate is the completeness mark,
    // not mere map presence: a tally recreated by live events after an
    // eviction exists but holds only the post-eviction messages, and skipping
    // the read for it would under-report the child forever. Paid once per
    // child rather than per open (the aggregate is still computed here, not
    // fetched per render) — and in parallel, so a fan-out costs one round trip
    // rather than one each.
    coverage?.assertCurrent();
    if (page.isWorkerSourceCurrent && !page.isWorkerSourceCurrent()) throw new HistoryReadChangedError();
    coverage?.workerSources.assertCurrent();
    for (const evidence of coverage?.cachedAssociations ?? []) {
      this.revokeCachedAssociations(evidence);
      if (evidence.parentId === id) for (const child of evidence.childIds) revokedChildren.add(child);
    }
    reconcileWorkerSource();
    for (const child of revokedChildren) this.revokeChildAttribution(id, child);
    for (let index = 0; index < items.length; index++) {
      const item = items[index]!;
      if (item.type === "tool") items[index] = retainToolAssociation(item, sourceProjection);
    }
    const carrierIds = cursor ? undefined : new Set(items.map(item => item.id));
    let restoredCarrier = false;
    const incompleteToolCohorts = new Set<string>();
    const cohortMembers = new Map<string, Set<string>>();
    const rememberCohort = (child: string, row: string) => {
      const members = cohortMembers.get(child) ?? new Set<string>();
      members.add(row); cohortMembers.set(child, members);
    };
    for (const [row, child] of nativeToolChildren) if (child) rememberCohort(child, row);
    for (const known of sourceProjection.items()) if (known.type === "tool" && known.childConversationId) rememberCohort(known.childConversationId, known.id);
    const allocationPublications = new Map<string, AllocationPublication>();
    const accountingItems = page.completeItems?.map(item => {
      const retained = item.type === "tool" ? retainToolAssociation(item, sourceProjection) : item;
      // Optional enrichment stripped this exact launcher's child before the
      // first-page carrier pass. Admit its restored current-history copy, not
      // an arbitrary retained row, after source and contradiction validation.
      if (carrierIds && retained !== item && !carrierIds.has(retained.id)) {
        items.push(retained);
        carrierIds.add(retained.id);
        restoredCarrier = true;
      }
      if (item.type === "tool" && !item.childConversationId && coverage?.changed(item.id) && this.provider.watchWorkerAssociations) {
        const current = sourceProjection.get(item.id);
        // The live row owns its presentation, but its exact association still
        // occupies a place in complete attribution order. This copy is only
        // ordering input: never reinsert it or revoke a mismatching live row.
        if (current?.type === "tool" && current.name === "subagent" && item.status === "completed"
          && current.status === item.status && sameToolAssociation(item, current)) return { ...item, childConversationId: current.childConversationId };
      }
      if (item.type === "tool" && retained.type === "tool" && !retained.childConversationId && this.provider.watchWorkerAssociations) {
        const current = sourceProjection.get(item.id);
        // A rejected association is not an ordering member, but its absence
        // must not redistribute the whole cached child tally onto a sibling.
        const nativeChild = nativeToolChildren.get(item.id);
        if (nativeChild) incompleteToolCohorts.add(nativeChild);
        if (current?.type === "tool" && current.childConversationId) incompleteToolCohorts.add(current.childConversationId);
      }
      return retained;
    });
    if (accountingItems && this.provider.watchWorkerAssociations) {
      for (const known of sourceProjection.items()) if (known.type === "tool" && known.name === "subagent"
        && known.childConversationId && nativeToolChildren.get(known.id) !== known.childConversationId) incompleteToolCohorts.add(known.childConversationId);
    }
    if (restoredCarrier) items.sort((left, right) => left.createdAt - right.createdAt);
    await this.attributeLaunchers(id, items, accountingItems, coverage?.signal, page.workerSource ? coverage?.workerSources : undefined, coverage?.refreshAttribution, {
      incomplete: incompleteToolCohorts,
      observe: (child, owner, rows, incomplete, proof) => allocationPublications.set(child, { owner, revision: owner.allocationRevision, rows, incomplete, proof }),
      matchesRetained: (child, rows) => {
        const projected = sourceProjection.filter(item => item.type === "tool" && item.childConversationId === child)
          .flatMap(item => item.type === "tool" ? [this.accountedTask(id, child, item)] : []);
        // A parent reconstruction can know these exact launchers before this
        // child's own timeline has ever been projected. Reuse that same cache.
        const cached = parentId
          ? this.childTranscripts.get(attributionKey(parentId, id))?.launchers.filter(launcher => launcher.conversationId === child).map(launcher => this.accountedTask(id, child, launcher)) ?? [] : [];
        const prior = projected.length >= cached.length ? projected : cached;
        return prior.length === rows.length && rows.every(row => {
          const known = prior.find(candidate => candidate?.id === row.id);
          return row.binding !== undefined && sameLauncherBinding(row.binding, known?.binding);
        });
      },
      retain: item => {
        if (!coverage || coverage.changed(item.id) || !item.childConversationId
          || coverage.workerSources.hasAccountingPage(attributionKey(id, item.childConversationId))) return item;
        const prior = sourceProjection.get(item.id);
        const accounted = prior?.type === "tool" ? this.accountedTask(id, item.childConversationId, prior) : undefined;
        if (!accounted || !sameLauncherBinding(launcherBinding(item), accounted.binding)) {
          // A cached ancestor can know the receipt before this timeline opens.
          // Fold its immutable accounted cohort, not its live-updated launchers.
          const cached = parentId ? this.childTranscripts.get(attributionKey(parentId, id))?.launchers.filter(launcher => launcher.conversationId === item.childConversationId) : undefined;
          const tasks = cached?.map(launcher => this.accountedTask(id, item.childConversationId!, launcher));
          const known = tasks?.find(task => task?.id === item.id);
          if (!known || !tasks?.every((task): task is TaskRow => task !== undefined) || !sameLauncherBinding(launcherBinding(item), known.binding)) return item;
          const attribution = this.rowAttributions(id, item.childConversationId, tasks)[tasks.indexOf(known)];
          const retained = { ...item, ...attribution };
          this.rememberLauncherAccounting(id, item.childConversationId, retained, known);
          return retained;
        }
        if (prior?.type !== "tool" || item.status !== "completed" || prior.status !== item.status
          || prior.childConversationId !== item.childConversationId || !sameToolAssociation(item, prior)) return item;
        // Only this exact surviving row can keep known presentation. A current
        // accounting page or live update keeps its independent authority.
        const retained = { ...item,
          ...(item.workerSession === undefined && prior.workerSession ? { workerSession: prior.workerSession } : {}),
          ...(item.usage === undefined && prior.usage ? { usage: prior.usage } : {}),
          ...(item.model === undefined && prior.model ? { model: prior.model } : {}),
          ...(item.descendants === undefined && prior.descendants ? { descendants: prior.descendants } : {}),
        };
        this.carryLauncherAccounting(retained, prior);
        return retained;
      },
    });
    coverage?.assertCurrent();
    // OpenCode 1.18 never emits `question.v2.asked`, so a pending question is
    // invisible to the event stream and only the provider knows about it.
    // Asking here is what makes an open question answerable at all. A failed
    // list degrades the snapshot (the next refresh republishes) but must not
    // rewrite the published set — that would erase live questions.
    let questionsReconciled = false;
    let commitQuestionTracking: (() => void) | undefined;
    let reconcileQuestionFreshness: (() => void) | undefined;
    let questionTrackingCurrent: (() => boolean) | undefined;
    if (this.provider.listQuestions) try {
      questionRead.parentId = session.parentId;
      questionRead.scope = await this.questionReadScope(id, session.parentId);
      coverage?.assertCurrent();
      questionRead.age = ++this.questionReadClock;
      if (!this.disposed) this.questionReads.add(questionRead);
      const pendingNow = await this.pendingQuestions(id, false);
      coverage?.assertCurrent();
      for (const pending of pendingNow) {
        if (items.some(item => item.id === pending.id)) continue;
        items.push(pending);
      }
      {
        questionsReconciled = true;
        // A successful read is authoritative: it carries this conversation's
        // own questions and its children's, so one absent from it was
        // answered elsewhere while its only live signal was missed.
        const live = new Set(pendingNow.map(item => item.id));
        const projection = this.projection(id);
        for (const existing of projection.items()) {
          if (existing.type !== "question" || existing.status !== "pending" || live.has(existing.id) || coverage?.changed(existing.id)) continue;
          // Announced after the read began: the snapshot predates it, so it
          // stays on the timeline and its notification stays pending.
          if ((this.announced.get(existing.id)?.tick ?? 0) > questionTick) { if (!items.some(item => item.id === existing.id)) items.push(existing); continue; }
          stageHistoryRemoval(existing.id, () => {
            // A child's newer announcement can precede its awaited parent
            // mirror without changing this row's identity. Retire only the
            // announcement covered by this read, not the newer notification.
            if ((this.announced.get(existing.id)?.tick ?? 0) > questionTick) return;
            this.questionCreatedAt.delete(existing.id);
            this.resolveAnnounced(existing.id);
          });
        }
      }
      const tracking = new Map<string, Set<string>>([[id, new Set(pendingNow.map(item => item.id))]]);
      if (pendingNow.length > 0) {
        // A recovered child question is ALSO recorded under its owning child:
        // the child's next question-tool update computes removals against
        // that set, and the pump mirrors them into this conversation. Keyed
        // only under the parent, an answer given elsewhere left the parent
        // offering a question OpenCode no longer had — 409 until reload.
        // The sweep is child-inclusive, but each derived subset covers only
        // that child's own questions, not the child's children.
        const byChild = new Map<string, Set<string>>();
        for (const item of pendingNow) {
          if (item.type !== "question") continue;
          const owner = item.conversationId ?? id;
          if (owner === id) continue;
          const set = byChild.get(owner) ?? new Set<string>();
          set.add(item.id);
          byChild.set(owner, set);
        }
        for (const [owner, ids] of byChild) tracking.set(owner, ids);
      }
      const questionAuthority = (item: QuestionRequest): QuestionSetObservation | undefined => {
        return this.questionAuthority(questionRead, item);
      };
      const refreshedQuestion = (item: QuestionRequest) => questionAuthority(item) !== undefined;
      const ownsQuestion = (item: QuestionRequest) => questionAuthority(item)?.ids.has(item.id) ?? true;
      const retainCurrentQuestion = (item: QuestionRequest) => (refreshedQuestion(item) && ownsQuestion(item))
        || ((this.announced.get(item.id)?.tick ?? 0) > questionTick
          && historyRemovals.get(item.id)?.expected !== item);
      reconcileQuestionFreshness = () => {
        // An older source may have committed rows after our absence sweep.
        // Reread rather than granting its completion newer source authority.
        if (questionRead.conflicted) throw new HistoryReadChangedError();
        // A tool refresh owns a complete newer set, including absence. An old
        // read must neither resurrect its unprojected rows nor retire current
        // ones. Carry current rows for replacement/seed as well as recovery.
        for (let index = items.length - 1; index >= 0; index--) {
          const item = items[index]!;
          if (item.type === "question" && !ownsQuestion(item)) items.splice(index, 1);
        }
        for (const [itemId, removal] of historyRemovals) {
          // An announcement can precede its awaited parent mirror. Its tick
          // protects notification/timestamp retirement, not the old parent
          // row already covered by this read's absence. A newer set retaining
          // this question revokes removal; row replacement has its own fence.
          if (removal.expected?.type === "question" && refreshedQuestion(removal.expected) && ownsQuestion(removal.expected)) historyRemovals.delete(itemId);
        }
        for (const item of projection.items()) {
          if (item.type !== "question") continue;
          if (!ownsQuestion(item) && !retainCurrentQuestion(item)) {
            // Scoped newer absence also governs a row an overlapping older
            // publication inserted after our initial removal sweep.
            stageHistoryRemoval(item.id, () => {
              if ((this.announced.get(item.id)?.tick ?? 0) > questionTick) return;
              this.questionCreatedAt.delete(item.id);
              this.resolveAnnounced(item.id);
            });
            continue;
          }
          if (!retainCurrentQuestion(item)) continue;
          const index = items.findIndex(candidate => candidate.id === item.id);
          if (index < 0) items.push(item);
          else items[index] = item;
        }
        // Hooks may invalidate admission, but cannot admit another stale set.
        const revision = questionRead.revision;
        questionTrackingCurrent = () => questionRead.revision === revision;
      };
      commitQuestionTracking = () => {
        // Tracking is removal authority for the next tool refresh. Publish it
        // only with these rows, retaining later native announcements under the
        // same questionTick fence as removals. An unrelated permission update
        // must not prevent newly recovered questions from being tracked.
        for (const item of projection.items()) {
          if (item.type !== "question" || item.status !== "pending"
            || (this.announced.get(item.id)?.tick ?? 0) <= questionTick) continue;
          tracking.get(id)!.add(item.id);
          const owner = item.conversationId ?? id;
          if (owner !== id) {
            const ids = tracking.get(owner) ?? new Set<string>();
            ids.add(item.id);
            tracking.set(owner, ids);
          }
        }
        for (const item of pendingNow) {
          if (item.type !== "question" || !ownsQuestion(item) || this.questionCreatedAt.has(item.id)) continue;
          const current = projection.get(item.id);
          if (current?.type === "question" && current.status === "pending") this.questionCreatedAt.set(item.id, current.createdAt);
        }
        for (const [owner, ids] of tracking) {
          // A concurrent parent/child refresh or history owns its newer set.
          const newer = questionRead.sets.has(owner);
          const pending = new Set([...ids].filter(itemId => {
            const item = projection.get(itemId);
            return item?.type === "question" && item.status === "pending"
              && (ownsQuestion(item) || (this.announced.get(itemId)?.tick ?? 0) > questionTick);
          }));
          if (newer) {
            for (const itemId of this.publishedQuestions.get(owner) ?? []) {
              const known = projection.get(itemId) ?? pendingNow.find(item => item.id === itemId) ?? historyRemovals.get(itemId)?.expected;
              if (known?.type === "question" && !ownsQuestion(known) && (this.announced.get(itemId)?.tick ?? 0) <= questionTick) continue;
              pending.add(itemId);
            }
          }
          const children = owner === id;
          const observed = questionRead.sets.get(owner);
          // A newer owner-only subset cannot renew older child-inclusive
          // evidence. Preserve ages independently for the two coverage scopes.
          const age = Math.max(questionRead.age, observed?.children?.age ?? 0, children ? 0 : observed?.own?.age ?? 0);
          this.publishQuestionSet(owner, pending, age, questionRead, children);
        }
      };
    } catch { /* unknown, not empty */ }
    // A permission is otherwise knowable only from a live event: it has no
    // history representation, so one raised while the pump was restarting
    // would strand its turn with nothing on screen. Reconciling here — the
    // moment a user is actually looking at the conversation — makes it
    // answerable. Ids match the event path's, so a request that also arrives
    // live converges on one entry instead of rendering twice.
    try {
      const permissionTick = this.interactionClock;
      const pendingNow = await this.pendingPermissions(id);
      coverage?.assertCurrent();
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
          if (existing.type !== "permission" || existing.status !== "pending" || live.has(existing.id) || coverage?.changed(existing.id)) continue;
          if ((this.announced.get(existing.id)?.tick ?? 0) > permissionTick) { if (!items.some(item => item.id === existing.id)) items.push(existing); continue; }
          stageHistoryRemoval(existing.id, () => {
            // A child can announce this request again before its async parent
            // mirror replaces our row. Recheck the read's interaction fence
            // before retiring other copies or resolving that newer announcement.
            if ((this.announced.get(existing.id)?.tick ?? 0) > permissionTick) return;
            this.retireRecoveredPermission(existing, id);
          });
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
    coverage?.assertCurrent();
    const visibility = coverage && this.provider.getHistoryRevertBoundary && this.agent().capabilities.includes("reversible-history") ? page.revertVisibility : undefined;
    const currentBoundary = visibility ? await this.provider.getHistoryRevertBoundary!(id, { signal: coverage!.signal, expectedBoundary: visibility.boundaryId }) : undefined;
    const reversibleHistory = visibility
      ? visibility.state
      : await this.readReversibleHistoryState(id);
    coverage?.assertCurrent();
    if (coverage && (coverage.dirty() || visibility && visibility.boundaryId !== currentBoundary)) {
      // The page and boundary no longer describe one view. Do not publish its
      // rows or exclusions; reread within the existing bounded stream owner.
      throw new HistoryReadChangedError();
    }
    if (page.isWorkerSourceCurrent && !page.isWorkerSourceCurrent()) throw new HistoryReadChangedError();
    coverage?.workerSources.assertCurrent();
    const projection = this.projection(id);
    const reconciledVisibility = projection.reconciledHistoryVisibility;
    const previousReversibleHistory = reconciledVisibility?.state ?? this.reversibleHistory.get(id);
    const visibilityChanged = visibility && (reconciledVisibility?.boundaryId !== undefined
      ? reconciledVisibility.boundaryId !== visibility.boundaryId
      : previousReversibleHistory && reversibleHistory && (previousReversibleHistory.staged || reversibleHistory.staged)
        && !sameReversibleHistory(previousReversibleHistory, reversibleHistory));
    if (coverage && visibilityChanged && page.completeItems) {
      // A restore may make rows outside the requested page current again.
      // Complete provider coverage, not this page, supplies those rows.
      const held = new Set(items.map(item => item.id));
      for (const item of page.completeItems) if (!held.has(item.id)) items.push(this.correlateSteerMessage(id, item, coverage.steerCorrelations));
    }
    // A newer native row can replace its correlated history copy in the
    // change fence. Reapply only the read-owned native-ID correlation, keeping
    // that row's newer contents even after its old cache/projection departed.
    if (coverage) items.splice(0, items.length, ...coverage.merge(items).filter(item => {
      const removal = historyRemovals.get(item.id);
      return !removal || projection.get(item.id) !== removal.expected;
    }).map(item => this.correlateSteerMessage(id, item, coverage.steerCorrelations)));
    reconcileQuestionFreshness?.();
    // The live-task snapshot above was taken before several awaits; a task
    // that settled in the projection meanwhile keeps its settled row.
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      if (item.type !== "background_task" || item.status !== "running") continue;
      const current = projection.find(candidate => candidate.id === item.id);
      // A covered current occurrence can withdraw a history-only outcome.
      // Retained completion is not a parent report, and sparse upsert merging
      // must not restore it after the provider withholds that exact inference.
      const source = page.workerSource && page.completeItems?.find(candidate => candidate.id === item.id);
      if (coverage && !coverage.changed(item.id) && replacesHistoryOnlyOutcome(current, source)) {
        revokedRows.add(item.id);
        continue;
      }
      if (current?.type === "background_task" && current.status !== "running" && (!options.workers || coverage?.changed(item.id))) items[index] = current;
    }
    // Likewise the wakeup snapshot: a wakeup that fired or was cancelled
    // during those awaits keeps that row, not the pending or paused copy read
    // before — the copy would offer a Cancel for a wakeup that is gone. Only
    // those two are final for an id; paused and lost are not (a resume turns
    // a paused cron pending again), so a projection row in either state may
    // be the older one and the snapshot's read stands.
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      if (item.type !== "scheduled_wakeup" || (item.status !== "pending" && item.status !== "paused")) continue;
      const current = projection.find(candidate => candidate.id === item.id);
      if (current?.type === "scheduled_wakeup" && (current.status === "fired" || current.status === "cancelled")) items[index] = current;
    }
    if (this.provider.waitForEventStream) {
      reconcileWorkerSource();
      // A concurrent projection publication can carry pre-counterproof lines
      // through the live merge. Current scoped denial also governs that copy.
      reconcileRetainedAccounting(projection);
      let removed = false;
      const visible = new Set(page.completeItems?.map(item => item.id));
      // The revalidated CURRENT marker is direct exclusion authority, even
      // for a late update of that same discarded row. Earlier-marker evidence
      // survives a commit only against complete coverage and the live fence.
      const excluded = new Set(visibility?.excludedItemIds);
      if (coverage && page.workerOriginCoverage) for (const known of projection.items()) {
        // Only previously observed exact native origins can disappear. A
        // successful current inbox/live recovery has its own positive source;
        // unresolved running work is never settled by transcript absence.
        if (known.type === "background_task" && known.status !== "running" && !known.foreground
          && !recoveredWorkerIds.has(known.id) && !coverage.changed(known.id)
          && projection.workerOriginsAbsent(known, page.workerOriginCoverage)) excluded.add(known.id);
        if (known.type === "notice" && !positiveFallbacks.has(known.id) && !coverage.changed(known.id)
          && projection.workerFallbackOriginAbsent(known, page.workerOriginCoverage)) excluded.add(known.id);
      }
      if (visibility && page.completeItems) for (const itemId of coverage!.revertExclusions) {
        if (!visible.has(itemId) && !coverage!.changed(itemId)) excluded.add(itemId);
      }
      // Only the separately recovered live inventory can override a task-row
      // exclusion. Its hidden user/tool transcript remains excluded as before.
      for (const itemId of nativeLiveTasks) excluded.delete(itemId);
      // Recovery of live-only rows above can carry an old task back into the
      // page. Only exact exclusions govern it, not absence from the page.
      for (let index = items.length - 1; index >= 0; index--) if (excluded.has(items[index]!.id)) items.splice(index, 1);
      for (const itemId of excluded) {
        if (!projection.has(itemId)) continue;
        // Current exclusion authority retires this row even when an earlier
        // decision staged its old incarnation before a native reinsertion.
        removed = true;
        stageHistoryRemoval(itemId);
      }
      // A visible native result can change presentation when ownership
      // enrichment recovers. Neither page absence nor a notice-shaped id is
      // removal authority: require the provider's exact fallback relation and
      // an already verified worker for the same result AND child representing
      // the current report content. Retained settled workers may supply that
      // representation during a lookup outage, but not suppress a newer report.
      for (const relation of fallbackRelations) {
        const { fallback } = relation;
        if (coverage?.changed(fallback.id) || !items.some(item => workerRepresentsFallback(item, relation))) continue;
        const index = items.findIndex(item => item.id === fallback.id && projection.matchesWorkerFallback(item, relation));
        if (index >= 0) items.splice(index, 1);
        const current = projection.get(fallback.id);
        if (current && projection.matchesWorkerFallback(current, relation)) stageHistoryRemoval(fallback.id);
      }
      const allocationCommits: Array<{ owner: AttributionOwner; floor: number | undefined; occurrences?: string }> = [];
      if (coverage && !cursor && accountingItems) for (const [child, publication] of allocationPublications) {
        const key = attributionKey(id, child);
        if (this.attributionEpochs.get(key) !== publication.owner || publication.owner.allocationRevision !== publication.revision) continue;
        const sources = new Map(accountingItems.filter((item): item is ToolItem => item.type === "tool" && item.childConversationId === child).map(item => [item.id, item]));
        const current = items.filter((item): item is ToolItem => item.type === "tool" && item.childConversationId === child);
        const matches = (item: ToolItem) => {
          const source = sources.get(item.id);
          return source !== undefined && item.status === source.status && sameToolAssociation(item, source);
        };
        const proof = publication.proof && !revokedChildren.has(child) && current.length === publication.rows.length
          && current.every(matches) && projection.filter(item => item.type === "tool" && item.childConversationId === child && !excluded.has(item.id)).every(item => item.type === "tool" && matches(item));
        const floor = Math.max(publication.owner.allocationFloor ?? 0, publication.rows.length, cohortMembers.get(child)?.size ?? 0, current.length);
        if (publication.incomplete || publication.proof && !proof) {
          const known = sourceProjection.filter(item => item.type === "tool" && item.childConversationId === child)
            .flatMap(item => item.type === "tool" ? [this.accountedTask(id, child, item)] : []).filter((task): task is TaskRow => task !== undefined);
          // Negative occurrence evidence has exactly the existing marker's
          // bounded ownership/lifetime. Never replace it with a restatement.
          const occurrences = publication.owner.allocationOccurrences ?? (publication.owner.allocationFloor === undefined && known.length === floor
            ? occurrenceSignature(known) : undefined);
          allocationCommits.push({ owner: publication.owner, floor, occurrences });
        }
        else if (proof) {
          // Reconstruction can decorate the old projection before this parent
          // cohort publishes. Reapply current accounting only to exact rows;
          // never replace newer native presentation or an unmatched occurrence.
          const values = this.rowAttributions(id, child, publication.rows, coverage.workerSources);
          const byId = new Map(publication.rows.map((row, index) => [row.id, values[index]!]));
          for (let index = 0; index < items.length; index++) {
            const item = items[index]!;
            if (item.type === "tool" && item.childConversationId === child && matches(item)) {
              const { usage: _usage, model: _model, descendants: _descendants, ...presentation } = item;
              const repriced = { ...presentation, ...byId.get(item.id) };
              this.rememberLauncherAccounting(id, child, repriced, publication.rows.find(row => row.id === item.id)!);
              const prior = projection.get(item.id);
              if (prior?.type === "tool" && withdraws(prior, repriced)) revokedRows.add(item.id);
              items[index] = repriced;
            }
          }
          allocationCommits.push({ owner: publication.owner, floor: undefined });
        }
      }
      const replace = coverage?.replacement && (reversibleHistory && !sameReversibleHistory(previousReversibleHistory, reversibleHistory)
        || !sameConversationItems(projection.items(), items));
      // Nested candidates are permissions of this read, not successful child
      // publications. Check the final materialized graph before changing any
      // projection references; commit only with the enclosing publication.
      if (coverage && !cursor) for (const publication of coverage.workerSources.nestedPublications.values()) {
        if (!publication.proven || !this.nestedAllocationCurrent(publication, coverage.workerSources)) continue;
        const lines = items.flatMap(item => item.type === "tool" ? item.descendants ?? [] : []).filter(line => {
          const proof = this.descendantBindings.get(line);
          return proof?.sessionId === publication.sessionId && line.conversationId === publication.childId;
        });
        const launchers = this.childTranscripts.get(publication.parentKey)!.launchers.filter(launcher => launcher.conversationId === publication.childId);
        if (lines.length !== launchers.length || !launchers.every(launcher => lines.filter(line => {
          const proof = this.descendantBindings.get(line);
          const parent = publication.parents.find(parent => parent.id === line.parentId);
          return line.id === launcher.id && proof !== undefined && proof.parentSessionId === publication.parentId
            && proof.promptId === this.childTranscripts.get(publication.parentKey)!.prompts[launcher.promptIndex]?.id
            && parent?.binding !== undefined && sameLauncherBinding(proof.parent, parent.binding)
            && sameLauncherBinding(proof.launcher, launcher.binding);
        }).length === 1)) continue;
        allocationCommits.push({ owner: publication.owner, floor: undefined });
      }
      // Accepted reconciliation can withdraw attribution even after its cached
      // transcript was evicted. Use replacement semantics: an ordinary sparse
      // upsert would resurrect the receipt that the accounting guard denied.
      if (coverage) for (const item of items) if (item.type === "tool" && item.childConversationId && !coverage.changed(item.id)) {
        const current = projection.get(item.id);
        if (current?.type === "tool" && withdraws(current, item)) revokedRows.add(item.id);
      }
      // Ordinary upserts intentionally preserve terminal/sparse data. Exact
      // source revocation must replace it instead of merging hidden fields back.
      const recoveryUpdates: Array<Extract<NormalizedProviderUpdate, { kind: "upsert" | "remove" }>> = [];
      for (const [itemId, removal] of historyRemovals) {
        if (projection.get(itemId) === removal.expected) recoveryUpdates.push({ kind: "remove", itemId });
      }
      if (!replace) for (const itemId of new Set([...resetReports, ...revokedRows])) if (projection.has(itemId)) recoveryUpdates.push({ kind: "remove", itemId });
      if (page.workerOriginCoverage) projection.rememberWorkerOrigins(items, page.workerOriginCoverage, coverage?.changed);
      projection.rememberWorkerFallbacks(items, fallbackRelations, coverage?.changed, page.workerOriginCoverage);
      workerStrength?.(items);
      if (replace) {
        // Worker retention, exact exclusions and result supersession above
        // apply equally to replacement. Ordinary transcript rows get no such
        // retention. Commit only after the covered read's final validation.
        projection.replace(items, recoveryUpdates.flatMap(update => update.kind === "remove" ? [update.itemId] : []), () => {
          coverage?.assertCurrent(); coverage?.workerSources.assertCurrent();
          return !this.disposed && this.projections.get(id) === projection && (questionTrackingCurrent?.() ?? true);
        });
        // Replacement preparation/admission may fail. Do not discard buffered
        // native events until the complete replacement has actually committed.
        this.eventCoalescer?.discard(id);
      } else {
        // Recovery is also for clients already listening when V2 reconnects.
        // Publish recovered values, not just a silent seed of the next snapshot.
        for (const item of items) {
          const current = projection.get(item.id);
          // Equal JSON can carry newer native execution evidence. Stage that
          // replacement in the same validated recovery batch; recover's public
          // equality suppresses a symbol-only frame while retaining the row.
          const execution = (item as typeof item & OpenCodeExecutionIdentity)[OPENCODE_EXECUTION_LIVE];
          const executionChanged = execution !== undefined
            && execution !== (current as (ConversationItem & OpenCodeExecutionIdentity) | undefined)?.[OPENCODE_EXECUTION_LIVE];
          const turn = (item as ConversationItem & ClaudeTextIdentity)[CLAUDE_TURN];
          const turnChanged = turn !== undefined
            && turn.completed !== (current as (ConversationItem & ClaudeTextIdentity) | undefined)?.[CLAUDE_TURN]?.completed;
          if (!current || !sameConversationItems([current], [item]) || executionChanged || turnChanged || revokedRows.has(item.id) || resetReports.has(item.id)) recoveryUpdates.push({ kind: "upsert", item });
          else if (current.type === "tool" && item.type === "tool" && coverage?.projection === projection && !coverage.changed(item.id)) {
            this.refreshEquivalentDescendantBindings(projection, current, item);
          }
        }
        if (!projection.recover(recoveryUpdates, () => {
          coverage?.assertCurrent(); coverage?.workerSources.assertCurrent();
          return !this.disposed && this.projections.get(id) === projection && (questionTrackingCurrent?.() ?? true);
        }, removed || !!visibilityChanged)) throw new HistoryReadChangedError();
      }
      // Publication and eligibility share the covering read's final fence.
      // Session lookups and child usage/model frames never clear this marker.
      for (const commit of allocationCommits) {
        commit.owner.allocationFloor = commit.floor;
        commit.owner.allocationOccurrences = commit.floor === undefined ? undefined : commit.occurrences;
        commit.owner.generationOnly = false;
        commit.owner.allocationRevision++;
      }
      if (reversibleHistory) {
        projection.reconciledHistoryVisibility = { state: reversibleHistory, ...(visibility ? { boundaryId: visibility.boundaryId } : {}) };
        this.rememberReversibleHistory(id, reversibleHistory);
      }
    } else {
      workerStrength?.(items);
      // Preserve legacy snapshot seeding (no incremental upsert fan-out).
      // Complete its fallible preparation before publishing retired rows.
      projection.seed(items);
      projection.recover([...historyRemovals].filter(([itemId, removal]) => projection.get(itemId) === removal.expected)
        .map(([itemId]) => ({ kind: "remove" as const, itemId })));
    }
    for (const [itemId, removal] of historyRemovals) if (!projection.has(itemId)) removal.retired?.();
    commitQuestionTracking?.();
    for (let index = 0; index < items.length; index++) {
      const item = items[index]!;
      this.syncRecoveredPermission(item);
      // Another read may have corrected the shared order while this read
      // awaited parentage. Return the same canonical metadata as the guard.
      if (item.type === "permission") items[index] = projection.get(item.id) ?? item;
      // A separately normalized transcript may still hold a live token for a
      // row whose ordered result we already saw. Return the same terminal
      // evidence as the projection, without restoring unrelated sparse fields.
      else items[index] = preserveClaudeTurn(projection.get(item.id), item);
    }
    if (this.provider.reconcileBackgroundTasks) this.syncBackgroundState(id);
    // A reopened conversation whose agent still holds live work is in the
    // background state, not idle: the list and the status must agree.
    if (items.some(item => item.type === "background_task" && !item.foreground && item.status === "running") && !isLiveConversationStatus(projection.status) && projection.status !== "background") {
      projection.statusUpdate("background");
    } else if (items.some(item => item.type === "scheduled_wakeup" && item.status === "pending") && !isLiveConversationStatus(projection.status) && projection.status !== "background" && projection.status !== "scheduled") {
      // Likewise a session held for its wakeups is scheduled, not idle.
      projection.statusUpdate("scheduled");
    }
    return {
      conversation: projection.withVisualStatus({ ...(coverage?.conversation() ?? this.summary(session, projection.status)), status: projection.status }),
      configuration: coverage ? this.configurations.get(id) ?? configuration : configuration,
      generation: this.generation,
      // Keep final covered-read merge through cursor capture await-free.
      // Covered native reads merge every projected change through the final
      // synchronous handoff above. Their snapshot already contains recovery
      // publications, including rows larger than the replay ring. Starting
      // before those publications can force another full read on every event.
      // Legacy reads have no change fence and still need the earlier cursor.
      cursor: coverage ? projection.replay.latestCursor() : replayCursor,
      items: snapshotClaudeTurns(items),
      // A client joining or reloading mid-run gets the same held queue a
      // client that watched it build presents.
      queued: this.queuedMessages(id),
      ...(reversibleHistory ? { reversibleHistory } : {}),
      olderCursor: page.nextCursor ? encodeHistoryCursor({ provider: page.nextCursor }) : undefined,
      ...(historyStart ? { historyStart } : {}),
    };
  }

  async subscribe(id: string, options: { cursor?: string; signal?: AbortSignal } = {}): Promise<{
    snapshot: ConversationSnapshot;
    events: ReplaySubscription;
  }> {
    const session = await this.requireSession(id);
    const projection = this.projection(id);
    const configuration = await this.configuration(id);
    const reversibleHistory = await this.readReversibleHistoryState(id);
    const handoff = projection.replay.handoff(cursor => {
      const currentReversibleHistory = this.reversibleHistory.get(id) ?? reversibleHistory;
      return {
        conversation: this.summary(session, projection.status),
        configuration,
        generation: this.generation,
        cursor,
        items: snapshotClaudeTurns(projection.items()),
        queued: this.queuedMessages(id),
        ...(currentReversibleHistory ? { reversibleHistory: currentReversibleHistory } : {}),
      };
    }, options.cursor, options.signal);
    return { snapshot: handoff.snapshot, events: handoff.subscription };
  }

  subscribeInventory(signal?: AbortSignal): ConversationInventorySubscription {
    return this.inventory.subscribe(signal);
  }

  /**
   * This agent's slice of the workspace activity summary: whether any
   * conversation has a turn in flight or live background work, and whether
   * any permission request or question awaits the user. Read from the
   * adapter-level records, never from the provider, so it is cheap enough to
   * answer on every change.
   */
  activity(): ChatActivity {
    return { working: this.liveTurns.size > 0 || this.backgroundWork.size > 0, awaiting: this.pendingInteractions.size > 0, unresolved: this.unresolvedBackgroundWork.size > 0 };
  }

  pendingNotifications() { return this.notifications.pendingSnapshot(); }

  // Deduplicated at the source: a second conversation starting while one
  // already runs does not change the summary.
  private activityMayHaveChanged(): void {
    const next = this.activity();
    if (next.working === this.lastActivity.working && next.awaiting === this.lastActivity.awaiting && next.unresolved === this.lastActivity.unresolved) return;
    this.lastActivity = next;
    this.onActivityChange?.();
  }

  private trackInteraction(conversationId: string, itemId: string, pending: boolean): void {
    const ids = this.pendingInteractions.get(conversationId);
    if (pending) {
      if (ids) ids.add(itemId);
      else this.pendingInteractions.set(conversationId, new Set([itemId]));
    } else if (ids) {
      ids.delete(itemId);
      if (ids.size === 0) this.pendingInteractions.delete(conversationId);
    }
    this.activityMayHaveChanged();
  }

  // Also reached when a timeline is rewritten (undo, redo, revert, restore).
  // Announcement records outlive that: the request is still pending for the
  // agent and the hub, and only an explicit resolution — or the
  // conversation's loss below — settles what was announced.
  private forgetInteractions(conversationId: string): void {
    this.pendingInteractions.delete(conversationId);
    this.activityMayHaveChanged();
  }

  // A conversation that is deleted or has left the workspace can neither work
  // nor wait on the user here: requireSession rejects its later events, so
  // nothing else would ever settle its adapter-level records. If it returns,
  // its activity is re-derived from new events.
  private forgetActivity(conversationId: string): void {
    const recovery = this.backgroundRecoveries.get(conversationId);
    recovery?.checking?.finish();
    recovery?.readLifetime?.abort();
    if (recovery) clearTimeout(recovery.timer);
    this.backgroundRecoveries.delete(conversationId);
    for (const [key, admission] of this.admittingSteers) if (admission.conversationId === conversationId) {
      admission.retired = true;
      this.admittingSteers.delete(key);
    }
    // Owned by it, or announced under it: a child's request appears in its
    // launching conversation, and that conversation's loss settles it too —
    // no child event is guaranteed to follow.
    for (const [itemId, record] of this.announced) if (record.owner === conversationId || record.destination === conversationId) this.resolveAnnounced(itemId);
    for (const notification of this.notifications.pendingSnapshot()) {
      try {
        if (JSON.parse(notification.sourceId)[0] !== conversationId || notification.kind === "turn-completed") continue;
        this.notifications.observe({ type: "interaction", origin: "live", conversationId: notification.conversationId, sourceId: notification.sourceId,
          kind: notification.kind, pending: false, createdAt: Date.now() });
      } catch { /* only interaction source ids are owner/request tuples */ }
    }
    this.notifications.forgetConversation(conversationId);
    this.liveTurns.delete(conversationId);
    this.settledTurns.delete(conversationId);
    this.backgroundWork.delete(conversationId);
    this.unresolvedBackgroundWork.delete(conversationId);
    this.forgetInteractions(conversationId);
  }

  // The adapter's only workspace classification. Every path that learns a
  // conversation lies outside the workspace forgets its activity here.
  private async isInWorkspace(session: Pick<ProviderSession, "id" | "directory">): Promise<boolean> {
    const inWorkspace = await isSessionInWorkspace(session.directory, this.workspacePath);
    if (!inWorkspace) this.forgetActivity(session.id);
    return inWorkspace;
  }

  startEventPump(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pumpPromise) return this.pumpPromise;
    const controller = new AbortController();
    this.pumpController = controller;
    if (this.provider.reconcileBackgroundTasks) this.backgroundReady = new Promise(resolve => { this.backgroundReadyResolve = resolve; });
    this.pumpPromise = this.pump(controller.signal).finally(() => {
      // Abort on every exit, not just stopEventPump: when one merged provider
      // stream dies the other survives on this signal, and the supervisor's
      // restart would stack a fresh pair of subscriptions on top of it.
      controller.abort();
      this.pumpController = null;
      this.pumpPromise = null;
    });
    this.inventory.invalidate();
    return this.pumpPromise;
  }

  async stopEventPump(): Promise<void> {
    this.pumpController?.abort();
    await this.pumpPromise?.catch(error => {
      if (!isAbortError(error)) throw error;
    });
  }

  dispose(): Promise<void> {
    if (this.disposalPromise) return this.disposalPromise;
    this.disposed = true;
    this.questionReads.clear();
    for (const admission of this.admittingSteers.values()) admission.retired = true;
    this.admittingSteers.clear();
    for (const recovery of this.backgroundRecoveries.values()) { clearTimeout(recovery.timer); recovery.checking?.finish(); recovery.readLifetime?.abort(); }
    this.backgroundRecoveries.clear();
    this.backgroundRecoveryFloorUntil = 0;
    this.backgroundRecoverySourceStartedAt = -Infinity;
    for (const pending of this.revertReconciliations.values()) {
      if (pending.timer !== null) clearTimeout(pending.timer);
    }
    this.revertReconciliations.clear();
    this.inventory.dispose();
    // The provider's own resources retire with the adapter: live agent
    // sessions must not keep working with no event consumer left.
    if (this.provider.reconcileBackgroundTasks) {
      return this.disposalPromise = Promise.allSettled([this.stopEventPump(), this.provider.dispose?.()])
        .then(() => Promise.allSettled(this.backgroundPending)).then(() => undefined);
    }
    return this.disposalPromise = this.stopEventPump()
      .then(() => this.provider.dispose?.())
      .then(() => undefined, () => undefined);
  }

  async prompt(conversationId: string, requestId: string, text: string, model?: ModelSelection, mode?: string, variant?: string, attachments?: MessageAttachment[], delivery?: MessageDelivery, context?: ChatActionContext, operationReceipt?: string): Promise<{
    messageId: string;
    // Accepted but not yet delivered: held by the workspace (`queue`) or
    // pending with the agent (`steer`). A dispatched prompt is not pending.
    pending: boolean;
    delivery: MessageDelivery;
    configuration: ConversationConfiguration;
    conversation?: ConversationSummary;
    // What the provider actually ran, when it was not an ordinary turn.
    operation?: "reload";
    automaticBackground?: AutomaticBackgroundOutcome;
  }> {
    if (sideQuestionOperation(text)) throw new SideGenerationUnsupportedError("Use the separate side-answer action for /btw; it is never sent to conversation history");
    if (!text.trim() && !attachments?.length) throw new Error("prompt must not be empty");
    context = context ? { ...context } : undefined;
    return this.steerActionReceipt(this.actionReceiptKey("prompt", conversationId, requestId, context, operationReceipt), () =>
      this.enqueuePromptAdmission(conversationId, async () => {
        // Refused only for text that actually parses as a listed command — an
        // unlisted "/typo" or a pasted path fragment is prose and keeps its
        // images. The classification freezes here: dispatch never re-parses an
        // attachment-bearing prompt, so a command list that changes while a
        // message is held cannot reroute it onto the command path, which
        // carries no attachments. A failed listing propagates (same rule as
        // dispatch): admitting "/compact" with images as prose because the
        // list was momentarily unavailable would send a command as chat text.
        // Inside the admission lane on purpose: a slow listing would otherwise
        // let a later submission overtake this one and commit its
        // configuration first. Inside the receipt too: a retry of an accepted
        // request must replay the receipt, never reconsult a list that may
        // have changed or gone unavailable since — and a refusal is not cached
        // (a rejected receipt is dropped), so a transient listing failure
        // stays retryable.
        if (attachments?.length && text.startsWith("/") && parseSlashCommand(text, await this.provider.listCommands()) !== undefined) {
          throw new CommandAttachmentsError();
        }
        const session = await this.requireSession(conversationId);
        const projection = this.projection(conversationId);
        const currentConfiguration = await this.configuration(conversationId);
        const variantModel = await this.validateSelections(currentConfiguration, model, mode, variant);
        // Validated at admission whether the message dispatches or holds, so an
        // unknown reference is refused while the submitting client still has
        // the draft to restore.
        const attachmentRefs = await this.validateAttachments(attachments);
        const reversible = await this.readReversibleHistoryState(conversationId);
        // opencode-v2-steering D6: on a steering agent, a prompt that is not a
        // command can go to the agent's inbox as a steer — the replacement
        // under a staged revert always does, a busy submission when asked to.
        const steerable = this.agent().capabilities.includes("steering")
          && (reversible?.staged || delivery === "steer")
          && !(text.startsWith("/") && parseSlashCommand(text, await this.provider.listCommands()) !== undefined);
        if (reversible?.staged) {
          if (steerable) {
            // A replacement is another pending inbox entry, not an escape
            // from the combined dock bound. Refuse before committing Undo.
            this.assertDockCapacity(conversationId, text);
            // The replacement goes out as a steer with resume: the agent
            // commits the boundary, wakes, and delivers every pending steer
            // with it, oldest first. The held queue stays pending behind it.
            const steered = await this.admitSteer(conversationId, requestId, text, attachmentRefs);
            await this.reconcileReversibleHistory(conversationId).catch(() => undefined);
            if (!this.settledTurns.has(conversationId)) this.dormantQueues.delete(conversationId);
            this.publishPausedChanges(conversationId);
            return this.followAcceptedSteer(conversationId, { messageId: steered.id, pending: true, delivery: "steer" as const, configuration: this.configurations.get(conversationId) ?? currentConfiguration }, context);
          }
          // OpenCode commits a staged boundary when it accepts a new prompt.
          // This submission is the replacement branch, not another held
          // message, so it goes ahead of the queue that Undo paused.
          const dispatched = await this.dispatchPrompt(conversationId, projection, session, {
            messageId: this.id(),
            text,
            requestId,
            ...(attachmentRefs.length ? { attachments: attachmentRefs } : {}),
            ...(variantModel ? { model: variantModel } : {}),
            ...(mode ? { mode } : {}),
            ...(variant ? { variant } : {}),
          });
          await this.reconcileReversibleHistory(conversationId).catch(() => undefined);
          if (!this.settledTurns.has(conversationId)) this.dormantQueues.delete(conversationId);
          this.publishPausedChanges(conversationId);
          return { ...dispatched, pending: false, delivery: "queue" };
        }
        const busy = this.turnActive(conversationId, projection);
        const queue: HeldQueue = this.heldQueues.get(conversationId) ?? [];
        // Order is absolute: while anything is held, a new submission joins the
        // back of the queue even when the conversation is momentarily idle —
        // dormant after a cancellation, or between deliveries.
        if (busy || queue.length > 0 || (this.pendingSteers.get(conversationId)?.length ?? 0) > 0) {
          // One bound over the whole dock: steers and held messages together,
          // whoever raised them (D11).
          this.assertDockCapacity(conversationId, text);
          if (steerable) {
            // The steer carries no model, mode, or variant: a mid-turn switch
            // would retarget the turn being steered (D6). The composer's
            // staged selection stays staged for the next queued or idle
            // submission, so nothing is committed here.
            const steered = await this.admitSteer(conversationId, requestId, text, attachmentRefs);
            // A new composer submission resumes Stop's held queue, but a
            // refused/unknown admission or newer settlement retains the pause.
            if (!this.settledTurns.has(conversationId)) this.dormantQueues.delete(conversationId);
            this.publishPausedChanges(conversationId);
            return this.followAcceptedSteer(conversationId, { messageId: steered.id, pending: true, delivery: "steer" as const, configuration: this.configurations.get(conversationId) ?? currentConfiguration }, context);
          }
          // The EFFECTIVE selections are resolved and frozen at submission, not
          // just the explicitly supplied ones: a later submission may move the
          // conversation's configuration before this delivers, and a held
          // message that stored nothing would silently inherit that drift while
          // its delivery reported the drifted configuration as its own. An
          // explicit model without a variant clears the variant, exactly as an
          // immediate dispatch commits it.
          const heldModel = variantModel ?? currentConfiguration.model;
          const heldMode = mode ?? currentConfiguration.mode;
          const heldVariant = variant ?? (model === undefined ? currentConfiguration.variant : undefined);
          const heldId = this.id();
          const held: HeldMessage = {
            id: heldId,
            submissionId: heldId,
            submissionOrder: ++this.submissionClock,
            text,
            queuedAt: Date.now(),
            delivery: "queue",
            requestId,
            ...(attachmentRefs.length ? { attachments: attachmentRefs } : {}),
            ...(heldModel ? { model: heldModel } : {}),
            ...(heldMode ? { mode: heldMode } : {}),
            ...(heldVariant ? { variant: heldVariant } : {}),
          };
          queue.push(held);
          this.heldQueues.set(conversationId, queue);
          // A submission is what reactivates a queue a cancellation paused.
          this.dormantQueues.delete(conversationId);
          // The staged selection commits on submission, exactly as an
          // immediately dispatched prompt commits it; delivery re-asserts the
          // same values on the wire.
          const configuration = this.commitConfiguration(conversationId, currentConfiguration, model, mode, variant);
          // This newly accepted submission is explicit permission to resume
          // kept input. Cached receipts and rejected/preflight-failed attempts
          // never reach this handoff; discard and derived status cannot grant it.
          delete queue.awaitingFreshIdle;
          this.publishQueue(conversationId, { kind: "held", messageId: held.id });
          this.publishPausedChanges(conversationId);
          if (!busy) this.scheduleDelivery(conversationId);
          return { messageId: held.id, pending: true, delivery: "queue", configuration };
        }
        const dispatched = await this.dispatchPrompt(conversationId, projection, session, {
          messageId: this.id(),
          text,
          requestId,
          ...(attachmentRefs.length ? { attachments: attachmentRefs } : {}),
          ...(variantModel ? { model: variantModel } : {}),
          ...(mode ? { mode } : {}),
          ...(variant ? { variant } : {}),
        });
        if (!this.settledTurns.has(conversationId)) this.dormantQueues.delete(conversationId);
        this.publishPausedChanges(conversationId);
        return { ...dispatched, pending: false, delivery: "queue" };
      }));
  }

  /**
   * Hand a message to the agent's inbox as a steer (opencode-v2-steering D1):
   * delivered into the running turn at its next step boundary, or waking a
   * resting session (`resume`). The entry joins the pending-steer map at
   * once under the agent's id — the same id its inbox events will name — so
   * the dock, the bound, and the stream agree on one handle.
   */
  private async admitSteer(conversationId: string, requestId: string, text: string, attachmentRefs: MessageAttachment[], queuedAt = Date.now(), sourceHeld?: HeldMessage): Promise<PendingSteer & { terminal?: "delivered" | "cancelled" }> {
    const providerAttachments = await this.locateAttachments(attachmentRefs);
    const projection = this.projection(conversationId);
    const previousStatus = projection.status;
    const waking = !this.turnActive(conversationId, projection);
    // A steer can wake an interrupted turn, including an Undo replacement.
    // Mark that admission before awaiting the provider: committing the revert
    // can release the held queue before the stream reports the resumed turn.
    // As with dispatchPrompt, a faster terminal event must win over acceptance.
    if (waking) projection.statusUpdate("sending");
    const settledBeforeAdmission = this.settledTurns.get(conversationId);
    let accepted: { messageId: string };
    const identity = this.id();
    const nativeId = this.provider.promptIdentity?.(identity) ?? identity;
    const submissionId = sourceHeld?.submissionId ?? nativeId;
    const submissionOrder = sourceHeld?.submissionOrder ?? ++this.submissionClock;
    const fence: SteerAdmission = { conversationId, id: nativeId, submissionId, submissionOrder, requestId, held: sourceHeld };
    const fenceKey = steerKey(conversationId, nativeId);
    // Retain request-local truth until the actual transport settles, not just
    // the admission deadline. Evicted requests cannot apply late evidence.
    while (this.admittingSteers.size >= STEER_ADMISSIONS_LIMIT) {
      const [key, oldest] = this.admittingSteers.entries().next().value!;
      oldest.retired = true;
      this.admittingSteers.delete(key);
    }
    this.admittingSteers.set(fenceKey, fence);
    const releaseFence = () => {
      if (this.admittingSteers.get(fenceKey) === fence) this.admittingSteers.delete(fenceKey);
    };
    let awaitingLateAcceptance = false;
    let transportSettled = false;
    const admission = Promise.resolve().then(() => this.provider.prompt(conversationId, { id: nativeId, text, delivery: "steer", ...(providerAttachments.length ? { attachments: providerAttachments } : {}) }))
      .then(value => { transportSettled = true; return value; }, error => { transportSettled = true; throw error; });
    const exposeDiscard = () => {
      if (this.disposed || fence.terminal || fence.retired) return;
      const held = sourceHeld && this.heldQueues.get(conversationId)?.includes(sourceHeld) && sourceHeld.unconfirmedSteerId === nativeId ? sourceHeld : undefined;
      const pending = this.pendingSteers.get(conversationId)?.find(entry => entry.id === nativeId && entry.unconfirmed);
      const owner = held ?? pending;
      if (!owner || owner.admissionUncertaintyId) return;
      owner.admissionUncertaintyId = crypto.randomUUID();
      this.publishQueue(conversationId, { kind: "paused", messageId: owner.id });
    };
    try {
      accepted = await this.boundedSteerAdmission(admission, nativeId);
      if (waking && projection.status === "sending") projection.statusUpdate("running");
    } catch (error) {
      // Restoring optimistic admission state is not a new provider idle event:
      // in particular it cannot release input deliberately kept after discard.
      if (waking && projection.status === "sending") projection.statusUpdate(previousStatus, undefined, false);
      if (error instanceof PrimarySteerOutcomeUnknownError && !this.disposed && !fence.terminal && !fence.retired) {
        awaitingLateAcceptance = true;
        if (sourceHeld && this.heldQueues.get(conversationId)?.includes(sourceHeld)) {
          sourceHeld.unconfirmedSteerId = nativeId;
          this.publishQueue(conversationId, { kind: "paused", messageId: sourceHeld.id });
          this.publishPausedChanges(conversationId);
        } else if (!sourceHeld && !this.pendingSteers.get(conversationId)?.some(entry => entry.id === nativeId && !entry.unconfirmed)) {
          this.recordPendingSteer(conversationId, nativeId, submissionId, submissionOrder, requestId, text, attachmentRefs, queuedAt, true);
        }
        // A still-running transport has not settled into an unknown outcome.
        // Its pending owner stays read-only until that transport actually ends.
        if (transportSettled) exposeDiscard();
        // Late acknowledgement is read-side evidence only. It must never
        // re-enter the composite operation or initiate a delayed follow-up.
        void admission.then(late => {
          if (this.disposed || fence.terminal || fence.retired) return;
          const queue = this.heldQueues.get(conversationId) ?? [];
          const heldUnknown = sourceHeld && queue.includes(sourceHeld) && sourceHeld.unconfirmedSteerId === nativeId;
          const pendingUnknown = this.pendingSteers.get(conversationId)?.some(entry => entry.id === nativeId && entry.unconfirmed);
          if (!heldUnknown && !pendingUnknown) return;
          if (heldUnknown) {
            queue.splice(queue.indexOf(sourceHeld), 1);
            if (!queue.length) this.heldQueues.delete(conversationId);
          }
          this.recordPendingSteer(conversationId, late.messageId, submissionId, submissionOrder, requestId, text, attachmentRefs, queuedAt);
        }, exposeDiscard).finally(releaseFence).catch(() => undefined);
      }
      throw error;
    } finally {
      if (!awaitingLateAcceptance) releaseFence();
    }
    // Acceptance is still receipt-keyed, but it cannot recreate terminal
    // state. The terminal queue event also fences the client's local echo.
    if (fence.terminal || fence.retired || this.disposed) return { id: accepted.messageId, submissionId, submissionOrder, text, queuedAt, requestId, tick: this.inboxClock, ...(fence.terminal ? { terminal: fence.terminal } : {}) };
    // Receipt evidence cannot undo an interruption observed during admission.
    if (this.settledTurns.get(conversationId) === settledBeforeAdmission) this.settledTurns.delete(conversationId);
    return this.recordPendingSteer(conversationId, accepted.messageId, submissionId, submissionOrder, requestId, text, attachmentRefs, queuedAt);
  }

  private recordPendingSteer(conversationId: string, messageId: string, submissionId: string, submissionOrder: number, requestId: string, text: string, attachmentRefs: MessageAttachment[], queuedAt: number, unconfirmed?: true): PendingSteer {
    const steers = this.pendingSteers.get(conversationId) ?? [];
    const existing = steers.find(entry => entry.id === messageId);
    const steer: PendingSteer = { id: messageId, submissionId, submissionOrder, text, queuedAt: existing?.queuedAt ?? queuedAt, requestId, ...(attachmentRefs.length ? { attachments: attachmentRefs } : {}), ...(unconfirmed ? { unconfirmed } : {}), tick: ++this.inboxClock };
    if (existing) {
      // The stream announced it before the acceptance answered: the entry is
      // there already, restated now with the request id the client waits for.
      Object.assign(existing, steer);
      if (!unconfirmed) { delete existing.unconfirmed; delete existing.admissionUncertaintyId; }
    } else {
      steers.push(steer);
      this.pendingSteers.set(conversationId, steers);
    }
    this.publishQueue(conversationId, { kind: "steered", messageId: steer.id });
    this.publishPausedChanges(conversationId);
    return steer;
  }

  // The dock is one bound: pending steers and held messages together, by
  // count and by text bytes (D11). Refused before anything changes.
  private assertDockCapacity(conversationId: string, text: string): void {
    const steers = this.pendingSteers.get(conversationId) ?? [];
    const queue = this.heldQueues.get(conversationId) ?? [];
    const count = steers.length + queue.length;
    const bytes = steers.reduce((total, entry) => total + Buffer.byteLength(entry.text), 0)
      + queue.reduce((total, entry) => total + Buffer.byteLength(entry.text), 0);
    if (count >= MAX_HELD_MESSAGES || bytes + Buffer.byteLength(text) > MAX_HELD_TEXT_BYTES) throw new ChatQueueFullError();
  }

  /**
   * Change a pending message's delivery (opencode-v2-steering D7, D8). Held
   * to steer hands the message to the agent now, with its attachments and
   * no frozen configuration; steer to held withdraws it from the agent and
   * holds it at its submission-order position under the session configuration
   * captured when preparing withdrawal. Both run in the admission lane and
   * are receipt-keyed.
   */
  changeDelivery(conversationId: string, messageId: string, requestId: string, delivery: MessageDelivery, context?: ChatActionContext, operationReceipt?: string): Promise<{ messageId: string; delivery: MessageDelivery } & AutomaticBackgroundFeedback> {
    context = context ? { ...context } : undefined;
    return this.steerActionReceipt(this.actionReceiptKey("switch", conversationId, requestId, context, operationReceipt), () => this.enqueuePromptAdmission(conversationId, async () => {
      await this.requireSession(conversationId);
      this.requireSteering();
      if (delivery === "steer") {
        const held = this.heldQueues.get(conversationId)?.find(entry => entry.id === messageId);
        if (!held) {
          if (this.pendingSteers.get(conversationId)?.some(entry => entry.id === messageId)) return { messageId, delivery: "steer" as const };
          throw this.notPendingError(conversationId, messageId);
        }
        const steered = await this.steerHeld(conversationId, held);
        return this.followAcceptedSteer(conversationId, { messageId: steered.id, delivery: "steer" as const }, context);
      }
      const steer = this.pendingSteers.get(conversationId)?.find(entry => entry.id === messageId);
      if (!steer) {
        const held = this.heldQueues.get(conversationId)?.find(entry => entry.id === messageId);
        if (held?.unconfirmedSteerId) throw new PrimarySteerOutcomeUnknownError(held.unconfirmedSteerId);
        if (held) return { messageId, delivery: "queue" as const };
        throw this.notPendingError(conversationId, messageId);
      }
      // Prepare the held configuration before asking for withdrawal.
      // A failed configuration read must leave the native instruction
      // untouched; after confirmed cancellation, holding it must
      // not depend on another asynchronous read. Freeze once for this action.
      const configuration = await this.configuration(conversationId);
      // A fresh id: the agent's cancelled inbox id must not be reused by a
      // later dispatch. Allocate before the destructive operation as well.
      const heldId = this.id();
      await this.withdrawSteer(conversationId, steer);
      const held: HeldMessage = {
        id: heldId,
        submissionId: steer.submissionId,
        submissionOrder: steer.submissionOrder,
        text: steer.text,
        queuedAt: steer.queuedAt,
        delivery: "queue",
        requestId: steer.requestId ?? requestId,
        ...(steer.attachments?.length ? { attachments: steer.attachments } : {}),
        ...(configuration.model ? { model: configuration.model } : {}),
        ...(configuration.mode ? { mode: configuration.mode } : {}),
        ...(configuration.variant ? { variant: configuration.variant } : {}),
      };
      const queue = this.heldQueues.get(conversationId) ?? [];
      const index = queue.findIndex(entry => entry.submissionOrder > held.submissionOrder);
      queue.splice(index < 0 ? queue.length : index, 0, held);
      this.heldQueues.set(conversationId, queue);
      this.publishQueue(conversationId, { kind: "switched", messageId: held.id });
      this.publishPausedChanges(conversationId);
      this.scheduleDelivery(conversationId);
      return { messageId: held.id, delivery: "queue" as const };
    }));
  }

  /**
   * Send a pending message now (opencode-v2-steering D8). On a steering
   * agent a held message is steered, and a paused steer wakes the agent,
   * which delivers every paused steer together. On an agent with `send-now`
   * alone, a held message is dispatched under its frozen configuration while
   * nothing runs; the rest stay held, and a dormant queue stays dormant.
   */
  sendNow(conversationId: string, messageId: string, requestId: string, context?: ChatActionContext, operationReceipt?: string): Promise<{ messageId: string; delivery: MessageDelivery } & AutomaticBackgroundFeedback> {
    context = context ? { ...context } : undefined;
    return this.steerActionReceipt(this.actionReceiptKey("send-now", conversationId, requestId, context, operationReceipt), () => this.enqueuePromptAdmission(conversationId, async () => {
      const session = await this.requireSession(conversationId);
      const capabilities = this.agent().capabilities;
      if (!capabilities.includes("send-now")) throw new SendNowUnsupportedError();
      const projection = this.projection(conversationId);
      if (capabilities.includes("steering")) {
        const steer = this.pendingSteers.get(conversationId)?.find(entry => entry.id === messageId);
        if (steer) {
          if (steer.withdrawalUnconfirmed) throw new SteerWithdrawalUnconfirmedError();
          if (steer.unconfirmed || steer.resumeUnconfirmed) throw new PrimarySteerOutcomeUnknownError(steer.id);
          // A running turn takes its steers at its next boundary on its own;
          // interrupting it to wake them would stop the work being steered.
          if (this.turnActive(conversationId, projection)) throw new SendNowUnavailableError();
          const settledBeforeResume = this.settledTurns.get(conversationId);
          const resume = this.provider.interrupt(conversationId, { resume: true });
          try { await this.boundedSteerAdmission(resume); }
          catch (error) {
            if (error instanceof PrimarySteerOutcomeUnknownError && !this.turnActive(conversationId, projection)) {
              for (const entry of this.pendingSteers.get(conversationId) ?? []) entry.resumeUnconfirmed = true;
              this.publishQueue(conversationId, { kind: "paused", messageId });
              void resume.then(() => {
                if (this.disposed) return;
                for (const entry of this.pendingSteers.get(conversationId) ?? []) delete entry.resumeUnconfirmed;
                if (this.settledTurns.get(conversationId) === settledBeforeResume) this.settledTurns.delete(conversationId);
                this.publishPausedChanges(conversationId);
              }, () => undefined);
            }
            throw error;
          }
          if (this.settledTurns.get(conversationId) === settledBeforeResume) this.settledTurns.delete(conversationId);
          this.publishPausedChanges(conversationId);
          return this.followAcceptedSteer(conversationId, { messageId, delivery: "steer" as const }, context);
        }
        const held = this.heldQueues.get(conversationId)?.find(entry => entry.id === messageId);
        if (!held) throw this.notPendingError(conversationId, messageId);
        const steered = await this.steerHeld(conversationId, held);
        return this.followAcceptedSteer(conversationId, { messageId: steered.id, delivery: "steer" as const }, context);
      }
      if (this.turnActive(conversationId, projection)) throw new SendNowUnavailableError();
      const queue = this.heldQueues.get(conversationId) ?? [];
      const index = queue.findIndex(entry => entry.id === messageId);
      if (index < 0) throw this.notPendingError(conversationId, messageId);
      const held = queue[index]!;
      await this.dispatchPrompt(conversationId, projection, session, heldDispatchInput(held));
      const current = this.heldQueues.get(conversationId);
      const currentIndex = current?.indexOf(held) ?? -1;
      if (currentIndex >= 0) current!.splice(currentIndex, 1);
      if (current?.length === 0) this.heldQueues.delete(conversationId);
      this.publishQueue(conversationId, { kind: "delivered", messageId: held.id });
      this.publishPausedChanges(conversationId);
      return { messageId: held.id, delivery: "queue" as const };
    }));
  }

  // A held message leaves the queue and goes to the agent as a steer with
  // its attachments; its frozen configuration is not applied (D8). Refused
  // for a command: the inbox cannot run Uatu's built-ins.
  private async steerHeld(conversationId: string, held: HeldMessage): Promise<PendingSteer> {
    if (held.unconfirmedSteerId) throw new PrimarySteerOutcomeUnknownError(held.unconfirmedSteerId);
    if (held.text.startsWith("/") && !held.attachments?.length && parseSlashCommand(held.text, await this.provider.listCommands()) !== undefined) throw new CommandSteeringError();
    const steer = await this.admitSteer(conversationId, held.requestId, held.text, held.attachments ?? [], held.queuedAt, held);
    const queue = this.heldQueues.get(conversationId) ?? [];
    const index = queue.indexOf(held);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.heldQueues.delete(conversationId);
    this.publishQueue(conversationId, { kind: steer.terminal === "delivered" ? "delivered" : steer.terminal === "cancelled" ? "removed" : "switched", messageId: steer.id });
    this.publishPausedChanges(conversationId);
    return steer;
  }

  private requireSteering(): void {
    if (!this.agent().capabilities.includes("steering")) throw new SteeringUnsupportedError();
  }

  private notPendingError(conversationId: string, messageId: string): Error {
    return this.deliveredSteers.has(steerKey(conversationId, messageId)) ? new SteerAlreadyDeliveredError() : new QueuedMessageNotHeldError();
  }

  /**
   * Withdraw a steer from the agent (D7): ask for the cancellation, then wait
   * for the agent's own settlement of that entry, because a cancel of an
   * already-delivered or missing entry answers as if it worked. Returns once
   * the entry is out of the pending map; throws SteerAlreadyDeliveredError
   * when the agent delivered it first, so a message is never both delivered
   * and returned or held.
   */
  private async withdrawSteer(conversationId: string, steer: PendingSteer, retryWithdrawal = false): Promise<void> {
    if (steer.withdrawalUnconfirmed && !retryWithdrawal) throw new SteerWithdrawalUnconfirmedError();
    if (steer.unconfirmed || steer.resumeUnconfirmed) throw new PrimarySteerOutcomeUnknownError(steer.id);
    const waiters = this.steerSettlements.get(conversationId) ?? new Map<string, (outcome: "delivered" | "cancelled") => void>();
    this.steerSettlements.set(conversationId, waiters);
    let settle!: (outcome: "delivered" | "cancelled") => void;
    const settled = new Promise<"delivered" | "cancelled">(resolve => { settle = resolve; });
    let observed: "delivered" | "cancelled" | undefined;
    const observe = (outcome: "delivered" | "cancelled") => {
      observed = outcome;
      settle(outcome);
    };
    waiters.set(steer.id, observe);
    let expire!: (error: Error) => void;
    const deadline = new Promise<never>((_resolve, reject) => { expire = reject; });
    const timer = setTimeout(() => expire(new SteerWithdrawalUnconfirmedError()), this.steerWithdrawTimeoutMs);
    // All transport awaits share one deadline. Closing it also releases a
    // hanging read when a positive stream settlement wins the outer race.
    const bounded = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, deadline]);
    let graceTimer: typeof timer | undefined;
    const graceMs = Math.floor(this.steerWithdrawTimeoutMs / 2);
    const grace = graceMs > 0 ? new Promise<undefined>(resolve => {
      graceTimer = setTimeout(() => resolve(undefined), graceMs);
    }) : Promise.resolve(undefined);
    const delivered = () => observed === "delivered" || this.deliveredSteers.has(steerKey(conversationId, steer.id)) || this.projection(conversationId).has(`message:${steer.id}`);
    try {
      const recover = async (): Promise<"delivered" | "cancelled"> => {
        if (!this.provider.cancelInbox) throw new SteerWithdrawalUnconfirmedError();
        await bounded(Promise.resolve().then(() => this.provider.cancelInbox!(conversationId, steer.id)));
        // The event grace period starts with the operation, so a slow POST
        // cannot consume the reserved read-side recovery window as well.
        const terminal = await bounded(Promise.race([settled, grace]));
        if (terminal) return terminal;
        if (!this.provider.listPendingInbox) return bounded(settled);
        const listed = await bounded(this.provider.listPendingInbox(conversationId));
        if (delivered()) return "delivered";
        if (observed === "cancelled") return "cancelled";
        if (listed.some(entry => entry.id === steer.id)) return bounded(settled);
        const result = await this.steerHistoryOutcome(conversationId, steer.id, bounded);
        return delivered() ? "delivered" : result;
      };
      const outcome = await Promise.race([recover(), settled, deadline]);
      if (outcome === "delivered") this.rememberDelivered(conversationId, steer.id);
      this.forgetSteer(conversationId, steer.id);
      if (outcome === "delivered") {
        this.publishQueue(conversationId, { kind: "delivered", messageId: steer.id });
        this.publishPausedChanges(conversationId);
        throw new SteerAlreadyDeliveredError();
      }
    } catch (error) {
      // A response failure is not a refusal: the cancellation may already
      // have applied. Positive terminal evidence always outranks that failure.
      if (error instanceof SteerAlreadyDeliveredError) throw error;
      if (delivered()) {
        this.rememberDelivered(conversationId, steer.id);
        this.forgetSteer(conversationId, steer.id);
        this.publishQueue(conversationId, { kind: "delivered", messageId: steer.id });
        this.publishPausedChanges(conversationId);
        throw new SteerAlreadyDeliveredError();
      }
      if (observed === "cancelled") {
        this.forgetSteer(conversationId, steer.id);
        return;
      }
      const current = this.pendingSteers.get(conversationId)?.find(entry => entry.id === steer.id);
      if (current) {
        current.withdrawalUnconfirmed = true;
        this.publishQueue(conversationId, { kind: "paused", messageId: steer.id });
        this.publishPausedChanges(conversationId);
      }
      throw new SteerWithdrawalUnconfirmedError();
    } finally {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      expire(new SteerWithdrawalUnconfirmedError());
      if (waiters.get(steer.id) === observe) waiters.delete(steer.id);
      if (waiters.size === 0) this.steerSettlements.delete(conversationId);
    }
  }

  private async steerHistoryOutcome(conversationId: string, steerId: string, bounded: <T>(operation: Promise<T>) => Promise<T>): Promise<"delivered" | "cancelled"> {
    const rowId = `message:${steerId}`;
    const cursors = new Set<string>();
    const pages = new Set<string>();
    let cursor: string | undefined;
    // Read-side recovery only: bounded even for a provider that repeats a
    // page/cursor. Incomplete evidence leaves the steer unconfirmed, never
    // authorizes an edit or conversion to submit it a second time.
    for (let read = 0; read < 20; read++) {
      const page = await bounded(this.provider.listMessages(conversationId, { cursor, limit: DEFAULT_PAGE_SIZE }));
      const items = page.completeItems ?? page.items;
      if (items.some(item => item.id === rowId)) return "delivered";
      if (page.deliveryHistoryIncomplete) throw new SteerWithdrawalUnconfirmedError();
      if (page.completeItems !== undefined) return "cancelled";
      const fingerprint = JSON.stringify(page.items.map(item => item.id));
      if (pages.has(fingerprint)) throw new SteerWithdrawalUnconfirmedError();
      pages.add(fingerprint);
      if (!page.nextCursor) {
        if (page.items.length >= DEFAULT_PAGE_SIZE) throw new SteerWithdrawalUnconfirmedError();
        return "cancelled";
      }
      if (cursors.has(page.nextCursor)) throw new SteerWithdrawalUnconfirmedError();
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new SteerWithdrawalUnconfirmedError();
  }

  private forgetSteer(conversationId: string, steerId: string): boolean {
    for (const read of this.inboxReads.get(conversationId) ?? []) read.add(steerId);
    const steers = this.pendingSteers.get(conversationId);
    if (!steers) return false;
    const index = steers.findIndex(entry => entry.id === steerId);
    if (index < 0) return false;
    steers.splice(index, 1);
    if (steers.length === 0) this.pendingSteers.delete(conversationId);
    return true;
  }

  private rememberDelivered(conversationId: string, steerId: string, knownRequestId?: string): void {
    const key = steerKey(conversationId, steerId);
    const admission = this.admittingSteers.get(key);
    const requestId = knownRequestId ?? this.pendingSteers.get(conversationId)?.find(entry => entry.id === steerId)?.requestId
      ?? this.heldQueues.get(conversationId)?.find(entry => entry.unconfirmedSteerId === steerId || entry === admission?.held)?.requestId
      ?? (!admission?.retired ? admission?.requestId : undefined);
    boundedSet(this.deliveredSteers, key, requestId ?? this.deliveredSteers.get(key) ?? true, DELIVERED_STEERS_LIMIT);
  }

  // Native ids, not client request ids, establish ownership. Keep the original
  // correlation on delivered rows too, so a lost response cannot leave a
  // browser's optimistic draft beside the accepted input after reload.
  private snapshotSteerCorrelations(conversationId: string): Map<string, string> {
    const known = new Map<string, string>();
    for (const [key, requestId] of this.deliveredSteers) {
      if (typeof requestId !== "string") continue;
      const [owner, nativeId] = JSON.parse(key) as [string, string];
      if (owner === conversationId) known.set(nativeId, requestId);
    }
    for (const admission of this.admittingSteers.values()) {
      if (admission.conversationId === conversationId && !admission.retired) known.set(admission.id, admission.requestId);
    }
    for (const held of this.heldQueues.get(conversationId) ?? []) {
      if (held.unconfirmedSteerId) known.set(held.unconfirmedSteerId, held.requestId);
    }
    for (const pending of this.pendingSteers.get(conversationId) ?? []) {
      if (pending.requestId) known.set(pending.id, pending.requestId);
    }
    return known;
  }

  private correlateSteerMessage(conversationId: string, item: ConversationItem, readCorrelations?: ReadonlyMap<string, string>): ConversationItem {
    if (item.type !== "user_message" || !item.id.startsWith("message:")) return item;
    const id = item.id.slice("message:".length);
    const key = steerKey(conversationId, id);
    const admission = this.admittingSteers.get(key);
    const delivered = this.deliveredSteers.get(key);
    const current = this.projection(conversationId).get(item.id);
    const requestId = readCorrelations?.get(id) ?? this.pendingSteers.get(conversationId)?.find(entry => entry.id === id)?.requestId
      ?? (!admission?.retired ? admission?.requestId : undefined)
      ?? (typeof delivered === "string" ? delivered : undefined)
      ?? (current?.type === "user_message" ? current.requestId : undefined);
    return requestId ? { ...item, requestId } : item;
  }

  /**
   * One inbox change from the agent's stream (D3): a user steer pending, an
   * entry settled, a delivery switched. Applied to the pending-steer map,
   * never to a timeline; the delivered row arrives as its own upsert.
   */
  private applyInboxDelta(conversationId: string, delta: InboxDelta): void {
    const steers = this.pendingSteers.get(conversationId) ?? [];
    if (delta.kind === "pending") {
      // The dock lists the user's steers; the agent's own entries and its
      // natively queued input are not Uatu's queue.
      if (delta.delivery !== "steer") return;
      const fence = this.admittingSteers.get(steerKey(conversationId, delta.id));
      const admission = fence?.retired ? undefined : fence;
      if (admission?.terminal || this.deliveredSteers.has(steerKey(conversationId, delta.id)) || this.projection(conversationId).has(`message:${delta.id}`)) return;
      const queue = this.heldQueues.get(conversationId) ?? [];
      const held = queue.find(entry => entry === admission?.held || entry.unconfirmedSteerId === delta.id);
      if (held) {
        queue.splice(queue.indexOf(held), 1);
        if (!queue.length) this.heldQueues.delete(conversationId);
      }
      const existing = steers.find(entry => entry.id === delta.id);
      if (existing) {
        existing.text = delta.text;
        if (admission) existing.requestId = admission.requestId;
        existing.tick = ++this.inboxClock;
        delete existing.unconfirmed;
        delete existing.admissionUncertaintyId;
        if (delta.attachments?.length) existing.attachments = delta.attachments; else delete existing.attachments;
        if (!existing.nativeOrderKnown) {
          steers.splice(steers.indexOf(existing), 1);
          existing.nativeOrderKnown = true;
          const index = steers.findIndex(entry => !entry.nativeOrderKnown);
          steers.splice(index < 0 ? steers.length : index, 0, existing);
        }
        this.publishQueue(conversationId, { kind: "steered", messageId: delta.id });
        this.publishPausedChanges(conversationId);
        return;
      }
      const submissionId = held?.submissionId ?? admission?.submissionId ?? delta.id;
      const requestId = held?.requestId ?? admission?.requestId;
      const index = steers.findIndex(entry => !entry.nativeOrderKnown);
      steers.splice(index < 0 ? steers.length : index, 0, { id: delta.id, submissionId, nativeOrderKnown: true, submissionOrder: held?.submissionOrder ?? admission?.submissionOrder ?? ++this.submissionClock, text: delta.text, queuedAt: held?.queuedAt ?? delta.at, ...(requestId ? { requestId } : {}), ...(delta.attachments?.length ? { attachments: delta.attachments } : {}), tick: ++this.inboxClock });
      this.pendingSteers.set(conversationId, steers);
      this.publishQueue(conversationId, { kind: "steered", messageId: delta.id });
      this.publishPausedChanges(conversationId);
      return;
    }
    if (delta.kind === "delivery") {
      // Switched to the agent's native queue elsewhere: no longer a steer the
      // dock lists. A switch to steer of an entry never seen carries no text;
      // the next reconciliation lists it.
      if (delta.delivery === "queue" && this.forgetSteer(conversationId, delta.id)) {
        this.publishQueue(conversationId, { kind: "removed", messageId: delta.id });
        this.publishPausedChanges(conversationId);
      }
      return;
    }
    // Settled. A withdrawal waiting on this entry takes the outcome and
    // publishes the end itself; otherwise the dock learns it here.
    for (const read of this.inboxReads.get(conversationId) ?? []) read.add(delta.id);
    const waiter = this.steerSettlements.get(conversationId)?.get(delta.id);
    const admission = this.admittingSteers.get(steerKey(conversationId, delta.id));
    if (admission?.id === delta.id) {
      admission.terminal = delta.outcome;
    }
    // The held owner keeps the native identity even after a rejected
    // transport releases its fence. Positive settlement retires it once.
    const queue = this.heldQueues.get(conversationId);
    const index = queue?.findIndex(entry => entry === admission?.held || entry.unconfirmedSteerId === delta.id) ?? -1;
    // Positive settlement transfers the original correlation before either
    // pending owner (including an unknown Queue→Steer handoff) is removed.
    if (delta.outcome === "delivered") this.rememberDelivered(conversationId, delta.id);
    if (queue && index >= 0) {
      queue.splice(index, 1);
      if (!queue.length) this.heldQueues.delete(conversationId);
    }
    if (waiter) {
      this.forgetSteer(conversationId, delta.id);
      waiter(delta.outcome);
      return;
    }
    if (!this.forgetSteer(conversationId, delta.id) && admission?.id !== delta.id && index < 0) return;
    this.publishQueue(conversationId, { kind: delta.outcome === "delivered" ? "delivered" : "removed", messageId: delta.id });
    this.publishPausedChanges(conversationId);
  }

  /**
   * Replace the pending-steer map from the agent's own list (D3): on attach
   * and after the stream reconnects, so steers raised while the stream was
   * down or by another client are listed. A failed list is unknown, not
   * empty, and leaves the map as it stands. With no turn live, listed steers
   * are stranded until something wakes the agent.
   */
  private async reconcilePendingSteers(conversationId: string, history: readonly ConversationItem[] = [], coverage?: HistoryCoverage): Promise<void> {
    if (!this.provider.listPendingInbox || !this.agent().capabilities.includes("steering")) return;
    if (this.disposed) return;
    // Attach may precede the service's pump. Own and observe that pump, then
    // await its actual transport handshake, not generator construction. A
    // connected read reuses the same subscription; V1/Claude need no barrier.
    if (this.provider.waitForEventStream && !this.pumpPromise) void this.startEventPump().catch(() => undefined);
    const stream = this.provider.waitForEventStream ? this.pumpController : null;
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, ...(stream ? [stream.signal] : []), ...(coverage ? [coverage.signal] : [])]);
    let unavailable!: () => void;
    const expired = new Promise<never>((_resolve, reject) => { unavailable = () => reject(new Error("Inbox recovery unavailable")); });
    signal.addEventListener("abort", unavailable, { once: true });
    const timer = setTimeout(() => lifetime.abort(), 5_000);
    let readTick = this.inboxClock;
    const terminal = new Set<string>();
    const reads = this.inboxReads.get(conversationId) ?? new Set<Set<string>>();
    this.inboxReads.set(conversationId, reads);
    reads.add(terminal);
    let listed: Awaited<ReturnType<NonNullable<ChatProvider["listPendingInbox"]>>>;
    try {
      listed = await Promise.race([(async () => {
        if (this.provider.waitForEventStream) await this.provider.waitForEventStream(signal);
        signal.throwIfAborted();
        readTick = this.inboxClock;
        return this.provider.listPendingInbox!(conversationId, { signal });
      })(), expired]);
      // A late response belongs only to the connection that covered its read.
      if (signal.aborted || this.disposed || stream && this.pumpController !== stream) throw new Error("Inbox recovery unavailable");
      coverage?.assertCurrent();
    } catch {
      // Native recovery needs both stream coverage and a successful list:
      // the stream cannot replay changes missed before its handshake. Keep
      // known owners, but never claim their stale set is a current snapshot.
      // Legacy providers retain their degraded-read contract.
      if (this.provider.waitForEventStream) throw new Error("Inbox recovery unavailable");
      return;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", unavailable);
      reads.delete(terminal);
      if (reads.size === 0) this.inboxReads.delete(conversationId);
    }
    const projection = this.projection(conversationId);
    const delivered = (id: string) => history.some(item => item.id === `message:${id}`) || projection.has(`message:${id}`) || this.deliveredSteers.has(steerKey(conversationId, id));
    for (const admission of this.admittingSteers.values()) {
      if (admission.conversationId === conversationId && delivered(admission.id)) admission.terminal = "delivered";
    }
    listed = listed.filter(entry => !terminal.has(entry.id) && !delivered(entry.id));
    const current = this.pendingSteers.get(conversationId) ?? [];
    const confirmedHeld = new Map<string, HeldMessage>();
    const held = this.heldQueues.get(conversationId) ?? [];
    const remaining = held.filter(entry => {
      const nativeId = entry.unconfirmedSteerId ?? [...this.admittingSteers.values()].find(admission => admission.conversationId === conversationId && admission.held === entry && !admission.retired)?.id;
      if (!nativeId || !listed.some(candidate => candidate.id === nativeId && candidate.delivery === "steer")
        && !history.some(item => item.id === `message:${nativeId}`) && !projection.has(`message:${nativeId}`)) return true;
      confirmedHeld.set(nativeId, entry);
      return false;
    });
    if (remaining.length !== held.length) {
      held.splice(0, held.length, ...remaining);
      if (!held.length) this.heldQueues.delete(conversationId);
    }
    const next: PendingSteer[] = listed.filter(entry => entry.delivery === "steer").map(entry => {
      const known = current.find(candidate => candidate.id === entry.id) ?? confirmedHeld.get(entry.id);
      const fence = this.admittingSteers.get(steerKey(conversationId, entry.id));
      const admission = fence?.retired ? undefined : fence;
      const requestId = known?.requestId ?? admission?.requestId;
      return { id: entry.id, submissionId: known?.submissionId ?? admission?.submissionId ?? entry.id, nativeOrderKnown: true, submissionOrder: known?.submissionOrder ?? admission?.submissionOrder ?? ++this.submissionClock, text: entry.text, queuedAt: known?.queuedAt ?? entry.at, ...(requestId ? { requestId } : {}), ...(entry.attachments?.length ? { attachments: entry.attachments } : {}), ...(known && "withdrawalUnconfirmed" in known && known.withdrawalUnconfirmed ? { withdrawalUnconfirmed: true as const } : {}), ...(known && "resumeUnconfirmed" in known && known.resumeUnconfirmed && !this.turnActive(conversationId, projection) ? { resumeUnconfirmed: true as const } : {}), tick: known && "tick" in known ? known.tick : ++this.inboxClock };
    });
    const nextIds = new Set(next.map(entry => entry.id));
    // Kept without the list's say: entries a withdrawal is waiting on (their
    // settlement decides) and entries learned after the read began.
    // Absence in an attach/reconnect snapshot is not withdrawal confirmation:
    // its history may be filtered, incomplete, or captured before cancellation.
    // Only positive delivery evidence or settlement retires uncertain entries.
    const kept = current.filter(entry => !nextIds.has(entry.id) && !terminal.has(entry.id) && !delivered(entry.id) && (entry.unconfirmed || entry.withdrawalUnconfirmed || entry.resumeUnconfirmed || this.steerSettlements.get(conversationId)?.has(entry.id) || entry.tick > readTick));
    const gone = current.filter(entry => !nextIds.has(entry.id) && !kept.includes(entry));
    const added = next.filter(entry => !current.some(candidate => candidate.id === entry.id));
    // The list owns native enqueue order, which differs from the original
    // submission order when held messages are steered later. Retained unknown
    // owners keep their position relative to surviving neighbours; they cannot
    // reorder the list or be treated as cancelled just because it omitted them.
    const merged = [...next];
    for (const entry of kept) {
      const index = current.indexOf(entry);
      const successor = current.slice(index + 1).find(candidate => nextIds.has(candidate.id));
      const predecessor = current.slice(0, index).reverse().find(candidate => merged.some(item => item.id === candidate.id));
      const position = successor ? merged.findIndex(item => item.id === successor.id)
        : predecessor ? merged.findIndex(item => item.id === predecessor.id) + 1 : Math.min(index, merged.length);
      merged.splice(position, 0, entry);
    }
    if (merged.length === 0) this.pendingSteers.delete(conversationId);
    else this.pendingSteers.set(conversationId, merged);
    // Steers learned of only now, on a session with no turn live, have
    // nothing coming to deliver them: stranded until something wakes the
    // agent. Register their owner before trimming historical settlements.
    if (current.length === 0 && listed.length > 0 && !this.turnActive(conversationId, projection) && !this.settledTurns.has(conversationId)) this.rememberSettlement(conversationId);
    for (const entry of gone) {
      const wasDelivered = delivered(entry.id);
      // The departing owner is no longer in pendingSteers. Transfer its
      // correlation with the positive native delivery evidence, before it is
      // lost; a client nonce never becomes the ownership/cache key.
      if (wasDelivered) this.rememberDelivered(conversationId, entry.id, entry.requestId);
      this.publishQueue(conversationId, { kind: wasDelivered ? "delivered" : "removed", messageId: entry.id });
    }
    for (const entry of added) this.publishQueue(conversationId, { kind: "steered", messageId: entry.id });
    for (const [nativeId, entry] of confirmedHeld) {
      if (!nextIds.has(nativeId)) this.rememberDelivered(conversationId, nativeId, entry.requestId);
      this.publishQueue(conversationId, { kind: nextIds.has(nativeId) ? "switched" : "delivered", messageId: nextIds.has(nativeId) ? nativeId : entry.id });
    }
    this.publishPausedChanges(conversationId);
  }

  /** The pending steers as the adapter holds them, for tests. */
  pendingSteersForTests(conversationId: string): readonly PendingSteer[] {
    return this.pendingSteers.get(conversationId) ?? [];
  }

  discardUnconfirmedSteer(conversationId: string, messageId: string, requestId: string, uncertaintyId: string): Promise<{ discarded: true; outcomeUnconfirmed: true }> {
    // Capture before joining the lane. A confirmation/replacement while waiting
    // must not turn this local-only operation into removal of another owner.
    const held = this.heldQueues.get(conversationId)?.find(entry => entry.id === messageId);
    const pending = this.pendingSteers.get(conversationId)?.find(entry => entry.id === messageId);
    const owner = held ?? pending;
    const nativeId = held?.unconfirmedSteerId ?? pending?.id;
    const submissionId = owner?.submissionId;
    return this.receipts.run(JSON.stringify(["discard-unconfirmed", conversationId, messageId, uncertaintyId, requestId]), () => this.enqueuePromptAdmission(conversationId, async () => {
      this.requireSteering();
      const queue = this.heldQueues.get(conversationId);
      const steers = this.pendingSteers.get(conversationId);
      if (!owner || !uncertaintyId || owner.admissionUncertaintyId !== uncertaintyId || owner.submissionId !== submissionId
        || (held ? !queue?.includes(held) || held.unconfirmedSteerId !== nativeId
          : !pending || !steers?.includes(pending) || !pending.unconfirmed || pending.resumeUnconfirmed || pending.withdrawalUnconfirmed)) {
        throw new InteractionConflictError("admission uncertainty changed; refresh pending input");
      }
      const admission = this.admittingSteers.get(steerKey(conversationId, nativeId!));
      if (admission && admission.submissionId === submissionId && (!held || admission.held === held)) admission.retired = true;
      // Fence only already-running inbox snapshots. This is not a cancellation
      // tombstone: future native pending/history evidence remains authoritative.
      for (const read of this.inboxReads.get(conversationId) ?? []) read.add(nativeId!);
      if (held) {
        queue!.splice(queue!.indexOf(held), 1);
        if (!queue!.length) this.heldQueues.delete(conversationId);
      } else this.forgetSteer(conversationId, pending!.id);
      const remaining = this.heldQueues.get(conversationId);
      if (remaining?.length) {
        remaining.deliveryEpoch = {};
        remaining.awaitingFreshIdle = true;
      }
      this.publishQueue(conversationId, { kind: "removed", messageId });
      this.publishPausedChanges(conversationId);
      return { discarded: true as const, outcomeUnconfirmed: true as const };
    }));
  }

  async removeQueued(conversationId: string, messageId: string, requestId: string): Promise<{ removed: true }> {
    // Removal runs through the same per-conversation admission lane as
    // dispatch, so it can never race a delivery: when it runs, the message is
    // either still held (removed here, never sent) or already delivered
    // (refused, and the client learns it is no longer held).
    return this.receipts.run(`unqueue:${conversationId}:${requestId}`, () => this.enqueuePromptAdmission(conversationId, async () => {
      await this.requireSession(conversationId);
      const queue = this.heldQueues.get(conversationId) ?? [];
      const index = queue.findIndex(held => held.id === messageId);
      if (index >= 0 && queue[index]!.unconfirmedSteerId) throw new OperationOutcomeUnknownError();
      if (index < 0) {
        // A steer is withdrawn from the agent, which must confirm it (D7).
        const steer = this.pendingSteers.get(conversationId)?.find(entry => entry.id === messageId);
        if (!steer) throw this.notPendingError(conversationId, messageId);
        // Remove is cancellation only, including an explicit retry against
        // the same native inbox ID. Conversion never gets this exception.
        await this.withdrawSteer(conversationId, steer, true);
        this.publishQueue(conversationId, { kind: "removed", messageId });
        this.publishPausedChanges(conversationId);
        return { removed: true as const };
      }
      queue.splice(index, 1);
      if (queue.length === 0) this.heldQueues.delete(conversationId);
      this.publishQueue(conversationId, { kind: "removed", messageId });
      this.publishPausedChanges(conversationId);
      return { removed: true as const };
    }));
  }

  /**
   * Admission-time check that every reference resolves to stored bytes. The
   * returned refs carry the sniffed mime type — the store's authority — over
   * the client's claim; names stay client-supplied, the store keeps none.
   */
  private async validateAttachments(attachments?: MessageAttachment[]): Promise<MessageAttachment[]> {
    if (!attachments?.length) return [];
    const refs: MessageAttachment[] = [];
    for (const attachment of attachments) {
      const stored = attachment.id && this.resolveAttachment ? await this.resolveAttachment(attachment.id) : null;
      if (!stored) throw new UnknownAttachmentError();
      refs.push({ id: stored.id, name: attachment.name, mimeType: stored.mimeType });
    }
    return refs;
  }

  /**
   * Dispatch-time location of stored bytes for the provider hand-off. Also
   * runs for a message that validated when it was admitted to the queue: a
   * reference that stopped resolving while held fails the delivery rather
   * than handing the provider a dangling path.
   */
  private async locateAttachments(attachments?: MessageAttachment[]): Promise<ProviderAttachment[]> {
    if (!attachments?.length) return [];
    const located: ProviderAttachment[] = [];
    for (const attachment of attachments) {
      const stored = attachment.id && this.resolveAttachment ? await this.resolveAttachment(attachment.id) : null;
      if (!stored) throw new UnknownAttachmentError();
      located.push({ id: stored.id, name: attachment.name, mimeType: stored.mimeType, absolutePath: stored.absolutePath });
    }
    return located;
  }

  /**
   * Refuses a selection the agent does not offer, and resolves which model a
   * bare variant rides. A variant is refused unless the model it would ride
   * advertises it — variants are per-model, and an unknown one passed through
   * would silently do nothing on the wire. A prompt that carries a variant
   * without restating the model means "this conversation's model, harder".
   * Only a change pays a provider list round trip.
   */
  private async validateSelections(currentConfiguration: ConversationConfiguration, model?: ModelSelection, mode?: string, variant?: string): Promise<ModelSelection | undefined> {
    const previousModel = model ? currentConfiguration.model : undefined;
    const modelChanged = model !== undefined && (!previousModel || !sameSelection(previousModel, model));
    // One list serves the model check and the variant check below; only a
    // change pays the round trip.
    let available: ChatModel[] | undefined;
    if (model && modelChanged) {
      available = await this.provider.listModels();
      // An agent that runs typed ids takes an unlisted selection verbatim;
      // its acceptance or rejection is the agent's to report on the turn.
      const typedIds = this.provider.describe().capabilities.includes("custom-model-id");
      if (!typedIds && !available.some(candidate => sameSelection(candidate.selection, model))) throw new InvalidModelSelectionError();
    }
    // Same freshness rule as the model: only a change pays the list round
    // trip, and an unknown name is refused rather than passed through for
    // OpenCode to interpret.
    if (mode && currentConfiguration.mode !== mode) {
      const modes = await this.modes();
      if (!modes.some(candidate => candidate.name === mode)) throw new InvalidModeSelectionError();
    }
    const variantModel = variant ? model ?? currentConfiguration.model : model;
    if (variant && (modelChanged || currentConfiguration.variant !== variant)) {
      available ??= await this.provider.listModels();
      const selected = variantModel && available.find(candidate => sameSelection(candidate.selection, variantModel));
      if (!selected?.variants?.includes(variant)) throw new InvalidVariantSelectionError();
    }
    return variantModel;
  }

  /**
   * The one place a prompt actually reaches the provider. Every dispatch runs
   * on an idle conversation — a busy one holds the message instead — inside
   * the per-conversation admission lane.
   */
  private async dispatchPrompt(conversationId: string, projection: ConversationProjection, initialSession: ProviderSession, input: {
    messageId: string;
    text: string;
    requestId: string;
    attachments?: MessageAttachment[];
    model?: ModelSelection;
    mode?: string;
    variant?: string;
  }): Promise<{ messageId: string; configuration: ConversationConfiguration; conversation?: ConversationSummary; operation?: "reload" }> {
    let session = initialSession;
    const { text, mode, variant } = input;
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
    projection.statusUpdate("sending");
    const settledBeforeDispatch = this.settledTurns.get(conversationId);
    try {
      // A failed command listing propagates: classifying "/compact" as
      // plain prose because the list was momentarily unavailable would
      // send the text as a message and report it accepted. Attachments pin
      // the prose route without consulting the list: admission already
      // proved the text was no listed command, and re-parsing here could
      // reroute a held message onto the command path — which carries no
      // attachments — if the list changed while it waited.
      const slash = text.startsWith("/") && !input.attachments?.length
        ? parseSlashCommand(text, await this.provider.listCommands())
        : undefined;
      // Stored bytes are located at dispatch, not carried by the held entry:
      // the queue holds references, and a reference that stopped resolving
      // while held fails the delivery like any provider refusal.
      const providerAttachments = await this.locateAttachments(input.attachments);
      const accepted: { messageId: string; text?: string; operation?: "reload" } = slash
        ? await this.provider.command(conversationId, { id: input.messageId, name: slash.name, arguments: slash.arguments, listed: slash.command, model: input.model, mode, variant })
        : await this.provider.prompt(conversationId, { id: input.messageId, text, delivery: "queue", ...(providerAttachments.length ? { attachments: providerAttachments } : {}), model: input.model, mode, variant });
      // A dispatch wakes the agent, which takes its pending steers with it.
      if (this.settledTurns.get(conversationId) === settledBeforeDispatch) this.settledTurns.delete(conversationId);
      // "sending" ends at acceptance, BEFORE the rename side-work below —
      // the dispatch is no longer in flight once the provider has accepted
      // it, so the state must not span the rename's provider round trips.
      // Guarded, not unconditional: a fast turn's completion can outrun the
      // acceptance response, and a terminal status that already landed must
      // not be overwritten back to "running".
      if (projection.status === "sending") projection.statusUpdate("running");
      // The row goes in at acceptance too, before the rename's round trips:
      // a provider that later retires this placeholder (a 2.x command whose
      // server-minted row arrived after its admission window) removes it by
      // id, and a removal that lands before the row exists is a no-op that
      // leaves the row beside the server's for good.
      projection.upsert({ id: `message:${accepted.messageId}`, type: "user_message", createdAt: Date.now(), text: accepted.text ?? text, requestId: input.requestId, ...(input.attachments?.length ? { attachments: input.attachments } : {}) });
      if (renameToFirstPrompt) {
        try {
          // A manual rename can finish while prompt validation is still
          // running, before the projection enters `sending`. Re-read here so
          // the stale first-prompt decision cannot overwrite that title.
          session = await this.requireSession(conversationId);
          if (isDefaultConversationTitle(session.title)) {
            session = await this.provider.renameSession!(conversationId, deriveConversationTitle(text));
            const metadata = await this.classifyInventorySession(session);
            if (!metadata.inWorkspace) throw new ConversationNotFoundError();
            this.rememberInventorySession(session.id, metadata, true);
            conversation = this.summary(session, projection.status);
            projection.conversationUpdate(conversation);
          }
        } catch { /* cosmetic — listConversations repairs default titles later */ }
      }
      const configuration = this.commitConfiguration(conversationId, this.configurations.get(conversationId) ?? {}, input.model, mode, variant);
      return { messageId: accepted.messageId, configuration, ...(conversation ? { conversation } : {}), ...(accepted.operation ? { operation: accepted.operation } : {}) };
    } catch (error) {
      const mapped = error instanceof UnsupportedVariantSelectionError
        ? new InvalidVariantSelectionError(error.message)
        : error;
      if (projection.status === "sending") projection.statusUpdate("failed", errorMessage(mapped));
      throw mapped;
    }
  }

  // Provider events can update the cache while prompt admission awaits.
  // Merge onto the latest value synchronously so omitted fields preserve
  // that newer state rather than restoring the pre-admission snapshot.
  private commitConfiguration(conversationId: string, fallback: ConversationConfiguration, model?: ModelSelection, mode?: string, variant?: string): ConversationConfiguration {
    const latestConfiguration = this.configurations.get(conversationId) ?? fallback;
    const configuration: ConversationConfiguration = {
      ...latestConfiguration,
      ...(model ? { model } : {}),
      ...(mode ? { mode } : {}),
    };
    if (model) {
      if (variant) configuration.variant = variant;
      else delete configuration.variant;
    } else if (variant) configuration.variant = variant;
    this.configurations.set(conversationId, configuration);
    // An entirely unknown resumed conversation does not tell us what
    // OpenCode actually chose, so it must not erase the durable cold-TUI
    // fallback. Known accepted models do become this adapter's last-used
    // selection, matching a running TUI.
    if (configuration.model) this.newConversationDefaults = configuration;
    if (!sameConfiguration(latestConfiguration, configuration)) {
      // Resolved at publish time, not at the caller's capture: awaits sit
      // between a caller picking up its projection and this publication, and
      // an LRU eviction in that window would send the event into a replay no
      // current subscriber holds.
      this.projection(conversationId).replay.publish({ type: "conversation.configuration", configuration });
    }
    return configuration;
  }

  /**
   * The dock as it goes on the wire — handles, not dispatch payloads: steers
   * first in enqueue order, then held messages in submission order, each with
   * its delivery and, when nothing will deliver it on its own, `paused` (D3,
   * D5). A steer is paused when the conversation has settled and no later
   * wake has superseded that settlement; a held message while
   * delivery is paused (dormant, or a revert in progress or staged).
   */
  private queuedMessages(conversationId: string): QueuedMessage[] {
    const settled = this.settledTurns.has(conversationId);
    const heldPaused = this.deliveryPaused(conversationId);
    const steers = (this.pendingSteers.get(conversationId) ?? []).map(({ id, submissionId, text, queuedAt, requestId, attachments, unconfirmed, admissionUncertaintyId, resumeUnconfirmed, withdrawalUnconfirmed }): QueuedMessage => ({
      id, submissionId, text, queuedAt, delivery: "steer",
      ...(unconfirmed || resumeUnconfirmed || withdrawalUnconfirmed || settled ? { paused: true as const } : {}),
      ...(unconfirmed || resumeUnconfirmed || withdrawalUnconfirmed ? { unconfirmed: true as const } : {}),
      ...(unconfirmed && admissionUncertaintyId && !resumeUnconfirmed && !withdrawalUnconfirmed ? { admissionUncertaintyId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(attachments?.length ? { attachments } : {}),
    }));
    const queue = this.heldQueues.get(conversationId) ?? [];
    const blockedAt = queue.findIndex(entry => entry.unconfirmedSteerId !== undefined);
    const held = queue.map(({ id, submissionId, text, queuedAt, requestId, attachments, unconfirmedSteerId, admissionUncertaintyId }, index): QueuedMessage => ({
      id, submissionId, text, queuedAt, delivery: "queue",
      ...(heldPaused || blockedAt >= 0 && index >= blockedAt ? { paused: true as const } : {}),
      ...(unconfirmedSteerId ? { unconfirmed: true as const } : {}),
      ...(unconfirmedSteerId && admissionUncertaintyId ? { admissionUncertaintyId } : {}),
      requestId,
      ...(attachments?.length ? { attachments } : {}),
    }));
    return [...steers, ...held];
  }

  // Resolved at publish time for the same eviction reason as configuration
  // commits: the delivered event especially has no provider-side echo, so a
  // subscriber who arrived on a replacement projection would otherwise show
  // the departed head as still held until the next queue change.
  private publishQueue(conversationId: string, change: { kind: QueueChangeKind; messageId: string }): void {
    this.projection(conversationId).replay.publish({ type: "conversation.queue", queued: this.queuedMessages(conversationId), change });
    this.trimSettlements();
  }

  private rememberSettlement(conversationId: string): void {
    this.settledTurns.delete(conversationId);
    this.settledTurns.set(conversationId, {});
    this.trimSettlements();
  }

  private trimSettlements(): void {
    for (const id of this.settledTurns.keys()) {
      if (this.settledTurns.size <= INVENTORY_SESSION_LIMIT) break;
      // Pending input and in-flight actions own their ordering fences even
      // after projection eviction. Bound historical markers, not live owners.
      if (this.heldQueues.has(id) || this.pendingSteers.has(id) || this.promptAdmissions.has(id) || this.stoppingTurns.has(id)) continue;
      this.settledTurns.delete(id);
    }
  }

  // The paused state is derived, so a change to what it derives from (a
  // settle, a wake, dormancy, a revert) publishes one `paused` or `resumed`
  // per entry whose state changed — and nothing when none did (D5).
  private publishPausedChanges(conversationId: string): void {
    if (!this.pendingSteers.has(conversationId) && !this.heldQueues.has(conversationId) && !this.publishedPaused.has(conversationId)) return;
    const before = this.publishedPaused.get(conversationId) ?? new Set<string>();
    const dock = this.queuedMessages(conversationId);
    const present = new Set(dock.map(entry => entry.id));
    for (const entry of dock) {
      if (entry.paused && !before.has(entry.id)) this.publishQueue(conversationId, { kind: "paused", messageId: entry.id });
      else if (!entry.paused && before.has(entry.id)) this.publishQueue(conversationId, { kind: "resumed", messageId: entry.id });
    }
    // An entry that left the dock was announced by its own event.
    const paused = new Set(dock.filter(entry => entry.paused).map(entry => entry.id));
    if (paused.size === 0) this.publishedPaused.delete(conversationId);
    else this.publishedPaused.set(conversationId, paused);
  }

  // liveTurns as well as projection status: a projection evicted mid-turn
  // comes back "idle" while the turn is still running, and dispatching
  // into it would race the very turn the queue exists to wait out.
  private turnActive(conversationId: string, projection: ConversationProjection): boolean {
    return isLiveConversationStatus(projection.status) || this.liveTurns.has(conversationId);
  }

  // Fire-and-forget by design: delivery is triggered by status transitions
  // and its failures are reported through the conversation itself (a failed
  // status plus a paused queue), not to whichever caller happened to trip it.
  private scheduleDelivery(conversationId: string): void {
    if (this.deliveryPaused(conversationId)) return;
    const queue = this.heldQueues.get(conversationId);
    if (!queue?.length) return;
    const epoch = queue.deliveryEpoch;
    void this.enqueuePromptAdmission(conversationId, () => {
      if (this.heldQueues.get(conversationId) !== queue || queue.deliveryEpoch !== epoch) return Promise.resolve();
      return this.deliverNextHeld(conversationId);
    }).catch(() => undefined);
  }

  private async deliverNextHeld(conversationId: string): Promise<void> {
    if (this.deliveryPaused(conversationId)) return;
    const queue = this.heldQueues.get(conversationId);
    const held = queue?.[0];
    if (!queue || !held) return;
    if (held.unconfirmedSteerId) return;
    // Re-held, not lost: a conversation that reports busy again before this
    // ran keeps the message queued, and the next end-of-turn retries. A
    // straggling duplicate completion can still release a head early; that
    // is bounded for prompts by the provider's queue delivery, and for
    // slash commands by OpenCode's runner itself — a command on a busy
    // session joins the in-flight run (SessionRunState.ensureRunning), so
    // its expanded template is answered by the running turn rather than
    // starting a concurrent one. Either way the cost is the removal window,
    // never turn corruption.
    if (this.turnActive(conversationId, this.projection(conversationId))) return;
    let session: ProviderSession;
    try {
      session = await this.requireSession(conversationId);
    } catch {
      // The terminal transition that triggered this delivery is already
      // consumed — returning silently would strand an accepted message in
      // the queue with nothing left to release it. Pausing instead makes
      // the stall visible state with a documented exit: the next
      // submission resumes delivery from the head. A genuinely deleted
      // conversation pauses a queue nobody can see, which is harmless.
      this.dormantQueues.add(conversationId);
      return;
    }
    // The lookup awaited, and the pump runs outside the admission lane: a
    // busy report can land meanwhile — e.g. the merged stream correcting a
    // stale terminal event. Re-held, not lost, exactly like the guard above;
    // the corrected turn's own end retries. Reacquired as well as rechecked:
    // an LRU eviction during the lookup would leave a captured projection
    // stale, and the dispatch must publish where current subscribers listen.
    const projection = this.projection(conversationId);
    if (this.deliveryPaused(conversationId) || this.turnActive(conversationId, projection)) return;
    try {
      await this.dispatchPrompt(conversationId, projection, session, heldDispatchInput(held));
      // History and inbox events reconcile outside the admission lane. Remove
      // the accepted object from the current queue, not a captured array/head.
      const current = this.heldQueues.get(conversationId);
      const index = current?.indexOf(held) ?? -1;
      if (index >= 0) current!.splice(index, 1);
      if (current?.length === 0) this.heldQueues.delete(conversationId);
      this.publishQueue(conversationId, { kind: "delivered", messageId: held.id });
    } catch {
      // The provider refused the delivery. The message stays held and the
      // queue pauses so a failing conversation is not hammered once per
      // status flap; the failed turn status is already published, and the
      // user's next submission or removal decides what happens.
      this.dormantQueues.add(conversationId);
      this.publishPausedChanges(conversationId);
    }
  }

  private deliveryPaused(conversationId: string): boolean {
    return this.dormantQueues.has(conversationId)
      || this.heldQueues.get(conversationId)?.awaitingFreshIdle === true
      || this.reversibleMutations.has(conversationId)
      || this.revertReconciliations.has(conversationId)
      || this.reversibleHistory.get(conversationId)?.staged === true;
  }

  // OpenCode applies prompts to one conversation in admission order. Keep the
  // matching cache commit in that same order even if provider requests settle
  // out of order; a failed admission must not block the next request.
  private enqueuePromptAdmission<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.promptAdmissions.get(conversationId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.then(() => undefined, () => undefined);
    this.promptAdmissions.set(conversationId, tail);
    void tail.then(() => {
      if (this.promptAdmissions.get(conversationId) === tail) this.promptAdmissions.delete(conversationId);
      this.trimSettlements();
    });
    return next;
  }

  async renameConversation(conversationId: string, requestId: string, rawTitle: string): Promise<{ conversation: ConversationSummary }> {
    const title = rawTitle.trim();
    if (!title || Buffer.byteLength(title) > 200) throw new InvalidConversationTitleError();
    if (!this.provider.renameSession || !this.agent().capabilities.includes("conversation-rename")) {
      throw new ConversationRenameUnsupportedError();
    }
    return this.receipts.run(`rename:${conversationId}:${requestId}`, async () => {
      await this.requireSession(conversationId);
      const renamed = await this.provider.renameSession!(conversationId, title);
      const metadata = await this.classifyInventorySession(renamed);
      if (!metadata.inWorkspace) throw new ConversationNotFoundError();
      this.rememberInventorySession(renamed.id, metadata, true);
      const conversation = this.summary(renamed);
      this.projection(conversationId).conversationUpdate(conversation);
      return { conversation };
    });
  }

  async abort(conversationId: string, requestId: string): Promise<{ cancelled: true }> {
    // Serialized through the admission lane like delivery and removal: a
    // delivery that has already started dispatching cannot be stopped by the
    // dormant flag alone, so cancellation waits for it to finish admitting
    // and then interrupts the turn it just started — while deliveries that
    // have not started find the queue paused.
    return this.receipts.run(`cancel:${conversationId}:${requestId}`, () => this.enqueuePromptAdmission(conversationId, async () => {
      await this.requireSession(conversationId);
      // Cancel means stop: held messages stay queued and removable, and none
      // of them rides the idle transition this interrupt causes. Paused
      // BEFORE the provider call — the interrupt's own idle event can reach
      // the pump before the interrupt request resolves, and an un-paused
      // queue would deliver into exactly the gap the user cancelled.
      // Keep Stop's intent even with no held entries yet: converting a paused
      // native steer to Queue later is not a new submission or a resume.
      const paused = !this.dormantQueues.has(conversationId);
      this.dormantQueues.add(conversationId);
      const stop: { resumed: boolean; status?: ConversationStatus } = { resumed: false };
      const settledBeforeStop = this.settledTurns.get(conversationId);
      this.stoppingTurns.set(conversationId, stop);
      try {
        // Without resume: pending steers stay with the agent, unwoken, and
        // read as paused once the interrupt settles the turn (D9).
        await this.provider.interrupt(conversationId, { resume: false });
        if (!stop.resumed) this.projection(conversationId).statusUpdate("interrupted");
        this.publishPausedChanges(conversationId);
        return { cancelled: true };
      } catch (error) {
        // A failed response cannot establish non-application, even without a
        // terminal stream event. Keep Stop's queue intent without inventing
        // an interruption or retrying the native request.
        if (error instanceof InterruptNotAppliedError && paused && !stop.resumed && this.settledTurns.get(conversationId) === settledBeforeStop) this.dormantQueues.delete(conversationId);
        this.publishPausedChanges(conversationId);
        throw error;
      } finally {
        // Recreate an evicted view before its request-scoped observer retires,
        // including a newer run's completion after an uncertain old response.
        if (stop.resumed) this.projection(conversationId);
        this.stoppingTurns.delete(conversationId);
      }
    }));
  }

  undo(conversationId: string, requestId: string): Promise<ReversibleHistoryResult> {
    return this.runReversibleMutation("undo", conversationId, requestId);
  }

  redo(conversationId: string, requestId: string): Promise<ReversibleHistoryResult> {
    return this.runReversibleMutation("redo", conversationId, requestId);
  }

  revert(conversationId: string, messageId: string, requestId: string): Promise<ReversibleHistoryResult> {
    return this.runReversibleMutation("revert", conversationId, requestId, messageId);
  }

  restore(conversationId: string, messageId: string, requestId: string): Promise<ReversibleHistoryResult> {
    return this.runReversibleMutation("restore", conversationId, requestId, messageId);
  }

  private runReversibleMutation(operation: "undo" | "redo" | "revert" | "restore", conversationId: string, requestId: string, messageId?: string): Promise<ReversibleHistoryResult> {
    return this.receipts.run(`${operation}:${conversationId}:${requestId}`, () =>
      this.enqueuePromptAdmission(conversationId, async () => {
        const provider = this.requireReversibleHistoryProvider();
        await this.requireSession(conversationId);
        const before = operation === "revert" || operation === "restore"
          ? await this.reconcileReversibleHistory(conversationId)
          : await provider.getReversibleHistoryState(conversationId);
        this.rememberReversibleHistory(conversationId, before);
        if (operation === "undo" && !before.canUndo) {
          return { outcome: "nothing-to-undo", state: before };
        }
        if (operation === "redo" && !before.canRedo) {
          return { outcome: "nothing-to-redo", state: before };
        }
        if (operation === "revert") {
          const target = this.projection(conversationId).items().find(item => item.id === messageId);
          if (target?.type !== "user_message") throw new ReversibleHistoryTargetError();
        }
        if (operation === "restore" && !before.revertedMessages.some(message => message.id === messageId)) {
          throw new ReversibleHistoryTargetError();
        }

        this.reversibleMutations.add(conversationId);
        this.publishPausedChanges(conversationId);
        try {
          if ((operation === "undo" || operation === "revert") && this.turnActive(conversationId, this.projection(conversationId))) {
            // Pause first. OpenCode can publish idle before interrupt() returns.
            // Without resume: the steers stay pending for the replacement.
            await this.provider.interrupt(conversationId, { resume: false });
            this.projection(conversationId).statusUpdate("interrupted");
          }
          const result = operation === "undo"
            ? await provider.undo(conversationId)
            : operation === "redo"
              ? await provider.redo(conversationId)
              : operation === "revert"
                ? await provider.revert(conversationId, messageId!)
                : await provider.restore(conversationId, messageId!);
          const normalized = await this.normalizeRestoredDraft(result);
          let state = normalized.state;
          try {
            state = await this.reconcileReversibleHistory(conversationId);
          } catch {
            // The boundary already moved. Keep its receipt idempotent and the
            // queue conservatively paused from the provider's returned state;
            // its lifecycle event can retry the authoritative read.
            this.rememberReversibleHistory(conversationId, normalized.state);
          }
          if (!state.staged) this.dormantQueues.delete(conversationId);
          return { ...normalized, state };
        } catch (error) {
          this.rememberReversibleHistory(conversationId, before);
          throw error;
        } finally {
          this.reversibleMutations.delete(conversationId);
          this.scheduleDelivery(conversationId);
          this.publishPausedChanges(conversationId);
        }
      }));
  }

  private requireReversibleHistoryProvider(): Required<Pick<ChatProvider, "getReversibleHistoryState" | "undo" | "redo" | "revert" | "restore">> {
    if (!this.provider.describe().capabilities.includes("reversible-history")
      || !this.provider.getReversibleHistoryState || !this.provider.undo || !this.provider.redo
      || !this.provider.revert || !this.provider.restore) {
      throw new ReversibleHistoryUnsupportedError();
    }
    return {
      getReversibleHistoryState: this.provider.getReversibleHistoryState.bind(this.provider),
      undo: this.provider.undo.bind(this.provider),
      redo: this.provider.redo.bind(this.provider),
      revert: this.provider.revert.bind(this.provider),
      restore: this.provider.restore.bind(this.provider),
    };
  }

  private async readReversibleHistoryState(conversationId: string): Promise<ReversibleHistoryState | undefined> {
    if (!this.agent().capabilities.includes("reversible-history")) return undefined;
    const state = await this.requireReversibleHistoryProvider().getReversibleHistoryState(conversationId);
    this.rememberReversibleHistory(conversationId, state);
    return state;
  }

  private rememberReversibleHistory(conversationId: string, state: ReversibleHistoryState): void {
    const previous = this.reversibleHistory.get(conversationId);
    this.reversibleHistory.set(conversationId, state);
    if (previous?.staged && !state.staged) this.scheduleDelivery(conversationId);
  }

  private async normalizeRestoredDraft(result: ReversibleHistoryResult): Promise<ReversibleHistoryResult> {
    const draft = result.restoredDraft;
    if (!draft?.attachments?.length) return result;
    const attachments: MessageAttachment[] = [];
    for (const attachment of draft.attachments) {
      if (!attachment.id || !this.resolveAttachment) {
        attachments.push({ name: attachment.name, mimeType: attachment.mimeType });
        continue;
      }
      try {
        const stored = await this.resolveAttachment(attachment.id);
        attachments.push(stored
          ? { id: stored.id, name: attachment.name, mimeType: stored.mimeType }
          : { name: attachment.name, mimeType: attachment.mimeType });
      } catch {
        attachments.push({ name: attachment.name, mimeType: attachment.mimeType });
      }
    }
    const restoredDraft: RestoredDraft = { text: draft.text, attachments };
    return { ...result, restoredDraft };
  }

  private async reconcileReversibleHistory(conversationId: string, isCurrent?: () => boolean): Promise<ReversibleHistoryState> {
    if (this.provider.waitForEventStream) {
      if (!this.pumpPromise) void this.startEventPump().catch(() => undefined);
      const projection = this.projection(conversationId);
      const before = projection.items();
      const previous = this.reversibleHistory.get(conversationId);
      // Native replacement consumes the same bounded, generation-covered
      // history reconciliation as navigation. Optional page omissions cannot
      // discard known workers or renew their control authority.
      const snapshot = await this.readCoveredHistory(conversationId, { limit: RECONSTRUCTION_READ_LIMIT }, { dirty: false }, { isCurrent });
      const state = snapshot.reversibleHistory!;
      if (!sameReversibleHistory(previous, state) || !sameConversationItems(before, snapshot.items)) await this.rebuildChildAttribution(conversationId);
      return state;
    }
    const provider = this.requireReversibleHistoryProvider();
    const [items, state] = await Promise.all([
      this.authoritativeVisibleHistory(conversationId, isCurrent),
      provider.getReversibleHistoryState(conversationId),
    ]);
    if (this.disposed || (isCurrent && !isCurrent())) throw new Error("reversible history reconciliation was cancelled");
    const projection = this.projection(conversationId);
    const changed = !sameReversibleHistory(this.reversibleHistory.get(conversationId), state)
      || !sameConversationItems(projection.items(), items);
    // No buffered update from the discarded branch may apply after replace.
    this.eventCoalescer?.discard(conversationId);
    this.rememberReversibleHistory(conversationId, state);
    if (changed) {
      // The replacement is the provider's raw rows: a launcher among them
      // carries no attribution, so the banked tallies go back on before
      // they replace what the client shows.
      await this.attributeLaunchers(conversationId, items, items);
      projection.replace(items);
      // A revert in a subagent rewrote what its store holds: the tally its
      // parent banked for it — and the line every ancestor lists for it —
      // counts spend that is gone, and no removal event says so.
      // Forget it, square against the rewritten store, and put the fresh
      // figure on the launching row.
      await this.rebuildChildAttribution(conversationId);
    }
    projection.reconciledHistoryVisibility = { state };
    return state;
  }

  private async rebuildChildAttribution(childId: string): Promise<void> {
    let parentId: string | null;
    try {
      parentId = await this.parentOf(childId);
    } catch {
      return;
    }
    if (!parentId) return;
    const key = attributionKey(parentId, childId);
    // A read in flight for the old store must not bank what it finds.
    this.attributionReadEpoch(key, true);
    this.childUsage.delete(key);
    this.childModels.delete(key);
    this.childPrompts.delete(key);
    this.childTranscripts.delete(key);
    this.removedLaunchers.delete(key);
    this.removedChildAttribution.delete(key);
    this.attributionArrivals.delete(key);
    this.completeAttributions.delete(key);
    // Retain evidence through queued publication, within the same native
    // optional budget. Ancestor queries cannot extend reconstruction's window.
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, ...(this.pumpController ? [this.pumpController.signal] : [])]);
    const sources = this.provider.watchWorkerAssociations ? new WorkerSourceRead(signal) : undefined;
    const timer = sources ? setTimeout(() => lifetime.abort(), this.accountingReadTimeoutMs) : undefined;
    try {
      const expired = new Promise<void>(resolve => {
        if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await Promise.race([(async () => {
        if (sources) {
          // The child's own page watches its outgoing edges, not this incoming
          // association. Counterproof during reconstruction also fences repricing.
          const incoming = this.provider.watchWorkerAssociations!(parentId, [childId], { signal }).snapshot();
          sources.observe(incoming.workerSource);
          if (incoming.contradictedChildren.includes(childId)) return;
        }
        await this.reconstructAttribution(parentId, childId, new Set(), signal, sources);
        // The dedupe may have handed back that stale in-flight read; it banks
        // nothing, so square once more from a clean start.
        if (!this.completeAttributions.has(key)) await this.reconstructAttribution(parentId, childId, new Set(), signal, sources);
        if (signal.aborted || this.disposed) return;
        sources?.assertCurrent();
        const coalescer = this.eventCoalescer;
        if (!coalescer) return;
        this.decorateLauncherRows(parentId, childId, coalescer, sources);
        if (sources && this.projections.has(parentId)) {
          coalescer.flushAll();
          await coalescer.settled();
          if (signal.aborted) return;
        }
        if (sources) await this.refreshRewrittenAncestors(parentId, childId, sources, signal, coalescer);
        else await this.refreshAncestors(parentId, coalescer);
        coalescer.flushAll();
        await coalescer.settled();
      })(), expired]);
    } catch (error) {
      // The mutation's required history already published. A changed optional
      // source cannot reprice its old association or undo that accepted result.
      if (!signal.aborted && !(error instanceof HistoryReadChangedError)) throw error;
    } finally { clearTimeout(timer); lifetime.abort(); }
  }

  private scheduleRevertReconciliation(conversationId: string, lifecycle: RevertLifecycle): void {
    if (this.disposed) return;
    const existing = this.revertReconciliations.get(conversationId);
    if (existing) {
      existing.revision += 1;
      existing.lifecycle = lifecycle;
      return;
    }
    const pending: RevertReconciliation = {
      revision: 1,
      lifecycle,
      failures: 0,
      running: false,
      timer: null,
    };
    this.revertReconciliations.set(conversationId, pending);
    void this.runRevertReconciliation(conversationId, pending);
  }

  private async runRevertReconciliation(conversationId: string, pending: RevertReconciliation): Promise<void> {
    if (this.disposed || this.revertReconciliations.get(conversationId) !== pending || pending.running) return;
    pending.running = true;
    const revision = pending.revision;
    const isCurrent = () => this.revertReconciliations.get(conversationId) === pending && pending.revision === revision;
    try {
      await this.enqueuePromptAdmission(conversationId, async () => {
        if (!isCurrent()) return;
        await this.requireSession(conversationId);
        if (!isCurrent()) return;
        await this.reconcileReversibleHistory(conversationId, isCurrent);
      });
      pending.running = false;
      pending.failures = 0;
      if (this.disposed || this.revertReconciliations.get(conversationId) !== pending) return;
      if (pending.revision !== revision) {
        void this.runRevertReconciliation(conversationId, pending);
        return;
      }
      this.finishRevertReconciliation(conversationId, pending);
    } catch {
      pending.running = false;
      if (this.disposed || this.revertReconciliations.get(conversationId) !== pending) return;
      if (pending.revision !== revision) {
        pending.failures = 0;
        void this.runRevertReconciliation(conversationId, pending);
        return;
      }
      pending.failures = Math.min(pending.failures + 1, 5);
      const exponent = Math.min(pending.failures - 1, 4);
      const delay = Math.min(REVERT_RECONCILIATION_INITIAL_RETRY_MS * 2 ** exponent, REVERT_RECONCILIATION_MAX_RETRY_MS);
      pending.timer = setTimeout(() => {
        pending.timer = null;
        void this.runRevertReconciliation(conversationId, pending);
      }, delay);
    }
  }

  private finishRevertReconciliation(conversationId: string, pending: RevertReconciliation): void {
    if (this.revertReconciliations.get(conversationId) !== pending) return;
    if (pending.timer !== null) clearTimeout(pending.timer);
    this.revertReconciliations.delete(conversationId);
    this.scheduleDelivery(conversationId);
  }

  private cancelRevertReconciliation(conversationId: string): void {
    const pending = this.revertReconciliations.get(conversationId);
    if (!pending) return;
    pending.revision += 1;
    if (pending.timer !== null) clearTimeout(pending.timer);
    this.revertReconciliations.delete(conversationId);
  }

  private async authoritativeVisibleHistory(conversationId: string, isCurrent?: () => boolean): Promise<ConversationItem[]> {
    const items: ConversationItem[] = [];
    let cursor: string | undefined;
    do {
      if (isCurrent && !isCurrent()) throw new Error("reversible history reconciliation was cancelled");
      const page = await this.provider.listMessages(conversationId, { cursor, limit: RECONSTRUCTION_READ_LIMIT });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    if (!this.liveTurns.has(conversationId)) {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]!;
        if ((item.type === "tool" || item.type === "command" || item.type === "reasoning") && (item.status === "running" || item.status === "pending")) {
          items[index] = { ...item, status: "cancelled" };
        }
        // A foreground run (a typed command's) is part of the turn that ran
        // it, not background work the provider lists: with no turn live, it
        // is over whatever its row last said.
        if (item.type === "background_task" && item.foreground && item.status === "running") {
          items[index] = { ...item, status: "stopped" };
        }
      }
    }
    items.sort((left, right) => left.createdAt - right.createdAt);
    return [...new Map(items.map(item => [item.id, item])).values()];
  }

  respondPermission(conversationId: string, requestId: string, clientRequestId: string, outcome: PermissionOutcome, choiceId?: string): Promise<{ outcome: PermissionOutcome }> {
    return this.receipts.run(`permission:${conversationId}:${requestId}:${clientRequestId}`, async () => {
      const session = await this.requireSession(conversationId);
      const projection = this.projection(conversationId);
      // A subagent's request can be answered from the parent without its own
      // transcript ever having been opened, so the owning projection may be
      // empty. Reconcile it against OpenCode's pending set before judging the
      // request stale — otherwise the card is visible, answerable, and refused.
      if (!projection.has(`permission:${requestId}`)) await this.seedPendingPermissions(conversationId);
      projection.requirePending(requestId, "permission");
      // An approval intent is only meaningful against what the card
      // offered: a rejection carries none, an offered set requires one of
      // its own ids, and a generic permission accepts none — otherwise a
      // Claude plan silently maps an unknown intent to implement, or a
      // rejection renders as though a choice was approved.
      const pendingItem = projection.items().find(item => item.id === `permission:${requestId}`);
      const offered = (pendingItem?.type === "permission" ? pendingItem.choices ?? [] : []).map(choice => choice.id);
      if (outcome === "rejected") {
        if (choiceId !== undefined) throw new InvalidPermissionChoiceError("a rejection does not carry an approval intent");
      } else if (offered.length > 0) {
        if (choiceId === undefined || !offered.includes(choiceId)) {
          throw new InvalidPermissionChoiceError(`the approval must name one of the offered intents: ${offered.join(", ")}`);
        }
      } else if (choiceId !== undefined) {
        throw new InvalidPermissionChoiceError("this permission offers no approval intents");
      }
      const reply: ProviderPermissionReply = outcome === "approved-once" ? "once" : outcome === "approved-session" ? "always" : "reject";
      await this.provider.replyPermission(conversationId, requestId, reply, choiceId);
      projection.resolvePermission(requestId, outcome, choiceId);
      await this.observeNotifications({ conversationId, updates: [{ kind: "remove", itemId: `permission:${requestId}` }], outcome: "handled", eventType: "permission.answered" });
      this.resolveMirroredCopy(session.parentId, `permission:${requestId}`, parent => parent.resolvePermission(requestId, outcome, choiceId));
      return { outcome };
    });
  }

  /**
   * Stops one of the conversation's running background tasks. The agent
   * reports the stop as that task settling, which is what the timeline
   * records; this only carries the request.
   */
  /** The login's plan usage as the provider last read it; null when nothing has been read. */
  async usage(): Promise<AgentUsageReport | null> {
    if (!this.provider.usageReport || !this.provider.describe().capabilities.includes("usage")) throw new UsageUnsupportedError();
    return (await this.provider.usageReport()) ?? null;
  }

  /**
   * Read plan usage now. Idempotent per client request id, and one read at
   * a time across request ids: a second ask while one is out joins it
   * rather than starting another (spec) — when the one out answers at
   * least as much. A "start" asked while a live-only read is out runs
   * after it: joined, it would be told "no-live-session" for the session
   * it asked to start.
   */
  readUsage(clientRequestId: string, mode: UsageReadMode): Promise<UsageReadResult> {
    return this.receipts.run(`usage-read:${clientRequestId}`, async () => {
      const provider = this.provider;
      if (!provider.readUsage || !provider.describe().capabilities.includes("usage")) throw new UsageUnsupportedError();
      const inFlight = this.usageRead;
      if (inFlight && (inFlight.mode === mode || mode === "live-only")) return inFlight.promise;
      const run = inFlight ? inFlight.promise.catch(() => undefined).then(() => provider.readUsage!(mode)) : provider.readUsage(mode);
      const entry = { mode, promise: run };
      entry.promise = run.finally(() => { if (this.usageRead === entry) this.usageRead = null; });
      this.usageRead = entry;
      return entry.promise;
    });
  }

  private usageRead: { mode: UsageReadMode; promise: Promise<UsageReadResult> } | null = null;

  async stopTask(conversationId: string, taskId: string, clientRequestId: string): Promise<{ stopped: true }> {
    const result = await this.receipts.run(`stop-task:${conversationId}:${taskId}:${clientRequestId}`, async () => {
      await this.requireSession(conversationId);
      if (!this.provider.stopTask || !this.provider.describe().capabilities.includes("background-tasks")) throw new BackgroundTasksUnsupportedError();
      try { await this.provider.stopTask(conversationId, taskId); }
      catch (error) { if (error instanceof OperationOutcomeUnknownError) return { unknown: true as const }; throw error; }
      return { stopped: true as const };
    });
    if ("unknown" in result) throw new OperationOutcomeUnknownError();
    return result;
  }

  async backgroundBlockingWork(conversationId: string, requestId: string): Promise<{ accepted: true }> {
    const result = await this.receipts.run(`background:${conversationId}:${requestId}`, () => this.enqueuePromptAdmission(conversationId, async () => {
      await this.requireSession(conversationId);
      try { await this.backgroundBlockingWorkInternal(conversationId); }
      catch (error) { if (error instanceof OperationOutcomeUnknownError) return { unknown: true as const }; throw error; }
      return { accepted: true as const };
    }));
    if ("unknown" in result) throw new OperationOutcomeUnknownError();
    return result;
  }

  async generate(conversationId: string, _requestId: string, question: string): Promise<{ text: string }> {
    await this.requireSession(conversationId);
    if (!this.provider.generate || !this.agent().capabilities.includes("side-generation")) throw new SideGenerationUnsupportedError();
    // Independent of admission: do not wait for or interrupt a foreground turn.
    // Do not cache personal side questions in workspace-shared action receipts.
    // The initiating page guards concurrent clicks and never replays on reconnect.
    return { text: await this.provider.generate!(conversationId, [
      "The user is asking a quick side question about the conversation so far.",
      "Answer directly and concisely in markdown from what you already know.",
      "Do not call any tools and do not take any actions.",
      "", question,
    ].join("\n")) };
  }

  private actionReceiptKey(action: string, conversationId: string, requestId: string, context?: ChatActionContext, operationReceipt?: string): string {
    if (context) return JSON.stringify([context.receiptScope, action, conversationId, requestId]);
    return operationReceipt ? JSON.stringify(["opaque-operation", operationReceipt, action, conversationId, requestId]) : `${action}:${conversationId}:${requestId}`;
  }

  private async steerActionReceipt<T extends object>(key: string, operation: () => Promise<T>): Promise<T> {
    const result = await this.receipts.run<T | { primarySteerUnknown: true }>(key, async () => {
      try { return await operation(); }
      catch (error) {
        if (error instanceof PrimarySteerOutcomeUnknownError) return { primarySteerUnknown: true };
        throw error;
      }
    });
    if ("primarySteerUnknown" in result) throw new OperationOutcomeUnknownError();
    return result;
  }

  private async boundedSteerAdmission<T>(operation: Promise<T>, messageId?: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PrimarySteerOutcomeUnknownError(messageId)), this.steerAdmissionTimeoutMs);
    });
    try { return await Promise.race([operation, timeout]); }
    catch (error) { if (error instanceof OperationOutcomeUnknownError) throw new PrimarySteerOutcomeUnknownError(messageId); throw error; }
    finally { clearTimeout(timer); }
  }

  private async backgroundBlockingWorkInternal(conversationId: string): Promise<void> {
    if (!this.provider.backgroundBlockingWork || !this.agent().capabilities.includes("background-blocking-work")) throw new BackgroundTasksUnsupportedError();
    await this.provider.backgroundBlockingWork(conversationId);
  }

  // Called only after acknowledged admission/resume and its pending-state
  // commit, inside the original receipt/admission lane. No recursive lane.
  private async followAcceptedSteer<T extends object>(conversationId: string, accepted: T, context?: ChatActionContext): Promise<T & AutomaticBackgroundFeedback> {
    const capabilities = this.agent().capabilities;
    if (!context || context.automaticBackground === "off" || !capabilities.includes("steering") || !capabilities.includes("background-blocking-work")) return accepted;
    const outcome = (automaticBackground: AutomaticBackgroundOutcome) => ({ ...accepted, automaticBackground });
    if (context.automaticBackground === "unavailable") return outcome("unavailable");
    let expired = false, dispatched = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T & AutomaticBackgroundFeedback>(resolve => {
      timer = setTimeout(() => { expired = true; resolve(outcome(dispatched ? "unknown" : "unavailable")); }, this.automaticBackgroundTimeoutMs);
    });
    const follow = (async () => {
      try { await this.requireSession(conversationId); } catch { return outcome("unavailable"); }
      if (expired) return outcome("unavailable");
      let items = this.projection(conversationId).items();
      try {
        if (this.provider.reconcileBackgroundTasks) {
          const tasks = await this.provider.reconcileBackgroundTasks(conversationId, { fresh: true });
          // Foreground shells remain running tool rows, not background-task
          // rows. Read the same fresh parent history rather than waiting for
          // an event frame to reach the adapter or installing a later watcher.
          const page = await this.provider.listMessages(conversationId, { limit: DEFAULT_PAGE_SIZE });
          const current = this.projection(conversationId).items();
          const evidence = new Map(current.filter(item => item.type !== "background_task").map(item => [item.id, item]));
          for (const item of page.completeItems ?? page.items) {
            if (item.type !== "tool" && item.type !== "command") continue;
            const newer = current.find(candidate => candidate.id === item.id);
            evidence.set(item.id, item.status === "running" && newer && (newer.type === "tool" || newer.type === "command") && newer.status !== "running" && newer.status !== "pending" ? newer : item);
          }
          const ids = new Set(tasks.map(task => task.id));
          items = [
            ...evidence.values(),
            ...current.filter((item): item is BackgroundTaskItem => item.type === "background_task" && !ids.has(item.id)).map(item => item.status === "running" ? unverifyWorkerTask(item) : item),
            ...tasks.map(task => {
              const settled = current.find(item => item.id === task.id && item.type === "background_task" && item.status !== "running");
              return task.status === "running" && settled ? settled : task;
            }),
          ];
        }
      } catch { return outcome("unavailable"); }
      if (expired) return outcome("unavailable");
      if (!hasVerifiedBlockingWork(this.projection(conversationId).status, items)) return outcome("not-needed");
      dispatched = true;
      try { await this.backgroundBlockingWorkInternal(conversationId); return outcome("accepted"); }
      catch (error) { return outcome(error instanceof OperationOutcomeUnknownError ? "unknown" : "failed"); }
    })();
    try { return await Promise.race([follow, timeout]); }
    finally { clearTimeout(timer); }
  }

  /**
   * Release a conversation held for its scheduled wakeups (D5): the agent's
   * session ends, its wakeups read as cancelled, and the conversation is
   * idle. Serialized with deliveries so a held prompt the idle status
   * releases lands in a fresh session, not the one being retired.
   */
  /** Cancel one wakeup, live or paused (D12): it never fires again. */
  cancelWakeup(conversationId: string, wakeupId: string, clientRequestId: string): Promise<{ cancelled: true }> {
    return this.receipts.run(`cancel-wakeup:${conversationId}:${wakeupId}:${clientRequestId}`, async () => {
      await this.requireSession(conversationId);
      if (!this.provider.cancelWakeup || !this.provider.describe().capabilities.includes("scheduled-wakeups")) throw new ScheduledWakeupsUnsupportedError();
      await this.provider.cancelWakeup(conversationId, wakeupId);
      return { cancelled: true as const };
    });
  }

  release(conversationId: string, clientRequestId: string): Promise<{ released: true }> {
    return this.receipts.run(`release:${conversationId}:${clientRequestId}`, () => this.enqueuePromptAdmission(conversationId, async () => {
      await this.requireSession(conversationId);
      if (!this.provider.release || !this.provider.describe().capabilities.includes("scheduled-wakeups")) throw new ScheduledWakeupsUnsupportedError();
      await this.provider.release(conversationId);
      return { released: true as const };
    }));
  }

  /**
   * The output a task has produced so far: a read, not a mutation, so no
   * receipt. Gated like stop — only an agent with background work can be
   * asked — and the provider decides whether this task has an output file.
   */
  async taskOutput(conversationId: string, taskId: string, options: { tailBytes: number }): Promise<BackgroundTaskOutput | null> {
    await this.requireSession(conversationId);
    if (!this.provider.taskOutput || !this.provider.describe().capabilities.includes("background-tasks")) throw new BackgroundTasksUnsupportedError();
    return this.provider.taskOutput(conversationId, taskId, options);
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
      await this.observeNotifications({ conversationId, updates: [{ kind: "remove", itemId: `question:${requestId}` }], outcome: "handled", eventType: "question.answered" });
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
    // An evicted parent has no copy left to resolve, but its eviction-proof
    // pending record must not outlive the answer.
    else this.trackInteraction(parentId, itemId, false);
  }

  // Counts an event the pump could not use, by type. Never records a payload:
  // a payload can carry file contents, and the count is what is actionable.
  private countDiscard(outcome: "unrecognized" | "unparseable", eventType: string): void {
    if (!this.metrics) return;
    this.metrics.inc(`chat.event.${outcome}.${this.countedType("event", eventType)}`);
  }

  // Counts a content block (or part) skipped inside a recognized event, by
  // block type, under the same distinct-type cap as events.
  private countSkippedBlock(blockType: string): void {
    if (!this.metrics) return;
    this.metrics.inc(`chat.block.unrecognized.${this.countedType("block", blockType)}`);
  }

  // The counter key for a type: itself while the bounded key space has room,
  // `other` once it is full. Events and blocks share the one budget.
  private countedType(space: "event" | "block", name: string): string {
    const type = name || "unknown";
    const seen = `${space}:${type}`;
    if (this.countedEventTypes.has(seen)) return type;
    if (this.countedEventTypes.size >= MAX_COUNTED_EVENT_TYPES) return "other";
    this.countedEventTypes.add(seen);
    return type;
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
  /**
   * `ancestry` is the chain of sessions whose reads this one is nested in. A
   * grandchild found in the read is reconstructed in turn; one that leads back
   * into that chain (a loop in the data) is skipped rather than awaited, since
   * the in-flight dedupe would hand back the very promise being waited on. An
   * independent read of the same child already in flight — the child's own
   * transcript opened at the same moment — is not on the chain, and is awaited
   * like any other so its figure lands here too.
   */
  private reconstructAttribution(parentId: string, childId: string, ancestry: ReadonlySet<string> = new Set(), signal?: AbortSignal, sources?: WorkerSourceRead): Promise<void> {
    if (this.provider.waitForEventStream) return this.reconstructNativeAttribution(parentId, childId, ancestry, signal, sources);
    const key = attributionKey(parentId, childId);
    const existing = this.attributionReconstructions.get(key);
    if (existing) return existing;
    const epoch = this.attributionReadEpoch(key);
    const pending = this.reconstructAttributionRead(key, childId, epoch, new Set([...ancestry, childId])).finally(() => {
      if (this.attributionReconstructions.get(key) === pending) {
        this.attributionReconstructions.delete(key);
      }
    });
    this.attributionReconstructions.set(key, pending);
    return pending;
  }

  private async reconstructNativeAttribution(parentId: string, childId: string, ancestry: ReadonlySet<string>, callerSignal?: AbortSignal, sources?: WorkerSourceRead): Promise<void> {
    if (callerSignal?.aborted || this.disposed) return;
    const key = attributionKey(parentId, childId);
    let owner = this.nativeAccountingReads.get(key);
    if (!owner || owner.controller.signal.aborted) {
      const controller = new AbortController();
      const signal = controller.signal;
      const timer = setTimeout(() => controller.abort(), this.accountingReadTimeoutMs);
      const retired = new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      const current = { controller, promise: Promise.resolve(), callers: 0, sources: new WorkerSourceRead(signal) };
      this.nativeAccountingReads.set(key, current);
      const epoch = this.attributionReadEpoch(key);
      // Completeness belongs to this refresh, not an earlier successful read.
      // Clear it while this owner is current, before any await: failure,
      // expiry or incomplete descendants must also leave ancestors retryable.
      // Retired reads cannot clear a newer owner's successful stamp later.
      this.completeAttributions.delete(key);
      current.promise = Promise.race([
        this.reconstructAttributionRead(key, childId, epoch, new Set([...ancestry, childId]), signal, current.sources),
        retired,
      ]).finally(() => {
        clearTimeout(timer);
        controller.abort();
        if (this.nativeAccountingReads.get(key) === current) this.nativeAccountingReads.delete(key);
      });
      owner = current;
    }
    owner.callers++;
    const unfollow = sources ? owner.sources.follow(sources) : undefined;
    let departed: (() => void) | undefined;
    try {
      if (!callerSignal) await owner.promise;
      else await Promise.race([owner.promise, new Promise<void>(resolve => {
        departed = () => resolve();
        callerSignal.addEventListener("abort", departed, { once: true });
        if (callerSignal.aborted) resolve();
      })]);
    } finally {
      unfollow?.();
      if (departed) callerSignal!.removeEventListener("abort", departed);
      // A waiter cannot retire work still serving another current caller.
      if (--owner.callers === 0) owner.controller.abort();
    }
  }

  private invalidateNativeHistoryAccounting(): void {
    for (const owner of this.nativeAccountingReads.values()) owner.controller.abort();
    this.nativeAccountingReads.clear();
    // V2 has no replay. A previous generation's completeness (or pending
    // reconstruction) cannot stand in for the child's current stored history.
    this.completeAttributions.clear();
    this.attributionReconstructions.clear();
    for (const [key, owner] of this.attributionEpochs) this.attributionEpochs.set(key, {
      epoch: ++this.attributionSequence,
      allocationRevision: 0,
      allocationOccurrences: owner.allocationOccurrences,
      ...(this.provider.watchWorkerAssociations ? { allocationFloor: owner.allocationFloor ?? 0,
        generationOnly: owner.allocationFloor === undefined || owner.generationOnly === true } : {}),
    });
  }

  private revokeChildAttribution(parentId: string, childId: string): void {
    const key = attributionKey(parentId, childId);
    this.attributionReadEpoch(key, true);
    this.nativeAccountingReads.get(key)?.controller.abort();
    this.childUsage.delete(key); this.childModels.delete(key); this.childPrompts.delete(key); this.childTranscripts.delete(key);
    this.childSessionCosts.delete(key); this.completeAttributions.delete(key);
  }

  private watchCachedAssociations(read: CachedAssociationRead, pending?: { key: string; transcript: ChildTranscript }): void {
    const visited = new Set<string>();
    const visit = (parentId: string, childId: string, ancestry: ReadonlySet<string>, ownerKey?: string) => {
      if (ancestry.has(childId)) return;
      read.include(parentId, childId, ownerKey);
      const key = attributionKey(parentId, childId);
      if (visited.has(key)) return;
      visited.add(key);
      const next = new Set([...ancestry, childId]);
      const transcript = pending?.key === key ? pending.transcript : this.childTranscripts.get(key);
      for (const launcher of transcript?.launchers ?? []) visit(childId, launcher.conversationId, next, key);
    };
    const prefix = `${read.id}${ATTRIBUTION_SEPARATOR}`;
    const keys = new Set(this.childTranscripts.keys());
    if (pending) keys.add(pending.key);
    for (const key of keys) if (key.startsWith(prefix)) visit(read.id, key.slice(prefix.length), new Set([read.id]));
  }

  private bankChildTranscript(key: string, transcript: ChildTranscript): void {
    // Register the proposed graph synchronously, before banking it or retiring
    // its producer's leases. Other readers may later import its decorated rows.
    for (const read of this.nativeAssociationReads) this.watchCachedAssociations(read, { key, transcript });
    this.bankAttribution(this.childTranscripts, key, transcript);
  }

  private watchProjectionAssociations(id: string, item: ConversationItem): void {
    if ((item.type !== "tool" && item.type !== "background_task") || !item.childConversationId) return;
    const reads = [...this.nativeAssociationReads].filter(read => read.id === id);
    if (!reads.length) return;
    for (const read of reads) read.include(id, item.childConversationId);
    if (item.type !== "tool" || !item.descendants?.length) return;
    type Node = { session: string; ownerKey: string; ancestry: ReadonlySet<string> };
    const nodes = new Map<string, Node>([[item.id, { session: item.childConversationId, ownerKey: attributionKey(id, item.childConversationId), ancestry: new Set([id, item.childConversationId]) }]]);
    const lines = new Map(item.descendants.map(line => [line.id, line]));
    const visit = (line: SubagentLine, ancestry: ReadonlySet<string>): Node | undefined => {
      if (ancestry.has(line.id)) return;
      const known = nodes.get(line.id);
      if (known) return known;
      const next = new Set([...ancestry, line.id]);
      const parentLine = lines.get(line.parentId);
      const parent = nodes.get(line.parentId) ?? (parentLine ? visit(parentLine, next) : undefined);
      if (!parent || parent.ancestry.has(line.conversationId)) return;
      for (const read of reads) read.include(parent.session, line.conversationId, parent.ownerKey);
      const node = { session: line.conversationId, ownerKey: attributionKey(parent.session, line.conversationId), ancestry: new Set([...parent.ancestry, line.conversationId]) };
      nodes.set(line.id, node);
      return node;
    };
    for (const line of item.descendants) visit(line, new Set());
  }

  private revokeCachedAssociations(evidence: CachedAssociationCounterproof): void {
    if (!evidence.childIds.length) return;
    const revoked = new Set(evidence.childIds);
    for (const child of revoked) this.revokeChildAttribution(evidence.parentId, child);
    for (const key of evidence.transcriptKeys) {
      const transcript = this.childTranscripts.get(key);
      if (!transcript) continue;
      const launchers = transcript.launchers.filter(launcher => !revoked.has(launcher.conversationId));
      if (launchers.length === transcript.launchers.length) continue;
      // Retire only this parent transcript's old reconstruction. Preserve its
      // own known spend/prompts while withdrawing the contradicted child edge.
      this.attributionReadEpoch(key, true);
      this.nativeAccountingReads.get(key)?.controller.abort();
      this.completeAttributions.delete(key);
      this.bankChildTranscript(key, { ...transcript, launchers });
    }
  }

  private async reconstructAttributionRead(key: string, childId: string, epoch: number, ancestry: ReadonlySet<string>, signal?: AbortSignal, sources?: WorkerSourceRead): Promise<void> {
    const byMessage = new Map<string, TokenUsage>();
    const byModel = new Map<string, MessageModel>();
    const byPrompt = new Map<string, string>();
    let transcript: ChildTranscript;
    let descendantsIncomplete = false;
    let sessionCostUsd: number | undefined;
    const readStartedAt = this.attributionSequence;
    const revokedDescendants = new Set<string>();
    const sourceGuards: Array<() => boolean> = [];
    let inventorySignature: string | undefined;
    let ownSignature: string | undefined;
    let progressiveOwn = false;
    let currentLauncher: ((launcher: Launcher) => boolean) | undefined;
    let descendantIds: string[] = [];
    const reconstructDescendants = async () => {
      for (const grandchildId of descendantIds) {
        signal?.throwIfAborted();
        await this.reconstructAttribution(childId, grandchildId, ancestry, signal, sources);
        if (!this.completeAttributions.has(attributionKey(childId, grandchildId))) descendantsIncomplete = true;
      }
    };
    try {
      // Every message, in one read: banking a partial tally would permanently
      // underreport the child, because a banked key is never re-read. The
      // read asks for effectively everything at once — the provider's paging
      // is a local slice over a fully refetched merge, so walking it in
      // fifty-message pages would fetch the whole child once per page. The
      // cursor loop stays as a backstop for a child even longer than one
      // read; pages walk newest to oldest, so the first page's last-reported
      // model is the child's newest and is kept.
      let cursor: string | undefined;
      let complete: ConversationItem[] | undefined;
      let paged: ConversationItem[] = [];
      let origins: ProviderHistoryPage["workerOriginCoverage"];
      do {
        signal?.throwIfAborted();
        const page = await this.provider.listMessages(childId, { cursor, limit: RECONSTRUCTION_READ_LIMIT, ...(signal ? { signal } : {}) });
        signal?.throwIfAborted();
        if (page.isWorkerSourceCurrent) {
          if (!page.isWorkerSourceCurrent()) throw new HistoryReadChangedError();
          sourceGuards.push(page.isWorkerSourceCurrent);
        }
        if (page.workerSource) sources?.observe(page.workerSource, key);
        origins ??= page.workerOriginCoverage;
        for (const child of page.workerAssociationContradictions ?? []) revokedDescendants.add(child);
        if (page.visibleDescendantsIncomplete) descendantsIncomplete = true;
        sessionCostUsd = page.sessionCostUsd;
        for (const reported of page.accounting) {
          if (reported.usage) byMessage.set(reported.messageId, reported.usage);
          if (reported.model) byModel.set(reported.messageId, { model: reported.model, createdAt: reported.createdAt, effort: reported.effort });
          if (reported.promptId) byPrompt.set(reported.messageId, reported.promptId);
        }
        complete ??= page.completeItems;
        if (!complete) paged = [...page.items, ...paged];
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      // The child's prompts in order, and the subagents it launched itself,
      // each under the prompt it followed. A launcher that leads back into
      // the chain being read (a loop in the data) is not listed.
      transcript = readChildTranscript(complete ?? paged, ancestry);
      if (this.provider.watchWorkerAssociations && sources?.hasAccountingPage(key) && origins) {
        const occurrences = new Map<string, { binding: LauncherBinding; promptId: string | undefined } | undefined>();
        const children = new Map<string, string | undefined>();
        let promptId: string | undefined;
        for (const item of complete ?? paged) {
          if (item.type === "user_message") promptId = item.id.replace(/^message:/, "");
          else if (item.type === "tool") {
            if (occurrences.has(item.id)) occurrences.set(item.id, undefined);
            else if (occurrences.size < MAX_CHILD_ATTRIBUTIONS) occurrences.set(item.id, { binding: launcherBinding(item), promptId });
          }
        }
        for (const origin of origins) if (origin.taskType === "agent" && origin.toolUseId) {
          const id = `tool:${origin.toolUseId}`;
          if (children.has(id)) children.set(id, undefined);
          else if (children.size < MAX_CHILD_ATTRIBUTIONS) children.set(id, origin.childConversationId);
        }
        // Unassociated native tools can disprove a retained occurrence, never
        // admit a child. Hidden, ambiguous and changed prompt origins likewise
        // cannot reach retained binding proof. Overflow fails closed.
        currentLauncher = launcher => {
          const occurrence = occurrences.get(launcher.id);
          return occurrence !== undefined && sameLauncherBinding(launcher.binding, occurrence.binding)
            && occurrence.promptId === transcript.prompts[launcher.promptIndex]?.id && children.get(launcher.id) === launcher.conversationId;
        };
        // Native ownership leases can remain current across a newer SSE launch.
        // Fence that older occurrence inventory through enclosing publication,
        // rather than dropping the new edge or relaxing stale-cache matching.
        const liveLaunchersCurrent = currentLauncher;
        const guard = (lifetime: AbortSignal): WorkerSourceGuard => ({
          isCurrent: () => !lifetime.aborted && !this.childTranscripts.get(key)?.launchers.some(launcher =>
            (this.attributionArrivals.get(key)?.get(launcher.id) ?? 0) > readStartedAt && !liveLaunchersCurrent(launcher)),
          retain: guard,
        });
        sources.observe(guard(signal!));
      }
      // Fingerprint ONLY the provider inventory, before filtering or merging
      // cached/live prompts and launchers. Oversized proof fails closed while
      // ordinary reconstruction keeps its existing behavior and budgets.
      if (transcript.prompts.length + transcript.launchers.length <= MAX_CHILD_ATTRIBUTIONS) {
        ownSignature = transcriptSignature({ prompts: transcript.prompts, launchers: [] });
        if (!descendantsIncomplete && !revokedDescendants.size) inventorySignature = transcriptSignature(transcript);
      }
      transcript.launchers = transcript.launchers.filter(launcher => !revokedDescendants.has(launcher.conversationId));
      descendantIds = [...new Set(transcript.launchers.map(launcher => launcher.conversationId))];
      for (const promptId of byPrompt.values()) if (!transcript.prompts.some(prompt => prompt.id === promptId)) transcript.prompts.push({ id: promptId });
      // Only native pages carrying source leases may bank progressively.
      // Legacy/unfenced providers preserve their existing all-or-nothing read.
      progressiveOwn = Boolean(this.provider.waitForEventStream && sources?.hasAccountingPage(key));
      if (!progressiveOwn) await reconstructDescendants();
    } catch (error) {
      if (error instanceof HistoryReadChangedError) throw error;
      return;
    }
    // Eviction clears every live value this read would merge. A completion
    // from before that boundary must not repopulate the cleared maps and mark
    // a potentially incomplete answer authoritative.
    if (signal?.aborted || this.attributionEpochs.get(key)?.epoch !== epoch) return;
    if (sourceGuards.some(current => !current())) throw new HistoryReadChangedError();
    sources?.assertCurrent();
    // Commit negative association evidence only with this reconstruction's
    // still-current owner/epoch. An older or cancelled read cannot retire a
    // newer positive descendant owner, cache or inspection association.
    for (const child of revokedDescendants) this.revokeChildAttribution(childId, child);
    // Live events that landed while the read was in flight are newer than
    // the stored snapshot — for those the live figure wins, or the stale
    // snapshot would be banked permanently once the events fall behind the
    // replay cursor. A figure banked before the read began is the older
    // one: the store may have overtaken it (a partial figure seen before a
    // disconnect, the child finishing while the stream was down), so it
    // stands only where the store has nothing for that message — a tally
    // rebuilt live after an eviction, which the store read is squaring, not
    // replacing. A message the store dropped is handled where the drop is
    // seen: a removal event withdraws it, and a revert invalidates the
    // child's tally outright. V2 also orders models against this read, so
    // pre-disconnect metadata cannot overrule its current stored evidence;
    // legacy providers retain their live-model precedence.
    const live = this.childUsage.get(key);
    const arrivals = this.attributionArrivals.get(key);
    if (live) for (const [messageId, usage] of live) {
      if (!byMessage.has(messageId) || (arrivals?.get(messageId) ?? 0) > readStartedAt) byMessage.set(messageId, usage);
    }
    const liveModels = this.childModels.get(key);
    if (liveModels) for (const [messageId, model] of liveModels) {
      if (!this.provider.waitForEventStream || !byModel.has(messageId) || (arrivals?.get(messageId) ?? 0) > readStartedAt) byModel.set(messageId, model);
    }
    // Which prompt a message answers never changes, so the store's word
    // stands and a live one only fills what the store did not say. Prompts
    // and launchers seen live during the read are newer than the transcript
    // it returned, and go after it.
    const livePrompts = this.childPrompts.get(key);
    if (livePrompts) for (const [messageId, promptId] of livePrompts) if (!byPrompt.has(messageId)) byPrompt.set(messageId, promptId);
    const liveTranscript = this.childTranscripts.get(key);
    if (this.provider.watchWorkerAssociations) for (const launcher of transcript.launchers) {
      const known = liveTranscript?.launchers.find(candidate => candidate.id === launcher.id && candidate.conversationId === launcher.conversationId);
      if (known) this.carryLauncherAccounting(launcher, known);
    }
    if (liveTranscript) {
      for (const prompt of liveTranscript.prompts) if (!transcript.prompts.some(known => known.id === prompt.id)) transcript.prompts.push(prompt);
      for (const launcher of liveTranscript.launchers) if (!revokedDescendants.has(launcher.conversationId)
        && (!currentLauncher || currentLauncher(launcher)) && !transcript.launchers.some(known => known.id === launcher.id)) transcript.launchers.push(launcher);
    }
    // A launcher removed while this read was in flight is newer than the
    // transcript it returned, and must not come back with it.
    const removedLaunchers = this.removedLaunchers.get(key);
    if (removedLaunchers) transcript.launchers = transcript.launchers.filter(launcher => !removedLaunchers.has(launcher.id));
    const removed = this.removedChildAttribution.get(key);
    if (removed) for (const messageId of removed.keys()) {
      byMessage.delete(messageId);
      byModel.delete(messageId);
      byPrompt.delete(messageId);
    }
    this.bankChildUsage(key, byMessage);
    this.bankAttribution(this.childModels, key, byModel);
    this.bankAttribution(this.childPrompts, key, byPrompt);
    this.bankChildTranscript(key, transcript);
    if ((this.childSessionCosts.get(key)?.sequence ?? 0) <= readStartedAt) this.bankSessionCost(key, sessionCostUsd);
    // Own accounting is already verified under this owner, before optional
    // descendants can consume the remaining deadline. Own prompt/accounting
    // authority does not imply complete outgoing topology: missing optional
    // ownership cannot withdraw branches or validate descendant bindings.
    if (ownSignature !== undefined && sources?.hasAccountingPage(key)) sources.inventory(key, {
      ownSignature, signature: inventorySignature, owner: this.attributionEpochs.get(key)!, revision: this.attributionEpochs.get(key)!.allocationRevision,
    });
    if (progressiveOwn) try {
      await reconstructDescendants();
    } catch (error) {
      if (error instanceof HistoryReadChangedError) throw error;
      return;
    }
    if (signal?.aborted || this.attributionEpochs.get(key)?.epoch !== epoch) return;
    if (sourceGuards.some(current => !current())) throw new HistoryReadChangedError();
    sources?.assertCurrent();
    if (this.provider.watchWorkerAssociations) for (const launcher of transcript.launchers) {
      const childKey = attributionKey(childId, launcher.conversationId);
      if (sources?.hasAccountingPage(childKey) && this.completeAttributions.has(childKey)) {
        this.rememberLauncherAccounting(childId, launcher.conversationId, launcher, { id: launcher.id, binding: launcher.binding, prompt: launcher.prompt });
      }
    }
    if (descendantsIncomplete) return;
    // Squared against the store until eviction or the bounded refresh age.
    this.completeAttributions.set(key, Date.now());
    this.removedLaunchers.delete(key);
    if (this.completeAttributions.size > MAX_CHILD_ATTRIBUTIONS) {
      this.completeAttributions.delete(this.completeAttributions.keys().next().value!);
    }
  }

  /**
   * Bounded insert for the attribution maps. An eviction takes the mark of
   * completeness with it: the next open of that parent must re-read the
   * child's store rather than trust whatever partial tally live events
   * rebuild afterwards.
   */
  private bankAttribution<T>(map: Map<string, T>, key: string, value: T): void {
    if (this.provider.watchWorkerAssociations) this.attributionReadEpoch(key);
    const evicted = boundedSet(map, key, value, MAX_CHILD_ATTRIBUTIONS);
    if (evicted !== undefined) {
      this.completeAttributions.delete(evicted);
      this.attributionEpochs.delete(evicted); // in-flight reads cannot outlive their cache's authority
    }
  }

  private bankChildUsage(key: string, usage: Map<string, TokenUsage>): void {
    const owned = usage as ChildUsage;
    if (this.provider.watchWorkerAssociations) {
      this.attributionReadEpoch(key);
      // The aggregate keeps its negative eligibility even if the epoch index
      // evicts first. Reuse copies only invalidation, never a retired epoch.
      owned.allocationOwner = this.attributionEpochs.get(key);
    }
    this.bankAttribution(this.childUsage, key, owned);
  }

  private attributionReadEpoch(key: string, renew = false): number {
    const known = this.attributionEpochs.get(key);
    if (known !== undefined && !renew) return known.epoch;
    // Never reuse an epoch after eviction: an absent entry cannot validate an
    // older read, nor can a later read accidentally restore its authority.
    const owner: AttributionOwner = { epoch: ++this.attributionSequence, allocationRevision: 0 };
    const retainedFloor = known?.allocationFloor ?? this.childUsage.get(key)?.allocationOwner?.allocationFloor;
    owner.allocationOccurrences = known?.allocationOccurrences ?? this.childUsage.get(key)?.allocationOwner?.allocationOccurrences;
    if (this.provider.watchWorkerAssociations && (renew || retainedFloor !== undefined || this.hasRetainedAttribution(key)))
      owner.allocationFloor = retainedFloor ?? 0;
    const evicted = boundedSet(this.attributionEpochs, key, owner, MAX_CHILD_ATTRIBUTIONS);
    if (evicted !== undefined) this.completeAttributions.delete(evicted);
    return owner.epoch;
  }

  private hasRetainedAttribution(key: string): boolean {
    if (this.childUsage.has(key) || this.childModels.has(key) || this.childPrompts.has(key)
      || this.childTranscripts.has(key) || this.childSessionCosts.has(key)) return true;
    const separator = key.indexOf(ATTRIBUTION_SEPARATOR);
    const parent = this.projections.get(key.slice(0, separator)), child = key.slice(separator + 1);
    // An all-unknown session report is only a presentation placeholder, not
    // retained accounting. Known zero spend still fences a lost owner.
    return Boolean(parent?.filter(item => item.type === "tool" && item.childConversationId === child
      && (item.usage !== undefined || item.model !== undefined || Boolean(item.descendants?.length)
        || item.workerSession?.model !== undefined || item.workerSession?.effort != null || item.workerSession?.costUsd != null)).length);
  }

  private allocationBlocked(key: string): boolean {
    if (!this.provider.watchWorkerAssociations) return false;
    const owner = this.attributionEpochs.get(key);
    return owner ? owner.allocationFloor !== undefined : this.hasRetainedAttribution(key);
  }

  private ownAccountingCurrent(key: string, sources?: WorkerSourceRead, topology = false): boolean {
    if (!sources?.hasAccountingPage(key)) return false;
    // Preserve completed reconstruction authority. A still-incomplete native
    // read additionally needs its own banked, unchanged prompts and owner.
    // Callers granting outgoing-topology authority still require its complete
    // raw inventory, not merely successfully returned own accounting.
    if (this.completeAttributions.has(key)) return true;
    const inventory = sources.inventory(key), transcript = this.childTranscripts.get(key);
    return inventory !== undefined && transcript !== undefined
      && this.attributionEpochs.get(key) === inventory.owner && inventory.owner.allocationRevision === inventory.revision
      && (topology ? inventory.signature !== undefined && transcriptSignature(transcript) === inventory.signature
        : transcriptSignature({ prompts: transcript.prompts, launchers: [] }) === inventory.ownSignature);
  }

  private attributionPublicationGuard(key: string, sources: WorkerSourceRead): () => boolean {
    const owner = this.attributionEpochs.get(key), revision = owner?.allocationRevision;
    const usage = this.childUsage.get(key), models = this.childModels.get(key), prompts = this.childPrompts.get(key), transcript = this.childTranscripts.get(key);
    const lastArrival = () => {
      let latest = 0;
      for (const arrival of this.attributionArrivals.get(key)?.values() ?? []) latest = Math.max(latest, arrival);
      return latest;
    };
    const arrival = lastArrival();
    return () => {
      if (this.disposed || this.attributionEpochs.get(key) !== owner || owner?.allocationRevision !== revision
        || this.childUsage.get(key) !== usage || this.childModels.get(key) !== models || this.childPrompts.get(key) !== prompts
        || this.childTranscripts.get(key) !== transcript || lastArrival() !== arrival) return false;
      try { sources.assertCurrent(); return true; } catch { return false; }
    };
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
    boundedSet(this.sessionParents, id, parentId, INVENTORY_SESSION_LIMIT);
    return parentId;
  }

  /**
   * Attributes a subagent on the rows that launched it: the model its own
   * session ran and the tokens it consumed, upserted onto the parent's `task`
   * tool items — each row stating the task it represents, not the session.
   *
   * Materialized onto the parent's items rather than read on demand because the
   * client holds one conversation's projection and can never see a child's —
   * and computed from the events already flowing through this pump rather than
   * fetched per child, which would be a provider call per subagent per render.
   */
  private async attributeSubagent(
    conversationId: string,
    reported: { messageId: string; usage: TokenUsage; promptId?: string } | undefined,
    assistantModel: { messageId: string; model: string; createdAt: number; effort?: string; promptId?: string } | undefined,
    sessionCostUsd: number | undefined,
    removedMessageId: string | undefined,
    coalescer: ProviderUpdateCoalescer,
  ): Promise<void> {
    if (reported === undefined && assistantModel === undefined && sessionCostUsd === undefined && removedMessageId === undefined) return;
    let parentId: string | null;
    try {
      parentId = await this.parentOf(conversationId);
    } catch {
      return; // Unknown parentage is not a reason to fail the child's own events.
    }
    if (!parentId) return;
    const key = attributionKey(parentId, conversationId);
    if (assistantModel !== undefined) {
      const byMessage = this.childModels.get(key) ?? new Map<string, MessageModel>();
      if (!byMessage.has(assistantModel.messageId) && [...byMessage].every(([id, model]) => model.createdAt < assistantModel.createdAt || model.createdAt === assistantModel.createdAt && id < assistantModel.messageId)) this.bankSessionCost(key, undefined);
      byMessage.set(assistantModel.messageId, { model: assistantModel.model, createdAt: assistantModel.createdAt, effort: assistantModel.effort });
      this.bankAttribution(this.childModels, key, byMessage);
      this.stampArrival(key, assistantModel.messageId);
      this.removedChildAttribution.get(key)?.delete(assistantModel.messageId);
    }
    if (reported !== undefined) {
      // Keyed by the provider's message id, not by the part the usage
      // decorated: a message can produce several text parts, and its tokens
      // are cumulative for the message. Banking them per part would count one
      // message's spend once for every part it emitted.
      const byMessage = this.childUsage.get(key) ?? new Map<string, TokenUsage>();
      byMessage.set(reported.messageId, reported.usage);
      this.bankChildUsage(key, byMessage);
      this.stampArrival(key, reported.messageId);
      this.removedChildAttribution.get(key)?.delete(reported.messageId);
    }
    const answered = reported ?? assistantModel;
    // Which prompt the message answers: named by the event where it can be.
    // An event that names none (a record shape with no `parentID`, and a
    // normalizer whose own memory of the session's prompts began empty — a
    // restart or reconnect mid-task) answers the newest prompt the child is
    // known to have received, from the store or live; without this a reused
    // subagent's new spend would fall to its FIRST task's row. A message that
    // is already paired keeps its pairing: a restatement of an earlier task's
    // message must not move to the task running now.
    const promptId = answered === undefined ? undefined
      : answered.promptId ?? (this.childPrompts.get(key)?.has(answered.messageId) ? undefined : this.childTranscripts.get(key)?.prompts.at(-1)?.id);
    if (answered !== undefined && promptId !== undefined) {
      const byMessage = this.childPrompts.get(key) ?? new Map<string, string>();
      byMessage.set(answered.messageId, promptId);
      this.bankAttribution(this.childPrompts, key, byMessage);
      // A prompt first heard of here is newer than every prompt already
      // known: prompts reach a session one at a time, in order.
      const transcript = this.childTranscripts.get(key) ?? { prompts: [], launchers: [] };
      if (!transcript.prompts.some(prompt => prompt.id === promptId)) {
        this.bankChildTranscript(key, { ...transcript, prompts: [...transcript.prompts, { id: promptId }] });
      }
    }
    if (removedMessageId !== undefined) {
      const byMessage = this.childUsage.get(key) ?? new Map<string, TokenUsage>();
      byMessage.delete(removedMessageId);
      this.bankChildUsage(key, byMessage);
      this.childModels.get(key)?.delete(removedMessageId);
      this.childPrompts.get(key)?.delete(removedMessageId);
      const removed = this.removedChildAttribution.get(key) ?? new Map<string, number>();
      const sequence = this.stampArrival(key, removedMessageId);
      const retired = boundedSet(removed, removedMessageId, sequence, MAX_CHILD_MESSAGE_REMOVALS);
      if (retired !== undefined) {
        // Retiring a fence first invalidates every older read. Only a future
        // provider read or live update may reintroduce a retired identity.
        this.attributionReadEpoch(key, true);
        this.completeAttributions.delete(key);
        this.attributionArrivals.get(key)?.delete(retired);
      }
      this.bankAttribution(this.removedChildAttribution, key, removed);
    }
    if (sessionCostUsd !== undefined) this.bankSessionCost(key, sessionCostUsd);
    this.decorateLauncherRows(parentId, conversationId, coalescer);
    // A subagent's spend is listed beneath every conversation above it: its
    // own rows carry it one level up, and each ancestor's row for the branch
    // lists it as a line. Nothing is added into an ancestor's figure — the
    // lines sum to the total on their own — so going up is only a refresh.
    await this.refreshAncestors(parentId, coalescer);
  }

  /**
   * Re-decorate the rows of every conversation above `sessionId`: the lines
   * a row lists beneath it include everything its subagent's branch spent, so
   * a change anywhere below has to reach each ancestor that is on screen.
   */
  private async refreshAncestors(sessionId: string, coalescer: ProviderUpdateCoalescer): Promise<void> {
    const seen = new Set<string>([sessionId]);
    let lower = sessionId;
    for (;;) {
      let upper: string | null;
      try {
        upper = await this.parentOf(lower);
      } catch {
        return;
      }
      if (!upper || seen.has(upper)) return;
      seen.add(upper);
      this.decorateLauncherRows(upper, lower, coalescer);
      lower = upper;
    }
  }

  /** Reprice only the rewritten receipt, retaining its immutable path. Fresh
   * ancestor pages prove visibility/bindings, not ancestor accounting authority. */
  private async refreshRewrittenAncestors(parentId: string, childId: string, sources: WorkerSourceRead, signal: AbortSignal, coalescer: ProviderUpdateCoalescer): Promise<void> {
    const key = attributionKey(parentId, childId), owner = this.attributionEpochs.get(key);
    if (owner?.allocationFloor !== 0 || !this.ownAccountingCurrent(key, sources, true)) return;
    const usage = this.childUsage.get(key), models = this.childModels.get(key), own = this.childTranscripts.get(key);
    const accountingCurrent = this.attributionPublicationGuard(key, sources);
    const inventory = sources.inventory(key);
    const topologyCurrent = inventory !== undefined && own !== undefined && inventory.owner === owner
      && inventory.revision === owner.allocationRevision && inventory.signature !== undefined && inventory.signature === transcriptSignature(own);
    const path: Array<{ upper: string; lower: string; key: string; transcript: ChildTranscript; signature: string; owner: AttributionOwner | undefined; revision: number | undefined }> = [];
    const seen = new Set([childId]);
    let lower = parentId;
    // Capture every incoming edge before any ancestor I/O can observe changes.
    while (!seen.has(lower) && path.length < MAX_CHILD_ATTRIBUTIONS) {
      seen.add(lower);
      const incoming = [...this.childTranscripts].filter(([scope]) => scope.endsWith(`${ATTRIBUTION_SEPARATOR}${lower}`));
      if (incoming.length !== 1) break;
      const [scope, transcript] = incoming[0]!, upper = scope.slice(0, scope.indexOf(ATTRIBUTION_SEPARATOR));
      const epoch = this.attributionEpochs.get(scope);
      if (!epoch || (epoch.allocationFloor ?? 0) > 0 || seen.has(upper)) return;
      const watch = this.provider.watchWorkerAssociations!(upper, [lower], { signal }).snapshot();
      sources.observe(watch.workerSource);
      if (watch.contradictedChildren.includes(lower)) return;
      path.push({ upper, lower, key: scope, transcript, signature: transcriptSignature(transcript), owner: epoch, revision: epoch?.allocationRevision });
      lower = upper;
    }
    if (!path.length) return;
    const launchers = path[0]!.transcript.launchers.filter(launcher => launcher.conversationId === childId);
    const tasks = launchers.map(launcher => this.accountedTask(parentId, childId, launcher));
    if (!tasks.length || !tasks.every((task): task is TaskRow => task !== undefined)
      || tasks.some((task, index) => !sameLauncherBinding(launchers[index]!.binding, task.binding))
      || this.unresolvedTaskRows(parentId, childId, tasks)
      || owner.allocationOccurrences !== undefined && occurrenceSignature(tasks) !== owner.allocationOccurrences) return;
    const views = path.map(edge => {
      const projection = this.projections.get(edge.upper);
      const rows = projection?.filter(item => item.type === "tool" && item.childConversationId === edge.lower).filter((item): item is ToolItem => item.type === "tool") ?? [];
      return { id: edge.upper, childId: edge.lower, projection, rows, expected: [...rows], visibility: projection?.reconciledHistoryVisibility };
    });
    if (views.some(view => view.rows.length > MAX_CHILD_ATTRIBUTIONS || view.rows.some(row => (row.descendants?.length ?? 0) > MAX_CHILD_ATTRIBUTIONS))) return;
    const current = () => {
      if (signal.aborted || !accountingCurrent()) return false;
      return path.every(edge => this.childTranscripts.get(edge.key) === edge.transcript && transcriptSignature(edge.transcript) === edge.signature
        && this.attributionEpochs.get(edge.key) === edge.owner && edge.owner?.allocationRevision === edge.revision
        && !this.reversibleMutations.has(edge.lower) && !this.revertReconciliations.has(edge.lower)
        && !this.reversibleMutations.has(edge.upper) && !this.revertReconciliations.has(edge.upper))
        && views.every(view => this.projections.get(view.id) === view.projection
          && view.projection?.reconciledHistoryVisibility === view.visibility
          && view.rows.length === (view.projection?.filter(item => item.type === "tool" && item.childConversationId === view.childId).length ?? 0)
          && view.expected.every(row => view.projection?.get(row.id) === row));
    };
    const pages = new Map<string, ChildTranscript>();
    for (const edge of path) {
      const session = await this.provider.getSession(edge.lower);
      if (!current() || session?.parentId !== edge.upper) return;
    }
    for (const id of new Set(path.flatMap(edge => [edge.upper, edge.lower]))) {
      const page = await this.provider.listMessages(id, { limit: RECONSTRUCTION_READ_LIMIT, signal });
      if (!current() || !page.completeItems || !page.workerSource || page.isWorkerSourceCurrent && !page.isWorkerSourceCurrent()) return;
      sources.observe(page.workerSource);
      pages.set(id, readChildTranscript(page.completeItems, new Set([id])));
    }
    if (!current() || path.some(edge => transcriptSignature(pages.get(edge.lower)!) !== edge.signature)) return;
    const values = foldByTask(tasks, own?.prompts, usage, models, this.childPrompts.get(key));
    const byId = new Map(tasks.map((task, index) => [task.id, values[index]!]));
    for (const view of views) for (const [index, row] of view.rows.entries()) {
      if (!row.childConversationId || !sameLauncherBinding(launcherBinding(row), this.accountedTask(view.id, row.childConversationId, row)?.binding)) continue;
      const lines = new Map((row.descendants ?? []).map(line => [line.id, line]));
      if (lines.size !== (row.descendants?.length ?? 0) || lines.has(row.id)) continue;
      const valid = (line: SubagentLine, ancestry: ReadonlySet<string>): boolean => {
        if (ancestry.has(line.id)) return false;
        const proof = this.descendantBindings.get(line);
        if (!proof || proof.parentId !== line.parentId) return false;
        const parent = line.parentId === row.id ? row : lines.get(line.parentId);
        const parentBinding = parent === row ? launcherBinding(row) : parent ? this.descendantBindings.get(parent as SubagentLine)?.launcher : undefined;
        const parentOwner = parent === row ? view.id : parent ? this.descendantBindings.get(parent as SubagentLine)?.sessionId : undefined;
        const parentChild = parent === row ? row.childConversationId : parent ? (parent as SubagentLine).conversationId : undefined;
        const nativeParent = pages.get(proof.parentSessionId)?.launchers.find(task => task.id === line.parentId && task.conversationId === proof.sessionId);
        const transcript = pages.get(proof.sessionId), native = transcript?.launchers.find(task => task.id === line.id && task.conversationId === line.conversationId);
        return proof.parentSessionId === parentOwner && proof.sessionId === parentChild
          && parentBinding !== undefined && sameLauncherBinding(proof.parent, parentBinding)
          && nativeParent !== undefined && sameLauncherBinding(nativeParent.binding, proof.parent)
          && native !== undefined && sameLauncherBinding(native.binding, proof.launcher)
          && transcript!.prompts[native.promptIndex]?.id === proof.promptId
          && (parent === row || parent !== undefined && valid(parent as SubagentLine, new Set([...ancestry, line.id])));
      };
      // Only a complete native inventory can withdraw an old outgoing edge.
      // Missing enrichment is unknown; it is never subtree-removal authority.
      const withdrawn = new Set<string>();
      if (topologyCurrent) for (const line of lines.values()) {
        const proof = this.descendantBindings.get(line), parent = lines.get(line.parentId);
        if (proof?.sessionId === childId && proof.parentSessionId === parentId && parent?.conversationId === childId
          && byId.has(parent.id) && valid(parent, new Set())
          && sameLauncherBinding(proof.parent, this.descendantBindings.get(parent)?.launcher)
          && !own!.launchers.some(launcher => launcher.id === line.id && launcher.conversationId === line.conversationId
            && sameLauncherBinding(launcher.binding, proof.launcher))) withdrawn.add(line.id);
      }
      const hidden = (line: SubagentLine, seen: ReadonlySet<string>): boolean => {
        if (withdrawn.has(line.id)) return true;
        if (seen.has(line.id)) return false;
        const parent = lines.get(line.parentId);
        return parent !== undefined && hidden(parent, new Set([...seen, line.id]));
      };
      let changed = withdrawn.size > 0;
      const descendants = row.descendants?.filter(line => !hidden(line, new Set())).map(line => {
        const value = byId.get(line.id);
        if (line.conversationId !== childId || !value || !valid(line, new Set())) return line;
        const { usage: _usage, model: _model, ...binding } = line;
        const next = { ...binding, ...value };
        if (sameLines([line], [next])) return line;
        this.descendantBindings.set(next, this.descendantBindings.get(line)!);
        changed = true;
        return next;
      });
      if (!changed || !current()) continue;
      const item = { ...row, descendants };
      this.carryLauncherAccounting(item, row);
      this.rewritePublications.set(item, { original: row, cohort: view.rows, context: sources, visible: true,
        current: () => current() && view.expected[index] === row,
        accepted: (before, actual) => {
          // Advance only this exact candidate's observed application. Wire
          // equality alone, another context, or a reused ID grants nothing.
          if (before !== row || view.expected[index] !== row || actual?.type !== "tool"
            || this.projections.get(view.id) !== view.projection || view.projection?.get(row.id) !== actual
            || actual.descendants !== item.descendants || this.launcherAccounting.get(actual) !== this.launcherAccounting.get(row)
            || !sameConversationItems([actual], [item])) return;
          view.expected[index] = actual;
        } });
      coalescer.push(view.id, [{ kind: "upsert", item }]);
    }
  }

  /**
   * A subagent's own launchers, seen live: what becomes the lines beneath the
   * row that launched the subagent. Only a session that has a parent is
   * tracked — a top-level conversation's launchers are its own rows.
   */
  private async trackLaunchers(conversationId: string, updates: readonly NormalizedProviderUpdate[], coalescer: ProviderUpdateCoalescer): Promise<void> {
    const rows = updates.flatMap(update => update.kind === "upsert" && update.item.type === "tool" && update.item.childConversationId ? [update.item] : []);
    // A launcher that is removed takes its line with it. OpenCode's part
    // removal names the part, not the row made from it, so both spellings of
    // the id are read as the row's. Without this the record never forgets: the
    // line and its cost stay on every ancestor, and — the tally being marked
    // squared — a reopen keeps them too.
    const removed = new Set(updates.flatMap(update => update.kind === "remove" ? [update.itemId.replace(/^part:/, "tool:")] : []));
    // The child's own prompts, with their text: what tells a task's prompt
    // from a compaction request or a "continue" OpenCode put there itself.
    const prompted = updates.flatMap(update => update.kind === "upsert" && update.item.type === "user_message" ? [{ id: update.item.id.replace(/^message:/, ""), text: update.item.text }] : []);
    if (rows.length === 0 && removed.size === 0 && prompted.length === 0) return;
    let parentId: string | null;
    try {
      parentId = await this.parentOf(conversationId);
    } catch {
      return;
    }
    if (!parentId) return;
    const key = attributionKey(parentId, conversationId);
    const transcript = this.childTranscripts.get(key) ?? { prompts: [], launchers: [] };
    const launchers = transcript.launchers.filter(launcher => !removed.has(launcher.id));
    let changed = launchers.length !== transcript.launchers.length;
    const prompts = [...transcript.prompts];
    for (const prompt of prompted) {
      const known = prompts.findIndex(candidate => candidate.id === prompt.id);
      if (known < 0) prompts.push(prompt);
      // A restatement of the message arrives with no parts, and so no text:
      // it must not blank a text already heard.
      else if (prompts[known]!.text === prompt.text || (prompt.text === "" && prompts[known]!.text !== undefined)) continue;
      else prompts[known] = prompt;
      changed = true;
    }
    // Not yet squared against the store: a read may be in flight, or still to
    // come, holding the launcher this removal names — even when no record of
    // it exists here yet. Remember the removal so that read cannot bank it.
    if (removed.size > 0 && !this.completeAttributions.has(key)) {
      const tombstones = this.removedLaunchers.get(key) ?? new Set<string>();
      for (const id of removed) tombstones.add(id);
      this.bankAttribution(this.removedLaunchers, key, tombstones);
    }
    for (const row of rows) this.removedLaunchers.get(key)?.delete(row.id);
    for (const row of rows) {
      const known = launchers.findIndex(launcher => launcher.id === row.id);
      // The prompt being answered when the launcher first appeared is the
      // newest one known; later restatements of the row do not move it.
      const next = launcherOf(row, known >= 0 ? launchers[known]!.promptIndex : Math.max(0, prompts.length - 1), known >= 0 ? launchers[known] : undefined);
      this.carryLauncherAccounting(next, known >= 0 ? launchers[known] : row);
      if (known < 0) launchers.push(next);
      else if (sameLauncher(launchers[known]!, next)) continue;
      else launchers[known] = next;
      changed = true;
      if (this.provider.watchWorkerAssociations) {
        this.stampArrival(key, row.id);
      }
    }
    // An occurrence restatement can leave launcher text unchanged while a
    // published cohort invalidation still needs to reach the ancestor lines.
    if (!changed && !rows.some(row => this.allocationBlocked(attributionKey(conversationId, row.childConversationId!)))) return;
    if (changed) this.bankChildTranscript(key, { prompts, launchers });
    this.decorateLauncherRows(parentId, conversationId, coalescer);
    await this.refreshAncestors(parentId, coalescer);
  }

  private stampArrival(key: string, id: string): number {
    const arrivals = this.attributionArrivals.get(key) ?? new Map<string, number>();
    const sequence = ++this.attributionSequence;
    arrivals.set(id, sequence);
    this.bankAttribution(this.attributionArrivals, key, arrivals);
    return sequence;
  }

  /** Reuse an inspection's existing bounded history read; no extra transcript fetch. */
  private refreshInspectedChildAccounting(childId: string, parentId: string, accounting: readonly StoredMessageAccounting[], sessionCostUsd: number | undefined, readStartedAt: number): void {
    const key = attributionKey(parentId, childId);
    if ((this.childSessionCosts.get(key)?.sequence ?? 0) <= readStartedAt) this.bankSessionCost(key, sessionCostUsd);
    const usage = this.childUsage.get(key) ?? new Map<string, TokenUsage>();
    const models = this.childModels.get(key) ?? new Map<string, MessageModel>();
    for (const reported of accounting) {
      if (this.removedChildAttribution.get(key)?.has(reported.messageId)) continue;
      if ((this.attributionArrivals.get(key)?.get(reported.messageId) ?? 0) > readStartedAt) continue;
      if (reported.usage) usage.set(reported.messageId, reported.usage);
      if (reported.model) models.set(reported.messageId, { model: reported.model, createdAt: reported.createdAt, effort: reported.effort });
    }
    this.bankChildUsage(key, usage);
    this.bankAttribution(this.childModels, key, models);
    if (this.eventCoalescer) this.decorateLauncherRows(parentId, childId, this.eventCoalescer);
  }

  private bankSessionCost(key: string, costUsd: number | undefined): void {
    if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) costUsd = undefined;
    const highest = Math.max(this.childSessionCosts.get(key)?.highest ?? 0, costUsd ?? 0);
    // The native lifetime aggregate never decreases, including on revert.
    // Ignore out-of-order/duplicated lower totals; never add snapshots together.
    this.bankAttribution(this.childSessionCosts, key, { costUsd: costUsd === undefined ? null : highest, highest, sequence: ++this.attributionSequence });
  }

  private accountedTask(parentId: string, childId: string, source: object): TaskRow | undefined {
    const proof = this.launcherAccounting.get(source);
    return proof?.parentId === parentId && proof.childId === childId ? proof.task : undefined;
  }

  private rememberLauncherAccounting(parentId: string, childId: string, target: object, task: TaskRow): void {
    if (!this.provider.watchWorkerAssociations || !task.binding) return;
    this.launcherAccounting.set(target, Object.freeze({ parentId, childId,
      task: Object.freeze({ id: task.id, binding: task.binding, ...(task.prompt === undefined ? {} : { prompt: task.prompt }) }) }));
  }

  /** Presentation changes inherit the original receipt binding, never renew it. */
  private carryLauncherAccounting(target: object, current?: object, incoming?: object): void {
    const proof = incoming && this.launcherAccounting.get(incoming) || current && this.launcherAccounting.get(current);
    if (proof) this.launcherAccounting.set(target, proof);
  }

  /**
   * What each of the rows that launched `childId` should state: the k-th row
   * the spend of the k-th task the child was given, and beneath it the lines
   * of every subagent launched while answering that task, at any depth.
   */
  private rowAttributions(parentId: string, childId: string, rows: readonly TaskRow[], sources?: WorkerSourceRead): RowAttribution[] {
    const key = attributionKey(parentId, childId);
    const folds = foldByTask(rows, this.childTranscripts.get(key)?.prompts, this.childUsage.get(key), this.childModels.get(key), this.childPrompts.get(key));
    const beneath = new Map<string, SubagentLine[]>();
    const retainedRows = rows.map(row => {
      const current = this.projections.get(parentId)?.get(row.id);
      return current?.type === "tool" && current.childConversationId === childId && row.binding && sameLauncherBinding(row.binding, launcherBinding(current))
        ? { ...row, retainedDescendants: current.descendants } : row;
    });
    for (const line of this.descendantLines(parentId, childId, retainedRows, new Set([parentId, childId]), sources)) {
      beneath.set(line.parentId, [...(beneath.get(line.parentId) ?? []), line]);
    }
    const branch = (id: string): SubagentLine[] => (beneath.get(id) ?? []).flatMap(line => [line, ...branch(line.id)]);
    return folds.map((fold, index) => {
      const descendants = branch(rows[index]!.id);
      // A denied retained relation is an explicit withdrawal, not a sparse
      // omission that the presentation merge may restore on a direct row.
      return { ...fold, ...(descendants.length > 0 || this.provider.watchWorkerAssociations && retainedRows[index]?.retainedDescendants?.length ? { descendants } : {}) };
    });
  }

  private unresolvedTaskRows(parentId: string, childId: string, rows: readonly TaskRow[]): ReadonlySet<string> | undefined {
    if (!this.provider.watchWorkerAssociations || rows.length < 2) return;
    const prompts = this.childTranscripts.get(attributionKey(parentId, childId))?.prompts;
    if (!prompts || prompts.length < rows.length) return;
    const paired = new Set(pairPrompts(rows, prompts));
    const unresolved = rows.filter((_, index) => !paired.has(index));
    // Partial pairing cannot make one task inherit another task's spend.
    // Keep the generic positional fallback and continuation pairing unchanged.
    return unresolved.length ? new Set(unresolved.map(row => row.id)) : undefined;
  }

  private nestedAllocationCurrent(publication: NestedAllocationPublication, sources: WorkerSourceRead): boolean {
    const { parentKey, key, parentInventory, inventory } = publication;
    for (const [scope, proof] of [[parentKey, parentInventory], [key, inventory]] as const) {
      const transcript = this.childTranscripts.get(scope);
      if (!transcript || sources.inventory(scope) !== proof || !sources.hasAccountingPage(scope)
        || this.attributionEpochs.get(scope) !== proof.owner || proof.owner.allocationRevision !== proof.revision
        || !this.completeAttributions.has(scope) || proof.signature === undefined || transcriptSignature(transcript) !== proof.signature) return false;
    }
    return publication.owner === inventory.owner && publication.owner.epoch === publication.epoch
      && publication.views.every(view => this.projections.get(view.id) === view.projection
        && view.rows.length === (view.projection?.filter(item => item.type === "tool" && item.childConversationId === view.childId).length ?? 0)
        && view.rows.every(row => view.projection?.get(row.id) === row));
  }

  private nestedAllocationProof(parentId: string, sessionId: string, childId: string, rows: readonly TaskRow[], own: readonly Launcher[], sources?: WorkerSourceRead): boolean {
    if (!sources) return false;
    const parentKey = attributionKey(parentId, sessionId), key = attributionKey(sessionId, childId);
    const parentInventory = sources.inventory(parentKey), inventory = sources.inventory(key);
    // Zero-floor invalidation includes reused/generation-retired occurrences.
    // Preserve its existing read-local behavior; this publication closes only
    // an observed positive membership deficit, never a new ownership claim.
    if (!parentInventory || !inventory || (inventory.owner.allocationFloor ?? 0) <= 0) return false;
    let publication = sources.nestedPublications.get(key);
    if (!publication) {
      if (sources.nestedPublications.size >= MAX_CHILD_ATTRIBUTIONS) return false;
      const views = ([[parentId, sessionId], [sessionId, childId]] as const).map(([id, child]) => {
        const projection = this.projections.get(id);
        return { id, childId: child, projection, rows: projection?.filter((item): item is ToolItem => item.type === "tool" && item.childConversationId === child) ?? [] };
      });
      if (rows.length > MAX_CHILD_ATTRIBUTIONS || views.some(view => view.rows.length > MAX_CHILD_ATTRIBUTIONS)) return false;
      // An existing line stripped of its private provenance is unknown. Fresh
      // native inventories do not retroactively validate that retained object.
      if (views[0]!.rows.some(row => row.type === "tool" && row.descendants?.some(line =>
        line.conversationId === childId && !this.descendantBindings.has(line)))) return false;
      publication = { parentKey, key, parentId, sessionId, childId, parentInventory, inventory, owner: inventory.owner, epoch: inventory.owner.epoch,
        parents: rows.map(row => ({ id: row.id, binding: row.binding })), views, proven: false };
      sources.nestedPublications.set(key, publication);
    }
    if (!this.nestedAllocationCurrent(publication, sources) || own.length < (inventory.owner.allocationFloor ?? 0)
      || rows.length !== publication.parents.length || rows.some((row, index) => row.id !== publication.parents[index]!.id
        || !row.binding || !sameLauncherBinding(row.binding, publication.parents[index]!.binding))) return false;
    const parentTranscript = this.childTranscripts.get(parentKey)!, transcript = this.childTranscripts.get(key)!;
    const tasks = own.map(launcher => ({ id: launcher.id, prompt: launcher.prompt, binding: launcher.binding }));
    if (inventory.owner.allocationOccurrences === undefined || occurrenceSignature(tasks) !== inventory.owner.allocationOccurrences) return false;
    // Native prompt pairing must actually open every task; positional fallback,
    // unknown text and duplicate occurrences cannot prove cohort membership.
    const paired = (tasks: readonly TaskRow[], prompts: readonly Prompt[]) => {
      let next = 0;
      const ids = new Set<string>();
      for (const prompt of prompts) {
        if (ids.has(prompt.id) || prompt.text === undefined) return false;
        ids.add(prompt.id);
        const task = tasks[next];
        if (task?.prompt !== undefined && deliversPrompt(prompt.text, task.prompt, next === 0)) {
          next++;
        }
      }
      return next === tasks.length && new Set(tasks.map(task => task.id)).size === tasks.length
        && tasks.every(task => task.binding?.inputHash !== undefined);
    };
    publication.proven = paired(rows, parentTranscript.prompts) && paired(tasks, transcript.prompts);
    return publication.proven;
  }

  /**
   * The lines beneath the rows that launched `sessionId`: one per task the
   * session gave a subagent of its own, stating that task's own spend, then
   * the same one level further down. A nested launcher hangs off the row of
   * the task during which it was launched — the prompt it follows, paired the
   * way the spend is. `ancestry` stops a loop in the data.
   */
  private descendantLines(parentId: string, sessionId: string, rows: readonly TaskRow[], ancestry: ReadonlySet<string>, sources?: WorkerSourceRead): SubagentLine[] {
    const parentKey = attributionKey(parentId, sessionId);
    const transcript = this.childTranscripts.get(parentKey);
    const launchers = transcript?.launchers ?? [];
    if (launchers.length === 0 || rows.length === 0) return [];
    // Own spend does not prove the outgoing launcher inventory. A retired or
    // own-only read may bind descendants only through immutable retained lines
    // matching the current parent occurrence, never positional cache pairing.
    const bindingRestricted = this.provider.watchWorkerAssociations && !this.ownAccountingCurrent(parentKey, sources, true)
      && (this.allocationBlocked(parentKey) || !this.completeAttributions.has(parentKey) || sources?.hasAccountingPage(parentKey) === true);
    const pairing = pairPrompts(rows, transcript?.prompts ?? []);
    const byChild = new Map<string, Launcher[]>();
    for (const launcher of launchers) {
      if (ancestry.has(launcher.conversationId)) continue;
      byChild.set(launcher.conversationId, [...(byChild.get(launcher.conversationId) ?? []), launcher]);
    }
    const lines: SubagentLine[] = [];
    for (const [childId, own] of byChild) {
      const key = attributionKey(sessionId, childId);
      const tasks: TaskRow[] = own.map(launcher => ({ id: launcher.id, binding: launcher.binding, ...(launcher.prompt === undefined ? {} : { prompt: launcher.prompt }) }));
      const unresolved = this.unresolvedTaskRows(sessionId, childId, tasks);
      // Zero-floor behavior remains read-local. A positive membership deficit
      // additionally needs authoritative inventories and exact native pairing;
      // only enclosing history publication changes persistent eligibility.
      const currentCohort = this.allocationBlocked(key) && this.nestedAllocationProof(parentId, sessionId, childId, rows, own, sources)
        || this.ownAccountingCurrent(attributionKey(parentId, sessionId), sources, true)
        && this.ownAccountingCurrent(key, sources)
        && this.attributionEpochs.get(key)?.allocationFloor === 0;
      const guarded = (this.allocationBlocked(key) && !currentCohort) || unresolved !== undefined;
      const folds = guarded ? [] : foldByTask(tasks, this.childTranscripts.get(key)?.prompts, this.childUsage.get(key), this.childModels.get(key), this.childPrompts.get(key));
      own.forEach((launcher, index) => {
        // A blocked incoming edge cannot use positional pairing to assign a
        // deeper launch to a task. Only an exact current row's recorded direct
        // descendant relation can provide that binding. Ambiguity fails closed.
        const promptId = transcript?.prompts[launcher.promptIndex]?.id;
        const matchesRetained = (row: TaskRow, line: SubagentLine) => {
          const proof = this.descendantBindings.get(line);
          return line.id === launcher.id && line.parentId === row.id && line.conversationId === childId
            && proof !== undefined && proof.parentSessionId === parentId && proof.sessionId === sessionId
            && proof.parentId === row.id && proof.promptId === promptId
            && sameLauncherBinding(proof.parent, row.binding) && sameLauncherBinding(proof.launcher, launcher.binding);
        };
        const retainedParents = rows.filter(row => (row.descendantBinding ?? (bindingRestricted ? row.retainedDescendants : undefined))?.some(line => matchesRetained(row, line)));
        const positional = rows[Math.min(pairing[launcher.promptIndex] ?? launcher.promptIndex, rows.length - 1)]!;
        const parent = retainedParents.length === 1 ? retainedParents[0]
          : retainedParents.length === 0 && !bindingRestricted && positional.descendantBinding === undefined ? positional : undefined;
        if (parent) {
          const projected = this.projections.get(sessionId)?.get(launcher.id);
          tasks[index] = { ...tasks[index]!, retainedDescendants: projected?.type === "tool" && projected.childConversationId === childId
            && projected.descendants !== undefined && sameLauncherBinding(launcher.binding, launcherBinding(projected)) ? projected.descendants : parent.retainedDescendants };
        }
        // Recursive lines obey the same cohort fence as direct rows. Only a
        // current matching row can retain its own known attribution; an old
        // ancestor line cannot prove a changed input or occurrence's spend.
        const current = guarded ? this.projections.get(sessionId)?.get(launcher.id) : undefined;
        const exact = current?.type === "tool" && current.childConversationId === childId
          && sameLauncher(launcher, launcherOf(current, launcher.promptIndex)) && !unresolved?.has(launcher.id)
          && (sameLauncherBinding(launcher.binding, this.accountedTask(sessionId, childId, current)?.binding)
            || sources?.hasAccountingPage(key) === true && sameLauncherBinding(launcher.binding, this.accountedTask(sessionId, childId, launcher)?.binding));
        // A live materialization can lack its own receipt object while an
        // ancestor still holds the exact immutable line. This is retention
        // only: current pages, positive deficits and changed/missing current
        // occurrences cannot borrow that older line's amounts.
        const retainedRelation = parent && this.attributionEpochs.get(key)?.allocationFloor === 0 && !unresolved?.has(launcher.id)
          && (!current || current.type === "tool" && current.childConversationId === childId && sameLauncher(launcher, launcherOf(current, launcher.promptIndex)))
          ? parent.retainedDescendants?.find(line => matchesRetained(parent, line)) : undefined;
        const retained = !sources && current?.type === "tool"
          && (!this.accountedTask(sessionId, childId, current) || sameLauncherBinding(launcher.binding, this.accountedTask(sessionId, childId, current)?.binding))
          ? retainedRelation : undefined;
        // Keep all tasks in folding order, including denied ones: dropping one
        // would give its aggregate to a survivor. Denied bindings propagate to
        // every depth, while an unaffected current subtree retains its proof.
        if (!parent || guarded) tasks[index] = { ...tasks[index]!, descendantBinding: parent && exact ? current.descendants ?? [] : retainedRelation ? parent?.retainedDescendants ?? [] : [] };
        if (!parent) return;
        const known = exact ? current : retained;
        const attribution = guarded ? known ? {
          ...(known.usage === undefined ? {} : { usage: known.usage }),
          ...(known.model === undefined ? {} : { model: known.model }),
        } : {} : folds[index];
        const line: SubagentLine = {
          id: launcher.id,
          parentId: parent.id,
          description: launcher.description,
          ...(launcher.subagent === undefined ? {} : { subagent: launcher.subagent }),
          conversationId: childId,
          ...attribution,
        };
        // Record only while generating this exact relation. Neither a clone
        // without metadata nor matching IDs can reconstruct missing proof.
        // Native prompt identity survives preambles that shift array indices.
        if (parent.binding?.inputHash !== undefined && launcher.binding.inputHash !== undefined && promptId !== undefined) {
          this.descendantBindings.set(line, Object.freeze({ parentSessionId: parentId, sessionId, parentId: parent.id,
            parent: parent.binding, launcher: launcher.binding, promptId }));
        }
        lines.push(line);
      });
      lines.push(...this.descendantLines(sessionId, childId, tasks, new Set([...ancestry, childId]), sources));
    }
    return lines;
  }

  /**
   * Put the banked tally onto the rows that launched the child, if the parent
   * is projected — the rows live in its timeline, and an unprojected parent
   * has no row on screen to carry a figure. The scan walks the projection
   * unordered and sorts only the child's own rows: this runs per child event,
   * and OpenCode restates a message's tokens many times a turn, so sorting the
   * whole parent timeline each time (what `items()` does) would make a chatty
   * subagent cost the parent's length per chunk.
   */
  private decorateLauncherRows(parentId: string, conversationId: string, coalescer: ProviderUpdateCoalescer, sources?: WorkerSourceRead): void {
    const parent = this.projections.get(parentId);
    if (!parent) return;
    const cohort = parent.filter(item => item.type === "tool" && item.childConversationId === conversationId).filter((item): item is ToolItem => item.type === "tool");
    const accountingCurrent = sources ? this.attributionPublicationGuard(attributionKey(parentId, conversationId), sources) : undefined;
    const current = () => accountingCurrent?.() === true && this.projections.get(parentId) === parent
      && cohort.length === parent.filter(item => item.type === "tool" && item.childConversationId === conversationId).length
      && cohort.every(row => parent.get(row.id) === row);
    for (const updates of this.launcherRowUpdates(parentId, conversationId, parent, sources)) {
      if (sources) for (const update of updates) {
        const original = cohort.find(row => row.id === (update.kind === "upsert" ? update.item.id : update.kind === "remove" ? update.itemId : undefined));
        if (original) this.rewritePublications.set(update.kind === "upsert" ? update.item : update, { original, cohort, context: sources, visible: false, current });
      }
      coalescer.push(parentId, updates);
    }
  }

  /** The same, applied to a projection directly — for rows a flush has only just materialized. */
  private settleLauncherRows(parentId: string, conversationId: string, parent: ConversationProjection): void {
    for (const updates of this.launcherRowUpdates(parentId, conversationId, parent)) for (const update of updates) parent.apply(update);
  }

  private refreshEquivalentDescendantBindings(projection: ConversationProjection, current: ToolItem, incoming: ToolItem): void {
    this.carryLauncherAccounting(current, current, incoming);
    if (!this.provider.watchWorkerAssociations || !current.descendants || !incoming.descendants
      || current.descendants.length !== incoming.descendants.length) return;
    let changed = false;
    const descendants = current.descendants.map((line, index) => {
      const next = incoming.descendants![index]!, proof = this.descendantBindings.get(next);
      // Missing proof cannot replace known provenance. Equal semantic proof
      // also retains its references, avoiding self-generated read changes.
      if (!proof || sameDescendantBinding(this.descendantBindings.get(line), proof)) return line;
      changed = true;
      return next;
    });
    if (changed) projection.refreshEquivalentTool(current, { ...current, descendants });
  }

  private launcherRowUpdates(parentId: string, conversationId: string, parent: ConversationProjection, sources?: WorkerSourceRead): NormalizedProviderUpdate[][] {
    const rows = launcherRows(parent.filter(item => item.type === "tool" && item.childConversationId === conversationId));
    const ancestor = this.sessionParents.get(parentId);
    let transcript = ancestor ? this.childTranscripts.get(attributionKey(ancestor, parentId)) : undefined;
    if (!transcript) for (const [scope, known] of this.childTranscripts) if (scope.endsWith(`${ATTRIBUTION_SEPARATOR}${parentId}`)) {
      transcript = known; break;
    }
    const cached = transcript?.launchers.filter(launcher => launcher.conversationId === conversationId);
    const accounted = cached?.map(launcher => this.accountedTask(parentId, conversationId, launcher));
    // A live frame can materialize only one member of a reconstructed cohort.
    // Keep its original allocation order instead of donating the whole tally.
    const partial = accounted && accounted.length > rows.length && accounted.every((task): task is TaskRow => task !== undefined);
    const tasks = partial ? accounted : rows.map(taskRow);
    const unresolved = this.unresolvedTaskRows(parentId, conversationId, tasks);
    const key = attributionKey(parentId, conversationId);
    // A generation fence alone still permits current native updates to an
    // already dense cohort. It does not clear eligibility, and cannot bypass
    // observed missing membership or a lost cache owner.
    const denseCurrent = this.attributionEpochs.get(key)?.generationOnly === true && !unresolved && rows.length > 1
      && this.childTranscripts.get(key)?.prompts.length === rows.length;
    const blocked = this.allocationBlocked(key) && !denseCurrent;
    // A successful rewrite may reprice an exact already-accounted row at a
    // benign zero-floor retirement. It neither clears that floor nor bypasses
    // positive missing-membership/occurrence counterproof or changed bindings.
    const rewriteOwner = this.attributionEpochs.get(key);
    const currentRewrite = blocked && rewriteOwner?.allocationFloor === 0 && !partial && !unresolved
      && this.ownAccountingCurrent(key, sources)
      && (rewriteOwner.allocationOccurrences === undefined || rewriteOwner.allocationOccurrences === occurrenceSignature(tasks))
      && rows.every(row => sameLauncherBinding(launcherBinding(row), this.accountedTask(parentId, conversationId, row)?.binding));
    const attributions = unresolved || blocked && !currentRewrite ? [] : this.rowAttributions(parentId, conversationId, tasks, sources);
    const workerSession = workerSessionReport(this.childSessionCosts.get(key)?.costUsd, this.childModels.get(key));
    const backgroundUpdates: NormalizedProviderUpdate[][] = parent.filter(item => item.type === "background_task" && item.childConversationId === conversationId).flatMap(row =>
      row.type === "background_task" && (this.childSessionCosts.get(key)?.costUsd != null || this.childUsage.get(key)?.size || this.childModels.get(key)?.size || row.workerSession) && !sameWorkerSession(row.workerSession, workerSession)
        ? [[{ kind: "upsert" as const, item: { ...row, workerSession } }]] : []);
    return [...backgroundUpdates, ...rows.flatMap((row, index) => {
      const taskIndex = partial ? tasks.findIndex(task => task.id === row.id) : index;
      const own = partial && (taskIndex < 0 || !sameLauncherBinding(launcherBinding(row), tasks[taskIndex]!.binding)) ? {}
        : unresolved || blocked && !currentRewrite ? unresolved?.has(row.id) ? {} : { usage: row.usage, model: row.model, descendants: row.descendants } : attributions[taskIndex]!;
      const attribution = { ...own, workerSession };
      // Nothing new to say: most restatements change nothing until the turn's
      // token counts actually move, and an upsert that restates the row
      // verbatim still costs a replay frame for every subscriber.
      if (sameAttribution(row, attribution)) {
        this.refreshEquivalentDescendantBindings(parent, row, { ...row, ...attribution });
        return [];
      }
      const { usage: _usage, model: _model, descendants: _descendants, ...withoutAttribution } = row;
      const item = { ...withoutAttribution, ...attribution };
      this.carryLauncherAccounting(item, row);
      if (!this.accountedTask(parentId, conversationId, item) && !blocked && !unresolved) {
        const known = accounted?.find(task => task?.id === row.id);
        if (known) this.rememberLauncherAccounting(parentId, conversationId, item, known);
        else if (row.usage === undefined && row.model === undefined) this.rememberLauncherAccounting(parentId, conversationId, item, taskRow(row));
      }
      // Upserts deliberately preserve attribution omitted by ordinary tool
      // updates, so attribution that is no longer there — a removed or
      // reverted message, a line that left — has to be put on as a
      // replacement: remove first, or the intentional clear is merged away.
      return [withdraws(row, attribution) ? [{ kind: "remove" as const, itemId: row.id }, { kind: "upsert" as const, item }] : [{ kind: "upsert" as const, item }]];
    })];
  }

  projectionForTests(id: string): ConversationProjection {
    return this.projection(id);
  }

  retainedSettlementsForTests(): number {
    return this.settledTurns.size;
  }

  private async pump(signal: AbortSignal): Promise<void> {
    // Metadata follows coalescer-owned item objects, never the wire item.
    // Discarded/unmaterialized updates leave no projection provenance entry.
    const sourceOrigins = new WeakMap<ConversationItem, NonNullable<NormalizedProviderEvent["workerOriginUpdates"]>>();
    const fallbackDeliveries = new WeakMap<NormalizedProviderUpdate, NonNullable<NormalizedProviderEvent["workerOriginUpdates"]>>();
    const sourceFallbacks = new WeakMap<ConversationItem, WorkerResultFallback[]>();
    const coalescer = new ProviderUpdateCoalescer({
      windowMs: this.coalesceWindowMs,
      // The window folds repeated upserts the way the projection applies
      // them, so a sparse frame landing right behind a full one cannot
      // strip what the full one carried (a 2.x tool call's input).
      mergeUpsert: (current, incoming) => {
        const previousRewrite = this.rewritePublications.get(current), nextRewrite = this.rewritePublications.get(incoming);
        // Native updates keep their presentation; a queued optional rewrite
        // contributes nothing when another update touches the same row.
        if (nextRewrite === false) return current;
        if (nextRewrite) return previousRewrite !== undefined ? incoming : current;
        if (previousRewrite === false) return incoming;
        if (previousRewrite) current = previousRewrite.original;
        const merged = mergeInteraction(current, incoming);
        this.carryLauncherAccounting(merged, current, incoming);
        const origins = new Map([...(sourceOrigins.get(current) ?? []), ...(sourceOrigins.get(incoming) ?? [])]
          .map(origin => [origin.toolUseId ? `call:${origin.toolUseId}` : `result:${origin.messageId}`, origin]));
        if (origins.size) sourceOrigins.set(merged, [...origins.values()]);
        const fallbacks = [...new Map([...(sourceFallbacks.get(current) ?? []), ...(sourceFallbacks.get(incoming) ?? [])]
          .filter(relation => sameConversationItems([merged], [relation.fallback]))
          .map(relation => [relation.fallback.id, relation])).values()];
        if (fallbacks.length) sourceFallbacks.set(merged, fallbacks);
        return merged;
      },
      onFlush: async (conversationId, updates) => {
        const rewritten = new Set<string>();
        const validRewrites = new Set<NormalizedProviderUpdate>();
        const acceptedRewrites = new Map<NormalizedProviderUpdate, (before: ConversationItem | undefined, actual: ConversationItem | undefined) => void>();
        const queued = updates;
        updates = updates.filter(update => {
          const publication = this.rewritePublications.get(update.kind === "upsert" ? update.item : update);
          if (publication === false) return false;
          if (!publication) return true;
          if (!publication.current() || queued.some(other => {
            const otherPublication = this.rewritePublications.get(other.kind === "upsert" ? other.item : other);
            if (otherPublication === false) return false;
            return other !== update && otherPublication?.context !== publication.context
              && (other.kind === "remove" && publication.cohort.some(row => row.id === other.itemId)
                || other.kind === "upsert" && (other.item.id === publication.original.id || other.item.type === "tool" && other.item.childConversationId === publication.original.childConversationId));
          })) return false;
          if (publication.original.childConversationId) rewritten.add(publication.original.childConversationId);
          if (publication.visible) validRewrites.add(update);
          if (publication.accepted) acceptedRewrites.set(update, publication.accepted);
          return true;
        });
        for (const update of queued) {
          const key = update.kind === "upsert" ? update.item : update;
          if (this.rewritePublications.has(key)) this.rewritePublications.set(key, false);
        }
        if (!updates.length) return;
        // Not gated on the abort signal: a graceful stop still applies
        // whatever the coalescer buffered in its final window.
        if (updates.every(update => fallbackDeliveries.has(update))) {
          // Metadata alone cannot recreate an evicted projection or republish
          // unrelated user delivery/accounting state. Its notice must survive.
          const projection = this.projections.get(conversationId);
          for (const update of updates) projection?.rememberFallbackStoredOrigins(fallbackDeliveries.get(update)!);
          return;
        }
        const projection = this.projection(conversationId);
        if (this.provider.waitForEventStream && projection.reconciledHistoryVisibility?.state.staged && !updates.every(update => validRewrites.has(update))) {
          // Staged native transcript and live inventory have distinct owners.
          // Reconcile their canonical views rather than publishing a hidden
          // launcher or terminal result directly from a live update.
          for (const update of updates) if (update.kind === "status") projection.apply(update);
          const generation = this.backgroundStreamGeneration;
          const fence = projection.beginHistoryRead();
          try { await this.history(conversationId); }
          catch {
            projection.recover(projection.items().flatMap(item => item.type === "background_task" && item.status === "running"
              && !fence.changed(item.id) && !fence.workerChanged(item)
              ? [{ kind: "upsert" as const, item: unverifyWorkerTask(item) }] : []),
            () => !signal.aborted && !this.disposed && this.projections.get(conversationId) === projection
              && generation === this.backgroundStreamGeneration && fence.current()
              && !this.reversibleMutations.has(conversationId) && !this.revertReconciliations.has(conversationId));
            if (this.provider.reconcileBackgroundTasks) this.syncBackgroundState(conversationId);
          } finally { fence.release(); }
          return;
        }
        const workerProgress = this.observeBackgroundSource(conversationId, projection, updates);
        for (const update of updates) {
          const accept = acceptedRewrites.get(update);
          const before = accept && update.kind === "upsert" ? projection.get(update.item.id) : undefined;
          const applied = projection.apply(update.kind === "upsert" ? { ...update, item: this.correlateSteerMessage(conversationId, update.item) } : update);
          if (accept && applied?.type === "item.upsert") accept(before, applied.item);
          if (fallbackDeliveries.has(update)) projection.rememberFallbackStoredOrigins(fallbackDeliveries.get(update)!);
          if (update.kind === "upsert" && sourceOrigins.has(update.item)) {
            const current = projection.get(update.item.id);
            if (current) projection.rememberWorkerOrigins([current], sourceOrigins.get(update.item)!, undefined, true);
          }
          if (update.kind === "upsert" && sourceFallbacks.has(update.item)) {
            const current = projection.get(update.item.id);
            if (current) projection.rememberWorkerFallbacks([current], sourceFallbacks.get(update.item)!);
          }
        }
        const recovery = this.backgroundRecoveries.get(conversationId);
        if (recovery) for (const id of recovery.progress.keys()) if (!projection.has(id)) recovery.progress.delete(id);
        if (workerProgress) this.scheduleBackgroundRecovery(conversationId, true);
        if (this.provider.reconcileBackgroundTasks) this.syncBackgroundState(conversationId);
        // A fast subagent can start and report inside one coalescer window:
        // its usage arrives while the parent's task row is still buffered, so
        // attributeSubagent found no row to decorate and only banked the
        // figures. The row exists now — settle any banked attribution onto
        // task rows this flush just materialized, or a child that never
        // speaks again leaves its row bare until the parent is reopened.
        // Every row of that child is settled, not only the new one: a further
        // task's row changes which messages the earlier rows answer for.
        const settled = new Set<string>();
        for (const update of updates) {
          if (update.kind !== "upsert" || (update.item.type !== "tool" && update.item.type !== "background_task") || !update.item.childConversationId) continue;
          if (rewritten.has(update.item.childConversationId)) continue;
          if (settled.has(update.item.childConversationId)) continue;
          settled.add(update.item.childConversationId);
          this.settleLauncherRows(conversationId, update.item.childConversationId, projection);
        }
      },
    });
    this.eventCoalescer = coalescer;
    const reconcileInboxes = () => {
      for (const id of new Set([...this.projections.keys(), ...this.pendingSteers.keys()])) {
        if (this.provider.waitForEventStream) void this.history(id).catch(() => undefined);
        else void this.reconcilePendingSteers(id).catch(() => undefined);
      }
    };
    // Native V2 has no replay: subscribe before reading recovery truth, then
    // keep consuming deltas while the read is in flight (the inbox tick fence
    // protects newer changes). Legacy providers have no readiness handshake.
    if (!this.provider.waitForEventStream) reconcileInboxes();
    try {
      for await (const normalized of this.provider.events(signal)) {
        if (signal.aborted) break;
        if ((this.provider.reconcileBackgroundTasks || this.provider.waitForEventStream) && normalized.eventType === "server.connected") {
          if (this.provider.waitForEventStream) this.invalidateNativeHistoryAccounting();
          this.backgroundConnected = true;
          this.backgroundReadyResolve?.();
          this.backgroundReadyResolve = undefined;
          this.backgroundStreamGeneration++;
          this.backgroundRecoveryFloorUntil = 0;
          this.backgroundRecoverySourceStartedAt = -Infinity;
          for (const [id, recovery] of this.backgroundRecoveries) {
            recovery.readLifetime?.abort();
            recovery.checking?.finish();
            delete recovery.checkingStarted;
            clearTimeout(recovery.timer);
            recovery.timer = undefined;
            recovery.failures = 0;
            recovery.inconclusiveReads = 0;
            delete recovery.exhaustedAt;
            recovery.progress = this.backgroundProgressBaseline(id);
            delete recovery.sourceProgress;
            delete recovery.sourceProgressBytes;
            delete recovery.sourceProgressLost;
            delete recovery.sourceStartedAt;
            this.seedBackgroundSource(id, recovery);
            recovery.dirty = true;
          }
          this.drainBackgroundRecoveries();
          // Only an initialized, connected provider is read. Activity itself
          // remains memory-only and cannot start a runtime.
          void this.provider.listSessions().then(async sessions => {
            for (const session of sessions) {
              if (signal.aborted || this.disposed) break;
              if (!session.parentId && await this.isInWorkspace(session)) this.scheduleBackgroundRecovery(session.id);
            }
          }).catch(() => undefined);
        }
        if (this.provider.waitForEventStream && normalized.eventType === "server.connected") reconcileInboxes();
        const interactionUpdate = normalized.updates.some(update => update.kind === "upsert" && (update.item.type === "permission" || update.item.type === "question")
          || update.kind === "remove" && /^(permission|question):/.test(update.itemId));
        if (this.provider.reconcileBackgroundTasks && normalized.conversationId && (interactionUpdate || /^(session\.(inbox\.(enqueued|delivered)|tool\.success|message\.content\.updated|execution\.(succeeded|failed|interrupted)))$/.test(normalized.eventType))) {
          void this.requireSession(normalized.conversationId).then(session => {
            this.scheduleBackgroundRecovery(session.parentId ?? session.id);
          }).catch(() => undefined);
        }
        if (normalized.catalogsChanged) {
          this.catalogSequence += 1;
          this.inventory.invalidate();
        }
        if (normalized.outcome === "unrecognized" || normalized.outcome === "unparseable") {
          this.countDiscard(normalized.outcome, normalized.eventType);
        }
        for (const blockType of normalized.skippedBlocks ?? []) this.countSkippedBlock(blockType);
        if (normalized.sessionLifecycle) {
          await this.applySessionLifecycle(normalized.sessionLifecycle);
          if (signal.aborted) break;
          // A deleted session is already gone. Its event metadata is the full
          // confinement and parentage authority; never follow it with a lookup.
          if (normalized.sessionLifecycle.kind === "deleted") continue;
        }
        if (!normalized.conversationId) continue;
        // An event with no timeline updates can still carry a child's model
        // or token report — exactly what a message with only tool or
        // reasoning parts emits. Attribution must see those; only an event
        // carrying nothing at all is skipped.
        if (normalized.updates.length === 0 && normalized.assistantUsage === undefined && normalized.assistantModel === undefined
          && normalized.sessionCostUsd === undefined && normalized.removedMessageId === undefined && normalized.configuration === undefined && normalized.revertLifecycle === undefined && !normalized.notificationTurns?.length) continue;
        // Confinement is checked per event as it arrives, never at flush time:
        // a session that moves out of the workspace must stop publishing from
        // that moment, and events received while it was confined stay valid.
        let eventSession: ProviderSession;
        try {
          eventSession = await this.requireSession(normalized.conversationId);
        } catch (error) {
          if (error instanceof ConversationNotFoundError) continue;
          throw error;
        }
        if (signal.aborted) break;
        if (normalized.revertLifecycle) {
          coalescer.discard(normalized.conversationId);
          this.scheduleRevertReconciliation(normalized.conversationId, normalized.revertLifecycle);
          continue;
        }
        await this.observeNotifications(normalized);
        if (normalized.configuration) {
          const current = await this.configuration(normalized.conversationId);
          const configuration = { ...current, ...normalized.configuration };
          if (normalized.replaceModel && normalized.configuration.model) {
            configuration.model = normalized.configuration.model;
            if (normalized.configuration.variant) configuration.variant = normalized.configuration.variant;
            else delete configuration.variant;
          }
          this.configurations.set(normalized.conversationId, configuration);
          if (!sameConfiguration(current, configuration)) {
            this.projection(normalized.conversationId).replay.publish({ type: "conversation.configuration", configuration });
          }
        }
        // Inbox deltas are the dock's, applied in order and at once; the
        // timeline updates that may ride the same event go through the
        // coalescer as before.
        const timelineUpdates: NormalizedProviderUpdate[] = [];
        for (const update of normalized.updates) {
          if (update.kind === "inbox") {
            this.applyInboxDelta(normalized.conversationId, update.delta);
            // The dock settles immediately. Stored-result provenance follows
            // the same serialized handoff as its possibly buffered notice.
            if (update.delta.kind === "settled" && update.delta.outcome === "delivered"
              && normalized.workerOriginUpdates?.some(origin => !origin.toolUseId && origin.messageId === update.delta.id)) timelineUpdates.push(update);
          }
          else timelineUpdates.push(update);
        }
        // A coalesced add/remove may never reach the timeline. Active reads
        // still need its occurrence identity to respect the newer removal.
        this.projections.get(normalized.conversationId)?.touchWorkerOccurrences(timelineUpdates);
        if (normalized.workerOriginUpdates?.length) {
          const projection = this.projection(normalized.conversationId);
          // Delivery can confirm an already projected notification-only result.
          // Launcher origins instead follow their verified normalized upsert,
          // so a reused call cannot re-anchor an unrelated retained row.
          projection.rememberWorkerOrigins(projection.items(), normalized.workerOriginUpdates.filter(origin => !origin.toolUseId), undefined, true);
          for (const update of timelineUpdates) if (update.kind === "upsert" && update.item.type === "background_task") sourceOrigins.set(update.item, normalized.workerOriginUpdates);
        }
        if (normalized.workerResultFallbacks?.length) for (const update of timelineUpdates) if (update.kind === "upsert") {
          const relations = normalized.workerResultFallbacks.filter(relation => sameConversationItems([update.item], [relation.fallback]));
          if (relations.length) sourceFallbacks.set(update.item, relations);
        }
        if (normalized.workerOriginUpdates?.length) for (const update of timelineUpdates) {
          if (update.kind === "inbox" && update.delta.kind === "settled" && update.delta.outcome === "delivered") {
            fallbackDeliveries.set(update, normalized.workerOriginUpdates.filter(origin => !origin.toolUseId && origin.messageId === update.delta.id));
          }
        }
        if (this.provider.waitForEventStream) this.markNativeHistoryDirty(normalized.conversationId,
          !this.projections.get(normalized.conversationId)?.reconciledHistoryVisibility?.state.staged);
        coalescer.push(normalized.conversationId, timelineUpdates);
        if (this.provider.waitForEventStream && normalized.updates.some(update => update.kind === "inbox" && update.delta.kind === "settled"
          && update.delta.outcome === "delivered" && !this.projection(normalized.conversationId!).has(`message:${update.delta.id}`)
          && !timelineUpdates.some(candidate => candidate.kind === "upsert" && candidate.item.id === `message:${update.delta.id}`))) {
          if (!this.markNativeHistoryDirty(normalized.conversationId)) void this.history(normalized.conversationId).catch(() => undefined);
        }
        // OpenCode never emits `question.v2.asked`, so the arrival of the
        // `question` tool part is the only live signal that a question was
        // asked or answered. Ask the provider for the real pending set and
        // publish the difference; without this a question is invisible until
        // the next snapshot, which meant reloading the browser to see it.
        if (normalized.updates.some(isQuestionToolUpdate)) {
          this.refreshQuestions(normalized.conversationId, coalescer, eventSession.parentId);
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
        await this.attributeSubagent(normalized.conversationId, normalized.assistantUsage, normalized.assistantModel, normalized.sessionCostUsd, normalized.removedMessageId, coalescer);
        // And for the subagents a subagent launches itself: they are rows in
        // ITS timeline, so the conversation above it learns of them here.
        await this.trackLaunchers(normalized.conversationId, normalized.updates, coalescer);
      }
    } finally {
      coalescer.dispose();
      await coalescer.settled();
      this.backgroundConnected = false;
      this.backgroundReadyResolve?.();
      this.backgroundReadyResolve = undefined;
      this.backgroundStreamGeneration++;
      if (this.provider.waitForEventStream) this.invalidateNativeHistoryAccounting();
      for (const recovery of this.backgroundRecoveries.values()) { clearTimeout(recovery.timer); recovery.timer = undefined; recovery.checking?.finish(); delete recovery.checkingStarted; }
      if (this.provider.reconcileBackgroundTasks && !this.disposed) {
        for (const [id, projection] of this.projections) {
          for (const item of projection.items()) if (item.type === "background_task" && item.status === "running") projection.apply({ kind: "upsert", item: unverifyWorkerTask(item) });
          this.trackBackgroundActivity(id, projection, projection.status);
        }
        for (const [id, work] of this.backgroundWork) {
          if (!work.verified) continue;
          this.unresolvedBackgroundWork.add(id);
          if (work.legacy) this.backgroundWork.set(id, { legacy: true, verified: false });
          else this.backgroundWork.delete(id);
        }
        this.activityMayHaveChanged();
      }
      if (this.eventCoalescer === coalescer) this.eventCoalescer = null;
    }
  }

  private scheduleBackgroundRecovery(id: string, workerProgress = false): void {
    if (this.disposed || !this.provider.reconcileBackgroundTasks) return;
    const existing = this.backgroundRecoveries.get(id);
    if (existing) {
      if (existing.exhaustedAt !== undefined) {
        if (!workerProgress && Date.now() - existing.exhaustedAt < BACKGROUND_EXHAUSTED_COOLDOWN_MS) return;
        delete existing.exhaustedAt;
        existing.inconclusiveReads = 0;
        delete existing.checkingStarted;
      }
      if (workerProgress) existing.inconclusiveReads = 0;
      existing.dirty = true;
      this.drainBackgroundRecoveries();
      return;
    }
    if (!workerProgress && Date.now() < this.backgroundRecoveryFloorUntil) return;
    if (this.backgroundRecoveries.size >= INVENTORY_SESSION_LIMIT) {
      // Only inactive parked records are disposable here. Active/queued/error
      // recovery keeps its place; overflow waits for another native trigger or
      // an explicit snapshot, which remains independent of this scheduler.
      const oldest = [...this.backgroundRecoveries].find(([, recovery]) => recovery.exhaustedAt !== undefined && !recovery.running);
      if (!oldest) return;
      this.retireBackgroundRecovery(oldest[0]);
    }
    const recovery: BackgroundRecovery = { dirty: true, running: false, failures: 0, inconclusiveReads: 0, progress: this.backgroundProgressBaseline(id),
      ...(Date.now() < this.backgroundRecoveryFloorUntil ? { sourceProgressLost: true as const } : {}) };
    this.seedBackgroundSource(id, recovery);
    this.backgroundRecoveries.set(id, recovery);
    this.drainBackgroundRecoveries();
  }

  private retireBackgroundRecovery(id: string): void {
    const recovery = this.backgroundRecoveries.get(id);
    recovery?.checking?.finish();
    recovery?.readLifetime?.abort();
    if (recovery?.exhaustedAt !== undefined) {
      if (Date.now() >= this.backgroundRecoveryFloorUntil) this.backgroundRecoverySourceStartedAt = -Infinity;
      this.backgroundRecoveryFloorUntil = Math.max(this.backgroundRecoveryFloorUntil, recovery.exhaustedAt + BACKGROUND_EXHAUSTED_COOLDOWN_MS);
      this.backgroundRecoverySourceStartedAt = Math.max(this.backgroundRecoverySourceStartedAt, recovery.sourceStartedAt ?? -Infinity);
      for (const marker of recovery.progress.values()) this.backgroundRecoverySourceStartedAt = Math.max(this.backgroundRecoverySourceStartedAt, marker.startedAt);
    }
    this.backgroundRecoveries.delete(id);
  }

  private retainBackgroundSource(recovery: BackgroundRecovery, item: BackgroundTaskItem, marker: WorkerRecoveryProgress): void {
    recovery.sourceStartedAt = Math.max(recovery.sourceStartedAt ?? -Infinity, marker.startedAt);
    const retained = recovery.sourceProgress ??= new Map();
    for (const key of [`row:${item.id}`, ...workerRecoveryAliases(item)]) {
      const previous = retained.get(key);
      const next = mergeWorkerRecoveryProgress(previous, marker);
      const bytes = Buffer.byteLength(JSON.stringify([key, next]));
      const total = (recovery.sourceProgressBytes ?? 0) - (previous ? Buffer.byteLength(JSON.stringify([key, previous])) : 0) + bytes;
      if ((!previous && retained.size >= BACKGROUND_SOURCE_KEYS) || total > BACKGROUND_SOURCE_BYTES) { recovery.sourceProgressLost = true; continue; }
      retained.set(key, next);
      recovery.sourceProgressBytes = total;
    }
  }

  private seedBackgroundSource(id: string, recovery: BackgroundRecovery): void {
    for (const item of this.projections.get(id)?.filter(item => item.type === "background_task") ?? []) {
      if (item.type === "background_task") this.retainBackgroundSource(recovery, item, recovery.progress.get(item.id) ?? workerRecoveryProgress(item));
    }
  }

  // Only source/coalescer updates call this, never recovery's own results.
  // Compare retained high-water knowledge before applying native updates, so
  // unchanged rediscovery, uncertainty flips and alias renames are not progress.
  private observeBackgroundSource(id: string, projection: ConversationProjection, updates: readonly NormalizedProviderUpdate[]): boolean {
    if (!this.provider.reconcileBackgroundTasks) return false;
    const recovery = this.backgroundRecoveries.get(id);
    if (recovery) for (const update of updates) {
      if (update.kind !== "remove") continue;
      const item = projection.get(update.itemId);
      if (item?.type === "background_task") this.retainBackgroundSource(recovery, item,
        recovery.progress.get(item.id) ?? recovery.sourceProgress?.get(`row:${item.id}`) ?? workerRecoveryProgress(item));
    }
    if (!updates.some(update => update.kind === "upsert" && update.item.type === "background_task")) return false;
    const aliases = this.backgroundProgressAliases(recovery, projection);
    let progress = false;
    for (const update of updates) {
      if (update.kind === "upsert" && update.item.type === "background_task"
        && this.recordBackgroundProgress(recovery, update.item, aliases, projection.get(update.item.id))) progress = true;
    }
    return progress;
  }

  private backgroundProgressAliases(recovery: BackgroundRecovery | undefined, projection: ConversationProjection): Map<string, WorkerRecoveryProgress> {
    const lost = recovery?.sourceProgressLost || !recovery && Date.now() < this.backgroundRecoveryFloorUntil;
    const aliases = new Map(recovery?.sourceProgress);
    for (const item of projection.filter(item => item.type === "background_task")) {
      if (item.type !== "background_task") continue;
      if (lost && item.stateUncertain && !workerRecoveryAliases(item).some(alias => recovery?.sourceProgress?.has(alias))) continue;
      const marker = recovery?.progress.get(item.id) ?? workerRecoveryProgress(item);
      for (const alias of workerRecoveryAliases(item)) aliases.set(alias, mergeWorkerRecoveryProgress(aliases.get(alias), marker));
    }
    return aliases;
  }

  // Source frames and safe reconciliation results share the same retained
  // native high-water comparison. Read-side rediscovery cannot replenish its
  // own budget after a source removal prunes the disposable projected marker.
  private recordBackgroundProgress(recovery: BackgroundRecovery | undefined, item: BackgroundTaskItem, aliases: Map<string, WorkerRecoveryProgress>, current?: ConversationItem, verifiedDiscovery = false): boolean {
    const nativeAliases = workerRecoveryAliases(item);
    let previous = recovery?.progress.get(item.id) ?? recovery?.sourceProgress?.get(`row:${item.id}`) ?? (current?.type === "background_task" ? workerRecoveryProgress(current) : undefined);
    for (const alias of nativeAliases) {
      const marker = aliases.get(alias);
      if (marker) previous = mergeWorkerRecoveryProgress(previous, marker);
    }
    const marker = item.stateUncertain ? previous : mergeWorkerRecoveryProgress(previous, workerRecoveryProgress(item));
    if (!marker) return false;
    const lost = recovery?.sourceProgressLost || !recovery && Date.now() < this.backgroundRecoveryFloorUntil;
    const nativeBasis = nativeAliases.some(alias => aliases.has(alias));
    // Verified first discovery may extend a read cycle. After a retention gap,
    // both paths require retained-native progress or a newer verified start;
    // changing a UI row or repeating an old result is not execution progress.
    const discovery = nativeAliases.length > 0 || verifiedDiscovery;
    const progress = marker !== previous && Boolean(previous && (!lost || nativeBasis)
      || discovery && (!lost || item.createdAt > (recovery?.sourceStartedAt ?? this.backgroundRecoverySourceStartedAt)));
    recovery?.progress.set(item.id, marker);
    if (recovery) this.retainBackgroundSource(recovery, item, marker);
    for (const alias of nativeAliases) aliases.set(alias, mergeWorkerRecoveryProgress(aliases.get(alias), marker));
    return progress;
  }

  private backgroundProgressBaseline(id: string): Map<string, WorkerRecoveryProgress> {
    const progress = new Map<string, WorkerRecoveryProgress>();
    for (const item of this.projections.get(id)?.filter(item => item.type === "background_task") ?? []) {
      if (item.type === "background_task") progress.set(item.id, workerRecoveryProgress(item));
    }
    return progress;
  }

  private syncBackgroundState(id: string): void {
    const projection = this.projection(id);
    this.trackBackgroundActivity(id, projection, projection.status);
    const running = projection.find(item => item.type === "background_task" && !item.foreground && item.status === "running") !== undefined;
    if (running && !isLiveConversationStatus(projection.status) && projection.status !== "background") projection.statusUpdate("background");
    else if (!running && projection.status === "background") projection.statusUpdate("completed", undefined, false);
    this.activityMayHaveChanged();
  }

  private trackBackgroundActivity(id: string, projection: ConversationProjection, status: ConversationStatus): void {
    let legacy = false, verified = false, unresolved = false, hasActivity = false;
    for (const item of projection.filter(item => item.type === "background_task" && !item.foreground)) {
      if (item.type !== "background_task" || item.foreground) continue;
      if (item.activity) {
        hasActivity = true;
        const state = workerState(item.status, item.stateUncertain, item.activity);
        verified ||= state === "working";
        unresolved ||= state === "unknown";
      } else if (this.provider.reconcileBackgroundTasks && item.status === "running") legacy = true;
    }
    // Providers without independent observations retain their authoritative
    // background-status behavior; uncertainty must not turn it off globally.
    legacy ||= status === "background" && !hasActivity;
    if (legacy || verified) this.backgroundWork.set(id, { legacy, verified }); else this.backgroundWork.delete(id);
    if (unresolved) this.unresolvedBackgroundWork.add(id); else this.unresolvedBackgroundWork.delete(id);
  }

  private drainBackgroundRecoveries(): void {
    if (this.disposed || !this.backgroundConnected) return;
    for (const [id, recovery] of this.backgroundRecoveries) {
      if (this.backgroundRecoveryCount >= 4) break;
      if (recovery.running || recovery.timer || recovery.exhaustedAt !== undefined) continue;
      recovery.running = true;
      recovery.dirty = false;
      this.backgroundRecoveryCount++;
      const generation = this.backgroundStreamGeneration;
      const interactionTick = this.interactionClock;
      const readProjection = this.projection(id);
      // One presentation window per admitted cycle, never per retry or paint.
      // This is not native evidence and must not touch the read's source fences.
      if (!recovery.checkingStarted) {
        recovery.checkingStarted = true;
        const checking = readProjection.items().flatMap(item => {
          if (item.type !== "background_task" || item.status !== "running"
            || item.activity && item.activity.kind !== "unavailable" && item.activity.kind !== "session-active"
            || !item.activity && !item.stateUncertain) return [];
          const next = readProjection.workerCheckingPresentation(item, "checking");
          return next ? [next] : [];
        });
        if (checking.length) {
          this.trackBackgroundActivity(id, readProjection, readProjection.status);
          this.activityMayHaveChanged();
          const finish = () => {
            clearTimeout(timer);
            if (recovery.checking?.finish !== finish) return;
            delete recovery.checking;
            for (const item of checking) readProjection.workerCheckingPresentation(item, "unavailable");
          };
          const timer = setTimeout(finish, 10_000);
          timer.unref?.();
          recovery.checking = { finish };
        }
      }
      const checking = recovery.checking;
      const fence = readProjection.beginHistoryRead();
      const lifetime = new AbortController();
      recovery.readLifetime = lifetime;
      const signal = AbortSignal.any([lifetime.signal, ...(this.pumpController ? [this.pumpController.signal] : [])]);
      const workerSources = new WorkerSourceRead(signal);
      let sourceDeadline: ReturnType<typeof setTimeout> | undefined;
      const pending = this.requireSession(id).then(() => {
        if (this.disposed || signal.aborted) throw new Error("Background recovery disposed");
        return Promise.all([
          this.provider.reconcileBackgroundTasks!(id, { signal, onSource: source => {
            if (signal.aborted) return;
            // Queue/ownership IO is not a retained source. Start the bounded
            // handoff only when native evidence actually transfers its lease.
            if (!sourceDeadline) {
              sourceDeadline = setTimeout(() => lifetime.abort(), this.historyReadTimeoutMs);
              sourceDeadline.unref?.();
            }
            workerSources.observe(source.workerSource);
          } }),
          Promise.allSettled([this.pendingPermissions(id), this.pendingQuestions(id)]),
        ]);
      }).then(([tasks, interactions]) => {
        if (this.disposed || this.backgroundRecoveries.get(id) !== recovery || generation !== this.backgroundStreamGeneration) return;
        const projection = this.projection(id);
        if (projection !== readProjection || !fence.current() || !workerSources.isCurrent() || this.reversibleMutations.has(id) || this.revertReconciliations.has(id)) {
          recovery.dirty = true;
          recovery.inconclusiveReads++;
          recovery.progress = this.backgroundProgressBaseline(id);
          return;
        }
        // A busy source does not invalidate independent facts. Read-lifetime
        // alias fences include rows added and removed entirely during the read.
        const safeTasks = tasks.filter(item => !fence.changed(item.id) && !fence.workerChanged(item));
        const progressAliases = this.backgroundProgressAliases(recovery, projection);
        const { byId, supersedes } = indexRecoveredBackgroundTasks(safeTasks);
        const recoveryUpdates: Array<Extract<NormalizedProviderUpdate, { kind: "upsert" | "remove" }>> = [];
        for (const known of projection.items()) {
          if (fence.changed(known.id)) continue;
          if (known.type === "background_task" && supersedes(known)) {
            recoveryUpdates.push({ kind: "remove", itemId: known.id });
            continue;
          }
          if (workerSources.hasSources() && replacesHistoryOnlyOutcome(known, byId.get(known.id))) {
            recoveryUpdates.push({ kind: "remove", itemId: known.id });
            continue;
          }
          if (known.type === "background_task" && known.status === "running" && !byId.has(known.id)) recoveryUpdates.push({ kind: "upsert", item: unverifyWorkerTask(known) });
        }
        for (const item of safeTasks) recoveryUpdates.push({ kind: "upsert", item });
        if (!projection.recover(recoveryUpdates, () => !this.disposed && this.backgroundRecoveries.get(id) === recovery
          && generation === this.backgroundStreamGeneration && this.projections.get(id) === projection && fence.current()
          && workerSources.isCurrent() && !this.reversibleMutations.has(id) && !this.revertReconciliations.has(id))) {
          recovery.dirty = true;
          return;
        }
        // Only committed observations may consume progress. A rejected read
        // must leave an identical successful retry eligible to extend its budget.
        let progress = false;
        for (const item of safeTasks) {
          if (this.recordBackgroundProgress(recovery, item, progressAliases, undefined, true)) progress = true;
        }
        // At most one retained marker per projected worker row, including
        // omitted rows kept uncertain. No growing retired-identity registry.
        for (const id of recovery.progress.keys()) if (!projection.has(id)) recovery.progress.delete(id);
        // Inventory recovery must expose already-pending child requests even
        // when no parent is selected. Failed reads are unknown, not empty;
        // per-item and stream-generation fences also govern these snapshots.
        for (const [index, type] of (["permission", "question"] as const).entries()) {
          if (!(type === "permission" ? this.provider.listPermissions : this.provider.listQuestions)) continue;
          const result = interactions[index]!;
          if (result.status !== "fulfilled") continue;
          const live = new Set(result.value.map(item => item.id));
          for (const known of projection.items()) {
            if (known.type !== type || known.status !== "pending" || live.has(known.id)
              || fence.changed(known.id)
              || (this.announced.get(known.id)?.tick ?? 0) > interactionTick) continue;
            projection.apply({ kind: "remove", itemId: known.id });
            if (known.type === "permission") this.retireRecoveredPermission(known, id);
            else this.resolveAnnounced(known.id);
          }
          for (const item of result.value) {
            if (fence.changed(item.id)) continue;
            if ((item.type === "permission" || item.type === "question") && !this.announced.has(item.id)) {
              this.announced.set(item.id, { owner: item.conversationId ?? id, destination: id, tick: ++this.interactionClock });
            }
            projection.apply({ kind: "upsert", item });
            this.syncRecoveredPermission(item);
          }
        }
        this.syncBackgroundState(id);
        recovery.failures = interactions.some(result => result.status === "rejected") ? recovery.failures + 1 : 0;
        if (progress) recovery.inconclusiveReads = 0;
        recovery.inconclusiveReads = recovery.dirty || projection.find(item => item.type === "background_task" && item.status === "running" && item.stateUncertain === true) ? recovery.inconclusiveReads + 1 : 0;
      }, () => {
        if (this.disposed || this.backgroundRecoveries.get(id) !== recovery || generation !== this.backgroundStreamGeneration) return;
        if (!workerSources.isCurrent()) {
          recovery.dirty = true;
          recovery.inconclusiveReads++;
          recovery.progress = this.backgroundProgressBaseline(id);
          return;
        }
        if (!readProjection.recover(readProjection.items().flatMap(known => known.type === "background_task" && known.status === "running"
          && !fence.changed(known.id) && !fence.workerChanged(known)
          ? [{ kind: "upsert" as const, item: unverifyWorkerTask(known) }] : []),
        () => !this.disposed && this.backgroundRecoveries.get(id) === recovery && generation === this.backgroundStreamGeneration
          && this.projections.get(id) === readProjection && fence.current() && workerSources.isCurrent()
          && !this.reversibleMutations.has(id) && !this.revertReconciliations.has(id))) recovery.dirty = true;
        this.syncBackgroundState(id);
        recovery.failures++;
      }).finally(() => {
        clearTimeout(sourceDeadline);
        lifetime.abort();
        if (recovery.readLifetime === lifetime) delete recovery.readLifetime;
        checking?.finish();
        fence.release();
        this.backgroundPending.delete(pending);
        this.backgroundRecoveryCount--;
        recovery.running = false;
        if (this.disposed) return;
        if (this.backgroundRecoveries.get(id) !== recovery) { this.drainBackgroundRecoveries(); return; }
        if (generation !== this.backgroundStreamGeneration) {
          recovery.failures = 0;
          recovery.inconclusiveReads = 0;
          recovery.progress = this.backgroundProgressBaseline(id);
          recovery.dirty = true;
        }
        if (recovery.failures) {
          recovery.timer = setTimeout(() => { recovery.timer = undefined; this.drainBackgroundRecoveries(); }, Math.min(30_000, 1_000 * 2 ** Math.min(5, recovery.failures - 1)));
          recovery.timer.unref?.();
        } else if (recovery.inconclusiveReads >= BACKGROUND_INCONCLUSIVE_READ_LIMIT) {
          recovery.exhaustedAt = Date.now();
          // Remember recovered knowledge without treating the read itself as
          // a source-progress exception or extending the exhausted budget.
          this.seedBackgroundSource(id, recovery);
          recovery.dirty = false;
          // Keep parked recency for bounded eviction, with no runnable entry
          // or self-scheduled probe until an eligible external trigger arrives.
          this.backgroundRecoveries.delete(id);
          this.backgroundRecoveries.set(id, recovery);
        } else if (recovery.inconclusiveReads) {
          recovery.timer = setTimeout(() => { recovery.timer = undefined; this.drainBackgroundRecoveries(); }, recovery.dirty ? BACKGROUND_DIRTY_RETRY_MS : 1_000 * 2 ** (recovery.inconclusiveReads - 1));
          recovery.timer.unref?.();
        } else if (!recovery.dirty && generation === this.backgroundStreamGeneration) this.backgroundRecoveries.delete(id);
        this.drainBackgroundRecoveries();
      });
      this.backgroundPending.add(pending);
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
    const startedAt = this.permissionQueueOrder.beginRead();
    const pending = await this.provider.listPermissions();
    // A child-only refresh also needs its verified parent destination. Cache
    // that metadata before the accepted recovery is published synchronously.
    if (pending.some(request => request.conversationId === id)) await this.parentOf(id).catch(() => null);
    const ids = pending.map(request => `permission:${request.requestId}`);
    this.permissionQueueOrder.reconcile(ids, startedAt);
    const listed = new Set(ids);
    // The same request can be held by its owner and its parent. Publish order
    // corrections to both before either surface can offer a different head.
    for (const projection of this.projections.values()) {
      for (const item of projection.filter(item => item.type === "permission" && item.status === "pending" && listed.has(item.id))) {
        if (item.type !== "permission") continue;
        const ordered = this.permissionQueueOrder.observe(item);
        if (ordered.queueOrder !== item.queueOrder) projection.upsert(ordered);
      }
    }
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
      const item = this.permissionQueueOrder.observe({
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
        // The recovered card must show what the live one would have —
        // this path exists for the reader who missed that event.
        ...(request.alwaysPatterns === undefined ? {} : { alwaysPatterns: request.alwaysPatterns }),
        ...(request.diff === undefined ? {} : { diff: request.diff }),
        ...(request.plan === undefined ? {} : { plan: request.plan }),
        ...(request.choices === undefined ? {} : { choices: request.choices }),
        ...(request.sourceToolId === undefined ? {} : { sourceToolId: request.sourceToolId }),
        ...(request.mcp === undefined ? {} : { mcp: request.mcp }),
      });
      items.push(item);
    }
    return items;
  }

  /** Called only after the read's resolution/history fences have accepted it.
   * Whichever transcript recovered a queue head, its retained owner and
   * mirrored parent must offer the same request. Never reopen resolved copies. */
  private syncRecoveredPermission(item: ConversationItem): void {
    if (item.type !== "permission" || item.status !== "pending" || !item.conversationId) return;
    const parentId = this.sessionParents.get(item.conversationId);
    for (const [id, projection] of this.projections) {
      // An existing mirrored request also proves the destination if the
      // parent lookup is temporarily unavailable. It does not create a view.
      if (id !== item.conversationId && id !== parentId
        && !projection.find(candidate => candidate.type === "permission" && candidate.conversationId === item.conversationId)) continue;
      const current = projection.get(item.id);
      if (current?.type === "permission" && current.status === "resolved") continue;
      if (!current || !sameConversationItems([current], [item])) projection.upsert(item);
    }
  }

  /** An accepted pending-list absence retires every retained copy of the same
   * owning request. Either the owner or its parent may be refreshed first. */
  private retireRecoveredPermission(item: PermissionRequest, conversationId: string): void {
    const owner = item.conversationId ?? conversationId;
    for (const [id, projection] of this.projections) {
      const current = projection.get(item.id);
      if (current?.type === "permission" && current.status === "pending" && (current.conversationId ?? id) === owner) {
        projection.apply({ kind: "remove", itemId: item.id });
      }
    }
    this.permissionCreatedAt.delete(item.id);
    this.resolveAnnounced(item.id);
  }

  /** The provider's live background tasks for this conversation, as running rows. */
  /** Null when the provider cannot list: unknown, not empty. */
  /**
   * Put each subagent's banked tally onto the row that launched it, reading
   * a child's store first where the tally is not yet squared against it.
   * Used for a history page and for the items a reversible-history
   * replacement puts in a projection's place — raw rows from the provider,
   * which carry no attribution of their own.
   */
  private async attributeLaunchers(id: string, items: ConversationItem[], complete?: readonly ConversationItem[], signal?: AbortSignal, sources?: WorkerSourceRead, refresh = false, cohort?: LauncherCohortRead): Promise<void> {
    const unattributed = [...new Set(items.flatMap(item =>
      // Reconcile on parent refresh, normally at most once per 30 seconds.
      // Nested association proof and changed-source retries bypass that cache;
      // neither path introduces polling or refreshes on every paint.
      (item.type === "tool" || item.type === "background_task") && item.childConversationId
        && (refresh || Date.now() - (this.completeAttributions.get(attributionKey(id, item.childConversationId)) ?? 0) >= 30_000
          // A cached nested transcript is accounting, not fresh association
          // proof. Reconcile its edges under this enclosing read's leases.
          || sources && (this.childTranscripts.get(attributionKey(id, item.childConversationId))?.launchers.length ?? 0) > 0)
        ? [item.childConversationId]
        : []))];
    await Promise.all(unattributed.map(childId => this.reconstructAttribution(id, childId, new Set(), signal, sources)));
    // A row's figure depends on its place among ALL the rows that launched
    // the same child — the k-th row states the k-th task. A page holds only
    // some of them, so the order is taken from the complete transcript where
    // the provider exposes it, and from the page alone only where it does not.
    const rowsByChild = new Map<string, TaskRow[]>();
    for (const row of launcherRows([...(complete ?? items)])) {
      rowsByChild.set(row.childConversationId, [...(rowsByChild.get(row.childConversationId) ?? []), taskRow(row)]);
    }
    const attributions = new Map<string, RowAttribution>();
    const incomplete = new Set(cohort?.incomplete);
    for (const childId of new Set([...rowsByChild.keys(), ...incomplete])) {
      const rows = rowsByChild.get(childId) ?? [];
      if (this.unresolvedTaskRows(id, childId, rows)) incomplete.add(childId);
      if (this.provider.watchWorkerAssociations) {
        const key = attributionKey(id, childId);
        if (rows.length || this.attributionEpochs.has(key) || this.hasRetainedAttribution(key)) {
          this.attributionReadEpoch(key);
          const owner = this.attributionEpochs.get(key)!;
          const proof = rows.length > 0 && !incomplete.has(childId) && this.ownAccountingCurrent(key, sources)
            && ((owner.allocationFloor ?? 0) <= 0 || this.ownAccountingCurrent(key, sources, true))
            && (rows.length >= (owner.allocationFloor ?? 0) || (this.childTranscripts.get(key)?.prompts.length ?? Infinity) <= rows.length);
          // A banked session tally is not proof for a changed task occurrence.
          // Without current accounting, only the exact retained cohort may fold
          // it; otherwise retain each unchanged row through the existing fence.
          if (!proof && owner.allocationFloor === undefined && !cohort?.matchesRetained(childId, rows)) incomplete.add(childId);
          cohort?.observe(childId, owner, rows, incomplete.has(childId), proof);
          if (owner.allocationFloor !== undefined && !proof) incomplete.add(childId);
        }
      }
      if (incomplete.has(childId)) continue;
      this.rowAttributions(id, childId, rows, sources).forEach((attribution, index) => attributions.set(rows[index]!.id, attribution));
    }
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      if ((item.type === "tool" || item.type === "background_task") && item.childConversationId) {
        const key = attributionKey(id, item.childConversationId);
        if (this.childSessionCosts.get(key)?.costUsd != null || this.childUsage.get(key)?.size || this.childModels.get(key)?.size || item.workerSession) items[index] = { ...item, workerSession: workerSessionReport(this.childSessionCosts.get(key)?.costUsd, this.childModels.get(key)) };
      }
      if (item.type !== "tool") continue;
      if (item.childConversationId && incomplete.has(item.childConversationId)) {
        items[index] = cohort?.retain(items[index] as ToolItem) ?? items[index]!;
        continue;
      }
      const attribution = attributions.get(item.id);
      if (!attribution || Object.keys(attribution).length === 0) continue;
      items[index] = { ...items[index] as ToolItem, ...attribution };
      this.rememberLauncherAccounting(id, item.childConversationId!, items[index]!, rowsByChild.get(item.childConversationId!)!.find(row => row.id === item.id)!);
    }
  }

  private async liveScheduledWakeups(id: string): Promise<ConversationItem[]> {
    if (!this.provider.listScheduledWakeups) return [];
    try {
      return (await this.provider.listScheduledWakeups())
        .filter(wakeup => wakeup.conversationId === id)
        .map(wakeup => ({
          id: `wakeup:${wakeup.wakeupId}`,
          type: "scheduled_wakeup" as const,
          createdAt: wakeup.createdAt,
          wakeupId: wakeup.wakeupId,
          prompt: wakeup.prompt,
          recurring: wakeup.recurring,
          schedule: wakeup.schedule,
          ...(wakeup.nextFireAt === undefined ? {} : { nextFireAt: wakeup.nextFireAt }),
          status: "pending" as const,
        }));
    } catch {
      return [];
    }
  }

  private async liveBackgroundTasks(id: string): Promise<ConversationItem[] | null> {
    if (!this.provider.listBackgroundTasks) return null;
    try {
      return (await this.provider.listBackgroundTasks())
        .filter(task => task.conversationId === id)
        .map(task => ({
          id: `task:${task.taskId}`,
          type: "background_task" as const,
          createdAt: task.startedAt,
          taskId: task.taskId,
          description: task.description,
          ...(task.taskType === undefined ? {} : { taskType: task.taskType }),
          ...(task.toolUseId === undefined ? {} : { toolUseId: task.toolUseId }),
          status: "running" as const,
          ...(task.subagentType === undefined ? {} : { subagentType: task.subagentType }),
          ...(task.prompt === undefined ? {} : { prompt: task.prompt }),
          ...(task.usage === undefined ? {} : { usage: task.usage }),
          ...(task.outputFile === undefined ? {} : { outputFile: task.outputFile }),
          ...(task.childConversationId === undefined ? {} : { childConversationId: task.childConversationId }),
        }));
    } catch {
      return null;
    }
  }

  /** Publishes a conversation's own pending permissions into its projection. */
  private async seedPendingPermissions(conversationId: string): Promise<void> {
    try {
      const projection = this.projection(conversationId);
      for (const item of await this.pendingPermissions(conversationId)) {
        if (!projection.has(item.id)) projection.apply({ kind: "upsert", item });
        this.syncRecoveredPermission(item);
      }
    } catch { /* unknown, not empty — requirePending still decides */ }
  }

  /** Cached because a reconciliation may ask about the same session twice. */
  private async isChildOf(candidate: string, parentId: string): Promise<boolean> {
    if (candidate === parentId) return false;
    return (await this.parentOf(candidate)) === parentId;
  }

  /** Throws on provider failure — an errored list is unknown, not empty. */
  private async pendingQuestions(id: string, rememberTimestamps = true): Promise<QuestionRequest[]> {
    if (!this.provider.listQuestions) return [];
    const pending = await this.provider.listQuestions();
    const items: QuestionRequest[] = [];
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
      if (rememberTimestamps) this.questionCreatedAt.set(itemId, createdAt);
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
        ...(request.source === undefined ? {} : { source: request.source }),
        ...(request.intro === undefined ? {} : { intro: request.intro }),
        ...(request.link === undefined ? {} : { link: request.link }),
        ...(request.schema === undefined ? {} : { schema: request.schema }),
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

  private async questionReadScope(id: string, parentId: string | undefined): Promise<Set<string>> {
    const scope = new Set([id]);
    let parent: string | null | undefined = parentId;
    while (parent && !scope.has(parent)) {
      scope.add(parent);
      parent = await this.parentOf(parent);
    }
    return scope;
  }

  /** Retain pending removal authority; lend empty-set authority only to reads
   * already in flight. Each read observes the latest set, not a mutation log. */
  private publishQuestionSet(owner: string, pending: Set<string>, age: number, source: QuestionSetRead, children: boolean): void {
    if (pending.size) this.publishedQuestions.set(owner, pending);
    else this.publishedQuestions.delete(owner);
    for (const read of this.questionReads) {
      // A source proves its ancestor path before listing. This includes
      // newly discovered children's empty sets without borrowing authority
      // from unrelated roots (or requiring a retained tree/revision registry).
      if (read === source || (owner !== read.conversationId && !source.scope.has(read.conversationId)
        && !(children && owner === read.parentId))) continue;
      if (age < read.age) {
        // Older publication is not a newer observation. It can introduce rows
        // after this read's sweep, so revoke its admission and retry instead.
        read.conflicted = true;
        read.revision++;
        continue;
      }
      const coverage: QuestionSetCoverage = read.sets.get(owner) ?? {};
      const kind = children ? "children" : "own";
      if (age <= read.age || age < (coverage[kind]?.age ?? 0)) continue;
      coverage.parentId = owner === source.conversationId ? source.parentId : source.conversationId;
      coverage[kind] = { ids: pending, age };
      read.sets.set(owner, coverage);
      read.revision++;
    }
  }

  private questionAuthority(read: QuestionSetRead, item: QuestionRequest): QuestionSetObservation | undefined {
    const owner = item.conversationId ?? read.conversationId;
    const owning = read.sets.get(owner);
    const parent = owner === read.conversationId ? read.parentId : owning?.parentId ?? this.sessionParents.get(owner);
    const applicable = [read.sets.get(read.conversationId)?.children, owning?.own, owning?.children,
      parent ? read.sets.get(parent)?.children : undefined];
    return applicable.reduce<QuestionSetObservation | undefined>((latest, fact) => fact && (!latest || fact.age > latest.age) ? fact : latest, undefined);
  }

  /**
   * Republishes the pending-question set for one conversation: upserts what is
   * pending now and removes what no longer is (answered elsewhere, or from the
   * CLI). Fire-and-forget with one refresh in flight per conversation — a turn
   * emits many `question` tool updates and each must not become a round trip.
   */
  private refreshQuestions(conversationId: string, coalescer: ProviderUpdateCoalescer, parentId?: string): void {
    if (!this.provider.listQuestions || this.questionRefreshes.has(conversationId)) return;
    this.questionRefreshes.add(conversationId);
    void (async () => {
      try {
        const scope = await this.questionReadScope(conversationId, parentId);
        const questionTick = this.interactionClock;
        for (let attempt = 0; attempt < 3; attempt++) {
          const source: QuestionSetRead = { conversationId, parentId, scope, sets: new Map(), age: ++this.questionReadClock, conflicted: false, revision: 0 };
          if (!this.disposed) this.questionReads.add(source);
          try {
            let items = await this.pendingQuestions(conversationId, false);
            if (source.conflicted) continue;
            const projection = this.projection(conversationId);
            const current = projection.items().filter((item): item is QuestionRequest => item.type === "question" && item.status === "pending");
            // Prefer a fresh list while retries remain. On the final attempt
            // reconcile applicable membership instead of abandoning discovery:
            // a child's empty set cannot exclude its parent's own question.
            if (source.sets.size && attempt < 2) continue;
            const authority = (item: QuestionRequest) => this.questionAuthority(source, item);
            items = items.filter(item => authority(item)?.ids.has(item.id) ?? true);
            // Younger history can discover a question absent from the captured
            // list. Borrow its committed row, but not a grandchild outside this
            // list's coverage. References live only for this active read.
            for (const owner of source.sets.keys()) {
              for (const item of this.projections.get(owner)?.items() ?? []) {
                if (item.type !== "question" || item.status !== "pending") continue;
                const itemOwner = item.conversationId ?? owner;
                const parent = source.sets.get(itemOwner)?.parentId ?? this.sessionParents.get(itemOwner);
                if (itemOwner !== conversationId && parent !== conversationId) continue;
                if (!authority(item)?.ids.has(item.id) || items.some(candidate => candidate.id === item.id)) continue;
                items.push(item);
              }
            }
            for (const item of current) {
              if (!authority(item)?.ids.has(item.id) && (this.announced.get(item.id)?.tick ?? 0) <= questionTick) continue;
              const index = items.findIndex(candidate => candidate.id === item.id);
              if (index < 0) items.push(item);
              else items[index] = item;
            }
            for (const item of items) if (!this.questionCreatedAt.has(item.id)) this.questionCreatedAt.set(item.id, item.createdAt);
            const live = new Set(items.map(item => item.id));
            const previous = this.publishedQuestions.get(conversationId) ?? new Set<string>();
            const updates: NormalizedProviderUpdate[] = items.map(item => ({ kind: "upsert", item }));
            for (const id of previous) {
              if (live.has(id)) continue;
              updates.push({ kind: "remove", itemId: id });
              this.questionCreatedAt.delete(id);
            }
            // Only evidence covering this entire owner's set can renew its
            // child-inclusive age; descendant/owner-only facts keep their scope.
            const age = Math.max(source.age, source.sets.get(conversationId)?.children?.age ?? 0);
            this.publishQuestionSet(conversationId, live, age, source, true);
            if (updates.length > 0) {
              await this.observeNotifications({ conversationId, updates, outcome: "handled", eventType: "questions.refreshed" });
              coalescer.push(conversationId, updates);
              // This fallback is the only path that discovers a subagent's
              // question at all (no asked event exists), and the pump's mirror
              // only sees the original tool update — so without mirroring here
              // the parent shows a task running and no sign anything is waiting.
              await this.mirrorToParent(conversationId, updates, coalescer);
            }
            return;
          } finally { this.questionReads.delete(source); }
        }
      }
      // A failed refresh must reach THIS catch with the published set intact:
      // treating it as an empty pending list would remove live questions and
      // leave the agent blocked with nothing on screen to answer.
      catch { /* a failed refresh leaves the next tool update to retry */ }
      finally { this.questionRefreshes.delete(conversationId); }
    })();
  }

  /**
   * Resolves a request exactly as it was announced — same owner, same
   * launching conversation — from the record kept at announcement, so a
   * removal reported by the parent, or by a reconciliation that retires the
   * card, needs no provider lookup. False when nothing was announced under
   * this id: there is then nothing pending to resolve.
   */
  private resolveAnnounced(itemId: string): boolean {
    const match = /^(question|permission):(.+)$/.exec(itemId);
    const known = match ? this.announced.get(itemId) : undefined;
    if (!match || !known) return false;
    this.announced.delete(itemId);
    this.notifications.observe({
      type: "interaction", origin: "live", conversationId: known.destination,
      sourceId: JSON.stringify([known.owner, match[2]]),
      kind: match[1] === "question" ? "question-pending" : "permission-pending",
      pending: false, createdAt: Date.now(),
    });
    return true;
  }

  private async observeNotifications(event: NormalizedProviderEvent): Promise<void> {
    if (!event.conversationId) return;
    if (!event.notificationTurns?.length && !event.updates.some(update =>
      update.kind === "upsert" && (update.item.type === "question" || update.item.type === "permission")
      || update.kind === "remove" && /^(question|permission):/.test(update.itemId))) return;
    const session = await this.requireSession(event.conversationId);
    for (const turn of event.notificationTurns ?? []) {
      this.notifications.observe({ ...turn, origin: "live", type: "turn", conversationId: session.id, child: Boolean(session.parentId) });
    }
    // Child requests appear in their launching conversation. Use the owning
    // session in the source key so mirroring never creates a second alert.
    let destination = session;
    const visited = new Set([session.id]);
    while (destination.parentId && !visited.has(destination.parentId)) {
      visited.add(destination.parentId);
      destination = await this.requireSession(destination.parentId);
    }
    for (const update of event.updates) {
      if (update.kind === "upsert" && (update.item.type === "question" || update.item.type === "permission")) {
        const item = update.item;
        const owner = item.conversationId ?? session.id;
        if (item.status !== "pending" && this.resolveAnnounced(item.id)) continue;
        if (item.status === "pending") this.announced.set(item.id, { owner, destination: destination.id, tick: ++this.interactionClock });
        this.notifications.observe({
          type: "interaction", origin: "live", conversationId: destination.id,
          sourceId: JSON.stringify([owner, item.requestId]),
          kind: item.type === "question" ? "question-pending" : "permission-pending",
          pending: item.status === "pending", createdAt: item.createdAt,
        });
      } else if (update.kind === "remove") {
        const match = /^(question|permission):(.+)$/.exec(update.itemId);
        if (!match || this.resolveAnnounced(update.itemId)) continue;
        // Never announced here — nothing is pending under it, but a resolution
        // after a lost pending frame must still reach the hub.
        this.notifications.observe({
          type: "interaction", origin: "live", conversationId: destination.id,
          sourceId: JSON.stringify([session.id, match[2]]),
          kind: match[1] === "question" ? "question-pending" : "permission-pending",
          pending: false, createdAt: Date.now(),
        });
      }
    }
  }

  private async requireSession(id: string): Promise<ProviderSession> {
    // A provider failure propagates as itself: the pump treats not-found as
    // "skip this frame" but must restart on transport errors, and the API
    // routes should answer 500, not 404, when the provider is unreachable.
    const session = await this.provider.getSession(id);
    if (!session || !await this.isInWorkspace(session)) throw new ConversationNotFoundError();
    return session;
  }

  private async classifyInventorySession(
    session: Pick<ProviderSession, "id" | "title" | "directory" | "parentId">,
    deleted = false,
  ): Promise<InventorySessionMetadata> {
    const parentId = session.parentId ?? null;
    boundedSet(this.sessionParents, session.id, parentId, INVENTORY_SESSION_LIMIT);
    return {
      inWorkspace: await this.isInWorkspace(session),
      parentId,
      title: session.title,
      deleted,
    };
  }

  private rememberInventorySession(id: string, next: InventorySessionMetadata, invalidate: boolean): void {
    const previous = this.inventorySessions.get(id);
    boundedSet(this.inventorySessions, id, next, INVENTORY_SESSION_LIMIT);
    if (!invalidate) return;
    const wasVisible = inventoryVisible(previous);
    const isVisible = inventoryVisible(next);
    if (wasVisible !== isVisible || (isVisible && previous?.title !== next.title)) this.inventory.invalidate();
  }

  private async applySessionLifecycle(lifecycle: NormalizedSessionLifecycle): Promise<void> {
    if (lifecycle.kind === "deleted") {
      this.cancelRevertReconciliation(lifecycle.id);
      this.forgetActivity(lifecycle.id);
    }
    // A sparse update names only what changed (2.x's rename: id and title).
    // Parentage it does not mention is unchanged, not cleared: a child
    // renamed mid-turn must keep mirroring its requests to its parent. A
    // read that fails leaves the cached answer, which is what it would have
    // been cleared to.
    // A deleted session cannot be read, so a sparse deletion takes the
    // cached parent and nothing else.
    const parentId = lifecycle.sparse
      ? lifecycle.kind === "deleted"
        ? this.sessionParents.get(lifecycle.id) ?? null
        : await this.parentOf(lifecycle.id).catch(() => this.sessionParents.get(lifecycle.id) ?? null)
      : lifecycle.parentId ?? null;
    // Classification forgets the activity of a session outside the workspace.
    const next = await this.classifyInventorySession({ ...lifecycle, parentId: parentId ?? undefined }, lifecycle.kind === "deleted");
    if (!next.inWorkspace) this.cancelRevertReconciliation(lifecycle.id);
    const previous = this.inventorySessions.get(lifecycle.id);
    // A sparse event's directory is the workspace by assumption, not by the
    // wire (2.x's deletion carries none), so it vouches for nothing unseen:
    // only a session this adapter listed can have left the list.
    const eventDescribesVisibleSession = lifecycle.sparse
      ? this.listedSessions.has(lifecycle.id)
      : next.inWorkspace && next.parentId === null;
    const relevantDeletion = lifecycle.kind === "deleted"
      && previous?.deleted !== true
      && (inventoryVisible(previous) || eventDescribesVisibleSession);
    this.rememberInventorySession(lifecycle.id, next, lifecycle.kind !== "deleted");
    if (relevantDeletion) this.inventory.invalidate();
  }

  private async configuration(id: string): Promise<ConversationConfiguration> {
    const cached = this.configurations.get(id);
    if (cached) return cached;
    const existing = this.configurationReads.get(id);
    if (existing) return existing;
    const read = this.provider.getConversationConfiguration(id).then(configuration => {
      // Prompt acceptance may have populated the cache while the provider read
      // was in flight. That newer value wins over the earlier recovered state.
      const current = this.configurations.get(id);
      if (current) return current;
      this.configurations.set(id, configuration);
      return configuration;
    }).finally(() => {
      if (this.configurationReads.get(id) === read) this.configurationReads.delete(id);
    });
    this.configurationReads.set(id, read);
    return read;
  }

  private projection(id: string): ConversationProjection {
    const existing = this.projections.get(id);
    if (existing) {
      // Re-insert to record recency; the Map doubles as the LRU order.
      this.projections.delete(id);
      this.projections.set(id, existing);
      return existing;
    }
    const projection = new ConversationProjection(new ConversationReplay(this.generation, id, this.replayBytes, this.replayClock), (status, sourceTransition) => {
      // `background` is not a live turn: the process is up for the tasks,
      // but the conversation accepts a prompt. Retrying and compacting are.
      const stop = this.stoppingTurns.get(id);
      if (stop) stop.status = status;
      if (isLiveConversationStatus(status)) {
        this.liveTurns.set(id, status);
        if (stop) stop.resumed = true;
      } else this.liveTurns.delete(id);
      // Background work still counts as working for the workspace summary,
      // through its own set so the composer rules above stay untouched.
      this.trackBackgroundActivity(id, projection, status);
      // The conversation settling strands its pending steers (D3);
      // a live turn takes its inbox at its boundaries, so nothing is stranded
      // while one runs.
      if (status === "idle" || status === "completed" || status === "interrupted") this.rememberSettlement(id);
      else if (isLiveConversationStatus(status)) this.settledTurns.delete(id);
      // A turn that ended on its own releases the next held message. Only
      // these two: an interruption leaves the queue dormant by decision, and
      // a failure must not restart a failing conversation by itself.
      if (status === "idle" || status === "completed") {
        if (sourceTransition) {
          const queue = this.heldQueues.get(id);
          if (queue) delete queue.awaitingFreshIdle;
        }
        this.scheduleDelivery(id);
      }
      this.publishPausedChanges(id);
      this.activityMayHaveChanged();
    }, {
      pending: itemId => this.trackInteraction(id, itemId, true),
      settled: itemId => {
        this.trackInteraction(id, itemId, false);
        this.permissionQueueOrder.forget(itemId);
      },
      cleared: () => this.forgetInteractions(id),
      permission: item => this.permissionQueueOrder.observe(item),
    }, (item, current, incoming) => {
      this.carryLauncherAccounting(item, current, incoming);
      this.watchProjectionAssociations(id, item);
    });
    // Seed existing event truth without firing a new transition: recreating a
    // view is not evidence of another execution and must not fence a Stop.
    projection.status = this.liveTurns.get(id) ?? this.stoppingTurns.get(id)?.status ?? "idle";
    this.projections.set(id, projection);
    for (const [candidateId, candidate] of this.projections) {
      if (this.projections.size <= this.maxProjections) break;
      if (candidateId === id || candidate.replay.subscriberCount() > 0) continue;
      // Evicted conversations lose their ring. The shared high-water mark
      // gives a replacement a newer boundary without retaining tombstones;
      // old subscriptions still receive an explicit retention-gap resync.
      this.projections.delete(candidateId);
      if (this.backgroundRecoveries.get(candidateId)?.exhaustedAt !== undefined) this.retireBackgroundRecovery(candidateId);
      this.configurations.delete(candidateId);
      forgetAttributions(this.attributionEpochs, candidateId);
      forgetAttributions(this.attributionArrivals, candidateId);
      forgetAttributions(this.childUsage, candidateId);
      forgetAttributions(this.childSessionCosts, candidateId);
      forgetAttributions(this.childModels, candidateId);
      forgetAttributions(this.childPrompts, candidateId);
      forgetAttributions(this.childTranscripts, candidateId);
      forgetAttributions(this.removedLaunchers, candidateId);
      forgetAttributions(this.removedChildAttribution, candidateId);
      forgetAttributions(this.completeAttributions, candidateId);
    }
    return projection;
  }

  private summary(session: ProviderSession, status: ConversationStatus = this.projections.get(session.id)?.status ?? this.liveTurns.get(session.id) ?? this.stoppingTurns.get(session.id)?.status ?? "idle"): ConversationSummary {
    const summary = { id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, status };
    const projection = this.projections.get(session.id);
    return projection?.status === status ? projection.withVisualStatus(summary) : summary;
  }
}

function inventoryVisible(metadata: InventorySessionMetadata | undefined): boolean {
  return metadata?.inWorkspace === true && metadata.parentId === null && !metadata.deleted;
}

/** A `question` tool part moving in any direction: asked, answered, or failed. */
function isQuestionToolUpdate(update: NormalizedProviderUpdate): boolean {
  return update.kind === "upsert" && update.item.type === "tool" && update.item.name.toLowerCase() === "question";
}

export function parseSlashCommand(text: string, commands: ChatCommand[]): { name: string; arguments: string; command: ChatCommand } | undefined {
  return parsePromptSlashCommand(text, commands);
}

const REVERSIBLE_HISTORY_COMMANDS: ChatCommand[] = [
  { name: "undo", description: "Undo the latest user turn", argumentHint: "", kind: "local-operation" },
  { name: "redo", description: "Redo the next hidden user turn", argumentHint: "", kind: "local-operation" },
];

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

function sameConfiguration(left: ConversationConfiguration, right: ConversationConfiguration): boolean {
  return left.mode === right.mode
    && left.variant === right.variant
    && (left.model === undefined
      ? right.model === undefined
      : right.model !== undefined && sameSelection(left.model, right.model));
}

function sameReversibleHistory(left: ReversibleHistoryState | undefined, right: ReversibleHistoryState): boolean {
  return left?.staged === right.staged
    && left.canUndo === right.canUndo
    && left.canRedo === right.canRedo
    && JSON.stringify(left.revertedMessages) === JSON.stringify(right.revertedMessages);
}

function sameConversationItems(left: ConversationItem[], right: ConversationItem[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function workerRepresentsFallback(item: ConversationItem, { resultId, childConversationId, report }: WorkerResultFallback): boolean {
  return !!report && item.type === "background_task" && item.taskType === "agent" && !item.stateUncertain
    && item.resultId === resultId && item.childConversationId === childConversationId
    && item.status === report.status && item.summary === report.summary;
}

// How a projection reports its interaction requests (permissions, questions)
// becoming pending or settling, and its timeline being rebuilt wholesale.
export type ProjectionInteractionHooks = {
  pending(itemId: string): void;
  settled(itemId: string): void;
  cleared(): void;
  permission?(item: PermissionRequest): PermissionRequest;
};

export class ConversationProjection {
  // Bound to projected worker rows, not a historical/tombstone cache. Exact
  // native message/call anchors survive optional enrichment outages only.
  private readonly workerOrigins = new Map<string, { createdAt: number; worker?: string; taskType?: string; keys: Set<string> }>();
  // Only exact, actually materialized fallback relations enter this map. Its
  // lifetime and size are bounded by this projection's notice rows, not ids
  // guessed from notice-shaped strings or arbitrary synthetic messages.
  private readonly workerFallbacks = new Map<string, WorkerResultFallback & { stored: boolean }>();

  workerFallbackOriginAbsent(item: ConversationItem, source: NonNullable<ProviderHistoryPage["workerOriginCoverage"]>): boolean {
    const prior = this.workerFallbacks.get(item.id);
    return !!prior?.stored && sameConversationItems([item], [prior.fallback])
      && !source.some(origin => !origin.toolUseId && origin.messageId === prior.resultId);
  }

  matchesWorkerFallback(item: ConversationItem, relation: WorkerResultFallback): boolean {
    if (sameConversationItems([item], [relation.fallback])) return true;
    const prior = this.workerFallbacks.get(item.id);
    // Only the exact materialized native relation can bridge enqueue/storage
    // clocks. Changed content and arbitrary notice-shaped ids cannot borrow it.
    return !!prior && prior.resultId === relation.resultId && prior.childConversationId === relation.childConversationId
      && sameConversationItems([item], [prior.fallback])
      && sameConversationItems([{ ...prior.fallback, createdAt: relation.fallback.createdAt }], [relation.fallback]);
  }

  rememberWorkerFallbacks(items: ConversationItem[], relations: readonly WorkerResultFallback[], changed?: (id: string) => boolean, storedOrigins?: ProviderHistoryPage["workerOriginCoverage"]): void {
    const candidates = new Map(items.map(item => [item.id, item]));
    for (const relation of relations) {
      const current = this.get(relation.fallback.id), prior = this.workerFallbacks.get(relation.fallback.id);
      const storedOrigin = storedOrigins?.some(origin => !origin.toolUseId && origin.messageId === relation.resultId
        && origin.childConversationId === relation.childConversationId);
      // Delivery can be learned from storage even when its new normalized
      // presentation is a worker, not the retained enqueue-time notice.
      if (prior && current && !changed?.(current.id) && storedOrigin && this.matchesWorkerFallback(current, relation)) prior.stored = true;
      const item = candidates.get(relation.fallback.id);
      if (item && !changed?.(item.id) && sameConversationItems([item], [relation.fallback])) {
        const stored = !!prior?.stored && prior.resultId === relation.resultId && prior.childConversationId === relation.childConversationId
          && sameConversationItems([prior.fallback], [relation.fallback])
          || !!storedOrigin;
        this.workerFallbacks.set(item.id, { ...relation, stored });
      }
    }
  }

  rememberFallbackStoredOrigins(origins: NonNullable<ProviderHistoryPage["workerOriginCoverage"]>): void {
    for (const relation of this.workerFallbacks.values()) if (origins.some(origin => !origin.toolUseId && origin.messageId === relation.resultId)) relation.stored = true;
  }

  private pruneWorkerFallback(item: ConversationItem): void {
    const prior = this.workerFallbacks.get(item.id);
    if (prior && !sameConversationItems([item], [prior.fallback])) this.workerFallbacks.delete(item.id);
  }

  private matchingWorkerOrigins(item: BackgroundTaskItem, source: NonNullable<ProviderHistoryPage["workerOriginCoverage"]>): Set<string> {
    const calls = new Set([...(item.toolUseIds ?? []), ...(item.toolUseId ? [item.toolUseId] : [])]);
    return new Set(source.filter(origin => (!origin.taskType || origin.taskType === item.taskType) && (!origin.childConversationId || origin.childConversationId === item.childConversationId)
      && (!origin.outputFile || origin.outputFile === item.outputFile)
      && (origin.toolUseId ? calls.has(origin.toolUseId) : origin.messageId === item.resultId))
      .map(origin => JSON.stringify([origin.messageId, origin.toolUseId ?? null])));
  }

  workerOriginsAbsent(item: BackgroundTaskItem, source: NonNullable<ProviderHistoryPage["workerOriginCoverage"]>): boolean {
    const prior = this.workerOrigins.get(item.id);
    if (!prior || prior.createdAt !== item.createdAt || prior.worker !== (item.childConversationId ?? item.outputFile) || prior.taskType !== item.taskType) return false;
    const current = this.matchingWorkerOrigins(item, source);
    return ![...prior.keys].some(key => current.has(key));
  }

  workerReportOriginAbsent(item: BackgroundTaskItem, source: NonNullable<ProviderHistoryPage["workerOriginCoverage"]>): boolean {
    const prior = this.workerOrigins.get(item.id);
    if (!item.resultId || !prior || prior.createdAt !== item.createdAt || prior.worker !== (item.childConversationId ?? item.outputFile) || prior.taskType !== item.taskType) return false;
    const key = JSON.stringify([item.resultId, null]);
    return prior.keys.has(key) && !this.matchingWorkerOrigins(item, source).has(key);
  }

  workerLaunchOriginPresent(item: BackgroundTaskItem, source: NonNullable<ProviderHistoryPage["workerOriginCoverage"]>): boolean {
    const prior = this.workerOrigins.get(item.id);
    if (!prior || prior.createdAt !== item.createdAt || prior.worker !== (item.childConversationId ?? item.outputFile) || prior.taskType !== item.taskType) return false;
    const current = this.matchingWorkerOrigins(item, source);
    return [...prior.keys].some(key => (JSON.parse(key) as [string, string | null])[1] !== null && current.has(key));
  }

  rememberWorkerOrigins(items: ConversationItem[], source: NonNullable<ProviderHistoryPage["workerOriginCoverage"]>, changed?: (id: string) => boolean, append = false): void {
    for (const item of items) {
      if (item.type !== "background_task" || changed?.(item.id)) continue;
      const keys = this.matchingWorkerOrigins(item, source);
      if (!keys.size) continue;
      const worker = item.childConversationId ?? item.outputFile;
      const prior = this.workerOrigins.get(item.id);
      if (append && prior?.createdAt === item.createdAt && prior.worker === worker && prior.taskType === item.taskType) {
        const calls = new Set([...(item.toolUseIds ?? []), ...(item.toolUseId ? [item.toolUseId] : [])]);
        const incomingCalls = new Set(source.flatMap(origin => origin.toolUseId ? [origin.toolUseId] : []));
        for (const key of prior.keys) {
          const [message, call] = JSON.parse(key) as [string, string | null];
          // At most one live anchor per retained native call/result. A reused
          // call cannot accumulate an unbounded per-row history registry.
          if (call ? calls.has(call) && !incomingCalls.has(call) : message === item.resultId) keys.add(key);
        }
      }
      this.workerOrigins.set(item.id, { createdAt: item.createdAt, worker, taskType: item.taskType, keys });
    }
  }
  status: ConversationStatus = "idle";
  // Last boundary whose timeline was reconciled, not merely read for queue
  // policy. Projection eviction naturally retires this view's authority.
  reconciledHistoryVisibility?: { state: ReversibleHistoryState; boundaryId?: string | null };
  private timeline = new Map<string, ConversationItem>();
  private text = new ProviderTextReconciler();
  // Only concurrent covered reads retain change fences. No permanent removal
  // tombstones: each owner releases its set on completion, abort or deadline.
  private readonly historyReads = new Set<{ changed: Set<string>; workerAliases: Set<string>; conversation?: ConversationSummary }>();
  private replacementRevision = 0;
  private mutationRevision = 0;

  beginHistoryRead() {
    const changed = new Set<string>();
    const workerAliases = new Set<string>();
    const read: { changed: Set<string>; workerAliases: Set<string>; conversation?: ConversationSummary } = { changed, workerAliases };
    const revision = this.replacementRevision;
    this.historyReads.add(read);
    return {
      current: () => revision === this.replacementRevision,
      changed: (id: string) => changed.has(id),
      conversation: () => read.conversation,
      workerChanged: (item: BackgroundTaskItem) => workerRecoveryAliases(item).some(alias => workerAliases.has(alias)),
      merge: (items: ConversationItem[]) => {
        const merged = new Map(items.map(item => [item.id, item]));
        for (const id of changed) {
          const current = this.timeline.get(id);
          if (current) merged.set(id, current); else merged.delete(id);
        }
        return [...merged.values()].sort((left, right) => left.createdAt - right.createdAt);
      },
      release: () => { this.historyReads.delete(read); },
    };
  }

  private historyChanged(id: string): void {
    this.mutationRevision++;
    for (const read of this.historyReads) read.changed.add(id);
  }

  private touchWorker(item: ConversationItem | undefined): void {
    if (item?.type !== "background_task" || !this.historyReads.size) return;
    const aliases = workerRecoveryAliases(item);
    for (const read of this.historyReads) for (const alias of aliases) read.workerAliases.add(alias);
  }

  // Source observation precedes coalescing; direct projection updates use the
  // same fence below. Sets live only until their owning covered read releases.
  touchWorkerOccurrences(updates: readonly NormalizedProviderUpdate[]): void {
    if (!this.historyReads.size) return;
    for (const update of updates) {
      if (update.kind === "upsert") {
        this.touchWorker(this.timeline.get(update.item.id));
        this.touchWorker(update.item);
      } else if (update.kind === "remove") this.touchWorker(this.timeline.get(update.itemId));
    }
  }

  constructor(
    readonly replay: ConversationReplay,
    // Every status change flows through statusUpdate, so this single hook is
    // how the adapter keeps its eviction-proof live-turn set accurate.
    private readonly onStatus?: (status: ConversationStatus, sourceTransition: boolean) => void,
    // Every interaction request's lifecycle, so the adapter can keep an
    // eviction-proof record of what awaits the user.
    private readonly interactions?: ProjectionInteractionHooks,
    // Presentation relationships must reach active enclosing reads before the
    // row is visible to their live merge, including direct seeds/replacements.
    private readonly beforePublish?: (item: ConversationItem, current?: ConversationItem, incoming?: ConversationItem) => void,
  ) {}

  has(itemId: string): boolean {
    return this.timeline.has(itemId);
  }

  get(itemId: string): ConversationItem | undefined {
    return this.timeline.get(itemId);
  }

  /** Adapter-owned presentation only: no native progress or history invalidation.
   * Activity object matching prevents a deadline from overwriting newer evidence,
   * while allowing unrelated attribution updates to preserve the same window.
   */
  workerCheckingPresentation(expected: BackgroundTaskItem, kind: "checking" | "unavailable"): BackgroundTaskItem | undefined {
    const current = this.timeline.get(expected.id);
    if (current?.type !== "background_task" || current.activity !== expected.activity || current.status !== "running"
      || current.activity && !["checking", "unavailable", "session-active"].includes(current.activity.kind)
      || !current.activity && !current.stateUncertain) return undefined;
    const item: BackgroundTaskItem = { ...current, activity: { ...current.activity, kind } };
    this.mutationRevision++;
    this.timeline.set(item.id, item);
    this.replay.publish({ type: "item.upsert", item });
    return item;
  }

  items(): ConversationItem[] {
    return [...this.timeline.values()].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  /** First match in insertion order, for lookups that need no timeline order. */
  find(predicate: (item: ConversationItem) => boolean): ConversationItem | undefined {
    for (const item of this.timeline.values()) if (predicate(item)) return item;
    return undefined;
  }

  /** Every matching item, unordered — `items()` sorts the whole timeline, which a per-event caller cannot afford. */
  filter(predicate: (item: ConversationItem) => boolean): ConversationItem[] {
    const found: ConversationItem[] = [];
    for (const item of this.timeline.values()) if (predicate(item)) found.push(item);
    return found;
  }

  seed(items: ConversationItem[]): void {
    this.mutationRevision++;
    for (const item of snapshotClaudeTurns(items)) {
      const current = this.timeline.get(item.id);
      const interaction = mergeInteraction(current, item);
      const merged = interaction.type === "permission" ? this.interactions?.permission?.(interaction) ?? interaction : interaction;
      this.pruneWorkerFallback(merged);
      this.beforePublish?.(merged, current, item);
      this.timeline.set(item.id, merged);
      if (merged.type === "permission" || merged.type === "question") {
        if (merged.status === "pending") this.interactions?.pending(merged.id);
        else this.interactions?.settled(merged.id);
      }
      if (item.type === "assistant_message") this.text.seed(item.id.replace(/^part:/, ""), item.markdown);
      else if (item.type === "reasoning") this.text.seed(item.id.replace(/^part:|^reasoning:/, ""), item.text);
    }
  }

  /** A synchronous, validated row recovery. Fallible merge/provenance hooks
   * run against the old view; a reentrant mutation or revoked admission aborts
   * the candidate. Only then swap the complete map and publish its bounded
   * effective change set. Interaction notifications observe the complete new
   * view and an already committed replay boundary, never a row-by-row prefix. */
  recover(updates: readonly Extract<NormalizedProviderUpdate, { kind: "upsert" | "remove" }>[], admit: () => boolean = () => true, invalidate = false): boolean {
    if (!admit()) return false;
    const revision = this.mutationRevision, cursor = this.replay.latestCursor();
    const prior = this.timeline, staged = new Map(prior);
    const touched = new Set<string>(), settled = new Set<string>();
    const firstRemoval = new Map<string, number>(), lastUpsert = new Map<string, number>();
    for (const [index, update] of updates.entries()) {
      if (update.kind === "remove") {
        if (!firstRemoval.has(update.itemId)) firstRemoval.set(update.itemId, index);
        staged.delete(update.itemId); touched.add(update.itemId); settled.add(update.itemId);
        continue;
      }
      const incoming = preserveClaudeTurn(prior.get(update.item.id), snapshotClaudeItem(update.item)), current = staged.get(incoming.id);
      const interaction = mergeInteraction(current, incoming);
      const merged = interaction.type === "permission" ? this.interactions?.permission?.(interaction) ?? interaction : interaction;
      if ((merged.type === "permission" || merged.type === "question") && merged.status !== "pending") settled.add(merged.id);
      if (merged.type === "question" && !merged.questions.length
        || merged.type === "permission" && !merged.resources.length && merged.plan === undefined) continue;
      this.beforePublish?.(merged, current, incoming);
      staged.set(merged.id, merged); touched.add(merged.id);
      lastUpsert.set(merged.id, index);
    }
    const publication = this.replay.prepareBatch((function* () {
      // A deliberate remove/reinsert is a replacement, not a sparse upsert.
      // Folding it to its final row would let browser merges retain revoked
      // child/usage/control fields. Preserve its ordered reset pair when the
      // complete batch fits; oversized batches still become one resync.
      for (const [index, update] of updates.entries()) {
        const id = update.kind === "remove" ? update.itemId : update.item.id;
        const before = prior.get(id), item = staged.get(id);
        if (update.kind === "remove") {
          if (before && firstRemoval.get(id) === index) yield { type: "item.remove" as const, itemId: id };
        } else if (item && lastUpsert.get(id) === index
          && (!before || firstRemoval.has(id) || !sameConversationItems([before], [item]))) {
          yield { type: "item.upsert" as const, item };
        }
      }
      // A fitting visibility change keeps its existing ordered row events and
      // terminal invalidation. An oversized plan collapses the entire batch,
      // including this marker, to the single resync chosen by prepareBatch.
      if (invalidate) yield { type: "resync" as const, reason: "conversation-rewritten" as const };
    })());
    if (!admit() || this.mutationRevision !== revision || this.replay.latestCursor() !== cursor) return false;
    // No callback or await between the last admission check and publication.
    this.timeline = staged;
    for (const id of touched) {
      const before = prior.get(id), item = staged.get(id);
      this.touchWorker(before); this.touchWorker(item); this.historyChanged(id);
      if (item) {
        this.pruneWorkerFallback(item);
        if (item.type === "assistant_message") this.text.seed(item.id.replace(/^part:/, ""), item.markdown);
        else if (item.type === "reasoning") this.text.seed(item.id.replace(/^part:|^reasoning:/, ""), item.text);
      } else {
        this.workerOrigins.delete(id); this.workerFallbacks.delete(id);
        this.text.forget(id); this.text.forget(id.replace(/^part:|^reasoning:/, ""));
      }
    }
    publication();
    for (const id of settled) this.interactions?.settled(id);
    for (const id of touched) {
      const item = staged.get(id);
      if ((item?.type === "permission" || item?.type === "question") && item.status === "pending") this.interactions?.pending(id);
    }
    return true;
  }

  /** Replace the complete visible state, preserving seed (not sparse upsert)
   * semantics. Required source removals and the terminal rewrite marker share
   * one prepared publication. All fallible hooks/text preparation run against
   * the old view, before the admission check and state swap. */
  replace(items: ConversationItem[], removals: readonly string[] = [], admit: () => boolean = () => true): ChatEvent {
    if (!admit()) throw new HistoryReadChangedError();
    const revision = this.mutationRevision, cursor = this.replay.latestCursor(), prior = this.timeline;
    const staged = new Map<string, ConversationItem>(), text = new ProviderTextReconciler();
    const notifications: ConversationItem[] = [], prunedFallbacks = new Set<string>();
    for (const item of snapshotClaudeTurns(items)) {
      const current = staged.get(item.id), interaction = mergeInteraction(current, preserveClaudeTurn(prior.get(item.id), item));
      const merged = interaction.type === "permission" ? this.interactions?.permission?.(interaction) ?? interaction : interaction;
      const fallback = this.workerFallbacks.get(merged.id);
      if (fallback && !sameConversationItems([merged], [fallback.fallback])) prunedFallbacks.add(merged.id);
      this.beforePublish?.(merged, current, item);
      staged.set(item.id, merged); notifications.push(merged);
      if (item.type === "assistant_message") text.seed(item.id.replace(/^part:/, ""), item.markdown);
      else if (item.type === "reasoning") text.seed(item.id.replace(/^part:|^reasoning:/, ""), item.text);
    }
    const publication = this.replay.prepareBatch((function* () {
      for (const itemId of new Set(removals)) if (prior.has(itemId)) yield { type: "item.remove" as const, itemId };
      yield { type: "resync" as const, reason: "conversation-rewritten" as const };
    })());
    if (!admit() || this.mutationRevision !== revision || this.replay.latestCursor() !== cursor) throw new HistoryReadChangedError();
    // No callback or await between final admission, complete state swap and
    // publication. A queued coalescer flush cannot run inside this commit.
    this.timeline = staged; this.text = text;
    const retained = new Set(staged.keys());
    for (const id of this.workerOrigins.keys()) if (!retained.has(id)) this.workerOrigins.delete(id);
    for (const id of this.workerFallbacks.keys()) if (!retained.has(id) || prunedFallbacks.has(id)) this.workerFallbacks.delete(id);
    this.replacementRevision++;
    for (const id of prior.keys()) this.historyChanged(id);
    for (const id of staged.keys()) this.historyChanged(id);
    const event = publication()!; // Every replacement includes its marker.
    this.interactions?.cleared();
    for (const item of notifications) {
      if (item.type === "permission" || item.type === "question") {
        if (item.status === "pending") this.interactions?.pending(item.id);
        else this.interactions?.settled(item.id);
      }
    }
    return event;
  }

  apply(update: NormalizedProviderUpdate): ChatEvent | undefined {
    if (update.kind === "upsert") return this.upsert(orderedClaudeItem(this.timeline.get(update.item.id), update.item));
    if (update.kind === "remove") {
      this.workerOrigins.delete(update.itemId);
      this.workerFallbacks.delete(update.itemId);
      this.touchWorker(this.timeline.get(update.itemId));
      this.historyChanged(update.itemId);
      this.timeline.delete(update.itemId);
      this.interactions?.settled(update.itemId);
      // A removed item's stream is over: its reconciler text goes with it,
      // or a long conversation would keep every replaced streaming block.
      this.text.forget(update.itemId);
      this.text.forget(update.itemId.replace(/^part:|^reasoning:/, ""));
      return this.replay.publish({ type: "item.remove", itemId: update.itemId });
    }
    // Status reports apply unconditionally, including a completion that
    // lands while a dispatch is still awaiting acceptance: the classic
    // command route resolves only when the whole turn finishes, so that
    // completion is genuine and dropping it would stick the conversation at
    // "running" with the queue frozen. The cost is that a straggling
    // duplicate of the PREVIOUS turn's completion (the merged native and
    // classic streams can both announce one end) may release the next held
    // message early — bounded harm, because delivery admits with the
    // provider's own queue semantics and OpenCode holds it until the active
    // turn actually ends; only removability is lost early. Without turn
    // identity on status events the two cases cannot be told apart here.
    if (update.kind === "status") return this.statusUpdate(update.status, update.message, true, update as typeof update & OpenCodeStepStatus & OpenCodeCompletionAlias);
    // An inbox delta is the adapter's, applied to its pending-steer map
    // before updates reach a projection; one that arrives here is a no-op.
    if (update.kind === "inbox") return undefined;
    const wasNew = update.item !== undefined && !this.timeline.has(update.itemId);
    if (wasNew && update.item) this.timeline.set(update.itemId, orderedClaudeItem(undefined, update.item));
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
    this.historyChanged(update.itemId);
    return this.replay.publish({ type: "item.text_delta", itemId: update.itemId, delta });
  }

  upsert(item: ConversationItem): ChatEvent | undefined {
    item = snapshotClaudeItem(item);
    const current = this.timeline.get(item.id);
    const interaction = mergeInteraction(current, item);
    const merged = interaction.type === "permission" ? this.interactions?.permission?.(interaction) ?? interaction : interaction;
    this.pruneWorkerFallback(merged);
    this.touchWorker(current);
    this.touchWorker(merged);
    // A settled request clears the adapter's record even when the frame is
    // dropped below for lack of content: that record outlives eviction, and a
    // recreated projection may see nothing of the request but its resolution.
    if ((merged.type === "permission" || merged.type === "question") && merged.status !== "pending") this.interactions?.settled(merged.id);
    // A resolution for a question this projection never saw (asked frame
    // missed, projection evicted) has no question content to render, and an
    // empty questions array fails client validation — publishing it would
    // trade one lost frame for a stream resync loop.
    if (merged.type === "question" && merged.questions.length === 0) return undefined;
    // Same for a permission resolution whose ask was never projected: the
    // classic `permission.replied` event carries no action or resources, and
    // an empty resources array fails client validation the same way. A plan
    // approval is the exception on both sides: it legitimately names no
    // resources — the plan itself is the content — and client validation
    // accepts empty resources exactly when a plan is present.
    if (merged.type === "permission" && merged.resources.length === 0 && merged.plan === undefined) return undefined;
    this.historyChanged(item.id);
    this.beforePublish?.(merged, current, item);
    this.timeline.set(item.id, merged);
    if ((merged.type === "permission" || merged.type === "question") && merged.status === "pending") this.interactions?.pending(merged.id);
    if (merged.type === "assistant_message") this.text.seed(merged.id.replace(/^part:/, ""), merged.markdown);
    if (merged.type === "reasoning") this.text.seed(merged.id.replace(/^part:|^reasoning:/, ""), merged.text);
    return this.replay.publish({ type: "item.upsert", item: merged });
  }

  /** Commit private provenance only: public equality does not imply equal proof. */
  refreshEquivalentTool(expected: ToolItem, incoming: ToolItem): void {
    if (this.timeline.get(expected.id) !== expected || !sameConversationItems([expected], [incoming])) return;
    this.beforePublish?.(incoming, expected, incoming);
    this.timeline.set(expected.id, incoming);
    // Older covered reads must merge these newer references, without a replay
    // frame or mutating the frozen proof held by a historical snapshot.
    this.historyChanged(expected.id);
  }

  private stepVisualLive = false;
  private aliasVisualLive = false;

  /** Copy the current primitive hint into this snapshot, never a shared token. */
  withVisualStatus(summary: ConversationSummary): ConversationSummary & OpenCodeStepStatus & OpenCodeCompletionAlias {
    const { [OPENCODE_STEP_LIVE]: _previous, [OPENCODE_ALIAS_LIVE]: _alias, ...current } = summary as typeof summary & OpenCodeStepStatus & OpenCodeCompletionAlias;
    if (this.aliasVisualLive && this.status === "completed" && summary.status === "completed") return { ...current, [OPENCODE_ALIAS_LIVE]: true };
    return this.stepVisualLive && this.status === "failed" && summary.status === "failed"
      ? { ...current, [OPENCODE_STEP_LIVE]: true }
      : current;
  }

  statusUpdate(status: ConversationStatus, message?: string, sourceTransition = true, native?: OpenCodeStepStatus & OpenCodeCompletionAlias): ChatEvent {
    const alias = native?.[OPENCODE_COMPLETION_ALIAS] === true;
    this.aliasVisualLive = alias && (isLiveConversationStatus(this.status) || this.stepVisualLive || this.aliasVisualLive);
    this.status = status;
    this.stepVisualLive = status === "failed" && native?.[OPENCODE_STEP_LIVE] === true;
    // A known step failure is nonterminal. Actual ordered terminal statuses
    // seal retained native history before a later execution can reuse it.
    // Replace rows, not shared tokens: queued earlier frames/snapshots keep
    // their original text and execution boundary, with no extra wire events.
    if (sourceTransition && !alias && (status === "completed" || status === "interrupted" || status === "failed" && !this.stepVisualLive)) {
      const closedTurns = new Map<ClaudeTurn, ClaudeTurn>();
      for (const [id, item] of this.timeline) {
        if (item.type !== "assistant_message") continue;
        const executionLive = (item as typeof item & OpenCodeExecutionIdentity)[OPENCODE_EXECUTION_LIVE] === true;
        const turn = (item as typeof item & ClaudeTextIdentity)[CLAUDE_TURN];
        if (!executionLive && (!turn || turn.completed)) continue;
        let closed: ClaudeTurn | undefined;
        if (turn && !turn.completed) {
          closed = closedTurns.get(turn);
          if (!closed) { closed = Object.freeze({ completed: true }); closedTurns.set(turn, closed); }
        }
        const sealed = { ...item, ...(executionLive ? { [OPENCODE_EXECUTION_LIVE]: false } : {}), ...(closed ? { [CLAUDE_TURN]: closed } : {}) };
        this.timeline.set(id, sealed);
        this.historyChanged(id);
      }
    }
    this.onStatus?.(status, sourceTransition);
    return this.replay.publish({ type: "conversation.status", status, message,
      ...(this.stepVisualLive ? { [OPENCODE_STEP_LIVE]: true as const } : {}),
      ...(alias ? { [OPENCODE_COMPLETION_ALIAS]: true as const } : {}),
      ...(this.aliasVisualLive ? { [OPENCODE_ALIAS_LIVE]: true as const } : {}) });
  }

  conversationUpdate(conversation: ConversationSummary): ChatEvent {
    for (const read of this.historyReads) read.conversation = conversation;
    return this.replay.publish({ type: "conversation.updated", conversation });
  }

  requirePending(requestId: string, type: "permission" | "question"): void {
    const item = this.timeline.get(`${type}:${requestId}`);
    if (!item || (item.type !== "permission" && item.type !== "question") || item.type !== type || item.status !== "pending") {
      throw new InteractionConflictError();
    }
    const own = this.replay.conversationId;
    const owner = item.conversationId ?? own;
    const active = activeInteractionRequests(this.items(), own).find(candidate => (candidate.conversationId ?? own) === owner);
    if (active?.id !== item.id) throw new InteractionConflictError();
  }

  validateQuestionOutcome(requestId: string, outcome: QuestionOutcome): void {
    if (outcome.kind === "rejected") return;
    const item = this.timeline.get(`question:${requestId}`);
    if (!item || item.type !== "question" || outcome.answers.length !== item.questions.length) throw new InteractionConflictError("invalid question response");
    for (let index = 0; index < item.questions.length; index += 1) {
      const question = item.questions[index]!;
      const answers = outcome.answers[index]!;
      if (answers.length === 0 && question.optional) continue;
      if (answers.length === 0 || answers.some(answer => typeof answer !== "string" || answer.trim().length === 0)) {
        throw new InteractionConflictError("question requires a non-empty answer");
      }
      if (!question.multiple && answers.length !== 1) throw new InteractionConflictError("question requires exactly one answer");
      const labels = new Set(question.options.map(option => option.label));
      if (answers.some(answer => !labels.has(answer) && !question.allowFreeForm)) {
        throw new InteractionConflictError("question does not allow free-form answers");
      }
    }
  }

  resolvePermission(requestId: string, outcome: PermissionOutcome, choiceId?: string): void {
    const item = this.timeline.get(`permission:${requestId}`);
    if (!item || item.type !== "permission") throw new InteractionConflictError();
    this.upsert({ ...item, status: "resolved", outcome, ...(choiceId ? { choiceId } : {}) });
  }

  resolveQuestion(requestId: string, outcome: QuestionOutcome): void {
    const item = this.timeline.get(`question:${requestId}`);
    if (!item || item.type !== "question") throw new InteractionConflictError();
    this.upsert({ ...item, status: "resolved", outcome });
  }
}

const MAX_CHILD_ATTRIBUTIONS = 512;
const MAX_CHILD_MESSAGE_REMOVALS = 512;
// NUL: a session id cannot contain one, so the two halves stay unambiguous.
const ATTRIBUTION_SEPARATOR = "\u0000";

/** Whether any figure in `next` is below the same figure in `previous`. */
/** A subagent launched by a subagent: a row in the launching subagent's own timeline. */
type Launcher = { id: string; description: string; subagent?: string; conversationId: string; promptIndex: number; prompt?: string;
  binding: LauncherBinding };
type LauncherBinding = Readonly<{ name: string; status: ToolItem["status"]; createdAt: number; completedAt?: number; inputHash?: string }>;
type DescendantBinding = Readonly<{ parentSessionId: string; sessionId: string; parentId: string;
  parent: LauncherBinding; launcher: LauncherBinding; promptId: string }>;
// A user message in a child session. `text` is what decides whether it is a
// task's prompt: undefined when never seen, empty for a message that carries
// none (OpenCode's compaction request, or its synthetic "continue").
type Prompt = { id: string; text?: string };
// A row (or nested launcher) that gave a subagent a task, with the prompt it gave.
type TaskRow = { id: string; prompt?: string; binding?: LauncherBinding;
  // Candidate references only; every relation still needs immutable proof.
  retainedDescendants?: readonly SubagentLine[];
  // Read-local references to an exact current row's existing descendants.
  // Undefined keeps ordinary pairing; an empty list denies deeper bindings.
  descendantBinding?: readonly SubagentLine[] };
type AttributionOwner = {
  epoch: number;
  allocationRevision: number;
  // Undefined permits allocation; zero is unproven, positive counts record
  // observed missing cohort membership. Neither is ownership or Stop proof.
  allocationFloor?: number;
  // Counterproof only: the last published cohort's exact occurrences at its
  // first membership deficit. Input renewal requires separate native proof.
  allocationOccurrences?: string;
  generationOnly?: boolean;
};
type ChildUsage = Map<string, TokenUsage> & { allocationOwner?: AttributionOwner };
type AllocationPublication = { owner: AttributionOwner; revision: number; rows: readonly TaskRow[]; incomplete: boolean; proof: boolean };
type AccountingInventory = Readonly<{ ownSignature: string; signature: string | undefined; owner: AttributionOwner; revision: number }>;
type NestedAllocationPublication = {
  parentKey: string; key: string; parentId: string; sessionId: string; childId: string;
  parentInventory: AccountingInventory; inventory: AccountingInventory; owner: AttributionOwner; epoch: number;
  proven: boolean;
  parents: readonly Pick<TaskRow, "id" | "binding">[];
  views: Array<{ id: string; childId: string; projection: ConversationProjection | undefined; rows: readonly ConversationItem[] }>;
};
type LauncherCohortRead = {
  incomplete: ReadonlySet<string>;
  matchesRetained: (child: string, rows: readonly TaskRow[]) => boolean;
  retain: (item: ToolItem) => ToolItem;
  observe: (child: string, owner: AttributionOwner, rows: readonly TaskRow[], incomplete: boolean, proof: boolean) => void;
};
type ChildTranscript = { prompts: Prompt[]; launchers: Launcher[] };
type RowAttribution = { model?: string; usage?: TokenUsage; descendants?: SubagentLine[]; workerSession?: ToolItem["workerSession"] };
type LauncherRow = ToolItem & { childConversationId: string };

function transcriptSignature(transcript: ChildTranscript): string {
  return createHash("sha256").update(JSON.stringify(transcript)).digest("hex");
}

function occurrenceSignature(rows: readonly Pick<TaskRow, "id" | "binding">[]): string {
  return createHash("sha256").update(JSON.stringify(rows.map(row => ({ id: row.id, name: row.binding?.name, status: row.binding?.status,
    createdAt: row.binding?.createdAt, completedAt: row.binding?.completedAt })).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0))).digest("hex");
}

/** The rows that launched subagents, oldest first — the order their tasks were given in. */
function launcherRows(items: ConversationItem[]): LauncherRow[] {
  return items
    .filter((item): item is LauncherRow => item.type === "tool" && item.childConversationId !== undefined)
    .sort((left, right) => left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** The prompt a task row gave its subagent, where the row still carries its input. */
function taskPrompt(row: ToolItem): string | undefined {
  const detail = describeToolDetail(row);
  return detail.kind === "agent" && detail.prompt !== "" ? detail.prompt : undefined;
}

function taskRow(row: ToolItem): TaskRow {
  const prompt = taskPrompt(row);
  return { id: row.id, binding: launcherBinding(row), ...(prompt === undefined ? {} : { prompt }) };
}

function launcherBinding(row: ToolItem, known?: LauncherBinding): LauncherBinding {
  const inputHash = row.input === undefined ? known?.inputHash : createHash("sha256").update(row.input).digest("hex");
  return Object.freeze({ name: row.name === "tool" ? known?.name ?? row.name : row.name, status: row.status, createdAt: row.createdAt,
    ...(row.completedAt === undefined ? {} : { completedAt: row.completedAt }), ...(inputHash === undefined ? {} : { inputHash }) });
}

function launcherOf(row: ToolItem & { childConversationId?: string }, promptIndex: number, known?: Launcher): Launcher {
  const detail = describeToolDetail(row);
  // A restatement that has lost its input says nothing new about the task.
  const description = detail.kind === "agent" ? detail.description : known?.description ?? row.name;
  const subagent = detail.kind === "agent" ? detail.subagent : known?.subagent;
  const prompt = taskPrompt(row) ?? known?.prompt;
  return { id: row.id, description, ...(subagent === undefined ? {} : { subagent }), conversationId: row.childConversationId!, promptIndex, ...(prompt === undefined ? {} : { prompt }),
    binding: launcherBinding(row, known?.binding) };
}

function sameLauncher(left: Launcher, right: Launcher): boolean {
  return left.description === right.description && left.subagent === right.subagent && left.conversationId === right.conversationId && left.promptIndex === right.promptIndex && left.prompt === right.prompt
    && sameLauncherBinding(left.binding, right.binding);
}

function sameLauncherBinding(left: LauncherBinding, right: LauncherBinding | undefined): boolean {
  return right !== undefined && left.name === right.name && left.status === right.status && left.createdAt === right.createdAt
    && left.completedAt === right.completedAt && left.inputHash === right.inputHash;
}

function sameDescendantBinding(left: DescendantBinding | undefined, right: DescendantBinding): boolean {
  return left !== undefined && left.parentSessionId === right.parentSessionId && left.sessionId === right.sessionId
    && left.parentId === right.parentId && left.promptId === right.promptId
    && sameLauncherBinding(left.parent, right.parent) && sameLauncherBinding(left.launcher, right.launcher);
}

/** A child's prompts in order and the subagents it launched, each under the prompt it followed. */
function readChildTranscript(items: readonly ConversationItem[], ancestry: ReadonlySet<string>): ChildTranscript {
  const prompts: Prompt[] = [];
  const launchers: Launcher[] = [];
  for (const item of items) {
    if (item.type === "user_message") prompts.push({ id: item.id.replace(/^message:/, ""), text: item.text });
    else if (item.type === "tool" && item.childConversationId && !ancestry.has(item.childConversationId)) {
      launchers.push(launcherOf(item, Math.max(0, prompts.length - 1)));
    }
  }
  return { prompts, launchers };
}

/**
 * Which task row each of a child's prompts belongs to. A subagent's session
 * holds more user messages than the tasks it was given: OpenCode adds a
 * compaction request and a synthetic "continue" every time a long-running
 * subagent summarises itself, and someone can type into it. Pairing by
 * position alone would hand everything after the first such message to the
 * NEXT task — a compaction during task one billed to task two.
 *
 * So a prompt opens the next task row only when it IS that task's prompt: its
 * text is the prompt the row gave. The first task alone may also arrive
 * behind a preamble — its prompt ending with the row's on lines of its own —
 * because OpenCode 2.x opens the prompt that creates a child session with
 * "You are a subagent spawned by another session."; a task given to an
 * existing child arrives bare, so later rows match exactly and a message
 * typed into the child cannot open one early. Any other prompt belongs to
 * the task before it. A prompt whose text was never seen is taken to be a task's — the
 * position it would have had. Where nothing can be compared (an agent that
 * reports no texts, rows that have lost their input) or nothing matched at
 * all, pairing falls back to position, which is right whenever the counts agree.
 */
function pairPrompts(rows: readonly TaskRow[], prompts: readonly Prompt[]): number[] {
  const positional = prompts.map((_, index) => Math.min(index, rows.length - 1));
  if (!rows.some(row => row.prompt !== undefined) || !prompts.some(prompt => prompt.text !== undefined)) return positional;
  let row = -1;
  const paired = prompts.map(prompt => {
    const next = rows[row + 1];
    const opens = next !== undefined && (prompt.text === undefined
      || (next.prompt === undefined ? prompt.text !== "" : deliversPrompt(prompt.text, next.prompt, row < 0)));
    if (opens) row += 1;
    return Math.max(row, 0);
  });
  return row < 0 ? positional : paired;
}

/** Whether a child's prompt is the task prompt a row gave — after a preamble only where one may precede it. */
function deliversPrompt(delivered: string, given: string, preambled: boolean): boolean {
  const text = delivered.trim();
  const prompt = given.trim();
  return prompt !== "" && (text === prompt || (preambled && text.endsWith(`\n${prompt}`)));
}

/**
 * A child's tally, split over the rows that launched it. A subagent handed a
 * further task is one session and several rows: a message belongs to the row
 * its prompt is paired with (`pairPrompts`). Messages that name no prompt
 * belong to the first row (an agent that reports none has one row per child).
 * Every message is counted on exactly one row, so the rows always sum to the
 * session.
 */
function foldByTask(
  rows: readonly TaskRow[],
  prompts: readonly Prompt[] | undefined,
  usage: Map<string, TokenUsage> | undefined,
  models: Map<string, MessageModel> | undefined,
  answered: Map<string, string> | undefined,
): Array<{ model?: string; usage?: TokenUsage }> {
  if (rows.length === 0) return [];
  // Prompts only heard of through a reply are newer than every known one.
  const order = [...(prompts ?? [])];
  if (answered) for (const promptId of answered.values()) if (!order.some(prompt => prompt.id === promptId)) order.push({ id: promptId });
  const pairing = pairPrompts(rows, order);
  const rowOfPrompt = new Map(order.map((prompt, index) => [prompt.id, pairing[index]!]));
  const rowOf = (messageId: string): number => {
    const promptId = answered?.get(messageId);
    return promptId === undefined ? 0 : rowOfPrompt.get(promptId) ?? 0;
  };
  const usageByRow = rows.map(() => new Map<string, TokenUsage>());
  const modelsByRow = rows.map(() => new Map<string, MessageModel>());
  if (usage) for (const [messageId, value] of usage) usageByRow[rowOf(messageId)]!.set(messageId, value);
  if (models) for (const [messageId, value] of models) modelsByRow[rowOf(messageId)]!.set(messageId, value);
  return usageByRow.map((byMessage, index) => {
    const total = sumUsage(byMessage);
    const model = latestModel(modelsByRow[index]);
    return { ...(model === undefined ? {} : { model }), ...(total === undefined ? {} : { usage: total }) };
  });
}

function sameLines(left: readonly SubagentLine[] | undefined, right: readonly SubagentLine[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((line, index) => {
    const other = right[index]!;
    return line.id === other.id && line.parentId === other.parentId && line.description === other.description && line.subagent === other.subagent
      && line.conversationId === other.conversationId && line.model === other.model && sameUsage(line.usage, other.usage);
  });
}

function sameAttribution(row: ToolItem, attribution: RowAttribution): boolean {
  return row.model === attribution.model && sameUsage(row.usage, attribution.usage) && sameLines(row.descendants, attribution.descendants) && sameWorkerSession(row.workerSession, attribution.workerSession);
}

function sameWorkerSession(left: ToolItem["workerSession"], right: ToolItem["workerSession"]): boolean {
  return left?.model === right?.model && left?.effort === right?.effort && left?.costUsd === right?.costUsd;
}

/** Whether the row states something the attribution no longer does — which an upsert's merge would keep. */
function withdraws(row: ToolItem, attribution: RowAttribution): boolean {
  if (row.model !== undefined && attribution.model === undefined) return true;
  if (row.descendants !== undefined && attribution.descendants === undefined) return true;
  if (row.usage === undefined) return false;
  if (attribution.usage === undefined) return true;
  return Object.keys(row.usage).some(component => attribution.usage![component as keyof TokenUsage] === undefined);
}

function attributionKey(parentId: string, childId: string): string {
  return `${parentId}${ATTRIBUTION_SEPARATOR}${childId}`;
}

function forgetAttributions(keyed: Map<string, unknown> | Set<string>, parentId: string): void {
  const prefix = `${parentId}${ATTRIBUTION_SEPARATOR}`;
  for (const key of keyed.keys()) if (key.startsWith(prefix)) keyed.delete(key);
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
    for (const key of TOKEN_USAGE_COMPONENTS) {
      const value = usage[key];
      if (value !== undefined) total[key] = (total[key] ?? 0) + value;
    }
    if (usage.costUsd !== undefined) total.costUsd = (total.costUsd ?? 0) + usage.costUsd;
  }
  return Object.keys(total).length > 0 ? total : undefined;
}

function latestModel(byMessage: Map<string, MessageModel> | undefined): string | undefined {
  let latest: { messageId: string; value: MessageModel } | undefined;
  if (!byMessage) return undefined;
  for (const [messageId, value] of byMessage) {
    if (!latest || value.createdAt > latest.value.createdAt || (value.createdAt === latest.value.createdAt && messageId > latest.messageId)) {
      latest = { messageId, value };
    }
  }
  return latest?.value.model;
}

/** Capture turn evidence with the snapshot's text/cursor, before returning its
 * promise. Native result normalization may seal a shared token before any
 * awaiting service/router resumes. Never freeze or mutate that native token:
 * queued frames still need it, and ordered status sealing replaces retained
 * rows independently. Copies belong only to this bounded snapshot. */
function snapshotClaudeItem(item: ConversationItem, turns?: Map<ClaudeTurn, ClaudeTurn>): ConversationItem {
  const turn = (item as ConversationItem & ClaudeTextIdentity)[CLAUDE_TURN];
  if (!turn || Object.isFrozen(turn)) return item;
  let captured = turns?.get(turn);
  if (!captured) { captured = Object.freeze({ completed: turn.completed }); turns?.set(turn, captured); }
  const snapshot: ConversationItem & ClaudeTextIdentity = { ...item, [CLAUDE_TURN]: captured };
  return snapshot;
}

function snapshotClaudeTurns(items: ConversationItem[]): ConversationItem[] {
  const turns = new Map<ClaudeTurn, ClaudeTurn>();
  return items.map(item => snapshotClaudeItem(item, turns));
}

/** Native apply is ordered; producer normalization is not. A result may already
 * have mutated its native token while this earlier row awaited requireSession.
 * Enroll immutable projection-owned evidence, never that producer's future
 * completion. Historical seed/recover/replace retain their snapshot authority;
 * an already-closed native row id cannot be reopened by a late alias. */
function orderedClaudeItem(current: ConversationItem | undefined, incoming: ConversationItem): ConversationItem {
  if (incoming.type !== "assistant_message" || !(incoming as typeof incoming & ClaudeTextIdentity)[CLAUDE_TURN]) return incoming;
  const retained = (current as (ConversationItem & ClaudeTextIdentity) | undefined)?.[CLAUDE_TURN];
  const ordered: typeof incoming & ClaudeTextIdentity = { ...incoming, [CLAUDE_TURN]: retained && Object.isFrozen(retained) ? retained : Object.freeze({ completed: false }) };
  return ordered;
}

/** Native row ids do not move between turns. Once closed, stale history cannot reopen one. */
function preserveClaudeTurn(current: ConversationItem | undefined, incoming: ConversationItem): ConversationItem {
  if (current?.type !== "assistant_message" || incoming.type !== "assistant_message") return incoming;
  const turn = (current as typeof current & ClaudeTextIdentity)[CLAUDE_TURN];
  if (turn?.completed && !(incoming as typeof incoming & ClaudeTextIdentity)[CLAUDE_TURN]?.completed) {
    const preserved: typeof incoming & ClaudeTextIdentity = { ...incoming, [CLAUDE_TURN]: turn };
    return preserved;
  }
  return incoming;
}

function mergeInteraction(current: ConversationItem | undefined, incoming: ConversationItem): ConversationItem {
  if (!current || current.type !== incoming.type) return incoming;
  if (current.type === "user_message" && incoming.type === "user_message") {
    // Same rule as text below: an update that omits attachments is sparse —
    // classic event aliases and empty-parts message.updated frames know
    // nothing of them — not an instruction to strip the thumbnails.
    const attachments = incoming.attachments ?? current.attachments;
    const preserved = attachments?.length ? { attachments } : {};
    if (current.requestId && !incoming.requestId) return { ...incoming, text: current.text, requestId: current.requestId, ...preserved };
    // A history-loaded message carries no requestId, and message.updated events
    // normalize with empty parts — an empty incoming text is "no new content",
    // not a blanking instruction.
    if (!incoming.text) return { ...incoming, text: current.text, ...preserved };
    return { ...incoming, ...preserved };
  }
  if (current.type === "assistant_message" && incoming.type === "assistant_message") {
    const merged = mergeAssistantMessage(current, incoming);
    // A reconnect's first observed delta is not this retained part's birth.
    // Preserve only against explicitly weak text-start evidence, not against
    // real native starts or general message/model/usage corrections.
    return preserveClaudeTurn(current, (incoming as typeof incoming & OpenCodeTextStart)[OPENCODE_TEXT_START_FALLBACK] === true
      ? { ...merged, createdAt: current.createdAt } : merged);
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
      // Same sparse rule: a second announcement without the agent's
      // always-patterns (the v2 `save` is optional, a reply carries none)
      // says nothing about them, and must not blank the ones already known.
      ...(incoming.alwaysPatterns?.length ? {} : current.alwaysPatterns !== undefined ? { alwaysPatterns: current.alwaysPatterns } : {}),
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
  // A settled background task is terminal too: a late progress patch or a
  // stale running snapshot must neither reopen it nor drop its summary.
  if (current.type === "background_task" && incoming.type === "background_task") {
    const keepTerminal = current.status !== "running";
    const merged = {
      ...current,
      ...incoming,
      status: keepTerminal && incoming.status === "running" ? current.status : incoming.status,
      ...(incoming.summary ?? current.summary ? { summary: incoming.summary ?? current.summary } : {}),
    };
    // A progress note belongs to a running task only.
    if (merged.status !== "running") delete merged.progress;
    return merged;
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
      ...(incoming.descendants ?? current.descendants ? { descendants: incoming.descendants ?? current.descendants } : {}),
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
