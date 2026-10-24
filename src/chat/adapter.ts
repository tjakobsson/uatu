import { randomBytes, randomUUID } from "node:crypto";
import { AgentNotificationTracker, type AgentNotificationEvent } from "./notifications";

import { boundedSet } from "../shared/bounded-map";
import { ProviderUpdateCoalescer } from "./coalescer";
import { ConversationInventoryBroadcaster, type ConversationInventorySubscription } from "./inventory-broadcaster";
import type { InboxDelta, NormalizedProviderEvent, NormalizedProviderUpdate, NormalizedSessionLifecycle, StoredMessageAccounting } from "./provider";
import { describeToolDetail } from "./tool-detail";
import { mergeAssistantMessage, sameUsage, TOKEN_USAGE_COMPONENTS } from "./usage";
import { InterruptNotAppliedError, OperationOutcomeUnknownError, ReversibleHistoryTargetError, UnsupportedVariantSelectionError, type ChatProvider, type ProviderAttachment, type ProviderPermissionReply, type ProviderSession } from "./provider";
import { IdempotencyReceipts } from "./receipts";
import { ConversationReplay, type ReplaySubscription } from "./replay";
import { ProviderTextReconciler } from "./text-reconciler";
import { parsePromptSlashCommand, sideQuestionOperation } from "./slash-commands";
import { isLiveConversationStatus } from "./types";
import type { ChatActionContext, AutomaticBackgroundOutcome, AutomaticBackgroundFeedback } from "./types";
import { hasVerifiedBlockingWork } from "./blocking-work";
import { workerSessionReport, type WorkerMessageModel } from "./worker-session";
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

type MessageModel = WorkerMessageModel;
type InventorySessionMetadata = {
  inWorkspace: boolean;
  parentId: string | null;
  title: string;
  deleted: boolean;
};
type HistoryCoverage = { signal: AbortSignal; assertCurrent: () => void; dirty: () => boolean; revertExclusions: Set<string>; merge: (items: ConversationItem[]) => ConversationItem[]; changed: (id: string) => boolean; inboxReconciled: boolean; markInboxReconciled: () => void; steerCorrelations: ReadonlyMap<string, string> };
class HistoryReadChangedError extends Error {}

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
  automaticBackgroundTimeoutMs?: number;
  steerAdmissionTimeoutMs?: number;
  // Called when activity() may read differently than it last did (already
  // deduplicated here). The service forwards it to whoever watches the
  // workspace's activity summary.
  onActivityChange?: () => void;
  onNotification?: (event: AgentNotificationEvent) => void;
};

export class ChatAdapter {
  private readonly notifications: AgentNotificationTracker;
  readonly generation: string;
  private readonly provider: ChatProvider;
  private readonly workspacePath: string;
  private readonly resolveAttachment: ChatAdapterOptions["resolveAttachment"];
  private readonly replayBytes: number;
  private readonly id: () => string;
  private readonly projections = new Map<string, ConversationProjection>();
  private readonly receipts: IdempotencyReceipts;
  // Question item ids currently published per conversation, so a question that
  // stops being pending can be withdrawn from the timeline.
  private readonly publishedQuestions = new Map<string, Set<string>>();
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
  private readonly backgroundWork = new Set<string>();
  private readonly backgroundRecoveries = new Map<string, { dirty: boolean; running: boolean; failures: number; timer?: ReturnType<typeof setTimeout> }>();
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
  private lastActivity: ChatActivity = { working: false, awaiting: false };
  private readonly maxProjections: number;
  private readonly coalesceWindowMs: number | undefined;
  private readonly metrics: ChatEventMetrics | undefined;
  private readonly countedEventTypes = new Set<string>();
  // Provider-owned state. This cache only avoids repeated reads while a
  // projection is warm; every miss recovers through the provider seam.
  private readonly configurations = new Map<string, ConversationConfiguration>();
  private readonly configurationReads = new Map<string, Promise<ConversationConfiguration>>();
  private readonly nativeHistoryReads = new Map<string, { stream: AbortController | null; promise: Promise<ConversationSnapshot>; recovery: { dirty: boolean } }>();
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
  private readonly heldQueues = new Map<string, HeldMessage[]>();
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
  private readonly childUsage = new Map<string, Map<string, TokenUsage>>();
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
  // Launchers removed before the tally was squared against the store. A
  // stored read in flight would otherwise hand the removed launcher back and
  // bank it — the same race `removedChildAttribution` closes for messages.
  private readonly removedLaunchers = new Map<string, Set<string>>();
  // Ordered live removals survive both refresh and inspection reads until a
  // later live upsert, explicit invalidation or bounded cache retirement.
  private readonly removedChildAttribution = new Map<string, Map<string, number>>();
  private readonly attributionReconstructions = new Map<string, Promise<void>>();
  private readonly attributionEpochs = new Map<string, number>();
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

  private async readCoveredHistory(id: string, options: { cursor?: string; limit?: number }, recovery: { dirty: boolean }): Promise<ConversationSnapshot> {
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
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, ...(stream ? [stream.signal] : [])]);
    const timer = setTimeout(() => lifetime.abort(), 5_000);
    let fence: ReturnType<ConversationProjection["beginHistoryRead"]> | undefined;
    let ready = false;
    let unavailable!: () => void;
    const expired = new Promise<never>((_resolve, reject) => { unavailable = () => reject(new Error("Inbox recovery unavailable")); });
    signal.addEventListener("abort", unavailable, { once: true });
    try {
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
          if (signal.aborted || this.disposed || this.pumpController !== stream || generation !== this.backgroundStreamGeneration) throw new Error("Inbox recovery unavailable");
        };
        // A delivery whose enqueue predates this subscription has no native
        // payload to replay. Reread storage, never invent a row from dock text.
        // The whole handoff, including rereads, shares one bounded lifetime.
        let inboxReconciled = false;
        while (true) {
          recovery.dirty = false;
          fence = this.projection(id).beginHistoryRead();
          try {
            const snapshot = await this.readHistory(id, options, { signal, assertCurrent, dirty: () => recovery.dirty, revertExclusions, merge: fence.merge, changed: fence.changed, inboxReconciled, markInboxReconciled: () => { inboxReconciled = true; }, steerCorrelations });
            inboxReconciled = true;
            assertCurrent();
            if (!recovery.dirty) return snapshot;
          } catch (error) {
            if (!(error instanceof HistoryReadChangedError)) throw error;
          } finally { fence.release(); }
        }
      })(), expired]);
    } catch (error) {
      if (!ready || signal.aborted) throw new Error("Inbox recovery unavailable");
      throw error;
    }
    finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", unavailable);
      fence?.release();
      lifetime.abort();
    }
  }

  private async readHistory(id: string, options: { cursor?: string; limit?: number }, coverage?: HistoryCoverage): Promise<ConversationSnapshot> {
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
    const page = await this.provider.listMessages(id, { cursor: cursor?.provider, limit: options.limit ?? DEFAULT_PAGE_SIZE, ...(coverage ? { signal: coverage.signal } : {}) });
    coverage?.assertCurrent();
    if (coverage && page.revertVisibility && this.provider.getHistoryRevertBoundary) {
      for (const itemId of page.revertVisibility.excludedItemIds) if (this.projection(id).has(itemId)) coverage.revertExclusions.add(itemId);
    }
    // An inspection predating parent eviction/revert cannot repopulate its cleared cache.
    if (parentId && attributionOwner && this.projections.get(parentId) === attributionOwner && this.attributionEpochs.get(inspectionKey!) === inspectionEpoch) {
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
    const items = page.items.map(item => this.correlateSteerMessage(id, item, coverage?.steerCorrelations));
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
    if (this.provider.reconcileBackgroundTasks) {
      let recovered: BackgroundTaskItem[];
      try {
        if (this.pumpPromise && !this.backgroundConnected) {
          await this.backgroundReady;
          if (!this.backgroundConnected) throw new Error("Background stream is disconnected");
        }
        recovered = await this.provider.reconcileBackgroundTasks(id, coverage ? { signal: coverage.signal } : undefined);
      }
      catch { recovered = []; }
      coverage?.assertCurrent();
      const { byId, supersedes } = indexRecoveredBackgroundTasks(recovered);
      for (const known of [...this.projection(id).items(), ...items]) {
        if (known.type !== "background_task" || byId.has(known.id)) continue;
        if (supersedes(known) && !coverage?.changed(known.id)) {
          this.projection(id).apply({ kind: "remove", itemId: known.id });
          const index = items.findIndex(item => item.id === known.id);
          if (index >= 0) items.splice(index, 1);
          continue;
        }
        byId.set(known.id, known.status === "running" ? { ...known, stateUncertain: true } : known);
      }
      for (const task of byId.values()) {
        const index = items.findIndex(item => item.id === task.id);
        if (index < 0) items.push(task); else items[index] = task;
      }
    }
    const liveTasks = this.provider.reconcileBackgroundTasks ? null : await this.liveBackgroundTasks(id);
    if (liveTasks !== null) {
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
    await this.attributeLaunchers(id, items, page.completeItems);
    coverage?.assertCurrent();
    // OpenCode 1.18 never emits `question.v2.asked`, so a pending question is
    // invisible to the event stream and only the provider knows about it.
    // Asking here is what makes an open question answerable at all. A failed
    // list degrades the snapshot (the next refresh republishes) but must not
    // rewrite the published set — that would erase live questions.
    let questionsReconciled = false;
    try {
      const questionTick = this.interactionClock;
      const pendingNow = await this.pendingQuestions(id);
      coverage?.assertCurrent();
      for (const pending of pendingNow) {
        if (items.some(item => item.id === pending.id)) continue;
        items.push(pending);
      }
      if (this.provider.listQuestions) {
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
          projection.apply({ kind: "remove", itemId: existing.id });
          this.questionCreatedAt.delete(existing.id);
          this.resolveAnnounced(existing.id);
        }
      }
      if (pendingNow.length > 0) {
        this.publishedQuestions.set(id, new Set(pendingNow.map(item => item.id)));
        // A recovered child question is ALSO recorded under its owning child:
        // the child's next question-tool update computes removals against
        // that set, and the pump mirrors them into this conversation. Keyed
        // only under the parent, an answer given elsewhere left the parent
        // offering a question OpenCode no longer had — 409 until reload.
        // The sweep is child-inclusive, so each subset is that child's full
        // current pending set and overwriting is safe.
        const byChild = new Map<string, Set<string>>();
        for (const item of pendingNow) {
          if (item.type !== "question") continue;
          const owner = item.conversationId ?? id;
          if (owner === id) continue;
          const set = byChild.get(owner) ?? new Set<string>();
          set.add(item.id);
          byChild.set(owner, set);
        }
        for (const [owner, ids] of byChild) this.publishedQuestions.set(owner, ids);
      } else this.publishedQuestions.delete(id);
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
          projection.apply({ kind: "remove", itemId: existing.id });
          this.permissionCreatedAt.delete(existing.id);
          this.resolveAnnounced(existing.id);
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
    if (coverage) items.splice(0, items.length, ...coverage.merge(items));
    // The live-task snapshot above was taken before several awaits; a task
    // that settled in the projection meanwhile keeps its settled row.
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      if (item.type !== "background_task" || item.status !== "running") continue;
      const current = projection.find(candidate => candidate.id === item.id);
      if (current?.type === "background_task" && current.status !== "running") items[index] = current;
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
      let removed = false;
      const visible = new Set(page.completeItems?.map(item => item.id));
      // The revalidated CURRENT marker is direct exclusion authority, even
      // for a late update of that same discarded row. Earlier-marker evidence
      // survives a commit only against complete coverage and the live fence.
      const excluded = new Set(visibility?.excludedItemIds);
      if (visibility && page.completeItems) for (const itemId of coverage!.revertExclusions) {
        if (!visible.has(itemId) && !coverage!.changed(itemId)) excluded.add(itemId);
      }
      // Recovery of live-only rows above can carry an old task back into the
      // page. Only exact exclusions govern it, not absence from the page.
      for (let index = items.length - 1; index >= 0; index--) if (excluded.has(items[index]!.id)) items.splice(index, 1);
      for (const itemId of excluded) {
        if (!projection.has(itemId)) continue;
        projection.apply({ kind: "remove", itemId });
        removed = true;
      }
      // Recovery is also for clients already listening when V2 reconnects.
      // Publish recovered values, not just a silent seed of the next snapshot.
      for (const item of items) {
        const current = projection.get(item.id);
        if (!current || !sameConversationItems([current], [item])) projection.apply({ kind: "upsert", item });
      }
      if (reversibleHistory) {
        projection.reconciledHistoryVisibility = { state: reversibleHistory, ...(visibility ? { boundaryId: visibility.boundaryId } : {}) };
        this.rememberReversibleHistory(id, reversibleHistory);
      }
      if (removed || visibilityChanged) projection.replay.publish({ type: "resync", reason: "conversation-rewritten" });
    } else projection.seed(items);
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
      conversation: this.summary(session, projection.status),
      configuration,
      generation: this.generation,
      cursor: replayCursor,
      items,
      // A client joining or reloading mid-run gets the same held queue a
      // client that watched it build presents.
      queued: this.queuedMessages(id),
      ...(reversibleHistory ? { reversibleHistory } : {}),
      olderCursor: page.nextCursor ? encodeHistoryCursor({ provider: page.nextCursor }) : undefined,
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
        items: projection.items(),
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
    return { working: this.liveTurns.size > 0 || this.backgroundWork.size > 0, awaiting: this.pendingInteractions.size > 0 };
  }

  pendingNotifications() { return this.notifications.pendingSnapshot(); }

  // Deduplicated at the source: a second conversation starting while one
  // already runs does not change the summary.
  private activityMayHaveChanged(): void {
    const next = this.activity();
    if (next.working === this.lastActivity.working && next.awaiting === this.lastActivity.awaiting) return;
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
    for (const admission of this.admittingSteers.values()) admission.retired = true;
    this.admittingSteers.clear();
    for (const recovery of this.backgroundRecoveries.values()) clearTimeout(recovery.timer);
    this.backgroundRecoveries.clear();
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
        const queue = this.heldQueues.get(conversationId) ?? [];
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
    const admission = Promise.resolve().then(() => this.provider.prompt(conversationId, { id: nativeId, text, delivery: "steer", ...(providerAttachments.length ? { attachments: providerAttachments } : {}) }));
    try {
      accepted = await this.boundedSteerAdmission(admission, nativeId);
      if (waking && projection.status === "sending") projection.statusUpdate("running");
    } catch (error) {
      if (waking && projection.status === "sending") projection.statusUpdate(previousStatus);
      if (error instanceof PrimarySteerOutcomeUnknownError && !this.disposed && !fence.terminal && !fence.retired) {
        awaitingLateAcceptance = true;
        if (sourceHeld && this.heldQueues.get(conversationId)?.includes(sourceHeld)) {
          sourceHeld.unconfirmedSteerId = nativeId;
          this.publishQueue(conversationId, { kind: "paused", messageId: sourceHeld.id });
        } else if (!sourceHeld && !this.pendingSteers.get(conversationId)?.some(entry => entry.id === nativeId && !entry.unconfirmed)) {
          this.recordPendingSteer(conversationId, nativeId, submissionId, submissionOrder, requestId, text, attachmentRefs, queuedAt, true);
        }
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
        }, () => undefined).finally(releaseFence).catch(() => undefined);
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
      if (!unconfirmed) delete existing.unconfirmed;
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
      queue.splice(queue.indexOf(held), 1);
      if (queue.length === 0) this.heldQueues.delete(conversationId);
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
      if (remaining.length) this.heldQueues.set(conversationId, remaining);
      else this.heldQueues.delete(conversationId);
    }
    // Steers learned of only now, on a session with no turn live, have
    // nothing coming to deliver them: stranded until something wakes the
    // agent. Steers already tracked keep the wake and settle bookkeeping.
    if (current.length === 0 && listed.length > 0 && !this.turnActive(conversationId, projection) && !this.settledTurns.has(conversationId)) this.settledTurns.set(conversationId, {});
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
            projection.replay.publish({ type: "conversation.updated", conversation });
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
    const steers = (this.pendingSteers.get(conversationId) ?? []).map(({ id, submissionId, text, queuedAt, requestId, attachments, unconfirmed, resumeUnconfirmed, withdrawalUnconfirmed }): QueuedMessage => ({
      id, submissionId, text, queuedAt, delivery: "steer",
      ...(unconfirmed || resumeUnconfirmed || withdrawalUnconfirmed || settled ? { paused: true as const } : {}),
      ...(unconfirmed || resumeUnconfirmed || withdrawalUnconfirmed ? { unconfirmed: true as const } : {}),
      ...(requestId ? { requestId } : {}),
      ...(attachments?.length ? { attachments } : {}),
    }));
    const held = (this.heldQueues.get(conversationId) ?? []).map(({ id, submissionId, text, queuedAt, requestId, attachments, unconfirmedSteerId }): QueuedMessage => ({
      id, submissionId, text, queuedAt, delivery: "queue",
      ...(heldPaused || unconfirmedSteerId ? { paused: true as const } : {}),
      ...(unconfirmedSteerId ? { unconfirmed: true as const } : {}),
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
    if (!this.heldQueues.get(conversationId)?.length) return;
    void this.enqueuePromptAdmission(conversationId, () => this.deliverNextHeld(conversationId)).catch(() => undefined);
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
      queue.shift();
      if (queue.length === 0) this.heldQueues.delete(conversationId);
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
      this.projection(conversationId).replay.publish({ type: "conversation.updated", conversation });
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
    await this.reconstructAttribution(parentId, childId);
    // The dedupe may have handed back that stale in-flight read; it banks
    // nothing, so square once more from a clean start.
    if (!this.completeAttributions.has(key)) await this.reconstructAttribution(parentId, childId);
    const coalescer = this.eventCoalescer;
    if (!coalescer) return;
    this.decorateLauncherRows(parentId, childId, coalescer);
    await this.refreshAncestors(parentId, coalescer);
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
            ...current.filter((item): item is BackgroundTaskItem => item.type === "background_task" && !ids.has(item.id)).map(item => item.status === "running" ? { ...item, stateUncertain: true } : item),
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
  private reconstructAttribution(parentId: string, childId: string, ancestry: ReadonlySet<string> = new Set()): Promise<void> {
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

  private invalidateNativeHistoryAccounting(): void {
    // V2 has no replay. A previous generation's completeness (or pending
    // reconstruction) cannot stand in for the child's current stored history.
    this.completeAttributions.clear();
    this.attributionReconstructions.clear();
    for (const key of this.attributionEpochs.keys()) this.attributionEpochs.set(key, ++this.attributionSequence);
  }

  private async reconstructAttributionRead(key: string, childId: string, epoch: number, ancestry: ReadonlySet<string>): Promise<void> {
    const byMessage = new Map<string, TokenUsage>();
    const byModel = new Map<string, MessageModel>();
    const byPrompt = new Map<string, string>();
    let transcript: ChildTranscript;
    let descendantsIncomplete = false;
    let sessionCostUsd: number | undefined;
    const readStartedAt = this.attributionSequence;
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
      do {
        const page = await this.provider.listMessages(childId, { cursor, limit: RECONSTRUCTION_READ_LIMIT });
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
      for (const promptId of byPrompt.values()) if (!transcript.prompts.some(prompt => prompt.id === promptId)) transcript.prompts.push({ id: promptId });
      // The child's own subagents are squared against their stores the same
      // way (recursively), each under its own key: nothing is rolled up into
      // this tally, and the lines beneath a row are assembled from those keys
      // when the row is decorated. A grandchild whose read did not complete
      // leaves this tally unmarked too — banked for what it holds, but read
      // again on the next open rather than listing an incomplete nest for good.
      for (const grandchildId of new Set(transcript.launchers.map(launcher => launcher.conversationId))) {
        await this.reconstructAttribution(childId, grandchildId, ancestry);
        if (!this.completeAttributions.has(attributionKey(childId, grandchildId))) descendantsIncomplete = true;
      }
    } catch {
      return;
    }
    // Eviction clears every live value this read would merge. A completion
    // from before that boundary must not repopulate the cleared maps and mark
    // a potentially incomplete answer authoritative.
    if (this.attributionEpochs.get(key) !== epoch) return;
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
    if (liveTranscript) {
      for (const prompt of liveTranscript.prompts) if (!transcript.prompts.some(known => known.id === prompt.id)) transcript.prompts.push(prompt);
      for (const launcher of liveTranscript.launchers) if (!transcript.launchers.some(known => known.id === launcher.id)) transcript.launchers.push(launcher);
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
    this.bankAttribution(this.childUsage, key, byMessage);
    this.bankAttribution(this.childModels, key, byModel);
    this.bankAttribution(this.childPrompts, key, byPrompt);
    this.bankAttribution(this.childTranscripts, key, transcript);
    if ((this.childSessionCosts.get(key)?.sequence ?? 0) <= readStartedAt) this.bankSessionCost(key, sessionCostUsd);
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
    const evicted = boundedSet(map, key, value, MAX_CHILD_ATTRIBUTIONS);
    if (evicted !== undefined) {
      this.completeAttributions.delete(evicted);
      this.attributionEpochs.delete(evicted); // in-flight reads cannot outlive their cache's authority
    }
  }

  private attributionReadEpoch(key: string, renew = false): number {
    const known = this.attributionEpochs.get(key);
    if (known !== undefined && !renew) return known;
    // Never reuse an epoch after eviction: an absent entry cannot validate an
    // older read, nor can a later read accidentally restore its authority.
    const epoch = ++this.attributionSequence;
    this.bankAttribution(this.attributionEpochs, key, epoch);
    return epoch;
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
      this.bankAttribution(this.childUsage, key, byMessage);
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
        this.bankAttribution(this.childTranscripts, key, { ...transcript, prompts: [...transcript.prompts, { id: promptId }] });
      }
    }
    if (removedMessageId !== undefined) {
      const byMessage = this.childUsage.get(key) ?? new Map<string, TokenUsage>();
      byMessage.delete(removedMessageId);
      this.bankAttribution(this.childUsage, key, byMessage);
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
      if (known < 0) launchers.push(next);
      else if (sameLauncher(launchers[known]!, next)) continue;
      else launchers[known] = next;
      changed = true;
    }
    if (!changed) return;
    this.bankAttribution(this.childTranscripts, key, { prompts, launchers });
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
    this.bankAttribution(this.childUsage, key, usage);
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

  /**
   * What each of the rows that launched `childId` should state: the k-th row
   * the spend of the k-th task the child was given, and beneath it the lines
   * of every subagent launched while answering that task, at any depth.
   */
  private rowAttributions(parentId: string, childId: string, rows: readonly TaskRow[]): RowAttribution[] {
    const key = attributionKey(parentId, childId);
    const folds = foldByTask(rows, this.childTranscripts.get(key)?.prompts, this.childUsage.get(key), this.childModels.get(key), this.childPrompts.get(key));
    const beneath = new Map<string, SubagentLine[]>();
    for (const line of this.descendantLines(parentId, childId, rows, new Set([parentId, childId]))) {
      beneath.set(line.parentId, [...(beneath.get(line.parentId) ?? []), line]);
    }
    const branch = (id: string): SubagentLine[] => (beneath.get(id) ?? []).flatMap(line => [line, ...branch(line.id)]);
    return folds.map((fold, index) => {
      const descendants = branch(rows[index]!.id);
      return { ...fold, ...(descendants.length > 0 ? { descendants } : {}) };
    });
  }

  /**
   * The lines beneath the rows that launched `sessionId`: one per task the
   * session gave a subagent of its own, stating that task's own spend, then
   * the same one level further down. A nested launcher hangs off the row of
   * the task during which it was launched — the prompt it follows, paired the
   * way the spend is. `ancestry` stops a loop in the data.
   */
  private descendantLines(parentId: string, sessionId: string, rows: readonly TaskRow[], ancestry: ReadonlySet<string>): SubagentLine[] {
    const transcript = this.childTranscripts.get(attributionKey(parentId, sessionId));
    const launchers = transcript?.launchers ?? [];
    if (launchers.length === 0 || rows.length === 0) return [];
    const pairing = pairPrompts(rows, transcript?.prompts ?? []);
    const byChild = new Map<string, Launcher[]>();
    for (const launcher of launchers) {
      if (ancestry.has(launcher.conversationId)) continue;
      byChild.set(launcher.conversationId, [...(byChild.get(launcher.conversationId) ?? []), launcher]);
    }
    const lines: SubagentLine[] = [];
    for (const [childId, own] of byChild) {
      const key = attributionKey(sessionId, childId);
      const tasks: TaskRow[] = own.map(launcher => ({ id: launcher.id, ...(launcher.prompt === undefined ? {} : { prompt: launcher.prompt }) }));
      const folds = foldByTask(tasks, this.childTranscripts.get(key)?.prompts, this.childUsage.get(key), this.childModels.get(key), this.childPrompts.get(key));
      own.forEach((launcher, index) => lines.push({
        id: launcher.id,
        parentId: rows[Math.min(pairing[launcher.promptIndex] ?? launcher.promptIndex, rows.length - 1)]!.id,
        description: launcher.description,
        ...(launcher.subagent === undefined ? {} : { subagent: launcher.subagent }),
        conversationId: childId,
        ...folds[index],
      }));
      lines.push(...this.descendantLines(sessionId, childId, tasks, new Set([...ancestry, childId])));
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
  private decorateLauncherRows(parentId: string, conversationId: string, coalescer: ProviderUpdateCoalescer): void {
    const parent = this.projections.get(parentId);
    if (!parent) return;
    for (const updates of this.launcherRowUpdates(parentId, conversationId, parent)) coalescer.push(parentId, updates);
  }

  /** The same, applied to a projection directly — for rows a flush has only just materialized. */
  private settleLauncherRows(parentId: string, conversationId: string, parent: ConversationProjection): void {
    for (const updates of this.launcherRowUpdates(parentId, conversationId, parent)) for (const update of updates) parent.apply(update);
  }

  private launcherRowUpdates(parentId: string, conversationId: string, parent: ConversationProjection): NormalizedProviderUpdate[][] {
    const rows = launcherRows(parent.filter(item => item.type === "tool" && item.childConversationId === conversationId));
    const attributions = this.rowAttributions(parentId, conversationId, rows.map(taskRow));
    const key = attributionKey(parentId, conversationId);
    const workerSession = workerSessionReport(this.childSessionCosts.get(key)?.costUsd, this.childModels.get(key));
    const backgroundUpdates: NormalizedProviderUpdate[][] = parent.filter(item => item.type === "background_task" && item.childConversationId === conversationId).flatMap(row =>
      row.type === "background_task" && (this.childSessionCosts.get(key)?.costUsd != null || this.childUsage.get(key)?.size || this.childModels.get(key)?.size || row.workerSession) && !sameWorkerSession(row.workerSession, workerSession)
        ? [[{ kind: "upsert" as const, item: { ...row, workerSession } }]] : []);
    return [...backgroundUpdates, ...rows.flatMap((row, index) => {
      const attribution = { ...attributions[index]!, workerSession };
      // Nothing new to say: most restatements change nothing until the turn's
      // token counts actually move, and an upsert that restates the row
      // verbatim still costs a replay frame for every subscriber.
      if (sameAttribution(row, attribution)) return [];
      const { usage: _usage, model: _model, descendants: _descendants, ...withoutAttribution } = row;
      const item = { ...withoutAttribution, ...attribution };
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

  private async pump(signal: AbortSignal): Promise<void> {
    const coalescer = new ProviderUpdateCoalescer({
      windowMs: this.coalesceWindowMs,
      // The window folds repeated upserts the way the projection applies
      // them, so a sparse frame landing right behind a full one cannot
      // strip what the full one carried (a 2.x tool call's input).
      mergeUpsert: mergeInteraction,
      onFlush: (conversationId, updates) => {
        // Not gated on the abort signal: a graceful stop still applies
        // whatever the coalescer buffered in its final window.
        const projection = this.projection(conversationId);
        for (const update of updates) projection.apply(update.kind === "upsert" ? { ...update, item: this.correlateSteerMessage(conversationId, update.item) } : update);
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
        try {
          await this.requireSession(normalized.conversationId);
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
          if (update.kind === "inbox") this.applyInboxDelta(normalized.conversationId, update.delta);
          else timelineUpdates.push(update);
        }
        coalescer.push(normalized.conversationId, timelineUpdates);
        if (this.provider.waitForEventStream && normalized.updates.some(update => update.kind === "inbox" && update.delta.kind === "settled"
          && update.delta.outcome === "delivered" && !this.projection(normalized.conversationId!).has(`message:${update.delta.id}`)
          && !timelineUpdates.some(candidate => candidate.kind === "upsert" && candidate.item.id === `message:${update.delta.id}`))) {
          const reading = this.nativeHistoryReads.get(normalized.conversationId);
          if (reading?.stream === this.pumpController) reading.recovery.dirty = true;
          else void this.history(normalized.conversationId).catch(() => undefined);
        }
        // OpenCode never emits `question.v2.asked`, so the arrival of the
        // `question` tool part is the only live signal that a question was
        // asked or answered. Ask the provider for the real pending set and
        // publish the difference; without this a question is invisible until
        // the next snapshot, which meant reloading the browser to see it.
        if (normalized.updates.some(isQuestionToolUpdate)) {
          this.refreshQuestions(normalized.conversationId, coalescer);
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
      for (const recovery of this.backgroundRecoveries.values()) { clearTimeout(recovery.timer); recovery.timer = undefined; }
      if (this.provider.reconcileBackgroundTasks && !this.disposed) {
        for (const projection of this.projections.values()) {
          for (const item of projection.items()) if (item.type === "background_task" && item.status === "running") projection.apply({ kind: "upsert", item: { ...item, stateUncertain: true } });
        }
      }
      if (this.eventCoalescer === coalescer) this.eventCoalescer = null;
    }
  }

  private scheduleBackgroundRecovery(id: string): void {
    if (this.disposed || !this.provider.reconcileBackgroundTasks) return;
    const existing = this.backgroundRecoveries.get(id);
    if (existing) { existing.dirty = true; return; }
    this.backgroundRecoveries.set(id, { dirty: true, running: false, failures: 0 });
    this.drainBackgroundRecoveries();
  }

  private syncBackgroundState(id: string): void {
    const projection = this.projection(id);
    const running = projection.find(item => item.type === "background_task" && !item.foreground && item.status === "running") !== undefined;
    if (running) this.backgroundWork.add(id); else this.backgroundWork.delete(id);
    if (running && !isLiveConversationStatus(projection.status) && projection.status !== "background") projection.statusUpdate("background");
    else if (!running && projection.status === "background") projection.statusUpdate("completed");
    this.activityMayHaveChanged();
  }

  private drainBackgroundRecoveries(): void {
    if (this.disposed || !this.backgroundConnected) return;
    for (const [id, recovery] of this.backgroundRecoveries) {
      if (this.backgroundRecoveryCount >= 4) break;
      if (recovery.running || recovery.timer) continue;
      recovery.running = true;
      recovery.dirty = false;
      this.backgroundRecoveryCount++;
      const generation = this.backgroundStreamGeneration;
      const interactionTick = this.interactionClock;
      const pending = this.requireSession(id).then(() => {
        if (this.disposed) throw new Error("Background recovery disposed");
        return Promise.all([
          this.provider.reconcileBackgroundTasks!(id),
          Promise.allSettled([this.pendingPermissions(id), this.pendingQuestions(id)]),
        ]);
      }).then(([tasks, interactions]) => {
        if (this.disposed || recovery.dirty || generation !== this.backgroundStreamGeneration) return;
        const projection = this.projection(id);
        const { byId, supersedes } = indexRecoveredBackgroundTasks(tasks);
        for (const known of projection.items()) {
          if (known.type === "background_task" && supersedes(known)) {
            projection.apply({ kind: "remove", itemId: known.id });
            continue;
          }
          if (known.type === "background_task" && known.status === "running" && !byId.has(known.id)) projection.apply({ kind: "upsert", item: { ...known, stateUncertain: true } });
        }
        for (const item of tasks) projection.apply({ kind: "upsert", item });
        // Inventory recovery must expose already-pending child requests even
        // when no parent is selected. Failed reads are unknown, not empty;
        // stream generation/dirty fences above also govern these snapshots.
        for (const [index, type] of (["permission", "question"] as const).entries()) {
          if (!(type === "permission" ? this.provider.listPermissions : this.provider.listQuestions)) continue;
          const result = interactions[index]!;
          if (result.status !== "fulfilled") continue;
          const live = new Set(result.value.map(item => item.id));
          for (const known of projection.items()) {
            if (known.type !== type || known.status !== "pending" || live.has(known.id)
              || (this.announced.get(known.id)?.tick ?? 0) > interactionTick) continue;
            projection.apply({ kind: "remove", itemId: known.id });
            this.resolveAnnounced(known.id);
          }
          for (const item of result.value) {
            if ((item.type === "permission" || item.type === "question") && !this.announced.has(item.id)) {
              this.announced.set(item.id, { owner: item.conversationId ?? id, destination: id, tick: ++this.interactionClock });
            }
            projection.apply({ kind: "upsert", item });
          }
        }
        this.syncBackgroundState(id);
        recovery.failures = interactions.some(result => result.status === "rejected") || projection.find(item => item.type === "background_task" && item.status === "running" && item.stateUncertain === true) ? recovery.failures + 1 : 0;
      }, () => {
        if (this.disposed) return;
        for (const known of this.projection(id).items()) {
          if (known.type === "background_task" && known.status === "running") this.projection(id).apply({ kind: "upsert", item: { ...known, stateUncertain: true } });
        }
        recovery.failures++;
      }).finally(() => {
        this.backgroundPending.delete(pending);
        this.backgroundRecoveryCount--;
        recovery.running = false;
        if (this.disposed) return;
        if (recovery.failures) {
          recovery.timer = setTimeout(() => { recovery.timer = undefined; this.drainBackgroundRecoveries(); }, Math.min(30_000, 1_000 * 2 ** Math.min(5, recovery.failures - 1)));
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
    const pending = await this.provider.listPermissions();
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
      items.push({
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
    }
    return items;
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
  private async attributeLaunchers(id: string, items: ConversationItem[], complete?: readonly ConversationItem[]): Promise<void> {
    const unattributed = [...new Set(items.flatMap(item =>
      // Reconcile on an existing parent refresh at most once per 30 seconds,
      // including settled children changed while disconnected. No polling loop.
      (item.type === "tool" || item.type === "background_task") && item.childConversationId && Date.now() - (this.completeAttributions.get(attributionKey(id, item.childConversationId)) ?? 0) >= 30_000
        ? [item.childConversationId]
        : []))];
    await Promise.all(unattributed.map(childId => this.reconstructAttribution(id, childId)));
    // A row's figure depends on its place among ALL the rows that launched
    // the same child — the k-th row states the k-th task. A page holds only
    // some of them, so the order is taken from the complete transcript where
    // the provider exposes it, and from the page alone only where it does not.
    const rowsByChild = new Map<string, TaskRow[]>();
    for (const row of launcherRows([...(complete ?? items)])) {
      rowsByChild.set(row.childConversationId, [...(rowsByChild.get(row.childConversationId) ?? []), taskRow(row)]);
    }
    const attributions = new Map<string, RowAttribution>();
    for (const [childId, rows] of rowsByChild) {
      this.rowAttributions(id, childId, rows).forEach((attribution, index) => attributions.set(rows[index]!.id, attribution));
    }
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      if ((item.type === "tool" || item.type === "background_task") && item.childConversationId) {
        const key = attributionKey(id, item.childConversationId);
        if (this.childSessionCosts.get(key)?.costUsd != null || this.childUsage.get(key)?.size || this.childModels.get(key)?.size || item.workerSession) items[index] = { ...item, workerSession: workerSessionReport(this.childSessionCosts.get(key)?.costUsd, this.childModels.get(key)) };
      }
      if (item.type !== "tool") continue;
      const attribution = attributions.get(item.id);
      if (!attribution || Object.keys(attribution).length === 0) continue;
      items[index] = { ...items[index] as ToolItem, ...attribution };
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
      }
    } catch { /* unknown, not empty — requirePending still decides */ }
  }

  /** Cached because a reconciliation may ask about the same session twice. */
  private async isChildOf(candidate: string, parentId: string): Promise<boolean> {
    if (candidate === parentId) return false;
    return (await this.parentOf(candidate)) === parentId;
  }

  /** Throws on provider failure — an errored list is unknown, not empty. */
  private async pendingQuestions(id: string): Promise<ConversationItem[]> {
    if (!this.provider.listQuestions) return [];
    const pending = await this.provider.listQuestions();
    const items: ConversationItem[] = [];
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
      this.questionCreatedAt.set(itemId, createdAt);
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
        if (updates.length > 0) {
          await this.observeNotifications({ conversationId, updates, outcome: "handled", eventType: "questions.refreshed" });
          coalescer.push(conversationId, updates);
          // This fallback is the only path that discovers a subagent's
          // question at all (no asked event exists), and the pump's mirror
          // only sees the original tool update — so without mirroring here
          // the parent shows a task running and no sign anything is waiting.
          await this.mirrorToParent(conversationId, updates, coalescer);
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
    const projection = new ConversationProjection(new ConversationReplay(this.generation, id, this.replayBytes), status => {
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
      if (status === "background" || this.provider.reconcileBackgroundTasks && projection.find(item => item.type === "background_task" && !item.foreground && item.status === "running")) this.backgroundWork.add(id);
      else this.backgroundWork.delete(id);
      // The conversation settling strands its pending steers (D3);
      // a live turn takes its inbox at its boundaries, so nothing is stranded
      // while one runs.
      if (status === "idle" || status === "completed" || status === "interrupted") this.settledTurns.set(id, {});
      else if (isLiveConversationStatus(status)) this.settledTurns.delete(id);
      // A turn that ended on its own releases the next held message. Only
      // these two: an interruption leaves the queue dormant by decision, and
      // a failure must not restart a failing conversation by itself.
      if (status === "idle" || status === "completed") this.scheduleDelivery(id);
      this.publishPausedChanges(id);
      this.activityMayHaveChanged();
    }, {
      pending: itemId => this.trackInteraction(id, itemId, true),
      settled: itemId => this.trackInteraction(id, itemId, false),
      cleared: () => this.forgetInteractions(id),
    });
    // Seed existing event truth without firing a new transition: recreating a
    // view is not evidence of another execution and must not fence a Stop.
    projection.status = this.liveTurns.get(id) ?? this.stoppingTurns.get(id)?.status ?? "idle";
    this.projections.set(id, projection);
    for (const [candidateId, candidate] of this.projections) {
      if (this.projections.size <= this.maxProjections) break;
      if (candidateId === id || candidate.replay.subscriberCount() > 0) continue;
      // Evicted conversations lose their replay ring; a returning client's
      // stale cursor resolves to a retention-gap resync, which is safe.
      this.projections.delete(candidateId);
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
    return { id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, status };
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

// How a projection reports its interaction requests (permissions, questions)
// becoming pending or settling, and its timeline being rebuilt wholesale.
export type ProjectionInteractionHooks = {
  pending(itemId: string): void;
  settled(itemId: string): void;
  cleared(): void;
};

export class ConversationProjection {
  status: ConversationStatus = "idle";
  // Last boundary whose timeline was reconciled, not merely read for queue
  // policy. Projection eviction naturally retires this view's authority.
  reconciledHistoryVisibility?: { state: ReversibleHistoryState; boundaryId?: string | null };
  private readonly timeline = new Map<string, ConversationItem>();
  private readonly text = new ProviderTextReconciler();
  // Only concurrent covered reads retain change fences. No permanent removal
  // tombstones: each owner releases its set on completion, abort or deadline.
  private readonly historyReads = new Set<Set<string>>();

  beginHistoryRead() {
    const changed = new Set<string>();
    this.historyReads.add(changed);
    return {
      changed: (id: string) => changed.has(id),
      merge: (items: ConversationItem[]) => {
        const merged = new Map(items.map(item => [item.id, item]));
        for (const id of changed) {
          const current = this.timeline.get(id);
          if (current) merged.set(id, current); else merged.delete(id);
        }
        return [...merged.values()].sort((left, right) => left.createdAt - right.createdAt);
      },
      release: () => { this.historyReads.delete(changed); },
    };
  }

  private historyChanged(id: string): void {
    for (const read of this.historyReads) read.add(id);
  }

  constructor(
    readonly replay: ConversationReplay,
    // Every status change flows through statusUpdate, so this single hook is
    // how the adapter keeps its eviction-proof live-turn set accurate.
    private readonly onStatus?: (status: ConversationStatus) => void,
    // Every interaction request's lifecycle, so the adapter can keep an
    // eviction-proof record of what awaits the user.
    private readonly interactions?: ProjectionInteractionHooks,
  ) {}

  has(itemId: string): boolean {
    return this.timeline.has(itemId);
  }

  get(itemId: string): ConversationItem | undefined {
    return this.timeline.get(itemId);
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
    for (const item of items) {
      const merged = mergeInteraction(this.timeline.get(item.id), item);
      this.timeline.set(item.id, merged);
      if (merged.type === "permission" || merged.type === "question") {
        if (merged.status === "pending") this.interactions?.pending(merged.id);
        else this.interactions?.settled(merged.id);
      }
      if (item.type === "assistant_message") this.text.seed(item.id.replace(/^part:/, ""), item.markdown);
      else if (item.type === "reasoning") this.text.seed(item.id.replace(/^part:|^reasoning:/, ""), item.text);
    }
  }

  replace(items: ConversationItem[]): ChatEvent {
    for (const id of this.timeline.keys()) this.historyChanged(id);
    for (const item of items) this.historyChanged(item.id);
    this.timeline.clear();
    this.text.clear();
    this.interactions?.cleared();
    this.seed(items);
    return this.replay.publish({ type: "resync", reason: "conversation-rewritten" });
  }

  apply(update: NormalizedProviderUpdate): ChatEvent | undefined {
    if (update.kind === "upsert") return this.upsert(update.item);
    if (update.kind === "remove") {
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
    if (update.kind === "status") return this.statusUpdate(update.status, update.message);
    // An inbox delta is the adapter's, applied to its pending-steer map
    // before updates reach a projection; one that arrives here is a no-op.
    if (update.kind === "inbox") return undefined;
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
    const current = this.timeline.get(item.id);
    const merged = mergeInteraction(current, item);
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
    this.timeline.set(item.id, merged);
    if ((merged.type === "permission" || merged.type === "question") && merged.status === "pending") this.interactions?.pending(merged.id);
    if (merged.type === "assistant_message") this.text.seed(merged.id.replace(/^part:/, ""), merged.markdown);
    if (merged.type === "reasoning") this.text.seed(merged.id.replace(/^part:|^reasoning:/, ""), merged.text);
    return this.replay.publish({ type: "item.upsert", item: merged });
  }

  statusUpdate(status: ConversationStatus, message?: string): ChatEvent {
    this.status = status;
    this.onStatus?.(status);
    return this.replay.publish({ type: "conversation.status", status, message });
  }

  requirePending(requestId: string, type: "permission" | "question"): void {
    const item = this.timeline.get(`${type}:${requestId}`);
    if (!item || (item.type !== "permission" && item.type !== "question") || item.type !== type || item.status !== "pending") {
      throw new InteractionConflictError();
    }
    // Answerable is decided per owning conversation, matching the renderer: a
    // parent shows its own requests next to mirrored subagent ones, and a
    // newer mirrored request must not make the parent's own request refuse
    // the answer its enabled buttons just offered.
    const own = this.replay.conversationId;
    const owner = item.conversationId ?? own;
    const pending = [...this.timeline.values()]
      .filter((candidate): candidate is PermissionRequest | QuestionRequest =>
        (candidate.type === "permission" || candidate.type === "question") && candidate.status === "pending")
      .filter(candidate => (candidate.conversationId ?? own) === owner)
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
    if (pending[0]?.id !== item.id) throw new InteractionConflictError();
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
type Launcher = { id: string; description: string; subagent?: string; conversationId: string; promptIndex: number; prompt?: string };
// A user message in a child session. `text` is what decides whether it is a
// task's prompt: undefined when never seen, empty for a message that carries
// none (OpenCode's compaction request, or its synthetic "continue").
type Prompt = { id: string; text?: string };
// A row (or nested launcher) that gave a subagent a task, with the prompt it gave.
type TaskRow = { id: string; prompt?: string };
type ChildTranscript = { prompts: Prompt[]; launchers: Launcher[] };
type RowAttribution = { model?: string; usage?: TokenUsage; descendants?: SubagentLine[]; workerSession?: ToolItem["workerSession"] };
type LauncherRow = ToolItem & { childConversationId: string };

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
  return { id: row.id, ...(prompt === undefined ? {} : { prompt }) };
}

function launcherOf(row: ToolItem & { childConversationId?: string }, promptIndex: number, known?: Launcher): Launcher {
  const detail = describeToolDetail(row);
  // A restatement that has lost its input says nothing new about the task.
  const description = detail.kind === "agent" ? detail.description : known?.description ?? row.name;
  const subagent = detail.kind === "agent" ? detail.subagent : known?.subagent;
  const prompt = taskPrompt(row) ?? known?.prompt;
  return { id: row.id, description, ...(subagent === undefined ? {} : { subagent }), conversationId: row.childConversationId!, promptIndex, ...(prompt === undefined ? {} : { prompt }) };
}

function sameLauncher(left: Launcher, right: Launcher): boolean {
  return left.description === right.description && left.subagent === right.subagent && left.conversationId === right.conversationId && left.promptIndex === right.promptIndex && left.prompt === right.prompt;
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
    return mergeAssistantMessage(current, incoming);
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
