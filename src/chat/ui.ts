import { escapeHtml } from "../shared/html";
import { appState } from "../shell/state";
import { presentationLocalStorage } from "../shell/presentation-storage";
import { registerBackInterceptor } from "../shell/history";
import { onWorkspaceCredentialRefresh } from "../terminal/client";
import { ChatApiClient, ChatTransportError, type ChatEventStream } from "./client";
import { TimelineAnchorController, type AnchorGeometry, type TimelineAnchor } from "./anchor";
import { ChatViewportController } from "./viewport";
import { newRequestId } from "./ids";
import { insertCommand, matchingCommands } from "./slash-commands";
import { navigateWorkspaceFileReference, resolveWorkspaceFileReference } from "./file-references";
import { READER_CLOSED, QueueDockRenderer, TimelineRenderer, decorateAttachmentImages, decorateFileLinks, latestTodoEntries, statusLabel, subagentEntries, type SubagentEntry } from "./timeline-renderer";
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
import { CHAT_ATTACHMENT_MAX_BYTES, CHAT_ATTACHMENT_MIME_TYPES, CHAT_ATTACHMENTS_PER_MESSAGE, type ChatAgent, type ChatCapability, type ChatMode, type ChatAvailability, type ChatCommand, type ChatModel, type ConversationConfiguration, type ConversationItem, type ConversationSummary, type MessageAttachment, type ModelSelection, type PermissionOutcome, type QuestionOutcome, type TokenUsage } from "./types";
import { formatDiagnostics } from "./diagnostics";
import { collectQuestionAnswers, showQuestionPanel, syncQuestionControl, syncQuestionForm } from "./question-form";
import { configurationOptionLabel, createChatConfigurationPicker, type ChatConfigurationPickerController } from "./configuration-picker";
import { copyChatText } from "./copy-actions";

const PRESENTATION_KEY = "uatu:chat-presentation";
const SAVE_DEBOUNCE_MS = 400;
const MAX_EXPANDED_ENTRIES = 400;
type Presentation = {
  selectedId?: string;
  drafts: Record<string, string>;
  expanded: string[];
  anchors: Record<string, TimelineAnchor>;
  workingSince: Record<string, number>;
  // Dismissed finished-subagent entry ids, per conversation — dismissal is a
  // user statement that must survive reload.
  dismissedSubagents: Record<string, string[]>;
};

const EMPTY_PRESENTATION: Presentation = { drafts: {}, expanded: [], anchors: {}, workingSince: {}, dismissedSubagents: {} };

export function initChat(): void {
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

  const api = new ChatApiClient();
  const anchor = new TimelineAnchorController();
  const viewport = new ChatViewportController(surface, form, timeline, anchor);
  const renderer = new TimelineRenderer();
  const queueDock = new QueueDockRenderer();
  let presentation = readPresentation();
  let conversations: ConversationSummary[] = [];
  let models: ChatModel[] = [];
  let modes: ChatMode[] = [];
  let commands: ChatCommand[] = [];
  let projection: ChatProjection | null = null;
  const stagedConfigurations = new Map<string, ConversationConfiguration>();
  let configurationPicker: ChatConfigurationPickerController | null = null;
  let stream: ChatEventStream | null = null;
  let selectionGeneration = 0;
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
  const nameAgent = () => {
    // Both, not one or the other: the workspace label answers "where am I"
    // and the agent name answers "who am I talking to". A nullish chain would
    // have hidden the agent on every workspace that has a root — which is all
    // of them — leaving the composer as the only place it was named.
    if (chatContext) chatContext.textContent = [appState.roots[0]?.label, agent?.name].filter(Boolean).join(" · ") || "Chat";
    if (inputLabel) inputLabel.textContent = agent ? `Message ${agent.name}` : "Send a message";
    if (input) input.placeholder = agent ? `Ask ${agent.name}…` : "Send a message…";
  };
  const chatHeading = () => (agent ? `${agent.name} Chat` : "Chat");
  // An agent that declared itself is believed exactly: a capability it did not
  // list is one it does not have. When no agent has been reported at all — an
  // older workspace, or the moment before the adapter exists — nothing is
  // known, so nothing is withheld.
  const declares = (capability: ChatCapability) => agent?.capabilities.includes(capability) ?? true;
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
    // An agent that does not report token usage has no context readout to
    // show, and a permanently empty meter would claim otherwise.
    if (!declares("context")) contextUsage?.remove();
    if (!declares("conversation-rename")) renameButton?.remove();
    else if (renameButton) renameButton.hidden = false;
    // Removed, not disabled, per the capability rule above. The model-level
    // gate is different — see syncAttachControl: a model choice flips often,
    // so there the control stays visible and goes inactive instead.
    if (!declares("attachments")) attachButton?.remove();
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
    const known = new Set(conversations.map(conversation => conversation.id));
    if (projection) known.add(projection.conversationId);
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
  const subagentLabel = (entry: SubagentEntry): string =>
    entry.subagent ? `${entry.subagent} · ${entry.description}` : entry.description;
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
    if (!usage) {
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

  const renderNow = (newContent: boolean) => {
    rendering = true;
    const dirty = renderer.render(items, projection, expanded, declares("subagents"));
    queueDock.render(queueDockElement, projection?.queued ?? []);
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

  const setComposerError = (message: string | null) => {
    composerError.textContent = message ?? "";
    composerError.hidden = !message;
  };

  // ------------------------------------------------------------------
  // Image attachments: staged per conversation, uploaded at attach time,
  // referenced by id everywhere after (spec: bytes cross each boundary once).
  // Pending state deliberately does not persist across reloads.
  // ------------------------------------------------------------------
  type PendingAttachment = MessageAttachment & { id: string; previewUrl: string };
  const pendingAttachments = new Map<string, PendingAttachment[]>();
  // One serialized staging chain per conversation. Serialization makes the
  // per-message bound check honest — a second paste near the eight-image
  // limit runs after the first and sees its result instead of racing past
  // the cap — and submission drains the chain (re-reading the tail until
  // nothing new was appended while it waited) so an image attached moments
  // before Enter joins the message it was attached for.
  const attachmentStaging = new Map<string, Promise<void>>();
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

  const setPendingAttachments = (conversationId: string, entries: PendingAttachment[]) => {
    if (entries.length > 0) pendingAttachments.set(conversationId, entries);
    else pendingAttachments.delete(conversationId);
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
    attachmentsStrip.textContent = "";
    attachmentsStrip.hidden = entries.length === 0;
    for (const entry of entries) {
      const item = document.createElement("span");
      item.className = "chat-attachment";
      item.setAttribute("role", "listitem");
      const thumb = document.createElement("img");
      thumb.className = "chat-attachment-thumb";
      thumb.src = entry.previewUrl;
      thumb.alt = entry.name;
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
      item.append(thumb, name, remove);
      attachmentsStrip.append(item);
    }
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
    const task = (attachmentStaging.get(conversationId) ?? Promise.resolve()).then(async () => {
      for (const file of files) {
        if ((pendingAttachments.get(conversationId) ?? []).length >= CHAT_ATTACHMENTS_PER_MESSAGE) {
          setComposerError(`A message can carry at most ${CHAT_ATTACHMENTS_PER_MESSAGE} images.`);
          break;
        }
        if (!supportedAttachmentTypes.has(file.type.toLowerCase())) {
          setComposerError(`${file.name || "That file"} is not a supported image (PNG, JPEG, GIF, WebP).`);
          continue;
        }
        if (file.size > CHAT_ATTACHMENT_MAX_BYTES) {
          setComposerError(`${file.name || "That image"} is larger than the ${Math.round(CHAT_ATTACHMENT_MAX_BYTES / (1024 * 1024))} MiB limit.`);
          continue;
        }
        try {
          const stored = await api.uploadAttachment(conversationId, file);
          // Keyed to the conversation the upload was staged for, which may no
          // longer be the selected one by the time the round trip returns.
          const entries = pendingAttachments.get(conversationId) ?? [];
          entries.push({ id: stored.id, name: file.name || "image", mimeType: stored.mimeType, previewUrl: URL.createObjectURL(file) });
          setPendingAttachments(conversationId, entries);
        } catch (error) {
          setComposerError(`Could not attach ${file.name || "image"}: ${messageOf(error)}`);
        }
      }
    });
    attachmentStaging.set(conversationId, task);
    try {
      await task;
    } finally {
      if (attachmentStaging.get(conversationId) === task) attachmentStaging.delete(conversationId);
    }
    renderAttachments();
    syncControls();
  };

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
    const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith("image/"));
    if (files.length === 0) return;
    // Without the capability there is no image intake at all: default paste
    // behavior stands untouched.
    if (agent && !declares("attachments")) return;
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
    const images = Array.from(event.dataTransfer?.files ?? []).filter(file => file.type.startsWith("image/"));
    if (images.length === 0) {
      setComposerError("Only PNG, JPEG, GIF, or WebP images can be attached.");
      return;
    }
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
    // an empty draft sendable (image-only prompts are accepted end to end).
    const hasContent = Boolean(input.value.trim()) || currentPendingAttachments().length > 0;
    send.disabled = running ? cancelling || !projection : submitting || !projection || !hasContent;
    const action = running ? "Cancel" : "Send";
    sendLabel.textContent = action;
    send.setAttribute("aria-label", running ? "Cancel response" : "Send message");
    send.title = running ? "Cancel response" : "Send message";
    configurationTrigger.disabled = submitting || !projection;
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

  const renderConfiguration = () => {
    const configuration = displayedConfiguration();
    const displayedModel = configuration.model
      ? models.find(model => sameModel(model.selection, configuration.model!))
      : undefined;
    configurationSummary.textContent = declares("models")
      ? displayedModel?.name ?? (configuration.model ? `${configuration.model.providerId}/${configuration.model.modelId}` : `Let ${agent?.name ?? "OpenCode"} choose`)
      : "Chat settings";
    const showMode = declares("modes") && modes.length > 0;
    const showReasoning = declares("variants") && Boolean(displayedModel?.variants?.length);
    configurationModeSummary.hidden = !showMode;
    configurationModeSummary.textContent = showMode ? configurationOptionLabel(configuration.mode ?? "auto") : "";
    configurationVariantSummary.hidden = !showReasoning;
    configurationVariantValue.textContent = showReasoning ? configurationOptionLabel(configuration.variant ?? "auto") : "";
    configurationDetails.hidden = !showMode && !showReasoning;
    const accessibleValues = [
      declares("models") ? `Model: ${displayedModel?.name ?? (configuration.model ? `${configuration.model.providerId}/${configuration.model.modelId}, unavailable` : `chosen by ${agent?.name ?? "the agent"}`)}` : "",
      showMode ? `Mode: ${configuration.mode ? configurationOptionLabel(configuration.mode) : `chosen by ${agent?.name ?? "the agent"}`}` : "",
      showReasoning ? `Reasoning: ${configuration.variant ? configurationOptionLabel(configuration.variant) : `chosen by ${agent?.name ?? "the agent"}`}` : "",
    ].filter(Boolean);
    configurationTrigger.setAttribute("aria-label", accessibleValues.length > 0 ? `Chat configuration. ${accessibleValues.join(". ")}` : "Chat settings");
    configurationPicker?.update({ agent, models, modes, configuration });
    syncAttachControl();
    syncControls();
  };

  const selectConversation = async (id: string) => {
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
    save();
    projection = null;
    setComposerError(null);
    renderConfiguration();
    syncContextIndicator();
    input.value = presentation.drafts[id] ?? "";
    autosize(input);
    renderAttachments();
    announce("Loading conversation...");
    syncControls();
    try {
      const snapshot = await api.snapshot(id);
      if (token !== selectionGeneration) return;
      projection = projectionFromSnapshot(snapshot, acceptedDrafts);
      // Every snapshot install invalidates in-flight held echoes: the fresh
      // projection's queueRevision restarts at zero, so a revision captured
      // before the reload could coincide with it and let a stale echo
      // through. The epoch is what cannot be coincided with.
      projectionEpoch += 1;
      conversations = conversations.map(item => item.id === snapshot.conversation.id ? snapshot.conversation : item);
      renderConfiguration();
      renderAttachments();
      announce(snapshot.items.length ? "" : "Start this conversation by sending a message.");
      anchor.restore(presentation.anchors[id] ?? null);
      scheduleRender(false, false);
      stream = api.stream(id, snapshot.cursor, {
        event: (event, cursor) => {
          if (!projection || token !== selectionGeneration) return;
          const result = applyChatEvent(projection, event, cursor);
          if (result.outcome === "gap" || result.outcome === "resync") {
            void selectConversation(id);
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
        resync: () => { if (token === selectionGeneration) void selectConversation(id); },
        error: error => { if (token === selectionGeneration) announce(error.message, true); },
      });
    } catch (error) {
      if (token === selectionGeneration) announce(messageOf(error), true);
    }
  };

  const renderChooser = () => {
    select.replaceChildren();
    if (conversations.length === 0) {
      select.append(new Option("No conversations", ""));
      select.disabled = true;
      form.hidden = true;
      if (chatTitle) chatTitle.textContent = chatHeading();
      return;
    }
    select.disabled = false;
    for (const conversation of conversations) select.append(new Option(displayConversationTitle(conversation), conversation.id));
    const selected = conversations.some(item => item.id === presentation.selectedId) ? presentation.selectedId! : conversations[0]!.id;
    select.value = selected;
    void selectConversation(selected);
  };

  select.addEventListener("change", () => { if (select.value) void selectConversation(select.value); });
  const stageModel = (selection: ModelSelection | undefined) => {
    if (!projection) return;
    const staged = { ...stagedConfigurations.get(projection.conversationId) };
    if (!selection || (projection.configuration?.model && sameModel(selection, projection.configuration.model))) delete staged.model;
    else staged.model = selection;
    delete staged.variant;
    setStagedConfiguration(projection.conversationId, staged);
    renderConfiguration();
    syncContextIndicator();
  };
  const stageVariant = (name: string | undefined) => {
    if (!projection) return;
    const staged = { ...stagedConfigurations.get(projection.conversationId) };
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
  newButton.addEventListener("click", async () => {
    newButton.disabled = true;
    announce("Creating conversation...");
    try {
      const snapshot = await api.createConversation();
      if (projection) presentation.drafts[projection.conversationId] = input.value;
      conversations = [snapshot.conversation, ...conversations.filter(item => item.id !== snapshot.conversation.id)];
      presentation.selectedId = snapshot.conversation.id;
      renderChooser();
      select.value = snapshot.conversation.id;
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

  olderButton.addEventListener("click", async () => {
    if (!projection?.olderCursor) return;
    const current = projection;
    olderButton.disabled = true;
    anchor.beforeMutation(geometry());
    try {
      const page = await api.snapshot(current.conversationId, current.olderCursor);
      if (projection?.conversationId !== current.conversationId) return;
      projection = prependSnapshot(projection, page);
      const dirty = renderer.render(items, projection, expanded, declares("subagents"));
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

  const resolvePermission = async (source: ChatProjection, itemId: string, outcome: PermissionOutcome) => {
    const item = source.items.find(candidate => candidate.id === itemId);
    if (!item || item.type !== "permission" || item.status !== "pending") return;
    disableCard(itemId, true);
    // Addressed to the conversation that owns the request, not the one on
    // screen: a subagent's request shown in its parent must be answered for the
    // subagent, so the child's requirePending guard and receipt key govern it.
    try { await api.permission(item.conversationId ?? source.conversationId, item.requestId, newRequestId(), outcome); }
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
      const target = (event.target as Element).closest<HTMLElement>("[data-file-ref], [data-permission-outcome], [data-question-reject], [data-open-conversation], [data-chat-copy]");
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
      if (!item || item.type === "user_message" || item.type === "assistant_message") return;
      if (item.type === "permission" && target.dataset.permissionOutcome) {
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
    cancelling = true;
    setComposerError(null);
    noteComposer("Cancelling...");
    syncControls();
    try { await api.cancel(projection.conversationId, newRequestId()); }
    catch (error) {
      const message = messageOf(error);
      announce(message, true);
      setComposerError(`Cancellation failed: ${message}`);
    }
    finally { cancelling = false; syncControls(); }
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!projection || submitting) return;
    if (!input.value.trim() && currentPendingAttachments().length === 0) return;
    const conversationId = projection.conversationId;
    const text = input.value;
    submitting = true;
    setComposerError(null);
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
        if (!presentation.drafts[conversationId]) { presentation.drafts[conversationId] = text; save(); }
        submitting = false;
        syncControls();
        return;
      }
    }
    // Captured and cleared optimistically like the text; restored on failure.
    const stagedAttachments = [...(pendingAttachments.get(conversationId) ?? [])];
    const attachmentRefs: MessageAttachment[] = stagedAttachments.map(({ id, name, mimeType }) => ({ id, name, mimeType }));
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
    input.value = "";
    presentation.drafts[conversationId] = "";
    setPendingAttachments(conversationId, []);
    renderAttachments();
    save();
    autosize(input);
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
      setComposerError(null);
      // The message is accepted; the local previews have no further use.
      for (const staged of stagedAttachments) URL.revokeObjectURL(staged.previewUrl);
    } catch (error) {
      const message = messageOf(error);
      announce(message, true);
      retryRequests.set(conversationId, { text, requestId, attachments: attachmentKey });
      // The refused message's attachments go back to pending — uploaded bytes
      // are still stored, so the references stay valid for the retry.
      setPendingAttachments(conversationId, [...stagedAttachments, ...(pendingAttachments.get(conversationId) ?? [])]);
      if (projection?.conversationId === conversationId) {
        projection = removeAcceptedDraft(projection, requestId);
        if (!input.value.trim()) {
          input.value = text;
          autosize(input);
        }
        presentation.drafts[conversationId] = input.value;
        save();
        renderAttachments();
        scheduleRender();
      } else {
        // Switched away while the request was in flight: the live input now
        // belongs to another conversation, so the failed text goes back into
        // the stored draft and reappears on return.
        if (!presentation.drafts[conversationId]) presentation.drafts[conversationId] = text;
        save();
      }
      submitting = false;
      setComposerError(`${message}. Draft restored.`);
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
    flushSave();
    stream?.close();
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
  // immediately via the initial maybeBootstrap() call. Failures — a stale PWA
  // cookie 401, a transient status error — leave the bootstrap re-runnable:
  // it retries on the next Chat activation and on credential refresh.
  let bootstrapped = false;
  let bootstrapping = false;

  // The unavailable state is the whole point of this surface when OpenCode will
  // not start: it has to carry enough evidence to diagnose the failure from a
  // pasted bug report, and offer the retry that makes a fixed environment
  // recoverable without restarting the workspace.
  const showUnavailable = (availability: Extract<ChatAvailability, { state: "unavailable" }>) => {
    form.hidden = true;
    select.disabled = true;
    newButton.disabled = true;
    announce(availability.message, true);

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
      announce(agent ? `Starting ${agent.name}…` : "Starting the agent…");
      try {
        const next = await api.retry();
        if (next.state === "unavailable") {
          showUnavailable(next);
          return;
        }
        bootstrapped = false;
        await bootstrap();
      } catch (error) {
        // The retry POST itself failed (network, proxy, credential refresh) —
        // announce() alone would wipe the panel and leave the surface with no
        // Retry control at all, so rebuild it around the transport error.
        showUnavailable({ ...availability, message: `Retry failed: ${messageOf(error)}` });
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
      const availability = await api.status();
      if (availability.state === "unavailable") {
        showUnavailable(availability);
        return;
      }
      // Named before anything is fetched: every later render reads the agent,
      // and a control that appeared unnamed and then renamed itself would be
      // the pop-in this seam exists to avoid.
      if (availability.state === "ready") agent = availability.agent;
      nameAgent();
      applyCapabilities();
      // A capability the agent does not declare is not fetched at all. The
      // mode list stays fault-tolerant on top of that: a declared list that
      // fails to load hides the picker rather than blocking chat.
      [models, conversations, commands, modes] = await Promise.all([
        declares("models") ? api.models() : Promise.resolve([] as ChatModel[]),
        api.conversations(),
        declares("commands") ? api.commands().catch(() => []) : Promise.resolve([] as ChatCommand[]),
        declares("modes") ? api.modes().catch(() => [] as ChatMode[]) : Promise.resolve([] as ChatMode[]),
      ]);
      form.hidden = false;
      select.disabled = false;
      newButton.disabled = false;
      renderConfiguration();
      announce(conversations.length ? "" : "No conversations yet. Create one to start.");
      renderChooser();
      bootstrapped = true;
    } catch (error) { announce(messageOf(error), true); }
    finally { bootstrapping = false; }
  };
  const chatSurfaceActive = () => {
    const root = document.documentElement;
    return root.getAttribute("data-ui-mode") === "touch"
      ? root.getAttribute("data-active-tab") === "chat"
      : root.getAttribute("data-chat-panel") === "open";
  };
  const maybeBootstrap = () => { if (chatSurfaceActive()) void bootstrap(); };
  const surfaceObserver = new MutationObserver(maybeBootstrap);
  surfaceObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-chat-panel", "data-active-tab", "data-ui-mode"] });
  onWorkspaceCredentialRefresh(maybeBootstrap);
  maybeBootstrap();
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
