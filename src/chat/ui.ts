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
import { READER_CLOSED, TimelineRenderer, decorateFileLinks, latestTodoEntries, statusLabel, subagentEntries, type SubagentEntry } from "./timeline-renderer";
import { totalTokens } from "./usage";
import {
  addAcceptedDraft,
  applyChatEvent,
  confirmAcceptedDraft,
  prependSnapshot,
  projectionFromSnapshot,
  removeAcceptedDraft,
  type ChatProjection,
} from "./projection";
import type { ChatAgent, ChatCapability, ChatMode, ChatAvailability, ChatCommand, ChatModel, ConversationItem, ConversationSummary, ModelSelection, PermissionOutcome, QuestionOutcome, TokenUsage } from "./types";
import { formatDiagnostics } from "./diagnostics";

const PRESENTATION_KEY = "uatu:chat-presentation";
const SAVE_DEBOUNCE_MS = 400;
const MAX_EXPANDED_ENTRIES = 400;
type Presentation = {
  selectedId?: string;
  drafts: Record<string, string>;
  expanded: string[];
  anchors: Record<string, TimelineAnchor>;
  workingSince: Record<string, number>;
  // `model` is the default for a conversation never chosen for; `models`
  // remembers the per-conversation choice. One global value made the picker
  // claim whatever was last chosen anywhere, for every conversation.
  model?: ModelSelection;
  models: Record<string, ModelSelection>;
  // Same shape for the mode (Build/Plan/...). Empty means the agent's own
  // default: the picker never claims to know a session's current mode.
  mode?: string;
  modes: Record<string, string>;
  // The reasoning variant, per conversation and as a global default — the same
  // storage as the model. Empty means the model's own default effort.
  variant?: string;
  variants: Record<string, string>;
  // Dismissed finished-subagent entry ids, per conversation — dismissal is a
  // user statement that must survive reload.
  dismissedSubagents: Record<string, string[]>;
};

const EMPTY_PRESENTATION: Presentation = { drafts: {}, expanded: [], anchors: {}, workingSince: {}, models: {}, modes: {}, variants: {}, dismissedSubagents: {} };

export function initChat(): void {
  const surface = document.querySelector<HTMLElement>("#chat-surface");
  const timeline = document.querySelector<HTMLElement>("#chat-timeline");
  const items = document.querySelector<HTMLElement>("#chat-items");
  const state = document.querySelector<HTMLElement>("#chat-state");
  const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select");
  const newButton = document.querySelector<HTMLButtonElement>("#chat-new-conversation");
  const olderButton = document.querySelector<HTMLButtonElement>("#chat-load-older");
  const latestButton = document.querySelector<HTMLButtonElement>("#chat-latest");
  const form = document.querySelector<HTMLFormElement>("#chat-composer");
  const input = document.querySelector<HTMLTextAreaElement>("#chat-input");
  const commandMenu = document.querySelector<HTMLElement>("#chat-command-menu");
  const send = document.querySelector<HTMLButtonElement>("#chat-send");
  const sendLabel = document.querySelector<HTMLElement>("#chat-send .chat-send-label");
  const modelSelect = document.querySelector<HTMLSelectElement>("#chat-model-select");
  const modeSelect = document.querySelector<HTMLSelectElement>("#chat-mode-select");
  const variantSelect = document.querySelector<HTMLSelectElement>("#chat-variant-select");
  const cancel = document.querySelector<HTMLButtonElement>("#chat-cancel");
  const composerStatus = document.querySelector<HTMLElement>("#chat-composer-status");
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
  if (!surface || !timeline || !items || !state || !select || !newButton || !olderButton || !latestButton || !form || !input || !commandMenu || !send || !sendLabel || !modelSelect || !cancel || !composerStatus) return;

  const api = new ChatApiClient();
  const anchor = new TimelineAnchorController();
  const viewport = new ChatViewportController(surface, form, timeline, anchor);
  const renderer = new TimelineRenderer();
  let presentation = readPresentation();
  let conversations: ConversationSummary[] = [];
  let models: ChatModel[] = [];
  let modes: ChatMode[] = [];
  let commands: ChatCommand[] = [];
  let projection: ChatProjection | null = null;
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
  // Entries for layers that closed while navigation sat above them. A history
  // entry cannot be deleted from the middle of the stack, so a direct close
  // (header, Escape) of a drill-down whose entry is buried leaves that entry
  // behind — retired here, and skipped when a Back later lands on it, so the
  // reader never meets a dead step. Registered before the layer's own
  // interceptor ever is: interceptors run newest-first, so an open layer
  // still answers first.
  const retiredDrilldownTokens = new Set<string>();
  registerBackInterceptor(event => {
    const flag = (event.state as { chatDrilldown?: unknown } | null)?.chatDrilldown;
    if (typeof flag !== "string" || !retiredDrilldownTokens.has(flag)) return false;
    history.back();
    return true;
  });
  let rendering = false;
  let renderFrame: number | null = null;
  let submitting = false;
  // A failed send leaves acceptance unknown — the server may already hold a
  // receipt for the request. Resubmitting the same text reuses its id so the
  // receipt dedupes instead of starting a second agent turn. Keyed per
  // conversation: a success elsewhere must not discard another
  // conversation's unresolved id.
  const retryRequests = new Map<string, { text: string; requestId: string }>();
  let commandMatch: ReturnType<typeof matchingCommands> = null;
  let commandIndex = 0;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let workingTimer: ReturnType<typeof setInterval> | null = null;
  // A transient composer note ("Sending…") outranks the status label until the
  // conversation status actually moves, so a render cannot erase it.
  let composerNote: string | null = null;
  let lastStatus: ChatProjection["status"] | null = null;
  const expanded = new Set(presentation.expanded);
  // Messages accepted while a turn was already running. They are cleared when
  // the turn ends, which is the moment the agent has actually taken them.
  const queued = new Set<string>();
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
    if (!declares("modes")) modeSelect?.remove();
    if (!declares("models")) modelSelect.remove();
    if (!declares("variants")) variantSelect?.remove();
    // An agent that does not report token usage has no context readout to
    // show, and a permanently empty meter would claim otherwise.
    if (!declares("context")) contextUsage?.remove();
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
      for (const key of Object.keys(presentation.models)) if (!known.has(key)) delete presentation.models[key];
      for (const key of Object.keys(presentation.variants)) if (!known.has(key)) delete presentation.variants[key];
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
    // Skipped when nothing changed: rewriting the pill's text every frame
    // replaces the text node a finger may be resting on.
    const signature = `${outstanding.length}\u0001${outstanding[outstanding.length - 1]?.id ?? ""}`;
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
    requestsJump.dataset.requestTarget = outstanding[outstanding.length - 1]!.id;
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
    const timelineItems = projection?.items ?? [];
    for (let index = timelineItems.length - 1; index >= 0; index -= 1) {
      const item = timelineItems[index]!;
      if (item.type === "assistant_message" && item.usage) { usage = item.usage; break; }
    }
    if (usage === paintedUsage && modelSelect.value === paintedUsageModel) return;
    paintedUsage = usage;
    paintedUsageModel = modelSelect.value;
    if (!usage) {
      contextUsage.hidden = true;
      contextUsage.open = false;
      return;
    }
    const used = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    const limit = models.find(model => modelValue(model.selection) === modelSelect.value)?.contextLimit;
    const fraction = limit && limit > 0 ? Math.min(1, used / limit) : undefined;
    contextUsageFill.style.width = `${Math.round((fraction ?? 0) * 100)}%`;
    // The figure states the fill in words as well as in width, so the tier
    // colouring below is emphasis on something already legible rather than
    // the only signal.
    contextUsageLabel.textContent = fraction === undefined
      ? `${formatTokens(used)} in context`
      : `${formatTokens(used)}/${formatTokens(limit!)} · ${Math.round(fraction * 100)}%`;
    contextUsage.dataset.fill = fraction === undefined ? "unknown" : fraction >= 0.9 ? "full" : fraction >= 0.75 ? "high" : "normal";
    contextUsage.title = fraction === undefined
      ? `${used.toLocaleString()} tokens in the context window`
      : `${used.toLocaleString()} of ${limit!.toLocaleString()} tokens in the context window`;
    const rows: Array<[string, number]> = [];
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
    const dirty = renderer.render(items, projection, expanded, queued);
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

  const syncControls = () => {
    const status = projection?.status ?? null;
    if (status !== lastStatus) {
      composerNote = null;
      lastStatus = status;
      if (status !== "running" && status !== "sending" && queued.size > 0) queued.clear();
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
    if (running && workingTimer === null) workingTimer = setInterval(() => { composerStatus.textContent = workingText(); syncWaiting(); }, 1_000);
    if (!running && workingTimer !== null) {
      clearInterval(workingTimer);
      workingTimer = null;
    }
    send.disabled = submitting || !projection || !input.value.trim();
    const action = running ? "Steer" : "Send";
    sendLabel.textContent = action;
    send.setAttribute("aria-label", `${action} message`);
    send.title = `${action} message`;
    modelSelect.disabled = submitting || models.length === 0;
    if (modeSelect?.isConnected) modeSelect.disabled = submitting || modes.length === 0;
    if (variantSelect?.isConnected) variantSelect.disabled = submitting;
    cancel.hidden = !running;
    olderButton.hidden = !projection?.olderCursor;
    composerStatus.textContent = composerNote ?? workingText();
    syncWaiting();
  };

  const noteComposer = (message: string | null) => {
    composerNote = message;
    composerStatus.textContent = message ?? workingText();
  };

  const renderModels = () => {
    modelSelect.replaceChildren();
    if (models.length === 0) {
      modelSelect.append(new Option("No models available", ""));
      modelSelect.disabled = true;
      return;
    }
    for (const model of models) {
      modelSelect.append(new Option(`${model.provider}: ${model.name}`, modelValue(model.selection)));
    }
    const stored = presentation.model && models.some(model => sameModel(model.selection, presentation.model!))
      ? presentation.model
      : models[0]!.selection;
    presentation.model = stored;
    applyModel(projection?.conversationId ?? presentation.selectedId);
    renderVariants();
    save();
    syncControls();
  };

  /**
   * Reasoning variants belong to the selected model, so the list is rebuilt
   * whenever the model changes — and the target conversation rides in as the
   * argument on a conversation switch, because at that moment `projection`
   * still names the previous one. A model that offers none hides the control
   * (like an absent mode list), and the whole control is removed when the
   * agent does not declare the capability — checked as `isConnected`, since
   * the removed node is still reachable from this closure and repopulating it
   * would let a stored variant ride along with no visible control saying so.
   * "Default" leads, meaning the model's own effort, and a chosen variant is
   * remembered per conversation like the model.
   */
  const renderVariants = (conversationId = projection?.conversationId ?? presentation.selectedId) => {
    if (!variantSelect?.isConnected) return;
    const selected = models.find(model => modelValue(model.selection) === modelSelect.value);
    const variants = selected?.variants ?? [];
    variantSelect.replaceChildren();
    variantSelect.hidden = variants.length === 0;
    if (variants.length === 0) return;
    variantSelect.append(new Option("Reasoning: default", ""));
    for (const variant of variants) variantSelect.append(new Option(`Reasoning: ${variant}`, variant));
    const offered = (name: string | undefined) => (name && Array.from(variantSelect.options).some(option => option.value === name) ? name : undefined);
    variantSelect.value = offered(conversationId ? presentation.variants[conversationId] : undefined) ?? offered(presentation.variant) ?? "";
  };

  /**
   * The mode picker leads with "default" rather than claiming a value: the
   * session's current mode is the agent's state, not ours, and a session
   * stuck in a read-only mode is exactly the case where lying would hurt.
   * Choosing a named mode sends it with every prompt from then on.
   */
  const renderModes = () => {
    if (!modeSelect) return;
    modeSelect.replaceChildren();
    modeSelect.hidden = modes.length === 0;
    if (modes.length === 0) return;
    modeSelect.append(new Option("Mode: default", ""));
    for (const mode of modes) {
      const option = new Option(modeLabel(mode.name), mode.name);
      if (mode.description) option.title = mode.description;
      modeSelect.append(option);
    }
    applyMode(projection?.conversationId ?? presentation.selectedId);
    syncControls();
  };

  const applyMode = (conversationId: string | undefined) => {
    if (!modeSelect || modes.length === 0) return;
    const known = (name: string | undefined) => (name && modes.some(mode => mode.name === name) ? name : undefined);
    const chosen = known(conversationId ? presentation.modes[conversationId] : undefined);
    // Once a named mode has been chosen for this conversation there is no
    // default to go back to: the mode is session state in the agent, and a
    // prompt that omits it keeps the previous choice — offering "default"
    // then would display one mode and run another.
    const defaultOption = modeSelect.options[0];
    if (defaultOption && defaultOption.value === "") defaultOption.disabled = chosen !== undefined;
    modeSelect.value = chosen ?? known(presentation.mode) ?? "";
  };

  /**
   * Points the picker at the conversation's own model, falling back to the
   * global default and then the first available model. A stored selection the
   * server no longer offers is ignored rather than shown as a live choice.
   */
  const applyModel = (conversationId: string | undefined) => {
    if (models.length === 0) return;
    const known = (selection: ModelSelection | undefined) =>
      selection && models.some(model => sameModel(model.selection, selection)) ? selection : undefined;
    const chosen = known(conversationId ? presentation.models[conversationId] : undefined)
      ?? known(presentation.model)
      ?? models[0]!.selection;
    modelSelect.value = modelValue(chosen);
  };

  const selectConversation = async (id: string) => {
    // Choosing a conversation is leaving whatever turn was being drilled into:
    // the drill-down is a view over the parent, and the parent is changing.
    closeChildConversation();
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
    applyModel(id);
    // The variant list belongs to the model, and the model just changed to
    // this conversation's — the rebuild validates the stored variant against
    // the new model's options rather than the previous conversation's.
    renderVariants(id);
    applyMode(id);
    const conversation = conversations.find(item => item.id === id);
    if (chatTitle) chatTitle.textContent = conversation ? displayConversationTitle(conversation) : chatHeading();
    form.hidden = false;
    save();
    projection = null;
    input.value = presentation.drafts[id] ?? "";
    autosize(input);
    announce("Loading conversation...");
    syncControls();
    try {
      const snapshot = await api.snapshot(id);
      if (token !== selectionGeneration) return;
      projection = projectionFromSnapshot(snapshot, acceptedDrafts);
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
  modelSelect.addEventListener("change", () => {
    renderVariants();
    const selection = models.find(model => modelValue(model.selection) === modelSelect.value)?.selection;
    if (!selection) return;
    presentation.model = selection;
    if (projection) presentation.models[projection.conversationId] = selection;
    save();
    // The fill is measured against the selected model's window, so choosing a
    // different model restates it rather than leaving the old percentage up.
    syncContextIndicator();
  });
  variantSelect?.addEventListener("change", () => {
    const name = variantSelect.value || undefined;
    if (name) presentation.variant = name; else delete presentation.variant;
    if (projection) {
      if (name) presentation.variants[projection.conversationId] = name;
      else delete presentation.variants[projection.conversationId];
    }
    save();
  });
  modeSelect?.addEventListener("change", () => {
    const name = modeSelect.value || undefined;
    if (name && !modes.some(mode => mode.name === name)) return;
    if (name) presentation.mode = name;
    else delete presentation.mode;
    if (projection) {
      if (name) presentation.modes[projection.conversationId] = name;
      else delete presentation.modes[projection.conversationId];
    }
    save();
    // Re-derives the default option's availability: choosing a named mode
    // locks "default" for this conversation from now on.
    applyMode(projection?.conversationId ?? presentation.selectedId);
  });
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

  olderButton.addEventListener("click", async () => {
    if (!projection?.olderCursor) return;
    const current = projection;
    olderButton.disabled = true;
    anchor.beforeMutation(geometry());
    try {
      const page = await api.snapshot(current.conversationId, current.olderCursor);
      if (projection?.conversationId !== current.conversationId) return;
      projection = prependSnapshot(projection, page);
      const dirty = renderer.render(items, projection, expanded, queued);
      timeline.scrollTop = anchor.afterMutation(geometry());
      for (const node of dirty) decorateFileLinks(node);
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

  /** A question is answered once any option is ticked or free-form text typed. */
  const panelAnswered = (panel: HTMLElement): boolean =>
    panel.querySelector("input[type=radio]:checked, input[type=checkbox]:checked") !== null
    || [...panel.querySelectorAll<HTMLInputElement>("input[type=text]")].some(input => input.value.trim() !== "");

  /**
   * Drives the tab strip and the primary button: "Next" until the last
   * question, "Answer" on it, disabled until the step in view is satisfied.
   * A multi-select step needs at least one box ticked, never all of them.
   */
  const syncQuestionForm = (form: HTMLFormElement) => {
    const panels = [...form.querySelectorAll<HTMLElement>("[data-question-panel]")];
    if (panels.length === 0) return;
    const activeIndex = Math.max(0, panels.findIndex(panel => !panel.hidden));
    const answered = panels.map(panelAnswered);
    form.querySelectorAll<HTMLButtonElement>("[data-question-tab]").forEach((tab, index) => {
      tab.setAttribute("aria-selected", String(index === activeIndex));
      tab.classList.toggle("is-active", index === activeIndex);
      tab.classList.toggle("is-answered", answered[index] === true);
    });
    const primary = form.querySelector<HTMLButtonElement>("[data-question-primary]");
    if (!primary) return;
    const last = activeIndex === panels.length - 1;
    primary.textContent = last ? "Answer" : "Next";
    primary.disabled = last ? answered.some(value => !value) : !answered[activeIndex];
  };

  const showQuestionPanel = (form: HTMLFormElement, index: number) => {
    form.querySelectorAll<HTMLElement>("[data-question-panel]").forEach((panel, at) => { panel.hidden = at !== index; });
    syncQuestionForm(form);
  };

  // Radios and the "Other" free-form field share a name, and a single-choice
  // question must submit exactly one answer — picking one side clears the
  // other, so the form state always matches what FormData will produce.
  const enforceSingleChoice = (input: HTMLInputElement, form: HTMLFormElement) => {
    const siblings = form.querySelectorAll<HTMLInputElement>(`input[name="${CSS.escape(input.name)}"]`);
    if (input.type === "radio") {
      siblings.forEach(sibling => { if (sibling.type === "text") sibling.value = ""; });
    } else if (input.type === "text" && input.value.trim() !== "") {
      siblings.forEach(sibling => { if (sibling.type === "radio") sibling.checked = false; });
    }
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
      const target = (event.target as Element).closest<HTMLElement>("[data-file-ref], [data-permission-outcome], [data-question-reject], [data-open-conversation]");
      const source = sourceProjection();
      if (!target || !source) return;
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
      enforceSingleChoice(input, form);
      syncQuestionForm(form);
      // A lone single-choice question needs no confirmation step: picking the
      // option is the answer. Anything with more questions, multiple allowed
      // answers, or a free-form field keeps its explicit step.
      if (input.type !== "radio") return;
      const source = sourceProjection();
      const item = source?.items.find(candidate => candidate.id === input.closest<HTMLElement>("[data-chat-item-id]")?.dataset.chatItemId);
      if (!source || !item || item.type !== "question" || item.questions.length !== 1) return;
      const question = item.questions[0]!;
      if (question.multiple || question.allowFreeForm) return;
      void resolveQuestion(source, item.id, { kind: "answered", answers: [[input.value]] });
    });
    container.addEventListener("input", event => {
      const input = event.target as HTMLInputElement;
      const form = input.form;
      if (!form?.matches("form[data-question-form]")) return;
      enforceSingleChoice(input, form);
      syncQuestionForm(form);
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
      const data = new FormData(questionForm);
      const answers = item.questions.map((_, index) => data.getAll(`q-${index}`).map(String).filter(Boolean));
      // The button is disabled until every step is satisfied, so this only
      // catches a form submitted some other way (Enter in the free-form field).
      const missing = answers.flatMap((answer, index) => answer.length === 0 ? [index] : []);
      if (missing.length > 0) {
        showQuestionPanel(questionForm, missing[0]!);
        announce(`Still to answer: ${missing.map(index => item.questions[index]!.header).filter(Boolean).join(", ")}`, true);
        return;
      }
      void resolveQuestion(source, item.id, { kind: "answered", answers });
    });
  };

  const renderChild = (newContent: boolean) => {
    if (!drilldownItems || !drilldownTimeline) return;
    if (!childAnchor.isPinned()) childAnchor.beforeMutation(childGeometry());
    const dirty = childRenderer.render(drilldownItems, child?.projection ?? null, expanded);
    drilldownTimeline.scrollTop = childAnchor.afterMutation(childAnchorGeometry(), newContent);
    for (const node of dirty) {
      decorateFileLinks(node);
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
    if (!popped && drilldownHistoryToken !== null && (history.state as { chatDrilldown?: unknown } | null)?.chatDrilldown === drilldownHistoryToken) {
      // Ask the platform to pop, and finish in the popstate that arrives:
      // leaving a back-stack entry for a layer that is no longer open would
      // make the next Back a no-op. Re-entry is bounded by `popped`. Matched
      // by token — a stale marker from before a reload is not our entry.
      history.back();
      return;
    }
    // Reaching here directly (not via a pop) with a token still minted means
    // the layer's entry is buried under navigation pushed above it — it
    // cannot be removed, so it is retired and later skipped.
    if (!popped && drilldownHistoryToken !== null) retiredDrilldownTokens.add(drilldownHistoryToken);
    child = null;
    drilldownHistoryToken = null;
    childGeneration += 1;
    open.stream?.close();
    releaseChildBack?.();
    releaseChildBack = null;
    if (drilldownItems) childRenderer.render(drilldownItems, null, expanded);
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
    releaseChildBack ??= registerBackInterceptor(event => {
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
    childRenderer.render(drilldownItems, null, expanded);
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
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing
      && (event.metaKey || event.ctrlKey || document.documentElement.dataset.uiMode !== "touch")) {
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
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!projection || !input.value.trim() || submitting) return;
    const conversationId = projection.conversationId;
    const text = input.value;
    const retry = retryRequests.get(conversationId);
    const requestId = retry?.text === text ? retry.requestId : newRequestId();
    const selectedModel = models.find(model => modelValue(model.selection) === modelSelect.value)?.selection;
    // `isConnected`, not just non-null: the control is removed when the agent
    // does not declare the capability, and a detached select must not smuggle
    // a stored variant onto the wire with nothing on screen saying so.
    const selectedVariant = variantSelect?.isConnected && !variantSelect.hidden ? (variantSelect.value || undefined) : undefined;
    const selectedMode = modeSelect?.value || undefined;
    const wasRunning = projection.status === "running" || projection.status === "sending";
    submitting = true;
    // Optimistic send: the message shows immediately and the input clears;
    // on failure the draft is removed and the text restored.
    projection = addAcceptedDraft(projection, { requestId, messageId: `pending:${requestId}`, text });
    input.value = "";
    presentation.drafts[conversationId] = "";
    save();
    autosize(input);
    noteComposer(projection.status === "running" ? "Steering..." : "Sending...");
    syncControls();
    scheduleRender(true);
    try {
      const accepted = await api.prompt(conversationId, requestId, text, selectedModel, selectedMode, selectedVariant);
      retryRequests.delete(conversationId);
      if (accepted.conversation) {
        conversations = conversations.map(conversation => conversation.id === accepted.conversation!.id ? accepted.conversation! : conversation);
        const option = Array.from(select.options).find(candidate => candidate.value === accepted.conversation!.id);
        if (option) option.text = displayConversationTitle(accepted.conversation);
        if (chatTitle) chatTitle.textContent = displayConversationTitle(accepted.conversation);
      }
      if (projection?.conversationId === conversationId) {
        if (wasRunning) queued.add(`message:${accepted.messageId}`);
        projection = confirmAcceptedDraft(projection, { requestId, messageId: accepted.messageId, text });
        scheduleRender(true);
      }
      noteComposer(accepted.delivery === "steer" ? "Steer accepted" : "Message accepted");
    } catch (error) {
      announce(messageOf(error), true);
      retryRequests.set(conversationId, { text, requestId });
      if (projection?.conversationId === conversationId) {
        projection = removeAcceptedDraft(projection, requestId);
        if (!input.value.trim()) {
          input.value = text;
          autosize(input);
        }
        presentation.drafts[conversationId] = input.value;
        save();
        scheduleRender();
      } else {
        // Switched away while the request was in flight: the live input now
        // belongs to another conversation, so the failed text goes back into
        // the stored draft and reappears on return.
        if (!presentation.drafts[conversationId]) presentation.drafts[conversationId] = text;
        save();
      }
      submitting = false;
      noteComposer("Message not accepted; draft restored");
      syncControls();
      return;
    }
    submitting = false;
    syncControls();
  });
  cancel.addEventListener("click", async () => {
    if (!projection) return;
    cancel.disabled = true;
    noteComposer("Cancelling...");
    try { await api.cancel(projection.conversationId, newRequestId()); }
    catch (error) { announce(messageOf(error), true); }
    finally { cancel.disabled = false; }
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
      renderModels();
      renderModes();
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

// The shape this key had before agent/mode/subagent were separated.
type LegacyPresentation = { agent?: unknown; agents?: unknown };

function stringOrLegacy(value: unknown, legacy: unknown): string | undefined {
  if (typeof value === "string") return value;
  return typeof legacy === "string" ? legacy : undefined;
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
      model: parseStoredModel(value.model),
      models: parseStoredModels(value.models),
      // `agent`/`agents` are this key's pre-rename names. Dropping them would
      // reset a saved mode to "default" while the agent's session still runs
      // the old one — the picker would display one mode and run another, which
      // is the exact lie applyMode() exists to prevent. Read once; the next
      // save writes only the new names.
      mode: stringOrLegacy(value.mode, (value as LegacyPresentation).agent),
      modes: parseStoredNames(value.modes ?? (value as LegacyPresentation).agents),
      variant: typeof value.variant === "string" ? value.variant : undefined,
      variants: parseStoredNames(value.variants),
      dismissedSubagents: parseStoredIdLists(value.dismissedSubagents),
    };
  } catch { return structuredClone(EMPTY_PRESENTATION); }
}

function parseStoredNames(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
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

function parseStoredModel(value: unknown): ModelSelection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const model = value as Partial<ModelSelection>;
  return typeof model.providerId === "string" && typeof model.modelId === "string"
    ? { providerId: model.providerId, modelId: model.modelId }
    : undefined;
}

function parseStoredModels(value: unknown): Record<string, ModelSelection> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value)
    .map(([id, selection]) => [id, parseStoredModel(selection)] as const)
    .filter((entry): entry is [string, ModelSelection] => entry[1] !== undefined);
  return Object.fromEntries(entries);
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

function modeLabel(name: string): string {
  return `Mode: ${name.charAt(0).toUpperCase()}${name.slice(1)}`;
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
