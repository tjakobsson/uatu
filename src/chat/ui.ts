import { boundedSet } from "../shared/bounded-map";
import { Composer, type PendingQueueAction } from "./composer";
import { escapeHtml } from "../shared/html";
import { createLoadingSignal } from "../preview/loading-signal";
import { measureChatWork } from "./performance";
import { appState } from "../shell/state";
import { presentationLocalStorage } from "../shell/presentation-storage";
import { onUiModeChange } from "../shell/ui-mode";
import { registerBackInterceptor } from "../shell/history";
import { liveChannel, onManualRecovery, registerLiveTeardown, registerRecoveryWork, requestManualRecovery } from "../shell/live";
import { isHubPage } from "../shared/app-url";
import { onWorkspaceCredentialRefresh } from "../terminal/client";
import { ChatApiClient, ChatConnectionInterruptedError, ChatTransportError, type ChatEventStream } from "./client";
import { TimelineAnchorController, type AnchorGeometry, type TimelineAnchor } from "./anchor";
import { CoordinatedScrollOwner, type RevealOptions } from "./coordinated-scroll";
import { ChatViewportController } from "./viewport";
import { notificationAwaiting, notificationConversation } from "./notification-navigation";
import { setActiveTab } from "../shell/tab-bar";
import { expandChatPanel, isChatPanelOpen } from "./surface";
import { CHAT_SURFACE_ACTIVE_EVENT, chatSurfaceInView } from "./surface-visibility";
import { newRequestId } from "./ids";
import { insertCommand, localHistoryOperation, matchingCommands, parsePromptSlashCommand, sideQuestionOperation, slashCommandQuery, type LocalHistoryOperation } from "./slash-commands";
import { LatestRefresh } from "./latest-refresh";
import { navigateWorkspaceFileReference, resolveWorkspaceFileReference } from "./file-references";
import { READER_CLOSED, QueueDockRenderer, RevertedMessagesDockRenderer, TimelineRenderer, decorateAttachmentImages, decorateFileLinks, formatElapsed, latestTodoEntries, questionStepLabel, statusLabel, subagentEntries, workingLabel } from "./timeline-renderer";
import { backgroundTasksByTool, runningBackgroundTasks } from "./background-tasks";
import { pausedStatusLabel, pausedWakeups, pendingWakeups, scheduledStatusLabel, wakeupFireTime } from "./scheduled-wakeups";
import { CompactDisclosure, compactWorkers, workerSummary, type CompactWorker } from "./compact-work";
import { WorkerDismissalClient, visibleWorkers, workerDismissible, workerExecutionIds } from "./worker-dismissal-client";
import { CheckingPresentation } from "./worker-dismissal-client-checking";
import { revealWorkerRequest } from "./worker-dismissal-client-request";
import { CompactWorkersView } from "./compact-workers-view";
import { expandedWorkBudget } from "./work-budget";
import { renderChatMarkdown } from "./markdown";
import { SilentRunFollower, TaskInspectionPanel, formatTaskElapsed, taskForChild, taskById, taskInspection, type OpenTaskInspection } from "./task-inspection";
import { composerRoutineState, formatUsd, latestPlanReport, latestRateLimit, planChip, planHasRows, planName, planReadoutRows, sessionTotalsTitle, standingSentence, usageAsOf, usageStale, type RateLimitStanding } from "./composer-status";
import { buildPlanRowNodes, currentUsageReport, initUsagePaneControls, noteUsageReport, onUsageChange, onUsageRead, readStatusText, readUsageNow, refreshUsageIfStale, revealUsagePane, usageReadState, usageReadable } from "./usage-pane";
import { isLiveConversationStatus } from "./types";
import type { BackgroundTaskItem } from "./types";
import { contextReadout } from "./context-readout";
import { HoldToQueue, HOLD_ARM_MS, HOLD_COUNTDOWN_MS, HOLD_TOTAL_MS } from "./hold-to-queue";
import { QueueDiscovery } from "./queue-discovery";
import { buildReceiptRows, buildReceiptTotal, parseReceiptView, receiptHeading, subagentTranscriptTitle, type ReceiptView } from "./receipt-view";
import { formatTokens, totalTokens } from "./usage";
import { resolveSessionTotals, type ConversationTotals } from "./conversation-totals";
import {
  applyChatEvent,
  prependSnapshot,
  projectionFromSnapshot,
  refreshFromSnapshot,
  type ChatProjection,
} from "./projection";
import type { AgentChatStatus, ChatAgent, ChatCapability, ChatMode, ChatAvailability, ChatCommand, ChatLoginState, ChatModel, ConversationConfiguration, ConversationItem, ConversationSnapshot, ConversationSummary, ContextReportItem, MessageDelivery, ModelSelection, PermissionOutcome, QuestionOutcome, SessionTotals } from "./types";
import { formatDiagnostics } from "./diagnostics";
import { collectQuestionAnswers, showQuestionPanel, syncQuestionControl, syncQuestionForm } from "./question-form";
import { configurationOptionLabel, createChatConfigurationPicker, type ChatConfigurationPickerController } from "./configuration-picker";
import { loginActionElement, loginActionFor, type LoginAction } from "./login-action";
import { copyChatText } from "./copy-actions";
import { announceConversationInventory, renderConversationInventoryAwareness, renderSelectedConversationDeleted } from "./inventory-presentation";
import { ConversationInventoryTracker, SerializedInventoryReconciler, conversationActivitySuffix, conversationDayGroup, dedupeConversationInventory, isConversationChooserActivationKey, patchConversationOptions, retainedPresentationConversationIds } from "./inventory-reconciler";
import { dateTime, nextLocalMidnight } from "./dates";
import { watchPinnedDayLabels } from "./pinned-day";

const PRESENTATION_KEY = "uatu:chat-presentation";
const TOO_LATE = "Too late — already delivered";
const SAVE_DEBOUNCE_MS = 400;
const MAX_EXPANDED_ENTRIES = 400;
const REFRESH_RETRY_INITIAL_MS = 100;
const REFRESH_RETRY_MAX_MS = 5_000;
type Presentation = {
  selectedId?: string;
  drafts: Record<string, string>;
  expanded: string[];
  anchors: Record<string, TimelineAnchor>;
  workingSince: Record<string, number>;
  // Dismissed finished-subagent entry ids, per conversation — dismissal is a
  // user statement that must survive reload.
  dismissedSubagents: Record<string, string[]>;
  // The agent the user last conversed with; the default for the next
  // creation (spec: last used, then the server default).
  lastAgentId?: string;
  // How the cost receipt is itemized. A reading preference, not a fact about
  // any one conversation, so it holds across conversations and reloads.
  receiptView?: ReceiptView;
};

// A status line that also reports what it is currently saying, so an owner of
// a specific message can check it is still the one on screen before removing it.
type Announcer = ((message: string, error?: boolean) => void) & {
  current: () => string;
  // The line itself, for an owner that keeps an element child on it.
  target: HTMLElement | null;
  // Told after every announcement, before the line's visibility is settled,
  // so an owner can attach or remove its child in the same pass.
  spoken: Set<() => void>;
};

const EMPTY_PRESENTATION: Presentation = { drafts: {}, expanded: [], anchors: {}, workingSince: {}, dismissedSubagents: {} };

export function initChat(api = new ChatApiClient()): void {
  let notificationTarget = notificationConversation(window.location?.search ?? "");
  // Opened from another workspace's "needs your answer" notice (?awaiting=1):
  // this workspace names the conversation that waits, asked at once so the
  // answer is usually in before the inventory. `undefined` is a failed read —
  // startup then proceeds as if no destination was named, since saying the
  // request was answered would be a guess.
  let awaitingLookup: Promise<string | null | undefined> | null = !notificationTarget && notificationAwaiting(window.location?.search ?? "")
    ? api.awaiting().catch(() => undefined) : null;
  let awaitingAnswered = false;
  const resolveAwaiting = async () => {
    if (!awaitingLookup) return;
    const found = await awaitingLookup;
    awaitingLookup = null;
    const id = typeof found === "string" ? notificationConversation(`conversation=${encodeURIComponent(found)}`) : null;
    if (id) notificationTarget = id;
    else awaitingAnswered = found === null;
    // The destination is settled: the URL now names what was chosen, as a
    // push notification's would, and a reload does not ask again.
    if (window.location) {
      const url = new URL(window.location.href);
      url.searchParams.delete("awaiting");
      if (id) url.searchParams.set("conversation", id);
      window.history.replaceState(window.history.state, "", url);
    }
  };
  const surface = document.querySelector<HTMLElement>("#chat-surface");
  const timeline = document.querySelector<HTMLElement>("#chat-timeline");
  const items = document.querySelector<HTMLElement>("#chat-items");
  const state = document.querySelector<HTMLElement>("#chat-state");
  const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select");
  const newButton = document.querySelector<HTMLButtonElement>("#chat-new-conversation");
  const renameButton = document.querySelector<HTMLButtonElement>("#chat-rename-conversation");
  const renameForm = document.querySelector<HTMLFormElement>("#chat-rename-form");
  const renameInput = document.querySelector<HTMLInputElement>("#chat-rename-title");
  const renameCancel = document.querySelector<HTMLButtonElement>("#chat-rename-cancel");
  const olderButton = document.querySelector<HTMLButtonElement>("#chat-load-older");
  const latestButton = document.querySelector<HTMLButtonElement>("#chat-latest");
  const revertedShell = document.querySelector<HTMLDetailsElement>("#chat-reverted");
  const revertedLabel = document.querySelector<HTMLElement>("#chat-reverted-label");
  const revertedItems = document.querySelector<HTMLElement>("#chat-reverted-items");
  const queueDockElement = document.querySelector<HTMLElement>("#chat-queue");
  const queueNoteElement = document.querySelector<HTMLElement>("#chat-queue-note");
  const form = document.querySelector<HTMLFormElement>("#chat-composer");
  const input = document.querySelector<HTMLTextAreaElement>("#chat-input");
  const commandMenu = document.querySelector<HTMLElement>("#chat-command-menu");
  const send = document.querySelector<HTMLButtonElement>("#chat-send");
  const sendGroup = document.querySelector<HTMLElement>("#chat-send-group");
  const stop = document.querySelector<HTMLButtonElement>("#chat-stop");
  const sendLabel = document.querySelector<HTMLElement>("#chat-send .chat-send-label");
  const configurationTrigger = document.querySelector<HTMLButtonElement>("#chat-configuration-trigger");
  const configurationSummary = document.querySelector<HTMLElement>("#chat-configuration-summary");
  const configurationDetails = document.querySelector<HTMLElement>("#chat-configuration-details");
  const configurationModeSummary = document.querySelector<HTMLElement>("#chat-configuration-mode-summary");
  const configurationVariantSummary = document.querySelector<HTMLElement>("#chat-configuration-variant-summary");
  const configurationVariantValue = document.querySelector<HTMLElement>("#chat-configuration-variant-value");
  const configurationDialog = document.querySelector<HTMLDialogElement>("#chat-configuration-dialog");
  const configurationSearch = document.querySelector<HTMLInputElement>("#chat-configuration-search");
  const configurationModelsSection = document.querySelector<HTMLElement>("#chat-configuration-models-section");
  const configurationModels = document.querySelector<HTMLElement>("#chat-configuration-models");
  const configurationResultStatus = document.querySelector<HTMLElement>("#chat-configuration-result-status");
  const configurationEmpty = document.querySelector<HTMLElement>("#chat-configuration-empty");
  const configurationDone = document.querySelector<HTMLButtonElement>("#chat-configuration-done");
  const configurationModeSection = document.querySelector<HTMLElement>("#chat-configuration-mode-section");
  const configurationMode = document.querySelector<HTMLSelectElement>("#chat-configuration-mode");
  const configurationVariantSection = document.querySelector<HTMLElement>("#chat-configuration-variant-section");
  const configurationVariant = document.querySelector<HTMLSelectElement>("#chat-configuration-variant");
  const composerStatus = document.querySelector<HTMLElement>("#chat-composer-status");
  const loginNotice = document.querySelector<HTMLElement>("#chat-login-notice");
  const rateLimitLive = document.querySelector<HTMLElement>("#chat-rate-limit-live");
  const planUsage = document.querySelector<HTMLDetailsElement>("#chat-plan-usage");
  const planUsageSummary = document.querySelector<HTMLElement>("#chat-plan-usage-summary");
  const planReadout = document.querySelector<HTMLElement>("#chat-plan-readout");
  const planReadoutHead = document.querySelector<HTMLElement>("#chat-plan-readout-head");
  const planReadoutName = document.querySelector<HTMLElement>("#chat-plan-readout-name");
  const planReadoutAge = document.querySelector<HTMLElement>("#chat-plan-readout-age");
  const planRead = document.querySelector<HTMLButtonElement>("#chat-plan-read");
  const planReadoutStatus = document.querySelector<HTMLElement>("#chat-plan-readout-status");
  const planReadoutRowsElement = document.querySelector<HTMLElement>("#chat-plan-readout-rows");
  const planReadoutStanding = document.querySelector<HTMLElement>("#chat-plan-readout-standing");
  const planPin = document.querySelector<HTMLButtonElement>("#chat-plan-pin");
  const planSession = document.querySelector<HTMLElement>("#chat-plan-readout-session");
  const planSessionTitle = document.querySelector<HTMLElement>("#chat-plan-session-title");
  const planSessionCost = document.querySelector<HTMLElement>("#chat-plan-session-cost");
  const planSessionModels = document.querySelector<HTMLElement>("#chat-plan-session-models");
  const planSessionViews = document.querySelector<HTMLElement>("#chat-plan-session-views");
  const planSessionHeading = document.querySelector<HTMLElement>("#chat-plan-session-heading");
  const planSessionTotal = document.querySelector<HTMLElement>("#chat-plan-session-total");
  const composerChips = document.querySelector<HTMLElement>("#chat-composer-chips");
  // The reason the latest status event carried (a retry's attempt and HTTP
  // status), shown with the named state — per conversation, so a switch
  // to another retrying conversation never borrows this one's reason.
  const statusMessages = new Map<string, string | undefined>();
  // Whether the caret sits in a slash query, matches or not: starting one
  // re-reads the catalogs, so a command added elsewhere — which the banked
  // list cannot match yet — appears while the user is still typing it. Any
  // programmatic write to the composer ends the query it was tracking, so
  // the next `/` typed counts as a new one.
  let slashQueryActive = false;
  // Rows the stream removed, per conversation, carried across snapshot
  // rebuilds (a resync, a switch away and back) so a late acceptance never
  // recreates a row the stream already retired.
  const removedRows = new Map<string, string[]>();
  const composerStatusLive = document.querySelector<HTMLElement>("#chat-composer-status-live");
  const composerError = document.querySelector<HTMLElement>("#chat-composer-error");
  // Attachment surfaces. Guarded at use rather than joining the required
  // check below, like the drill-down, so an older shell still runs Chat.
  const attachButton = document.querySelector<HTMLButtonElement>("#chat-attach");
  const attachInput = document.querySelector<HTMLInputElement>("#chat-attach-input");
  const attachmentsStrip = document.querySelector<HTMLElement>("#chat-attachments");
  const imageViewer = document.querySelector<HTMLDialogElement>("#chat-image-viewer");
  const imageViewerImage = document.querySelector<HTMLImageElement>("#chat-image-viewer-image");
  const imageViewerName = document.querySelector<HTMLElement>("#chat-image-viewer-name");
  const imageViewerClose = document.querySelector<HTMLButtonElement>("#chat-image-viewer-close");
  const copyStatus = document.querySelector<HTMLElement>("#chat-copy-status");
  const contextUsage = document.querySelector<HTMLDetailsElement>("#chat-context-usage");
  const contextUsageFill = document.querySelector<HTMLElement>("#chat-context-usage-meter .chat-context-meter-fill");
  const contextUsageLabel = document.querySelector<HTMLElement>("#chat-context-usage-label");
  const contextUsageBreakdown = document.querySelector<HTMLElement>("#chat-context-usage-breakdown");
  const chatTitle = document.querySelector<HTMLElement>("#chat-title");
  const chatContext = document.querySelector<HTMLElement>("#chat-context");
  const inputLabel = document.querySelector<HTMLElement>("#chat-input-label");
  // The subagent drill-down's own box: a transcript over the parent's, with
  // its own back affordance. Every use is guarded rather than joining the
  // required-element check below, so a shell without it still runs Chat.
  const drilldown = document.querySelector<HTMLElement>("#chat-drilldown");
  const drilldownItems = document.querySelector<HTMLElement>("#chat-drilldown-items");
  const drilldownTimeline = document.querySelector<HTMLElement>("#chat-drilldown-timeline");
  const drilldownTitle = document.querySelector<HTMLElement>("#chat-drilldown-title");
  const drilldownState = document.querySelector<HTMLElement>("#chat-drilldown-state");
  const drilldownBack = document.querySelector<HTMLButtonElement>("#chat-drilldown-back");
  const drilldownOlder = document.querySelector<HTMLButtonElement>("#chat-drilldown-older");
  // The running-task panel inside the drill-down: the header strip over a
  // subagent's transcript, and the output pane a shell task opens instead of
  // a transcript (design D7).
  const drilldownTask = document.querySelector<HTMLElement>("#chat-drilldown-task");
  const drilldownOutput = document.querySelector<HTMLElement>("#chat-drilldown-output");
  const drilldownOutputText = document.querySelector<HTMLElement>("#chat-drilldown-output-text");
  const drilldownOutputNote = document.querySelector<HTMLElement>("#chat-drilldown-output-note");
  if (!surface || !timeline || !items || !state || !select || !newButton || !olderButton || !latestButton || !queueDockElement || !form || !input || !commandMenu || !send || !sendLabel || !configurationTrigger || !configurationSummary || !configurationDetails || !configurationModeSummary || !configurationVariantSummary || !configurationVariantValue || !configurationDialog || !configurationSearch || !configurationModelsSection || !configurationModels || !configurationResultStatus || !configurationEmpty || !configurationDone || !composerStatus || !composerStatusLive || !composerError || !copyStatus) return;

  const anchor = new TimelineAnchorController();
  // Initial renders can run before focus wiring is installed. Later paints
  // reconcile removals too: WebKit does not send focusout for a removed input.
  let reconcileAnswerAfterPaint = () => {};
  const renderer = new TimelineRenderer();
  renderer.deferClosedActivity = true;
  const readSignal = createLoadingSignal({ segment: null, barHost: timeline, busyHost: timeline, visibleLabel: true });
  const readError = document.createElement("div");
  readError.className = "chat-read-error";
  readError.setAttribute("role", "alert");
  readError.hidden = true;
  surface.append(readError);
  const showReadError = (container: HTMLElement, error: unknown, retry: () => void) => {
    const message = document.createElement("span");
    message.textContent = messageOf(error);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Retry read";
    button.addEventListener("click", retry);
    container.replaceChildren(message, button);
    container.hidden = false;
  };
  let readLane: { controller: AbortController; token: number; label: string } | null = null;
  const runConversationRead = async <T>(label: string, retry: () => void, read: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    readLane?.controller.abort();
    const lane = { controller: new AbortController(), token: readSignal.start(label), label };
    readLane = lane;
    if (!chatSurfaceActive()) readSignal.cancel(lane.token);
    readError.hidden = true;
    readError.replaceChildren();
    try {
      const value = await read(lane.controller.signal);
      return value;
    } catch (error) {
      if (readLane === lane && !lane.controller.signal.aborted) {
        showReadError(readError, error, retry);
      }
      throw error;
    } finally {
      const settle = () => { if (readLane === lane) { readSignal.settle(lane.token); readLane = null; } };
      if (chatSurfaceActive()) requestAnimationFrame(() => requestAnimationFrame(settle));
      else settle();
    }
  };
  const queueDock = new QueueDockRenderer();
  const revertedDock = revertedShell && revertedLabel && revertedItems
    ? new RevertedMessagesDockRenderer(revertedShell, revertedLabel, revertedItems)
    : null;
  // Keep read/write ownership with this page even if a host replaces its
  // global window while an in-flight read still owes us a save after pagehide.
  const presentationStorage = presentationLocalStorage();
  let presentation = readPresentation(presentationStorage);
  let conversations: ConversationSummary[] = [];
  // Every offered agent with its availability, in server presentation order.
  let agentStatuses: AgentChatStatus[] = [];
  // Catalogs are per agent; the bare lists below are the selected-agent view,
  // swapped whenever the conversation's owning agent changes.
  type AgentCatalogs = { models: ChatModel[]; modes: ChatMode[]; commands: ChatCommand[]; commandInventoryAvailable: boolean; catalogRevision?: string };
  const agentCatalogs = new Map<string, AgentCatalogs>();
  const agentCatalogLoads = new Map<string, Promise<AgentCatalogs>>();
  // Latest requested revision, including invalidations received before the
  // initial catalog is banked. Each bank acknowledges only successful reads.
  const catalogRevisions = new Map<string, string>();
  let catalogLoading = false;
  let contextAgentId: string | undefined;
  let models: ChatModel[] = [];
  let modes: ChatMode[] = [];
  let commands: ChatCommand[] = [];
  // Whether a dock entry's text runs as a listed command — what the adapter's
  // parseSlashCommand decides — so the dock offers no steer for one.
  const isListedCommand = (text: string): boolean => parsePromptSlashCommand(text, commands) !== undefined;
  let projection: ChatProjection | null = null;
  const stagedConfigurations = new Map<string, ConversationConfiguration>();
  const configurationLabels = { summary: "Chat settings", inline: "", accessible: [] as string[] };
  let configurationPicker: ChatConfigurationPickerController | null = null;
  let stream: ChatEventStream | null = null;
  let inventoryStream: ChatEventStream | null = null;
  let selectionGeneration = 0;
  // A stored reference is not an opened selection. Keep it inert across
  // missing inventories, even if creation cancels startup before it finishes.
  let hasSelectedConversation = false;
  let failedOpeningConversationId: string | null = null;
  // A consumed startup restore is not deletion-recovery eligible until its
  // opening read succeeds. Keep this scoped to its current selection epoch.
  let unestablishedStartup: { conversationId: string; generation: number } | null = null;
  const isUnestablishedStartup = (id: string | null | undefined) =>
    unestablishedStartup?.generation === selectionGeneration && unestablishedStartup.conversationId === id;
  let startupOwnsSelection = true;
  let pendingStartupId: string | null = null;
  const supersedeStartupSelection = () => {
    startupOwnsSelection = false;
    pendingStartupId = null;
  };
  let selectedConversationDeleted = false;
  type ConversationRefreshRecovery = {
    conversationId: string;
    token: number;
    delayMs: number;
    timer: ReturnType<typeof setTimeout> | null;
    wake: (() => void) | null;
  };
  let conversationRefreshRecovery: ConversationRefreshRecovery | null = null;
  const inventoryTracker = new ConversationInventoryTracker();
  const syncInventoryAwareness = (announceIncrease = false) => {
    renderConversationInventoryAwareness(document, inventoryTracker.unseenCount);
    announceConversationInventory(document, announceIncrease ? inventoryTracker.unseenCount : 0);
  };
  syncInventoryAwareness();
  // Viewing child X of parent Y. A subagent transcript is a drill-down into a
  // turn, not a conversation: this state never reaches the picker, the
  // inventory, or the stored per-conversation presentation, so returning to
  // the parent is clearing it rather than re-selecting anything.
  type Drilldown = {
    conversationId: string;
    label: string;
    projection: ChatProjection | null;
    stream: ChatEventStream | null;
    read?: { controller: AbortController; token: number; label: string };
    // The background task this layer inspects, when it was opened for one:
    // the parent's item, found by id on every repaint so the strip follows
    // it in place. A transcript view is a live child over it; an output view
    // has no child at all and reads the task's output file instead.
    task?: OpenTaskInspection;
  };
  let child: Drilldown | null = null;
  let childInvoker: HTMLElement | null = null;
  let childInvokerSelector: string | null = null;
  // The error line the output view last put up. When a later read answers,
  // the panel says so and the line comes down — but only if it still says
  // what the panel put there, so a message something else has since spoken
  // is left standing.
  let taskOutputError = "";
  const taskPanel = drilldownTask && drilldownOutput && drilldownOutputText && drilldownOutputNote
    ? new TaskInspectionPanel({
      hosts: { strip: drilldownTask, output: drilldownOutput, outputText: drilldownOutputText, outputNote: drilldownOutputNote },
      fetchOutput: (conversationId, taskId, signal) => api.taskOutput(conversationId, taskId, undefined, signal),
      active: () => chatSurfaceActive(),
      onError: error => {
        taskOutputError = messageOf(error);
        announceChild(taskOutputError, true);
      },
      onRecovered: () => {
        if (taskOutputError && announceChild.current() === taskOutputError) announceChild("");
        taskOutputError = "";
      },
    })
    : null;
  // The drill-down's task, as the parent's projection now has it — the strip
  // and the output view are re-synced from here by the background-task
  // repaint, and by the stop control's own in-flight guard.
  const syncTaskInspection = () => {
    if (!taskPanel || !child?.task) return;
    const owner = projection?.conversationId === child.task.conversationId ? projection : null;
    taskPanel.sync(checkingPresentation.task(owner ? taskById(owner.items, child.task.taskId, child.task.itemId) : undefined), stoppingTasks.has(child.task.taskId));
  };
  let childGeneration = 0;
  // A run that streams nothing — the review a typed command launches — or
  // whose stream has stalled is followed from its transcript on disk while
  // its drill-down is open (design D14). The re-read folds into the open
  // projection the way live events do, and repaints as new content does:
  // it never goes through the open path, so the reader's place, the follow
  // state, the stream, and the task strip are all left as they are.
  const silentRun = new SilentRunFollower({
    refresh: async signal => {
      const open = child;
      const generation = childGeneration;
      if (!open?.projection) return undefined;
      const page = await api.snapshot(open.conversationId, undefined, signal);
      if (signal.aborted || generation !== childGeneration || child !== open || !open.projection) return undefined;
      const refreshed = refreshFromSnapshot(open.projection, page);
      if (!refreshed) return undefined;
      open.projection = refreshed.projection;
      if (refreshed.changed) { announceChild(""); renderChild(true); }
      // The follower applies the status the read found itself: a read that
      // finds the run settled is already a read made after the settle.
      return isLiveConversationStatus(open.projection.status);
    },
    active: () => chatSurfaceActive(),
  });
  const childRenderer = new TimelineRenderer();
  childRenderer.deferClosedActivity = true;
  const childAnchor = new TimelineAnchorController();
  const childReadSignal = drilldownTimeline ? createLoadingSignal({ segment: null, barHost: drilldownTimeline, busyHost: drilldownTimeline, visibleLabel: true }) : null;
  const childReadError = document.createElement("div");
  childReadError.className = "chat-read-error";
  childReadError.setAttribute("role", "alert");
  childReadError.hidden = true;
  drilldown?.append(childReadError);
  const runChildRead = async (owner: Drilldown, label: string, retry: () => void, load: (signal: AbortSignal) => Promise<void>) => {
    owner.read?.controller.abort();
    const read = { controller: new AbortController(), label, token: childReadSignal?.start(label) ?? 0 };
    owner.read = read;
    childReadError.hidden = true;
    childReadError.replaceChildren();
    if (!chatSurfaceActive()) childReadSignal?.cancel(read.token);
    try { await load(read.controller.signal); }
    catch (error) {
      if (child === owner && owner.read === read && !read.controller.signal.aborted) {
        showReadError(childReadError, error, retry);
      }
    } finally {
      const settle = () => {
        if (child === owner && owner.read === read) { childReadSignal?.settle(read.token); owner.read = undefined; }
      };
      if (chatSurfaceActive()) requestAnimationFrame(() => requestAnimationFrame(settle));
      else settle();
    }
  };
  let releaseChildBack: (() => void) | null = null;
  // The identity of the history entry THIS session pushed for the open
  // drill-down, or null when none is on the stack. A unique value rather
  // than a boolean because the boolean survives where the layer does not: a
  // reload keeps the flagged entry while the in-memory drill-down dies, and
  // an interceptor that trusts any flag then refuses to close a layer over a
  // stale marker. Minted with newRequestId, NOT a page-local counter: a
  // counter restarts on every load, so the first open after a reload would
  // re-mint exactly the value a stale entry already carries.
  let drilldownHistoryToken: string | null = null;
  let drilldownClosePending = false;
  // Entries for layers that closed while navigation sat above them. A history
  // entry cannot be deleted from the middle of the stack, so a direct close
  // (header, Escape) of a drill-down whose entry is buried leaves that entry
  // behind — retired here, and skipped in the direction the reader was moving
  // when navigation later lands on it, so the reader never meets a dead step.
  // Registered before the layer's own
  // interceptor ever is: interceptors run newest-first, so an open layer
  // still answers first.
  type RetiredDrilldown = { kind: "forward-only" } | { kind: "buried"; next: "back" | "forward" };
  const retiredDrilldownTokens = new Map<string, RetiredDrilldown>();
  registerBackInterceptor(event => {
    const flag = (event.state as { chatDrilldown?: unknown } | null)?.chatDrilldown;
    if (typeof flag !== "string") return false;
    const retired = retiredDrilldownTokens.get(flag);
    if (!retired) return false;
    if (retired.kind === "forward-only") history.back();
    else {
      const direction = retired.next;
      retired.next = direction === "back" ? "forward" : "back";
      history[direction]();
    }
    return true;
  });
  let rendering = false;
  let renderFrame: number | null = null;
  let renderDirty = false;
  let pendingNewContent = false;
  let childRenderFrame: number | null = null;
  let childRenderDirty = false;
  let childNewContent = false;
  let incrementalTimer: ReturnType<typeof setTimeout> | null = null;
  let lastTranscriptPaint = 0;
  let childIncrementalTimer: ReturnType<typeof setTimeout> | null = null;
  let lastChildPaint = 0;
  let cancelling = false;
  // Bumped on every main-projection snapshot install. queueRevision restarts
  // at zero with each fresh projection, so an in-flight held echo compares
  // this epoch too — a revision captured before a reload must never pass
  // against the replacement projection's coincidentally equal revision.
  let projectionEpoch = 0;
  type HistoryOperation = LocalHistoryOperation | "revert" | "restore";
  let commandInventoryAvailable = true;
  let commandMatch: ReturnType<typeof matchingCommands> = null;
  let commandIndex = 0;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let workingTimer: ReturnType<typeof setInterval> | null = null;
  // A transient composer note ("Sending…") outranks the status label until the
  // conversation status actually moves, so a render cannot erase it.
  let composerNote: string | null = null;
  let lastStatus: ChatProjection["status"] | null = null;
  let lastRoutineAnnouncement = "";
  const expanded = new Set(presentation.expanded);
  // The agent Chat is talking to, once it has said so. Every name and every
  // capability-gated control reads this rather than fixed copy, so installing
  // a different agent changes what is shown and not what is written here.
  let agent: ChatAgent | undefined;
  // Before the agent reports itself there is nothing truthful to name, so the
  // copy stays neutral rather than guessing.
  // The name to show for the current context: the agent's own declaration
  // once its runtime has spoken, its registry identity before that. Identity
  // is known from the status list even while availability is still idle —
  // a conversation created under a cold agent is not anonymous.
  const displayAgentName = (): string | undefined => agent?.name ?? agentStatusFor(contextAgentId)?.agent.name;
  const nameAgent = () => {
    const name = displayAgentName();
    // Both, not one or the other: the workspace label answers "where am I"
    // and the agent name answers "who am I talking to". A nullish chain would
    // have hidden the agent on every workspace that has a root — which is all
    // of them — leaving the composer as the only place it was named.
    if (chatContext) chatContext.textContent = [appState.roots[0]?.label, name].filter(Boolean).join(" · ") || "Chat";
    if (inputLabel) inputLabel.textContent = name ? `Message ${name}` : "Send a message";
    if (input) input.placeholder = name ? `Ask ${name}…` : "Send a message…";
  };
  const chatHeading = () => {
    const name = displayAgentName();
    return name ? `${name} Chat` : "Chat";
  };
  // An agent that declared itself is believed exactly: a capability it did not
  // list is one it does not have. When no agent has been reported at all — an
  // older workspace, or the moment before the adapter exists — nothing is
  // known, so nothing is withheld.
  const declares = (capability: ChatCapability) => agent?.capabilities.includes(capability) ?? true;
  const agentStatusFor = (agentId: string | undefined): AgentChatStatus | undefined =>
    agentStatuses.find(status => status.agent.id === agentId);
  // How the selected agent gets a login: the Hub's Settings, or its command.
  const contextLoginAction = (): LoginAction | undefined => {
    const status = agentStatusFor(contextAgentId);
    return status ? loginActionFor(status.agent.id, status.agent.name) : undefined;
  };
  const contextLoginState = (): ChatLoginState | undefined => {
    const availability = agentStatusFor(contextAgentId)?.availability;
    return availability?.state === "ready" ? availability.login : undefined;
  };
  // Each agent's `accountsRevision` as last seen. It moves when a login
  // changes through the Hub's Agent accounts: the agent's catalogs are then
  // re-read, and an empty model list is believed (the last provider logged
  // out) rather than skipped as a list that has not loaded yet.
  const accountsRevisions = new Map<string, number>();
  const setAgentStatuses = (next: AgentChatStatus[]) => {
    agentStatuses = next;
    for (const status of next) {
      if (status.availability.state !== "ready") continue;
      const revision = status.availability.accountsRevision ?? 0;
      const known = accountsRevisions.get(status.agent.id);
      accountsRevisions.set(status.agent.id, revision);
      if (known === undefined || known === revision) continue;
      if (contextAgentId === status.agent.id && agentCatalogs.has(status.agent.id)) void refreshBankedCommands(status.agent.id, { acceptEmpty: true });
      else agentCatalogs.delete(status.agent.id);
    }
    renderLoginNotice();
  };
  // Status re-reads that land together collapse into one, plus one more if
  // another was asked for while it ran.
  let statusReread: Promise<void> | null = null;
  let statusRereadQueued = false;
  const rereadStatuses = () => {
    if (statusReread) {
      statusRereadQueued = true;
      return;
    }
    statusReread = (async () => {
      try {
        setAgentStatuses(await api.status());
      } catch {
        // The next tick asks again. A login poll whose read failed has nothing
        // else to wake it, so it is scheduled again from the last known state.
        scheduleLoginPoll(contextLoginState());
      }
    })().finally(() => {
      statusReread = null;
      if (statusRereadQueued) {
        statusRereadQueued = false;
        rereadStatuses();
      }
    });
  };
  // While the selected agent has no usable login, or has not said yet,
  // status is re-read now and then: a login made outside UatuCode (a
  // terminal) sends no tick, and a first login read lands after the agent
  // is ready. Nothing is polled once the login is known to work.
  const LOGIN_POLL_MS = 5_000;
  let loginPoll: ReturnType<typeof setTimeout> | null = null;
  const scheduleLoginPoll = (state: ChatLoginState | undefined) => {
    if (state !== "missing" && state !== "unknown") {
      if (loginPoll !== null) { clearTimeout(loginPoll); loginPoll = null; }
      return;
    }
    if (loginPoll !== null) return;
    loginPoll = setTimeout(() => {
      loginPoll = null;
      if (document.visibilityState === "hidden") {
        scheduleLoginPoll(contextLoginState());
        return;
      }
      rereadStatuses();
    }, LOGIN_POLL_MS);
  };
  // The selected agent cannot run a turn: said where a message is typed,
  // with the way to log in. Present for a new conversation and an existing
  // one alike, since both are typed into here.
  const renderLoginNotice = () => {
    const state = contextLoginState();
    scheduleLoginPoll(state);
    if (!loginNotice) return;
    const status = agentStatusFor(contextAgentId);
    const missing = state === "missing" && status !== undefined;
    loginNotice.hidden = !missing;
    if (!missing) {
      loginNotice.replaceChildren();
      return;
    }
    const text = document.createElement("span");
    text.className = "chat-login-notice-text";
    text.textContent = `${status.agent.name} is not logged in.`;
    loginNotice.replaceChildren(text, " ", loginActionElement(document, loginActionFor(status.agent.id, status.agent.name)));
  };
  // A conversation names its agent on its summary; a child conversation the
  // inventory never lists still carries the owner as its id prefix.
  const conversationAgentId = (conversationId: string | null | undefined): string | undefined => {
    if (!conversationId) return undefined;
    const listed = conversations.find(conversation => conversation.id === conversationId)?.agent?.id;
    if (listed) return listed;
    const boundary = conversationId.indexOf(":");
    const prefix = boundary > 0 ? conversationId.slice(0, boundary) : undefined;
    return agentStatusFor(prefix)?.agent.id;
  };
  /**
   * A control the agent has no capability for is taken out of the surface, not
   * left disabled. A disabled control still claims the feature exists and is
   * merely unavailable right now, which is a different and untrue statement.
   * Only applied once the agent has declared itself — before that, nothing is
   * known and nothing is removed.
   *
   * Only the proactive pickers the user opens are removed here. The reactive
   * controls — answering a question, approving a permission, opening a
   * subagent — appear only when the agent raises one, so an agent that does
   * not declare `questions`/`permissions`/`subagents` produces no such item
   * and the control has nothing to render for. Belt-and-suspenders gating of
   * those surfaces (against a stale record from a differently-capable agent)
   * lands with the waves that own their renderers, so the outstanding-request
   * count and the subagent track stay gated in lockstep with them rather than
   * half-gated here.
   */
  // An absent capability presents no control — absent from the DOM, as the
  // capability rule and its tests mean it — but capabilities change with the
  // selected conversation's agent now, so removal must be reversible: a
  // stable anchor remembers the spot and the control returns through it.
  const capabilityControl = (element: HTMLElement | null, unhide = true) => {
    if (!element || !element.parentNode) return (_present: boolean) => {};
    const anchor = element.ownerDocument.createComment("capability-slot");
    element.parentNode.insertBefore(anchor, element);
    return (present: boolean) => {
      if (present) {
        if (!element.isConnected) anchor.parentNode?.insertBefore(element, anchor.nextSibling);
        // Markup may ship the control hidden until an agent declares it;
        // a control whose own renderer governs hidden opts out.
        if (unhide) element.hidden = false;
      } else if (element.isConnected) element.remove();
    };
  };
  const presentRename = capabilityControl(renameButton);
  const presentAttach = capabilityControl(attachButton);
  const presentContext = capabilityControl(contextUsage, false);

  const applyCapabilities = () => {
    if (!agent) return;
    configurationTrigger.hidden = !declares("models") && !declares("modes") && !declares("variants");
    // An agent that does not report usage leaves no readout behind — the
    // meter comes out of the DOM and returns with a declaring agent; its
    // own renderer governs hidden/open while present.
    if (contextUsage && !declares("context")) contextUsage.open = false;
    presentContext(declares("context"));
    presentRename(declares("conversation-rename"));
    // The model-level attachment gate is different — see syncAttachControl:
    // a model choice flips often, so there the control stays visible and
    // goes inactive instead. The capability gate governs presence.
    presentAttach(declares("attachments"));
  };
  nameAgent();

  // One status-line contract for every surface that has one; the parent's
  // state element and the drill-down's differ only in which element speaks.
  const announcerFor = (target: HTMLElement | null): Announcer => {
    // The message lives in its own leading text node: an announcement must
    // not level appended children (the takeover renders one diagnosis panel
    // per failed agent into this element, and each panel's announce would
    // otherwise destroy the previous panels). The announcement still owns
    // every text node — text set through other paths is replaced, exactly
    // as the textContent variant did — but element children survive; they
    // are removed explicitly where that is meant.
    let node: Text | null = null;
    const spoken = new Set<() => void>();
    const speak = (message: string, error = false) => {
      if (!target) return;
      if (!node || node.parentNode !== target) {
        node = target.ownerDocument.createTextNode("");
        target.prepend(node);
      }
      for (const child of [...target.childNodes]) {
        if (child !== node && child.nodeType === 3) child.remove();
      }
      node.textContent = message;
      target.classList.toggle("is-error", error);
      for (const listener of [...spoken]) listener();
      target.hidden = !message && target.childElementCount === 0;
    };
    // What the line is saying right now. A caller that owns a specific
    // message needs this to check it is still the one being shown before
    // taking it down.
    return Object.assign(speak, { current: () => node?.textContent ?? "", target, spoken });
  };
  const announce = announcerFor(state);
  const announceChild = announcerFor(drilldownState);

  // Step narration owns a live region of its own, beside each status line.
  // The status line is shared with connection-interruption messaging, whose
  // recovery affordance keys on the line's current text: a transient
  // "Question 2 of 4" landed in it would strip the in-place Reconnect button
  // while a stream is still down (and its clear() would not re-expose the
  // owned message). Question steps are ambient, not actionable — they speak
  // politely without displacing anything.
  const stepAnnouncerFor = (target: HTMLElement | null): Announcer => {
    const region = document.createElement("div");
    region.className = "sr-only";
    region.setAttribute("aria-live", "polite");
    target?.parentNode?.insertBefore(region, target.nextSibling);
    return announcerFor(region);
  };
  const announceQuestionStep = stepAnnouncerFor(state);
  const announceQuestionStepChild = stepAnnouncerFor(drilldownState);

  // Connection-interruption messaging has a dedicated owner, PER STREAM. The
  // status line is shared with provider outages, validation refusals, and turn
  // failures — all of which the user still has to act on — so a reconnect may
  // not clear the line wholesale. And the conversation and inventory streams
  // fail and recover independently: one of them coming back must not retract
  // the other's warning while it is still down.
  const interruptionsFor = (speak: Announcer) => {
    const owned = new Map<string, string>();
    // The way back while an interruption is what the line reports. The
    // channel keeps retrying on its own, but a stall can outlive that cycle
    // (a wake-up signal lost, a page whose recovery machinery is gone), and
    // on a home-screen page there is no browser reload to fall back on. The
    // shell's manual recovery reconnects in place and reloads only if that
    // does not confirm; either way this surface's draft and position stand.
    const reconnect = document.createElement("button");
    reconnect.type = "button";
    reconnect.className = "chat-secondary-button chat-reconnect-button";
    reconnect.textContent = "Reconnect";
    reconnect.addEventListener("click", () => { void requestManualRecovery(); });
    onManualRecovery(inFlight => {
      reconnect.disabled = inFlight;
      reconnect.textContent = inFlight ? "Reconnecting…" : "Reconnect";
      if (inFlight) reconnect.setAttribute("aria-busy", "true");
      else reconnect.removeAttribute("aria-busy");
    });
    // Present exactly while the line is showing one of this owner's
    // interruption messages — not while another message (a provider
    // refusal, a failed turn) has displaced it, even if a stream is still
    // down underneath.
    const sync = () => {
      const showing = speak.target !== null && [...owned.values()].includes(speak.current());
      if (showing) {
        if (reconnect.parentNode !== speak.target) speak.target!.append(reconnect);
      } else if (reconnect.parentNode) {
        reconnect.remove();
      }
    };
    // A transient message replaced this owner's interruption text: the
    // stream is still down underneath, so the in-place recovery affordance
    // stands beside the transient line until owned text returns.
    const keepRecoveryVisible = (): void => {
      if (owned.size > 0 && speak.target) speak.target.append(reconnect);
    };
    speak.spoken.add(sync);
    return {
      report(stream: string, error: unknown) {
        const message = messageOf(error);
        if (error instanceof ChatConnectionInterruptedError) owned.set(stream, message);
        speak(message, true);
      },
      // Whether the line is currently showing one of this owner's messages.
      isShowingOwned(): boolean {
        return speak.target !== null && owned.size > 0 && [...owned.values()].includes(speak.current());
      },
      // Whether a stream of this surface is still down, even while another
      // message (a validation refusal on an ordinary click) occupies the
      // line in its place.
      hasDown(): boolean {
        return owned.size > 0;
      },
      keepRecoveryVisible,
      // Speak the newest owned interruption again — a finished message left
      // the line without retelling it while the stream is still down.
      restoreOwned(): void {
        const remaining = [...owned.values()].at(-1);
        if (remaining !== undefined) speak(remaining, true);
      },
      // This stream's transport is healthy again. Its message goes; if the
      // other stream is still interrupted, the line states that instead of
      // falling silent.
      clear(stream: string) {
        const message = owned.get(stream);
        if (message === undefined) return;
        owned.delete(stream);
        if (speak.current() !== message) {
          // A transient message (a validation refusal on an ordinary click)
          // displaced this owner's text. While another stream of this
          // surface is still down, preserve the affordance's current
          // attached or detached state — re-attaching here would hang
          // recovery on an unrelated status the user must act on first.
          // When no interruptions remain at all, it goes.
          if (owned.size === 0) sync();
          return;
        }
        const remaining = [...owned.values()].at(-1);
        speak(remaining ?? "", remaining !== undefined);
      },
    };
  };
  const interruptions = interruptionsFor(announce);
  const childInterruptions = interruptionsFor(announceChild);
  // The interruption owner for the surface a message belongs to, so a
  // transient writer can preserve that surface's recovery affordances.
  const interruptionsOwnerFor = (source: ChatProjection) =>
    child && source.conversationId === child.conversationId ? childInterruptions : interruptions;

  // Which question request currently owns each surface's owed-answer line —
  // the parent's line and the drill-down's are one resource each, shared by
  // every conversation and card that surface shows, so the timeline wirings
  // (one per surface, separate closures) must read and write this one map.
  // The key is the exact question request — its conversation plus its
  // requestId — not merely the conversation: one conversation can ask again
  // (or carry a newer mirrored card) while an earlier question's resolve
  // still sits in flight, and a resolution landing then must never retire
  // the newer question's line. The record also carries the surface's own
  // interruption owner, captured when the line was raised: a resolution
  // landing on one surface retires the line on every surface whose record
  // matches, and each retired line restores its own surface's affordances.
  const owedAnswerOwners = new Map<Announcer, { key: string; owner: ReturnType<typeof interruptionsFor> }>();
  const questionOwnershipKey = (source: ChatProjection, item: Extract<ConversationItem, { type: "question" }>) =>
    `${item.conversationId ?? source.conversationId}\u0000${item.requestId}`;

  const geometryOf = (scroller: HTMLElement, container: HTMLElement): AnchorGeometry => {
    const bounds = scroller.getBoundingClientRect();
    return {
      scrollTop: scroller.scrollTop,
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
      items: Array.from(container.querySelectorAll<HTMLElement>("[data-chat-item-id]")).map(element => {
        const finish = measureChatWork("item-geometry");
        const rect = element.getBoundingClientRect();
        finish();
        return { id: element.dataset.chatItemId!, top: rect.top - bounds.top, bottom: rect.bottom - bounds.top };
      // Members of a collapsed activity group are not rendered and report
      // zero-size rects; anchoring to one would pin the viewport to nothing.
      }).filter(entry => entry.bottom > entry.top),
    };
  };

  const geometry = (): AnchorGeometry => geometryOf(timeline, items);
  // Every caller sits behind a guard on the drill-down elements existing
  // (renderChild and the wiring at the bottom), so the assertions cannot
  // fire — and a fallback to the parent's scroller would anchor the child
  // against the wrong geometry if they somehow did.
  const childGeometry = (): AnchorGeometry => geometryOf(drilldownTimeline!, drilldownItems!);
  // The pinned fast path. Pinned means "keep the end in view", which needs
  // the scroll extents and nothing per item — and the per-item pass is a
  // forced layout of the whole transcript (a rect per item). During a
  // streaming turn, pinned is the resting state and this runs per rendered
  // frame AND per scroll tick (each programmatic scrollTop echoes a scroll
  // event), so paying the full pass there saturates a phone's main thread —
  // taps land while the handler is still measuring, and the tap is what a
  // reader experiences as dead.
  const extentsOf = (scroller: HTMLElement): AnchorGeometry =>
    ({ scrollTop: scroller.scrollTop, clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight, items: [] });
  const parentScroll = new CoordinatedScrollOwner(timeline, {
    anchor, measure: includeItems => includeItems ? geometry() : extentsOf(timeline), active: chatSurfaceActive,
    onChange: () => {
      if (projection) {
        const current = anchor.currentAnchor();
        if (current) presentation.anchors[projection.conversationId] = current;
        else delete presentation.anchors[projection.conversationId];
        save();
      }
      latestButton.hidden = !anchor.hasUnseen();
      syncPromptRailActive();
    },
  });
  const childLatest = drilldownTimeline ? document.createElement("button") : null;
  if (childLatest && drilldownTimeline) {
    childLatest.id = "chat-drilldown-latest";
    childLatest.type = "button";
    childLatest.className = latestButton.className;
    childLatest.textContent = "Latest in subagent";
    childLatest.hidden = true;
    drilldownTimeline.after(childLatest);
  }
  const childScroll = drilldownTimeline ? new CoordinatedScrollOwner(drilldownTimeline, {
    anchor: childAnchor, measure: includeItems => includeItems ? childGeometry() : extentsOf(drilldownTimeline),
    active: () => chatSurfaceActive() && !!child,
    onChange: () => { if (childLatest) childLatest.hidden = !childAnchor.hasUnseen(); },
  }) : null;
  childLatest?.addEventListener("click", () => childScroll?.latest());
  /**
   * Where an answering reveal has to leave the field. The extent is the row
   * carrying Answer and Reject, so the two are placed as one block: the field
   * alone could be brought into the band with its own buttons still under the
   * keyboard. `end` because the band's bottom is the only position that is
   * stable whether or not the platform's focus scroll already moved the card —
   * a minimal move leaves whatever height WebKit happened to give it as a
   * strip of empty conversation between the buttons and the keyboard's edge.
   * Touch only: nothing covers the chrome on desktop, so there is no band to
   * be pressed against and the minimal move is the one that disturbs the
   * reader least. The extent travels either way — which row has to land with
   * the field is not a property of the device.
   * Only question forms currently pair a text field with an action row. A
   * future permission text editor must supply its own extent here; do not
   * accidentally borrow an action row from another request or enclosing UI.
   */
  const answerPlacement = (element: HTMLElement): RevealOptions => ({
    extent: element.closest("form[data-question-form]")?.querySelector<HTMLElement>(".chat-request-actions") ?? undefined,
    align: document.documentElement.getAttribute("data-ui-mode") === "touch" ? "end" : "nearest",
  });
  /**
   * A control is revealed by the owner of the timeline it sits in — the same
   * card can be shown in the parent transcript or in a subagent drill-down,
   * and each timeline scrolls itself.
   */
  const revealInOwningTimeline = (element: HTMLElement): void => {
    const placement = answerPlacement(element);
    if (drilldownTimeline?.contains(element)) childScroll?.reveal(element, placement);
    else if (timeline.contains(element)) parentScroll.reveal(element, placement);
  };
  /**
   * The same choice of owner, for the standing version: while the field is
   * focused its timeline is held at the revealed position, so the platform's
   * own autoscroll as the caret is dragged cannot run the conversation away.
   */
  const holdInOwningTimeline = (element: HTMLElement): void => {
    const placement = answerPlacement(element);
    if (drilldownTimeline?.contains(element)) childScroll?.hold(element, placement);
    else if (timeline.contains(element)) parentScroll.hold(element, placement);
  };
  /** Both owners on release: by the time focus has left, the field that was
   *  held may no longer be in the timeline that held it. Releasing an owner
   *  that holds nothing does nothing; the holder resumes its prior follow
   *  intent through the next coordinated frame. */
  const releaseHeldTimelines = (): void => { parentScroll.release(); childScroll?.release(); };
  /** The focused control, while it is a text control this surface owns. */
  const focusedChatTextControl = (): HTMLElement | null => {
    const active = document.activeElement;
    return active instanceof HTMLElement && surface.contains(active) && isTextEditingControl(active) ? active : null;
  };
  renderer.shellMutationHooks = {
    beforeMutation: () => parentScroll.beforeMutation(),
    afterMutation: () => parentScroll.request(),
    inspected: () => save(),
  };
  childRenderer.shellMutationHooks = {
    beforeMutation: () => childScroll?.beforeMutation(),
    afterMutation: () => childScroll?.request(),
    inspected: () => save(),
  };
  const viewport = new ChatViewportController(surface, form, () => {
    parentScroll.request();
    childScroll?.request();
    // While a request is being answered, the geometry that changed is the
    // keyboard's: the correction that matters is keeping the field the user
    // is typing into inside what is left of the viewport. It rides the frame
    // the corrections above already asked for, and has the last word in it.
    if (!document.documentElement.hasAttribute("data-chat-answering")) return;
    const focused = focusedChatTextControl();
    if (focused) revealInOwningTimeline(focused);
  });

  const flushSave = () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    // The inventory is the whole truth about what may keep stored state: a
    // subagent's transcript is a drill-down, never a picker option and never
    // a conversation, so it has no draft here to protect.
    const known = retainedPresentationConversationIds(
      conversations,
      projection?.conversationId ?? null,
      selectedConversationDeleted ? presentation.selectedId ?? null : null,
    );
    if ((!hasSelectedConversation || isUnestablishedStartup(presentation.selectedId)) && presentation.selectedId) {
      known.add(presentation.selectedId);
    }
    // Prune only once the inventory has actually loaded — an empty list at
    // boot must not wipe every stored draft.
    if (conversations.length > 0) {
      for (const key of Object.keys(presentation.drafts)) if (!known.has(key)) delete presentation.drafts[key];
      for (const key of Object.keys(presentation.anchors)) if (!known.has(key)) delete presentation.anchors[key];
      for (const key of Object.keys(presentation.workingSince)) if (!known.has(key)) delete presentation.workingSince[key];
      for (const key of Object.keys(presentation.dismissedSubagents)) if (!known.has(key)) delete presentation.dismissedSubagents[key];
    }
    while (expanded.size > MAX_EXPANDED_ENTRIES) {
      const oldest = expanded.values().next().value;
      if (oldest === undefined) break;
      expanded.delete(oldest);
    }
    presentation.expanded = [...expanded];
    try { presentationStorage?.setItem(PRESENTATION_KEY, JSON.stringify(presentation)); } catch { /* best effort */ }
  };

  const save = () => {
    if (saveTimer !== null) return;
    saveTimer = setTimeout(() => { saveTimer = null; flushSave(); }, SAVE_DEBOUNCE_MS);
  };

  const taskList = document.querySelector<HTMLDetailsElement>("#chat-task-list");
  const taskListLabel = document.querySelector<HTMLElement>("#chat-task-list-label");
  const taskListItems = document.querySelector<HTMLElement>("#chat-task-list-items");

  /**
   * The live task list pinned above the composer: progress and the task in
   * hand, expanding to the whole list. The timeline badges narrate what
   * changed; this answers "where are we now" without scrolling back for it.
   * Contents are patched rather than rebuilt so expanding it survives renders.
   *
   * Rebuilt only when the tasks actually changed. This runs on every rendered
   * frame of a streaming turn, and rebuilding the rows each frame does more
   * than waste work: on iOS, a tap whose target node is replaced before the
   * finger lifts never becomes a click, so a track that rebuilds per frame is
   * a track that cannot be tapped while the agent is working.
   */
  let paintedTasks = "";
  const syncTaskList = () => {
    if (!taskList || !taskListLabel || !taskListItems) return;
    const tasks = projection ? latestTodoEntries(projection.items) : [];
    const signature = tasks.map(task => `${task.state}\u0001${task.text}`).join("\u0002");
    if (signature === paintedTasks) return;
    paintedTasks = signature;
    if (tasks.length === 0) {
      taskList.hidden = true;
      taskListItems.replaceChildren();
      return;
    }
    const done = tasks.filter(task => task.state === "done").length;
    const current = tasks.find(task => task.state === "active") ?? tasks.find(task => task.state !== "done");
    const progress = `${done}/${tasks.length} tasks`;
    taskListLabel.textContent = current ? `${progress} · ${current.text}` : progress;
    taskListItems.replaceChildren(...tasks.map(task => {
      const row = document.createElement("li");
      row.className = `is-${task.state}`;
      row.textContent = task.text;
      return row;
    }));
    taskList.hidden = false;
  };

  const compactWorkersList = document.querySelector<HTMLDetailsElement>("#chat-compact-workers");
  const compactWorkersLabel = document.querySelector<HTMLElement>("#chat-compact-workers-label");
  const compactWorkersItems = document.querySelector<HTMLElement>("#chat-compact-workers-items");
  const hubDismissals = isHubPage();
  const checkingPresentation = new CheckingPresentation(() => { syncCompactWork(); syncTaskInspection(); });
  const dismissalNotice = document.createElement("p");
  dismissalNotice.className = "chat-worker-dismissal-notice";
  dismissalNotice.setAttribute("role", "status");
  dismissalNotice.hidden = true;
  compactWorkersList?.after(dismissalNotice);
  const personalDismissals = hubDismissals ? new WorkerDismissalClient({ channel: liveChannel(), changed: () => syncCompactWork() }) : null;
  registerLiveTeardown(() => { personalDismissals?.dispose(); checkingPresentation.dispose(); });
  const compactWorkerState = new CompactDisclosure();
  const compactPendingState = new CompactDisclosure();
  const pendingScrollPositions = new Map<string, number>();
  let pendingPaintedConversation: string | null = null;
  let pendingPaintedOpen = false;
  let pendingScrollRestore: { conversation: string; top: number } | null = null;
  compactWorkersList?.addEventListener("toggle", () => {
    compactWorkerState.toggled(compactWorkersList.open);
    compactWorkersList.querySelector("summary")?.setAttribute("aria-expanded", String(compactWorkersList.open));
    syncQueueOverflow();
    syncDesktopWorkLayout();
  });
  let dismissalBatchFeedback: { conversationId: string; skipped: number; priorError: string } | null = null;
  const dismissWorkers = async (workers: readonly CompactWorker[]) => {
    if (!projection) return;
    const conversationId = projection.conversationId;
    if (personalDismissals) {
      const eligible = workers.filter(worker => workerDismissible(checkingPresentation.worker(worker)));
      dismissalBatchFeedback = { conversationId, skipped: eligible.filter(worker => !workerExecutionIds(worker).length).length, priorError: personalDismissals.error };
      syncCompactWork();
      // Serialize this explicit batch, retaining independent per-entry revisions.
      for (const worker of eligible) {
        if (projection?.conversationId !== conversationId) break;
        if (!workerDismissible(checkingPresentation.worker(worker))) continue;
        const ids = workerExecutionIds(worker);
        if (!ids.length) continue;
        await personalDismissals.dismiss(ids[0], ids);
        if (personalDismissals.error) break;
      }
      return;
    }
    const dismissed = new Set(presentation.dismissedSubagents[projection.conversationId] ?? []);
    for (const worker of workers) {
      if (workerDismissible(checkingPresentation.worker(worker))) dismissed.add(worker.activity?.executionId ?? worker.id);
    }
    presentation.dismissedSubagents[projection.conversationId] = [...dismissed];
    save(); syncCompactWork();
  };
  const compactView = compactWorkersItems ? new CompactWorkersView(compactWorkersItems, () => {
    void dismissWorkers(compactWorkers(projection?.items ?? []).filter(worker => worker.state !== "working" && worker.state !== "unknown"));
  }) : null;
  const syncCompactWork = () => {
    if (!compactWorkersList || !compactWorkersItems || !compactWorkersLabel) return;
    const allWorkers = checkingPresentation.paint(projection?.conversationId ?? null, compactWorkers(projection?.items ?? []))
      .filter(worker => worker.kind === "agent" && declares("subagents") || Boolean(worker.taskId) && declares("background-tasks"))
      .map(worker => declares("context") ? worker : { ...worker, tokens: undefined });
    personalDismissals?.select(projection?.conversationId ?? null);
    personalDismissals?.observe(allWorkers);
    const dismissed = new Set(projection ? presentation.dismissedSubagents[projection.conversationId] ?? [] : []);
    if (!personalDismissals && projection) {
      const oldSize = dismissed.size;
      for (const worker of allWorkers) if (worker.activity?.kind === "working" || worker.activity?.kind === "needs-answer") {
        for (const id of workerExecutionIds(worker)) dismissed.delete(id);
        dismissed.delete(worker.id);
        for (const reference of worker.references) dismissed.delete(reference);
      }
      if (dismissed.size !== oldSize) { presentation.dismissedSubagents[projection.conversationId] = [...dismissed]; save(); }
    }
    // Legacy browser aliases are never authority in a Hub account. Local mode
    // keeps its old terminal marks, but new marks prefer exact execution ids.
    const workers = personalDismissals ? visibleWorkers(allWorkers, personalDismissals.dismissed) : allWorkers.filter(worker =>
      !workerDismissible(worker) || !(worker.activity?.executionId ? workerExecutionIds(worker).some(id => dismissed.has(id)) : dismissed.has(worker.id) || worker.references.some(id => dismissed.has(id))));
    if (dismissalBatchFeedback?.conversationId !== projection?.conversationId) dismissalBatchFeedback = null;
    const skipped = dismissalBatchFeedback?.skipped ?? 0;
    dismissalNotice.textContent = personalDismissals ? [...new Set([
      personalDismissals.error, dismissalBatchFeedback?.priorError,
      skipped ? `Skipped ${skipped} worker${skipped === 1 ? "" : "s"} with an unverified execution identity; ${skipped === 1 ? "it remains" : "they remain"} visible.` : "",
    ].filter(Boolean))].join(" ") : (workers.length ? "Worker dismissals apply only on this device." : "");
    dismissalNotice.hidden = !dismissalNotice.textContent;
    const summary = workerSummary(workers);
    compactWorkersLabel.textContent = summary;
    compactWorkersList.querySelector("summary")?.setAttribute("aria-label", `Workers: ${summary}`);
    compactWorkersList.hidden = workers.length === 0;
    const open = compactWorkerState.paint(projection?.conversationId ?? null,
      workers.filter(worker => worker.state === "working" || worker.state === "unknown").length,
      document.documentElement.dataset.uiMode === "touch" ? "touch" : "desktop", compactWorkersList.open);
    if (compactWorkersList.open !== open) compactWorkersList.open = open;
    compactWorkersList.querySelector("summary")?.setAttribute("aria-expanded", String(compactWorkersList.open));
    compactView?.paint(projection?.conversationId ?? null, workers, stoppingTasks, declares("background-tasks"));
    syncQueueOverflow();
  };
  compactWorkersItems?.addEventListener("mousedown", event => keepTouchComposerFocus(event));
  compactWorkersList?.querySelector("summary")?.addEventListener("mousedown", event => keepTouchComposerFocus(event));
  surface.addEventListener("keydown", event => {
    const root = document.documentElement;
    if (event.key !== "Escape" || event.defaultPrevented || !compactWorkersList?.open || child || surface.querySelector('dialog[open]:not([data-presentation="window"])')
      || root.dataset.uiMode !== "touch" || !root.matches("[data-chat-keyboard], [data-chat-short], [data-chat-wide-short]")) return;
    event.preventDefault();
    event.stopPropagation();
    const owned = compactWorkersList.contains(document.activeElement);
    compactWorkersList.open = false;
    compactWorkerState.toggled(false);
    if (owned) compactWorkersList.querySelector<HTMLElement>(":scope > summary")?.focus({ preventScroll: true });
  });
  compactWorkersItems?.addEventListener("click", event => {
    const dismiss = (event.target as Element).closest<HTMLElement>("[data-dismiss-worker]");
    if (dismiss) {
      const worker = compactWorkers(projection?.items ?? []).find(worker => worker.id === dismiss.dataset.dismissWorker);
      if (worker) void dismissWorkers([worker]);
      return;
    }
    const stop = (event.target as Element).closest<HTMLButtonElement>("[data-stop-task]");
    if (stop) { if (!stop.disabled) void requestStopTask(stop.dataset.stopTask!, stop, stop.dataset.stopItem); return; }
    const id = (event.target as Element).closest<HTMLElement>("[data-worker-item]")?.dataset.workerItem;
    if (!id) return;
    const worker = compactWorkers(projection?.items ?? []).find(worker => worker.id === id);
    if (!worker) return;
    if (worker.activity?.kind === "needs-answer" && worker.activity.request) {
      revealWorkerRequest(worker.activity, projection?.items ?? [], id => jumpToPrompt(id, false));
      return; // Never create a second reply flow or guess a child association.
    }
    const task = worker.taskId ? taskById(projection?.items ?? [], worker.taskId, worker.id) : undefined;
    const target = task ? taskInspection(task) : undefined;
    if (task && target && (target.view === "transcript" || taskById(projection?.items ?? [], task.taskId)?.id === task.id)) { inspectTask(task.taskId, task.id); return; }
    if (worker.conversationId) { openChildConversation(worker.conversationId, subagentLabelFor(worker.conversationId, projection)); return; }
    expanded.add(id);
    scheduleRender();
    requestAnimationFrame(() => {
      const node = jumpToPrompt(id, false);
      const details = node instanceof HTMLDetailsElement ? node : node?.querySelector("details");
      if (details) details.open = true;
    });
  });

  // Stops in flight, by task id: a rebuild mid-request must not hand back
  // an enabled button that would send the stop twice.
  const stoppingTasks = new Set<string>();
  const queueDiscovery = new QueueDiscovery(presentationStorage);
  const actionFeedback = document.querySelector<HTMLElement>("#chat-action-feedback");
  let pendingChatAction: { dialog: HTMLDialogElement; closed: Promise<void>; reopening: boolean; cancel(): void } | undefined;
  const confirmChatAction = async (title: string, message: string, accept: string, invoker?: HTMLElement): Promise<boolean> => {
    const dialog = document.querySelector<HTMLDialogElement>("#chat-action-confirm");
    if (pendingChatAction && (!pendingChatAction.dialog.isConnected || pendingChatAction.dialog !== dialog)) pendingChatAction.cancel();
    if (!dialog || dialog.open) return false;
    if (pendingChatAction) {
      // Native close clears open and restores focus before delivering close.
      // Reserve at most one reopen intent; no next owner may consume that event.
      const previous = pendingChatAction;
      if (previous.reopening) return false;
      previous.reopening = true;
      await previous.closed;
      if (!dialog.isConnected || document.querySelector("#chat-action-confirm") !== dialog || dialog.open || pendingChatAction) return false;
    }
    // WebKit pointer activation need not focus its button. Capture the
    // actual invoker rather than the unrelated control still holding focus.
    const previousFocus = invoker ?? document.activeElement;
    const inspection = previousFocus instanceof HTMLElement && drilldownTask?.contains(previousFocus) ? child?.task : undefined;
    dialog.querySelector("#chat-action-confirm-title")!.textContent = title;
    dialog.querySelector("#chat-action-confirm-body")!.textContent = message;
    dialog.querySelector("#chat-action-confirm-accept")!.textContent = accept;
    dialog.returnValue = "cancel";
    return new Promise((resolve, reject) => {
      let complete!: () => void;
      const closed = new Promise<void>(done => { complete = done; });
      const owner = { dialog, closed, reopening: false, cancel: () => settle(false, false) };
      pendingChatAction = owner;
      let settled = false;
      const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") event.stopPropagation(); };
      const cleanup = () => {
        dialog.removeEventListener("keydown", onKey);
        dialog.removeEventListener("close", onClose);
      };
      const settle = (confirmed: boolean, restoreFocus = true) => {
        if (pendingChatAction !== owner || settled) return;
        settled = true;
        cleanup();
        try {
          if (restoreFocus) {
            const survivingInspection = inspection && child?.task?.taskId === inspection.taskId && child.task.conversationId === inspection.conversationId
              ? drilldownTask?.querySelector<HTMLElement>("[data-task-result], [data-stop-task]:not(:disabled)") ?? drilldownBack ?? drilldownTimeline : null;
            (previousFocus instanceof HTMLElement && previousFocus.isConnected ? previousFocus : survivingInspection ?? input)?.focus({ preventScroll: true });
          }
        } finally {
          pendingChatAction = undefined;
          resolve(confirmed);
          complete();
        }
      };
      // Snapshot this owner's result before focus restoration can invoke UI code.
      const onClose = () => settle(dialog.returnValue === "confirm");
      dialog.addEventListener("keydown", onKey);
      dialog.addEventListener("close", onClose, { once: true });
      try { dialog.showModal(); }
      catch (error) {
        cleanup();
        pendingChatAction = undefined;
        complete();
        reject(error);
      }
    });
  };
  const syncBackgroundTasks = () => {
    syncTaskInspection();
    for (const taskId of stoppingTasks) {
      const current = taskById(projection?.items ?? [], taskId);
      if (current && current.status !== "running") stoppingTasks.delete(taskId);
    }
  };
  // One stop path for every control that offers it: the composer row and the
  // drill-down's strip both name the task, and the in-flight guard is shared
  // so neither can send the stop twice.
  const requestStopTask = async (taskId: string, invoker: HTMLElement, itemId?: string) => {
    if (!projection || stoppingTasks.has(taskId)) return;
    const source = projection;
    const task = taskById(source.items, taskId);
    if (!task || itemId !== undefined && task.id !== itemId || task.status !== "running" || task.stateUncertain) return;
    if (declares("background-blocking-work") && task.taskType === "shell") {
      if (!await confirmChatAction("Stop shell worker?", "This removes its provider record and output. OpenCode may report failed rather than cancelled; missing output cannot be recovered after reload.", "Stop shell worker", invoker)) return;
      const current = taskById(projection?.items ?? [], taskId);
      if (projection?.conversationId !== source.conversationId || current?.id !== task.id || current.status !== "running" || current.stateUncertain || stoppingTasks.has(taskId)) return;
    }
    const asynchronous = declares("background-blocking-work");
    // The agent reports the stop as the task settling, which is what moves
    // the row out of this list; until then the control stays inert.
    stoppingTasks.add(taskId);
    syncBackgroundTasks();
    syncCompactWork();
    void api.stopTask(source.conversationId, taskId, newRequestId()).catch(async error => {
      stoppingTasks.delete(taskId);
      const message = error instanceof ChatTransportError && error.status !== undefined && error.code !== "operation_outcome_unknown"
        ? messageOf(error) : "Outcome unknown; refreshing. Stop will not be replayed automatically.";
      // Snapshot installation clears its transient loading announcement. Keep
      // the mutation outcome independently, and announce it after that read;
      // a successful read cannot turn an unknown receipt into acceptance.
      await refreshSelectedConversation(source.conversationId);
      setComposerError(message, source.conversationId);
      if (projection?.conversationId === source.conversationId) {
        (child?.task?.conversationId === source.conversationId ? announceChild : announce)(message, true);
      }
    }).finally(() => {
      if (!asynchronous) stoppingTasks.delete(taskId);
      syncBackgroundTasks();
      syncCompactWork();
    });
  };
  /**
   * Opens a running task from its composer row: the child transcript for an
   * agent task, titled as its subagents-track row is, and the task view for
   * a shell task, titled by the command.
   */
  const inspectTask = (taskId: string, itemId?: string) => {
    if (!projection) return;
    const source = projection;
    const task = taskById(source.items, taskId, itemId);
    const target = task ? taskInspection(task) : undefined;
    if (!task || !target) return;
    if (target.view === "transcript") {
      const known = subagentEntries(source.items).some(entry => entry.conversationId === target.conversationId);
      openChildConversation(target.conversationId, known ? subagentLabelFor(target.conversationId, source) : task.description, false, { conversationId: source.conversationId, taskId, itemId: task.id, view: "transcript" });
      return;
    }
    openChildConversation(`task-output:${taskId}`, task.description, false, { conversationId: source.conversationId, taskId, itemId: task.id, view: "output" });
  };
  drilldownTask?.addEventListener("click", event => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-stop-task], [data-task-result]");
    if (button?.dataset.stopTask !== undefined) requestStopTask(button.dataset.stopTask, button, button.dataset.stopItem);
    else if (button?.dataset.taskResult) {
      pendingRequestJump = button.dataset.taskResult;
      closeChildConversation();
    }
  });

  const scheduledWakeups = document.querySelector<HTMLDetailsElement>("#chat-scheduled-wakeups");
  const scheduledWakeupsLabel = document.querySelector<HTMLElement>("#chat-scheduled-wakeups-label");
  const scheduledWakeupsItems = document.querySelector<HTMLElement>("#chat-scheduled-wakeups-items");
  const releaseButton = document.querySelector<HTMLButtonElement>("#chat-wakeups-release");
  const releaseNote = document.querySelector<HTMLElement>("#chat-wakeups-release-note");

  /**
   * The wakeups the agent scheduled for itself, pinned above the composer
   * while its session is held for them: each with its prompt, whether it
   * recurs, and when it next fires, and one release that ends the session
   * and every wakeup in it (spec). There is no per-wakeup cancel — the agent
   * holds that control, not the user. Rebuilt only on change.
   */
  let paintedScheduledWakeups: string | null = null;
  // A release in flight, by conversation: the control stays inert until the
  // agent reports the wakeups ended, so it cannot be sent twice.
  const releasing = new Set<string>();
  // Cancels in flight, by wakeup id: a rebuild mid-request must not hand
  // back an enabled button that would send the cancel twice.
  const cancellingWakeups = new Set<string>();
  const syncScheduledWakeups = () => {
    if (!scheduledWakeups || !scheduledWakeupsLabel || !scheduledWakeupsItems || !releaseButton || !releaseNote) return;
    const declared = Boolean(projection && declares("scheduled-wakeups"));
    const pending = declared ? pendingWakeups(projection!.items) : [];
    // Paused crons (D11): the session is gone, the agent rebuilds them when
    // the conversation runs again. Listed so a prompt never revives one by
    // surprise, each with its own Cancel.
    const paused = declared ? pausedWakeups(projection!.items) : [];
    const entries = [...pending, ...paused];
    const status = projection?.status;
    const inFlight = projection ? releasing.has(projection.conversationId) : false;
    const signature = [status ?? "", inFlight ? "releasing" : "", ...entries.map(entry => [entry.wakeupId, entry.status, entry.prompt, entry.recurring, entry.nextFireAt ?? "", entry.schedule, cancellingWakeups.has(entry.wakeupId) ? "cancelling" : ""].join("\u0001"))].join("\u0002");
    if (signature === paintedScheduledWakeups) return;
    paintedScheduledWakeups = signature;
    if (entries.length === 0) {
      scheduledWakeups.hidden = true;
      scheduledWakeupsItems.replaceChildren();
      return;
    }
    scheduledWakeupsLabel.textContent = pending.length > 0 ? scheduledStatusLabel(pending) : pausedStatusLabel(paused);
    scheduledWakeupsItems.replaceChildren(...entries.map(entry => {
      const row = document.createElement("li");
      row.dataset.scheduledWakeup = entry.wakeupId;
      row.className = `is-${entry.status}`;
      const text = document.createElement("span");
      text.className = "chat-wakeup-prompt";
      text.textContent = entry.prompt || "(no prompt)";
      text.title = entry.prompt;
      row.append(text);
      if (entry.recurring) {
        const recurs = document.createElement("span");
        recurs.className = "chat-wakeup-recurring";
        recurs.textContent = "Repeats";
        recurs.title = `Recurring: ${entry.schedule}`;
        row.append(recurs);
      }
      const when = document.createElement("span");
      when.className = "chat-wakeup-when";
      if (entry.status === "paused") {
        when.textContent = "Paused";
        when.title = entry.message ?? "Fires again when this conversation runs.";
      } else {
        // An expression the workspace cannot read is still stated, as written.
        when.textContent = wakeupFireTime(entry.nextFireAt) ?? entry.schedule;
        if (entry.nextFireAt !== undefined) when.title = dateTime(entry.nextFireAt);
      }
      row.append(when);
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "chat-task-stop";
      cancel.dataset.cancelWakeup = entry.wakeupId;
      cancel.textContent = cancellingWakeups.has(entry.wakeupId) ? "Cancelling…" : "Cancel";
      cancel.disabled = cancellingWakeups.has(entry.wakeupId) || inFlight;
      cancel.setAttribute("aria-label", `Cancel wakeup: ${entry.prompt}`);
      row.append(cancel);
      return row;
    }));
    // Release ends the session, so it is offered only where nothing else
    // would end with it: a running turn, or background work, says so and
    // waits (the agent would refuse the release anyway). With only paused
    // crons there is no session to release; each has its own Cancel.
    const release = releaseButton.parentElement as HTMLElement | null;
    if (release) release.hidden = pending.length === 0;
    const releasable = status === "scheduled" && !inFlight;
    releaseButton.disabled = !releasable;
    releaseButton.textContent = inFlight ? "Releasing…" : "Release session";
    releaseNote.textContent = status === "background"
      ? "Release is possible once the background work ends."
      : status !== "scheduled" && !inFlight
        ? "Release is possible once this turn ends."
        : "Releasing cancels every wakeup and ends the agent's session.";
    scheduledWakeups.hidden = false;
  };
  scheduledWakeupsItems?.addEventListener("click", event => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-cancel-wakeup]");
    if (!button || button.disabled || !projection) return;
    const source = projection;
    const wakeupId = button.dataset.cancelWakeup ?? "";
    if (cancellingWakeups.has(wakeupId)) return;
    // The agent reports the cancel as the row settling, which is what moves
    // it out of this list; until then the control stays inert.
    cancellingWakeups.add(wakeupId);
    paintedScheduledWakeups = null;
    syncScheduledWakeups();
    void api.cancelWakeup(source.conversationId, wakeupId, newRequestId()).catch(error => {
      announceFailureFor(source)(messageOf(error), true);
    }).finally(() => {
      cancellingWakeups.delete(wakeupId);
      paintedScheduledWakeups = null;
      syncScheduledWakeups();
    });
  });
  releaseButton?.addEventListener("click", () => {
    if (!projection || releaseButton.disabled) return;
    const source = projection;
    if (releasing.has(source.conversationId)) return;
    releasing.add(source.conversationId);
    paintedScheduledWakeups = null;
    syncScheduledWakeups();
    void api.release(source.conversationId, newRequestId()).catch(error => {
      announceFailureFor(source)(messageOf(error), true);
    }).finally(() => {
      releasing.delete(source.conversationId);
      paintedScheduledWakeups = null;
      syncScheduledWakeups();
    });
  });

  const requestsJump = document.querySelector<HTMLButtonElement>("#chat-requests-jump");
  // One policy for what a drill-down is titled, read from the structured
  // entries rather than scraped from whichever markup happens to carry the
  // text — the track row and the timeline row must produce the same title.
  const subagentLabelFor = (conversationId: string, source: ChatProjection | null): string => {
    // What the subagent itself spent, beside its name, once it has reported a
    // price: every task it was given, and nothing it launched. A row states
    // one task; the transcript is the whole agent.
    return source ? subagentTranscriptTitle(subagentEntries(source.items), source.items, conversationId) : "Subagent";
  };
  /**
   * Outstanding requests, pinned so they cannot scroll away. Ten permissions in
   * one turn left a user unable to tell which still needed them; per-card
   * styling alone does not answer that in a long transcript, because you still
   * have to scroll and count. This says how many and takes you to one.
   */
  let paintedRequests = "";
  let outstandingCount = 0;
  // The pill leads to a request; while that request is already on screen it
  // has nothing to offer, and it is floating over the very card the user is
  // answering. Intersection is the right question to ask, and an observer
  // answers it off the scroll path — reading geometry per frame here would
  // both force a layout and flicker as the card crosses the edge.
  let requestObserver: IntersectionObserver | null = null;
  let observedRequestCard: Element | null = null;
  let requestTargetVisible = false;
  const syncRequestsJumpVisibility = () => {
    if (!requestsJump) return;
    // A parent card keeps intersecting the parent timeline while the
    // drill-down is pushed over it, but the reader cannot reach it there —
    // and the pill is layered above the pushed screen precisely so a request
    // the parent is waiting on stays visible from inside a subagent. So the
    // target does not count as on screen while the layer is up. A card
    // observed in the drill-down's own timeline is the layer's own business
    // and is unaffected.
    const buried = Boolean(drilldown && !drilldown.hidden) && Boolean(observedRequestCard && items.contains(observedRequestCard));
    requestsJump.hidden = outstandingCount === 0 || (requestTargetVisible && !buried);
  };
  /**
   * One observer, on the card the pill currently points at. It is torn down
   * and rebuilt whenever that element changes — a new target, a re-rendered
   * card, another conversation, or no outstanding request at all — so nothing
   * is left observing a node the timeline has dropped.
   * The current observer shares the document lifetime of initChat. Do not
   * disconnect it on pagehide: iOS can retain the page (see the save handler).
   * If this surface gains a dispose path, release this observer there too.
   */
  const observeRequestTarget = (id: string | undefined) => {
    const card = id ? items.querySelector(`[data-chat-item-id="${CSS.escape(id)}"]`) : null;
    if (card === observedRequestCard) return;
    observedRequestCard = card;
    requestObserver?.disconnect();
    requestObserver = null;
    requestTargetVisible = false;
    if (!card || typeof IntersectionObserver !== "function") return;
    requestObserver = new IntersectionObserver(entries => {
      const entry = entries.at(-1);
      if (!entry) return;
      // Half the card, or half of what the timeline can show — a sliver of a
      // card crossing the edge leaves its answer field and its Answer/Reject
      // controls off screen, and the pill is the only way back to them. The
      // dense threshold list is what has the rule re-evaluated as the card
      // scrolls rather than only as it enters and leaves.
      requestTargetVisible = entry.isIntersecting
        && (entry.intersectionRatio >= 0.5
          || (entry.rootBounds ? entry.intersectionRect.height >= entry.rootBounds.height / 2 : false));
      syncRequestsJumpVisibility();
    }, { root: timeline, threshold: Array.from({ length: 21 }, (_, index) => index / 20) });
    requestObserver.observe(card);
  };
  const syncOutstandingRequests = () => {
    if (!requestsJump) return;
    const outstanding = projection
      ? projection.items.filter(item => (item.type === "permission" || item.type === "question") && item.status === "pending")
      : [];
    const target = outstanding.reduce<(typeof outstanding)[number] | undefined>((newest, item) =>
      !newest || item.createdAt > newest.createdAt || (item.createdAt === newest.createdAt && item.id > newest.id) ? item : newest, undefined);
    // Skipped when nothing changed: rewriting the pill's text every frame
    // replaces the text node a finger may be resting on.
    const signature = `${outstanding.length}\u0001${target?.id ?? ""}`;
    if (signature !== paintedRequests) {
      paintedRequests = signature;
      if (outstanding.length === 0) {
        requestsJump.textContent = "";
        delete requestsJump.dataset.requestTarget;
      } else {
        const noun = outstanding.length === 1 ? "request needs" : "requests need";
        requestsJump.textContent = `${outstanding.length} ${noun} your answer`;
        // The answerable one is the newest; that is where the jump lands,
        // because it is the only one a user can act on right now.
        requestsJump.dataset.requestTarget = target!.id;
      }
    }
    // The count is the text's business; whether the pill shows is the
    // observer's, so these run on every sync even when the text did not move.
    outstandingCount = outstanding.length;
    observeRequestTarget(target?.id);
    syncRequestsJumpVisibility();
  };

  // A jump parked while the drill-down closes. Closing can be asynchronous —
  // it defers to a history pop when the drill-down's entry is current — and
  // the close re-asserts the parent's anchor, which would snap a jump
  // performed before it straight back to where the timeline was pinned. The
  // close performs the parked jump instead, after its own scroll restore.
  let pendingRequestJump: string | null = null;
  const jumpToRequestCard = (id: string) => {
    const card = items.querySelector(`[data-chat-item-id="${CSS.escape(id)}"]`);
    if (!(card instanceof HTMLElement)) return;
    for (let parent = card.parentElement; parent && parent !== items; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    }
    if (card instanceof HTMLDetailsElement) card.open = true;
    if (!card.hasAttribute("tabindex")) card.tabIndex = -1;
    card.scrollIntoView({ block: "center" });
    card.focus?.();
  };
  requestsJump?.addEventListener("click", () => {
    const id = requestsJump.dataset.requestTarget;
    if (!id) return;
    // The count is the parent's, so the jump is too: an open drill-down closes
    // first rather than scrolling a timeline the child is covering.
    if (child) {
      pendingRequestJump = id;
      closeChildConversation();
      return;
    }
    jumpToRequestCard(id);
  });

  const syncSubagentTitle = () => {
    // The open transcript's title states the same cost as the row: a running
    // subagent's price moves while its transcript is open, and a title
    // computed once at the click would keep the earlier figure. A task's
    // output view is titled by its command and is no subagent's transcript.
    if (child && drilldownTitle && child.task?.view !== "output") {
      const label = subagentLabelFor(child.conversationId, projection);
      if (label !== child.label) {
        child.label = label;
        drilldownTitle.textContent = label;
      }
    }
  };

  /**
   * How full the context window is. Occupancy is `input + cache read + cache
   * write` of the newest assistant message that reported any — that is the
   * prompt the most recent request carried, which already includes the
   * conversation so far. `output` is what came back rather than what is
   * sitting in the window, so it belongs in the breakdown and not the fill.
   *
   * Nothing reported means nothing is shown: an empty meter would be a claim
   * about a conversation, not an absence of data about it.
   */
  // What the meter last painted, by identity — items are immutable, so the
  // same source item means the same figures. This sync runs on every rendered
  // frame of a streaming turn, and text deltas must not pay for meter and
  // breakdown rebuilds that would come out identical.
  let paintedSource: ConversationItem | undefined;
  let paintedUsageModel: string | undefined;
  let paintedWindowKey: string | undefined;
  const syncContextIndicator = () => {
    if (!contextUsage?.isConnected || !contextUsageFill || !contextUsageLabel || !contextUsageBreakdown) return;
    // The newest report or carrier, scanned from the tail — it is almost
    // always right at the end of a long timeline (see context-readout.ts).
    const readout = contextReadout(projection?.items ?? [], models, displayedConfiguration().model);
    const inlineContext = document.querySelector<HTMLElement>("#chat-inline-context");
    if (inlineContext) {
      const qualifier = readout?.window?.source === "estimate" ? "~" : "";
      inlineContext.textContent = !readout || !declares("context") ? "Context not reported"
        : readout.limit === undefined ? `${formatTokens(readout.used)} context · limit unknown`
        : `${qualifier}${Math.round((readout.fraction ?? 0) * 100)}% · ${formatTokens(readout.used)}/${formatTokens(readout.limit)} context`;
      inlineContext.title = !readout || !declares("context") ? "Context occupancy has not been reported"
        : `${readout.used.toLocaleString()} tokens in context; ${readout.limit === undefined ? "limit unknown" : `${readout.limit.toLocaleString()} ${readout.window?.source ?? "reported"} limit`}${readout.window?.freshness === "cached" ? " (cached)" : ""}`;
    }
    const reportingModel = readout?.model ? modelValue(readout.model) : "";
    const windowKey = JSON.stringify([readout?.limit, readout?.window]);
    if (readout?.source === paintedSource && reportingModel === paintedUsageModel && windowKey === paintedWindowKey) return;
    paintedSource = readout?.source;
    paintedUsageModel = reportingModel;
    paintedWindowKey = windowKey;
    if (!readout || !declares("context")) {
      contextUsage.hidden = true;
      contextUsage.open = false;
      return;
    }
    const { used, limit, fraction } = readout;
    const fillPercent = Math.round((fraction ?? 0) * 100);
    contextUsageFill.style.setProperty("--context-fill", `${fillPercent}%`);
    // Keep the unfilled wedge centred on the right, so partial usage reads as
    // a right-facing Pac-Man rather than a clock with an arbitrary start edge.
    const startAngle = Math.round((90 + (100 - fillPercent) * 1.8) * 10) / 10;
    contextUsageFill.style.setProperty("--context-start", `${startAngle}deg`);
    // The figure states the fill in words as well as in width, so the tier
    // colouring below is emphasis on something already legible rather than
    // the only signal.
    const estimated = readout.window?.source === "estimate";
    contextUsageLabel.textContent = fraction === undefined ? formatTokens(used) : `${estimated ? "~" : ""}${Math.round(fraction * 100)}%`;
    contextUsage.dataset.fill = fraction === undefined ? "unknown" : fraction >= 0.9 ? "full" : fraction >= 0.75 ? "high" : "normal";
    contextUsage.dataset.source = readout.source.type === "context_report" ? "report" : "usage";
    contextUsage.dataset.windowSource = readout.window?.source ?? (limit === undefined ? "unknown" : "legacy");
    contextUsage.dataset.windowFreshness = readout.window?.freshness ?? "current";
    contextUsage.title = fraction === undefined
      ? `${used.toLocaleString()} tokens used · Limit unavailable`
      : `${used.toLocaleString()} of ${limit!.toLocaleString()} tokens in the context window${estimated ? " · Estimated limit" : readout.window?.freshness === "cached" ? " · Cached limit" : ""}`;
    contextUsageBreakdown.replaceChildren(...readout.rows.flatMap(([label, value]) => {
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = value.toLocaleString();
      return [term, detail];
    }));
    if (limit === undefined) {
      const term = document.createElement("dt");
      term.textContent = "Limit";
      const detail = document.createElement("dd");
      detail.textContent = "Limit unavailable";
      contextUsageBreakdown.append(term, detail);
    }
    contextUsage.hidden = false;
  };

  const promptRail = document.querySelector<HTMLElement>("#chat-prompt-rail");

  /**
   * One dot per user prompt, newest at the bottom — tap to jump back to that
   * exchange. Hidden below two prompts, where the rail carries no information,
   * and capped to the most recent dozen so it cannot outgrow the viewport.
   */
  let paintedRail = "";
  const syncPromptRail = () => {
    if (!promptRail) return;
    const prompts = projection
      ? projection.items.filter((item): item is Extract<ConversationItem, { type: "user_message" }> => item.type === "user_message")
      : [];
    // Rebuilt only when the dots would differ; the active marking still runs
    // every call, since it follows the scroll position rather than the set.
    const signature = prompts.length < 2 ? "" : prompts.slice(-12).map(prompt => prompt.id).join("\u0002");
    if (signature === paintedRail) {
      if (signature !== "") syncPromptRailActive();
      return;
    }
    paintedRail = signature;
    if (prompts.length < 2) {
      promptRail.hidden = true;
      promptRail.replaceChildren();
      surface.toggleAttribute("data-chat-rail", false);
      return;
    }
    promptRail.replaceChildren(...prompts.slice(-12).map(prompt => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "chat-prompt-dot";
      dot.dataset.promptTarget = prompt.id;
      const snippet = prompt.text.replace(/\s+/g, " ").trim().slice(0, 60);
      dot.title = snippet;
      dot.setAttribute("aria-label", `Jump to: ${snippet}`);
      return dot;
    }));
    promptRail.hidden = false;
    // The rail overlays the timeline's right edge, where user bubbles land —
    // reserve the strip so dots never sit on top of text.
    surface.toggleAttribute("data-chat-rail", true);
    syncPromptRailActive();
  };

  /** Marks the dot of the prompt currently governing the viewport. */
  const syncPromptRailActive = () => {
    if (!promptRail || promptRail.hidden) return;
    const dots = [...promptRail.querySelectorAll<HTMLElement>("[data-prompt-target]")];
    let activeId: string | null = null;
    if (timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop <= 48) {
      // At the end of the timeline the newest exchange governs even when it
      // is too short to scroll to the top — without this, jumping to the
      // last prompt leaves the previous dot lit.
      activeId = dots.at(-1)?.dataset.promptTarget ?? null;
    } else {
      const bounds = timeline.getBoundingClientRect();
      for (const dot of dots) {
        const node = items.querySelector(`[data-chat-item-id="${CSS.escape(dot.dataset.promptTarget!)}"]`);
        if (node && node.getBoundingClientRect().top - bounds.top <= 60) activeId = dot.dataset.promptTarget!;
      }
    }
    for (const dot of dots) dot.classList.toggle("is-active", dot.dataset.promptTarget === activeId);
  };

  // The rail scrubs like an iOS scroll index: press anywhere on it to see
  // which prompt a dot is, slide to preview others (the timeline follows
  // live), release to land. A floating label carries the prompt text, since
  // a title tooltip is unreachable on touch.
  const railLabel = document.createElement("div");
  railLabel.id = "chat-prompt-rail-label";
  railLabel.className = "chat-prompt-rail-label";
  railLabel.hidden = true;
  surface.append(railLabel);

  const railDotAt = (clientY: number): HTMLElement | null => {
    let best: HTMLElement | null = null;
    let bestDistance = Infinity;
    for (const dot of promptRail?.querySelectorAll<HTMLElement>("[data-prompt-target]") ?? []) {
      const rect = dot.getBoundingClientRect();
      const distance = Math.abs((rect.top + rect.bottom) / 2 - clientY);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = dot;
      }
    }
    return best;
  };

  const jumpToPrompt = (id: string, smooth: boolean): HTMLElement | null => {
    const node = items.querySelector<HTMLElement>(`[data-chat-item-id="${CSS.escape(id)}"]`);
    if (!node) return null;
    parentScroll.pause();
    const bounds = timeline.getBoundingClientRect();
    // Land below the scroller's reserved top band — the pinned day separator
    // when there is one — rather than under it.
    const reserved = items.querySelector(".chat-day-separator") ? Number.parseFloat(getComputedStyle(timeline).scrollPaddingTop) || 8 : 8;
    timeline.scrollTo({
      top: timeline.scrollTop + node.getBoundingClientRect().top - bounds.top - reserved,
      behavior: smooth && !reducedMotion() ? "smooth" : "auto",
    });
    return node;
  };

  // Short prompts often land with barely any scroll, so a jump can read as a
  // dead tap. Flash the prompt itself — restarted via reflow so landing on
  // the same prompt twice flashes twice.
  const flashPrompt = (id: string) => {
    const node = items.querySelector<HTMLElement>(`[data-chat-item-id="${CSS.escape(id)}"]`);
    if (!node) return;
    items.querySelector(".is-jump-target")?.classList.remove("is-jump-target");
    void node.offsetWidth;
    node.classList.add("is-jump-target");
  };

  const scrubTo = (dot: HTMLElement) => {
    promptRail?.querySelector(".is-scrubbing")?.classList.remove("is-scrubbing");
    dot.classList.add("is-scrubbing");
    const rect = dot.getBoundingClientRect();
    railLabel.textContent = dot.title;
    railLabel.style.top = `${(rect.top + rect.bottom) / 2 - surface.getBoundingClientRect().top}px`;
    railLabel.hidden = false;
    jumpToPrompt(dot.dataset.promptTarget!, false);
  };

  let scrubFrame: number | null = null;
  let scrubY = 0;
  let scrubbedDot: HTMLElement | null = null;
  let scrubEndedAt = 0;
  promptRail?.addEventListener("pointerdown", event => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    promptRail.setPointerCapture(event.pointerId);
    const dot = railDotAt(event.clientY);
    if (dot) {
      scrubbedDot = dot;
      scrubTo(dot);
    }
  });
  promptRail?.addEventListener("pointermove", event => {
    if (!promptRail.hasPointerCapture(event.pointerId)) return;
    scrubY = event.clientY;
    scrubFrame ??= requestAnimationFrame(() => {
      scrubFrame = null;
      const dot = railDotAt(scrubY);
      if (dot && dot !== scrubbedDot) {
        scrubbedDot = dot;
        scrubTo(dot);
      }
    });
  });
  const endScrub = (event: PointerEvent) => {
    if (!promptRail?.hasPointerCapture(event.pointerId)) return;
    promptRail.releasePointerCapture(event.pointerId);
    railLabel.hidden = true;
    promptRail.querySelector(".is-scrubbing")?.classList.remove("is-scrubbing");
    scrubEndedAt = performance.now();
    const dot = scrubbedDot;
    scrubbedDot = null;
    if (dot?.dataset.promptTarget) flashPrompt(dot.dataset.promptTarget);
  };
  promptRail?.addEventListener("pointerup", endScrub);
  promptRail?.addEventListener("pointercancel", endScrub);
  // Keyboard activation still lands on the click path; a click that trails a
  // finished scrub is the same gesture arriving twice and is dropped.
  promptRail?.addEventListener("click", event => {
    if (performance.now() - scrubEndedAt < 500) return;
    const dot = (event.target as Element).closest<HTMLElement>("[data-prompt-target]");
    if (!dot?.dataset.promptTarget) return;
    jumpToPrompt(dot.dataset.promptTarget, true);
    flashPrompt(dot.dataset.promptTarget);
  });
  items.addEventListener("animationend", event => {
    if (event.animationName === "chat-jump-flash") (event.target as HTMLElement).classList.remove("is-jump-target");
  });

  const syncHistoryControls = () => {
    const historyBusy = composer.submitting || (projection ? composer.historyBusy(projection.conversationId) : false);
    for (const button of items.querySelectorAll<HTMLButtonElement>("[data-history-revert]")) button.disabled = historyBusy;
    for (const button of revertedItems?.querySelectorAll<HTMLButtonElement>("[data-history-restore]") ?? []) button.disabled = historyBusy;
  };

  // Focus a renderer asked for, once its timeline has painted (see
  // TimelineRenderer.focusAfterPaint).
  const applyFocusAfterPaint = (owner: TimelineRenderer, container: HTMLElement) => {
    const selector = owner.focusAfterPaint;
    if (!selector) return;
    owner.focusAfterPaint = undefined;
    container.querySelector<HTMLElement>(selector)?.focus();
  };

  const renderNow = (newContent: boolean) => {
    if (!chatSurfaceActive()) { renderDirty = true; pendingNewContent ||= newContent; return; }
    renderDirty = false;
    lastTranscriptPaint = performance.now();
    rendering = true;
    // The card states the owning agent's own persistent-approval reach.
    renderer.permissionScopeNote = agent?.permissionScopeNote;
    renderer.loginAction = contextLoginAction();
    const conversation = conversations.find(value => value.id === projection?.conversationId);
    renderer.conversationTitle = conversation ? displayConversationTitle(conversation) : chatHeading();
    const dirty = renderer.render(items, projection, expanded, declares("subagents"), declares("reversible-history"), turnStartedAt(projection));
    // Reconcile the current snapshot before revealing a retained output window.
    renderer.setShellOutputsHidden(false);
    revertedDock?.render(projection?.reversibleHistory?.revertedMessages ?? []);
    const pendingPane = queueDockElement.querySelector<HTMLElement>(".chat-queue-content");
    if (pendingPaintedConversation && pendingPaintedOpen && !pendingScrollRestore && !queueDockElement.hidden && pendingPane?.clientHeight) {
      boundedSet(pendingScrollPositions, pendingPaintedConversation, pendingPane.scrollTop, 200);
    }
    const pendingConversation = projection?.conversationId ?? null;
    const pendingOpen = compactPendingState.paint(pendingConversation, projection?.queued.length ?? 0,
      document.documentElement.dataset.uiMode === "touch" ? "touch" : "desktop");
    const restorePending = pendingOpen && (pendingConversation !== pendingPaintedConversation || !pendingPaintedOpen);
    queueDock.render(queueDockElement, projection?.queued ?? [], {
      conversationId: pendingConversation,
      withdrawalRetries: pendingConversation ? composer.withdrawalRetries(pendingConversation) : undefined,
      pendingActions: pendingConversation ? composer.pendingActions(pendingConversation) : undefined,
      steering: declares("steering"),
      sendNow: declares("send-now"),
      running: isLiveConversationStatus(projection?.status),
      replacement: projection?.reversibleHistory?.staged === true,
      compactOpen: pendingOpen,
      isCommand: isListedCommand,
      ...(queueNoteElement ? { note: queueNoteElement } : {}),
    });
    if (pendingConversation !== pendingPaintedConversation || restorePending) {
      pendingScrollRestore = pendingConversation && pendingOpen && !projection?.reversibleHistory?.staged
        ? { conversation: pendingConversation, top: pendingScrollPositions.get(pendingConversation) ?? 0 } : null;
      const pane = queueDockElement.querySelector<HTMLElement>(".chat-queue-content");
      if (pane) pane.scrollTop = pendingScrollRestore?.top ?? 0;
    }
    pendingPaintedConversation = pendingConversation;
    pendingPaintedOpen = pendingOpen;
    syncHistoryControls();
    rendering = false;
    syncTaskList();
    syncSubagentTitle();
    syncBackgroundTasks();
    syncCompactWork();
    syncScheduledWakeups();
    syncQueueOverflow();
    syncOutstandingRequests();
    syncContextIndicator();
    syncPromptRail();
    parentScroll.request(newContent);
    latestButton.hidden = !anchor.hasUnseen();
    syncControls();
    for (const node of dirty) {
      decorateFileLinks(node);
      decorateAttachmentImages(node);
      // A freshly built question form starts with its primary button disabled;
      // this settles the tab strip and button state for its first step.
      node.querySelectorAll<HTMLFormElement>("form[data-question-form]").forEach(syncQuestionForm);
    }
    applyFocusAfterPaint(renderer, items);
    reconcileAnswerAfterPaint();
    syncDesktopWorkLayout();
    restorePendingScroll();
  };

  function restorePendingScroll() {
    if (!pendingScrollRestore || pendingPaintedConversation !== pendingScrollRestore.conversation || !pendingPaintedOpen) return;
    const pane = queueDockElement?.querySelector<HTMLElement>(".chat-queue-content");
    if (!pane?.clientHeight) return;
    pane.scrollTop = pendingScrollRestore.top;
    pendingScrollRestore = null;
  }

  const scheduleRender = (newContent = false, captureCurrent = true, incremental = false) => {
    renderDirty = true;
    pendingNewContent ||= newContent;
    if (!chatSurfaceActive()) { syncChatAttention(); return; }
    const delay = incremental ? 50 - (performance.now() - lastTranscriptPaint) : 0;
    if (delay > 0) {
      if (incrementalTimer === null) incrementalTimer = setTimeout(() => {
        incrementalTimer = null;
        scheduleRender(false, captureCurrent);
      }, delay);
      return;
    }
    if (incrementalTimer !== null) { clearTimeout(incrementalTimer); incrementalTimer = null; }
    if (renderFrame !== null) return;
    // beforeMutation is a no-op while pinned — skipping the call skips the
    // full-geometry pass it would otherwise be handed for nothing.
    if (captureCurrent) parentScroll.beforeMutation();
    renderFrame = requestAnimationFrame(timestamp => {
      renderFrame = null;
      const content = pendingNewContent;
      pendingNewContent = false;
      renderNow(content);
      parentScroll.flush(timestamp);
    });
  };

  const workingText = () => {
    if (!projection) return "Select a conversation";
    const base = statusLabel(projection.status);
    const workingSince = presentation.workingSince[projection.conversationId];
    if (workingSince === undefined) return base;
    return `${base} · ${formatElapsed(Date.now() - workingSince)}`;
  };

  /**
   * When the running turn began, for the timeline's working line. The
   * presentation's own clock once syncControls has started it; before that
   * (the first render of a turn runs ahead of syncControls) and for a
   * subagent's transcript, which has no clock of its own, the prompt that
   * started the turn — the same instant syncControls will record.
   */
  const turnStartedAt = (source: ChatProjection | null | undefined): number | undefined => {
    if (!source || !isLiveConversationStatus(source.status)) return undefined;
    return presentation.workingSince[source.conversationId] ?? source.items.findLast(item => item.type === "user_message")?.createdAt ?? Date.now();
  };

  // The once-a-second tick of every working line on screen. Writes the
  // label only — a full render for a clock would rebuild nothing and cost a
  // layout pass every second of every turn.
  const tickWorkingLines = () => {
    if (!chatSurfaceActive()) return;
    for (const container of [items, drilldownItems]) {
      for (const line of container?.querySelectorAll<HTMLElement>(".chat-activity-group[data-working-since]") ?? []) {
        const label = line.querySelector(".chat-group-count");
        if (label) label.textContent = workingLabel(Date.now() - Number(line.dataset.workingSince));
      }
    }
  };

  // The composer task rows that carry an elapsed readout instead of a
  // progress note, ticked by the same clock as the working lines: the rows
  // are rebuilt only when what they SAY changes, and the elapsed time is not
  // part of that, so the second hand writes into the row in place.

  // The tick runs while anything on screen is working: the parent's turn, the
  // subagent in the drill-down, or a background task the turn left running. A
  // child keeps running after its parent has gone background or idle, and its
  // working line is stamped from the child's own status — so the parent's
  // status alone cannot decide whether the clock is needed. Background work
  // is its own case because the background state is not a live status: the
  // turn has ended, and only the tasks are still going. Re-evaluated wherever
  // any of those can change, so the last task settling stops the clock.
  const syncWorkingTimer = () => {
    const tasksRunning = declares("background-tasks") && runningBackgroundTasks(projection?.items ?? []).length > 0;
    const working = chatSurfaceActive() && (isLiveConversationStatus(projection?.status) || isLiveConversationStatus(child?.projection?.status) || tasksRunning);
    if (working && workingTimer === null) workingTimer = setInterval(() => {
      syncRoutineStatus(); tickWorkingLines();
      for (const readout of compactWorkersItems?.querySelectorAll<HTMLElement>("[data-elapsed-since]") ?? []) {
        readout.textContent = formatTaskElapsed(Date.now() - Number(readout.dataset.elapsedSince));
      }
    }, 1_000);
    if (!working && workingTimer !== null) {
      clearInterval(workingTimer);
      workingTimer = null;
    }
  };

  const showComposerError = (message: string | null) => {
    composerError.textContent = message ?? "";
    composerError.hidden = !message;
    composerError.classList.toggle("is-notice", message === TOO_LATE);
  };
  // Composer errors belong to the conversation they happened in: an upload
  // that fails after the user switched away must not flash its refusal into
  // the selected conversation, and the reason must still be waiting when its
  // own conversation is selected again. Callers with a captured id (the
  // staging chain) pass it; everything else speaks about the selection.
  const composerErrors = new Map<string, string>();
  const setComposerError = (message: string | null, conversationId = activeConversationId()) => {
    if (conversationId) {
      if (message) composerErrors.set(conversationId, message);
      else composerErrors.delete(conversationId);
    }
    if (!conversationId || conversationId === activeConversationId()) showComposerError(message);
  };

  // ------------------------------------------------------------------
  const activeConversationId = (): string | null =>
    projection?.conversationId ?? presentation.selectedId ?? null;
  const composer = new Composer({
    selected: activeConversationId, read: () => projection,
    write: next => { projection = next; }, epoch: () => projectionEpoch,
    cancelling: () => cancelling, declares,
    commands: () => commands, commandsAvailable: () => commandInventoryAvailable,
    agentId: () => contextAgentId,
    refreshCommands: agentId => { void refreshBankedCommands(agentId); },
    reloadCommands: async () => {
      if (!contextAgentId) return false;
      try {
        commands = await api.commands(contextAgentId);
        commandInventoryAvailable = true;
        const cached = agentCatalogs.get(contextAgentId);
        if (cached) agentCatalogs.set(contextAgentId, { ...cached, commands, commandInventoryAvailable: true });
        return true;
      } catch { return false; }
    },
    configuration: () => {
      const configuration = displayedConfiguration();
      const record = declares("models") && configuration.model ? models.find(model => sameModel(model.selection, configuration.model!)) : undefined;
      const model = record?.selection ?? (declares("models") && declares("custom-model-id") ? configuration.model : undefined);
      const variant = declares("variants") && configuration.variant && record?.variants?.includes(configuration.variant) ? configuration.variant : undefined;
      const mode = declares("modes") && modes.some(mode => mode.name === configuration.mode) ? configuration.mode : undefined;
      return { value: { model, mode, variant }, stage: stagedConfigurations.get(activeConversationId()!) };
    },
    consumeConfiguration: (id, stage) => {
      if (stagedConfigurations.get(id) === stage) stagedConfigurations.delete(id);
    },
    imageSupport: () => attachmentModelSupport(),
    refresh: (id, entry) => refreshSelectedConversation(id, entry),
  }, api, {
    read: id => activeConversationId() === id ? input.value : presentation.drafts[id] ?? "",
    write: (id, text) => {
      presentation.drafts[id] = text;
      if (activeConversationId() === id && input.value !== text) { input.value = text; slashQueryActive = false; autosize(input); }
      save();
    },
  }, {
    changed: (change, id) => {
      if (change === "draft") closeCommandMenu();
      if (change === "attachments" || change === "submit" || (change === "edit" || change === "history" || change === "restored") && activeConversationId() === id) renderAttachments();
      if (change === "accepted" && projection?.conversationId === id) renderConfiguration();
      syncControls();
      if (change === "submit") { parentScroll.latest(); latestButton.hidden = true; }
      if (change === "submit" || change === "accepted" || change === "pending" || change === "projection" || change === "restored") scheduleRender(change === "submit" || change === "accepted");
      if ((change === "edit" || change === "history") && activeConversationId() === id) input.focus();
    },
    error: setComposerError, note: (message, error) => noteComposer(message, error), announce,
    accepted: accepted => {
      if (!accepted.conversation) return;
      conversations = conversations.map(conversation => conversation.id === accepted.conversation!.id ? accepted.conversation! : conversation);
      relabelConversationOption(accepted.conversation);
      if (chatTitle) chatTitle.textContent = displayConversationTitle(accepted.conversation);
    },
    heldByHold: () => queueDiscovery.accepted(true),
  });
  const currentPendingAttachments = () => composer.pendingAttachments();
  const currentUnavailableAttachments = () => composer.unavailableAttachments();
  const noteAttachmentRefusal = (id: string, count = 1) => composer.noteAttachmentRefusal(id, count);

  // Whether the displayed model can see images. No selection means the agent
  // chooses — unknown is not "no", so the intake stays open and the provider
  // is the judge. A known selection without image support gates the intake,
  // naming the model (spec: visible but inactive, because the model choice
  // flips constantly and a vanishing control would be undiscoverable).
  const attachmentModelSupport = (): { supported: true } | { supported: false; modelName: string } => {
    if (!declares("models")) return { supported: true };
    const selection = displayedConfiguration().model;
    const record = selection ? models.find(model => sameModel(model.selection, selection)) : undefined;
    if (!record) return { supported: true };
    return record.imageInput === true
      ? { supported: true }
      : { supported: false, modelName: record.name };
  };

  const syncAttachControl = () => {
    if (!attachButton?.isConnected) return;
    const support = attachmentModelSupport();
    attachButton.disabled = !support.supported;
    const label = support.supported ? "Attach images" : `${support.modelName} cannot see images`;
    attachButton.title = label;
    attachButton.setAttribute("aria-label", label);
  };

  const renderAttachments = () => {
    if (!attachmentsStrip) return;
    const entries = currentPendingAttachments();
    const unavailable = currentUnavailableAttachments();
    attachmentsStrip.textContent = "";
    attachmentsStrip.hidden = entries.length === 0 && unavailable.length === 0;
    for (const entry of entries) {
      const item = document.createElement("span");
      item.className = "chat-attachment";
      item.setAttribute("role", "listitem");
      const view = document.createElement("button");
      view.type = "button";
      view.className = "chat-attachment-view";
      view.setAttribute("data-attachment-view", entry.previewUrl);
      view.setAttribute("data-attachment-view-name", entry.name);
      view.setAttribute("aria-label", `View ${entry.name} full size`);
      const thumb = document.createElement("img");
      thumb.className = "chat-attachment-thumb";
      thumb.src = entry.previewUrl;
      thumb.alt = entry.name;
      view.append(thumb);
      const name = document.createElement("span");
      name.className = "chat-attachment-name";
      name.textContent = entry.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chat-attachment-remove";
      remove.setAttribute("aria-label", `Remove ${entry.name}`);
      remove.textContent = "\u00d7";
      remove.addEventListener("click", () => {
        const conversationId = activeConversationId();
        if (!conversationId) return;
        composer.removeAttachment(entry);
        renderAttachments();
        syncControls();
      });
      item.append(view, name, remove);
      attachmentsStrip.append(item);
    }
    for (const entry of unavailable) {
      const item = document.createElement("span");
      item.className = "chat-attachment is-missing";
      item.setAttribute("role", "listitem");
      const placeholder = document.createElement("span");
      placeholder.className = "chat-attachment-missing";
      placeholder.setAttribute("aria-hidden", "true");
      placeholder.textContent = "?";
      const name = document.createElement("span");
      name.className = "chat-attachment-name";
      name.textContent = entry.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chat-attachment-remove";
      remove.setAttribute("aria-label", `Remove unavailable ${entry.name}`);
      remove.textContent = "\u00d7";
      remove.addEventListener("click", () => {
        const conversationId = activeConversationId();
        if (!conversationId) return;
        composer.removeAttachment(entry);
        renderAttachments();
        syncControls();
      });
      item.append(placeholder, name, remove);
      attachmentsStrip.append(item);
    }
  };

  // A typeless file stays a candidate — the staging gate and the upload
  // route's byte sniff decide, not the browser's filename-derived claim.
  const attachableClaim = (file: File) => file.type === "" || file.type.startsWith("image/");

  // A mixed drop or paste stages its images but must not let the rest vanish
  // silently — a file that disappears without a word reads as attached. An
  // intake with nothing supported in it is refused by its own branch before
  // reaching here, so this speaks only for the mix.
  const warnUnsupportedIntake = (files: File[], images: File[]) => {
    if (images.length === 0 || images.length === files.length) return;
    const refused = files.filter(file => !attachableClaim(file));
    // Counted like any staging refusal: a mix dropped while a submit drains
    // is content meant for that very message, and the post-drain guard must
    // see the loss rather than send the supported subset alone.
    const conversationId = activeConversationId();
    if (conversationId) noteAttachmentRefusal(conversationId, refused.length);
    setComposerError(refused.length === 1
      ? `${refused[0]!.name || "That file"} is not a supported image (PNG, JPEG, GIF, WebP).`
      : `${refused.length} files are not supported images (PNG, JPEG, GIF, WebP).`);
  };

  /**
   * Client-side screening only smooths the path — the upload route re-checks
   * type and size authoritatively (and by bytes, not by claim). A refusal
   * explains itself on the composer error line and touches neither the draft
   * nor the attachments already staged.
   */
  const stageAttachmentFiles = (files: File[]) => composer.attach(files);

  const openAttachmentViewer = (src: string, name: string) => {
    if (!imageViewer || !imageViewerImage) return;
    // The attribute round trip means the value technically arrives from the
    // DOM, so it is re-validated against the only two shapes this app ever
    // writes there: a staged blob: preview and the same-origin serve route.
    let resolved: URL;
    try { resolved = new URL(src, window.location.href); } catch { return; }
    if (resolved.protocol !== "blob:" && resolved.origin !== window.location.origin) return;
    imageViewerImage.src = resolved.href;
    imageViewerImage.alt = name;
    if (imageViewerName) imageViewerName.textContent = name;
    imageViewer.showModal();
  };
  const closeAttachmentViewer = () => {
    imageViewer?.close();
    // Freed eagerly so a revoked object URL or a huge image does not linger.
    if (imageViewerImage) imageViewerImage.src = "";
  };
  // One delegated listener covers every surface a thumbnail renders in —
  // timeline, queue dock, drill-down, and the composer strip.
  surface.addEventListener("click", event => {
    const view = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-attachment-view]") : null;
    if (!view) return;
    const src = view.getAttribute("data-attachment-view");
    if (!src) return;
    openAttachmentViewer(src, view.getAttribute("data-attachment-view-name") ?? "attachment");
  });
  // Escape closes natively; any click dismisses too — the dialog is a
  // viewer, not a form, so there is nothing a stray click could lose.
  imageViewer?.addEventListener("click", closeAttachmentViewer);
  imageViewer?.addEventListener("close", () => {
    if (imageViewerImage) imageViewerImage.src = "";
    // The dialog's focus restoration targets whatever held focus before
    // showModal(). A pointer flow in Safari focuses the tabindex="0" log,
    // not the thumbnail button, and the restored focus then paints a ring
    // around the whole conversation. Blurring only the container is safe:
    // a keyboard flow restores to the thumbnail button itself, which keeps
    // its own focus ring untouched.
    const restored = document.activeElement;
    if (restored instanceof HTMLElement && restored.classList.contains("chat-timeline")) restored.blur();
  });
  imageViewerClose?.addEventListener("click", closeAttachmentViewer);

  attachButton?.addEventListener("click", () => {
    if (attachButton.disabled) return;
    attachInput?.click();
  });
  attachInput?.addEventListener("change", () => {
    const files = Array.from(attachInput.files ?? []);
    attachInput.value = "";
    void stageAttachmentFiles(files);
  });
  input.addEventListener("paste", event => {
    if (!event.clipboardData) return;
    const pastedFiles = Array.from(event.clipboardData.files);
    if (pastedFiles.length === 0) return;
    // Without the capability there is no image intake at all: default paste
    // behavior stands untouched, refusals included.
    if (agent && !declares("attachments")) return;
    const files = pastedFiles.filter(attachableClaim);
    if (files.length === 0) {
      // Counted like every other refusal: files pasted while a submit drains
      // were meant for that message, and the post-drain guard must see the
      // loss even when nothing in the paste could stage. Deliberately without
      // preventDefault — the clipboard may carry text alongside the refused
      // file, and that text still rides the browser's own paste.
      const conversationId = activeConversationId();
      if (conversationId) noteAttachmentRefusal(conversationId, pastedFiles.length);
      setComposerError("Only PNG, JPEG, GIF, or WebP images can be attached.");
      return;
    }
    event.preventDefault();
    // A paste that carries both text and images keeps both (spec): the text
    // enters the draft at the caret exactly as an unintercepted paste would.
    const text = event.clipboardData.getData("text/plain");
    if (text) {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      input.value = input.value.slice(0, start) + text + input.value.slice(end);
      const caret = start + text.length;
      input.setSelectionRange(caret, caret);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    warnUnsupportedIntake(pastedFiles, files);
    void stageAttachmentFiles(files);
  });
  const dragCarriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
  form.addEventListener("dragover", event => {
    if (!dragCarriesFiles(event) || (agent && !declares("attachments"))) return;
    event.preventDefault();
    form.classList.add("is-drop-target");
  });
  form.addEventListener("dragleave", event => {
    const next = event.relatedTarget;
    if (next instanceof Node && form.contains(next)) return;
    form.classList.remove("is-drop-target");
  });
  // A cancelled drag (Escape) can end without a dragleave on the hovered
  // target; dragend on window is the reset of last resort.
  window.addEventListener("dragend", () => form.classList.remove("is-drop-target"));
  form.addEventListener("drop", event => {
    if (!dragCarriesFiles(event) || (agent && !declares("attachments"))) return;
    event.preventDefault();
    form.classList.remove("is-drop-target");
    const dropped = Array.from(event.dataTransfer?.files ?? []);
    const images = dropped.filter(attachableClaim);
    if (images.length === 0) {
      // Counted like every other refusal: files dropped while a submit
      // drains were meant for that message, and the post-drain guard must
      // see the loss even when nothing in the drop could stage.
      const conversationId = activeConversationId();
      if (conversationId) noteAttachmentRefusal(conversationId, dropped.length);
      setComposerError("Only PNG, JPEG, GIF, or WebP images can be attached.");
      return;
    }
    warnUnsupportedIntake(dropped, images);
    void stageAttachmentFiles(images);
  });

  /**
   * The plan summary and its readout. The summary is the newest plan the
   * timeline holds, in Claude Code's own words; opening it shows every
   * window the login reported, the plan's name, and what this conversation
   * has cost. Painted only when the report behind it changes — this runs on
   * every rendered frame of a streaming turn, like the context meter — and
   * the rows alone are re-painted once a minute while open so the relative
   * resets keep pace with the clock.
   */
  let paintedPlanReport: ContextReportItem | undefined;
  let paintedTotalsKey: string | undefined;
  // The standing the chip and readout were last painted for, so a rate
  // limit that begins or ends without a new plan report still repaints.
  let paintedStanding: RateLimitStanding | undefined;
  // The standing last spoken, per conversation. Per conversation because a
  // selection change blanks the projection before the incoming snapshot
  // lands: read as one conversation's history, that blank says "the standing
  // ended" and the reader is told a limit cleared that is still in force.
  // A conversation's own entry only moves when its own standing does.
  //
  // The level, not the words. The login restates a warning on every request
  // with its utilization ticking up, and the message carries that figure —
  // keyed on the spoken text, the warning would be read aloud again on each
  // one, moving the noise this change takes out of the timeline into the
  // reader's ear instead. The transitions worth speaking are the ones the
  // spec names: beginning, changing level, and retirement.
  const announcedStandings = new Map<string, RateLimitStanding["level"] | undefined>();
  // Which conversation the live region is currently describing, so a change
  // of selection can stop it describing the one the reader has left.
  let liveStandingConversation: string | undefined;
  const ANNOUNCED_STANDING_LIMIT = 256;
  let planTick: ReturnType<typeof setInterval> | undefined;
  const paintPlanRows = () => {
    if (planReadoutRowsElement && paintedPlanReport?.plan) planReadoutRowsElement.replaceChildren(...buildPlanRowNodes(document, planReadoutRows(paintedPlanReport.plan)));
    // The standing's reset reads relative to now, like the rows: ticked with them.
    if (planReadoutStanding && paintedStanding) planReadoutStanding.textContent = standingSentence(paintedStanding);
    paintPlanAge();
    paintPlanReadControls();
  };
  // The pin makes sense only where the sidebar sits beside the chat: on the
  // desktop layout with the sidebar expanded, and while the pane is not
  // already showing. Touch mode reaches the pane through the panels menu on
  // the Files tab, where the sidebar actually renders.
  const syncPlanPin = () => {
    if (!planPin) return;
    const pane = appState.panes.usage;
    const desktop = document.documentElement.dataset.uiMode === "desktop";
    const sidebarShown = !document.querySelector(".app-shell")?.classList.contains("is-sidebar-collapsed");
    planPin.hidden = !desktop || !sidebarShown || (pane.visible && !pane.collapsed);
  };
  // A session tally is keyed by the wire id ("claude-opus-5[1m]"); the
  // catalog knows it by selection or resolved id, with or without the
  // window marker, and a live catalog may carry only the family ("opus[1m]")
  // where the wire id carries family and version. An exact id wins, the
  // family stands in — skipping the default row, which names no model of
  // its own — and anything the catalog cannot name is shown as reported.
  const sessionModelName = (id: string): string => {
    const strip = (value: string) => value.replace(/\[[^\]]*\]$/, "");
    const bare = strip(id);
    const ids = (model: ChatModel) => [model.selection.modelId, model.resolvesTo?.modelId].filter((candidate): candidate is string => candidate !== undefined);
    const exact = models.find(model => ids(model).some(candidate => candidate === id || strip(candidate) === bare));
    const family = exact ?? models.find(model => !model.default && ids(model).some(candidate => bare.includes(strip(candidate))));
    return family?.name ?? id;
  };
  // The conversation block is a receipt: lines that sum to a total, itemized
  // by agent, by kind of agent, or by model — one at a time, the reader's
  // choice, remembered. Totals the agent tallies itself (Claude Code) come per
  // model only: no control, no total line, the block as it has always read.
  let paintedSession: { session: ConversationTotals; items: readonly ConversationItem[] } | undefined;
  const receiptView = (session: ConversationTotals): ReceiptView => session.receipt ? presentation.receiptView ?? "agents" : "models";
  const paintPlanSession = (session: ConversationTotals | undefined, items: readonly ConversationItem[]) => {
    if (!planSession || !planSessionCost || !planSessionModels) return;
    paintedSession = session ? { session, items } : undefined;
    planSession.hidden = !session;
    if (!session) return;
    // "This conversation", or "since HH:MM" when the tally began after the
    // conversation's first message (a workspace restarted mid-conversation).
    const title = sessionTotalsTitle(session, items);
    if (planSessionTitle) planSessionTitle.textContent = title;
    planSession.setAttribute("aria-label", title);
    const parts = [formatUsd(session.costUsd)];
    if (session.apiDurationMs > 0) parts.push(`${formatApiTime(session.apiDurationMs)} of API time`);
    if (session.linesAdded > 0 || session.linesRemoved > 0) parts.push(`+${session.linesAdded} −${session.linesRemoved} lines`);
    planSessionCost.textContent = parts.join(" · ");
    const view = receiptView(session);
    if (planSessionViews) {
      planSessionViews.hidden = !session.receipt;
      for (const button of planSessionViews.querySelectorAll<HTMLElement>("[data-receipt-view]")) {
        const active = button.dataset.receiptView === view;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-checked", String(active));
        button.tabIndex = active ? 0 : -1;
      }
    }
    if (planSessionHeading) planSessionHeading.textContent = receiptHeading(view);
    planSessionModels.replaceChildren(...buildReceiptRows(document, session, view, sessionModelName));
    if (planSessionTotal) {
      planSessionTotal.hidden = !session.receipt;
      planSessionTotal.replaceChildren(...(session.receipt ? [buildReceiptTotal(document, session.receipt.total)] : []));
    }
  };
  const chooseReceiptView = (view: ReceiptView, focus: boolean) => {
    presentation.receiptView = view;
    save();
    if (paintedSession) paintPlanSession(paintedSession.session, paintedSession.items);
    if (focus) planSessionViews?.querySelector<HTMLElement>(`[data-receipt-view="${view}"]`)?.focus();
  };
  planSessionViews?.addEventListener("click", event => {
    const view = parseReceiptView((event.target as Element).closest<HTMLElement>("[data-receipt-view]")?.dataset.receiptView);
    if (view) chooseReceiptView(view, false);
  });
  // A radiogroup moves its selection with the arrow keys, not Tab.
  planSessionViews?.addEventListener("keydown", event => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0 || !paintedSession) return;
    event.preventDefault();
    const views: readonly ReceiptView[] = ["agents", "types", "models"];
    chooseReceiptView(views[(views.indexOf(receiptView(paintedSession.session)) + step + views.length) % views.length]!, true);
  });
  // A login without plan limits (API key, Bedrock, Vertex) reports an empty
  // plan beside real session totals. The chip then carries the conversation's
  // cost — the figure that login budgets by — and the readout is only the
  // "This conversation" block: no plan name, no meters, no pin, since there
  // is no plan to name or keep in the sidebar. The pane still hears the
  // empty plan and says the login reports none. "Empty" is the readout's
  // own test — no row to draw — not the chip's base summary: a plan of only
  // a model-scoped bucket, or of reset-only base windows, has rows to show.
  // The workspace's last-known report, shaped as the report a conversation
  // would carry, so a conversation without one of its own reads the same
  // path. Cached per held report: the repaint check keys on identity.
  let knownAsReport: { source: ReturnType<typeof currentUsageReport>; item: ContextReportItem } | undefined;
  const lastKnownPlanReport = (): ContextReportItem | undefined => {
    const known = currentUsageReport();
    if (!known) return undefined;
    if (knownAsReport?.source !== known) knownAsReport = { source: known, item: { id: "context:last-known", type: "context_report", createdAt: known.reportedAt, total: 0, plan: known.plan } };
    return knownAsReport.item;
  };
  const syncPlanUsage = (standing: RateLimitStanding | undefined) => {
    if (!planUsage || !planUsageSummary) return;
    const own = projection && declares("context") ? latestPlanReport(projection.items) : undefined;
    // The newer of the conversation's own report and the workspace's
    // last-known one: a reopened conversation, or one with only a standing,
    // still shows the windows (spec), and a read that went through another
    // session still answers the conversation that asked. The totals stay
    // the conversation's own.
    const known = declares("usage") ? lastKnownPlanReport() : undefined;
    const report = own && (!known || own.createdAt >= known.createdAt) ? own : known ?? own;
    const plan = report?.plan;
    // The conversation's totals: the report's own where the agent tallies
    // them (Claude Code), else folded from the priced usage carriers
    // (OpenCode). Either way the chip and the block below read one figure.
    const totals = projection && declares("context") ? resolveSessionTotals(projection.items) : undefined;
    // One chip for the plan and the standing together. It can be shown for
    // a standing alone, so a login with no plan is not left with nowhere to
    // say it is rate limited.
    const chip = planChip(report || totals ? { ...(plan ? { plan } : {}), ...(totals ? { session: totals } : {}) } : undefined, standing);
    planUsage.hidden = !chip;
    if (!chip) {
      planUsage.open = false;
      paintedPlanReport = undefined;
      paintedTotalsKey = undefined;
      paintedStanding = undefined;
      // An empty plan still tells the pane something: this login has none.
      if (report?.plan) noteUsageReport({ plan: report.plan, reportedAt: report.createdAt });
      return;
    }
    const hasWindows = Boolean(plan && planHasRows(plan));
    planUsageSummary.textContent = chip.text;
    planUsage.dataset.level = chip.level;
    planUsage.dataset.summary = chip.kind;
    // The standing is repainted on its own, not only when the report moves:
    // a rate limit can begin and end without the login reporting a window.
    // The reset is part of the key, not just the message and level: a
    // rolling window restates one standing with a later reset, and the chip
    // above already shows it — an early return here would leave the opened
    // readout contradicting the chip that opened it.
    const sameStanding = standing?.message === paintedStanding?.message
      && standing?.level === paintedStanding?.level
      && standing?.resetsAt === paintedStanding?.resetsAt;
    // Folded totals are a fresh object per fold, so they are keyed by what
    // they say: a restated carrier that moved the cost repaints, one that
    // did not is a no-op.
    const totalsKey = totals ? JSON.stringify([totals.costUsd, totals.models, totals.receipt?.lines]) : undefined;
    if (report === paintedPlanReport && totalsKey === paintedTotalsKey && sameStanding) return;
    paintedPlanReport = report;
    paintedTotalsKey = totalsKey;
    paintedStanding = standing;
    if (planReadoutStanding) {
      planReadoutStanding.hidden = !standing;
      planReadoutStanding.textContent = standing ? standingSentence(standing) : "";
    }
    const name = plan ? planName(plan) : undefined;
    if (planReadoutHead) planReadoutHead.hidden = !hasWindows;
    if (planReadoutRowsElement) planReadoutRowsElement.hidden = !hasWindows;
    planReadout?.setAttribute("aria-label", hasWindows ? "Plan usage" : standing ? "Rate limit" : "This conversation's usage");
    if (planReadoutName) planReadoutName.textContent = name ?? "Plan usage";
    planSummaryBaseTitle = hasWindows
      ? `${name ?? "Plan usage"} · open for every window and its reset`
      : standing
        ? "Open for what the login reported and when it resets"
        : "This login reports no plan limits · open for this conversation's cost and per-model usage";
    planUsageSummary.title = planSummaryBaseTitle;
    paintPlanRows();
    paintPlanSession(totals, projection?.items ?? []);
    if (own?.plan) noteUsageReport({ plan: own.plan, reportedAt: own.createdAt });
  };
  // The read time and its age beside the plan name, and the stale mark on
  // the readout and the chip; repainted with the rows so the age moves.
  const paintPlanAge = () => {
    const readAt = paintedPlanReport?.createdAt;
    const hasPlan = Boolean(paintedPlanReport?.plan && planHasRows(paintedPlanReport.plan));
    if (planReadoutAge) planReadoutAge.textContent = hasPlan && readAt !== undefined ? usageAsOf(readAt) : "";
    const stale = hasPlan && readAt !== undefined && usageStale(readAt);
    if (planUsage) {
      if (stale) planUsage.dataset.stale = "true"; else delete planUsage.dataset.stale;
      if (planUsageSummary) planUsageSummary.title = stale && readAt !== undefined ? `${planSummaryBaseTitle} · read ${usageAsOf(readAt).replace(/^as of /, "")}` : planSummaryBaseTitle;
    }
  };
  let planSummaryBaseTitle = "";
  // "Read now" and the read's state line: shown only for an agent that
  // reports plan usage, disabled and relabelled while a read is out.
  const paintPlanReadControls = () => {
    const state = usageReadState();
    if (planRead) {
      planRead.hidden = !declares("usage") || !usageReadable();
      planRead.disabled = state.reading;
      planRead.textContent = state.reading ? "Reading…" : "Read now";
    }
    if (planReadoutStatus) {
      const text = declares("usage") ? readStatusText(state) : undefined;
      planReadoutStatus.hidden = !text;
      planReadoutStatus.textContent = text ?? "";
    }
  };
  onUsageChange(() => {
    paintPlanReadControls();
    // A fresh report from the read (or from any conversation) is a new
    // last-known plan: a conversation reading through it repaints.
    syncPlanUsage(paintedStanding);
  });
  planRead?.addEventListener("click", () => { void readUsageNow("start"); });
  initUsagePaneControls();
  planUsage?.addEventListener("toggle", () => {
    if (planUsage.open) {
      syncPlanPin();
      paintPlanRows();
      // A stale report refreshes through a session that is already up;
      // nothing is started for an unasked read (spec).
      if (declares("usage")) refreshUsageIfStale();
      if (planTick === undefined) planTick = setInterval(paintPlanRows, 60_000);
    } else if (planTick !== undefined) {
      clearInterval(planTick);
      planTick = undefined;
    }
  });
  planPin?.addEventListener("click", () => {
    if (revealUsagePane()) syncPlanPin();
  });
  // The pin's conditions move under an open readout: the sidebar collapses
  // or expands, the layout flips to touch and back, the pane is hidden or
  // shown from its own chrome or the panels menu. Each is a DOM stamp its
  // owner writes (sidebar/shell, shell/ui-mode, sidebar/panes), so the pin
  // watches the stamps rather than subscribing to three owners.
  const planPinObserver = new MutationObserver(() => {
    if (planUsage?.open) syncPlanPin();
  });
  planPinObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-ui-mode"] });
  const appShell = document.querySelector(".app-shell");
  if (appShell) planPinObserver.observe(appShell, { attributes: true, attributeFilter: ["class"] });
  const usagePaneSection = document.querySelector('.sidebar-pane[data-pane-id="usage"]');
  if (usagePaneSection) planPinObserver.observe(usagePaneSection, { attributes: true, attributeFilter: ["hidden", "class"] });

  const syncRoutineStatus = (announceEvent = false) => {
    const conversationStatus = projection?.status;
    const { stateName, label } = composerRoutineState({
      status: conversationStatus,
      statusMessage: projection ? statusMessages.get(projection.conversationId) : undefined,
      cancelling,
      submitting: composer.submitting,
      backgroundDeclared: declares("background-tasks"),
      backgroundTasks: runningBackgroundTasks(projection?.items ?? []),
      scheduledDeclared: declares("scheduled-wakeups"),
      scheduledWakeups: pendingWakeups(projection?.items ?? []),
    });
    // The rate-limit standing and plan utilization ride beside the status as
    // one chip, from the standing / report the timeline holds (D11, spec).
    const limit = projection ? latestRateLimit(projection.items) : undefined;
    syncPlanUsage(limit);
    // Spoken only on a transition of THIS conversation's standing:
    // beginning, hardening, or being retired. With no conversation in hand
    // there is no standing to have changed, so nothing is said.
    if (rateLimitLive) {
      // The region describes one conversation. When the selection moves it
      // is emptied, so it cannot go on stating the standing of the
      // conversation the reader has left — an unlimited conversation would
      // otherwise carry the previous one's warning in the accessibility
      // tree. Emptying is not the same as clearing: it announces nothing
      // and claims nothing about the incoming conversation, which is why it
      // is not routed through the transition below.
      if (liveStandingConversation !== projection?.conversationId) {
        liveStandingConversation = projection?.conversationId;
        rateLimitLive.textContent = "";
      }
    }
    if (rateLimitLive && projection) {
      const previous = announcedStandings.get(projection.conversationId);
      if (limit?.level !== previous) {
        // What is spoken is still the full standing with its reset — the
        // figure is worth hearing when the level moves, just not on every
        // request. A standing that ended is worth saying too: the reader
        // was told it began, and the chip is about to go quiet.
        rateLimitLive.textContent = limit
          ? standingSentence(limit)
          : previous ? "Rate limit cleared; requests are allowed again." : "";
        boundedSet(announcedStandings, projection.conversationId, limit?.level, ANNOUNCED_STANDING_LIMIT);
      }
    }
    if (composerChips) composerChips.hidden = planUsage?.hidden ?? true;
    composerStatus.dataset.state = stateName;
    composerStatus.setAttribute("aria-label", label);
    composerStatus.title = stateName === "working" ? workingText() : label;
    const announcement = composerNote ?? label;
    if (announceEvent || announcement !== lastRoutineAnnouncement) {
      lastRoutineAnnouncement = announcement;
      composerStatusLive.textContent = announcement;
    }
  };

  // Use the same canonical occurrences as Workers, including foreground agents.
  // Unknown workers remain inspectable, but are not confirmed live work.
  const hasLiveWorkers = () => declares("background-blocking-work")
    && compactWorkers(projection?.items ?? []).some(worker => worker.state === "working");
  const syncControls = () => {
    const status = projection?.status ?? null;
    if (status !== lastStatus) {
      composerNote = null;
      lastStatus = status;
    }
    const running = isLiveConversationStatus(projection?.status);
    if (projection && running && presentation.workingSince[projection.conversationId] === undefined) {
      const latestUserMessage = [...projection.items].reverse().find(item => item.type === "user_message");
      presentation.workingSince[projection.conversationId] = latestUserMessage?.createdAt ?? Date.now();
      save();
    }
    if (projection && !running && presentation.workingSince[projection.conversationId] !== undefined) {
      delete presentation.workingSince[projection.conversationId];
      save();
    }
    syncWorkingTimer();
    // A message needs content, not necessarily words: pending attachments make
    // an empty draft sendable (image-only prompts are accepted end to end),
    // and an upload still in flight counts — submission waits for it.
    const activeId = activeConversationId();
    const openAside = document.querySelector<HTMLDialogElement>("#chat-aside-dialog[open]");
    if (openAside && openAside.dataset.conversation !== activeId) minimiseAside("switch");
    const asideButton = document.querySelector<HTMLButtonElement>("#chat-aside-ready");
    if (asideButton) {
      asideButton.hidden = !activeId || !composer.sideAnswer(activeId) && !composer.sideGenerating(activeId);
      asideButton.disabled = !projection || Boolean(activeId && composer.sideGenerating(activeId));
      asideButton.textContent = activeId && composer.sideGenerating(activeId) ? "Side answer…" : activeId && composer.sideAnswer(activeId)?.failed ? "Side question failed" : "Side answer ready";
    }
    const hasContent = Boolean(input.value.trim()) || currentPendingAttachments().length > 0
      || (activeId !== null && composer.uploading(activeId));
    // Initial openings wait for a snapshot. After failure, keep that
    // conversation's private draft editable through explicit read retries.
    input.disabled = !projection && (!activeId || failedOpeningConversationId !== activeId);
    send.disabled = composer.submitting || cancelling || !projection || !hasContent;
    if (stop) {
      stop.disabled = cancelling || !projection || !running;
      const workers = hasLiveWorkers();
      stop.classList.toggle("has-worker-scope", declares("background-blocking-work"));
      stop.setAttribute("aria-label", workers ? "Stop parent" : "Stop response");
      stop.textContent = workers ? "Stop parent" : "Stop";
      stop.title = workers ? "Stop the parent and still-blocking work. Detached workers continue; their later notifications can wake the parent again." : "Stop";
    }
    if (actionFeedback) {
      const note = activeId ? composer.feedback(activeId) : "";
      actionFeedback.hidden = !note;
      if (actionFeedback.textContent !== note) actionFeedback.textContent = note;
    }
    syncSendDescription();
    syncConfigurationScope();
    sendGroup?.toggleAttribute("data-steering", declares("steering"));
    configurationTrigger.disabled = composer.submitting || !projection || catalogLoading;
    configurationTrigger.toggleAttribute("aria-busy", catalogLoading);
    if (renameButton) renameButton.disabled = !projection || selectedConversationDeleted;
    syncHistoryControls();
    olderButton.hidden = !projection?.olderCursor;
    syncRoutineStatus();
  };

  const noteComposer = (message: string | null, announceEvent = false) => {
    composerNote = message;
    // Explicit successful mutations are events, even when their words repeat.
    // Routine paints still deduplicate against the resulting current note.
    syncRoutineStatus(announceEvent);
  };

  const displayedConfiguration = (): ConversationConfiguration => {
    if (!projection) return {};
    const staged = stagedConfigurations.get(projection.conversationId);
    const configuration = { ...projection.configuration, ...staged };
    if (staged?.model && projection.configuration?.model && !sameModel(staged.model, projection.configuration.model) && staged.variant === undefined) {
      delete configuration.variant;
    }
    return configuration;
  };

  const syncConfigurationScope = () => {
    // A held submission can commit conversation configuration before the
    // running turn ends. These controls describe future turns, not evidence
    // of the active turn's settings, even after the local stage is consumed.
    const nextTurn = declares("steering") && (deliveryChoiceOffered() || projection?.reversibleHistory?.staged === true);
    const staged = projection && stagedConfigurations.get(projection.conversationId);
    const effective = projection?.configuration;
    const changed = nextTurn && Boolean(staged && (
      staged.model && (!effective?.model || !sameModel(staged.model, effective.model))
      || staged.mode && staged.mode !== effective?.mode
      || staged.variant && staged.variant !== effective?.variant
    ));
    const prefix = nextTurn ? "Next turn · " : "";
    configurationSummary.textContent = prefix + configurationLabels.summary;
    const inline = document.querySelector<HTMLElement>("#chat-inline-configuration");
    if (inline) {
      inline.textContent = prefix + configurationLabels.inline;
      inline.title = [agent?.name, inline.textContent].filter(Boolean).join(" · ");
    }
    configurationTrigger.setAttribute("aria-label", configurationLabels.accessible.length
      ? `Chat configuration. ${nextTurn ? "Next turn. " : ""}${configurationLabels.accessible.join(". ")}`
      : "Chat settings");
    const notice = document.querySelector<HTMLElement>("#chat-configuration-scope");
    if (notice) notice.hidden = !changed;
    configurationTrigger.setAttribute("aria-describedby", `chat-inline-context${changed ? " chat-configuration-scope" : ""}`);
    send.setAttribute("aria-describedby", `chat-send-help${changed ? " chat-configuration-scope" : ""}`);
  };

  const setStagedConfiguration = (conversationId: string, configuration: ConversationConfiguration) => {
    if (configuration.model || configuration.mode || configuration.variant) stagedConfigurations.set(conversationId, configuration);
    else stagedConfigurations.delete(conversationId);
  };

  // A default entry is named by what it runs: "Default · Opus (1M context)"
  // rather than an opaque "Default (recommended)" — by its id when it runs a
  // model no entry offers (a settings-selected id the catalog omits).
  const modelChipName = (model: ChatModel): string => {
    if (model.default && model.resolvesTo) {
      const resolved = models.find(candidate => sameModel(candidate.selection, model.resolvesTo!));
      return `Default · ${resolved ? resolved.name : model.resolvesTo.modelId}`;
    }
    return model.name;
  };

  const renderConfiguration = () => {
    const configuration = displayedConfiguration();
    // An agent may declare its own recommended defaults; while nothing is
    // chosen they ARE the active choice, exactly as the agent presents it.
    const defaultModel = models.find(model => model.default);
    const defaultMode = modes.find(mode => mode.default);
    const displayedModel = configuration.model
      ? models.find(model => sameModel(model.selection, configuration.model!))
      : defaultModel;
    configurationLabels.summary = declares("models")
      ? (displayedModel ? modelChipName(displayedModel) : configuration.model ? `${configuration.model.providerId}/${configuration.model.modelId}` : `Let ${agent?.name ?? "OpenCode"} choose`)
      : "Chat settings";
    const offersMode = declares("modes") && modes.length > 0;
    const offersReasoning = declares("variants") && Boolean(displayedModel?.variants?.length);
    // The chip states the selected value, or a default the agent declares.
    // Steering keeps these choices for future turns. A delegation without a
    // declared default is said once in the dialog ("Let ... choose"), not echoed here.
    const displayedMode = configuration.mode ?? defaultMode?.name;
    configurationLabels.inline = [displayedMode ? configurationOptionLabel(displayedMode) : agent?.name,
      declares("models") ? configurationLabels.summary : undefined,
      configuration.variant ? configurationOptionLabel(configuration.variant) : undefined].filter(Boolean).join(" · ");
    const showMode = offersMode && Boolean(displayedMode);
    const showReasoning = offersReasoning && Boolean(configuration.variant);
    configurationModeSummary.hidden = !showMode;
    configurationModeSummary.textContent = showMode ? configurationOptionLabel(displayedMode!) : "";
    configurationVariantSummary.hidden = !showReasoning;
    configurationVariantValue.textContent = showReasoning ? configurationOptionLabel(configuration.variant!) : "";
    configurationDetails.hidden = !showMode && !showReasoning;
    configurationLabels.accessible = [
      // An unlisted selection is the user's own typed id under an agent that
      // runs them; only elsewhere is it a model that went away.
      declares("models") ? `Model: ${displayedModel ? modelChipName(displayedModel) : configuration.model ? (declares("custom-model-id") ? `${configuration.model.modelId}, typed` : `${configuration.model.providerId}/${configuration.model.modelId}, unavailable`) : `chosen by ${agent?.name ?? "the agent"}`}` : "",
      offersMode ? `Mode: ${displayedMode ? configurationOptionLabel(displayedMode) : `chosen by ${agent?.name ?? "the agent"}`}` : "",
      offersReasoning ? `Reasoning: ${configuration.variant ? configurationOptionLabel(configuration.variant) : `chosen by ${agent?.name ?? "the agent"}`}` : "",
    ].filter(Boolean);
    configurationPicker?.update({
      agent,
      models,
      modes,
      configuration,
      // An empty list with no usable login says why, and how to fix it.
      ...(models.length === 0 && contextLoginState() === "missing" ? { emptyNotice: { message: "No provider is logged in.", action: contextLoginAction() } } : {}),
    });
    syncAttachControl();
    syncControls();
  };

  const newConversationAnnouncement = (configuration: ConversationConfiguration): string => {
    // Declared defaults ARE the active choice for an unset value, same
    // story renderConfiguration tells.
    const displayedModel = configuration.model
      ? models.find(model => sameModel(model.selection, configuration.model!))
      : models.find(model => model.default);
    const displayedMode = configuration.mode ?? modes.find(mode => mode.default)?.name;
    const chooser = agent?.name ?? "the agent";
    return [
      `Started new conversation${agent ? ` with ${agent.name}` : ""}.`,
      declares("models")
        ? `Model: ${displayedModel ? modelChipName(displayedModel) : configuration.model ? `${configuration.model.providerId}/${configuration.model.modelId}` : `chosen by ${chooser}`}.`
        : "",
      declares("modes") && modes.length > 0
        ? `Mode: ${displayedMode ? configurationOptionLabel(displayedMode) : `chosen by ${chooser}`}.`
        : "",
    ].filter(Boolean).join(" ");
  };

  const stopConversationRefreshRecovery = () => {
    const recovery = conversationRefreshRecovery;
    conversationRefreshRecovery = null;
    if (!recovery) return;
    if (recovery.timer !== null) clearTimeout(recovery.timer);
    recovery.wake?.();
  };

  const recoverSelectedConversation = (id: string) => {
    const token = selectionGeneration;
    if (activeConversationId() !== id) return;
    if (conversationRefreshRecovery?.conversationId === id && conversationRefreshRecovery.token === token) return;
    stopConversationRefreshRecovery();
    const recovery: ConversationRefreshRecovery = {
      conversationId: id,
      token,
      delayMs: REFRESH_RETRY_INITIAL_MS,
      timer: null,
      wake: null,
    };
    conversationRefreshRecovery = recovery;
    void (async () => {
      while (conversationRefreshRecovery === recovery && selectionGeneration === token && activeConversationId() === id) {
        if (await refreshSelectedConversation(id)) return;
        if (conversationRefreshRecovery !== recovery || selectionGeneration !== token || activeConversationId() !== id) return;
        await new Promise<void>(resolve => {
          recovery.wake = () => {
            recovery.wake = null;
            resolve();
          };
          recovery.timer = setTimeout(() => {
            recovery.timer = null;
            recovery.wake?.();
          }, recovery.delayMs);
        });
        recovery.delayMs = Math.min(recovery.delayMs * 2, REFRESH_RETRY_MAX_MS);
      }
    })().finally(() => {
      if (conversationRefreshRecovery === recovery) stopConversationRefreshRecovery();
    });
  };

  const installConversationSnapshot = (snapshot: ConversationSnapshot, acceptedDrafts: ChatProjection["acceptedDrafts"], token: number) => {
    projection = composer.acceptSnapshot(snapshot, acceptedDrafts);
    const carried = removedRows.get(snapshot.conversation.id);
    if (carried) projection = { ...projection, removedIds: carried };
    projectionEpoch += 1;
    conversations = conversations.map(item => item.id === snapshot.conversation.id ? snapshot.conversation : item);
    renderConfiguration();
    renderAttachments();
    announce(snapshot.items.length ? "" : "Start this conversation by sending a message.");
    cancelForSnapshot(parentScroll);
    anchor.restore(presentation.anchors[snapshot.conversation.id] ?? null);
    scheduleRender(false, false);
    stream = openConversationStream(snapshot.conversation.id, snapshot.cursor, token);
  };

  // Subscribes to the selected conversation's events from a cursor — a topic
  // on the page's one live stream, never a connection of its own. A
  // lifecycle wake-up does not come back here: the channel reconnects and
  // resumes this topic from the cursor it holds, so the timeline, its scroll
  // anchor, and the composer draft stay exactly as the user left them.
  const openConversationStream = (
    conversationId: string,
    cursor: string,
    token: number,
  ): ChatEventStream =>
    api.stream(conversationId, cursor, {
      event: (event, cursor) => {
        if (!projection || token !== selectionGeneration) return;
        const result = applyChatEvent(projection, event, cursor);
        if (result.outcome === "gap" || result.outcome === "resync") {
          recoverSelectedConversation(conversationId);
          return;
        }
        projection = result.projection;
        composer.observe(event, result.outcome === "applied");
        if (projection.removedIds) removedRows.set(conversationId, projection.removedIds);
        if (event.type === "conversation.configuration") renderConfiguration();
        if (event.type === "conversation.status") {
          if (event.status === "failed") setComposerError(event.message || "The active turn failed.");
          else if (isLiveConversationStatus(event.status)) setComposerError(null);
          statusMessages.set(conversationId, event.message);
        }
        if (event.type === "conversation.updated") {
          conversations = conversations.map(conversation => conversation.id === event.conversation.id ? event.conversation : conversation);
          relabelConversationOption(event.conversation);
          if (chatTitle) chatTitle.textContent = displayConversationTitle(event.conversation);
          if (renameInput && renameForm && !renameForm.hidden && document.activeElement !== renameInput) renameInput.value = event.conversation.title;
        }
        if (result.outcome === "applied") {
          announce("");
          scheduleRender(true, true, event.type === "item.text_delta" || (event.type === "item.upsert" && event.item.type === "assistant_message" && event.item.completedAt === undefined && isLiveConversationStatus(projection.status)));
        }
      },
      resync: () => {
        if (token !== selectionGeneration) return;
        if (!composer.historyResync(conversationId)) recoverSelectedConversation(conversationId);
      },
      error: error => { if (token === selectionGeneration) interruptions.report("conversation", error); },
      // Transport is healthy again. Cursor replay and `resync` still own
      // whether the projection is correct, so this clears the reconnect
      // message and nothing else — no refetch, no reprojection.
      recovered: () => { if (token === selectionGeneration) interruptions.clear("conversation"); },
    });

  async function refreshSelectedConversation(id: string, pendingEntry?: { id: string; action: PendingQueueAction }): Promise<boolean> {
    const token = selectionGeneration;
    const current = projection;
    if (!current || current.conversationId !== id || activeConversationId() !== id) return false;
    try {
      return await runConversationRead("Updating conversation...", () => { void refreshSelectedConversation(id, pendingEntry); }, async signal => {
        let snapshot = await api.snapshot(id, undefined, signal);
        if (signal.aborted || token !== selectionGeneration || projection?.conversationId !== id || activeConversationId() !== id) return false;
        snapshot = composer.checkedSnapshot(id, snapshot, pendingEntry);
        const previousStream = stream;
        installConversationSnapshot(snapshot, projection.acceptedDrafts, token);
        if (conversationRefreshRecovery?.conversationId === id && conversationRefreshRecovery.token === token) {
          stopConversationRefreshRecovery();
        }
        previousStream?.close();
        return true;
      });
    } catch (error) {
      return false;
    }
  }

  const selectConversation = async (id: string, deferredStartup = false): Promise<boolean> => {
    const openingStartup = deferredStartup || isUnestablishedStartup(id);
    supersedeStartupSelection();
    hasSelectedConversation = true;
    if (failedOpeningConversationId !== id) failedOpeningConversationId = null;
    if (projection?.conversationId === id && stream && !composer.needsHistoryRefresh(id) && !selectedConversationDeleted) return true;
    // Navigation ends the outgoing hold before a fast snapshot can arrive
    // ahead of its clearing paint. Only an in-place refresh may renew it;
    // otherwise removing A's field could resume A's follow intent over B.
    parentScroll.cancel();
    renderer.closeShellOutputWindow();
    childRenderer.closeShellOutputWindow();
    readLane?.controller.abort();
    stopConversationRefreshRecovery();
    selectedConversationDeleted = false;
    renderSelectedConversationDeleted(document, false);
    // Choosing a conversation is leaving whatever turn was being drilled into:
    // the drill-down is a view over the parent, and the parent is changing.
    closeChildConversation();
    if (renameForm) renameForm.hidden = true;
    const token = ++selectionGeneration;
    unestablishedStartup = openingStartup ? { conversationId: id, generation: token } : null;
    stream?.close();
    stream = null;
    const acceptedDrafts = projection?.conversationId === id ? projection.acceptedDrafts : composer.acceptedDrafts(id);
    if (projection) {
      presentation.drafts[projection.conversationId] = input.value;
      const currentAnchor = anchor.currentAnchor();
      if (currentAnchor) presentation.anchors[projection.conversationId] = currentAnchor;
    }
    presentation.selectedId = id;
    if (window.location && new URLSearchParams(window.location.search).has("conversation")) {
      const url = new URL(window.location.href);
      url.searchParams.set("conversation", id);
      window.history.replaceState(window.history.state, "", url);
    }
    const conversation = conversations.find(item => item.id === id);
    if (chatTitle) chatTitle.textContent = conversation ? displayConversationTitle(conversation) : chatHeading();
    form.hidden = false;
    // The identity row, capabilities, and catalogs follow the selected
    // conversation's owning agent (spec: the identity row follows the
    // conversation). Remember the choice as the next creation's default.
    const owningAgentId = conversationAgentId(id);
    if (owningAgentId && owningAgentId !== contextAgentId) {
      void applyAgentContext(owningAgentId);
    }
    if (owningAgentId) {
      presentation.lastAgentId = owningAgentId;
      const state = agentStatusFor(owningAgentId)?.availability.state;
      if (state === "idle" || state === "starting") refreshIdleAgentContext();
    }
    save();
    projection = null;
    scheduleRender(false, false);
    // Not a clear: the incoming conversation may hold a refusal that landed
    // while it was deselected, and it surfaces now.
    showComposerError(composerErrors.get(id) ?? null);
    renderConfiguration();
    syncContextIndicator();
    input.value = presentation.drafts[id] ?? "";
    slashQueryActive = false;
    autosize(input);
    renderAttachments();
    announce("");
    syncControls();
    try {
      return await runConversationRead("Loading conversation...", () => { void selectConversation(id); }, async signal => {
        const snapshot = await api.snapshot(id, undefined, signal);
        if (token !== selectionGeneration) return false;
        installConversationSnapshot(snapshot, acceptedDrafts, token);
        failedOpeningConversationId = null;
        unestablishedStartup = null;
        // The selection is settled; a ready agent stops polling, so this is
        // the moment mid-session command discoveries reach the completion
        // menu (background, after the chooser is done).
        refreshBankedCommands(conversationAgentId(id));
        return true;
      });
    } catch (error) {
      if (token === selectionGeneration && presentation.selectedId === id) {
        failedOpeningConversationId = id;
        syncControls();
      }
      return false;
    }
  };

  // One chooser label for every path that writes it: the title, the owning
  // agent when there is a choice of agents, and the last activity's clock
  // time (its day is the option's heading).
  const conversationOptionLabel = (conversation: ConversationSummary) => {
    const title = agentStatuses.length > 1 && conversation.agent
      ? `${displayConversationTitle(conversation)} · ${conversation.agent.name}`
      : displayConversationTitle(conversation);
    return `${title}${conversationActivitySuffix(conversation)}`;
  };
  const relabelConversationOption = (conversation: ConversationSummary) => {
    const option = Array.from(select.options).find(candidate => candidate.value === conversation.id);
    if (option) option.text = conversationOptionLabel(conversation);
  };
  // "Today" becomes "Yesterday" at the reader's midnight without any
  // inventory change, so the headings are refiled then.
  let chooserDayTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleChooserDayRollover = () => {
    if (chooserDayTimer !== undefined) clearTimeout(chooserDayTimer);
    const now = Date.now();
    chooserDayTimer = setTimeout(() => {
      chooserDayTimer = undefined;
      patchConversationOptions(select, conversations, conversationOptionLabel, conversationDayGroup);
      scheduleChooserDayRollover();
    }, nextLocalMidnight(now) - now + 1_000);
  };

  const patchChooser = (selectedId: string | null, deleted = false) => {
    renderSelectedConversationDeleted(document, deleted);
    // Keep only the unresolved startup selection across a transient omission;
    // all other options must continue to reflect the latest inventory.
    const retainedStartupOption = isUnestablishedStartup(selectedId)
      && selectedId && !conversations.some(conversation => conversation.id === selectedId)
      ? Array.from(select.options).find(option => option.value === selectedId)
      : undefined;
    patchConversationOptions(select, conversations, conversationOptionLabel, conversationDayGroup);
    scheduleChooserDayRollover();
    if (retainedStartupOption) select.append(retainedStartupOption);
    const genericPlaceholder = select.querySelector<HTMLOptionElement>("option[data-chat-inventory-placeholder]");
    if (deleted || selectedId) {
      genericPlaceholder?.remove();
    } else {
      const placeholder = genericPlaceholder ?? document.createElement("option");
      placeholder.setAttribute("data-chat-inventory-placeholder", "");
      placeholder.value = "";
      placeholder.disabled = true;
      placeholder.textContent = conversations.length === 0 ? "No conversations" : "Select a conversation";
      if (!genericPlaceholder) select.prepend(placeholder);
    }
    if (deleted) {
      select.value = "";
      select.disabled = false;
    } else {
      select.value = selectedId ?? "";
      select.disabled = conversations.length === 0 && !retainedStartupOption;
    }
  };

  const installInitialChooser = () => {
    if (awaitingAnswered) {
      // Nothing waits any more: show the list, not some other conversation
      // dressed up as the one the notice pointed at.
      awaitingAnswered = false;
      patchChooser(null);
      form.hidden = true;
      if (chatTitle) chatTitle.textContent = chatHeading();
      announce("That request was already answered.");
      return;
    }
    if (notificationTarget) {
      const target = notificationTarget;
      notificationTarget = null;
      patchChooser(target);
      void selectConversation(target);
      return;
    }
    const selected = conversations.some(item => item.id === presentation.selectedId)
      ? presentation.selectedId!
      : conversations[0]?.id ?? null;
    patchChooser(selected);
    if (!selected) {
      if (startupOwnsSelection) pendingStartupId = presentation.selectedId ?? null;
      form.hidden = true;
      if (chatTitle) chatTitle.textContent = chatHeading();
      return;
    }
    void selectConversation(selected);
  };

  const acknowledgeInventory = () => {
    if (!inventoryTracker.acknowledge()) return;
    syncInventoryAwareness();
  };
  document.querySelector<HTMLButtonElement>("#chat-conversation-unseen-count")
    ?.addEventListener("click", acknowledgeInventory);
  select.addEventListener("pointerdown", event => {
    if (event.button === 0) acknowledgeInventory();
  });
  select.addEventListener("keydown", event => {
    if (isConversationChooserActivationKey(event)) acknowledgeInventory();
  });
  select.addEventListener("change", () => {
    if (!select.value) return;
    if (inventoryTracker.isUnseen(select.value)) acknowledgeInventory();
    void selectConversation(select.value);
  });

  const enterSelectedConversationDeleted = () => {
    if (selectedConversationDeleted) return;
    stopConversationRefreshRecovery();
    selectedConversationDeleted = true;
    const selectedId = presentation.selectedId;
    if (selectedId) {
      presentation.drafts[selectedId] = input.value;
      if (projection?.conversationId === selectedId) {
        const currentAnchor = anchor.currentAnchor();
        if (currentAnchor) presentation.anchors[selectedId] = currentAnchor;
      }
    }
    // The projection remains in memory so its draft, attachments,
    // configuration, and active turn survive until an explicit selection.
    // Its stream and any snapshot callbacks can no longer mutate it.
    selectionGeneration += 1;
    stream?.close();
    stream = null;
    save();
  };

  const applyConversationInventory = (next: ConversationSummary[]) => {
    const tracked = inventoryTracker.reconcile(next);
    // Consume before starting any asynchronous read. Inventory is discovery,
    // not a retry mechanism for a failed opening read.
    if (pendingStartupId && startupOwnsSelection && next.some(item => item.id === pendingStartupId)) {
      const id = pendingStartupId;
      pendingStartupId = null;
      conversations = next;
      patchChooser(id);
      void selectConversation(id, true);
      syncInventoryAwareness(tracked.increased);
      syncControls();
      save();
      return;
    }
    const selectedId = hasSelectedConversation ? presentation.selectedId ?? null : null;
    const selectedMissing = selectedId !== null && !next.some(conversation => conversation.id === selectedId);
    // A transient omission cannot invalidate this one-shot read or turn its
    // failure into an automatic retry. Preserve its chooser and draft too.
    const startupOpeningMissing = selectedMissing && isUnestablishedStartup(selectedId);
    if (selectedMissing && !startupOpeningMissing) enterSelectedConversationDeleted();

    // The successful response replaces inventory truth. It does not install a
    // snapshot or touch the selected projection unless an unavailable
    // selection has returned and needs its stream restored.
    conversations = next;
    const selectedConversation = selectedId ? next.find(conversation => conversation.id === selectedId) : undefined;
    if (selectedConversation && projection?.conversationId === selectedId) {
      projection = { ...projection, conversation: selectedConversation };
      if (chatTitle) chatTitle.textContent = displayConversationTitle(selectedConversation);
    }
    if (selectedConversationDeleted && selectedConversation && selectedId) {
      selectedConversationDeleted = false;
      patchChooser(selectedId);
      void selectConversation(selectedId);
    } else if (selectedConversationDeleted) patchChooser(null, true);
    else patchChooser(selectedId);
    syncInventoryAwareness(tracked.increased);
    syncControls();
    save();
  };

  const inventoryReconciler = new SerializedInventoryReconciler(
    () => api.conversations(),
    applyConversationInventory,
    error => announce(messageOf(error), true),
  );

  const stageModel = (selection: ModelSelection | undefined) => {
    if (!projection) return;
    const staged = { ...stagedConfigurations.get(projection.conversationId) };
    const effective = (model: ModelSelection | undefined) => model ?? models.find(candidate => candidate.default)?.selection;
    const before = effective(staged.model ?? projection.configuration?.model);
    if (!selection || (projection.configuration?.model && sameModel(selection, projection.configuration.model))) delete staged.model;
    else staged.model = selection;
    const after = effective(staged.model ?? projection.configuration?.model);
    // A staged effort survives a selection that lands on the same effective
    // model (re-clicking the active Default row); a real switch clears it.
    if (!(before && after && sameModel(before, after))) delete staged.variant;
    setStagedConfiguration(projection.conversationId, staged);
    renderConfiguration();
    syncContextIndicator();
  };
  const stageVariant = (name: string | undefined) => {
    if (!projection) return;
    const staged = { ...stagedConfigurations.get(projection.conversationId) };
    // The wire requires a model with a variant. With nothing chosen the
    // declared default IS the model in force: stage its selection
    // alongside, exactly what clicking the Default row commits.
    if (name && staged.model === undefined && projection.configuration?.model === undefined) {
      const defaultModel = models.find(model => model.default);
      if (defaultModel) staged.model = defaultModel.selection;
    }
    const displayedModel = staged.model ?? projection.configuration?.model;
    const effectiveModel = projection.configuration?.model;
    const effectiveModelApplies = displayedModel === undefined
      ? effectiveModel === undefined
      : effectiveModel !== undefined && sameModel(displayedModel, effectiveModel);
    if (!name || (effectiveModelApplies && name === projection.configuration?.variant)) delete staged.variant;
    else staged.variant = name;
    setStagedConfiguration(projection.conversationId, staged);
    renderConfiguration();
  };
  const stageMode = (name: string | undefined) => {
    if (!projection) return;
    if (name && !modes.some(mode => mode.name === name)) return;
    const staged = { ...stagedConfigurations.get(projection.conversationId) };
    if (!name || name === projection.configuration?.mode) delete staged.mode;
    else staged.mode = name;
    setStagedConfiguration(projection.conversationId, staged);
    renderConfiguration();
  };
  configurationPicker = createChatConfigurationPicker({
    dialog: configurationDialog,
    trigger: configurationTrigger,
    surface,
    search: configurationSearch,
    modelsSection: configurationModelsSection,
    models: configurationModels,
    resultStatus: configurationResultStatus,
    empty: configurationEmpty,
    done: configurationDone,
    modeSection: configurationModeSection ?? undefined,
    modeSelect: configurationMode ?? undefined,
    variantSection: configurationVariantSection ?? undefined,
    variantSelect: configurationVariant ?? undefined,
    touchInitialFocus: configurationDone,
  }, {
    onModel: stageModel,
    onMode: stageMode,
    onVariant: stageVariant,
  });
  configurationTrigger.addEventListener("click", () => {
    refreshCatalogsOnUse();
    configurationPicker?.open();
  });
  configurationTrigger.addEventListener("mousedown", event => keepTouchComposerFocus(event));
  renderConfiguration();
  // With one agent there is no choice to offer; with more, creation asks.
  // The menu shows every offered agent with its availability, so an
  // unavailable agent is explained rather than hidden; choosing it does not
  // create a conversation (spec: an unavailable agent is explained at
  // creation).
  const chooseAgentForCreation = (): Promise<string | undefined | null> => {
    if (agentStatuses.length <= 1) return Promise.resolve(agentStatuses[0]?.agent.id);
    return new Promise(resolve => {
      document.querySelector("#chat-agent-menu")?.remove();
      const menu = document.createElement("div");
      menu.id = "chat-agent-menu";
      menu.className = "chat-agent-menu";
      menu.setAttribute("role", "menu");
      const defaultId = agentStatusFor(presentation.lastAgentId)?.agent.id ?? agentStatuses[0]!.agent.id;
      const finish = (value: string | null) => {
        menu.remove();
        document.removeEventListener("pointerdown", onOutside, true);
        document.removeEventListener("keydown", onKey, true);
        resolve(value);
      };
      const onOutside = (event: Event) => {
        if (!menu.contains(event.target as Node)) finish(null);
      };
      const onKey = (event: KeyboardEvent) => {
        if (event.key === "Escape") finish(null);
      };
      for (const status of agentStatuses) {
        const unavailable = status.availability.state === "unavailable";
        const item = document.createElement("button");
        item.type = "button";
        item.className = "chat-agent-menu__item";
        item.setAttribute("role", "menuitem");
        item.dataset.agentId = status.agent.id;
        if (status.agent.id === defaultId) item.classList.add("is-default");
        if (unavailable) item.classList.add("is-unavailable");
        const name = document.createElement("span");
        name.textContent = status.agent.name;
        item.append(name);
        if (unavailable) {
          const note = document.createElement("span");
          note.className = "chat-agent-menu__note";
          note.textContent = status.availability.state === "unavailable" ? status.availability.message : "";
          item.append(note);
          item.setAttribute("aria-disabled", "true");
        }
        item.addEventListener("click", () => {
          if (unavailable) {
            // The menu entry may be the only access to an agent with no
            // conversations; choosing it presents the diagnosis and Retry
            // (spec: an unavailable agent is explained at creation, and
            // every failed agent is repairable from the page). The menu
            // stays open — the healthy agent remains one click away.
            if (status.availability.state === "unavailable") showUnavailable(status.agent.id, status.availability, { takeover: false });
            return;
          }
          finish(status.agent.id);
        });
        menu.append(item);
      }
      // Fixed positioning against the button: the header row is not a
      // positioning context, and the menu must not disturb its layout.
      const anchor = newButton.getBoundingClientRect();
      menu.style.position = "fixed";
      menu.style.top = `${Math.round(anchor.bottom + 4)}px`;
      menu.style.right = `${Math.round(Math.max(8, window.innerWidth - anchor.right))}px`;
      newButton.insertAdjacentElement("afterend", menu);
      menu.querySelector<HTMLButtonElement>(".chat-agent-menu__item.is-default")?.focus();
      document.addEventListener("pointerdown", onOutside, true);
      document.addEventListener("keydown", onKey, true);
    });
  };

  newButton.addEventListener("click", async () => {
    const chosenAgent = await chooseAgentForCreation();
    if (chosenAgent === null) return;
    supersedeStartupSelection();
    newButton.disabled = true;
    announce("Creating conversation...");
    try {
      const snapshot = await api.createConversation(chosenAgent);
      if (chosenAgent) presentation.lastAgentId = chosenAgent;
      if (projection) presentation.drafts[projection.conversationId] = input.value;
      // Record local identity before the provider's invalidation can reconcile
      // it back, so this page never announces its own selected creation.
      if (inventoryTracker.noteLocalCreation(snapshot.conversation.id)) syncInventoryAwareness();
      void inventoryReconciler.supersede();
      conversations = dedupeConversationInventory([snapshot.conversation, ...conversations]);
      presentation.selectedId = snapshot.conversation.id;
      selectedConversationDeleted = false;
      patchChooser(snapshot.conversation.id);
      if (await selectConversation(snapshot.conversation.id)) {
        input.focus();
        announce(newConversationAnnouncement(projection?.configuration ?? snapshot.configuration));
      }
    } catch (error) { announce(messageOf(error), true); }
    finally { newButton.disabled = false; }
  });

  renameButton?.addEventListener("click", () => {
    if (!projection || !renameForm || !renameInput || !declares("conversation-rename")) return;
    renameInput.value = projection.conversation?.title ?? "";
    renameForm.hidden = false;
    renameInput.focus();
    renameInput.select();
  });
  renameCancel?.addEventListener("click", () => {
    if (renameForm) renameForm.hidden = true;
    renameButton?.focus();
  });
  renameForm?.addEventListener("submit", async event => {
    event.preventDefault();
    if (!projection || !renameInput) return;
    const conversationId = projection.conversationId;
    const title = renameInput.value.trim();
    if (!title) {
      announce("Conversation title must not be empty", true);
      renameInput.focus();
      return;
    }
    if (new TextEncoder().encode(title).byteLength > 200) {
      announce("Conversation title must be at most 200 bytes", true);
      renameInput.focus();
      return;
    }
    const controls = renameForm.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input");
    controls.forEach(control => { control.disabled = true; });
    try {
      const { conversation } = await api.renameConversation(conversationId, newRequestId(), title);
      void inventoryReconciler.supersede();
      conversations = conversations.map(item => item.id === conversation.id ? conversation : item);
      relabelConversationOption(conversation);
      if (projection?.conversationId === conversation.id) {
        projection = { ...projection, conversation };
        if (chatTitle) chatTitle.textContent = displayConversationTitle(conversation);
      }
      renameForm.hidden = true;
      announce("");
      renameButton?.focus();
    } catch (error) {
      announce(messageOf(error), true);
      renameInput.focus();
    } finally {
      controls.forEach(control => { control.disabled = false; });
    }
  });

  // Keep the focused touch composer's chrome in place until activation.
  // Cancel mousedown's focus default, not pointerdown: WebKit suppresses
  // the compatibility click when a touch pointerdown is cancelled.
  const keepTouchComposerFocus = (event: MouseEvent) => {
    if (document.documentElement.dataset.uiMode === "touch" && document.activeElement === input) event.preventDefault();
  };
  document.querySelector("#chat-work-dock")?.addEventListener("mousedown", event => {
    if ((event.target as Element).closest("summary")) keepTouchComposerFocus(event as MouseEvent);
  });
  queueDockElement.addEventListener("mousedown", event => {
    if ((event.target as Element).closest(".chat-queued-action, [data-pending-toggle]")) keepTouchComposerFocus(event);
  });
  queueDockElement.addEventListener("click", async event => {
    if ((event.target as Element).closest("[data-pending-toggle]")) {
      const pane = queueDockElement.querySelector<HTMLElement>(".chat-queue-content");
      const open = compactPendingState.paint(projection?.conversationId ?? null, projection?.queued.length ?? 0,
        document.documentElement.dataset.uiMode === "touch" ? "touch" : "desktop");
      if (projection && open && pane?.clientHeight) {
        boundedSet(pendingScrollPositions, projection.conversationId, pane.scrollTop, 200);
      }
      compactPendingState.toggled(!open);
      scheduleRender();
      return;
    }
    const target = (event.target as Element).closest<HTMLButtonElement>("[data-queue-remove], [data-queue-edit], [data-queue-steer], [data-queue-queue], [data-queue-send-now], [data-queue-discard]");
    if (!target || target.disabled || !projection) return;
    const id = projection.conversationId;
    const { queueRemove, queueEdit, queueSteer, queueQueue, queueSendNow, queueDiscard } = target.dataset;
    const messageId = queueRemove ?? queueEdit ?? queueSteer ?? queueQueue ?? queueSendNow ?? queueDiscard!;
    const action = queueRemove !== undefined ? "remove" : queueEdit !== undefined ? "edit" : queueSteer !== undefined ? "steer" : queueQueue !== undefined ? "queue" : queueSendNow !== undefined ? "send-now" : "discard";
    const result = composer.pending(messageId, action);
    if (!result) return;
    if ("confirm" in result) {
      if (!await confirmChatAction(result.title, result.explanation, result.acceptLabel, target)) return;
      target.disabled = true;
      try {
        const completed = await result.confirm();
        if (completed && action === "discard" && activeConversationId() === id && (document.activeElement === target || document.activeElement === document.body)) input.focus({ preventScroll: true });
      } finally { target.disabled = false; scheduleRender(); }
    } else {
      target.disabled = true;
      try { await result; } finally { target.disabled = false; scheduleRender(); }
    }
  });

  function syncQueueOverflow() {
    if (!queueDockElement || !surface) return;
    const scroller = queueDockElement.parentElement!;
    // Both cards retain their own header and content pane. Preserve the last
    // measurement while desktop's constrained dock is hidden.
    if (typeof getComputedStyle === "function" && getComputedStyle(scroller).display === "none") {
      // Hidden desktop work retains its intrinsic card measurements, but its
      // inline reading allocation must still follow a resized panel.
      syncExpandedWorkBudget(scroller, parseFloat(scroller.style.getPropertyValue("--chat-work-full-floor")) || 0);
      return;
    }
    const workerHeading = compactWorkersList?.hidden ? null : compactWorkersList?.querySelector("summary");
    const pendingHeading = queueDockElement.hidden ? null : queueDockElement.querySelector(".chat-queue-header");
    const workerHeight = workerHeading?.getBoundingClientRect().height ?? 0;
    const pendingHeight = pendingHeading?.getBoundingClientRect().height ?? 0;
    const queueContent = queueDockElement.querySelector<HTMLElement>(".chat-queue-content");
    const workerBody = compactWorkersList?.open && workerHeight ? compactView?.contentHeight() ?? 0 : 0;
    const queueBody = pendingHeight ? queueContent?.scrollHeight ?? 0 : 0;
    const workerFloor = workerHeight ? workerHeight + 2 + Math.min(48, workerBody) : 0;
    const queueActionHeight = Math.max(32, ...[...queueContent?.querySelectorAll<HTMLElement>(".chat-queued-action") ?? []].map(button => button.getBoundingClientRect().height));
    const warning = queueContent?.querySelector<HTMLElement>(".chat-queue-note.is-replacement:not([hidden])");
    const batch = queueContent?.querySelector<HTMLElement>(".chat-queue-batch:not([hidden])");
    // The pointer-transparent fade still paints over glyphs. Reserve its real
    // size as well as the reading inset; hit testing alone cannot detect it.
    const warningClearance = warning ? (parseFloat(getComputedStyle(queueDockElement, "::after").height) || 0) + 8 : 8;
    const safetyHeight = warning ? warning.getBoundingClientRect().height + (batch?.getBoundingClientRect().height ?? 0) + warningClearance : 0;
    const queueFloor = pendingHeight ? pendingHeight + 2 + Math.min(Math.max(queueActionHeight + 8, safetyHeight), queueBody) : 0;
    // Reverted history, TODOs and wakeups retain their own bounded contents;
    // none may silently restore the old shared-scroller fallback.
    let extraHeight = 0;
    let extraHeadings = 0;
    let extraCount = 0;
    for (const track of scroller.querySelectorAll<HTMLDetailsElement>(":scope > #chat-reverted, :scope > #chat-task-list, :scope > #chat-scheduled-wakeups")) {
      if (track.hidden || typeof getComputedStyle === "function" && getComputedStyle(track).display === "none") continue;
      const heading = track.querySelector("summary")?.getBoundingClientRect().height ?? 0;
      const body = track.querySelector<HTMLElement>(":scope > ul, :scope > .chat-reverted-items");
      const actionHeight = Math.max(44, ...[...body?.querySelectorAll("button") ?? []].map(button => button.getBoundingClientRect().height));
      const css = typeof getComputedStyle === "function" ? getComputedStyle(track) : track.style;
      const border = (parseFloat(css.borderTopWidth) || 0) + (parseFloat(css.borderBottomWidth) || 0);
      const margin = (parseFloat(css.marginTop) || 0) + (parseFloat(css.marginBottom) || 0);
      const gap = track.open ? parseFloat(css.rowGap) || 0 : 0;
      const height = heading + (track.open ? Math.min(body?.scrollHeight ?? 0, actionHeight + 8) + gap : 0) + border;
      track.style.setProperty("--chat-track-floor", `${height}px`);
      track.style.setProperty("--chat-track-heading", `${heading + border}px`);
      extraHeight += height + margin;
      extraHeadings += heading + border + margin;
      extraCount++;
    }
    const set = (name: string, value: number) => {
      const pixels = `${value}px`;
      if (scroller.style.getPropertyValue(name) !== pixels) scroller.style.setProperty(name, pixels);
    };
    // Retain open measurements while native details hides its body. CSS uses
    // [open] to switch to heading-only allocation before `toggle` is delivered.
    if (compactWorkersList?.open || !workerHeight) {
      set("--chat-worker-natural", workerHeight ? workerHeight + workerBody + 2 : 0);
      set("--chat-worker-floor", workerFloor);
    }
    set("--chat-queue-natural", pendingHeight ? pendingHeight + queueBody + 2 : 0);
    set("--chat-worker-heading", workerHeight + 2);
    set("--chat-queue-heading", pendingHeight + 2);
    set("--chat-queue-floor", queueFloor);
    const queueActionFloor = pendingHeight ? pendingHeight + 2 + Math.min(queueBody, queueActionHeight + 8) : 0;
    const preferredQueueFloor = pendingHeight ? pendingHeight + 2 + Math.min(queueBody, Math.max(queueActionHeight + 8, (warning?.getBoundingClientRect().height ?? 0) + warningClearance)) : 0;
    const dockCss = typeof getComputedStyle === "function" ? getComputedStyle(scroller) : scroller.style;
    const cardCount = Number(workerHeight > 0) + Number(pendingHeight > 0) + extraCount;
    const gapCount = Math.max(0, cardCount - 1);
    const normalGap = parseFloat(dockCss.getPropertyValue("--chat-work-gap-base")) || 0;
    const padding = (parseFloat(dockCss.paddingTop) || 0) + (parseFloat(dockCss.paddingBottom) || 0);
    const close = scroller.querySelector<HTMLElement>("#chat-work-close");
    const closeCss = close && !close.hidden ? getComputedStyle(close) : null;
    const closeHeight = closeCss && closeCss.display !== "none"
      ? close!.getBoundingClientRect().height + (parseFloat(closeCss.marginTop) || 0) + (parseFloat(closeCss.marginBottom) || 0) + normalGap : 0;
    const fullFloor = workerFloor + queueFloor + gapCount * normalGap + padding + extraHeight + closeHeight;
    set("--chat-work-full-floor", fullFloor);
    syncExpandedWorkBudget(scroller, fullFloor);
    const hardAvailable = parseFloat(scroller.style.getPropertyValue("--chat-work-hard-available"));
    const cramped = (document.documentElement.dataset.uiMode === "touch" || document.documentElement.hasAttribute("data-chat-work-expanded"))
      && Number.isFinite(hardAvailable) && fullFloor > hardAvailable;
    scroller.toggleAttribute("data-work-cramped", cramped);
    const active = scroller.dataset.workActive;
    const effectiveExtras = (cramped && active !== "history" ? extraHeadings : extraHeight) + closeHeight;
    // Enlarged safety text must keep a whole readable warning. If primary
    // chrome leaves less room, the existing outer-scroll exception exposes
    // that warning and the composer instead of clipping the warning's pane.
    const wholeWarning = warning && document.documentElement.dataset.uiMode === "touch"
      && parseFloat(getComputedStyle(document.documentElement).fontSize) > 16;
    const queueCompactFloor = cramped && !wholeWarning
      ? Math.max(queueActionFloor, Math.min(preferredQueueFloor, hardAvailable - (workerHeight ? workerHeight + 2 : 0) - effectiveExtras - padding))
      : preferredQueueFloor;
    set("--chat-queue-compact-floor", queueCompactFloor);
    const selectedCore = (active === "queue" ? workerHeight ? workerHeight + 2 : 0 : workerFloor)
      + (active === "queue" ? queueCompactFloor : pendingHeight ? pendingHeight + 2 : 0) + effectiveExtras;
    // Only inter-card whitespace yields after the reading band is exhausted;
    // header text, action targets and the composer keep their measured sizes.
    const gap = cramped && gapCount ? Math.max(0, Math.min(normalGap, (hardAvailable - selectedCore - padding) / gapCount)) : normalGap;
    const gaps = gapCount * gap + padding;
    set("--chat-work-gap", gap);
    set("--chat-work-spacing", gaps);
    set("--chat-work-extras", effectiveExtras);
    set("--chat-work-floor", cramped
      ? selectedCore + gaps
      : fullFloor);
    if (cramped && document.documentElement.dataset.uiMode === "touch" && scroller.hasAttribute("data-work-content-expanded")) {
      const reading = Math.max(0, Math.min(parseFloat(surface.style.getPropertyValue("--chat-expanded-reading")) || 0, hardAvailable - selectedCore - gaps));
      surface.style.setProperty("--chat-expanded-reading", `${reading}px`);
      set("--chat-work-expanded-capacity", Math.max(0, hardAvailable - reading));
    }
    // When primary chrome plus whole headers/action targets physically exceed
    // the visual band, use native outer scrolling rather than clipping cards
    // or shrinking enlarged text. Each body keeps its independent scrollport.
    surface.toggleAttribute("data-work-overflow", document.documentElement.dataset.uiMode === "touch"
      && Number.isFinite(hardAvailable) && selectedCore + gaps > hardAvailable + 1);
    scroller.toggleAttribute("data-work-region-overflow", document.documentElement.hasAttribute("data-chat-work-expanded")
      && Number.isFinite(hardAvailable) && selectedCore + gaps > hardAvailable + 1);
    scroller.classList.remove("has-more-below");
    queueDockElement.classList.toggle("has-more-below", !!queueContent && queueContent.scrollHeight - queueContent.clientHeight - queueContent.scrollTop > 1);
  }
  queueDockElement.addEventListener("scroll", syncQueueOverflow, { passive: true, capture: true });

  // Fixed keyboard delivery; Alt+Enter queues this submission only.
  let requestedDelivery: MessageDelivery | undefined;
  function deliveryChoiceOffered(): boolean {
    return Boolean(projection) && declares("steering") && (isLiveConversationStatus(projection?.status) || (projection?.queued.length ?? 0) > 0);
  }
  function sendSupportsHold(): boolean {
    const draft = input?.value ?? "";
    return declares("steering") && !sideQuestionOperation(draft) && !localHistoryOperation(draft, commands, declares("reversible-history"));
  }
  function syncSendDescription(): void {
    const touch = document.documentElement.dataset.uiMode === "touch";
    const sendAction = sideQuestionOperation(input?.value ?? "") ? "Ask side question" : localHistoryOperation(input?.value ?? "", commands, declares("reversible-history")) ? "Send message" : isLiveConversationStatus(projection?.status)
      ? declares("steering") && !isListedCommand(input?.value ?? "") && currentPendingAttachments().length === 0 ? "Send as steer; hold 2.5 seconds to queue" : declares("steering") ? "Send to queue" : "Queue message"
      : "Send message";
    send?.setAttribute("aria-label", sendAction);
    if (send) send.title = sendAction;
    const help = document.querySelector<HTMLElement>("#chat-send-help");
    const hint = document.querySelector<HTMLElement>("#chat-keyboard-hint");
    const keyboardChoice = deliveryChoiceOffered() && sendSupportsHold() && !isListedCommand(input?.value ?? "") && currentPendingAttachments().length === 0;
    if (hint) {
      hint.hidden = !projection || touch || !window.matchMedia("(pointer: fine) and (hover: hover)").matches;
      hint.textContent = keyboardChoice ? "Enter: steer · Alt+Enter: queue" : "Enter: send · Shift+Enter: new line";
    }
    const discovery = document.querySelector<HTMLElement>("#chat-queue-discovery");
    if (discovery) discovery.hidden = !queueDiscovery.visible(!send?.disabled && isLiveConversationStatus(projection?.status)
      && sendSupportsHold() && !isListedCommand(input?.value ?? "") && currentPendingAttachments().length === 0
      && !composer.uploading(activeConversationId() ?? "") && Boolean(input?.value.trim()));
    const keys = sendSupportsHold() && !isListedCommand(input?.value ?? "") && currentPendingAttachments().length === 0
      ? `${touch ? "Ctrl+Enter" : "Enter"}: Steer; Alt+Enter: Queue while working`
      : `${touch ? "Ctrl+Enter" : "Enter"} sends`;
    if (help) help.textContent = `${sendSupportsHold() ? "Hold Send or Space: after 0.5 seconds, a 2-second queue countdown starts. Release before the countdown sends; release during it or Escape cancels. " : ""}Enter activates Send immediately. In the message field, ${keys}.${touch ? " Enter adds a new line." : ""}`;
  }

  revertedItems?.addEventListener("pointerdown", event => {
    if (event.pointerType === "touch" && (event.target as Element).closest("[data-history-restore]")) event.preventDefault();
  });

  revertedItems?.addEventListener("click", event => {
    const target = (event.target as Element).closest<HTMLButtonElement>("[data-history-restore]");
    if (!target || !projection || composer.submitting || composer.historyBusy(projection.conversationId)) return;
    const messageId = target.dataset.historyRestore;
    if (!messageId) return;
    target.disabled = true;
    void runHistoryOperation("restore", projection.conversationId, messageId)
      .finally(() => { if (target.isConnected) target.disabled = false; });
  });

  olderButton.addEventListener("click", async () => {
    if (!projection?.olderCursor) return;
    const current = projection;
    let changedHistory = false;
    olderButton.disabled = true;
    parentScroll.beforeMutation();
    try {
      await runConversationRead("Loading older messages...", () => {
        if (changedHistory) void refreshSelectedConversation(current.conversationId);
        else olderButton.click();
      }, async signal => {
        const page = await api.snapshot(current.conversationId, current.olderCursor, signal).catch(error => {
          changedHistory = error instanceof ChatTransportError && error.status === 409;
          throw error;
        });
        if (signal.aborted || projection?.conversationId !== current.conversationId) return;
        projection = prependSnapshot(projection, page);
        // Publish the prepended DOM and its anchor correction in one frame.
        scheduleRender(false, false);
      });
    } catch { /* The read lane owns its error and retry. */ }
    finally { olderButton.disabled = false; syncControls(); }
  });

  latestButton.addEventListener("click", () => {
    parentScroll.latest();
  });

  /**
   * Expanding an activity group inside a transcript, for whichever timeline
   * it belongs to. `expanded` is shared: an item id names one item wherever
   * it is shown, so a group opened in a subagent's transcript stays open.
   */
  const wireExpansionToggle = (
    container: HTMLElement,
    scroll: CoordinatedScrollOwner,
  ) => {
    container.addEventListener("toggle", event => {
      const details = event.target as HTMLDetailsElement;
      if (!details.matches("details[data-chat-item-id]")) return;
      // Inserting a `<details open>` node fires a toggle of its own (the
      // renderer's force-opened request cards rely on exactly that), so an
      // open row still carrying the stream's marker is the render echoing,
      // not the reader speaking. Acting on the echo would strip the marker on
      // every rebuild — reclassifying each auto-opened row as reader-opened,
      // pinning it open past completion, and banking its id in `expanded`.
      // The reader can only ever close an already-open row (open=false, which
      // passes) or open an unmarked one, so no real interaction is lost.
      if (details.open && details.hasAttribute("data-auto-open")) return;
      scroll.beforeMutation(details.dataset.chatItemId);
      // The reader has spoken, so the row is theirs from here. Clearing the
      // stream's auto-open marker stops the next render from undoing an
      // expansion they made on a row that had opened itself; recording a close
      // stops a still-streaming tool from shouldering the row back open on its
      // next chunk. Both are needed — the auto-open rule is recomputed from
      // status and output every render and has no memory of its own.
      details.removeAttribute("data-auto-open");
      details.toggleAttribute(READER_CLOSED, !details.open);
      if (details.open) expanded.add(details.dataset.chatItemId!); else expanded.delete(details.dataset.chatItemId!);
      save();
      scroll.request();
    }, true);
  };

  // A failure reports where the reader is looking: a card answered inside the
  // drill-down speaks through the drill-down's own status line — in touch
  // mode that layer covers the parent's entirely, so a message sent to the
  // parent's line is a message no one sees while the controls silently
  // re-enable.
  const announceFailureFor = (source: ChatProjection) =>
    child && source.conversationId === child.conversationId ? announceChild : announce;

  const resolvePermission = async (source: ChatProjection, itemId: string, outcome: PermissionOutcome, choiceId?: string) => {
    const item = source.items.find(candidate => candidate.id === itemId);
    if (!item || item.type !== "permission" || item.status !== "pending") return;
    disableCard(itemId, true);
    // Addressed to the conversation that owns the request, not the one on
    // screen: a subagent's request shown in its parent must be answered for the
    // subagent, so the child's requirePending guard and receipt key govern it.
    try { await api.permission(item.conversationId ?? source.conversationId, item.requestId, newRequestId(), outcome, choiceId); }
    catch (error) { announceFailureFor(source)(messageOf(error), true); disableCard(itemId, false); }
  };

  const resolveQuestion = async (source: ChatProjection, itemId: string, outcome: QuestionOutcome): Promise<boolean> => {
    const item = source.items.find(candidate => candidate.id === itemId);
    if (!item || item.type !== "question" || item.status !== "pending") return false;
    disableCard(itemId, true);
    try { await api.question(item.conversationId ?? source.conversationId, item.requestId, newRequestId(), outcome); return true; }
    catch (error) { announceFailureFor(source)(messageOf(error), true); disableCard(itemId, false); return false; }
  };

  /**
   * Every interaction a rendered transcript offers, wired once per timeline.
   * The parent's items and the drill-down's are the same markup rendered from
   * different projections, so the projection they read is the only difference:
   * a request in a subagent's transcript resolves against the subagent, one in
   * the parent's against the parent — which is what keeps the parent
   * answerable while a child is open.
   */
  const wireItemInteractions = (container: HTMLElement, sourceProjection: () => ChatProjection | null, stage: { renderer: TimelineRenderer; rerender: () => void; beforeFileNavigation?: () => void }, scroll: CoordinatedScrollOwner) => {
    // "Allow always" is confirmed one step deeper, on the same card, where
    // it shows the rule the agent will actually install. The stage is this
    // timeline's own (the drill-down keeps its own renderer), and nothing
    // reaches the server until Confirm.
    const enterConfirmation = (itemId: string) => {
      stage.renderer.confirming.add(itemId);
      // Cancel is the safe landing for a step that exists to catch a slip;
      // Confirm is one Tab away.
      stage.renderer.focusAfterPaint = `[data-chat-item-id="${CSS.escape(itemId)}"] [data-permission-cancel]`;
      stage.rerender();
    };
    const leaveConfirmation = (itemId: string) => {
      if (!stage.renderer.confirming.delete(itemId)) return;
      stage.renderer.focusAfterPaint = `[data-chat-item-id="${CSS.escape(itemId)}"] [data-permission-outcome="approved-session"]`;
      stage.rerender();
    };
    // Prevent only the focus default of the native/compatibility mousedown:
    // blurring an answer restores the chrome and moves the action row before
    // the click lands. Cancelling touch pointerdown instead suppresses the
    // compatibility click altogether in WebKit. Mouse, pen and touch still
    // activate normally; radios, links and summaries keep ordinary focus.
    container.addEventListener("mousedown", event => {
      if ((event.target as Element).closest("[data-history-revert]")) keepTouchComposerFocus(event);
      if (!document.documentElement.hasAttribute("data-chat-answering")) return;
      if (!(event.target as Element).closest?.(REQUEST_ANSWER_CONTROLS)) return;
      event.preventDefault();
    });
    container.addEventListener("click", event => {
      const target = (event.target as Element).closest<HTMLElement>("[data-file-ref], [data-permission-outcome], [data-permission-choice], [data-permission-confirm], [data-permission-cancel], [data-question-reject], [data-open-conversation], [data-chat-copy], [data-history-revert]");
      if (!target) return;
      if (target instanceof HTMLButtonElement && target.dataset.chatCopy) {
        const text = target.closest("pre")?.querySelector(":scope > code")?.textContent;
        if (text === undefined || text === null) return;
        void copyChatText(target, text, message => { copyStatus.textContent = message; });
        return;
      }
      const source = sourceProjection();
      if (!source) return;
      if (target.dataset.openConversation) {
        const row = target.closest<HTMLElement>("[data-chat-item-id]")?.dataset.chatItemId;
        const task = source ? taskForChild(source.items, target.dataset.openConversation, row) : undefined;
        openChildConversation(target.dataset.openConversation, subagentLabelFor(target.dataset.openConversation, source), false,
          task && source ? { conversationId: source.conversationId, taskId: task.taskId, view: "transcript" } : undefined);
        return;
      }
      if (target.dataset.fileRef) {
        const reference = resolveWorkspaceFileReference(target.dataset.fileRef, appState.roots);
        if (reference) {
          stage.beforeFileNavigation?.();
          void navigateWorkspaceFileReference(reference);
        }
        return;
      }
      const itemElement = target.closest<HTMLElement>("[data-chat-item-id]");
      const item = source.items.find(candidate => candidate.id === itemElement?.dataset.chatItemId);
      if (!item || item.type === "assistant_message") return;
      if (item.type === "user_message") {
        if (target.dataset.historyRevert === undefined || source !== projection || composer.submitting || composer.historyBusy(source.conversationId)) return;
        const button = target as HTMLButtonElement;
        button.disabled = true;
        void runHistoryOperation("revert", source.conversationId, item.id)
          .finally(() => { if (button.isConnected) button.disabled = false; });
        return;
      }
      if (item.type === "permission" && target.dataset.permissionChoice) {
        // A chosen intent is an approval; the id tells the agent which one.
        void resolvePermission(source, item.id, "approved-once", target.dataset.permissionChoice);
      } else if (item.type === "permission" && target.dataset.permissionOutcome === "approved-session") {
        enterConfirmation(item.id);
      } else if (item.type === "permission" && target.dataset.permissionConfirm !== undefined) {
        void resolvePermission(source, item.id, "approved-session");
      } else if (item.type === "permission" && target.dataset.permissionCancel !== undefined) {
        leaveConfirmation(item.id);
      } else if (item.type === "permission" && target.dataset.permissionOutcome) {
        void resolvePermission(source, item.id, target.dataset.permissionOutcome as PermissionOutcome);
      } else if (item.type === "question" && target.dataset.questionReject !== undefined) {
        // A successful rejection retires the form — and the owed-answer line
        // a required validation error may have left on the status region:
        // the same guarded cleanup the answer path runs, but retiring the
        // line on every surface whose record matches — the mirrored card's
        // line may belong to the parent while the reject runs here. The
        // card's own item stays bound: the cleanup retires only the lines
        // this exact question request raised, never one another question —
        // of another conversation, or a newer one of this one — raised
        // while the request sat in flight.
        void resolveQuestion(source, item.id, { kind: "rejected" }).then(resolved => { if (resolved) clearOwedAnswersEverywhere(source, item); });
      }
    });
    container.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        // Escape inside the confirmation is Cancel, through the same button
        // so one path resolves the card. It stops here, so the surface's own
        // Escape handling does not also close the drill-down.
        const cancel = (event.target as Element).closest("[data-permission-confirming]")?.querySelector<HTMLButtonElement>("[data-permission-cancel]");
        if (!cancel) return;
        event.preventDefault();
        event.stopPropagation();
        cancel.click();
        return;
      }
      const target = (event.target as Element).closest<HTMLElement>("[role=button][data-file-ref]");
      if (target && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        target.click();
      }
    });
    // A step change is spoken, not just shown: with all tabs alike and the
    // panel swapping above the focus point, a screen-reader user otherwise
    // hears nothing while the question under their hands changes. Spoken to
    // the surface that owns the form — answering from a subagent drill-down
    // announces beside that surface's status line, never into it, so a
    // connection-interruption message and its Reconnect button stand.
    const speakQuestionStep = (source: ChatProjection, form: HTMLFormElement) => {
      const speak = source.conversationId === (child?.conversationId ?? null) ? announceQuestionStepChild : announceQuestionStep;
      const panels = [...form.querySelectorAll<HTMLElement>("[data-question-panel]")];
      const activeIndex = Math.max(0, panels.findIndex(panel => !panel.hidden));
      const panel = panels[activeIndex];
      // The step's label names it; a mapping that leaves the label unnamed
      // falls back to the statement itself rather than announcing a bare
      // hint (or nothing) for the question that just opened.
      const label = panel?.querySelector<HTMLElement>(".chat-question-step")?.textContent?.trim().replace(/\s+/g, " ");
      const statement = panel?.querySelector<HTMLElement>(".chat-question-statement")?.textContent?.trim().replace(/\s+/g, " ");
      const name = label || statement;
      speak(name ? `Question ${activeIndex + 1} of ${panels.length}: ${name}` : "");
    };

    // Retire this conversation's owed-answer line once the step it held back
    // becomes valid — but only while the line still reads as ours: a newer
    // unrelated status (an outage, a refusal) is never spoken over. The
    // interruption owner re-states its message when the blank replaces it.
    // "Ours" is the exact question request that raised the line, tracked in
    // the shared per-surface map (`owedAnswerOwners`): the prefix two cards'
    // messages can share says nothing about who raised it, so retirement
    // without an ownership check would take down whichever validation is on
    // the line — another conversation's, or a newer question of this one —
    // whenever an in-flight resolve lands after it.
    const clearOwedAnswer = (source: ChatProjection, item: Extract<ConversationItem, { type: "question" }>) => {
      const spoken = announceFailureFor(source);
      const owner = owedAnswerOwners.get(spoken);
      if (owner?.key !== questionOwnershipKey(source, item)) return;
      if (spoken.current().startsWith("Still to answer")) {
        spoken("");
        owedAnswerOwners.delete(spoken);
        owner.owner.restoreOwned();
      }
    };

    // Resolving the question retires its raised line on EVERY surface whose
    // ownership record matches — the parent's mirrored card can carry the
    // line while the answer or reject goes out from the drill-down (and the
    // reverse). Settling a form's local controls (the per-surface path
    // above) retires one surface's line and must not reach past it; a
    // resolution ends the question everywhere, so it matches records by the
    // exact question request, never by the surface the resolve ran on.
    // Still guarded by the prefix: a line a newer unrelated status has
    // displaced — an outage, a refusal — keeps standing, and each retired
    // line restores its own surface's interruption affordances.
    const clearOwedAnswersEverywhere = (source: ChatProjection, item: Extract<ConversationItem, { type: "question" }>) => {
      const key = questionOwnershipKey(source, item);
      for (const [spoken, owner] of [...owedAnswerOwners]) {
        if (owner.key !== key || !spoken.current().startsWith("Still to answer")) continue;
        spoken("");
        owedAnswerOwners.delete(spoken);
        owner.owner.restoreOwned();
      }
    };

    container.addEventListener("change", event => {
      const input = event.target as HTMLInputElement;
      const form = input.form;
      if (!form?.matches("form[data-question-form]")) return;
      // Choosing "Type your own answer" reveals and focuses the editor, which
      // resizes the card and pans the visible viewport under the keyboard. The
      // correction that follows must hold the request being answered rather
      // than whatever is topmost, or the question scrolls away as the user
      // starts to answer it. This timeline's own owner: the same card can be
      // shown in the parent transcript or in a subagent drill-down.
      const itemId = input.closest<HTMLElement>("[data-chat-item-id]")?.dataset.chatItemId;
      if (itemId !== undefined) scroll.beforeMutation(itemId);
      syncQuestionControl(input, true);
    });
    container.addEventListener("input", event => {
      const input = event.target as HTMLInputElement;
      const form = input.form;
      if (!form?.matches("form[data-question-form]")) return;
      syncQuestionControl(input);
    });
    // A wakeup row and the turn it started point at each other: the link
    // brings the other one into view in this same timeline and focuses it.
    container.addEventListener("click", event => {
      const link = (event.target as Element).closest<HTMLButtonElement>("[data-chat-jump]");
      if (!link) return;
      const destination = container.querySelector(`[data-chat-item-id="${CSS.escape(link.dataset.chatJump ?? "")}"]`);
      if (!(destination instanceof HTMLElement)) return;
      destination.scrollIntoView({ block: "center" });
      if (!destination.hasAttribute("tabindex")) destination.tabIndex = -1;
      destination.focus?.({ preventScroll: true });
    });
    container.addEventListener("click", event => {
      const tab = (event.target as Element).closest<HTMLButtonElement>("[data-question-tab]");
      if (!tab?.form) return;
      const source = sourceProjection();
      // Tab navigation leaves the current panel in whatever state it holds.
      // The owed-answer line goes stale only once no required step of the
      // form is outstanding: an optional empty tab-switch with a required
      // step still empty keeps the message alive — it names what is still
      // owed, not what was just left.
      const leaving = tab.form.querySelector<HTMLElement>("[data-question-panel]:not([hidden])");
      if (source && leaving) {
        const itemId = tab.form.closest<HTMLElement>("[data-chat-item-id]")?.dataset.chatItemId;
        const item = source.items.find(candidate => candidate.id === itemId);
        if (item?.type === "question") settleOwedAnswer(source, item, tab.form);
      }
      showQuestionPanel(tab.form, Number(tab.dataset.questionTab));
      if (source) speakQuestionStep(source, tab.form);
    });
    // A required empty stops here with the owed-answer message the final
    // check also speaks. During a connection interruption the message takes
    // the status line's text, but the outage's recovery affordance keeps
    // standing beside it exactly as it stood — attached only when it was
    // attached to the owned interruption before, never re-attached onto an
    // unrelated status. Repeated submits count as the known write they are:
    // while a stream of the surface is down, the affordance stands again on
    // every press of an empty required step. The message records the exact
    // question request that raised it (the shared `owedAnswerOwners` map,
    // keyed per surface): only that question's resolution may retire the
    // line later.
    const speakOwedAnswer = (source: ChatProjection, item: Extract<ConversationItem, { type: "question" }>, message: string) => {
      const spoken = announceFailureFor(source);
      const owner = interruptionsOwnerFor(source);
      owedAnswerOwners.set(spoken, { key: questionOwnershipKey(source, item), owner });
      const wasRecovering = owner.isShowingOwned();
      spoken(message, true);
      if (wasRecovering || owner.hasDown()) owner.keepRecoveryVisible();
    };

    // Name each owed step: the renderer's step-label selection — the short
    // label whichever mapping carried it, header on ties, prompt fallback —
    // the same names the tab strip prints, never a divergent header-first
    // algorithm that repeats one long header for every step. A field with
    // neither string reads "the current question" rather than empty.
    const owedStepNames = (outstanding: number[], item: Extract<ConversationItem, { type: "question" }>) =>
      outstanding.map(index => questionStepLabel(item.questions[index]!) || "the current question").join(", ");

    // Which of the form's required steps still owe answers — the one
    // predicate the settlement, the advance gate, and the final validation
    // all read, so the routes can never disagree about what is owed.
    const outstandingRequired = (form: HTMLFormElement, item: Extract<ConversationItem, { type: "question" }>) =>
      collectQuestionAnswers(form).flatMap((answer, index) => answer.length === 0 && !item.questions[index]?.optional ? [index] : []);

    // The owed-answer line follows the form's outstanding required steps as
    // they stand, wherever an interaction settles it: an optional empty never
    // retires a required one's line, a satisfied step stops being named, and
    // the refreshed message is spoken only while the line is still ours — a
    // newer unrelated status (an outage, a refusal) is never spoken over. Tab
    // navigation and the Next advance owe the line to the same whole form, so
    // they settle it together here rather than in diverging copies. Each
    // raising and refresh records the exact question request that owes the
    // line (the shared per-surface map), so a resolution landing after the
    // reader switched conversations — or asked this conversation again — can
    // never retire another question's line.
    const settleOwedAnswer = (source: ChatProjection, item: Extract<ConversationItem, { type: "question" }>, form: HTMLFormElement) => {
      const outstanding = outstandingRequired(form, item);
      if (outstanding.length === 0) {
        clearOwedAnswer(source, item);
        return;
      }
      // A refresh may only touch a line this exact question already owns:
      // two active forms of two owners share the surface's one status line,
      // and merely navigating form B — tabs, or the advance past its
      // optional empty step, with B's required step still outstanding — must
      // not rewrite the line form A's validation raised, nor steal its
      // ownership. B's own failed validation (the Next gate, the final
      // check) is what may take the line over.
      const spoken = announceFailureFor(source);
      if (owedAnswerOwners.get(spoken)?.key !== questionOwnershipKey(source, item)) return;
      // The refresh is spoken only while the line is still ours; a newer
      // unrelated status is never spoken over.
      if (!spoken.current().startsWith("Still to answer")) return;
      speakOwedAnswer(source, item, `Still to answer: ${owedStepNames(outstanding, item)}`);
    };

    container.addEventListener("submit", event => {
      const questionForm = event.target as HTMLFormElement;
      if (!questionForm.matches("form[data-question-form]")) return;
      event.preventDefault();
      const source = sourceProjection();
      const item = source?.items.find(candidate => candidate.id === questionForm.closest<HTMLElement>("[data-chat-item-id]")?.dataset.chatItemId);
      if (!source || !item || item.type !== "question") return;
      const panels = [...questionForm.querySelectorAll<HTMLElement>("[data-question-panel]")];
      const activeIndex = Math.max(0, panels.findIndex(panel => !panel.hidden));
      // Not on the last step yet: advance instead of submitting. The primary
      // button is "Next" here, so submitting the form means "go on" — but the
      // step being left must carry its answer first, unless it is optional
      // and may be left empty freely. A required empty stops here with the
      // same message the final check speaks, rather than surfacing only at
      // the end and bouncing the reader back through the wizard (GitHub
      // review finding on the never-disabling Answer: the check now runs on
      // the advance path too). Once the step passes, its stale owed-answer
      // line is retired — only if nothing newer owns the status.
      if (activeIndex < panels.length - 1) {
        const step = item.questions[activeIndex]!;
        if (collectQuestionAnswers(questionForm)[activeIndex]!.length === 0 && !step.optional) {
          // The advance holds on the step just left, but the line names the
          // whole form's outstanding set, not that step alone: the final
          // validation may already have listed later required steps, and
          // repeating Next must not shrink the message to the one the
          // reader is standing on.
          // The advance holds on the step just left, but the line names the
          // whole form's outstanding set, not that step alone: the final
          // validation may already have listed later required steps, and
          // repeating Next must not shrink the message to the one the
          // reader is standing on.
          const outstanding = outstandingRequired(questionForm, item);
          speakOwedAnswer(source, item, `Still to answer: ${owedStepNames(outstanding, item)}`);
          return;
        }
        // The advance retires the line only by the whole form's standing —
        // an optional empty behind Next must not clear what a required step
        // elsewhere still owes (the same settle the tab path runs).
        settleOwedAnswer(source, item, questionForm);
        showQuestionPanel(questionForm, activeIndex + 1);
        speakQuestionStep(source, questionForm);
        return;
      }
      const answers = collectQuestionAnswers(questionForm);
      // The primary button stays enabled, so every submit routes through this
      // check: an optional question may go unanswered; every other one must
      // not. The form jumps to the first missing panel and says what is owed.
      const missing = outstandingRequired(questionForm, item);
      if (missing.length > 0) {
        showQuestionPanel(questionForm, missing[0]!);
        speakOwedAnswer(source, item, `Still to answer: ${owedStepNames(missing, item)}`);
        return;
      }
      // Every answer is collected; but the question is not resolved yet —
      // the lines stay standing while the api call flies, and the guarded
      // cleanup runs only on success, exactly like the reject path: a
      // failed answer's own status must not also silently remove the
      // still-valid validation lines, and a line the same pending request
      // raises while its answer hangs is the success's to retire on every
      // surface whose record matches.
      void resolveQuestion(source, item.id, { kind: "answered", answers }).then(resolved => { if (resolved) clearOwedAnswersEverywhere(source, item); });
    });
  };

  const renderChild = (newContent: boolean) => {
    childRenderDirty = true;
    childNewContent ||= newContent;
    if (!chatSurfaceActive()) { syncChatAttention(); return; }
    const delay = newContent && isLiveConversationStatus(child?.projection?.status) ? 50 - (performance.now() - lastChildPaint) : 0;
    if (delay > 0) {
      if (childIncrementalTimer === null) childIncrementalTimer = setTimeout(() => {
        childIncrementalTimer = null;
        renderChild(false);
      }, delay);
      return;
    }
    if (childIncrementalTimer !== null) { clearTimeout(childIncrementalTimer); childIncrementalTimer = null; }
    if (childRenderFrame !== null) return;
    childRenderFrame = requestAnimationFrame(timestamp => {
      childRenderFrame = null;
      if (!chatSurfaceActive()) return;
      const content = childNewContent;
      childNewContent = false;
      childRenderDirty = false;
      renderChildNow(content);
      childScroll?.flush(timestamp);
    });
  };

  const renderChildNow = (newContent: boolean) => {
    lastChildPaint = performance.now();
    if (!drilldownItems || !drilldownTimeline) return;
    childScroll?.beforeMutation();
    childRenderer.permissionScopeNote = agent?.permissionScopeNote;
    childRenderer.loginAction = contextLoginAction();
    childRenderer.conversationTitle = child?.label;
    const dirty = childRenderer.render(drilldownItems, child?.projection ?? null, expanded, declares("subagents"), false, turnStartedAt(child?.projection));
    childRenderer.setShellOutputsHidden(false);
    syncWorkingTimer();
    if (drilldownOlder) drilldownOlder.hidden = !child?.projection?.olderCursor;
    // A subagent's report is the same login's plan: the Usage pane follows
    // it like the parent's (newest wins, by the report's own time).
    const childReport = child?.projection && declares("context") ? latestPlanReport(child.projection.items) : undefined;
    if (childReport?.plan) noteUsageReport({ plan: childReport.plan, reportedAt: childReport.createdAt });
    childScroll?.request(newContent);
    for (const node of dirty) {
      decorateFileLinks(node);
      decorateAttachmentImages(node);
      node.querySelectorAll<HTMLFormElement>("form[data-question-form]").forEach(syncQuestionForm);
    }
    applyFocusAfterPaint(childRenderer, drilldownItems);
    reconcileAnswerAfterPaint();
  };

  /**
   * Leaves the drill-down. Not a conversation switch: the picker never moved
   * off the parent and the parent's projection, composer, and stream stayed
   * mounted behind the child, so returning is clearing this state.
   *
   * `popped` says the platform back gesture delivered us here. Otherwise, when
   * a history entry was pushed for the layer and is still the current one, the
   * pop is asked for instead of finishing directly — leaving a back-stack
   * entry for a layer that is no longer open would make the next back press a
   * no-op.
   */
  const closeChildConversation = (popped = false) => {
    childRenderer.closeShellOutputWindow();
    childScroll?.cancel();
    if (childLatest) childLatest.hidden = true;
    const open = child;
    if (!open) return;
    if (!popped && drilldownClosePending) return;
    if (!popped && drilldownHistoryToken !== null && (history.state as { chatDrilldown?: unknown } | null)?.chatDrilldown === drilldownHistoryToken) {
      // Ask the platform to pop, and finish in the popstate that arrives:
      // leaving a back-stack entry for a layer that is no longer open would
      // make the next Back a no-op. Re-entry is bounded by `popped`. Matched
      // by token — a stale marker from before a reload is not our entry.
      drilldownClosePending = true;
      history.back();
      return;
    }
    drilldownClosePending = false;
    // The entry remains somewhere in history in both cases: buried below a
    // direct close, or in the Forward stack after its Back pop. Retire it so
    // landing on that same-URL marker later returns to a live document entry
    // rather than leaving an inert navigation step.
    if (drilldownHistoryToken !== null) {
      retiredDrilldownTokens.set(drilldownHistoryToken, popped
        ? { kind: "forward-only" }
        : { kind: "buried", next: "back" });
    }
    child = null;
    drilldownHistoryToken = null;
    childGeneration += 1;
    silentRun.stop();
    open.stream?.close();
    open.read?.controller.abort();
    childReadSignal?.cancel();
    childReadError.hidden = true;
    releaseChildBack?.();
    releaseChildBack = null;
    taskPanel?.close();
    if (drilldownTimeline) drilldownTimeline.hidden = false;
    if (drilldownItems && chatSurfaceActive()) childRenderer.render(drilldownItems, null, expanded, declares("subagents"));
    else childRenderDirty = true;
    reconcileAnswerAfterPaint();
    syncWorkingTimer();
    if (drilldownOlder) {
      drilldownOlder.hidden = true;
      drilldownOlder.disabled = false;
    }
    if (drilldown) drilldown.hidden = true;
    if (drilldownTitle) drilldownTitle.textContent = "";
    // The parent's cards are reachable again, so the pill returns to
    // deferring to the one it leads to.
    syncRequestsJumpVisibility();
    announceChild("");
    surface.removeAttribute("data-chat-drilldown");
    // Back to the parent at its live position: it never unmounted, so this is
    // only re-asserting the anchor the timeline was already holding.
    parentScroll.request();
    const invoker = childInvoker?.isConnected ? childInvoker : childInvokerSelector ? surface.querySelector<HTMLElement>(childInvokerSelector) : null;
    if (invoker && invoker.getClientRects().length > 0) invoker.focus({ preventScroll: true });
    else timeline.focus({ preventScroll: true });
    childInvoker = null;
    childInvokerSelector = null;
    // A jump that was waiting on this close lands after the anchor restore,
    // never before it — see the requests-jump handler.
    if (pendingRequestJump !== null) {
      const target = pendingRequestJump;
      pendingRequestJump = null;
      jumpToRequestCard(target);
    }
  };

  /**
   * Opens a subagent's transcript as a drill-down over the parent. The picker
   * keeps showing the parent — a subagent is a detail of a turn, not a
   * conversation anyone can start or resume, so it is reached from the row
   * that launched it and from nowhere else.
   *
   * A subagent opened from inside another subagent's transcript replaces the
   * one on screen: the drill-down is one level deep by design, and back
   * returns to the conversation the picker still shows.
   */
  // The drill-down's own event topic — one more subscription on the same
  // stream, alongside the parent's. The transcript on screen is as live a
  // surface as the parent conversation; the channel resumes it from its own
  // cursor after a wake-up, the same as the parent.
  const openChildStream = (
    entry: Drilldown,
    id: string,
    label: string,
    cursor: string,
    generation: number,
  ): ChatEventStream =>
    api.stream(id, cursor, {
      event: (event, cursor) => {
        if (generation !== childGeneration || !entry.projection) return;
        const result = applyChatEvent(entry.projection, event, cursor);
        // A gap in a drill-down is refetched in place; it is a view over a
        // turn, so there is no selection to re-run.
        if (result.outcome === "gap" || result.outcome === "resync") {
          openChildConversation(id, label, true, entry.task);
          return;
        }
        entry.projection = result.projection;
        if (result.outcome === "applied") {
          announceChild("");
          renderChild(true);
          // A record or its text arriving is the run speaking, so it is not
          // silent. A status change is not: a run that never streams must
          // still read as silent when it settles, so that it gets the reads
          // that bring in its last records.
          if (event.type === "item.upsert" || event.type === "item.text_delta" || event.type === "item.remove") silentRun.heard();
          silentRun.follow(isLiveConversationStatus(entry.projection.status));
        }
      },
      resync: () => { if (generation === childGeneration) openChildConversation(id, label, true, entry.task); },
      error: error => { if (generation === childGeneration) childInterruptions.report("child", error); },
      recovered: () => { if (generation === childGeneration) childInterruptions.clear("child"); },
    });

  const openChildConversation = (id: string, label: string, automaticRefresh = false, task?: OpenTaskInspection) => {
    if (!drilldown || !drilldownItems || !drilldownTimeline) return;
    const generation = ++childGeneration;
    drilldownClosePending = false;
    silentRun.stop();
    const previous = child;
    if (!previous) {
      childInvoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const attribute = ["data-worker-item", "data-inspect-task", "data-open-conversation"].find(name => childInvoker?.hasAttribute(name));
      const row = childInvoker?.closest<HTMLElement>("[data-chat-item-id]")?.dataset.chatItemId;
      childInvokerSelector = attribute ? `${row ? `[data-chat-item-id="${CSS.escape(row)}"] ` : ""}[${attribute}="${CSS.escape(childInvoker!.getAttribute(attribute)!)}"]` : null;
    }
    previous?.stream?.close();
    previous?.read?.controller.abort();
    const retainedProjection = previous?.conversationId === id ? previous.projection : null;
    const retainedAnchor = retainedProjection ? childAnchor.currentAnchor() : null;
    // The task behind this layer: named by the caller (a composer row), kept
    // from the layer being refreshed, or — for a transcript opened from the
    // subagents track or the launching row — found by the child id on a
    // running task, so a running subagent gets the strip whichever way in.
    const owningTask = projection ? taskForChild(projection.items, id) : undefined;
    const link = task
      ?? (previous?.conversationId === id ? previous.task : undefined)
      ?? (projection && owningTask ? { conversationId: projection.conversationId, taskId: owningTask.taskId, view: "transcript" as const } : undefined);
    const next: Drilldown = { conversationId: id, label, projection: retainedProjection, stream: null, ...(link ? { task: link } : {}) };
    const nested = previous !== null;
    child = next;
    const outputView = link?.view === "output";
    if (taskPanel) {
      if (link) {
        const owner = projection?.conversationId === link.conversationId ? projection : null;
        taskPanel.show(link, checkingPresentation.task(owner ? taskById(owner.items, link.taskId, link.itemId) : undefined), stoppingTasks.has(link.taskId));
      } else taskPanel.close();
    }
    // A task's output view has no transcript: the timeline stays out of the
    // way and the pane takes its place.
    drilldownTimeline.hidden = outputView;
    // One entry per layer, in both chromes. Conditioning this on the ui mode
    // meant storing "was this touch when it opened" under a name that claimed
    // to answer "does an entry exist" — two facts that drift the moment the
    // mode changes live, which is where a run of back-navigation bugs came
    // from. Back dismissing the topmost layer is the ordinary idiom on both,
    // and it leaves nothing mode-dependent to keep in sync.
    //
    // A subagent opened from inside another reuses the entry already on the
    // stack: the drill-down is one level deep, so one Back returns to the
    // parent rather than walking a stack of replaced children.
    if (!nested) {
      try {
        const token = newRequestId();
        history.pushState({ ...(history.state as Record<string, unknown> | null), chatDrilldown: token }, "", location.href);
        drilldownHistoryToken = token;
      } catch { /* history is best effort; the header control still returns */ }
    }
    // Only a layer that actually has an entry on the stack may consume Back.
    // When the push above throws (a document not fully active, a browser
    // refusing the operation) no entry exists, so the next Back is the
    // shell's document navigation — intercepting it would close the layer AND
    // leave the shell never loading the URL history already moved to.
    if (drilldownHistoryToken !== null) releaseChildBack ??= registerBackInterceptor(event => {
      if (!child) return false;
      // Only the pop that leaves the drill-down's own entry is this layer's
      // to consume. Landing ON that entry means something pushed above it was
      // popped — a TOC anchor, a document opened from inside the transcript —
      // and that back press belongs to the shell's handling, with the layer
      // staying up. Matched by the token this open minted, never by the mere
      // presence of a marker: a marker on some other entry is a leftover
      // (from before a reload, or an entry buried below ours) and a pop
      // landing there closes the layer like any other.
      const flag = (event.state as { chatDrilldown?: unknown } | null)?.chatDrilldown;
      if (drilldownHistoryToken !== null && flag === drilldownHistoryToken) return false;
      closeChildConversation(true);
      return true;
    });
    if (drilldownTitle) drilldownTitle.textContent = label;
    drilldown.hidden = false;
    surface.setAttribute("data-chat-drilldown", "open");
    // A request the parent is waiting on is no longer reachable behind the
    // pushed screen, so the pill stops deferring to it.
    syncRequestsJumpVisibility();
    if (!retainedProjection && chatSurfaceActive()) childRenderer.render(drilldownItems, null, expanded, declares("subagents"));
    else childRenderDirty = true;
    reconcileAnswerAfterPaint();
    // Hidden until this child's own first page says whether more exists —
    // otherwise a previous subagent's cursor would offer paging for a
    // transcript that has none.
    if (drilldownOlder) {
      drilldownOlder.hidden = true;
      drilldownOlder.disabled = false;
    }
    if (automaticRefresh && retainedProjection && childScroll) cancelForSnapshot(childScroll);
    else childScroll?.cancel();
    childAnchor.restore(retainedAnchor);
    announceChild("");
    if (!automaticRefresh) drilldownBack?.focus();
    if (outputView) return;
    void runChildRead(next, "Loading conversation...", () => openChildConversation(id, label, automaticRefresh, next.task), async signal => {
      const snapshot = await api.snapshot(id, undefined, signal);
      if (signal.aborted || generation !== childGeneration || child !== next) return;
      next.projection = projectionFromSnapshot(snapshot, []);
      announceChild(snapshot.items.length ? "" : "This subagent has not reported anything yet.");
      renderChild(false);
      next.stream = openChildStream(next, id, label, snapshot.cursor, generation);
      silentRun.follow(isLiveConversationStatus(next.projection.status));
    });
  };

  // The same paging the parent timeline offers: a subagent's transcript is
  // fetched one page at a time like any conversation, and without a way to
  // ask for the rest a long one simply began mid-story.
  drilldownOlder?.addEventListener("click", async () => {
    const open = child;
    if (!open?.projection?.olderCursor) return;
    const generation = childGeneration;
    drilldownOlder.disabled = true;
    childScroll?.beforeMutation();
    try {
      let changedHistory = false;
      await runChildRead(open, "Loading older messages...", () => {
        if (changedHistory) openChildConversation(open.conversationId, open.label, false, open.task);
        else drilldownOlder.click();
      }, async signal => {
        const page = await api.snapshot(open.conversationId, open.projection!.olderCursor, signal).catch(error => {
          changedHistory = error instanceof ChatTransportError && error.status === 409;
          throw error;
        });
        if (signal.aborted || generation !== childGeneration || child !== open || !open.projection) return;
        open.projection = prependSnapshot(open.projection, page);
        renderChild(false);
      });
    } catch (error) {
      if (generation === childGeneration && child === open) announceChild(messageOf(error), true);
    } finally {
      if (generation === childGeneration && child === open) drilldownOlder.disabled = false;
    }
  });

  drilldownBack?.addEventListener("click", () => closeChildConversation());
  drilldown?.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    closeChildConversation();
  });

  wireExpansionToggle(items, parentScroll);
  wireItemInteractions(items, () => projection, { renderer, rerender: () => scheduleRender(false) }, parentScroll);
  if (drilldownItems && drilldownTimeline) {
    wireExpansionToggle(drilldownItems, childScroll!);
    wireItemInteractions(drilldownItems, () => child?.projection ?? null, { renderer: childRenderer, rerender: () => renderChild(false) }, childScroll!);
  }

  const closeCommandMenu = () => {
    commandMatch = null;
    commandMenu.hidden = true;
    commandMenu.replaceChildren();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };

  const chooseCommand = (index: number) => {
    const match = commandMatch;
    const command = match?.commands[index];
    if (!match || !command) return;
    const inserted = insertCommand(input.value, match.query, command);
    input.value = inserted.value;
    input.setSelectionRange(inserted.caret, inserted.caret);
    closeCommandMenu();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  };

  // Each space-separated token of an argument hint is one unit, so the hint
  // wraps only between tokens: "[--comment]" never splits after "--", and a
  // lone "]" never lands on a line of its own (styles.css).
  const hintTokens = (hint: string) => hint.split(/\s+/).filter(Boolean)
    .map(token => `<span class="chat-command-hint-token">${escapeHtml(token)}</span>`).join(" ");

  const renderCommandMenu = () => {
    const caret = input.selectionStart ?? input.value.length;
    const querying = slashCommandQuery(input.value, caret) !== null;
    if (querying && !slashQueryActive) refreshCatalogsOnUse();
    slashQueryActive = querying;
    const next = matchingCommands(input.value, caret, commands);
    if (!next) { closeCommandMenu(); return; }
    commandMatch = next;
    commandIndex = Math.min(commandIndex, next.commands.length - 1);
    commandMenu.replaceChildren(...next.commands.map((command, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.id = `chat-command-option-${index}`;
      option.className = `chat-command-option${index === commandIndex ? " is-active" : ""}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === commandIndex));
      option.innerHTML = `<span class="chat-command-name">/${escapeHtml(command.name)}</span>${command.kind === "skill" ? `<span class="chat-command-kind">skill</span>` : ""}<span class="chat-command-hint">${hintTokens(command.argumentHint)}</span><span class="chat-command-description">${escapeHtml(command.description)}</span>`;
      option.addEventListener("pointerdown", event => event.preventDefault());
      option.addEventListener("click", () => chooseCommand(index));
      return option;
    }));
    commandMenu.hidden = false;
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-activedescendant", `chat-command-option-${commandIndex}`);
    commandMenu.querySelector<HTMLElement>(".is-active")?.scrollIntoView({ block: "nearest" });
  };

  input.addEventListener("input", () => {
    autosize(input);
    const id = activeConversationId();
    if (id) composer.edit(input.value);
    syncControls();
    renderCommandMenu();
  });
  input.addEventListener("keydown", event => {
    if (commandMatch && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      commandIndex = (commandIndex + (event.key === "ArrowDown" ? 1 : -1) + commandMatch.commands.length) % commandMatch.commands.length;
      renderCommandMenu();
      return;
    }
    if (commandMatch && (event.key === "Tab" || event.key === "Enter" && document.documentElement.dataset.uiMode !== "touch") && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      chooseCommand(commandIndex);
      return;
    }
    if (commandMatch && event.key === "Escape") { event.preventDefault(); closeCommandMenu(); return; }
    // ⌥Enter explicitly queues, only while
    // the choice exists; otherwise it is an ordinary Enter.
    if (event.key === "Enter" && event.altKey && !event.shiftKey && !event.isComposing && deliveryChoiceOffered()) {
      event.preventDefault();
      requestedDelivery = "queue";
      form.requestSubmit();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing
      && (event.metaKey || event.ctrlKey || document.documentElement.dataset.uiMode !== "touch")) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  // Answering is editing inside a request card. It is derived here rather
  // than in CSS because only the focus path knows which control took focus,
  // and it is the one state that hands the transcript the whole visible band.
  let heldAnswerField: HTMLElement | null = null;
  // A snapshot replaces automatic work, not the reader's focus intent. By
  // contrast pause/latest/navigation intentionally release that intent and
  // must keep the focus identity latched until focus actually changes.
  const cancelForSnapshot = (owner: CoordinatedScrollOwner) => {
    const field = heldAnswerField;
    const restore = field && owner.isHolding(field);
    // cancel restores the hold's original follow intent without scheduling;
    // the replacement hold must inherit that rather than a reveal's pause.
    owner.cancel();
    if (restore && field.isConnected && document.activeElement === field && chatSurfaceActive()) {
      holdInOwningTimeline(field);
    }
  };
  const syncEditingFocus = () => {
    const active = document.activeElement;
    const editing = surface.contains(active) && isTextEditingControl(active);
    document.documentElement.toggleAttribute("data-chat-editing", editing);
    document.documentElement.toggleAttribute("data-chat-input-focused", active === input);
    const answering = editing && Boolean((active as Element).closest?.(".chat-request, [data-question-form]"));
    document.documentElement.toggleAttribute("data-chat-answering", answering);
    // Focus identity, not the answering boolean, owns the hold: two request
    // fields can hand focus directly to one another, including across owners.
    // Ordinary viewport corrections only reveal; they must not renew a hold
    // that an explicit gesture released.
    const next = answering && chatSurfaceActive() && active instanceof HTMLElement ? active : null;
    if (next !== heldAnswerField) {
      if (heldAnswerField) releaseHeldTimelines();
      heldAnswerField = next;
      if (next) holdInOwningTimeline(next);
    }
    viewport.apply();
  };
  reconcileAnswerAfterPaint = () => {
    if (heldAnswerField && !surface.contains(heldAnswerField)) syncEditingFocus();
  };
  surface.addEventListener("focusin", syncEditingFocus);
  surface.addEventListener("focusout", () => queueMicrotask(syncEditingFocus));
  send.addEventListener("mousedown", keepTouchComposerFocus);
  attachButton?.addEventListener("mousedown", keepTouchComposerFocus);
  const holdVisual = document.createElement("span");
  holdVisual.className = "chat-hold-upward";
  holdVisual.setAttribute("aria-hidden", "true");
  holdVisual.hidden = true;
  const holdCap = document.createElement("span");
  holdCap.className = "chat-hold-cap";
  holdVisual.append(holdCap);
  const holdOrigin = document.createElement("span");
  holdOrigin.className = "chat-hold-origin";
  holdOrigin.setAttribute("aria-hidden", "true");
  holdOrigin.inert = true;
  // A viewport-owned visual cannot be clipped by the composer or work sheet.
  // The inert, zero-size probe shares its fixed containing block, but never
  // moves with the envelope. Keep both nodes under the same lifecycle owner.
  const mountHoldPortal = () => {
    if (!holdOrigin.isConnected) document.body.append(holdOrigin);
    if (!holdVisual.isConnected) document.body.append(holdVisual);
  };
  mountHoldPortal();
  let holdPointer: number | null = null;
  let holdBounds: DOMRect | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holdArmTimer: ReturnType<typeof setTimeout> | null = null;
  let holdFrame = 0;
  let suppressPointerClick = false;
  let ownedSpace = false;
  let requestedByHold = false;
  const submitDelivery = (delivery: MessageDelivery) => {
    requestedDelivery = delivery;
    form.requestSubmit();
  };
  const hold = new HoldToQueue(() => {
    if (!projection || send.disabled || composer.submitting || cancelling || document.hidden || !document.hasFocus()) return null;
    const box = send.getBoundingClientRect();
    return JSON.stringify([selectionGeneration, projection.conversationId, input.value,
      currentPendingAttachments(), composer.uploading(projection.conversationId), displayedConfiguration(),
      box.left, box.top, box.width, box.height]);
  }, delivery => { requestedByHold = delivery === "queue"; submitDelivery(delivery); });
  const clearHoldVisual = () => {
    if (holdTimer !== null) clearTimeout(holdTimer);
    if (holdArmTimer !== null) clearTimeout(holdArmTimer);
    holdTimer = null;
    holdArmTimer = null;
    cancelAnimationFrame(holdFrame);
    holdVisual.hidden = true;
    send.classList.remove("is-holding");
  };
  const cancelHold = () => {
    hold.cancel();
    clearHoldVisual();
    const pointer = holdPointer;
    holdPointer = null;
    holdBounds = null;
    if (pointer !== null && send.hasPointerCapture(pointer)) send.releasePointerCapture(pointer);
  };
  const paintHold = () => {
    const now = performance.now();
    const progress = hold.progress(now);
    if (progress === null) { clearHoldVisual(); return; }
    if (progress === 1) { hold.check(now); clearHoldVisual(); return; }
    const box = send.getBoundingClientRect();
    // Read the stable fixed origin in the same client coordinate space
    // as Send. Embedded WebKit can report client rects relative to the visual
    // viewport while fixed CSS coordinates still use the layout viewport.
    // Copying box.top directly then applies the keyboard pan a second time.
    // Read before any paint writes: resetting the visible portal to zero
    // first would synchronously flush layout on every animation frame.
    const origin = holdOrigin.getBoundingClientRect();
    const viewportTop = (window.visualViewport?.offsetTop ?? 0) + origin.top;
    // The full envelope appears only after arming. Its bounds stay fixed;
    // only the green fill advances, with room reserved above the finger.
    const extension = Math.min(104, Math.max(0, box.top - viewportTop - 8));
    holdVisual.style.width = `${box.width}px`;
    holdVisual.style.height = `${box.height + extension}px`;
    holdVisual.style.left = `${box.left - origin.left}px`;
    holdVisual.style.top = `${box.top - extension - origin.top}px`;
    holdVisual.style.setProperty("--hold-progress", String(progress));
    holdCap.textContent = `${isLiveConversationStatus(projection?.status) ? "Queue" : "Send"}\n${((1 - progress) * HOLD_COUNTDOWN_MS / 1000).toFixed(1)}s`;
    holdVisual.hidden = false;
    send.classList.add("is-holding");
    holdFrame = requestAnimationFrame(paintHold);
  };
  const armHoldVisual = () => {
    // Keep intent/geometry guards live during the silent delay too. A target
    // that moves away and back must not turn an invalid gesture into a tap.
    const validateArming = () => {
      if (hold.progress(performance.now()) === null) { clearHoldVisual(); return; }
      holdFrame = requestAnimationFrame(validateArming);
    };
    holdFrame = requestAnimationFrame(validateArming);
    holdArmTimer = setTimeout(() => {
      holdArmTimer = null;
      cancelAnimationFrame(holdFrame);
      paintHold();
    }, HOLD_ARM_MS);
    holdTimer = setTimeout(() => { hold.check(performance.now()); clearHoldVisual(); }, HOLD_TOTAL_MS);
  };
  send.addEventListener("pointerdown", event => {
    suppressPointerClick = false;
    if (!sendSupportsHold()) return;
    mountHoldPortal();
    if (!event.isPrimary || event.button !== 0 || !hold.begin(event.pointerId, performance.now())) return;
    event.preventDefault(); // Keep the composing field and mobile keyboard owned.
    suppressPointerClick = true;
    holdPointer = event.pointerId;
    holdBounds = send.getBoundingClientRect();
    send.setPointerCapture(event.pointerId);
    armHoldVisual();
  });
  send.addEventListener("pointermove", event => {
    if (event.pointerId !== holdPointer) return;
    const box = holdBounds;
    if (!box) return;
    if (event.clientX < box.left || event.clientX >= box.right || event.clientY < box.top || event.clientY >= box.bottom) cancelHold();
  });
  send.addEventListener("pointerup", event => {
    if (event.pointerId !== holdPointer) return;
    hold.release(event.pointerId, performance.now());
    cancelHold();
  });
  send.addEventListener("pointercancel", cancelHold);
  send.addEventListener("lostpointercapture", cancelHold);
  send.addEventListener("contextmenu", event => event.preventDefault());
  send.addEventListener("click", event => {
    event.preventDefault();
    if (event.detail > 0 && suppressPointerClick) { suppressPointerClick = false; return; }
    if (holdPointer !== null) { cancelHold(); return; }
    submitDelivery("steer");
  });
  send.addEventListener("keydown", event => {
    if (event.key === " " && !event.repeat) ownedSpace = false;
    if (event.key === " " && sendSupportsHold()) {
      event.preventDefault();
      ownedSpace = true;
      mountHoldPortal();
      if (event.repeat || holdPointer !== null || !hold.begin(-1, performance.now())) return;
      holdPointer = -1;
      armHoldVisual();
    } else if (event.repeat && event.key === "Enter") event.preventDefault();
  });
  send.addEventListener("keyup", event => {
    if (event.key !== " " || !ownedSpace) return;
    ownedSpace = false;
    event.preventDefault(); // Suppress Space's native click, including after Escape.
    if (holdPointer !== -1) return;
    hold.release(-1, performance.now());
    cancelHold();
  });
  send.addEventListener("blur", () => { if (holdPointer === -1) cancelHold(); });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || holdPointer === null) return;
    event.preventDefault(); event.stopImmediatePropagation(); cancelHold();
  }, true);
  window.addEventListener("blur", cancelHold);
  window.addEventListener("pagehide", () => {
    cancelHold();
    holdOrigin.remove();
    holdVisual.remove();
  });
  window.addEventListener("pageshow", mountHoldPortal);
  document.addEventListener("visibilitychange", cancelHold);
  input.addEventListener("input", cancelHold);
  // Mobile browsers can adjust a gap tap onto a nearby button. Use the raw
  // touch coordinates (click/pointer coordinates may already be adjusted)
  // to suppress only these misses; actual controls keep their native events.
  sendGroup?.addEventListener("touchstart", event => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0]!;
    const hit = [...sendGroup.querySelectorAll("button")].some(button => {
      const box = button.getBoundingClientRect();
      return touch.clientX >= box.left && touch.clientX < box.right
        && touch.clientY >= box.top && touch.clientY < box.bottom;
    });
    if (!hit) { event.preventDefault(); cancelHold(); }
  }, { passive: false });
  stop?.addEventListener("mousedown", keepTouchComposerFocus);
  stop?.addEventListener("click", async () => {
    if (!projection || !isLiveConversationStatus(projection.status) || cancelling) return;
    // Captured for the round trip: a failure landing after a switch belongs
    // to the conversation whose turn was being cancelled.
    const conversationId = projection.conversationId;
    if (document.documentElement.dataset.uiMode === "touch" && hasLiveWorkers()) {
      if (!await confirmChatAction("Stop parent?", "Stops the parent and its still-blocking foreground work. Detached workers continue; their later notifications can wake the parent again.", "Stop parent", stop)) return;
      if (projection?.conversationId !== conversationId || !isLiveConversationStatus(projection.status) || cancelling) return;
    }
    cancelling = true;
    setComposerError(null, conversationId);
    noteComposer("Cancelling...");
    syncControls();
    try { await api.cancel(conversationId, newRequestId()); }
    catch (error) {
      const message = messageOf(error);
      announce(message, true);
      setComposerError(`Cancellation failed: ${message}`, conversationId);
    }
    finally { cancelling = false; syncControls(); }
  });

  const runHistoryOperation = (operation: HistoryOperation, conversationId: string, messageId?: string) => composer.history(operation, conversationId, messageId);

  const asideButton = document.querySelector<HTMLButtonElement>("#chat-aside-ready");
  const asideDialog = document.querySelector<HTMLDialogElement>("#chat-aside-dialog");
  const asideContent = asideDialog?.querySelector<HTMLElement>("#chat-aside-answer");
  // Page-local reading state, keyed by conversation and answer identity. A new
  // answer starts at the top; minimising never admits a prompt or loses text.
  const asidePositions = new Map<string, { answer: unknown; top: number }>();
  let paintedAside: unknown;
  let restoreAsideFocus = false;
  function minimiseAside(reason = "") {
    if (!asideDialog?.open) return;
    const id = asideDialog.dataset.conversation;
    if (id) boundedSet(asidePositions, id, { answer: paintedAside, top: asideDialog.scrollTop }, 200);
    restoreAsideFocus = reason !== "mode" && asideDialog.contains(document.activeElement);
    asideDialog.close(reason);
  }
  // A native modal/nonmodal dialog cannot change modality in place. Hide on
  // the shell's real mode event; deliberate reopening chooses the new mode
  // while retaining the answer/offset, without taking over shell focus.
  onUiModeChange(() => { minimiseAside("mode"); scheduleRender(); });
  if (asideContent) wireItemInteractions(asideContent,
    () => asideDialog?.open && asideDialog.dataset.conversation === projection?.conversationId ? projection : null,
    { renderer, rerender: () => scheduleRender(false), beforeFileNavigation: () => minimiseAside("file") }, parentScroll);
  const syncAsideViewport = () => {
    if (!asideDialog?.open) return;
    const viewport = window.visualViewport;
    asideDialog.style.setProperty("--chat-aside-top", `${(viewport?.offsetTop ?? 0) + 12}px`);
    asideDialog.style.setProperty("--chat-aside-height", `${Math.max(0, (viewport?.height ?? window.innerHeight) - 24)}px`);
    asideDialog.style.setProperty("--chat-aside-window-height", `${Math.max(0, (viewport?.height ?? window.innerHeight) - 72)}px`);
    asideDialog.style.setProperty("--chat-aside-bottom", `${(viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - 12}px`);
  };
  window.visualViewport?.addEventListener("resize", syncAsideViewport);
  window.visualViewport?.addEventListener("scroll", syncAsideViewport);
  window.addEventListener("resize", syncAsideViewport);
  asideButton?.addEventListener("mousedown", keepTouchComposerFocus);
  asideButton?.addEventListener("click", () => {
    const id = activeConversationId();
    const answer = id ? composer.sideAnswer(id) : undefined;
    if (!projection || !answer || !asideDialog) return;
    asideDialog.querySelector("#chat-aside-question")!.textContent = answer.question;
    const content = asideDialog.querySelector<HTMLElement>("#chat-aside-answer")!;
    content.classList.add("markdown-body");
    const text = answer.text.trim() || "No text answer returned. The model may have attempted a tool call; side answers do not execute tools.";
    if (answer.failed) content.textContent = text;
    else {
      content.innerHTML = renderChatMarkdown(text);
      decorateFileLinks(content);
    }
    asideDialog.dataset.conversation = id!;
    asideDialog.returnValue = "";
    paintedAside = answer;
    const nonmodal = document.documentElement.dataset.uiMode === "desktop";
    asideDialog.dataset.presentation = nonmodal ? "window" : "modal";
    asideDialog.setAttribute("aria-modal", String(!nonmodal));
    // Native close restoration belongs to the deliberate invoker, not the
    // touch draft whose focus mousedown preserved until reader activation.
    asideButton.focus({ preventScroll: true });
    if (nonmodal) asideDialog.show(); else asideDialog.showModal();
    syncAsideViewport();
    document.querySelector<HTMLElement>("#chat-aside-close")?.focus({ preventScroll: true });
    const saved = asidePositions.get(id!);
    asideDialog.scrollTop = saved?.answer === answer ? saved.top : 0;
  });
  document.querySelector("#chat-aside-close")?.addEventListener("click", () => minimiseAside());
  asideDialog?.addEventListener("cancel", event => { event.preventDefault(); minimiseAside(); });
  asideDialog?.addEventListener("keydown", event => {
    if (event.key === "Escape" && asideDialog.dataset.presentation === "window") {
      event.preventDefault(); event.stopPropagation(); minimiseAside();
    }
  });
  asideDialog?.addEventListener("close", () => {
    const focused = document.activeElement;
    const mayRestore = focused === document.body || focused === asideButton || asideDialog.contains(focused);
    if (restoreAsideFocus && mayRestore && asideDialog.returnValue !== "file" && asideDialog.dataset.conversation === activeConversationId() && asideButton && !asideButton.hidden) asideButton.focus({ preventScroll: true });
    restoreAsideFocus = false;
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    // Every submission path, including requestSubmit from keyboard shortcuts,
    // shares the cancellation lock. Consume the one-shot override even when
    // refusing this attempt, and keep accepted submissions' delivery local
    // across awaits (such as attachment staging).
    const submissionDelivery = requestedDelivery;
    const submissionByHold = requestedByHold;
    requestedByHold = false;
    requestedDelivery = undefined;
    await composer.submit({ delivery: submissionDelivery, byHold: submissionByHold });
  });
  const workDock = document.querySelector<HTMLElement>("#chat-work-dock");
  // Secondary native disclosures can change their content without changing
  // their capped outer box, so ResizeObserver alone cannot discover opening.
  workDock?.addEventListener("toggle", () => {
    syncQueueOverflow();
    syncDesktopWorkLayout();
  }, true);
  const prioritizeWorkPane = (event: Event) => {
    const target = event.target as Element | null;
    // Header geometry can move when priority changes. Finish the native tap
    // before reallocating it, otherwise pointerup lands on a different row.
    if (event.type !== "click" && target?.closest("summary, .chat-queue-header")) return;
    if (target?.closest("#chat-queue")) workDock?.setAttribute("data-work-active", "queue");
    else if (target?.closest("#chat-compact-workers")) workDock?.setAttribute("data-work-active", "workers");
    else if (target?.closest("#chat-reverted, #chat-task-list, #chat-scheduled-wakeups")) workDock?.setAttribute("data-work-active", "history");
    syncQueueOverflow();
  };
  workDock?.addEventListener("pointerdown", prioritizeWorkPane);
  workDock?.addEventListener("focusin", prioritizeWorkPane);
  workDock?.addEventListener("click", prioritizeWorkPane, true);
  function measureSurfaceChromeHeight(container: HTMLElement, dock: HTMLElement, inset: number, transcript?: Element) {
    return [...container.children].reduce((height, child) => {
      if (child === dock || (transcript ? child === transcript : child.classList.contains("chat-transcript-area"))) return height;
      const css = getComputedStyle(child);
      if (css.display === "none" || ["absolute", "fixed"].includes(css.position)) return height;
      return height + child.getBoundingClientRect().height + (parseFloat(css.marginTop) || 0) + (parseFloat(css.marginBottom) || 0);
    }, inset);
  }
  function syncExpandedWorkBudget(dock: HTMLElement, minimumWork: number) {
    if (!surface || !queueDockElement || typeof getComputedStyle !== "function") return;
    const overlay = document.documentElement.hasAttribute("data-chat-work-expanded");
    const expanded = !!compactWorkersList?.open && !compactWorkersList.hidden
      || !queueDockElement.hidden && queueDockElement.dataset.expanded === "true";
    dock.toggleAttribute("data-work-content-expanded", expanded);
    if (!expanded && !overlay) {
      dock.style.removeProperty("--chat-work-expanded-capacity");
      surface.style.removeProperty("--chat-expanded-reading");
      return;
    }
    const css = getComputedStyle(surface);
    const fixed = measureSurfaceChromeHeight(surface, dock, (parseFloat(css.paddingTop) || 0) + (parseFloat(css.paddingBottom) || 0));
    const compactDesktop = document.documentElement.dataset.uiMode === "desktop" && window.matchMedia("(pointer: fine) and (hover: hover)").matches;
    const { reading, capacity: inlineCapacity } = expandedWorkBudget(surface.clientHeight - fixed, minimumWork, compactDesktop ? "desktop" : "comfortable");
    const capacity = overlay && form
      ? Math.max(0, form.getBoundingClientRect().top - surface.getBoundingClientRect().top)
      : inlineCapacity;
    for (const [element, property, value] of [
      [dock, "--chat-work-expanded-capacity", capacity],
      [dock, "--chat-work-hard-available", overlay ? capacity : Math.max(0, surface.clientHeight - fixed)],
      [surface, "--chat-expanded-reading", reading],
    ] as const) {
      const pixels = `${value}px`;
      if (element.style.getPropertyValue(property) !== pixels) element.style.setProperty(property, pixels);
    }
  }
  function syncDesktopWorkLayout() {
    if (!surface || !form || !input || typeof getComputedStyle !== "function") return;
    const root = document.documentElement;
    const dock = surface.querySelector<HTMLElement>("#chat-work-dock");
    const toggle = surface.querySelector<HTMLButtonElement>("#chat-work-toggle");
    const close = surface.querySelector<HTMLButtonElement>("#chat-work-close");
    const transcript = surface.querySelector<HTMLElement>(".chat-transcript-area");
    if (!dock || !toggle || !close || !transcript) return;
    const desktop = root.dataset.uiMode === "desktop";
    if (!desktop) {
      for (const attribute of ["data-chat-has-work", "data-chat-work-constrained", "data-chat-work-expanded"]) root.removeAttribute(attribute);
      toggle.hidden = close.hidden = true;
      return;
    }
    if (!dock.hasAttribute("data-work-content-expanded") && !root.hasAttribute("data-chat-work-expanded")) dock.style.removeProperty("--chat-work-hard-available");
    dock.style.removeProperty("--chat-work-available");
    const hasWork = [...dock.children].some(child => child !== close && !(child as HTMLElement).hidden && getComputedStyle(child).display !== "none");
    root.toggleAttribute("data-chat-has-work", hasWork);
    const fixed = measureSurfaceChromeHeight(surface, dock, 0, transcript);
    const floor = dock.hasAttribute("data-work-content-expanded")
      ? parseFloat(surface.style.getPropertyValue("--chat-expanded-reading")) || 0
      : parseFloat(getComputedStyle(transcript).minHeight) || 0;
    const minimum = Math.max(52, parseFloat(dock.style.getPropertyValue("--chat-work-full-floor")) || 0);
    const constrained = hasWork && surface.clientHeight - fixed - floor < minimum;
    root.toggleAttribute("data-chat-work-constrained", constrained);
    if (!constrained) {
      root.removeAttribute("data-chat-work-expanded");
      if (document.activeElement === close) (dock.querySelector<HTMLElement>("[data-inspect-task]") ?? input).focus({ preventScroll: true });
    }
    const open = constrained && root.hasAttribute("data-chat-work-expanded");
    toggle.hidden = !constrained || open;
    close.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (desktop) {
      dock.style.setProperty("--chat-workers-bottom", `${surface.getBoundingClientRect().bottom - form.getBoundingClientRect().top}px`);
    }
  }
  const expandDesktopWork = (focus = true) => {
    if (!document.documentElement.hasAttribute("data-chat-work-constrained")) return;
    document.documentElement.setAttribute("data-chat-work-expanded", "");
    syncDesktopWorkLayout();
    syncQueueOverflow();
    if (focus) surface.querySelector<HTMLElement>("#chat-work-close")?.focus({ preventScroll: true });
  };
  const closeDesktopWork = () => {
    document.documentElement.removeAttribute("data-chat-work-expanded");
    syncDesktopWorkLayout();
    syncQueueOverflow();
    surface.querySelector<HTMLElement>("#chat-work-toggle")?.focus({ preventScroll: true });
  };
  surface.querySelector("#chat-work-toggle")?.addEventListener("click", () => expandDesktopWork());
  surface.querySelector("#chat-work-close")?.addEventListener("click", closeDesktopWork);
  workDock?.addEventListener("chat-work-reveal", () => {
    syncQueueOverflow();
    syncDesktopWorkLayout();
    expandDesktopWork(false);
  });
  const revealWorkFocus = () => {
      const focused = document.activeElement as HTMLElement | null;
      if (!focused || !focused.closest("#chat-compact-workers-items, .chat-queue-content, #chat-reverted-items, #chat-task-list-items, #chat-scheduled-wakeups-items") || !workDock?.contains(focused)) return;
      const css = getComputedStyle(focused);
      const ring = (parseFloat(css.outlineWidth) || 0) + Math.max(0, parseFloat(css.outlineOffset) || 0);
      // Native focus scrolling exposes the border box, not its exterior ring.
      // Correct only this explicit focus move, inside each work scroller.
      for (let parent = focused.parentElement; parent; parent = parent.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) {
          const box = focused.getBoundingClientRect();
          const top = parent.getBoundingClientRect().top + parent.clientTop;
          const bottom = parent.getBoundingClientRect().top + parent.clientTop + parent.clientHeight - 1;
          if (box.top - ring < top) parent.scrollTop += Math.floor(box.top - ring - top);
          else if (box.bottom + ring > bottom) parent.scrollTop += Math.ceil(box.bottom + ring - bottom);
        }
        if (parent === workDock) break;
      }
  };
  workDock?.addEventListener("focusin", () => {
    if (document.activeElement?.closest("#chat-compact-workers-items, .chat-queue-content")) {
      dockGrowth?.cancel();
      dockGrowth = null;
    }
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(revealWorkFocus));
  });
  surface.addEventListener("keydown", event => {
    if (event.key === "Escape" && !event.defaultPrevented && document.documentElement.hasAttribute("data-chat-work-expanded")) {
      if (surface.querySelector('dialog[open]:not([data-presentation="window"]), #chat-drilldown:not([hidden])')) return;
      event.preventDefault(); event.stopPropagation(); closeDesktopWork();
    }
  });
  let dockHeight: number | null = null;
  let dockGrowth: Animation | null = null;
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
    if (workDock && document.documentElement.dataset.uiMode === "touch" && !workDock.hasAttribute("data-work-content-expanded")) {
      // Text enlargement can make fixed chrome taller than its percentage
      // budget. Secondary work yields before the primary composer does.
      const visualHeight = window.visualViewport?.height ?? window.innerHeight;
      const readingBudget = visualHeight * (surface.clientWidth >= 768 && !document.documentElement.hasAttribute("data-chat-wide-short") ? 0.35 : 0.4);
      // clientHeight includes safe-area padding. Count all in-flow chrome, not
      // just header/composer, so removing a sheet cannot spend the reading floor.
      const css = getComputedStyle(surface);
      const fixed = measureSurfaceChromeHeight(surface, workDock, (parseFloat(css.paddingTop) || 0) + (parseFloat(css.paddingBottom) || 0));
      // Enlarged replacement safety already permits the reading floor to
      // yield: its complete warning/batch controls must remain scroll-reachable.
      // Ordinary enlarged pending work and standard text retain their floor.
      const enlargedReplacement = parseFloat(getComputedStyle(document.documentElement).fontSize) > 16
        && queueDockElement.querySelector(".chat-queue-note.is-replacement:not([hidden])") !== null;
      const available = `${Math.max(0, surface.clientHeight - fixed - (enlargedReplacement ? 48 : Math.max(48, readingBudget)))}px`;
      if (workDock.style.getPropertyValue("--chat-work-available") !== available) workDock.style.setProperty("--chat-work-available", available);
      const hardAvailable = `${Math.max(0, surface.clientHeight - fixed)}px`;
      if (workDock.style.getPropertyValue("--chat-work-hard-available") !== hardAvailable) workDock.style.setProperty("--chat-work-hard-available", hardAvailable);
    }
    // Consume this surface's current capacity, not the zero-size measurement
    // retained while another touch tab hid it. No further resize is guaranteed
    // after restoring the budget, so overflow must settle in this same pass.
    syncQueueOverflow();
    syncDesktopWorkLayout();
    restorePendingScroll();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(revealWorkFocus);
    if (workDock && !dockGrowth) {
      const height = workDock.getBoundingClientRect().height;
      const previous = dockHeight;
      dockHeight = height;
      if (previous !== null && height > previous + 1
        && document.documentElement.dataset.uiMode === "touch"
        && !document.activeElement?.closest("#chat-compact-workers-items, .chat-queue-content")
        && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        // Reserve the final bounded height before revealing new chrome. An
        // animated layout height interleaves native scroll clamps with prompt
        // echo removal and can mistake those clamps for reader movement.
        dockGrowth = workDock.animate({ clipPath: [`inset(0 0 ${height - previous}px 0)`, "inset(0)"] }, { duration: 160, easing: "ease-out" });
        dockGrowth.onfinish = () => { dockGrowth = null; parentScroll.request(); };
      }
    }
    if (!chatSurfaceActive()) return;
    parentScroll.request();
    childScroll?.request();
  }) : null;
  observer?.observe(items);
  // A hidden constrained dock cannot signal panel resizing itself.
  observer?.observe(surface);
  observer?.observe(timeline);
  observer?.observe(queueDockElement);
  observer?.observe(form);
  const chatHeader = surface.querySelector<HTMLElement>(".chat-header");
  if (chatHeader) observer?.observe(chatHeader);
  if (workDock) observer?.observe(workDock);
  if (drilldownItems) observer?.observe(drilldownItems);
  if (drilldownTimeline) observer?.observe(drilldownTimeline);
  // Only the day being read keeps its pinned label; see pinned-day.ts.
  watchPinnedDayLabels(timeline, items);
  if (drilldownItems && drilldownTimeline) watchPinnedDayLabels(drilldownTimeline, drilldownItems);
  viewport.start();
  // The draft is saved on every hide, persisted or not: a frozen page can be
  // discarded later without ever running code again. Nothing else happens
  // here. This surface is never torn down on a lifecycle event — iOS fires an
  // unpersisted `pagehide` for a home-screen page it then keeps alive, and a
  // torn-down Chat would stay closed for the life of that document. The
  // hidden-page path (`handleChatSurfaceState`) already cancels the timers
  // and frames; the page's one channel releases the socket and keeps every
  // subscription, so a return resumes the streams from where they stopped.
  window.addEventListener("pagehide", () => {
    flushSave();
  });

  // Bootstrap is deferred until Chat is actually the active surface: status()
  // lazily launches the OpenCode server, and merely opening Preview, Files, or
  // Terminal must not pay that cost. A restored Chat surface bootstraps
  // immediately via the initial surface-state check. Failures — a stale PWA
  // cookie 401, a transient status error — leave the bootstrap re-runnable:
  // it retries on the next Chat activation and on credential refresh.
  let bootstrapped = false;
  let bootstrapping = false;
  let bootstrapRead: number | null = null;

  /**
   * Loads (or reuses) one agent's catalogs and installs them as the
   * selected-agent view. Capability-gated per agent: an undeclared catalog
   * is an empty list, never a request.
   */
  const applyAgentContext = async (agentId: string | undefined): Promise<void> => {
    const status = agentStatusFor(agentId) ?? agentStatuses[0];
    contextAgentId = status?.agent.id;
    renderLoginNotice();
    models = [];
    modes = [];
    commands = [];
    commandInventoryAvailable = false;
    catalogLoading = Boolean(status && status.availability.state !== "unavailable");
    configurationTrigger.disabled = catalogLoading || !projection;
    agent = status?.availability.state === "ready" ? status.availability.agent : undefined;
    if (status && agent?.capabilities.includes("usage")) seedUsage(status.agent.id);
    nameAgent();
    applyCapabilities();
    document.querySelectorAll(".chat-unavailable").forEach(panel => panel.remove());
    if (!status) return;
    if (status.availability.state === "unavailable") {
      showUnavailable(status.agent.id, status.availability, { takeover: false });
      return;
    }
    let catalogs = agentCatalogs.get(status.agent.id);
    if (!catalogs) {
      const chatAgent = agent;
      const has = (capability: ChatCapability) => chatAgent?.capabilities.includes(capability) ?? true;
      const wantsCommands = has("commands") || has("reversible-history");
      let loading = agentCatalogLoads.get(status.agent.id);
      if (!loading) {
      loading = Promise.all([
        has("models") ? api.models(status.agent.id).catch(() => [] as ChatModel[]) : Promise.resolve([] as ChatModel[]),
        wantsCommands ? api.commands(status.agent.id).then(list => ({ list, ok: true })).catch(() => ({ list: [] as ChatCommand[], ok: false })) : Promise.resolve({ list: [] as ChatCommand[], ok: true }),
        has("modes") ? api.modes(status.agent.id).catch(() => [] as ChatMode[]) : Promise.resolve([] as ChatMode[]),
      ]).then(([nextModels, nextCommands, nextModes]) => ({ models: nextModels, modes: nextModes, commands: nextCommands.list, commandInventoryAvailable: nextCommands.ok }));
      agentCatalogLoads.set(status.agent.id, loading);
      void loading.finally(() => agentCatalogLoads.delete(status.agent.id));
      }
      catalogs = await loading;
      // The awaited fetch may resolve after the user moved to another
      // agent's conversation; installing these lists then would dress that
      // conversation in this agent's catalog (a Claude "Default" chip on an
      // OpenCode conversation).
      if (contextAgentId !== status.agent.id) return;
      // A failed command read is not banked: the next context switch
      // retries. Neither is an empty list from an agent that declares the
      // capability — its inventory may simply not have hydrated yet, and
      // banking would hide every command for the rest of the page's life.
      if (catalogs.commandInventoryAvailable && (catalogs.commands.length > 0 || !has("commands"))) agentCatalogs.set(status.agent.id, catalogs);
    }
    models = catalogs.models;
    modes = catalogs.modes;
    commands = catalogs.commands;
    commandInventoryAvailable = catalogs.commandInventoryAvailable;
    catalogLoading = false;
    form.hidden = false;
    renderConfiguration();
    syncContextIndicator();
    syncControls();
    refreshCatalogRevision(status.agent.id);
  };

  // Plan usage is per login: the workspace's last-known report is fetched
  // once per agent that reports it, and that agent answers the reads. One
  // agent reports it today; the last one to answer would take the reads.
  // "Seeded" means answered: a read that failed in transit is asked again
  // on the next status or context refresh, and an agent that answered 409
  // does not report usage and is not asked again.
  const seededUsage = new Set<string>();
  const usageUnsupported = new Set<string>();
  const usageSeeds = new Map<string, Promise<void>>();
  const seedUsage = (agentId: string): Promise<void> => {
    if (seededUsage.has(agentId) || usageUnsupported.has(agentId)) return Promise.resolve();
    const pending = usageSeeds.get(agentId);
    if (pending) return pending;
    // Inside the chain: a client without the read (an older fake) rejects
    // like a failed read instead of throwing through the caller's bootstrap.
    const seed = Promise.resolve().then(() => api.usage(agentId)).then(report => {
      seededUsage.add(agentId);
      // The agent that holds a report answers the reads; an agent that
      // answered with nothing only takes them while no one else has. Which
      // response lands last must not decide who is asked.
      if (report || !usageReadable()) onUsageRead(mode => api.readUsage(agentId, newRequestId(), mode));
      if (report) noteUsageReport({ plan: report.plan, reportedAt: report.readAt, ...(report.conversationId ? { conversationId: report.conversationId } : {}) });
    }, error => {
      if (error instanceof ChatTransportError && error.status === 409) usageUnsupported.add(agentId);
    }).finally(() => { usageSeeds.delete(agentId); });
    usageSeeds.set(agentId, seed);
    return seed;
  };
  // An agent already up when the page loads seeds the pane before any
  // conversation is opened; one that reports ready later seeds then.
  const seedUsageFromStatuses = () => {
    for (const status of agentStatuses) {
      if (status.availability.state === "ready" && status.availability.agent?.capabilities.includes("usage")) seedUsage(status.agent.id);
    }
  };
  // An agent idle at page load has not declared anything yet, and a
  // workspace with no conversations never selects one to make it. The
  // inventory read has started every agent by the time it answers, so each
  // usable one is asked then; one that does not report usage says so once.
  const seedUsageFromInventory = () => {
    for (const status of agentStatuses) {
      if (status.availability.state !== "unavailable") void seedUsage(status.agent.id);
    }
  };

  /**
   * A selected conversation whose agent has not reported ready yet: the
   * selection itself makes the server start that agent, so poll status
   * until it lands as ready or unavailable — that is what upgrades the
   * identity row from registry name to declaration and loads the catalogs.
   * Gated on an actual selection so an untouched idle agent is never polled.
   */
  let statusRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  // The banked command inventory is the one catalog that changes
  // mid-session (agents discover skills; Claude pushes commands_changed).
  // Refreshed in the background from the idle poll and after a conversation
  // selection settles — never inside the selection or creation path itself,
  // where an in-flight read has raced the chooser before.
  // The catalogs are re-read where they are used: a ready agent has no idle
  // poll, so a page left open would otherwise keep the commands, models, and
  // modes it banked while another client's `/reload` changed them. Opening
  // a slash query or the configuration picker refreshes them in the
  // background; the open surface re-renders when the lists land. Every
  // open reads — they are user actions — and overlapping reads are safe:
  // only the latest one's answers are installed (LatestRefresh below), so
  // a read begun before another client's reload cannot outlast the one this
  // open started after it.
  const refreshCatalogsOnUse = () => {
    const agentId = contextAgentId;
    if (agentId) void refreshBankedCommands(agentId);
  };

  // Refreshes can overlap (a slash query's, then a reload's): only the
  // latest one's answers are installed, or a pre-reload list landing late
  // would overwrite the reloaded one.
  const catalogRefreshes = new LatestRefresh();
  const catalogRevisionReads = new Map<string, { bank: AgentCatalogs; revision: string; retryRequested: boolean }>();
  // Settles once every read has landed or failed. Track revision demand on
  // every refresh, including one started by a reconnect or picker action.
  const refreshBankedCommands = (agentId: string | undefined, options: { acceptEmpty?: boolean } = {}): Promise<void> => {
    if (!agentId) return Promise.resolve();
    const banked = agentCatalogs.get(agentId);
    if (!banked) return Promise.resolve();
    const revision = catalogRevisions.get(agentId);
    const revisionRead = revision === undefined ? undefined : { bank: banked, revision, retryRequested: false };
    if (revisionRead) catalogRevisionReads.set(agentId, revisionRead);
    const availability = agentStatusFor(agentId)?.availability;
    const capabilities = availability?.state === "ready" ? availability.agent?.capabilities : undefined;
    const has = (capability: ChatCapability) => capabilities?.includes(capability) ?? true;
    const latest = catalogRefreshes.begin(agentId);
    const current = () => agentCatalogs.get(agentId) === banked && latest();
    let complete = true;
    const reads: Promise<unknown>[] = [];
    if (has("commands") || has("reversible-history")) {
      reads.push(api.commands(agentId).then(list => {
        if (!current()) { complete = false; return; }
        banked.commands = list;
        banked.commandInventoryAvailable = true;
        if (contextAgentId === agentId) {
          commands = list;
          if (slashQueryActive) renderCommandMenu();
        }
      }).catch(() => { complete = false; }));
    }
    // Models change under a running page too — a Claude Code update ships
    // new entries — so the banked model list refreshes on the same cadence.
    if (has("models")) {
      reads.push(api.models(agentId).then(list => {
        if (!current() || (list.length === 0 && !options.acceptEmpty)) { complete = false; return; }
        banked.models = list;
        if (contextAgentId === agentId) {
          models = list;
          renderConfiguration();
          syncContextIndicator();
        }
      }).catch(() => { complete = false; }));
    }
    // Modes too: OpenCode's agents are its configuration, which a reload
    // (or an edit picked up on restart) changes under a running page.
    if (has("modes")) {
      reads.push(api.modes(agentId).then(list => {
        if (!current() || list.length === 0) { complete = false; return; }
        banked.modes = list;
        if (contextAgentId === agentId) {
          modes = list;
          renderConfiguration();
        }
      }).catch(() => { complete = false; }));
    }
    return Promise.all(reads).then(() => {
      const stillCurrent = current();
      if (stillCurrent && complete && reads.length > 0 && revision !== undefined) banked.catalogRevision = revision;
      if (!revisionRead || catalogRevisionReads.get(agentId) !== revisionRead) return;
      catalogRevisionReads.delete(agentId);
      // One retry consumes all matching invalidations received during this
      // attempt. Failure alone never creates more work or an automatic loop.
      if (stillCurrent && !complete && revisionRead.retryRequested && catalogRevisions.get(agentId) === revision) refreshCatalogRevision(agentId);
    });
  };

  const refreshCatalogRevision = (agentId: string): void => {
    const bank = agentCatalogs.get(agentId);
    const revision = catalogRevisions.get(agentId);
    if (!bank || revision === undefined || bank.catalogRevision === revision) return;
    const inflight = catalogRevisionReads.get(agentId);
    if (inflight?.bank === bank && inflight.revision === revision) {
      inflight.retryRequested = true;
      return;
    }
    void refreshBankedCommands(agentId);
  };

  const refreshIdleAgentContext = () => {
    if (statusRefreshTimer !== null) return;
    statusRefreshTimer = setTimeout(async () => {
      statusRefreshTimer = null;
      const watching = contextAgentId;
      if (!watching || conversationAgentId(presentation.selectedId) !== watching) return;
      try {
        setAgentStatuses(await api.status());
      } catch {
        return;
      }
      if (contextAgentId !== watching) return;
      await applyAgentContext(watching);
      refreshBankedCommands(watching);
      const state = agentStatusFor(watching)?.availability.state;
      if (state === "idle" || state === "starting") refreshIdleAgentContext();
    }, 1_500);
  };

  const startInventoryStream = () => {
    if (inventoryStream) return;
    try {
      inventoryStream = api.inventoryStream({
        // A tick may also mean a login changed (Agent accounts): status is
        // in-memory on the server, so it is re-read alongside the inventory.
        invalidation: event => {
          void inventoryReconciler.request(); rereadStatuses();
          for (const [agentId, revision] of Object.entries(event.catalogs ?? {})) {
            catalogRevisions.set(agentId, revision);
            refreshCatalogRevision(agentId);
          }
        },
        error: error => interruptions.report("inventory", error),
        recovered: () => { interruptions.clear("inventory"); refreshCatalogsOnUse(); },
      });
    } catch (error) {
      announce(messageOf(error), true);
    }
  };

  // The unavailable state is the whole point of this surface when OpenCode will
  // not start: it has to carry enough evidence to diagnose the failure from a
  // pasted bug report, and offer the retry that makes a fixed environment
  // recoverable without restarting the workspace.
  const showUnavailable = (agentId: string, availability: Extract<ChatAvailability, { state: "unavailable" }>, options: { takeover: boolean }) => {
    form.hidden = true;
    // A takeover means no agent can serve at all. One agent being down must
    // not block conversations with another, so the chooser and creation stay
    // usable outside the takeover case (spec: one agent's outage does not
    // block another).
    if (options.takeover) {
      select.disabled = true;
      newButton.disabled = true;
    }
    const agentName = agentStatusFor(agentId)?.agent.name ?? agentId;
    announce(`${agentName}: ${availability.message}`, true);

    const panel = document.createElement("div");
    panel.className = "chat-unavailable";
    // The panel names its own agent: a takeover renders one panel per
    // failed agent, and two bare Retry buttons would be indistinguishable.
    const heading = document.createElement("p");
    heading.className = "chat-unavailable__heading";
    heading.textContent = `${agentName}: ${availability.message}`;
    panel.append(heading);

    if (availability.diagnostics) {
      const details = document.createElement("details");
      details.className = "chat-unavailable__details";
      const summary = document.createElement("summary");
      summary.textContent = "Diagnostics";
      const report = document.createElement("pre");
      report.className = "chat-unavailable__report";
      report.textContent = formatDiagnostics(availability);
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "chat-unavailable__copy";
      copy.textContent = "Copy diagnostics";
      copy.addEventListener("click", () => {
        void navigator.clipboard?.writeText(report.textContent ?? "").then(
          () => { copy.textContent = "Copied"; },
          () => { copy.textContent = "Copy failed"; },
        );
      });
      details.append(summary, report, copy);
      panel.append(details);
    }

    // Retry is offered for every unavailable reason — someone who just
    // installed OpenCode should recover the same way — but for `not-installed`
    // the install instruction leads and retry is the secondary action.
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "chat-unavailable__retry";
    retry.textContent = "Retry";
    if (availability.reason === "not-installed") retry.classList.add("is-secondary");
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      retry.textContent = "Retrying…";
      panel.remove();
      announce(`Starting ${agentName}…`);
      try {
        const next = await api.retry(agentId);
        setAgentStatuses(agentStatuses.map(status => status.agent.id === agentId ? next : status));
        if (next.availability.state === "unavailable") {
          showUnavailable(agentId, next.availability, options);
          return;
        }
        if (options.takeover) {
          bootstrapped = false;
          await bootstrap();
          return;
        }
        // Only this agent was down: rebuild its context and reload whatever
        // conversation is selected under it.
        await applyAgentContext(agentId);
        const selectedId = presentation.selectedId;
        if (selectedId && conversationAgentId(selectedId) === agentId) void selectConversation(selectedId);
      } catch (error) {
        // The retry POST itself failed (network, proxy, credential refresh) —
        // announce() alone would wipe the panel and leave the surface with no
        // Retry control at all, so rebuild it around the transport error.
        showUnavailable(agentId, { ...availability, message: `Retry failed: ${messageOf(error)}` }, options);
      }
    });
    panel.append(retry);
    state.append(panel);
    state.hidden = false;
  };

  const bootstrap = async () => {
    if (bootstrapped || bootstrapping) return;
    bootstrapping = true;
    const initialRead = readSignal.start("Loading conversations...");
    bootstrapRead = initialRead;
    readError.hidden = true;
    try {
      setAgentStatuses(await api.status());
      seedUsageFromStatuses();
      // Every offered agent down at once is the only full takeover: with no
      // agent to converse with, the surface's job is the diagnosis + retry.
      const anyUsable = agentStatuses.some(status => status.availability.state !== "unavailable");
      if (!anyUsable) {
        // Every agent gets its own diagnosis and Retry: repairing the
        // second agent must be recoverable from this page too.
        for (const status of agentStatuses) {
          if (status.availability.state === "unavailable") showUnavailable(status.agent.id, status.availability, { takeover: true });
        }
        return;
      }
      // Named before anything is fetched: every later render reads the agent,
      // and a control that appeared unnamed and then renamed itself would be
      // the pop-in this seam exists to avoid. The starting context is the
      // last-used agent, then the server default (first entry).
      const preferred = agentStatusFor(presentation.lastAgentId) ?? agentStatuses[0]!;
      // Anything selected while these fetches are in flight — a conversation
      // the user just created — outranks this snapshot: the fetch began
      // before that creation, so its list cannot know it.
      const selectionAtStart = selectionGeneration;
      // The merged inventory is bounded per agent; the preferred agent's
      // context load is not (a cold catalog probe can take seconds). The
      // chooser must not wait on the latter — healthy conversations render
      // as soon as the inventory answers.
      const contextReady = applyAgentContext(preferred.agent.id);
      const nextConversations = await api.conversations();
      seedUsageFromInventory();
      conversations = dedupeConversationInventory([...conversations, ...nextConversations]);
      // Bootstrap is the silent page-local baseline. The stream starts only
      // after this point, so its mandatory initial frame reconciles rather
      // than turning every existing id into an unseen one.
      inventoryTracker.reconcile(conversations);
      syncInventoryAwareness();
      form.hidden = false;
      select.disabled = false;
      newButton.disabled = false;
      announce(conversations.length ? "" : "No conversations yet. Create one to start.");
      await resolveAwaiting();
      // A selection made mid-bootstrap is the user's; the initial chooser
      // pass must not replace it with this snapshot's newest entry.
      if (startupOwnsSelection && selectionGeneration === selectionAtStart) installInitialChooser();
      else patchChooser(hasSelectedConversation ? presentation.selectedId ?? null : null);
      void contextReady;
      bootstrapped = true;
      // The enumeration above probed every agent; the pre-probe snapshot
      // may still call a failed one usable, and the creation menu would
      // offer it with only a generic error behind it. Refresh in the
      // background so availability becomes the probe's verdict without
      // holding bootstrap's selection work open — and if the verdict is
      // that every agent is down after all, the takeover renders now
      // rather than after a reload.
      void api.status().then(next => {
        setAgentStatuses(next);
        if (next.length > 0 && next.every(status => status.availability.state === "unavailable")) {
          for (const status of next) {
            if (status.availability.state === "unavailable") showUnavailable(status.agent.id, status.availability, { takeover: true });
          }
          return;
        }
        // The bootstrap context may have applied against an idle snapshot,
        // leaving no declared agent; once the probe's verdict says ready,
        // re-apply so capabilities and catalogs come from the real agent —
        // otherwise the first conversation on a fresh workspace never gets
        // its capability controls until a reload or an agent switch.
        const current = next.find(status => status.agent.id === contextAgentId);
        // Ready-but-undeclared re-applies; so does a context agent the
        // probes found dead — applyAgentContext renders its diagnosis and
        // Retry instead of leaving a stale composer enabled.
        if ((current?.availability.state === "ready" && !agent) || current?.availability.state === "unavailable") {
          void applyAgentContext(contextAgentId);
        }
      }).catch(() => undefined);
      startInventoryStream();
    } catch (error) { showReadError(readError, error, () => { void bootstrap(); }); }
    finally { bootstrapping = false; readSignal.settle(bootstrapRead ?? initialRead); bootstrapRead = null; }
  };
  function chatSurfaceActive() {
    return chatSurfaceInView();
  }
  function syncChatAttention() {
    const pending = [projection, child?.projection].some(source => source?.items.some(item =>
      (item.type === "permission" || item.type === "question") && item.status === "pending"));
    for (const control of [document.getElementById("touch-tab-chat"), document.getElementById("chat-expand")]) {
      control?.toggleAttribute("data-badge", pending || (!chatSurfaceActive() && pendingNewContent));
      if (pending) control?.setAttribute("aria-description", "Needs your answer");
      else control?.removeAttribute("aria-description");
    }
  }
  let chatWasActive = false;
  const captureSurfaceAnchors = () => {
    if (!chatSurfaceActive()) return;
    parentScroll.beforeMutation();
    childScroll?.beforeMutation();
  };
  document.addEventListener("uatu:before-surface-change", captureSurfaceAnchors);
  const handleChatSurfaceState = () => {
    if (document.documentElement.hasAttribute("data-notification-chat") && (document.documentElement.getAttribute("data-ui-mode") === "touch" || isChatPanelOpen())) {
      document.documentElement.removeAttribute("data-notification-chat");
    }
    const active = chatSurfaceActive();
    const becameActive = active && !chatWasActive;
    chatWasActive = active;
    syncWorkingTimer();
    syncChatAttention();
    if (!active) {
      renderer.setShellOutputsHidden(true);
      childRenderer.setShellOutputsHidden(true);
      parentScroll.cancel();
      childScroll?.cancel();
      heldAnswerField = null;
      readSignal.cancel();
      childReadSignal?.cancel();
      if (incrementalTimer !== null) { clearTimeout(incrementalTimer); incrementalTimer = null; }
      if (childIncrementalTimer !== null) { clearTimeout(childIncrementalTimer); childIncrementalTimer = null; }
      if (renderFrame !== null) { cancelAnimationFrame(renderFrame); renderFrame = null; }
      if (childRenderFrame !== null) { cancelAnimationFrame(childRenderFrame); childRenderFrame = null; }
      return;
    }
    if (becameActive) {
      // The surface just came into view — the render below clears the
      // pending-content badge, and the hub switcher clears the workspace's
      // finished mark on the same cue. Fires at bootstrap too when the
      // surface is already in view (chatWasActive starts false).
      document.dispatchEvent(new CustomEvent(CHAT_SURFACE_ACTIVE_EVENT));
      // Backgrounding cancels owners but may retain DOM focus without another
      // focusin. Restore only the currently valid request field on return.
      syncEditingFocus();
      if (readLane) readLane.token = readSignal.start(readLane.label);
      else if (bootstrapping) bootstrapRead = readSignal.start("Loading conversations...");
      if (child?.read) child.read.token = childReadSignal?.start(child.read.label) ?? 0;
      // Even an unchanged projection may own a hidden floating viewport.
      // Its latest state is painted before its retained window becomes visible.
      scheduleRender(false, false);
      renderChild(false);
    }
    if (!bootstrapped) void bootstrap();
    else if (becameActive) {
      startInventoryStream();
      void inventoryReconciler.request();
    }
  };
  const surfaceObserver = new MutationObserver(handleChatSurfaceState);
  surfaceObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-chat-panel", "data-active-tab", "data-ui-mode", "data-notification-chat"] });
  document.addEventListener("visibilitychange", handleChatSurfaceState);
  onWorkspaceCredentialRefresh(() => {
    if (bootstrapped) {
      startInventoryStream();
      void inventoryReconciler.request();
    } else if (chatSurfaceActive()) {
      void bootstrap();
    }
  });
  // A page that was frozen, backgrounded, or off the network missed whatever
  // the stream would have delivered. The shell's one lifecycle recovery
  // (shell/live.ts) reconnects the page's live channel, which resumes the
  // inventory, the selected conversation, and any open subagent transcript
  // from the cursors it holds — a cursor the hub can no longer replay comes
  // back as a resync on that topic alone. Chat's own part is the state the
  // stream cannot replay: the authoritative inventory. Nothing here touches
  // presentation — drafts, timeline content, and scroll position survive
  // intact.
  registerRecoveryWork(async () => {
    if (!bootstrapped) return;
    await inventoryReconciler.request();
  });
  const revealNotificationChat = () => {
    if (document.documentElement.getAttribute("data-ui-mode") === "touch") setActiveTab("chat");
    else {
      expandChatPanel();
      // A notification still needs to be answerable in a desktop window too
      // narrow for the split. This temporary view does not change UI mode.
      if (!isChatPanelOpen()) document.documentElement.setAttribute("data-notification-chat", "");
    }
  };
  document.getElementById("chat-collapse")?.addEventListener("click", () => document.documentElement.removeAttribute("data-notification-chat"));
  navigator.serviceWorker?.addEventListener("message", event => {
    if (event.data?.type !== "uatu:open-conversation" || typeof event.data.conversationId !== "string") return;
    const id = notificationConversation(`conversation=${encodeURIComponent(event.data.conversationId)}`);
    if (!id) return;
    revealNotificationChat();
    closeChildConversation();
    if (bootstrapped) void selectConversation(id);
    else notificationTarget = id;
  });
  if (notificationTarget || awaitingLookup) revealNotificationChat();
  handleChatSurfaceState();
}

/**
 * The controls that resolve a request: a question's submit and reject, and a
 * permission's choices, outcomes and confirmation pair. All of them can be
 * tapped while a free-form answer field holds focus.
 */
const REQUEST_ANSWER_CONTROLS = [
  "[data-question-primary]",
  "[data-question-reject]",
  ".chat-request-actions [data-permission-choice]",
  ".chat-request-actions [data-permission-outcome]",
  ".chat-request-actions [data-permission-confirm]",
  ".chat-request-actions [data-permission-cancel]",
].join(", ");

function isTextEditingControl(value: Element | null): boolean {
  if (value instanceof HTMLTextAreaElement) return true;
  if (value instanceof HTMLInputElement) return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(value.type);
  return value instanceof HTMLElement && value.isContentEditable;
}

function disableCard(itemId: string, disabled: boolean): void {
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement>(`[data-chat-item-id="${CSS.escape(itemId)}"] button, [data-chat-item-id="${CSS.escape(itemId)}"] input`).forEach(control => { control.disabled = disabled; });
}

function autosize(input: HTMLTextAreaElement): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 192)}px`;
}

function readPresentation(storage: Storage | null): Presentation {
  try {
    const raw = storage?.getItem(PRESENTATION_KEY);
    if (!raw) return structuredClone(EMPTY_PRESENTATION);
    const value = JSON.parse(raw) as Partial<Presentation>;
    return {
      selectedId: typeof value.selectedId === "string" ? value.selectedId : undefined,
      lastAgentId: typeof value.lastAgentId === "string" ? value.lastAgentId : undefined,
      receiptView: parseReceiptView(value.receiptView),
      drafts: value.drafts && typeof value.drafts === "object" ? value.drafts : {},
      expanded: Array.isArray(value.expanded) ? value.expanded.filter(item => typeof item === "string") : [],
      anchors: value.anchors && typeof value.anchors === "object" ? value.anchors : {},
      workingSince: parseStoredTimestamps(value.workingSince),
      dismissedSubagents: parseStoredIdLists(value.dismissedSubagents),
    };
  } catch { return structuredClone(EMPTY_PRESENTATION); }
}

function parseStoredIdLists(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
    .map(([key, list]) => [key, list.filter((item): item is string => typeof item === "string")]));
}

function parseStoredTimestamps(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] =>
    typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0));
}

function modelValue(model: ModelSelection): string {
  return JSON.stringify([model.providerId, model.modelId]);
}

/** "42s", "3m 12s", "1h 04m": API time as the reader waited for it. */
function formatApiTime(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function sameModel(left: ModelSelection, right: ModelSelection): boolean {
  return left.providerId === right.providerId && left.modelId === right.modelId;
}

function messageOf(error: unknown): string {
  return error instanceof ChatTransportError || error instanceof Error ? error.message : "Chat failed";
}

function displayConversationTitle(conversation: ConversationSummary): string {
  return /^New session - /.test(conversation.title) ? "New conversation" : conversation.title || "Untitled conversation";
}

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
