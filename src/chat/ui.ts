import { escapeHtml } from "../shared/html";
import { appState } from "../shell/state";
import { presentationLocalStorage } from "../shell/presentation-storage";
import { registerBackInterceptor } from "../shell/history";
import { onWorkspaceCredentialRefresh } from "../terminal/client";
import { ChatApiClient, ChatTransportError, type ChatEventStream } from "./client";
import { TimelineAnchorController, type AnchorGeometry, type TimelineAnchor } from "./anchor";
import { ChatViewportController } from "./viewport";
import { newRequestId } from "./ids";
import { insertCommand, localHistoryOperation, matchingCommands, type LocalHistoryOperation } from "./slash-commands";
import { navigateWorkspaceFileReference, resolveWorkspaceFileReference } from "./file-references";
import { READER_CLOSED, QueueDockRenderer, RevertedMessagesDockRenderer, TimelineRenderer, decorateAttachmentImages, decorateFileLinks, latestTodoEntries, statusLabel, subagentEntries, subagentLabel } from "./timeline-renderer";
import { contextTokens, totalTokens } from "./usage";
import {
  addAcceptedDraft,
  applyChatEvent,
  confirmAcceptedDraft,
  dropQueuedMessage,
  noteQueuedMessage,
  prependSnapshot,
  projectionFromSnapshot,
  removeAcceptedDraft,
  type ChatProjection,
} from "./projection";
import { CHAT_ATTACHMENT_MAX_BYTES, CHAT_ATTACHMENT_MIME_TYPES, CHAT_ATTACHMENTS_PER_MESSAGE, type AgentChatStatus, type ChatAgent, type ChatCapability, type ChatMode, type ChatAvailability, type ChatCommand, type ChatModel, type ConversationConfiguration, type ConversationItem, type ConversationSnapshot, type ConversationSummary, type MessageAttachment, type ModelSelection, type PermissionOutcome, type QuestionOutcome, type RestoredDraft, type ReversibleHistoryResult, type TokenUsage } from "./types";
import { formatDiagnostics } from "./diagnostics";
import { collectQuestionAnswers, showQuestionPanel, syncQuestionControl, syncQuestionForm } from "./question-form";
import { configurationOptionLabel, createChatConfigurationPicker, type ChatConfigurationPickerController } from "./configuration-picker";
import { copyChatText } from "./copy-actions";
import { announceConversationInventory, renderConversationInventoryAwareness, renderSelectedConversationDeleted } from "./inventory-presentation";
import { ConversationInventoryTracker, SerializedInventoryReconciler, dedupeConversationInventory, isConversationChooserActivationKey, patchConversationOptions, retainedPresentationConversationIds } from "./inventory-reconciler";

const PRESENTATION_KEY = "uatu:chat-presentation";
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
};

const EMPTY_PRESENTATION: Presentation = { drafts: {}, expanded: [], anchors: {}, workingSince: {}, dismissedSubagents: {} };

export function initChat(api = new ChatApiClient()): void {
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
  const form = document.querySelector<HTMLFormElement>("#chat-composer");
  const input = document.querySelector<HTMLTextAreaElement>("#chat-input");
  const commandMenu = document.querySelector<HTMLElement>("#chat-command-menu");
  const send = document.querySelector<HTMLButtonElement>("#chat-send");
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
  const waiting = document.querySelector<HTMLElement>("#chat-waiting");
  const waitingLabel = document.querySelector<HTMLElement>("#chat-waiting-label");
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
  if (!surface || !timeline || !items || !state || !select || !newButton || !olderButton || !latestButton || !queueDockElement || !form || !input || !commandMenu || !send || !sendLabel || !configurationTrigger || !configurationSummary || !configurationDetails || !configurationModeSummary || !configurationVariantSummary || !configurationVariantValue || !configurationDialog || !configurationSearch || !configurationModelsSection || !configurationModels || !configurationResultStatus || !configurationEmpty || !configurationDone || !composerStatus || !composerStatusLive || !composerError || !copyStatus) return;

  const anchor = new TimelineAnchorController();
  const viewport = new ChatViewportController(surface, form, timeline, anchor);
  const renderer = new TimelineRenderer();
  const queueDock = new QueueDockRenderer();
  const revertedDock = revertedShell && revertedLabel && revertedItems
    ? new RevertedMessagesDockRenderer(revertedShell, revertedLabel, revertedItems)
    : null;
  let presentation = readPresentation();
  let conversations: ConversationSummary[] = [];
  // Every offered agent with its availability, in server presentation order.
  let agentStatuses: AgentChatStatus[] = [];
  // Catalogs are per agent; the bare lists below are the selected-agent view,
  // swapped whenever the conversation's owning agent changes.
  type AgentCatalogs = { models: ChatModel[]; modes: ChatMode[]; commands: ChatCommand[]; commandInventoryAvailable: boolean };
  const agentCatalogs = new Map<string, AgentCatalogs>();
  let contextAgentId: string | undefined;
  let models: ChatModel[] = [];
  let modes: ChatMode[] = [];
  let commands: ChatCommand[] = [];
  let projection: ChatProjection | null = null;
  const stagedConfigurations = new Map<string, ConversationConfiguration>();
  let configurationPicker: ChatConfigurationPickerController | null = null;
  let stream: ChatEventStream | null = null;
  let inventoryStream: ChatEventStream | null = null;
  let selectionGeneration = 0;
  let selectedConversationDeleted = false;
  let disposed = false;
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
  };
  let child: Drilldown | null = null;
  let childGeneration = 0;
  const childRenderer = new TimelineRenderer();
  const childAnchor = new TimelineAnchorController();
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
  let submitting = false;
  let cancelling = false;
  // Bumped on every main-projection snapshot install. queueRevision restarts
  // at zero with each fresh projection, so an in-flight held echo compares
  // this epoch too — a revision captured before a reload must never pass
  // against the replacement projection's coincidentally equal revision.
  let projectionEpoch = 0;
  // A failed send leaves acceptance unknown — the server may already hold a
  // receipt for the request. Resubmitting the same text reuses its id so the
  // receipt dedupes instead of starting a second agent turn. Keyed per
  // conversation: a success elsewhere must not discard another
  // conversation's unresolved id.
  // `attachments` joins the retry identity: a resubmission with the same text
  // but a changed attachment set is a different message, and reusing the old
  // request id would let the server replay the first acceptance receipt for a
  // payload the provider never saw.
  const retryRequests = new Map<string, { text: string; requestId: string; attachments: string }>();
  const historyMutations = new Set<string>();
  const pendingHistoryResyncs = new Set<string>();
  const historyRefreshRequired = new Set<string>();
  type HistoryOperation = LocalHistoryOperation | "revert" | "restore";
  const historyRetries = new Map<string, { operation: HistoryOperation; messageId?: string; requestId: string; result?: ReversibleHistoryResult }>();
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
  const applyCapabilities = () => {
    if (!agent) return;
    configurationTrigger.hidden = !declares("models") && !declares("modes") && !declares("variants");
    // Hidden, never removed: capabilities change with the selected
    // conversation's agent now, so a control another agent declares must be
    // able to come back. An absent capability still presents no control —
    // the rule is about presentation, and hidden satisfies it reversibly.
    if (contextUsage && !declares("context")) {
      // The meter's own renderer re-shows it when a context agent's usage
      // paints; here only the takeaway happens.
      contextUsage.hidden = true;
      contextUsage.open = false;
    }
    if (renameButton) renameButton.hidden = !declares("conversation-rename");
    // The model-level attachment gate is different — see syncAttachControl:
    // a model choice flips often, so there the control stays visible and
    // goes inactive instead.
    if (attachButton) attachButton.hidden = !declares("attachments");
  };
  nameAgent();

  // One status-line contract for every surface that has one; the parent's
  // state element and the drill-down's differ only in which element speaks.
  const announcerFor = (target: HTMLElement | null) => (message: string, error = false) => {
    if (!target) return;
    target.textContent = message;
    target.classList.toggle("is-error", error);
    target.hidden = !message;
  };
  const announce = announcerFor(state);
  const announceChild = announcerFor(drilldownState);

  const geometryOf = (scroller: HTMLElement, container: HTMLElement): AnchorGeometry => {
    const bounds = scroller.getBoundingClientRect();
    return {
      scrollTop: scroller.scrollTop,
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
      items: Array.from(container.querySelectorAll<HTMLElement>("[data-chat-item-id]")).map(element => {
        const rect = element.getBoundingClientRect();
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
  const anchorGeometry = (): AnchorGeometry => anchor.isPinned() ? extentsOf(timeline) : geometry();
  const childAnchorGeometry = (): AnchorGeometry => childAnchor.isPinned() ? extentsOf(drilldownTimeline!) : childGeometry();

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
    try { presentationLocalStorage()?.setItem(PRESENTATION_KEY, JSON.stringify(presentation)); } catch { /* best effort */ }
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

  const subagents = document.querySelector<HTMLDetailsElement>("#chat-subagents");
  const subagentsLabel = document.querySelector<HTMLElement>("#chat-subagents-label");
  const subagentsItems = document.querySelector<HTMLElement>("#chat-subagents-items");
  const dismissButton = document.querySelector<HTMLButtonElement>("#chat-subagents-dismiss");
  const requestsJump = document.querySelector<HTMLButtonElement>("#chat-requests-jump");
  // Finished subagents stay until explicitly dismissed — nothing retires
  // them on a timer. Dismissals persist with the rest of the per-conversation
  // presentation, so a reload does not resurrect an already-dismissed strip.
  const dismissedSubagents = (conversationId: string): Set<string> =>
    new Set(presentation.dismissedSubagents[conversationId] ?? []);
  // One policy for what a drill-down is titled, read from the structured
  // entries rather than scraped from whichever markup happens to carry the
  // text — the track row and the timeline row must produce the same title.
  const subagentLabelFor = (conversationId: string, source: ChatProjection | null): string => {
    const entry = source ? subagentEntries(source.items).find(candidate => candidate.conversationId === conversationId) : undefined;
    return entry ? subagentLabel(entry) : "Subagent";
  };
  subagentsItems?.addEventListener("click", event => {
    const open = (event.target as Element).closest<HTMLElement>("[data-open-conversation]");
    if (open?.dataset.openConversation) openChildConversation(open.dataset.openConversation, subagentLabelFor(open.dataset.openConversation, projection));
  });
  dismissButton?.addEventListener("click", event => {
    event.preventDefault();
    if (!projection) return;
    const dismissed = dismissedSubagents(projection.conversationId);
    for (const entry of subagentEntries(projection.items)) {
      if (entry.status !== "running" && entry.status !== "pending") dismissed.add(entry.id);
    }
    presentation.dismissedSubagents[projection.conversationId] = [...dismissed];
    save();
    syncSubagents();
    syncOutstandingRequests();
  });

  /**
   * Running and finished subagents, pinned beside the task list. A fan-out of
   * three subagents is three rows that would otherwise scroll away, and while
   * they run there is nothing else saying how many are still going.
   */
  /**
   * Outstanding requests, pinned so they cannot scroll away. Ten permissions in
   * one turn left a user unable to tell which still needed them; per-card
   * styling alone does not answer that in a long transcript, because you still
   * have to scroll and count. This says how many and takes you to one.
   */
  let paintedRequests = "";
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
    if (signature === paintedRequests) return;
    paintedRequests = signature;
    if (outstanding.length === 0) {
      requestsJump.hidden = true;
      requestsJump.textContent = "";
      delete requestsJump.dataset.requestTarget;
      return;
    }
    const noun = outstanding.length === 1 ? "request needs" : "requests need";
    requestsJump.hidden = false;
    requestsJump.textContent = `${outstanding.length} ${noun} your answer`;
    // The answerable one is the newest; that is where the jump lands, because
    // it is the only one a user can act on right now.
    requestsJump.dataset.requestTarget = target!.id;
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
    if (card instanceof HTMLDetailsElement) card.open = true;
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

  // Same rebuild-only-on-change rule as the task list, for the same tap
  // reason — these rows are buttons, and a button replaced mid-tap is a
  // button that never fires.
  let paintedSubagents = "";
  const syncSubagents = () => {
    if (!subagents || !subagentsLabel || !subagentsItems) return;
    if (!declares("subagents")) {
      paintedSubagents = "";
      subagents.hidden = true;
      subagentsItems.replaceChildren();
      return;
    }
    const all = projection ? subagentEntries(projection.items) : [];
    const dismissed = projection ? dismissedSubagents(projection.conversationId) : new Set<string>();
    const entries = all.filter(entry => !dismissed.has(entry.id));
    const signature = entries
      .map(entry => [entry.id, entry.status, entry.subagent ?? "", entry.description, entry.conversationId ?? "", entry.model ?? "", entry.usage ? String(totalTokens(entry.usage)) : ""].join("\u0001"))
      .join("\u0002");
    if (signature === paintedSubagents) return;
    paintedSubagents = signature;
    if (dismissButton) {
      dismissButton.hidden = !entries.some(entry => entry.status !== "running" && entry.status !== "pending");
    }
    if (entries.length === 0) {
      subagents.hidden = true;
      subagentsItems.replaceChildren();
      return;
    }
    const running = entries.filter(entry => entry.status === "running" || entry.status === "pending");
    const noun = entries.length === 1 ? "subagent" : "subagents";
    subagentsLabel.textContent = running.length > 0
      ? `${running.length} of ${entries.length} ${noun} working · ${running[0]!.description}`
      : `${entries.length} ${noun} finished`;
    subagentsItems.replaceChildren(...entries.map(entry => {
      const row = document.createElement("li");
      row.className = `is-${entry.status}`;
      const text = subagentLabel(entry);
      if (entry.conversationId) {
        const open = document.createElement("button");
        open.type = "button";
        open.className = "chat-subagent-open";
        open.dataset.openConversation = entry.conversationId;
        open.textContent = text;
        row.append(open);
      } else {
        const label = document.createElement("span");
        label.className = "chat-subagent-label";
        label.textContent = text;
        row.append(label);
      }
      // What it ran and what it cost, after the description so the row still
      // leads with what the subagent is doing. The model shows whenever the
      // agent named it; the token figure only where the agent declares it
      // reports usage, and only once it has reported some — an unattributed
      // subagent stays a readable row rather than one asserting a zero.
      const attribution = [
        entry.model,
        declares("context") && entry.usage ? `${formatTokens(totalTokens(entry.usage))} tokens` : undefined,
      ].filter(Boolean).join(" · ");
      if (attribution) {
        const note = document.createElement("span");
        note.className = "chat-subagent-attribution";
        note.textContent = attribution;
        row.append(note);
      }
      return row;
    }));
    subagents.hidden = false;
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
  // same usage object means the same figures. This sync runs on every rendered
  // frame of a streaming turn, and text deltas must not pay for meter and
  // breakdown rebuilds that would come out identical.
  let paintedUsage: TokenUsage | undefined;
  let paintedUsageModel: string | undefined;
  const syncContextIndicator = () => {
    if (!contextUsage?.isConnected || !contextUsageFill || !contextUsageLabel || !contextUsageBreakdown) return;
    // The newest assistant usage, scanned from the tail — it is almost always
    // right at the end of a long timeline.
    let usage: TokenUsage | undefined;
    let usageModel: ModelSelection | undefined;
    let zeroUsage: TokenUsage | undefined;
    let zeroUsageModel: ModelSelection | undefined;
    const timelineItems = projection?.items ?? [];
    for (let index = timelineItems.length - 1; index >= 0; index -= 1) {
      const item = timelineItems[index]!;
      if (item.type !== "assistant_message" || !item.usage) continue;
      // OpenCode starts a new assistant message with an all-zero report before
      // its real input/cache accounting arrives. Do not flash the meter to 0
      // between turns when an earlier meaningful occupancy is still known.
      if (!zeroUsage) { zeroUsage = item.usage; zeroUsageModel = item.model; }
      if (contextTokens(item.usage) > 0) { usage = item.usage; usageModel = item.model; break; }
    }
    if (!usage) { usage = zeroUsage; usageModel = zeroUsageModel; }
    const displayedModel = displayedConfiguration().model;
    const reportingModel = usageModel ? modelValue(usageModel) : displayedModel ? modelValue(displayedModel) : "";
    if (usage === paintedUsage && reportingModel === paintedUsageModel) return;
    paintedUsage = usage;
    paintedUsageModel = reportingModel;
    if (!usage || !declares("context")) {
      contextUsage.hidden = true;
      contextUsage.open = false;
      return;
    }
    const used = contextTokens(usage);
    const limit = models.find(model => modelValue(model.selection) === reportingModel)?.contextLimit;
    const fraction = limit && limit > 0 ? Math.min(1, used / limit) : undefined;
    const fillPercent = Math.round((fraction ?? 0) * 100);
    contextUsageFill.style.setProperty("--context-fill", `${fillPercent}%`);
    // Keep the unfilled wedge centred on the right, so partial usage reads as
    // a right-facing Pac-Man rather than a clock with an arbitrary start edge.
    const startAngle = Math.round((90 + (100 - fillPercent) * 1.8) * 10) / 10;
    contextUsageFill.style.setProperty("--context-start", `${startAngle}deg`);
    // The figure states the fill in words as well as in width, so the tier
    // colouring below is emphasis on something already legible rather than
    // the only signal.
    contextUsageLabel.textContent = fraction === undefined ? "?" : `${Math.round(fraction * 100)}%`;
    contextUsage.dataset.fill = fraction === undefined ? "unknown" : fraction >= 0.9 ? "full" : fraction >= 0.75 ? "high" : "normal";
    contextUsage.title = fraction === undefined
      ? `${used.toLocaleString()} tokens in the context window`
      : `${used.toLocaleString()} of ${limit!.toLocaleString()} tokens in the context window`;
    const rows: Array<[string, number]> = [["In context", used]];
    if (limit !== undefined) rows.push(["Limit", limit]);
    if (usage.input !== undefined) rows.push(["Input", usage.input]);
    if (usage.cacheRead !== undefined) rows.push(["Cache read", usage.cacheRead]);
    if (usage.cacheWrite !== undefined) rows.push(["Cache write", usage.cacheWrite]);
    if (usage.reasoning !== undefined) rows.push(["Reasoning", usage.reasoning]);
    if (usage.output !== undefined) rows.push(["Output", usage.output]);
    contextUsageBreakdown.replaceChildren(...rows.flatMap(([label, value]) => {
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = value.toLocaleString();
      return [term, detail];
    }));
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
    const bounds = timeline.getBoundingClientRect();
    timeline.scrollTo({
      top: timeline.scrollTop + node.getBoundingClientRect().top - bounds.top - 8,
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
    const historyBusy = submitting || (projection ? historyMutations.has(projection.conversationId) : false);
    for (const button of items.querySelectorAll<HTMLButtonElement>("[data-history-revert]")) button.disabled = historyBusy;
    for (const button of revertedItems?.querySelectorAll<HTMLButtonElement>("[data-history-restore]") ?? []) button.disabled = historyBusy;
  };

  const renderNow = (newContent: boolean) => {
    rendering = true;
    const dirty = renderer.render(items, projection, expanded, declares("subagents"), declares("reversible-history"));
    revertedDock?.render(projection?.reversibleHistory?.revertedMessages ?? []);
    queueDock.render(queueDockElement, projection?.queued ?? []);
    syncHistoryControls();
    rendering = false;
    syncTaskList();
    syncSubagents();
    syncOutstandingRequests();
    syncContextIndicator();
    syncPromptRail();
    timeline.scrollTop = anchor.afterMutation(anchorGeometry(), newContent);
    latestButton.hidden = !anchor.hasUnseen();
    syncControls();
    for (const node of dirty) {
      decorateFileLinks(node);
      decorateAttachmentImages(node);
      // A freshly built question form starts with its primary button disabled;
      // this settles the tab strip and button state for its first step.
      node.querySelectorAll<HTMLFormElement>("form[data-question-form]").forEach(syncQuestionForm);
    }
  };

  const scheduleRender = (newContent = false, captureCurrent = true) => {
    if (renderFrame !== null) return;
    // beforeMutation is a no-op while pinned — skipping the call skips the
    // full-geometry pass it would otherwise be handed for nothing.
    if (captureCurrent && !anchor.isPinned()) anchor.beforeMutation(geometry());
    renderFrame = requestAnimationFrame(() => {
      renderFrame = null;
      renderNow(newContent);
    });
  };

  const workingText = () => {
    if (!projection) return "Select a conversation";
    const base = statusLabel(projection.status);
    const workingSince = presentation.workingSince[projection.conversationId];
    if (workingSince === undefined) return base;
    const seconds = Math.max(0, Math.round((Date.now() - workingSince) / 1000));
    const elapsed = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
    return `${base} · ${elapsed}`;
  };

  /**
   * Waiting on the agent's first sign of life for this turn: the prompt is
   * accepted and nothing newer than the reader's own message has arrived. A
   * local model that must load its weights sits in this state for a long
   * while, and the composer's "Working" line — visually hidden in touch
   * mode — was the only thing saying anything was happening at all.
   */
  const awaitingFirstResponse = (): boolean => {
    if (!projection) return false;
    if (projection.status !== "sending" && projection.status !== "running") return false;
    if (projection.acceptedDrafts.length > 0) return true;
    for (let index = projection.items.length - 1; index >= 0; index -= 1) {
      const item = projection.items[index]!;
      if (item.type === "user_message") return true;
      // A previous turn's footer and a hidden usage carrier say nothing about
      // THIS turn; keep looking past them.
      if (item.type === "turn_status") continue;
      if (item.type === "assistant_message" && item.markdown === "") continue;
      return false;
    }
    return false;
  };

  const syncWaiting = () => {
    if (!waiting || !waitingLabel) return;
    const show = awaitingFirstResponse();
    waiting.hidden = !show;
    if (show) waitingLabel.textContent = workingText();
  };

  const showComposerError = (message: string | null) => {
    composerError.textContent = message ?? "";
    composerError.hidden = !message;
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
  // Image attachments: staged per conversation, uploaded at attach time,
  // referenced by id everywhere after (spec: bytes cross each boundary once).
  // Pending state deliberately does not persist across reloads.
  // ------------------------------------------------------------------
  type PendingAttachment = MessageAttachment & { id: string; previewUrl: string };
  const pendingAttachments = new Map<string, PendingAttachment[]>();
  const unavailableAttachments = new Map<string, MessageAttachment[]>();
  // One serialized staging chain per conversation. Serialization makes the
  // per-message bound check honest — a second paste near the eight-image
  // limit runs after the first and sees its result instead of racing past
  // the cap — and submission drains the chain (re-reading the tail until
  // nothing new was appended while it waited) so an image attached moments
  // before Enter joins the message it was attached for.
  const attachmentStaging = new Map<string, Promise<void>>();
  const attachmentStagingGeneration = new Map<string, number>();
  // Attachments riding an in-flight submission still count against the
  // per-message cap: a failure restores them to pending, and an intake that
  // ignored them could push the restored draft past eight and make every
  // retry refusable.
  const submittedAttachmentReserve = new Map<string, number>();
  // Monotonic per-conversation refusal count. Submission compares it across
  // the staging drain: a refusal that lands while a submit waits is a piece
  // of THAT message going missing, and the send must stop rather than
  // deliver a partial prompt. Refusals from before the submit are the
  // user's informed choice to send without the refused file.
  const attachmentRefusals = new Map<string, number>();
  const noteAttachmentRefusal = (conversationId: string, count = 1) => {
    if (count > 0) attachmentRefusals.set(conversationId, (attachmentRefusals.get(conversationId) ?? 0) + count);
  };

  // The prompt route bounds attachment names to 200 UTF-8 bytes and refuses
  // blank ones; a name staged verbatim past either rule would upload fine
  // and then fail every send. Bounded here — fallback for empty and
  // whitespace-only, truncation on a code-point boundary — so the reference
  // stays sendable.
  const boundAttachmentName = (name: string): string => {
    const trimmed = name.trim() === "" ? "image" : name;
    const encoder = new TextEncoder();
    if (encoder.encode(trimmed).length <= 200) return trimmed;
    let bounded = trimmed;
    while (bounded.length > 1 && encoder.encode(bounded).length > 200) bounded = bounded.slice(0, -1);
    // UTF-16 slicing can leave a lone high surrogate at the cut; it would
    // encode as U+FFFD garbage in the name.
    const last = bounded.charCodeAt(bounded.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) bounded = bounded.slice(0, -1);
    return bounded || "image";
  };
  const supportedAttachmentTypes = new Set<string>(CHAT_ATTACHMENT_MIME_TYPES);

  // The conversation attachments belong to. The projection may still be
  // loading when the user attaches — the selection is already made, so the
  // selected id serves until the snapshot installs. Without this, an attach
  // during the load window silently did nothing.
  const activeConversationId = (): string | null =>
    projection?.conversationId ?? presentation.selectedId ?? null;

  const currentPendingAttachments = (): PendingAttachment[] => {
    const conversationId = activeConversationId();
    return conversationId ? pendingAttachments.get(conversationId) ?? [] : [];
  };

  const currentUnavailableAttachments = (): MessageAttachment[] => {
    const conversationId = activeConversationId();
    return conversationId ? unavailableAttachments.get(conversationId) ?? [] : [];
  };

  const setPendingAttachments = (conversationId: string, entries: PendingAttachment[]) => {
    if (entries.length > 0) pendingAttachments.set(conversationId, entries);
    else pendingAttachments.delete(conversationId);
  };

  const setUnavailableAttachments = (conversationId: string, entries: MessageAttachment[]) => {
    if (entries.length > 0) unavailableAttachments.set(conversationId, entries);
    else unavailableAttachments.delete(conversationId);
  };

  const revokeAttachmentPreviews = (entries: readonly PendingAttachment[]) => {
    for (const entry of entries) if (entry.previewUrl.startsWith("blob:")) URL.revokeObjectURL(entry.previewUrl);
  };

  const invalidateAttachmentStaging = (conversationId: string) => {
    attachmentStagingGeneration.set(conversationId, (attachmentStagingGeneration.get(conversationId) ?? 0) + 1);
  };

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
        URL.revokeObjectURL(entry.previewUrl);
        setPendingAttachments(conversationId, currentPendingAttachments().filter(candidate => candidate !== entry));
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
        setUnavailableAttachments(conversationId, currentUnavailableAttachments().filter(candidate => candidate !== entry));
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
  const stageAttachmentFiles = async (files: File[]) => {
    const conversationId = activeConversationId();
    if (!conversationId || files.length === 0) return;
    if (agent && !declares("attachments")) return;
    const support = attachmentModelSupport();
    if (!support.supported) {
      setComposerError(`${support.modelName} cannot see images. Pick a model with image support to attach.`);
      return;
    }
    const generation = attachmentStagingGeneration.get(conversationId) ?? 0;
    const noteRefusal = () => noteAttachmentRefusal(conversationId);
    const task = (attachmentStaging.get(conversationId) ?? Promise.resolve()).then(async () => {
      for (const file of files) {
        if ((attachmentStagingGeneration.get(conversationId) ?? 0) !== generation) return;
        if ((pendingAttachments.get(conversationId) ?? []).length + (submittedAttachmentReserve.get(conversationId) ?? 0) >= CHAT_ATTACHMENTS_PER_MESSAGE) {
          setComposerError(`A message can carry at most ${CHAT_ATTACHMENTS_PER_MESSAGE} images.`, conversationId);
          noteRefusal();
          break;
        }
        // An empty type claim is unknown, not unsupported: browsers derive
        // File.type from the filename and local files carry no guarantee, so
        // the authoritative magic-byte sniff on the upload route decides.
        // Only an explicit non-image claim is refused without the round trip.
        if (file.type !== "" && !supportedAttachmentTypes.has(file.type.toLowerCase())) {
          setComposerError(`${file.name || "That file"} is not a supported image (PNG, JPEG, GIF, WebP).`, conversationId);
          noteRefusal();
          continue;
        }
        if (file.size > CHAT_ATTACHMENT_MAX_BYTES) {
          setComposerError(`${file.name || "That image"} is larger than the ${Math.round(CHAT_ATTACHMENT_MAX_BYTES / (1024 * 1024))} MiB limit.`, conversationId);
          noteRefusal();
          continue;
        }
        try {
          const stored = await api.uploadAttachment(conversationId, file);
          if ((attachmentStagingGeneration.get(conversationId) ?? 0) !== generation) return;
          // Keyed to the conversation the upload was staged for, which may no
          // longer be the selected one by the time the round trip returns.
          const entries = pendingAttachments.get(conversationId) ?? [];
          entries.push({ id: stored.id, name: boundAttachmentName(file.name), mimeType: stored.mimeType, previewUrl: URL.createObjectURL(file) });
          setPendingAttachments(conversationId, entries);
        } catch (error) {
          setComposerError(`Could not attach ${file.name || "image"}: ${messageOf(error)}`, conversationId);
          noteRefusal();
        }
      }
    });
    attachmentStaging.set(conversationId, task);
    // The chain existing is what makes an empty draft sendable, so the send
    // control resyncs now, not only when the upload lands.
    syncControls();
    try {
      await task;
    } finally {
      if (attachmentStaging.get(conversationId) === task) attachmentStaging.delete(conversationId);
    }
    renderAttachments();
    syncControls();
  };

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

  const syncRoutineStatus = () => {
    const conversationStatus = projection?.status;
    const stateName = cancelling
      ? "cancelling"
      : submitting || conversationStatus === "sending"
        ? "sending"
        : conversationStatus === "running"
          ? "working"
          : conversationStatus === "failed"
            ? "failed"
            : "ready";
    const label = cancelling
      ? "Cancelling"
      : submitting && conversationStatus !== "running"
        ? "Sending"
        : conversationStatus ? statusLabel(conversationStatus) : "Select a conversation";
    composerStatus.dataset.state = stateName;
    composerStatus.setAttribute("aria-label", label);
    composerStatus.title = stateName === "working" ? workingText() : label;
    const announcement = composerNote ?? label;
    if (announcement !== lastRoutineAnnouncement) {
      lastRoutineAnnouncement = announcement;
      composerStatusLive.textContent = announcement;
    }
  };

  const syncControls = () => {
    const status = projection?.status ?? null;
    if (status !== lastStatus) {
      composerNote = null;
      lastStatus = status;
    }
    const running = projection?.status === "running" || projection?.status === "sending";
    if (projection && running && presentation.workingSince[projection.conversationId] === undefined) {
      const latestUserMessage = [...projection.items].reverse().find(item => item.type === "user_message");
      presentation.workingSince[projection.conversationId] = latestUserMessage?.createdAt ?? Date.now();
      save();
    }
    if (projection && !running && presentation.workingSince[projection.conversationId] !== undefined) {
      delete presentation.workingSince[projection.conversationId];
      save();
    }
    if (running && workingTimer === null) workingTimer = setInterval(() => { syncRoutineStatus(); syncWaiting(); }, 1_000);
    if (!running && workingTimer !== null) {
      clearInterval(workingTimer);
      workingTimer = null;
    }
    send.type = running ? "button" : "submit";
    send.dataset.action = running ? "cancel" : "send";
    // A message needs content, not necessarily words: pending attachments make
    // an empty draft sendable (image-only prompts are accepted end to end),
    // and an upload still in flight counts — submission waits for it.
    const activeId = activeConversationId();
    const hasContent = Boolean(input.value.trim()) || currentPendingAttachments().length > 0
      || (activeId !== null && attachmentStaging.has(activeId));
    send.disabled = running ? cancelling || !projection : submitting || !projection || !hasContent;
    const action = running ? "Cancel" : "Send";
    sendLabel.textContent = action;
    send.setAttribute("aria-label", running ? "Cancel response" : "Send message");
    send.title = running ? "Cancel response" : "Send message";
    configurationTrigger.disabled = submitting || !projection;
    syncHistoryControls();
    olderButton.hidden = !projection?.olderCursor;
    syncRoutineStatus();
    syncWaiting();
  };

  const noteComposer = (message: string | null) => {
    composerNote = message;
    syncRoutineStatus();
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

  const setStagedConfiguration = (conversationId: string, configuration: ConversationConfiguration) => {
    if (configuration.model || configuration.mode || configuration.variant) stagedConfigurations.set(conversationId, configuration);
    else stagedConfigurations.delete(conversationId);
  };

  // A default entry is named by what it runs: "Default · Opus (1M context)"
  // rather than an opaque "Default (recommended)".
  const modelChipName = (model: ChatModel): string => {
    if (model.default && model.resolvesTo) {
      const resolved = models.find(candidate => sameModel(candidate.selection, model.resolvesTo!));
      if (resolved) return `Default · ${resolved.name}`;
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
    configurationSummary.textContent = declares("models")
      ? (displayedModel ? modelChipName(displayedModel) : configuration.model ? `${configuration.model.providerId}/${configuration.model.modelId}` : `Let ${agent?.name ?? "OpenCode"} choose`)
      : "Chat settings";
    const offersMode = declares("modes") && modes.length > 0;
    const offersReasoning = declares("variants") && Boolean(displayedModel?.variants?.length);
    // The chip states only what is in force: a chosen value, or a default
    // the agent itself declares. A delegation without a declared default is
    // said once in the dialog ("Let ... choose"), not echoed here.
    const displayedMode = configuration.mode ?? defaultMode?.name;
    const showMode = offersMode && Boolean(displayedMode);
    const showReasoning = offersReasoning && Boolean(configuration.variant);
    configurationModeSummary.hidden = !showMode;
    configurationModeSummary.textContent = showMode ? configurationOptionLabel(displayedMode!) : "";
    configurationVariantSummary.hidden = !showReasoning;
    configurationVariantValue.textContent = showReasoning ? configurationOptionLabel(configuration.variant!) : "";
    configurationDetails.hidden = !showMode && !showReasoning;
    const accessibleValues = [
      declares("models") ? `Model: ${displayedModel ? modelChipName(displayedModel) : configuration.model ? `${configuration.model.providerId}/${configuration.model.modelId}, unavailable` : `chosen by ${agent?.name ?? "the agent"}`}` : "",
      offersMode ? `Mode: ${displayedMode ? configurationOptionLabel(displayedMode) : `chosen by ${agent?.name ?? "the agent"}`}` : "",
      offersReasoning ? `Reasoning: ${configuration.variant ? configurationOptionLabel(configuration.variant) : `chosen by ${agent?.name ?? "the agent"}`}` : "",
    ].filter(Boolean);
    configurationTrigger.setAttribute("aria-label", accessibleValues.length > 0 ? `Chat configuration. ${accessibleValues.join(". ")}` : "Chat settings");
    configurationPicker?.update({ agent, models, modes, configuration });
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
    if (disposed || activeConversationId() !== id) return;
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
      while (!disposed && conversationRefreshRecovery === recovery && selectionGeneration === token && activeConversationId() === id) {
        if (await refreshSelectedConversation(id)) return;
        if (disposed || conversationRefreshRecovery !== recovery || selectionGeneration !== token || activeConversationId() !== id) return;
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
    projection = projectionFromSnapshot(snapshot, acceptedDrafts);
    historyRefreshRequired.delete(snapshot.conversation.id);
    projectionEpoch += 1;
    conversations = conversations.map(item => item.id === snapshot.conversation.id ? snapshot.conversation : item);
    renderConfiguration();
    renderAttachments();
    announce(snapshot.items.length ? "" : "Start this conversation by sending a message.");
    anchor.restore(presentation.anchors[snapshot.conversation.id] ?? null);
    scheduleRender(false, false);
    stream = api.stream(snapshot.conversation.id, snapshot.cursor, {
      event: (event, cursor) => {
        if (!projection || token !== selectionGeneration) return;
        const result = applyChatEvent(projection, event, cursor);
        if (result.outcome === "gap" || result.outcome === "resync") {
          recoverSelectedConversation(snapshot.conversation.id);
          return;
        }
        projection = result.projection;
        if (event.type === "conversation.configuration") renderConfiguration();
        if (event.type === "conversation.status") {
          if (event.status === "failed") setComposerError(event.message || "The active turn failed.");
          else if (event.status === "sending" || event.status === "running") setComposerError(null);
        }
        if (event.type === "conversation.updated") {
          conversations = conversations.map(conversation => conversation.id === event.conversation.id ? event.conversation : conversation);
          const option = Array.from(select.options).find(candidate => candidate.value === event.conversation.id);
          if (option) option.text = displayConversationTitle(event.conversation);
          if (chatTitle) chatTitle.textContent = displayConversationTitle(event.conversation);
          if (renameInput && renameForm && !renameForm.hidden && document.activeElement !== renameInput) renameInput.value = event.conversation.title;
        }
        if (result.outcome === "applied") { announce(""); scheduleRender(true); }
      },
      resync: () => {
        if (token !== selectionGeneration) return;
        if (historyMutations.has(snapshot.conversation.id)) pendingHistoryResyncs.add(snapshot.conversation.id);
        else recoverSelectedConversation(snapshot.conversation.id);
      },
      error: error => { if (token === selectionGeneration) announce(error.message, true); },
    });
  };

  async function refreshSelectedConversation(id: string): Promise<boolean> {
    const token = selectionGeneration;
    const current = projection;
    if (disposed || !current || current.conversationId !== id || activeConversationId() !== id) return false;
    try {
      const snapshot = await api.snapshot(id);
      if (disposed || token !== selectionGeneration || projection?.conversationId !== id || activeConversationId() !== id) return false;
      const previousStream = stream;
      installConversationSnapshot(snapshot, projection.acceptedDrafts, token);
      if (conversationRefreshRecovery?.conversationId === id && conversationRefreshRecovery.token === token) {
        stopConversationRefreshRecovery();
      }
      previousStream?.close();
      return true;
    } catch (error) {
      if (token === selectionGeneration && activeConversationId() === id) announce(messageOf(error), true);
      return false;
    }
  }

  const selectConversation = async (id: string): Promise<boolean> => {
    stopConversationRefreshRecovery();
    selectedConversationDeleted = false;
    renderSelectedConversationDeleted(document, false);
    // Choosing a conversation is leaving whatever turn was being drilled into:
    // the drill-down is a view over the parent, and the parent is changing.
    closeChildConversation();
    if (renameForm) renameForm.hidden = true;
    const token = ++selectionGeneration;
    stream?.close();
    stream = null;
    const acceptedDrafts = projection?.conversationId === id ? projection.acceptedDrafts : [];
    if (projection) {
      presentation.drafts[projection.conversationId] = input.value;
      const currentAnchor = anchor.currentAnchor();
      if (currentAnchor) presentation.anchors[projection.conversationId] = currentAnchor;
    }
    presentation.selectedId = id;
    const conversation = conversations.find(item => item.id === id);
    if (chatTitle) chatTitle.textContent = conversation ? displayConversationTitle(conversation) : chatHeading();
    form.hidden = false;
    // The identity row, capabilities, and catalogs follow the selected
    // conversation's owning agent (spec: the identity row follows the
    // conversation). Remember the choice as the next creation's default.
    const owningAgentId = conversationAgentId(id);
    if (owningAgentId && owningAgentId !== contextAgentId) await applyAgentContext(owningAgentId);
    if (owningAgentId) {
      presentation.lastAgentId = owningAgentId;
      const state = agentStatusFor(owningAgentId)?.availability.state;
      if (state === "idle" || state === "starting") refreshIdleAgentContext();
    }
    save();
    projection = null;
    // Not a clear: the incoming conversation may hold a refusal that landed
    // while it was deselected, and it surfaces now.
    showComposerError(composerErrors.get(id) ?? null);
    renderConfiguration();
    syncContextIndicator();
    input.value = presentation.drafts[id] ?? "";
    autosize(input);
    renderAttachments();
    announce("Loading conversation...");
    syncControls();
    try {
      const snapshot = await api.snapshot(id);
      if (token !== selectionGeneration) return false;
      installConversationSnapshot(snapshot, acceptedDrafts, token);
      return true;
    } catch (error) {
      if (token === selectionGeneration) announce(messageOf(error), true);
      return false;
    }
  };

  const patchChooser = (selectedId: string | null, deleted = false) => {
    renderSelectedConversationDeleted(document, deleted);
    patchConversationOptions(select, conversations, conversation =>
      agentStatuses.length > 1 && conversation.agent
        ? `${displayConversationTitle(conversation)} · ${conversation.agent.name}`
        : displayConversationTitle(conversation));
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
      select.disabled = conversations.length === 0;
    }
  };

  const installInitialChooser = () => {
    const selected = conversations.some(item => item.id === presentation.selectedId)
      ? presentation.selectedId!
      : conversations[0]?.id ?? null;
    patchChooser(selected);
    if (!selected) {
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
    const selectedId = presentation.selectedId ?? null;
    const selectedMissing = selectedId !== null && !next.some(conversation => conversation.id === selectedId);
    if (selectedMissing) enterSelectedConversationDeleted();

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
  configurationTrigger.addEventListener("click", () => configurationPicker?.open());
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
          if (unavailable) return;
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
      const option = Array.from(select.options).find(candidate => candidate.value === conversation.id);
      if (option) option.text = displayConversationTitle(conversation);
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

  queueDockElement.addEventListener("click", event => {
    const target = (event.target as Element).closest<HTMLButtonElement>("[data-queue-remove]");
    if (!target || !projection) return;
    // The server answers with a queue event that drops the entry on every
    // client; no optimistic removal. A refusal ("no longer held") is the
    // server stating this entry does not exist for it — delivered while the
    // click was in flight, removed elsewhere, or a stale echo a reload left
    // behind — so the local copy reconciles to that instead of stranding a
    // Remove button that can only ever 409.
    const messageId = target.dataset.queueRemove!;
    const conversationId = projection.conversationId;
    target.disabled = true;
    void api.removeQueued(conversationId, messageId, newRequestId())
      .catch(error => {
        if (error instanceof ChatTransportError && error.status === 409 && projection?.conversationId === conversationId) {
          projection = dropQueuedMessage(projection, messageId);
          scheduleRender();
        } else announce(messageOf(error), true);
      })
      .finally(() => { target.disabled = false; });
  });

  revertedItems?.addEventListener("pointerdown", event => {
    if (event.pointerType === "touch" && (event.target as Element).closest("[data-history-restore]")) event.preventDefault();
  });

  revertedItems?.addEventListener("click", event => {
    const target = (event.target as Element).closest<HTMLButtonElement>("[data-history-restore]");
    if (!target || !projection || submitting || historyMutations.has(projection.conversationId)) return;
    const messageId = target.dataset.historyRestore;
    if (!messageId) return;
    target.disabled = true;
    void runHistoryOperation("restore", projection.conversationId, messageId)
      .finally(() => { if (target.isConnected) target.disabled = false; });
  });

  olderButton.addEventListener("click", async () => {
    if (!projection?.olderCursor) return;
    const current = projection;
    olderButton.disabled = true;
    anchor.beforeMutation(geometry());
    try {
      const page = await api.snapshot(current.conversationId, current.olderCursor);
      if (projection?.conversationId !== current.conversationId) return;
      projection = prependSnapshot(projection, page);
      const dirty = renderer.render(items, projection, expanded, declares("subagents"), declares("reversible-history"));
      timeline.scrollTop = anchor.afterMutation(geometry());
      for (const node of dirty) { decorateFileLinks(node); decorateAttachmentImages(node); }
    } catch (error) { announce(messageOf(error), true); }
    finally { olderButton.disabled = false; syncControls(); }
  });

  timeline.addEventListener("scroll", () => {
    if (rendering) return;
    // Cheap while pinned; the full pass runs only once actually unpinned.
    // The first tick that crosses the threshold captures no anchor (items
    // were not collected), which self-heals on the next tick — a transient
    // preferable to a forced layout on every scroll event of a long chat.
    anchor.observe(anchorGeometry());
    if (projection) {
      const current = anchor.currentAnchor();
      if (current) presentation.anchors[projection.conversationId] = current;
      else delete presentation.anchors[projection.conversationId];
      save();
    }
    latestButton.hidden = !anchor.hasUnseen();
    syncPromptRailActive();
  }, { passive: true });
  latestButton.addEventListener("click", () => {
    timeline.scrollTo({ top: anchor.jumpToLatest(geometry()), behavior: reducedMotion() ? "auto" : "smooth" });
    latestButton.hidden = true;
  });

  /**
   * Expanding an activity group inside a transcript, for whichever timeline
   * it belongs to. `expanded` is shared: an item id names one item wherever
   * it is shown, so a group opened in a subagent's transcript stays open.
   */
  const wireExpansionToggle = (
    container: HTMLElement,
    scroller: HTMLElement,
    controller: TimelineAnchorController,
    measure: () => AnchorGeometry,
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
      controller.beforeMutation(measure(), details.dataset.chatItemId);
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
      requestAnimationFrame(() => { scroller.scrollTop = controller.afterMutation(measure()); });
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

  const resolveQuestion = async (source: ChatProjection, itemId: string, outcome: QuestionOutcome) => {
    const item = source.items.find(candidate => candidate.id === itemId);
    if (!item || item.type !== "question" || item.status !== "pending") return;
    disableCard(itemId, true);
    try { await api.question(item.conversationId ?? source.conversationId, item.requestId, newRequestId(), outcome); }
    catch (error) { announceFailureFor(source)(messageOf(error), true); disableCard(itemId, false); }
  };

  /**
   * Every interaction a rendered transcript offers, wired once per timeline.
   * The parent's items and the drill-down's are the same markup rendered from
   * different projections, so the projection they read is the only difference:
   * a request in a subagent's transcript resolves against the subagent, one in
   * the parent's against the parent — which is what keeps the parent
   * answerable while a child is open.
   */
  const wireItemInteractions = (container: HTMLElement, sourceProjection: () => ChatProjection | null) => {
    container.addEventListener("click", event => {
      const target = (event.target as Element).closest<HTMLElement>("[data-file-ref], [data-permission-outcome], [data-permission-choice], [data-question-reject], [data-open-conversation], [data-chat-copy], [data-history-revert]");
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
        openChildConversation(target.dataset.openConversation, subagentLabelFor(target.dataset.openConversation, source));
        return;
      }
      if (target.dataset.fileRef) {
        const reference = resolveWorkspaceFileReference(target.dataset.fileRef, appState.roots);
        if (reference) void navigateWorkspaceFileReference(reference);
        return;
      }
      const itemElement = target.closest<HTMLElement>("[data-chat-item-id]");
      const item = source.items.find(candidate => candidate.id === itemElement?.dataset.chatItemId);
      if (!item || item.type === "assistant_message") return;
      if (item.type === "user_message") {
        if (target.dataset.historyRevert === undefined || source !== projection || submitting || historyMutations.has(source.conversationId)) return;
        const button = target as HTMLButtonElement;
        button.disabled = true;
        void runHistoryOperation("revert", source.conversationId, item.id)
          .finally(() => { if (button.isConnected) button.disabled = false; });
        return;
      }
      if (item.type === "permission" && target.dataset.permissionChoice) {
        // A chosen intent is an approval; the id tells the agent which one.
        void resolvePermission(source, item.id, "approved-once", target.dataset.permissionChoice);
      } else if (item.type === "permission" && target.dataset.permissionOutcome) {
        void resolvePermission(source, item.id, target.dataset.permissionOutcome as PermissionOutcome);
      } else if (item.type === "question" && target.dataset.questionReject !== undefined) {
        void resolveQuestion(source, item.id, { kind: "rejected" });
      }
    });
    container.addEventListener("keydown", event => {
      const target = (event.target as Element).closest<HTMLElement>("[role=button][data-file-ref]");
      if (target && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        target.click();
      }
    });
    container.addEventListener("change", event => {
      const input = event.target as HTMLInputElement;
      const form = input.form;
      if (!form?.matches("form[data-question-form]")) return;
      syncQuestionControl(input, true);
    });
    container.addEventListener("input", event => {
      const input = event.target as HTMLInputElement;
      const form = input.form;
      if (!form?.matches("form[data-question-form]")) return;
      syncQuestionControl(input);
    });
    container.addEventListener("click", event => {
      const tab = (event.target as Element).closest<HTMLButtonElement>("[data-question-tab]");
      if (!tab?.form) return;
      showQuestionPanel(tab.form, Number(tab.dataset.questionTab));
    });
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
      // button is "Next" here, so submitting the form means "go on".
      if (activeIndex < panels.length - 1) {
        showQuestionPanel(questionForm, activeIndex + 1);
        return;
      }
      const answers = collectQuestionAnswers(questionForm);
      // The button is disabled until every step is satisfied, so this only
      // catches a form submitted some other way (Enter in the free-form field).
      const missing = answers.flatMap((answer, index) => answer.length === 0 ? [index] : []);
      if (missing.length > 0) {
        showQuestionPanel(questionForm, missing[0]!);
        announceFailureFor(source)(`Still to answer: ${missing.map(index => item.questions[index]!.header).filter(Boolean).join(", ")}`, true);
        return;
      }
      void resolveQuestion(source, item.id, { kind: "answered", answers });
    });
  };

  const renderChild = (newContent: boolean) => {
    if (!drilldownItems || !drilldownTimeline) return;
    if (!childAnchor.isPinned()) childAnchor.beforeMutation(childGeometry());
    const dirty = childRenderer.render(drilldownItems, child?.projection ?? null, expanded, declares("subagents"));
    if (drilldownOlder) drilldownOlder.hidden = !child?.projection?.olderCursor;
    drilldownTimeline.scrollTop = childAnchor.afterMutation(childAnchorGeometry(), newContent);
    for (const node of dirty) {
      decorateFileLinks(node);
      decorateAttachmentImages(node);
      node.querySelectorAll<HTMLFormElement>("form[data-question-form]").forEach(syncQuestionForm);
    }
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
    open.stream?.close();
    releaseChildBack?.();
    releaseChildBack = null;
    if (drilldownItems) childRenderer.render(drilldownItems, null, expanded, declares("subagents"));
    if (drilldownOlder) {
      drilldownOlder.hidden = true;
      drilldownOlder.disabled = false;
    }
    if (drilldown) drilldown.hidden = true;
    if (drilldownTitle) drilldownTitle.textContent = "";
    announceChild("");
    surface.removeAttribute("data-chat-drilldown");
    // Back to the parent at its live position: it never unmounted, so this is
    // only re-asserting the anchor the timeline was already holding.
    timeline.scrollTop = anchor.afterMutation(geometry());
    timeline.focus({ preventScroll: true });
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
  const openChildConversation = (id: string, label: string) => {
    if (!drilldown || !drilldownItems || !drilldownTimeline) return;
    const generation = ++childGeneration;
    drilldownClosePending = false;
    const previous = child;
    previous?.stream?.close();
    const next: Drilldown = { conversationId: id, label, projection: null, stream: null };
    const nested = previous !== null;
    child = next;
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
    childRenderer.render(drilldownItems, null, expanded, declares("subagents"));
    // Hidden until this child's own first page says whether more exists —
    // otherwise a previous subagent's cursor would offer paging for a
    // transcript that has none.
    if (drilldownOlder) {
      drilldownOlder.hidden = true;
      drilldownOlder.disabled = false;
    }
    childAnchor.restore(null);
    announceChild("Loading transcript…");
    drilldownBack?.focus();
    void (async () => {
      try {
        const snapshot = await api.snapshot(id);
        if (generation !== childGeneration || child !== next) return;
        next.projection = projectionFromSnapshot(snapshot, []);
        announceChild(snapshot.items.length ? "" : "This subagent has not reported anything yet.");
        renderChild(false);
        next.stream = api.stream(id, snapshot.cursor, {
          event: (event, cursor) => {
            if (generation !== childGeneration || !next.projection) return;
            const result = applyChatEvent(next.projection, event, cursor);
            // A gap in a drill-down is refetched in place; it is a view over a
            // turn, so there is no selection to re-run.
            if (result.outcome === "gap" || result.outcome === "resync") {
              openChildConversation(id, label);
              return;
            }
            next.projection = result.projection;
            if (result.outcome === "applied") { announceChild(""); renderChild(true); }
          },
          resync: () => { if (generation === childGeneration) openChildConversation(id, label); },
          error: error => { if (generation === childGeneration) announceChild(error.message, true); },
        });
      } catch (error) {
        if (generation === childGeneration) announceChild(messageOf(error), true);
      }
    })();
  };

  // The same paging the parent timeline offers: a subagent's transcript is
  // fetched one page at a time like any conversation, and without a way to
  // ask for the rest a long one simply began mid-story.
  drilldownOlder?.addEventListener("click", async () => {
    const open = child;
    if (!open?.projection?.olderCursor) return;
    const generation = childGeneration;
    drilldownOlder.disabled = true;
    childAnchor.beforeMutation(childGeometry());
    try {
      const page = await api.snapshot(open.conversationId, open.projection.olderCursor);
      if (generation !== childGeneration || child !== open || !open.projection) return;
      open.projection = prependSnapshot(open.projection, page);
      renderChild(false);
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

  wireExpansionToggle(items, timeline, anchor, geometry);
  wireItemInteractions(items, () => projection);
  if (drilldownItems && drilldownTimeline) {
    wireExpansionToggle(drilldownItems, drilldownTimeline, childAnchor, childGeometry);
    wireItemInteractions(drilldownItems, () => child?.projection ?? null);
    drilldownTimeline.addEventListener("scroll", () => { childAnchor.observe(childAnchorGeometry()); }, { passive: true });
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

  const renderCommandMenu = () => {
    const next = matchingCommands(input.value, input.selectionStart ?? input.value.length, commands);
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
      option.innerHTML = `<span class="chat-command-name">/${escapeHtml(command.name)}</span><span class="chat-command-hint">${escapeHtml(command.argumentHint)}</span><span class="chat-command-description">${escapeHtml(command.description)}</span>`;
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
    if (projection) { presentation.drafts[projection.conversationId] = input.value; save(); }
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
    if (commandMatch && (event.key === "Enter" || event.key === "Tab") && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      chooseCommand(commandIndex);
      return;
    }
    if (commandMatch && event.key === "Escape") { event.preventDefault(); closeCommandMenu(); return; }
    const running = projection?.status === "running" || projection?.status === "sending";
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing
      && (event.metaKey || event.ctrlKey || document.documentElement.dataset.uiMode !== "touch" || running)) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  const syncEditingFocus = () => {
    const editing = surface.contains(document.activeElement) && isTextEditingControl(document.activeElement);
    document.documentElement.toggleAttribute("data-chat-editing", editing);
    document.documentElement.toggleAttribute("data-chat-input-focused", document.activeElement === input);
    viewport.apply();
  };
  surface.addEventListener("focusin", syncEditingFocus);
  surface.addEventListener("focusout", () => queueMicrotask(syncEditingFocus));
  send.addEventListener("pointerdown", event => {
    if (event.pointerType === "touch") event.preventDefault();
  });
  send.addEventListener("click", async () => {
    if (!projection || (projection.status !== "running" && projection.status !== "sending") || cancelling) return;
    // Captured for the round trip: a failure landing after a switch belongs
    // to the conversation whose turn was being cancelled.
    const conversationId = projection.conversationId;
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

  const installRestoredDraft = (conversationId: string, draft: RestoredDraft | undefined, updateVisible: boolean) => {
    const restored = draft ?? { text: "" };
    const available: PendingAttachment[] = [];
    const unavailable: MessageAttachment[] = [];
    for (const attachment of restored.attachments ?? []) {
      if (attachment.id) {
        available.push({ ...attachment, id: attachment.id, previewUrl: api.attachmentUrl(attachment.id) });
      } else {
        unavailable.push(attachment);
      }
    }
    revokeAttachmentPreviews(pendingAttachments.get(conversationId) ?? []);
    setPendingAttachments(conversationId, available);
    setUnavailableAttachments(conversationId, unavailable);
    presentation.drafts[conversationId] = restored.text;
    save();
    if (!updateVisible) return unavailable.length;
    input.value = restored.text;
    autosize(input);
    renderAttachments();
    syncControls();
    input.focus();
    return unavailable.length;
  };

  const historyLabel = (operation: HistoryOperation) => operation[0]!.toUpperCase() + operation.slice(1);
  const historyRetryInstruction = (operation: HistoryOperation) => operation === "undo" || operation === "redo"
    ? `Submit /${operation} again`
    : `Choose ${historyLabel(operation)} message again`;
  const historyPreservedState = (operation: HistoryOperation) => operation === "undo" || operation === "redo"
    ? "command and attachments"
    : "composer and attachments";
  const historyProgressLabel = (operation: HistoryOperation) => operation === "restore"
    ? "Restoring..."
    : `${historyLabel(operation)}ing...`;

  const installChangedHistoryResult = async (operation: HistoryOperation, conversationId: string, result: ReversibleHistoryResult): Promise<boolean> => {
    const label = historyLabel(operation);
    retryRequests.delete(conversationId);
    invalidateAttachmentStaging(conversationId);
    if (activeConversationId() !== conversationId) {
      const unavailable = installRestoredDraft(conversationId, result.restoredDraft, false);
      if (unavailable > 0) {
        setComposerError(`${unavailable} restored ${unavailable === 1 ? "attachment is" : "attachments are"} unavailable and will not be sent.`, conversationId);
      }
      historyRetries.delete(conversationId);
      noteComposer(null);
      return true;
    }

    const refreshed = await refreshSelectedConversation(conversationId);
    pendingHistoryResyncs.delete(conversationId);
    if (activeConversationId() !== conversationId) {
      installRestoredDraft(conversationId, result.restoredDraft, false);
      historyRetries.delete(conversationId);
      noteComposer(null);
      return true;
    }
    if (!refreshed) {
      historyRefreshRequired.add(conversationId);
      const message = `${label} completed, but the conversation could not be refreshed. ${historyRetryInstruction(operation)} to reconnect; the ${historyPreservedState(operation)} were kept.`;
      setComposerError(message, conversationId);
      noteComposer(message);
      return false;
    }

    const unavailable = installRestoredDraft(conversationId, result.restoredDraft, true);
    const unavailableMessage = unavailable > 0
      ? `${unavailable} restored ${unavailable === 1 ? "attachment is" : "attachments are"} unavailable and will not be sent.`
      : null;
    historyRetries.delete(conversationId);
    setComposerError(unavailableMessage, conversationId);
    noteComposer(unavailableMessage ? `${label} complete. ${unavailableMessage}` : `${label} complete`);
    return true;
  };

  const runHistoryOperation = async (operation: HistoryOperation, conversationId: string, messageId?: string) => {
    const label = historyLabel(operation);
    submitting = true;
    historyMutations.add(conversationId);
    setComposerError(null, conversationId);
    noteComposer(historyProgressLabel(operation));
    closeCommandMenu();
    syncControls();
    try {
      const pending = historyRetries.get(conversationId);
      if (pending?.result && pending.operation === operation && pending.messageId === messageId) {
        await installChangedHistoryResult(pending.operation, conversationId, pending.result);
        return;
      }
      if (historyRefreshRequired.has(conversationId)) {
        const refreshed = await refreshSelectedConversation(conversationId);
        if (!refreshed) {
          const message = `The conversation could not be refreshed. ${historyRetryInstruction(operation)} to retry; the ${historyPreservedState(operation)} were kept.`;
          setComposerError(message, conversationId);
          noteComposer(message);
          return;
        }
      }

      const retry: { operation: HistoryOperation; messageId?: string; requestId: string; result?: ReversibleHistoryResult } =
        pending?.operation === operation && pending.messageId === messageId
          ? pending
          : { operation, ...(messageId ? { messageId } : {}), requestId: newRequestId() };
      historyRetries.set(conversationId, retry);
      const result = operation === "undo" || operation === "redo"
        ? await api[operation](conversationId, retry.requestId)
        : await api[operation](conversationId, messageId!, retry.requestId);
      if (result.outcome !== "changed") {
        historyRetries.delete(conversationId);
        if (pendingHistoryResyncs.delete(conversationId)) {
          const refreshed = await refreshSelectedConversation(conversationId);
          if (!refreshed && activeConversationId() === conversationId) {
            historyRefreshRequired.add(conversationId);
            const message = `${result.outcome === "nothing-to-undo" ? "Nothing more to undo" : "Nothing to redo"}, but the conversation could not be refreshed. Submit /${operation} again to reconnect.`;
            setComposerError(message, conversationId);
            noteComposer(message);
            return;
          }
        }
        if (activeConversationId() === conversationId) {
          noteComposer(result.outcome === "nothing-to-undo" ? "Nothing more to undo" : "Nothing to redo");
        } else {
          noteComposer(null);
        }
        return;
      }
      retry.result = result;
      await installChangedHistoryResult(operation, conversationId, result);
    } catch (error) {
      const preserved = historyPreservedState(operation);
      let message = `${label} failed: ${messageOf(error)}. ${preserved[0]!.toUpperCase()}${preserved.slice(1)} kept.`;
      if (pendingHistoryResyncs.delete(conversationId)) {
        const refreshed = await refreshSelectedConversation(conversationId);
        if (!refreshed && activeConversationId() === conversationId) {
          historyRefreshRequired.add(conversationId);
          message += ` The conversation also needs to reconnect; ${historyRetryInstruction(operation)} to retry.`;
        }
      }
      setComposerError(message, conversationId);
      if (activeConversationId() === conversationId) noteComposer(message);
      else noteComposer(null);
    } finally {
      historyMutations.delete(conversationId);
      submitting = false;
      syncControls();
    }
  };

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!projection || submitting) return;
    const operation = localHistoryOperation(input.value, commands, declares("reversible-history"));
    if (operation) {
      const conversationId = projection.conversationId;
      if (!commandInventoryAvailable) {
        submitting = true;
        noteComposer("Reloading commands...");
        syncControls();
        const loaded = await (async () => {
          if (!contextAgentId) return false;
          try {
            commands = await api.commands(contextAgentId);
            commandInventoryAvailable = true;
            const cached = agentCatalogs.get(contextAgentId);
            if (cached) agentCatalogs.set(contextAgentId, { ...cached, commands, commandInventoryAvailable: true });
            return true;
          } catch {
            return false;
          }
        })();
        submitting = false;
        if (!loaded) {
          const message = `Chat commands could not be loaded. Submit /${operation} again to retry; the command and attachments were kept.`;
          setComposerError(message, conversationId);
          noteComposer(activeConversationId() === conversationId ? message : null);
          syncControls();
          return;
        }
        if (activeConversationId() !== conversationId) {
          syncControls();
          return;
        }
      }
      await runHistoryOperation(operation, conversationId);
      return;
    }
    // In-flight staging is prospective content: an image-only submit during
    // its own upload waits for the drain below rather than being refused.
    if (!input.value.trim() && currentPendingAttachments().length === 0 && !attachmentStaging.has(projection.conversationId)) return;
    const conversationId = projection.conversationId;
    const text = input.value;
    // Restoration must not pick between the failed message and edits made
    // while it was in flight — both are the user's words. The captured
    // text leads, the newer edits follow as their own line.
    const restoreDraftText = () => {
      if (!text.trim()) return;
      input.value = input.value.trim() ? `${text}\n${input.value}` : text;
      autosize(input);
    };
    // The same rule for a submission that ends while another conversation is
    // selected: the switch already stored any newer edits as this
    // conversation's draft, and the captured text — never sent — must lead
    // rather than being discarded because the slot is occupied.
    const mergeStoredDraft = () => {
      if (!text.trim()) return;
      const edits = presentation.drafts[conversationId];
      presentation.drafts[conversationId] = edits?.trim() ? `${text}\n${edits}` : text;
      save();
    };
    const refusalsAtSubmit = attachmentRefusals.get(conversationId) ?? 0;
    submitting = true;
    setComposerError(null);
    // Captured AND cleared before any yield: the textarea stays editable
    // while the drain below waits, and anything typed then belongs to the
    // next message — an after-the-wait clear would erase it.
    input.value = "";
    presentation.drafts[conversationId] = "";
    save();
    autosize(input);
    // An upload attached moments before Enter belongs to THIS message:
    // submission waits for in-flight staging rather than snapshotting a list
    // the upload has not reached yet (and leaking the image into the next
    // message).
    let stagingTail = attachmentStaging.get(conversationId);
    if (stagingTail) {
      noteComposer("Uploading images...");
      // Drain, not snapshot: an intake can append a new chain link while
      // this await yields, and a snapshot would submit without it.
      while (stagingTail) {
        await stagingTail.catch(() => undefined);
        const next = attachmentStaging.get(conversationId);
        stagingTail = next === stagingTail ? undefined : next;
      }
      // The wait yielded: the user may have switched conversations. The text
      // belongs to the conversation it was written in, so it becomes that
      // conversation's draft instead of being sent against the wrong one.
      if (!projection || projection.conversationId !== conversationId) {
        mergeStoredDraft();
        submitting = false;
        syncControls();
        return;
      }
      // Edits made during the wait are the next draft, not part of this
      // message; nothing to do — they are already in the input.
    }
    // A refusal that landed during the drain is a piece of THIS message
    // going missing: the user pressed send believing the upload was
    // included, so the send stops rather than delivering a partial prompt.
    // The staging path already named the refusal on the error line, and any
    // successfully staged files stay pending for the corrected retry.
    if ((attachmentRefusals.get(conversationId) ?? 0) !== refusalsAtSubmit) {
      restoreDraftText();
      presentation.drafts[conversationId] = input.value;
      save();
      submitting = false;
      noteComposer("Message not sent; draft kept");
      renderAttachments();
      syncControls();
      return;
    }
    // The drain can end with nothing to send: an image-only submission whose
    // upload was refused has no content left, and the staging path already
    // explained why on the composer error line.
    if (!text.trim() && (pendingAttachments.get(conversationId) ?? []).length === 0) {
      // Restore the (empty) capture only if the user typed nothing meanwhile.
      if (!input.value.trim() && text) { input.value = text; autosize(input); }
      submitting = false;
      syncControls();
      return;
    }
    // Staged images can outlive the model choice that admitted them: a later
    // switch to a model without image support disables further intake, but
    // the send itself must refuse too, or the prompt would carry images the
    // selected model cannot see and the outcome would be the provider's to
    // improvise. Same wording as the intake refusal, plus the way out.
    const support = attachmentModelSupport();
    if (!support.supported && (pendingAttachments.get(conversationId) ?? []).length > 0) {
      restoreDraftText();
      presentation.drafts[conversationId] = input.value;
      save();
      submitting = false;
      setComposerError(`${support.modelName} cannot see images. Remove them or pick a model with image support.`);
      syncControls();
      return;
    }
    // Captured and cleared optimistically like the text; restored on failure.
    const stagedAttachments = [...(pendingAttachments.get(conversationId) ?? [])];
    const stagedUnavailableAttachments = [...(unavailableAttachments.get(conversationId) ?? [])];
    const attachmentRefs: MessageAttachment[] = stagedAttachments.map(({ id, name, mimeType }) => ({ id, name, mimeType }));
    submittedAttachmentReserve.set(conversationId, (submittedAttachmentReserve.get(conversationId) ?? 0) + stagedAttachments.length);
    const releaseAttachmentReserve = () => {
      const remaining = (submittedAttachmentReserve.get(conversationId) ?? 0) - stagedAttachments.length;
      if (remaining > 0) submittedAttachmentReserve.set(conversationId, remaining);
      else submittedAttachmentReserve.delete(conversationId);
    };
    const attachmentKey = stagedAttachments.map(entry => entry.id).join("\n");
    const retry = retryRequests.get(conversationId);
    const retriedRequest = retry?.text === text && retry.attachments === attachmentKey;
    const requestId = retriedRequest ? retry!.requestId : newRequestId();
    const configuration = displayedConfiguration();
    const selectedModelRecord = declares("models") && configuration.model
      ? models.find(model => sameModel(model.selection, configuration.model!))
      : undefined;
    const selectedModel = selectedModelRecord?.selection;
    const selectedVariant = declares("variants") && configuration.variant && selectedModelRecord?.variants?.includes(configuration.variant)
      ? configuration.variant
      : undefined;
    const selectedMode = declares("modes") && modes.some(mode => mode.name === configuration.mode) ? configuration.mode : undefined;
    // Captured before the round trip: a queue event that lands while the
    // acceptance is in flight makes the stream authoritative, and the local
    // held echo below must then stand down. The epoch catches the same
    // staleness across a projection reload, where the revision restarts.
    const queueRevisionAtSubmit = projection.queueRevision;
    const configurationRevisionAtSubmit = projection.configurationRevision;
    const projectionEpochAtSubmit = projectionEpoch;
    // Optimistic send: the message shows immediately and the input clears;
    // on failure the draft is removed and the text restored.
    projection = addAcceptedDraft(projection, { requestId, messageId: `pending:${requestId}`, text, ...(attachmentRefs.length ? { attachments: attachmentRefs } : {}) });
    setPendingAttachments(conversationId, []);
    setUnavailableAttachments(conversationId, []);
    renderAttachments();
    noteComposer("Sending...");
    syncControls();
    scheduleRender(true);
    try {
      const accepted = await api.prompt(conversationId, requestId, text, selectedModel, selectedMode, selectedVariant, attachmentRefs.length ? attachmentRefs : undefined);
      retryRequests.delete(conversationId);
      stagedConfigurations.delete(conversationId);
      if (accepted.conversation) {
        conversations = conversations.map(conversation => conversation.id === accepted.conversation!.id ? accepted.conversation! : conversation);
        const option = Array.from(select.options).find(candidate => candidate.value === accepted.conversation!.id);
        if (option) option.text = displayConversationTitle(accepted.conversation);
        if (chatTitle) chatTitle.textContent = displayConversationTitle(accepted.conversation);
      }
      if (projection?.conversationId === conversationId) {
        // The acceptance's committed configuration stands only while the
        // stream has not spoken since the request left and the projection
        // was not reloaded — a configuration event that landed meanwhile
        // (a reactivated queue head re-asserting its frozen selections, or
        // this very commit's own event) is at least as new as this
        // response, and a retried request can carry a receipt replayed
        // from before all of it. Same authority rule as the queue echo.
        if (!retriedRequest && projectionEpoch === projectionEpochAtSubmit && projection.configurationRevision === configurationRevisionAtSubmit) {
          projection = { ...projection, configuration: accepted.configuration };
        }
        // A held acceptance moves the draft into the queue dock immediately;
        // the server's queue event restates the same state and converges. A
        // dispatched acceptance becomes a timeline item. The echo carries the
        // pre-flight queue revision so a delivery or removal that outran the
        // acceptance is not resurrected as a phantom entry — and stands down
        // entirely after a reload or on a retried request. The echo exists
        // only to bridge a FRESH acceptance and its queue event: a retry's
        // response can be a replayed receipt for a message the stream has
        // since resolved (delivered, or removed by another client) with
        // nothing durable left to check it against, while anything the first
        // attempt really held has long been stated by the stream itself.
        projection = accepted.held
          ? !retriedRequest && projectionEpoch === projectionEpochAtSubmit
            ? noteQueuedMessage(projection, { id: accepted.messageId, text, queuedAt: Date.now(), requestId, ...(attachmentRefs.length ? { attachments: attachmentRefs } : {}) }, queueRevisionAtSubmit)
            : removeAcceptedDraft(projection, requestId)
          : confirmAcceptedDraft(projection, { requestId, messageId: accepted.messageId, text, ...(attachmentRefs.length ? { attachments: attachmentRefs } : {}) });
        renderConfiguration();
        scheduleRender(true);
      }
      noteComposer(accepted.held ? "Queued — sends when the agent is ready" : "Message accepted");
      // Addressed to the submitted conversation, not the selection: the
      // acceptance may land after a switch, and clearing the selected
      // conversation's own error would erase an unrelated reason.
      setComposerError(null, conversationId);
      // The message is accepted; the local previews have no further use.
      for (const staged of stagedAttachments) URL.revokeObjectURL(staged.previewUrl);
      releaseAttachmentReserve();
    } catch (error) {
      const message = messageOf(error);
      announce(message, true);
      retryRequests.set(conversationId, { text, requestId, attachments: attachmentKey });
      // The refused message's attachments go back to pending — uploaded bytes
      // are still stored, so the references stay valid for the retry. The
      // reserve releases only now that they are pending again, so intake
      // during the flight could never overfill the restored draft.
      setPendingAttachments(conversationId, [...stagedAttachments, ...(pendingAttachments.get(conversationId) ?? [])]);
      setUnavailableAttachments(conversationId, [...stagedUnavailableAttachments, ...(unavailableAttachments.get(conversationId) ?? [])]);
      releaseAttachmentReserve();
      if (projection?.conversationId === conversationId) {
        projection = removeAcceptedDraft(projection, requestId);
        restoreDraftText();
        presentation.drafts[conversationId] = input.value;
        save();
        renderAttachments();
        scheduleRender();
      } else {
        // Switched away while the request was in flight: the live input now
        // belongs to another conversation, so the failed text goes back into
        // the stored draft — ahead of any edits stored by the switch — and
        // reappears on return.
        mergeStoredDraft();
      }
      submitting = false;
      // Same addressing as the success clear: a refusal that lands after a
      // switch waits with its own conversation instead of flashing here.
      setComposerError(`${message}. Draft restored.`, conversationId);
      noteComposer("Message not accepted; draft restored");
      syncControls();
      return;
    }
    submitting = false;
    syncControls();
  });
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
    if (anchor.isPinned()) timeline.scrollTop = anchor.afterMutation(geometry());
    else if (anchor.currentAnchor()) timeline.scrollTop = anchor.afterMutation(geometry());
  }) : null;
  observer?.observe(items);
  viewport.start();
  window.addEventListener("pagehide", () => {
    disposed = true;
    stopConversationRefreshRecovery();
    flushSave();
    stream?.close();
    inventoryStream?.close();
    child?.stream?.close();
    observer?.disconnect();
    surfaceObserver.disconnect();
    viewport.stop();
    configurationPicker?.destroy();
    if (workingTimer !== null) clearInterval(workingTimer);
  }, { once: true });

  // Bootstrap is deferred until Chat is actually the active surface: status()
  // lazily launches the OpenCode server, and merely opening Preview, Files, or
  // Terminal must not pay that cost. A restored Chat surface bootstraps
  // immediately via the initial surface-state check. Failures — a stale PWA
  // cookie 401, a transient status error — leave the bootstrap re-runnable:
  // it retries on the next Chat activation and on credential refresh.
  let bootstrapped = false;
  let bootstrapping = false;

  /**
   * Loads (or reuses) one agent's catalogs and installs them as the
   * selected-agent view. Capability-gated per agent: an undeclared catalog
   * is an empty list, never a request.
   */
  const applyAgentContext = async (agentId: string | undefined): Promise<void> => {
    const status = agentStatusFor(agentId) ?? agentStatuses[0];
    contextAgentId = status?.agent.id;
    agent = status?.availability.state === "ready" ? status.availability.agent : undefined;
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
      const [nextModels, nextCommands, nextModes] = await Promise.all([
        has("models") ? api.models(status.agent.id).catch(() => [] as ChatModel[]) : Promise.resolve([] as ChatModel[]),
        wantsCommands ? api.commands(status.agent.id).then(list => ({ list, ok: true })).catch(() => ({ list: [] as ChatCommand[], ok: false })) : Promise.resolve({ list: [] as ChatCommand[], ok: true }),
        has("modes") ? api.modes(status.agent.id).catch(() => [] as ChatMode[]) : Promise.resolve([] as ChatMode[]),
      ]);
      // The awaited fetch may resolve after the user moved to another
      // agent's conversation; installing these lists then would dress that
      // conversation in this agent's catalog (a Claude "Default" chip on an
      // OpenCode conversation).
      if (contextAgentId !== status.agent.id) return;
      catalogs = { models: nextModels, modes: nextModes, commands: nextCommands.list, commandInventoryAvailable: nextCommands.ok };
      // A failed command read is not banked: the next context switch
      // retries. Neither is an empty list from an agent that declares the
      // capability — its inventory may simply not have hydrated yet, and
      // banking would hide every command for the rest of the page's life.
      if (nextCommands.ok && (nextCommands.list.length > 0 || !has("commands"))) agentCatalogs.set(status.agent.id, catalogs);
    }
    models = catalogs.models;
    modes = catalogs.modes;
    commands = catalogs.commands;
    commandInventoryAvailable = catalogs.commandInventoryAvailable;
    form.hidden = false;
    renderConfiguration();
  };

  /**
   * A selected conversation whose agent has not reported ready yet: the
   * selection itself makes the server start that agent, so poll status
   * until it lands as ready or unavailable — that is what upgrades the
   * identity row from registry name to declaration and loads the catalogs.
   * Gated on an actual selection so an untouched idle agent is never polled.
   */
  let statusRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const refreshIdleAgentContext = () => {
    if (statusRefreshTimer !== null) return;
    statusRefreshTimer = setTimeout(async () => {
      statusRefreshTimer = null;
      const watching = contextAgentId;
      if (!watching || conversationAgentId(presentation.selectedId) !== watching) return;
      try {
        agentStatuses = await api.status();
      } catch {
        return;
      }
      if (contextAgentId !== watching) return;
      await applyAgentContext(watching);
      const state = agentStatusFor(watching)?.availability.state;
      if (state === "idle" || state === "starting") refreshIdleAgentContext();
    }, 1_500);
  };

  const startInventoryStream = () => {
    if (inventoryStream) return;
    try {
      inventoryStream = api.inventoryStream({
        invalidation: () => { void inventoryReconciler.request(); },
        error: error => announce(error.message, true),
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
        agentStatuses = agentStatuses.map(status => status.agent.id === agentId ? next : status);
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
    try {
      agentStatuses = await api.status();
      // Every offered agent down at once is the only full takeover: with no
      // agent to converse with, the surface's job is the diagnosis + retry.
      const anyUsable = agentStatuses.some(status => status.availability.state !== "unavailable");
      if (!anyUsable) {
        const worst = agentStatuses[0]!;
        if (worst.availability.state === "unavailable") showUnavailable(worst.agent.id, worst.availability, { takeover: true });
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
      const [, nextConversations] = await Promise.all([
        applyAgentContext(preferred.agent.id),
        api.conversations(),
      ]);
      conversations = dedupeConversationInventory([...conversations, ...nextConversations]);
      // Bootstrap is the silent page-local baseline. The stream starts only
      // after this point, so its mandatory initial frame reconciles rather
      // than turning every existing id into an unseen one.
      inventoryTracker.reconcile(conversations);
      syncInventoryAwareness();
      form.hidden = false;
      select.disabled = false;
      newButton.disabled = false;
      renderConfiguration();
      announce(conversations.length ? "" : "No conversations yet. Create one to start.");
      // A selection made mid-bootstrap is the user's; the initial chooser
      // pass must not replace it with this snapshot's newest entry.
      if (selectionGeneration === selectionAtStart) installInitialChooser();
      else patchChooser(presentation.selectedId ?? null);
      bootstrapped = true;
      startInventoryStream();
    } catch (error) { announce(messageOf(error), true); }
    finally { bootstrapping = false; }
  };
  const chatSurfaceActive = () => {
    const root = document.documentElement;
    return root.getAttribute("data-ui-mode") === "touch"
      ? root.getAttribute("data-active-tab") === "chat"
      : root.getAttribute("data-chat-panel") === "open";
  };
  let chatWasActive = false;
  const handleChatSurfaceState = () => {
    const active = chatSurfaceActive();
    const becameActive = active && !chatWasActive;
    chatWasActive = active;
    if (!active) return;
    if (!bootstrapped) void bootstrap();
    else if (becameActive) {
      startInventoryStream();
      void inventoryReconciler.request();
    }
  };
  const surfaceObserver = new MutationObserver(handleChatSurfaceState);
  surfaceObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-chat-panel", "data-active-tab", "data-ui-mode"] });
  onWorkspaceCredentialRefresh(() => {
    if (bootstrapped) {
      startInventoryStream();
      void inventoryReconciler.request();
    } else if (chatSurfaceActive()) {
      void bootstrap();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && bootstrapped) void inventoryReconciler.request();
  });
  handleChatSurfaceState();
}

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

function readPresentation(): Presentation {
  try {
    const raw = presentationLocalStorage()?.getItem(PRESENTATION_KEY);
    if (!raw) return structuredClone(EMPTY_PRESENTATION);
    const value = JSON.parse(raw) as Partial<Presentation>;
    return {
      selectedId: typeof value.selectedId === "string" ? value.selectedId : undefined,
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

/**
 * Token counts at a glance: `840`, `12.4k`, `1.2M`. The exact figure is always
 * one hover or one expansion away (the title attribute and the breakdown), so
 * the compact form never has to be the only statement.
 */
function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function modelValue(model: ModelSelection): string {
  return JSON.stringify([model.providerId, model.modelId]);
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
