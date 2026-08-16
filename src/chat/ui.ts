import { escapeHtml } from "../shared/html";
import { appState } from "../shell/state";
import { presentationLocalStorage } from "../shell/presentation-storage";
import { onWorkspaceCredentialRefresh } from "../terminal/client";
import { ChatApiClient, ChatTransportError, type ChatEventStream } from "./client";
import { TimelineAnchorController, type AnchorGeometry, type TimelineAnchor } from "./anchor";
import { ChatViewportController } from "./viewport";
import { newRequestId } from "./ids";
import { insertCommand, matchingCommands } from "./slash-commands";
import { navigateWorkspaceFileReference, resolveWorkspaceFileReference } from "./file-references";
import { TimelineRenderer, decorateFileLinks, latestTodoEntries, statusLabel, subagentEntries } from "./timeline-renderer";
import {
  addAcceptedDraft,
  applyChatEvent,
  confirmAcceptedDraft,
  prependSnapshot,
  projectionFromSnapshot,
  removeAcceptedDraft,
  type ChatProjection,
} from "./projection";
import type { ChatCommand, ChatModel, ConversationItem, ConversationSummary, ModelSelection, PermissionOutcome, QuestionOutcome } from "./types";

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
  // Dismissed finished-subagent entry ids, per conversation — dismissal is a
  // user statement that must survive reload.
  dismissedSubagents: Record<string, string[]>;
};

const EMPTY_PRESENTATION: Presentation = { drafts: {}, expanded: [], anchors: {}, workingSince: {}, models: {}, dismissedSubagents: {} };

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
  const cancel = document.querySelector<HTMLButtonElement>("#chat-cancel");
  const composerStatus = document.querySelector<HTMLElement>("#chat-composer-status");
  const chatTitle = document.querySelector<HTMLElement>("#chat-title");
  const chatContext = document.querySelector<HTMLElement>("#chat-context");
  if (!surface || !timeline || !items || !state || !select || !newButton || !olderButton || !latestButton || !form || !input || !commandMenu || !send || !sendLabel || !modelSelect || !cancel || !composerStatus) return;

  const api = new ChatApiClient();
  const anchor = new TimelineAnchorController();
  const viewport = new ChatViewportController(surface, form, timeline, anchor);
  const renderer = new TimelineRenderer();
  let presentation = readPresentation();
  let conversations: ConversationSummary[] = [];
  let models: ChatModel[] = [];
  let commands: ChatCommand[] = [];
  let projection: ChatProjection | null = null;
  let stream: ChatEventStream | null = null;
  let selectionGeneration = 0;
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
  if (chatContext) chatContext.textContent = appState.roots[0]?.label ?? "OpenCode";

  const announce = (message: string, error = false) => {
    state.textContent = message;
    state.classList.toggle("is-error", error);
    state.hidden = !message;
  };

  const geometry = (): AnchorGeometry => {
    const bounds = timeline.getBoundingClientRect();
    return {
      scrollTop: timeline.scrollTop,
      clientHeight: timeline.clientHeight,
      scrollHeight: timeline.scrollHeight,
      items: Array.from(items.querySelectorAll<HTMLElement>("[data-chat-item-id]")).map(element => {
        const rect = element.getBoundingClientRect();
        return { id: element.dataset.chatItemId!, top: rect.top - bounds.top, bottom: rect.bottom - bounds.top };
      // Members of a collapsed activity group are not rendered and report
      // zero-size rects; anchoring to one would pin the viewport to nothing.
      }).filter(entry => entry.bottom > entry.top),
    };
  };

  const flushSave = () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    // The picker options join the inventory: an opened subagent child is
    // deliberately absent from `conversations` but present as a temporary
    // option, and pruning it while open would delete its live draft.
    const known = new Set([
      ...conversations.map(conversation => conversation.id),
      ...Array.from(select.options, option => option.value),
    ]);
    if (projection) known.add(projection.conversationId);
    // Prune only once the inventory has actually loaded — an empty list at
    // boot must not wipe every stored draft.
    if (conversations.length > 0) {
      for (const key of Object.keys(presentation.drafts)) if (!known.has(key)) delete presentation.drafts[key];
      for (const key of Object.keys(presentation.anchors)) if (!known.has(key)) delete presentation.anchors[key];
      for (const key of Object.keys(presentation.workingSince)) if (!known.has(key)) delete presentation.workingSince[key];
      for (const key of Object.keys(presentation.models)) if (!known.has(key)) delete presentation.models[key];
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
   */
  const syncTaskList = () => {
    if (!taskList || !taskListLabel || !taskListItems) return;
    const tasks = projection ? latestTodoEntries(projection.items) : [];
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
  // Finished subagents stay until explicitly dismissed — nothing retires
  // them on a timer. Dismissals persist with the rest of the per-conversation
  // presentation, so a reload does not resurrect an already-dismissed strip.
  const dismissedSubagents = (conversationId: string): Set<string> =>
    new Set(presentation.dismissedSubagents[conversationId] ?? []);
  subagentsItems?.addEventListener("click", event => {
    const open = (event.target as Element).closest<HTMLElement>("[data-open-conversation]");
    if (open?.dataset.openConversation) openChildConversation(open.dataset.openConversation, open.textContent ?? "Subagent");
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
  });

  /**
   * Running and finished subagents, pinned beside the task list. A fan-out of
   * three agents is three rows that would otherwise scroll away, and while
   * they run there is nothing else saying how many are still going.
   */
  const syncSubagents = () => {
    if (!subagents || !subagentsLabel || !subagentsItems) return;
    const all = projection ? subagentEntries(projection.items) : [];
    const dismissed = projection ? dismissedSubagents(projection.conversationId) : new Set<string>();
    const entries = all.filter(entry => !dismissed.has(entry.id));
    if (dismissButton) {
      dismissButton.hidden = !entries.some(entry => entry.status !== "running" && entry.status !== "pending");
    }
    if (entries.length === 0) {
      subagents.hidden = true;
      subagentsItems.replaceChildren();
      return;
    }
    const running = entries.filter(entry => entry.status === "running" || entry.status === "pending");
    const noun = entries.length === 1 ? "agent" : "agents";
    subagentsLabel.textContent = running.length > 0
      ? `${running.length} of ${entries.length} ${noun} working · ${running[0]!.description}`
      : `${entries.length} ${noun} finished`;
    subagentsItems.replaceChildren(...entries.map(entry => {
      const row = document.createElement("li");
      row.className = `is-${entry.status}`;
      const text = entry.subagent ? `${entry.subagent} · ${entry.description}` : entry.description;
      if (entry.conversationId) {
        const open = document.createElement("button");
        open.type = "button";
        open.className = "chat-subagent-open";
        open.dataset.openConversation = entry.conversationId;
        open.textContent = text;
        row.append(open);
      } else {
        row.textContent = text;
      }
      return row;
    }));
    subagents.hidden = false;
  };

  const promptRail = document.querySelector<HTMLElement>("#chat-prompt-rail");

  /**
   * One dot per user prompt, newest at the bottom — tap to jump back to that
   * exchange. Hidden below two prompts, where the rail carries no information,
   * and capped to the most recent dozen so it cannot outgrow the viewport.
   */
  const syncPromptRail = () => {
    if (!promptRail) return;
    const prompts = projection
      ? projection.items.filter((item): item is Extract<ConversationItem, { type: "user_message" }> => item.type === "user_message")
      : [];
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
    syncPromptRail();
    timeline.scrollTop = anchor.afterMutation(geometry(), newContent);
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
    if (captureCurrent) anchor.beforeMutation(geometry());
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
    if (running && workingTimer === null) workingTimer = setInterval(() => { composerStatus.textContent = workingText(); }, 1_000);
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
    cancel.hidden = !running;
    olderButton.hidden = !projection?.olderCursor;
    composerStatus.textContent = composerNote ?? workingText();
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
    save();
    syncControls();
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
    const conversation = conversations.find(item => item.id === id);
    if (chatTitle) chatTitle.textContent = conversation ? displayConversationTitle(conversation) : "OpenCode Chat";
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
      if (chatTitle) chatTitle.textContent = "OpenCode Chat";
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
    const selection = models.find(model => modelValue(model.selection) === modelSelect.value)?.selection;
    if (!selection) return;
    presentation.model = selection;
    if (projection) presentation.models[projection.conversationId] = selection;
    save();
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
    anchor.observe(geometry());
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

  items.addEventListener("toggle", event => {
    const details = event.target as HTMLDetailsElement;
    if (!details.matches("details[data-chat-item-id]")) return;
    anchor.beforeMutation(geometry(), details.dataset.chatItemId);
    if (details.open) expanded.add(details.dataset.chatItemId!); else expanded.delete(details.dataset.chatItemId!);
    save();
    requestAnimationFrame(() => { timeline.scrollTop = anchor.afterMutation(geometry()); });
  }, true);

  /**
   * Opens a subagent's child session as the viewed conversation. Children are
   * filtered out of the picker, so a temporary option is inserted first —
   * without one the select cannot show where you are, and re-choosing the
   * parent would be a no-op change event.
   */
  const openChildConversation = (id: string, label: string) => {
    if (!Array.from(select.options).some(option => option.value === id)) {
      select.append(new Option(`↳ ${label}`, id));
    }
    select.value = id;
    void selectConversation(id);
  };

  items.addEventListener("click", event => {
    const target = (event.target as Element).closest<HTMLElement>("[data-file-ref], [data-permission-outcome], [data-question-reject], [data-open-conversation]");
    if (!target || !projection) return;
    if (target.dataset.openConversation) {
      openChildConversation(target.dataset.openConversation, target.closest("details")?.querySelector(".chat-activity-subject")?.textContent ?? "Subagent");
      return;
    }
    if (target.dataset.fileRef) {
      const reference = resolveWorkspaceFileReference(target.dataset.fileRef, appState.roots);
      if (reference) void navigateWorkspaceFileReference(reference);
      return;
    }
    const itemElement = target.closest<HTMLElement>("[data-chat-item-id]");
    const item = projection.items.find(candidate => candidate.id === itemElement?.dataset.chatItemId);
    if (!item || item.type === "user_message" || item.type === "assistant_message") return;
    if (item.type === "permission" && target.dataset.permissionOutcome) {
      void resolvePermission(item.id, target.dataset.permissionOutcome as PermissionOutcome);
    } else if (item.type === "question" && target.dataset.questionReject !== undefined) {
      void resolveQuestion(item.id, { kind: "rejected" });
    }
  });
  items.addEventListener("keydown", event => {
    const target = (event.target as Element).closest<HTMLElement>("[role=button][data-file-ref]");
    if (target && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      target.click();
    }
  });

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

  items.addEventListener("change", event => {
    const input = event.target as HTMLInputElement;
    const form = input.form;
    if (!form?.matches("form[data-question-form]")) return;
    enforceSingleChoice(input, form);
    syncQuestionForm(form);
    // A lone single-choice question needs no confirmation step: picking the
    // option is the answer. Anything with more questions, multiple allowed
    // answers, or a free-form field keeps its explicit step.
    if (input.type !== "radio") return;
    const item = projection?.items.find(candidate => candidate.id === input.closest<HTMLElement>("[data-chat-item-id]")?.dataset.chatItemId);
    if (!item || item.type !== "question" || item.questions.length !== 1) return;
    const question = item.questions[0]!;
    if (question.multiple || question.allowFreeForm) return;
    void resolveQuestion(item.id, { kind: "answered", answers: [[input.value]] });
  });
  items.addEventListener("input", event => {
    const input = event.target as HTMLInputElement;
    const form = input.form;
    if (!form?.matches("form[data-question-form]")) return;
    enforceSingleChoice(input, form);
    syncQuestionForm(form);
  });
  items.addEventListener("click", event => {
    const tab = (event.target as Element).closest<HTMLButtonElement>("[data-question-tab]");
    if (!tab?.form) return;
    showQuestionPanel(tab.form, Number(tab.dataset.questionTab));
  });

  items.addEventListener("submit", event => {
    const questionForm = event.target as HTMLFormElement;
    if (!questionForm.matches("form[data-question-form]")) return;
    event.preventDefault();
    const item = projection?.items.find(candidate => candidate.id === questionForm.closest<HTMLElement>("[data-chat-item-id]")?.dataset.chatItemId);
    if (!item || item.type !== "question") return;
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
    void resolveQuestion(item.id, { kind: "answered", answers });
  });

  const resolvePermission = async (itemId: string, outcome: PermissionOutcome) => {
    if (!projection) return;
    const item = projection.items.find(candidate => candidate.id === itemId);
    if (!item || item.type !== "permission" || item.status !== "pending") return;
    disableCard(itemId, true);
    try { await api.permission(projection.conversationId, item.requestId, newRequestId(), outcome); }
    catch (error) { announce(messageOf(error), true); disableCard(itemId, false); }
  };

  const resolveQuestion = async (itemId: string, outcome: QuestionOutcome) => {
    if (!projection) return;
    const item = projection.items.find(candidate => candidate.id === itemId);
    if (!item || item.type !== "question" || item.status !== "pending") return;
    disableCard(itemId, true);
    try { await api.question(projection.conversationId, item.requestId, newRequestId(), outcome); }
    catch (error) { announce(messageOf(error), true); disableCard(itemId, false); }
  };

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
      const accepted = await api.prompt(conversationId, requestId, text, selectedModel);
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
  const bootstrap = async () => {
    if (bootstrapped || bootstrapping) return;
    bootstrapping = true;
    try {
      const availability = await api.status();
      if (availability.state === "unavailable") {
        announce(availability.message, true);
        form.hidden = true;
        select.disabled = true;
        newButton.disabled = true;
        return;
      }
      [models, conversations, commands] = await Promise.all([api.models(), api.conversations(), api.commands().catch(() => [])]);
      form.hidden = false;
      select.disabled = false;
      newButton.disabled = false;
      renderModels();
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
      model: parseStoredModel(value.model),
      models: parseStoredModels(value.models),
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
