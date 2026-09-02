import { appUrl } from "../shared/app-url";
import { escapeHtml, escapeHtmlAttribute } from "../shared/html";
import { appState } from "../shell/state";
import { renderChatMarkdown } from "./markdown";
import { resolveWorkspaceFileReference } from "./file-references";
import { commandSubject, describeToolDetail, deriveTodoActivities, patchDiffLines, todoActivitySummary, toolSubject, type DiffLine, type TodoEntry, type TodoSummary, type ToolDetail } from "./tool-detail";
import type { AcceptedDraft, ChatProjection } from "./projection";
import { isLiveConversationStatus, type ActivityStatus, type ConversationItem, type ConversationStatus, type MessageAttachment, type PermissionOutcome, type QueuedMessage, type QuestionRequest, type RevertedUserMessage, type TokenUsage, type ToolItem } from "./types";

type RenderedEntry = { node: HTMLElement; item: ConversationItem; active: boolean; variant: string };

/**
 * Keyed incremental timeline rendering: one persistent DOM node per item id.
 * Streaming deltas only touch the node they belong to, so pending question
 * forms, focus, selection, and find highlights in untouched items survive
 * every animation frame.
 */
export class TimelineRenderer {
  private readonly entries = new Map<string, RenderedEntry>();
  private readonly draftEntries = new Map<string, { node: HTMLElement; draft: AcceptedDraft }>();
  private readonly groupEntries = new Map<string, HTMLElement>();
  private conversationId: string | null = null;

  /** Reconciles the DOM under `target` and returns the created or changed nodes. */
  // The owning agent's persistent-approval sentence, set by the surface from
  // the agent's declaration; a card renders whatever its agent declared.
  permissionScopeNote: string | undefined;

  // `turnStartedAt` is when the running turn began (the surface's per-
  // conversation clock): the working line states the elapsed time from it,
  // and stamps it on the node so the surface can tick the label between
  // renders. Absent for a settled conversation — nothing is working.
  render(target: HTMLElement, projection: ChatProjection | null, expanded: Set<string>, allowSubagents = true, allowRevert = false, turnStartedAt?: number): HTMLElement[] {
    if (!projection) {
      this.reset();
      clearChildren(target);
      return [];
    }
    if (this.conversationId !== projection.conversationId) {
      this.reset();
      clearChildren(target);
      this.conversationId = projection.conversationId;
    }
    const dirty: HTMLElement[] = [];
    const ordered: HTMLElement[] = [];
    // Answerable is decided per owning conversation, not per timeline. With one
    // conversation's items this is exactly the old rule — the newest pending
    // request wins. With a subagent's request shown alongside the parent's,
    // each conversation gets its own active slot, so one cannot block the
    // other. `requirePending` applies the same rule server-side, per owner —
    // and the SAME COMPARATOR: newest createdAt, ties broken by id. Array
    // order is not that comparator (reconciled requests share one Date.now()
    // and keep provider order), and disagreeing with the server enables a
    // card whose every answer gets a stale-interaction conflict.
    const activeByOwner = new Map<string, { id: string; createdAt: number }>();
    for (const item of projection.items) {
      if (item.type !== "permission" && item.type !== "question") continue;
      if (item.status !== "pending") continue;
      const owner = item.conversationId ?? projection.conversationId;
      const current = activeByOwner.get(owner);
      if (!current || item.createdAt > current.createdAt || (item.createdAt === current.createdAt && item.id > current.id)) {
        activeByOwner.set(owner, { id: item.id, createdAt: item.createdAt });
      }
    }
    const activeRequests = new Set<string>([...activeByOwner.values()].map(entry => entry.id));

    const todoLabels = todoActivityLabels(projection.items);
    const durations = turnDurations(projection.items);
    const childLabels = new Map<string, string>();
    for (const entry of subagentEntries(projection.items)) {
      if (entry.conversationId && !childLabels.has(entry.conversationId)) {
        childLabels.set(entry.conversationId, subagentLabel(entry));
      }
    }

    // An assistant message with no text is data, not a bubble: the usage
    // carrier for a tool-only message (`usage:<id>` from normalization) and a
    // part the stream has not filled yet both hold facts the readouts consume
    // while having nothing to show. Filtered before rendering AND before
    // grouping, so a carrier sitting between two tool calls cannot split a
    // finished run's group.
    // A context report is data of the same kind: the readout consumes it,
    // the timeline never shows it.
    // A running background task is presented in the composer's live list;
    // only a settled one takes a place in the timeline (D8).
    const visible = projection.items.filter(item => !(item.type === "assistant_message" && item.markdown === "") && item.type !== "context_report"
      && !(item.type === "background_task" && item.status === "running"));

    const nodes = new Map<string, HTMLElement>();
    for (const [visibleIndex, item] of visible.entries()) {
      const active = activeRequests.has(item.id);
      const todo = todoLabels.get(item.id);
      const duration = durations.get(item.id);
      // Everything outside the item itself that changes its markup, so a
      // cached node is only reused when it would render identically.
      const foreign = (item.type === "permission" || item.type === "question")
        && item.conversationId !== undefined && item.conversationId !== projection.conversationId;
      const origin = foreign
        ? { conversationId: item.conversationId!, label: childLabels.get(item.conversationId!) ?? "Subagent" }
        : undefined;
      const entry = this.entries.get(item.id);
      // Completion is monotonic for an item. A new turn makes the conversation
      // active again, but must not revoke copy actions from an answer that was
      // already observed in a terminal state. An assistant still streaming
      // when a later user message is visible remains incomplete.
      const completedAssistant = item.type === "assistant_message"
        && (entry?.node.dataset.complete === "true" || assistantMessageComplete(visible, visibleIndex, projection.status));
      const variant = [todo?.label ?? "", todo?.task ?? "", duration === undefined ? "" : String(duration), origin?.conversationId ?? "", origin?.label ?? "", String(allowSubagents), String(allowRevert), String(completedAssistant), this.permissionScopeNote ?? ""].join("\u0001");
      if (entry && entry.item === item && entry.active === active && entry.variant === variant) {
        nodes.set(item.id, entry.node);
        continue;
      }
      if (entry && entry.active === active && (item.type !== "question" || entry.variant === variant) && patchInPlace(entry, item, completedAssistant)) {
        entry.variant = variant;
        nodes.set(item.id, entry.node);
        dirty.push(entry.node);
        continue;
      }
      // A request does not take its open state from `expanded`: a pending one
      // is force-open (below), and force-opening it fires a toggle that records
      // it as "expanded" — so honouring that set would keep it open once it
      // resolves and defeat the receding. Instead a pending request opens, and
      // the pending→resolved transition starts the card closed. A card that was
      // already resolved keeps its DOM open state across rebuilds — a resolved
      // item republished with fresh identity (a resync re-running the
      // selection) is not a new resolution, and snapping shut a card the
      // reader opened to audit would punish them for a stream hiccup.
      const isRequest = item.type === "permission" || item.type === "question";
      const stayedResolved = (item.type === "permission" || item.type === "question")
        && item.status === "resolved"
        && entry !== undefined
        && (entry.item.type === "permission" || entry.item.type === "question")
        && entry.item.status === "resolved";
      // A row the stream opened for its live tail is not a row the reader
      // opened: taking its DOM state back as "expanded" would keep a finished
      // tool permanently expanded, since the auto-open rule would then never
      // get to say no. Its own rule decides again on every render instead.
      const open = isRequest
        ? stayedResolved && entry!.node.hasAttribute("open")
        : entry
          ? entry.node.hasAttribute("open") && !entry.node.hasAttribute("data-auto-open")
          : expanded.has(item.id);
      // Carried forward across the rebuild: an explicit close outranks the
      // auto-open rule for the rest of the run, so a tool that keeps talking
      // cannot reopen a row the reader shut.
      const readerClosed = entry?.node.hasAttribute(READER_CLOSED) ?? false;
      const node = buildNode(renderItem(item, open, active, todo, duration, origin, readerClosed, allowSubagents, completedAssistant, allowRevert, this.permissionScopeNote));
      if (completedAssistant) decorateAssistantCopyActions(node);
      entry?.node.remove();
      this.entries.set(item.id, { node, item, active, variant });
      nodes.set(item.id, node);
      dirty.push(node);
    }

    // Assemble the top level: finished runs of activity rows and the live
    // tail of a running turn collapse behind one group line; everything else
    // stays flat. Member nodes keep their per-item identity — grouping only
    // changes where they are parented.
    const liveGroupIds = new Set<string>();
    // The awaiting form of the working line (a turn with nothing back yet)
    // is placed after the accepted drafts, not before them: the draft is the
    // prompt the agent is working on, and the line answers it.
    let awaitingNode: HTMLElement | null = null;
    for (const segment of activitySegments(visible, projection.status, projection.acceptedDrafts.length > 0)) {
      if (!segment.group) {
        for (const item of segment.items) {
          const node = nodes.get(item.id);
          if (node) ordered.push(node);
        }
        continue;
      }
      liveGroupIds.add(segment.group.id);
      let groupNode = this.groupEntries.get(segment.group.id);
      if (!groupNode) {
        groupNode = buildNode(renderGroup(segment.group.id, segment.items.length === 0, expanded.has(segment.group.id)));
        this.groupEntries.set(segment.group.id, groupNode);
        dirty.push(groupNode);
      }
      groupNode.dataset.outcome = segment.group.outcome;
      if (segment.group.live && turnStartedAt !== undefined) groupNode.dataset.workingSince = String(turnStartedAt);
      else delete groupNode.dataset.workingSince;
      const count = groupNode.querySelector(".chat-group-count");
      if (count) count.textContent = segment.group.live ? workingLabel(turnStartedAt === undefined ? undefined : Date.now() - turnStartedAt) : `${segment.items.length} steps`;
      const subject = groupNode.querySelector(".chat-activity-subject");
      if (subject) subject.textContent = segment.group.summary;
      if (segment.items.length === 0) {
        awaitingNode = groupNode;
        continue;
      }
      const body = groupNode.querySelector(".chat-group-items");
      if (body) {
        let memberCursor = body.firstElementChild;
        for (const item of segment.items) {
          const node = nodes.get(item.id);
          if (!node) continue;
          if (node === memberCursor) {
            memberCursor = memberCursor.nextElementSibling;
            continue;
          }
          body.insertBefore(node, memberCursor);
        }
      }
      ordered.push(groupNode);
    }

    for (const draft of projection.acceptedDrafts) {
      const entry = this.draftEntries.get(draft.requestId);
      if (entry && entry.draft.messageId === draft.messageId && entry.draft.text === draft.text) {
        ordered.push(entry.node);
        continue;
      }
      const node = buildNode(renderDraft(draft));
      entry?.node.remove();
      this.draftEntries.set(draft.requestId, { node, draft });
      ordered.push(node);
      dirty.push(node);
    }
    if (awaitingNode) ordered.push(awaitingNode);

    const liveIds = new Set(projection.items.map(item => item.id));
    for (const [id, entry] of this.entries) {
      if (!liveIds.has(id)) {
        entry.node.remove();
        this.entries.delete(id);
      }
    }
    const liveDrafts = new Set(projection.acceptedDrafts.map(draft => draft.requestId));
    for (const [id, entry] of this.draftEntries) {
      if (!liveDrafts.has(id)) {
        entry.node.remove();
        this.draftEntries.delete(id);
      }
    }

    let cursor = target.firstElementChild;
    for (const node of ordered) {
      if (node === cursor) {
        cursor = cursor.nextElementSibling;
        continue;
      }
      target.insertBefore(node, cursor);
    }
    // After the walk: a dissolved group's members have been reparented back
    // to the top level, so removing the stale group node here deletes only
    // the empty shell.
    for (const [id, groupNode] of this.groupEntries) {
      if (!liveGroupIds.has(id)) {
        groupNode.remove();
        this.groupEntries.delete(id);
      }
    }
    return dirty;
  }

  reset(): void {
    this.entries.clear();
    this.draftEntries.clear();
    this.groupEntries.clear();
    this.conversationId = null;
  }
}

/**
 * Summary label for each todo update, derived by walking the timeline in order
 * and diffing each snapshot against the one before it. Cross-item context, so
 * it cannot live in the per-item `describeToolDetail`.
 */
function todoActivityLabels(items: readonly ConversationItem[]): Map<string, TodoSummary> {
  const labels = new Map<string, TodoSummary>();
  let previous: TodoEntry[] = [];
  for (const item of items) {
    if (item.type !== "tool") continue;
    const detail = describeToolDetail(item);
    if (detail.kind !== "todo") continue;
    labels.set(item.id, todoActivitySummary(deriveTodoActivities(previous, detail.entries), detail.entries));
    previous = detail.entries;
  }
  return labels;
}

/**
 * The live todo list: the newest `todowrite` snapshot in the conversation.
 * Each write carries the whole list, so the last one is the current state.
 */
export function latestTodoEntries(items: readonly ConversationItem[]): TodoEntry[] {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.type !== "tool") continue;
    const detail = describeToolDetail(item);
    if (detail.kind === "todo") return detail.entries;
  }
  return [];
}

// `model` and `usage` come from the child session the subagent ran as,
// mirrored onto this tool item by the adapter — the client holds one
// conversation's projection and can never read a child's. Both are optional:
// a subagent that has not reported them still has a row to render.
export type SubagentEntry = {
  id: string;
  description: string;
  subagent?: string;
  status: ConversationStatus | string;
  conversationId?: string;
  model?: string;
  usage?: TokenUsage;
};

export function subagentLabel(entry: SubagentEntry): string {
  return entry.subagent ? `${entry.subagent} · ${entry.description}` : entry.description;
}

/**
 * Subagents launched in this conversation, in the order they started. Unlike
 * todos, each `task` call is its own agent rather than a snapshot of one list,
 * so every item counts — a fan-out of three is three entries.
 */
export function subagentEntries(items: readonly ConversationItem[]): SubagentEntry[] {
  const entries: SubagentEntry[] = [];
  for (const item of items) {
    if (item.type !== "tool") continue;
    const detail = describeToolDetail(item);
    if (detail.kind !== "agent") continue;
    entries.push({
      id: item.id,
      description: detail.description,
      ...(detail.subagent === undefined ? {} : { subagent: detail.subagent }),
      status: item.status,
      ...(detail.conversationId === undefined ? {} : { conversationId: detail.conversationId }),
      ...(item.model === undefined ? {} : { model: item.model }),
      ...(item.usage === undefined ? {} : { usage: item.usage }),
    });
  }
  return entries;
}

/**
 * What a group line's status dot says. `failed` outranks `live`: a step that
 * failed mid-turn is the one thing the reader must not miss while the line
 * stays collapsed, so the dot reddens the moment it happens rather than at
 * settle. `clean` is a finished group whose every member ended without
 * failing (a cancelled step is not a failure).
 */
export type GroupOutcome = "live" | "clean" | "failed";

type TimelineGroup = { id: string; live: boolean; summary: string; outcome: GroupOutcome };

type TimelineSegment = {
  group: TimelineGroup | null;
  items: ConversationItem[];
};

const GROUP_MIN = 3;

type ActivityItem = Extract<ConversationItem, { type: "tool" | "command" | "reasoning" | "background_task" }>;

function isActivity(item: ConversationItem): item is ActivityItem {
  return item.type === "tool" || item.type === "command" || item.type === "reasoning" || item.type === "background_task";
}

/**
 * Waiting on the agent's first sign of life for this turn: the prompt is
 * accepted and nothing newer than the reader's own message has arrived. A
 * local model that must load its weights sits in this state for a long
 * while, and the composer's "Working" line — visually hidden in touch mode —
 * would otherwise be the only thing saying anything was happening at all.
 * Pure over the timeline, so the working line can be one element from this
 * state through the steps to done.
 */
export function awaitingFirstResponse(items: readonly ConversationItem[], status: ConversationStatus, acceptedDrafts = false): boolean {
  if (!isLiveConversationStatus(status)) return false;
  if (acceptedDrafts) return true;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.type === "user_message") return true;
    // A previous turn's footer, a hidden usage carrier, a context report,
    // and a compaction marker say nothing about THIS turn's response; keep
    // looking past them.
    if (item.type === "turn_status" || item.type === "context_report" || item.type === "compaction") continue;
    if (item.type === "assistant_message" && item.markdown === "") continue;
    return false;
  }
  return false;
}

/**
 * Splits the timeline into flat items and groupable runs. A run of
 * consecutive activity rows (tool, command, reasoning, background task)
 * collapses behind one group line when it is long enough and every member
 * has finished. The trailing run of a still-running turn collapses from its
 * very first member instead: that is the work happening now, and one line
 * saying so — opened on demand — keeps the timeline calm while it does.
 * Letting the first steps render flat and then fold at three would be the
 * flicker the line exists to remove. A turn with nothing back yet gets the
 * same line with no members, so the reader watches one element from
 * "accepted" to "done".
 */
function activitySegments(items: readonly ConversationItem[], status: ConversationStatus, acceptedDrafts = false): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  let run: ActivityItem[] = [];
  const flushRun = (isTail: boolean) => {
    if (run.length === 0) return;
    const finished = run.every(item => item.status !== "running" && item.status !== "pending");
    const live = isTail && isLiveConversationStatus(status);
    segments.push(live || (run.length >= GROUP_MIN && finished)
      ? { group: describeGroup(run, live), items: run }
      : { group: null, items: run });
    run = [];
  };
  for (const item of items) {
    if (isActivity(item)) {
      run.push(item);
      continue;
    }
    flushRun(false);
    segments.push({ group: null, items: [item] });
  }
  flushRun(true);
  if (awaitingFirstResponse(items, status, acceptedDrafts)) {
    // Keyed by the prompt it answers: a different element from the group the
    // first step will start (which is keyed by that step), so the empty form
    // never carries an open state — there is nothing in it to open.
    const prompt = items.findLast(item => item.type === "user_message");
    segments.push({ group: { id: `group:${prompt?.id ?? "awaiting"}`, live: true, summary: "", outcome: "live" }, items: [] });
  }
  return segments;
}

function describeGroup(run: readonly ActivityItem[], live: boolean): TimelineGroup {
  const failed = run.some(item => item.status === "failed");
  return {
    id: `group:${run[0]!.id}`,
    live,
    summary: live ? currentStep(run) : groupSummary(run),
    outcome: failed ? "failed" : live ? "live" : "clean",
  };
}

/**
 * The step in flight, for the working line: the last member still running or
 * pending, else the last member (between steps, the line names what just
 * happened rather than going blank). Not the rolling summary — "Fetch … ·
 * WebSearch ×3" reads as a ledger, and a status line should read as a status.
 */
function currentStep(run: readonly ActivityItem[]): string {
  const step = run.findLast(item => item.status === "running" || item.status === "pending") ?? run[run.length - 1]!;
  const { label, subject } = stepName(step);
  return subject ? `${label} ${workspaceRelative(subject)}` : label;
}

/** "Working · 20s" from the turn's elapsed time; "Working" when no clock is known. */
export function workingLabel(elapsedMs: number | undefined): string {
  return elapsedMs === undefined ? "Working" : `Working · ${formatElapsed(elapsedMs)}`;
}

/** "12s" / "1m 5s", never empty — a clock that starts at "0s". */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// The markup of a group line, in its two forms. The populated form is a
// details whose body holds the member rows; the awaiting form has no members
// and is not a details, so it offers no cursor and no toggle — but it keeps
// the same classes and the same slots, so the swap to the populated form
// when the first step arrives moves nothing on screen. The awaiting form
// carries no item id: it is a status line, not a transcript entry, and
// everything that walks `[data-chat-item-id]` (anchors, the last delivered
// message) must keep seeing the entries only.
function renderGroup(id: string, awaiting: boolean, open: boolean): string {
  const line = `<span class="chat-group-dot" aria-hidden="true"></span><span class="chat-group-count"></span><span class="chat-activity-subject"></span>`;
  if (awaiting) return `<div class="chat-item chat-activity-group is-awaiting"><div class="chat-group-line">${line}</div></div>`;
  return `<details class="chat-item chat-activity-group" data-chat-item-id="${escapeHtmlAttribute(id)}"${open ? " open" : ""}><summary>${line}</summary><div class="chat-group-items"></div></details>`;
}

/**
 * How a step is named on a group line: its kind, and what it acted on where
 * the agent said. Grouped reasoning stays "Thought" without a duration — the
 * line counts kinds of steps, and per-entry timings belong on the entries.
 */
function stepName(item: ActivityItem): { label: string; subject: string | undefined } {
  if (item.type === "command") return { label: "Shell", subject: commandSubject(item.command) };
  if (item.type === "reasoning") return { label: item.label ?? (item.status === "completed" ? "Thought" : "Thinking"), subject: undefined };
  if (item.type === "background_task") return { label: backgroundTaskLabel(item), subject: item.description };
  const detail = describeToolDetail(item);
  return { label: detail.label, subject: toolSubject(detail) };
}

// How many steps a collapsed group names before it counts the rest.
const GROUP_NAMED = 3;

/**
 * The collapsed line of a group: the first few steps that acted on
 * something, named with it ("Bash ./hello.sh · Bash ls -la · Read
 * README.md"), then everything else counted by kind ("Thought ×3"). Naming
 * is what makes the line legible without opening it (spec: a group still
 * names the commands it contains); counting keeps a long run to one line,
 * and reasoning steps — which act on nothing — never take a named slot.
 */
function groupSummary(run: readonly ActivityItem[]): string {
  const named: string[] = [];
  const counts = new Map<string, number>();
  for (const item of run) {
    const { label, subject } = stepName(item);
    if (subject && named.length < GROUP_NAMED) {
      named.push(`${label} ${workspaceRelative(subject)}`);
      continue;
    }
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const counted = [...counts.entries()].map(([label, count]) => count > 1 ? `${label} ×${count}` : label);
  return [...named, ...counted].join(" · ");
}

/** "Thinking" while it streams; "Thought for 12s" (or just "Thought") after. */
export function reasoningLabel(item: Extract<ConversationItem, { type: "reasoning" }>): string {
  // Recalled context carries its own label; only the model's own thinking
  // is "Thought".
  if (item.label) return item.label;
  if (item.status !== "completed") return "Thinking";
  const worked = item.durationMs === undefined ? "" : formatWorked(item.durationMs);
  return worked ? `Thought for ${worked}` : "Thought";
}

/**
 * Duration of each finished turn, keyed by its turn_status item: the span
 * from the prompt that started the turn to the status that closed it. One
 * footer per prompt — a second status without a new prompt gets no figure.
 */
function turnDurations(items: readonly ConversationItem[]): Map<string, number> {
  const durations = new Map<string, number>();
  let promptAt: number | null = null;
  for (const item of items) {
    if (item.type === "user_message") {
      if (item.createdAt) promptAt = item.createdAt;
      continue;
    }
    if (item.type === "turn_status" && promptAt !== null && item.createdAt > promptAt) {
      durations.set(item.id, item.createdAt - promptAt);
      promptAt = null;
    }
  }
  return durations;
}

function formatWorked(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return "";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Streaming-friendly updates that avoid rebuilding the node. */
function patchInPlace(entry: RenderedEntry, item: ConversationItem, completedAssistant = false): boolean {
  const current = entry.item;
  if (current.type !== item.type) return false;
  if (item.type === "assistant_message" && current.type === "assistant_message") {
    const content = entry.node.querySelector<HTMLElement>(".chat-assistant-content");
    if (!content) return false;
    if (current.markdown !== item.markdown) content.innerHTML = renderChatMarkdown(item.markdown);
    entry.node.dataset.complete = String(completedAssistant);
    if (completedAssistant) decorateAssistantCopyActions(entry.node);
    else entry.node.querySelectorAll("[data-chat-copy]").forEach(control => control.remove());
    entry.item = item;
    return true;
  }
  // A pending question is republished whenever its tool part moves, but a
  // rebuilt node would discard the answers being typed into it and reset the
  // step in view. An unchanged question keeps its DOM.
  if (item.type === "question" && current.type === "question") {
    if (current.status !== item.status || current.requestId !== item.requestId) return false;
    if (JSON.stringify(current.questions) !== JSON.stringify(item.questions)) return false;
    entry.item = item;
    return true;
  }
  if (item.type === "reasoning" && current.type === "reasoning") {
    entry.node.className = `chat-item chat-activity is-${item.status}`;
    const status = entry.node.querySelector(".chat-activity-status");
    if (status) status.textContent = item.status;
    const label = entry.node.querySelector("summary > span");
    if (label) label.textContent = reasoningLabel(item);
    const pre = entry.node.querySelector("pre");
    if (pre) pre.textContent = item.text;
    entry.item = item;
    return true;
  }
  return false;
}

function clearChildren(target: HTMLElement): void {
  while (target.firstChild) target.firstChild.remove();
}

function buildNode(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.firstElementChild as HTMLElement;
}

/**
 * Shared by timeline items, drafts, and the queue dock. A reference without
 * an id (a replayed attachment that could not be recovered) renders the
 * labeled placeholder immediately; one whose stored bytes have since
 * vanished gets the same treatment when its image errors
 * (decorateAttachmentImages). Names are hostile input: escaped everywhere.
 */
function renderMessageAttachments(attachments: readonly MessageAttachment[] | undefined): string {
  if (!attachments?.length) return "";
  const entries = attachments.map(attachment => {
    const name = escapeHtml(attachment.name);
    if (!attachment.id) {
      return `<span class="chat-message-attachment is-missing" role="listitem"><span class="chat-attachment-missing" aria-hidden="true">?</span><span class="chat-attachment-name">${name}</span></span>`;
    }
    const src = escapeHtmlAttribute(appUrl(`/api/chat/attachments/${encodeURIComponent(attachment.id)}`));
    const label = escapeHtmlAttribute(`View ${attachment.name} full size`);
    return `<span class="chat-message-attachment" role="listitem"><button type="button" class="chat-attachment-view" data-attachment-view="${src}" data-attachment-view-name="${escapeHtmlAttribute(attachment.name)}" aria-label="${label}"><img class="chat-message-attachment-thumb" src="${src}" alt="${escapeHtmlAttribute(attachment.name)}" loading="lazy"></button><span class="chat-attachment-name">${name}</span></span>`;
  });
  return `<div class="chat-message-attachments" role="list" aria-label="Attached images">${entries.join("")}</div>`;
}

/** Swaps a thumbnail whose bytes are gone for the labeled placeholder. */
export function decorateAttachmentImages(root: HTMLElement): void {
  for (const image of root.querySelectorAll<HTMLImageElement>(".chat-message-attachment-thumb")) {
    if (image.dataset.attachmentWatched) continue;
    image.dataset.attachmentWatched = "true";
    image.addEventListener("error", () => {
      const placeholder = document.createElement("span");
      placeholder.className = "chat-attachment-missing";
      placeholder.setAttribute("aria-hidden", "true");
      placeholder.textContent = "?";
      image.closest(".chat-message-attachment")?.classList.add("is-missing");
      // Bytes are gone; a viewer opening on this reference has nothing to show.
      const view = image.closest<HTMLButtonElement>("[data-attachment-view]");
      if (view) {
        view.disabled = true;
        view.removeAttribute("data-attachment-view");
      }
      image.replaceWith(placeholder);
    }, { once: true });
  }
}

function renderDraft(draft: AcceptedDraft): string {
  const label = draft.messageId.startsWith("pending:") ? "Sending…" : "Delivered, waiting for agent history";
  return `<article class="chat-item chat-user-message is-pending" data-chat-item-id="draft-${escapeHtmlAttribute(draft.requestId)}">${renderMessageAttachments(draft.attachments)}${draft.text ? `<p>${escapeHtml(draft.text)}</p>` : ""}<small>${label}</small></article>`;
}

// A held message is not a timeline item: it renders in the dock above the
// composer, keeps its removal control, and only becomes a transcript entry
// when the workspace delivers it.
function renderQueued(held: QueuedMessage): string {
  const id = escapeHtmlAttribute(held.id);
  return `<article class="chat-queued-message is-held" role="listitem" data-chat-queued-id="${id}">${renderMessageAttachments(held.attachments)}${held.text ? `<p>${escapeHtml(held.text)}</p>` : ""}<footer class="chat-queued-row"><small class="chat-queued-tag">Queued — sends when the agent is ready</small><button type="button" class="chat-queued-remove" data-queue-remove="${id}">Remove</button></footer></article>`;
}

/**
 * Reconciles the queue dock — the strip docked to the composer that shows
 * what the workspace holds. Deliberately outside the timeline scroll: a held
 * message must sit against the composer whatever length the transcript is
 * and wherever the reader has scrolled it.
 */
export class QueueDockRenderer {
  private readonly entries = new Map<string, { node: HTMLElement; held: QueuedMessage }>();

  render(target: HTMLElement, queued: readonly QueuedMessage[]): void {
    const ordered: HTMLElement[] = [];
    for (const held of queued) {
      const entry = this.entries.get(held.id);
      if (entry && entry.held.text === held.text && JSON.stringify(entry.held.attachments ?? []) === JSON.stringify(held.attachments ?? [])) {
        ordered.push(entry.node);
        continue;
      }
      const node = buildNode(renderQueued(held));
      decorateAttachmentImages(node);
      entry?.node.remove();
      this.entries.set(held.id, { node, held });
      ordered.push(node);
    }
    const live = new Set(queued.map(held => held.id));
    for (const [id, entry] of this.entries) {
      if (!live.has(id)) {
        entry.node.remove();
        this.entries.delete(id);
      }
    }
    let cursor = target.firstElementChild;
    for (const node of ordered) {
      if (node === cursor) {
        cursor = cursor.nextElementSibling;
        continue;
      }
      target.insertBefore(node, cursor);
    }
    target.hidden = queued.length === 0;
  }

  reset(): void {
    this.entries.clear();
  }
}

function renderReverted(message: RevertedUserMessage): string {
  const id = escapeHtmlAttribute(message.id);
  return `<article class="chat-reverted-message" role="listitem" data-chat-reverted-id="${id}"><p>${escapeHtml(message.text)}</p><button type="button" class="chat-reverted-restore" data-history-restore="${id}">Restore message</button></article>`;
}

export class RevertedMessagesDockRenderer {
  private readonly entries = new Map<string, { node: HTMLElement; message: RevertedUserMessage }>();

  constructor(
    private readonly shell: HTMLDetailsElement,
    private readonly label: HTMLElement,
    private readonly target: HTMLElement,
  ) {}

  render(messages: readonly RevertedUserMessage[]): void {
    const ordered: HTMLElement[] = [];
    for (const message of messages) {
      const entry = this.entries.get(message.id);
      if (entry?.message.text === message.text) {
        ordered.push(entry.node);
        continue;
      }
      const node = buildNode(renderReverted(message));
      entry?.node.remove();
      this.entries.set(message.id, { node, message });
      ordered.push(node);
    }
    const live = new Set(messages.map(message => message.id));
    for (const [id, entry] of this.entries) {
      if (live.has(id)) continue;
      entry.node.remove();
      this.entries.delete(id);
    }
    let cursor = this.target.firstElementChild;
    for (const node of ordered) {
      if (node === cursor) {
        cursor = cursor.nextElementSibling;
        continue;
      }
      this.target.insertBefore(node, cursor);
    }
    this.label.textContent = `${messages.length} reverted ${messages.length === 1 ? "message" : "messages"}`;
    this.shell.hidden = messages.length === 0;
  }

  reset(): void {
    this.entries.clear();
    this.target.replaceChildren();
    this.shell.hidden = true;
  }
}

type RequestOrigin = { conversationId: string; label: string };

export function renderItem(item: ConversationItem, open: boolean, activeRequest: boolean, todo?: TodoSummary, durationMs?: number, origin?: RequestOrigin, readerClosed = false, allowSubagents = true, completedAssistant = false, allowRevert = false, permissionScopeNote?: string): string {
  const id = escapeHtmlAttribute(item.id);
  const stamp = timestampAttribute(item.createdAt);
  if (item.type === "user_message") {
    const action = allowRevert
      ? `<footer class="chat-message-actions"><button type="button" class="chat-message-revert" data-history-revert="${id}" aria-label="Revert message" title="Revert message"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M6 4 2.5 7.5 6 11M3 7.5h6a4 4 0 0 1 4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button></footer>`
      : "";
    return `<article class="chat-item chat-user-message" data-chat-item-id="${id}"${stamp}>${renderMessageAttachments(item.attachments)}${item.text ? `<div>${escapeHtml(item.text)}</div>` : ""}${action}</article>`;
  }
  if (item.type === "assistant_message") return `<article class="chat-item chat-assistant-message" data-chat-item-id="${id}" data-complete="${completedAssistant}"${stamp}><div class="chat-assistant-content markdown-body">${renderChatMarkdown(item.markdown)}</div></article>`;
  if (item.type === "turn_status") {
    const worked = durationMs === undefined ? "" : formatWorked(durationMs);
    return `<footer class="chat-item chat-turn-status is-${item.status}" data-chat-item-id="${id}"${stamp} role="status">${escapeHtml(statusLabel(item.status))}${item.message ? `: ${escapeHtml(item.message)}` : ""}${worked ? ` <span class="chat-turn-worked">· worked ${worked}</span>` : ""}</footer>`;
  }
  if (item.type === "notice") {
    // A reset time is formatted here, in the reader's zone, never on the server.
    const resets = item.resetsAt === undefined ? "" : ` Resets ${new Date(item.resetsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;
    return `<aside class="chat-item chat-notice is-${item.level}" data-chat-item-id="${id}"${stamp}${item.code ? ` data-notice-code="${escapeHtmlAttribute(item.code)}"` : ""} role="${item.level === "error" ? "alert" : "status"}">${escapeHtml(item.message + resets)}</aside>`;
  }
  // Compaction is a boundary, not a step: a quiet rule across the timeline
  // stating that the agent summarized what came before, with the agent's
  // own figures when it reported them. Earlier content stays above it.
  if (item.type === "compaction") return `<div class="chat-item chat-compaction" data-chat-item-id="${id}"${stamp} role="status"><span class="chat-compaction-label">${escapeHtml(compactionLabel(item))}</span></div>`;
  // Never reached: reports are filtered before rendering. Kept exhaustive so
  // a new kind fails loudly here rather than falling into the activity shell.
  if (item.type === "context_report") return "";
  // A settled background task: its outcome and the agent's summary, in
  // place. (Running ones are filtered out above and listed by the composer.)
  if (item.type === "background_task") {
    const outcome = item.status === "completed" ? "completed" : item.status === "failed" ? "failed" : item.status === "stopped" ? "cancelled" : "running";
    const body = `${item.summary ? `<pre class="chat-task-summary">${escapeHtml(item.summary)}</pre>` : ""}${item.toolUseId ? `<p class="chat-tool-meta">Started by the ${escapeHtml(item.taskType === "local_agent" ? "Agent" : "Bash")} step above.</p>` : ""}`;
    return activityShell(id, outcome, backgroundTaskLabel(item), item.description, body, open, false, readerClosed, stamp, item.status === "stopped" ? "stopped" : undefined);
  }
  if (item.type === "file_change") {
    return `<article class="chat-item chat-file-change" data-chat-item-id="${id}"${stamp}><span>${escapeHtml(item.operation)}</span> <button type="button" data-file-ref="${escapeHtmlAttribute(item.path)}">${escapeHtml(item.path)}</button>${counts(item.additions, item.deletions)}</article>`;
  }
  if (item.type === "task_progress") {
    // One presentation, updated in place: the same item id re-renders this
    // element rather than appending an entry per update (D9).
    const done = item.entries.filter(entry => entry.status === "completed").length;
    const rows = item.entries.map(entry => {
      const label = entry.status === "in_progress" && entry.activeText ? entry.activeText : entry.text;
      return `<li class="chat-task is-${entry.status}"><span class="chat-task-marker" aria-hidden="true"></span><span class="chat-task-text">${escapeHtml(label)}</span></li>`;
    }).join("");
    return `<section class="chat-item chat-task-progress" data-chat-item-id="${id}"${stamp} aria-label="Task progress"><header class="chat-task-progress-header">Tasks <span class="chat-task-progress-count">${done}/${item.entries.length}</span></header><ol class="chat-task-list">${rows}</ol></section>`;
  }
  if (item.type === "permission") return renderPermission(item, open, activeRequest, origin, allowSubagents, permissionScopeNote);
  if (item.type === "question") return renderQuestion(item, open, activeRequest, origin, allowSubagents);
  if (item.type === "tool") return renderTool(item, open, readerClosed, todo, allowSubagents);
  // A command's text is the subject, not the label. As a label it lands in the
  // summary's non-shrinking slot, so a long pipeline overruns the row instead
  // of truncating; "Shell" names the step and the command ellipsizes beside it.
  if (item.type === "command") {
    return activityShell(id, item.status, "Shell", item.command, renderActivityOutput(item.output, item.status), open, autoOpen(item.status, item.output) && !readerClosed, readerClosed, stamp);
  }
  // Reasoning has no streamed output to auto-open for; it opens only when the
  // reader says so.
  return activityShell(id, item.status, reasoningLabel(item), undefined, `<pre>${escapeHtml(item.text)}</pre>`, open, false, readerClosed, stamp);
}

function assistantMessageComplete(items: readonly ConversationItem[], index: number, status: ConversationStatus): boolean {
  const item = items[index];
  if (!item || item.type !== "assistant_message") return false;
  if (item.completedAt !== undefined) return true;
  if (items.slice(index + 1).some(candidate => candidate.type === "turn_status")) return true;
  // A retry or a compaction is still the same turn: the response may go on.
  return !isLiveConversationStatus(status);
}

export function decorateAssistantCopyActions(container: HTMLElement): void {
  const article = container.matches(".chat-assistant-message")
    ? container
    : container.querySelector<HTMLElement>(".chat-assistant-message");
  if (!article || article.dataset.complete !== "true") return;
  const content = article.querySelector<HTMLElement>(".chat-assistant-content");
  if (!content) return;
  for (const pre of content.querySelectorAll<HTMLPreElement>("pre")) {
    if (!pre.querySelector(":scope > code") || pre.querySelector(":scope > [data-chat-copy='code']")) continue;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "chat-copy-action chat-code-copy";
    copy.dataset.chatCopy = "code";
    copy.setAttribute("aria-label", "Copy code block");
    copy.title = "Copy code block";
    pre.append(copy);
  }
}

// How much of a tool's output to show before it becomes a show-more (finished)
// or an elided tail (running). Chosen to keep a chatty tool from taking over
// the transcript while still showing enough to read what it did.
const OUTPUT_LINE_LIMIT = 12;

// A running tool's row opens itself once it has output, so its live tail is
// visible without the reader hunting for it — the way OpenCode's own client
// shows a command working. A finished tool follows the normal collapse rules,
// which is what `autoOpen` exists to make possible: the row has to be able to
// say the stream opened it, or reading its DOM state back on the next render
// would keep it open forever once the tool finished (the same trap the
// force-open rule for requests documents above).
function autoOpen(status: ActivityStatus, output: string | undefined): boolean {
  return status === "running" && !!output;
}

/**
 * A row the reader deliberately closed. Held in the DOM for the same reason
 * the auto-open marker is — the next render reads its open state back from
 * there — and needed for the same reason in mirror image: the auto-open rule
 * is recomputed from status and output on every render, so a chatty tool would
 * shoulder the row back open on its very next chunk. Closing it has to mean
 * something for the rest of the run, not until the next line of output.
 */
export const READER_CLOSED = "data-reader-closed";

// One rendering for a tool or command's output. While it runs, only the tail
// is shown (and rendered) so progress is visible without the transcript
// carrying the whole log; once finished, a long output is bounded to a preview
// with a native show-more that reveals the rest — from then on the full text
// is present in the DOM.
function renderActivityOutput(output: string | undefined, status: ActivityStatus): string {
  if (!output) return "";
  if (status === "running") {
    // Search backward only as far as the visible tail. This runs for every
    // cumulative chunk, so counting every newline would make a long stream
    // quadratic even though only twelve lines are rendered.
    let cut = output.length;
    for (let index = 0; index < OUTPUT_LINE_LIMIT; index += 1) {
      cut = output.lastIndexOf("\n", cut - 1);
      if (cut === -1) return `<pre class="chat-tool-stream">${escapeHtml(output)}</pre>`;
    }
    return `<p class="chat-output-elided">Earlier output omitted</p><pre class="chat-tool-stream">${escapeHtml(output.slice(cut + 1))}</pre>`;
  }
  const lines = output.split("\n");
  if (lines.length <= OUTPUT_LINE_LIMIT) return `<pre>${escapeHtml(output)}</pre>`;
  const preview = lines.slice(0, OUTPUT_LINE_LIMIT).join("\n");
  const rest = lines.slice(OUTPUT_LINE_LIMIT).join("\n");
  const more = lines.length - OUTPUT_LINE_LIMIT;
  return `<pre>${escapeHtml(preview)}</pre><details class="chat-output-more"><summary>Show ${more} more ${more === 1 ? "line" : "lines"}</summary><pre>${escapeHtml(rest)}</pre></details>`;
}

function renderTool(item: ToolItem, open: boolean, readerClosed: boolean, todo: TodoSummary | undefined, allowSubagents: boolean): string {
  const detail = describeToolDetail(item);
  const body = toolBody(detail, item, allowSubagents);
  // A todo update stays collapsed, but its summary reports what moved and to
  // which task — every todowrite call carries the whole list, so showing the
  // list each time reprints it verbatim on every tool call.
  const label = detail.kind === "todo" && todo ? todo.label : detail.label;
  const subject = detail.kind === "todo" ? todo?.task : toolSubject(detail);
  return activityShell(escapeHtmlAttribute(item.id), item.status, label, subject, body, open, autoOpen(item.status, item.output) && !readerClosed, readerClosed, timestampAttribute(item.createdAt), activityStatusText(item.status, item.elapsedMs));
}

// One rendering for every diff the chat shows — a tool's edit, a patch, and a
// permission's pending change all read the same way.
function chatDiffMarkup(diff: DiffLine[]): string {
  return `<pre class="chat-diff">${diff.map(line => `<span class="chat-diff-line is-${line.sign === "-" ? "del" : "add"}">${escapeHtml(`${line.sign} ${line.text}`)}</span>`).join("\n")}</pre>`;
}

function toolBody(detail: ToolDetail, item: ToolItem, allowSubagents: boolean): string {
  const error = item.error ? `<pre class="chat-tool-error">${escapeHtml(item.error)}</pre>` : "";
  // Every branch has to surface `item.output` somehow, because the auto-open
  // rule keys on output alone: a row that opens itself to show its live tail
  // and then renders a body without it is a row that opened for nothing. The
  // branches below that omit `outputBlock` surface it in their own words
  // instead — `question` as the answer it parsed, `agent` as the subagent's
  // report — which is why they are not bare.
  switch (detail.kind) {
    case "edit":
      return `${fileButton(detail.path)}${chatDiffMarkup(detail.diff)}${outputBlock(item)}${error}`;
    case "write":
      return `${fileButton(detail.path)}<pre>${escapeHtml(detail.content)}</pre>${outputBlock(item)}${error}`;
    case "read":
      return `${fileButton(detail.startLine ? `${detail.path}:${detail.startLine}` : detail.path)}${outputBlock(item)}${error}`;
    case "search":
      return `<p class="chat-tool-meta"><code>${escapeHtml(detail.query)}</code>${detail.where ? ` in <code>${escapeHtml(detail.where)}</code>` : ""}</p>${outputBlock(item)}${error}`;
    case "fetch":
      return `<p class="chat-tool-meta"><code>${escapeHtml(detail.url)}</code></p>${outputBlock(item)}${error}`;
    case "todo":
      return `<ul class="chat-todo">${detail.entries.map(entry => `<li class="is-${entry.state}">${escapeHtml(entry.text)}</li>`).join("")}</ul>${outputBlock(item)}${error}`;
    case "patch":
      return `${detail.files.map(file => fileButton(file)).join("")}${chatDiffMarkup(detail.diff)}${outputBlock(item)}${error}`;
    case "question":
      return `${detail.asked.map(entry => `<p class="chat-tool-meta"><strong>${escapeHtml(entry.header)}</strong></p><p>${escapeHtml(entry.prompt)}</p>`).join("")}${detail.answer ? `<p class="chat-request-outcome">${escapeHtml(detail.answer)}</p>` : ""}${error}`;
    case "agent":
      // The result is the subagent's report — prose, rendered like assistant
      // markdown rather than dumped as the raw task envelope.
      return `<p class="chat-tool-meta">${detail.subagent ? `<code>${escapeHtml(detail.subagent)}</code> ` : ""}${escapeHtml(detail.description)}${allowSubagents && detail.conversationId ? ` <button type="button" data-open-conversation="${escapeHtmlAttribute(detail.conversationId)}">Open transcript</button>` : ""}</p><pre>${escapeHtml(detail.prompt)}</pre>${detail.result ? renderSubagentResult(detail.result) : ""}${error}`;
    case "skill":
      return `${outputBlock(item)}${error}`;
    case "bash":
      // The command in full (the summary showed its first line), what the
      // agent said it was for, then the bounded output.
      return `<pre class="chat-tool-command">${escapeHtml(detail.command)}</pre>${detail.description || detail.background ? `<p class="chat-tool-meta">${detail.description ? escapeHtml(detail.description) : ""}${detail.background ? `${detail.description ? " · " : ""}<span class="chat-tool-background">started in the background</span>` : ""}</p>` : ""}${outputBlock(item)}${error}`;
    default:
      // An unknown tool: show its input, then bound its output like any other.
      return `${item.input ? `<pre>${escapeHtml(item.input)}</pre>` : ""}${outputBlock(item)}${error}`;
  }
}

function outputBlock(item: ToolItem): string {
  return renderActivityOutput(item.output, item.status);
}

// Task output is prose rather than a raw log, but it obeys the same finished
// output bound. Both preview and remainder stay Markdown-rendered.
function renderSubagentResult(result: string): string {
  const lines = result.split("\n");
  if (lines.length <= OUTPUT_LINE_LIMIT) return `<div class="chat-subagent-result markdown-body">${renderChatMarkdown(result)}</div>`;
  // Render once so a fence, list, or table crossing the visual cutoff keeps
  // its structure. The closed details element is a native state toggle; CSS
  // uses it to clip or reveal this same content rather than rendering halves.
  return `<div class="chat-subagent-result is-bounded"><div class="chat-subagent-result-content markdown-body">${renderChatMarkdown(result)}</div><details class="chat-output-more"><summary><span class="chat-report-expand">Show full report</span><span class="chat-report-collapse">Collapse report</span></summary></details></div>`;
}

function fileButton(reference: string): string {
  return `<p class="chat-tool-meta"><button type="button" data-file-ref="${escapeHtmlAttribute(reference)}">${escapeHtml(workspaceRelative(reference))}</button></p>`;
}

/**
 * Tools report absolute paths. The reference keeps the absolute form so
 * navigation still resolves; only the label is shortened to the workspace-
 * relative path, which is what the reader recognizes.
 */
export function workspaceRelative(reference: string): string {
  const normalized = reference.replaceAll("\\", "/");
  for (const root of appState.roots) {
    const rootPath = root.path.replaceAll("\\", "/").replace(/\/$/, "");
    if (rootPath && normalized.startsWith(`${rootPath}/`)) return normalized.slice(rootPath.length + 1);
  }
  return reference;
}

// `auto` marks a row the stream opened rather than the reader. It is carried in
// the DOM because that is where the next render reads the open state back from,
// and the two have to stay distinguishable there.
function activityShell(id: string, status: string, label: string, subject: string | undefined, body: string, open: boolean, auto: boolean, readerClosed: boolean, stamp: string, statusText = status): string {
  const subjectHtml = subject ? `<span class="chat-activity-subject">${escapeHtml(workspaceRelative(subject))}</span>` : "";
  // Both markers ride on the rebuilt node, because a rebuild is how this row
  // survives streaming and neither state is recoverable from the item itself.
  const markers = `${!open && auto ? " data-auto-open" : ""}${readerClosed ? ` ${READER_CLOSED}` : ""}`;
  return `<details class="chat-item chat-activity is-${status}" data-chat-item-id="${id}"${stamp}${open || auto ? " open" : ""}${markers}><summary><span>${escapeHtml(label)}</span>${subjectHtml}<span class="chat-activity-status">${escapeHtml(statusText)}</span></summary>${body}</details>`;
}

/** "Background task finished" / "failed" / "stopped", or "Background task" while it runs. */
export function backgroundTaskLabel(item: Extract<ConversationItem, { type: "background_task" }>): string {
  const noun = item.taskType === "local_agent" ? "Background agent" : item.taskType === "local_workflow" ? "Background workflow" : "Background task";
  return item.status === "completed" ? `${noun} finished` : item.status === "failed" ? `${noun} failed` : item.status === "stopped" ? `${noun} stopped` : noun;
}

/** "running · 12s" for a tool the agent reports elapsed time for, else the bare status. */
function activityStatusText(status: ActivityStatus, elapsedMs: number | undefined): string {
  if (status !== "running" || elapsedMs === undefined) return status;
  const worked = formatWorked(elapsedMs);
  return worked ? `running · ${worked}` : status;
}

// A request's state, as data rather than something CSS has to re-derive: the
// card styling, the badge, and the outstanding count all read this one value.
// "queued" is a request that will need an answer once the active one is
// resolved — calling it superseded told users to ignore work they had to
// return to.
export type RequestState = "needs-answer" | "queued" | "resolved";

export function requestState(status: "pending" | "resolved", active: boolean): RequestState {
  if (status !== "pending") return "resolved";
  return active ? "needs-answer" : "queued";
}

// Text, not only colour. A colour-only signal disappears for colour-blind
// users, in high-contrast mode, and in a greyscale screenshot — and this is
// the one signal a user must not miss.
function requestBadge(state: RequestState): string {
  if (state === "needs-answer") return `<span class="chat-request-badge">Needs your answer</span>`;
  if (state === "queued") return `<span class="chat-request-badge is-queued">Waiting its turn</span>`;
  return "";
}

function requestAttributes(state: RequestState): string {
  return ` data-request-state="${state}"`;
}

// A request surfaced from a subagent looks identical to one the conversation
// raised itself, which undercuts the reason for surfacing it: the user is being
// asked to make a decision — one that reaches their other conversations — and
// needs to know who is asking.
function requestOrigin(origin: RequestOrigin | undefined, allowSubagents: boolean): string {
  if (!origin) return "";
  if (!allowSubagents) return `<p class="chat-request-origin">Requested by a subagent of this conversation.</p>`;
  return `<p class="chat-request-origin">Requested by ${escapeHtml(origin.label)}. <button type="button" data-open-conversation="${escapeHtmlAttribute(origin.conversationId)}">Open transcript</button></p>`;
}

function renderPermission(item: Extract<ConversationItem, { type: "permission" }>, open: boolean, active: boolean, origin?: RequestOrigin, allowSubagents = true, permissionScopeNote?: string): string {
  const pending = item.status === "pending";
  // `approved-session` is the transported value and stays; "Allow always" is
  // the human-facing text, because under every agent that offers it the
  // reply carries past the single request on the card.
  // What "Allow always" actually covers is the owning agent's own statement
  // (`ChatAgent.permissionScopeNote`): OpenCode's reaches later conversations
  // until its server restarts, Claude Code's lasts one live session — two
  // different lifetimes, two different sentences, neither written here. An
  // agent that declares none gets no scope line rather than another agent's.
  // A resolved request recedes: the outcome moves into the summary so it stays
  // legible at a glance, the choices and their scope note fall away, and the
  // resources it named stay in the collapsed body for a user auditing what was
  // granted. Only a pending request keeps its full footprint.
  // Agent-provided approval intents replace the generic pair: each choice is
  // one approve button carrying its id, and Reject stays universal. The
  // always/session scope note applies only to the generic pair.
  const scope = permissionScopeNote ? `<p class="chat-request-scope">${escapeHtml(permissionScopeNote)}</p>` : "";
  const actions = item.choices?.length
    ? `<div class="chat-request-actions">${item.choices.map(choice => `<button type="button" data-permission-choice="${escapeHtmlAttribute(choice.id)}"${choice.description ? ` title="${escapeHtmlAttribute(choice.description)}"` : ""}>${escapeHtml(choice.label)}</button>`).join("")}<button type="button" data-permission-outcome="rejected">Reject</button></div>`
    : `<div class="chat-request-actions"><button type="button" data-permission-outcome="approved-once">Allow once</button><button type="button" data-permission-outcome="approved-session">Allow always</button><button type="button" data-permission-outcome="rejected">Reject</button></div>${scope}`;
  const body = pending && active
    ? actions
    : pending ? `<p class="chat-request-outcome">Waiting its turn — answer the newest request first.</p>` : "";
  const state = requestState(item.status, active);
  const summaryTrace = state === "resolved" ? ` <span class="chat-request-trace">${escapeHtml(permissionOutcomeLabel(item.outcome, item))}</span>` : requestBadge(state);
  // What "Allow" would apply, shown where the choice is made. Only while the
  // request is still open — a receded, resolved card does not re-show the diff.
  const changePreview = pending && item.diff ? `<div class="chat-request-change">${chatDiffMarkup(patchDiffLines(item.diff))}</div>` : "";
  // The plan the approval would put into effect, rendered while the request
  // is open — the user approves what they can read, not a summary line.
  const planPreview = pending && item.plan ? `<div class="chat-request-plan">${renderChatMarkdown(item.plan)}</div>` : "";
  return `<details class="chat-item chat-request" data-chat-item-id="${escapeHtmlAttribute(item.id)}"${requestAttributes(state)}${timestampAttribute(item.createdAt)}${open || pending ? " open" : ""}><summary>Permission: ${escapeHtml(item.action)}${summaryTrace}</summary>${requestOrigin(origin, allowSubagents)}<ul>${item.resources.map(resource => `<li><code>${escapeHtml(resource)}</code></li>`).join("")}</ul>${planPreview}${changePreview}${body}</details>`;
}

// The receded form's label — what was decided, in words, since the summary no
// longer sits beside the choices that produced it.
function permissionOutcomeLabel(outcome: PermissionOutcome | undefined, item?: Extract<ConversationItem, { type: "permission" }>): string {
  const chosen = item?.choiceId ? item.choices?.find(choice => choice.id === item.choiceId) : undefined;
  if (chosen) return chosen.label;
  if (outcome === "approved-once") return "Allowed once";
  if (outcome === "approved-session") return "Allowed always";
  if (outcome === "rejected") return "Rejected";
  return "Resolved";
}

function renderQuestion(item: QuestionRequest, open: boolean, active: boolean, origin?: RequestOrigin, allowSubagents = true): string {
  const pending = item.status === "pending";
  // Questions are stepped through one at a time behind a tab strip, the way
  // OpenCode's own client presents them. Stacking every question at once buries
  // the later ones and makes a partly-filled form look broken.
  const stepped = item.questions.length > 1;
  const tabs = stepped
    ? `<div class="chat-question-tabs" role="tablist">${item.questions.map((question, index) => `<button type="button" role="tab" class="chat-question-tab${index === 0 ? " is-active" : ""}" data-question-tab="${index}" aria-selected="${index === 0}">${escapeHtml(question.header)}</button>`).join("")}</div>`
    : "";
  // A checkbox and a radio read almost identically inside a styled row, so the
  // legend says which it is — otherwise there is nothing telling you more than
  // one answer is allowed.
  const questions = item.questions.map((question, index) => {
    const type = question.multiple ? "checkbox" : "radio";
    const customInputId = `question-${item.id}-${index}-custom`;
    const options = question.options.map(option => `<label class="chat-question-option"><input type="${type}" name="q-${index}" value="${escapeHtmlAttribute(option.label)}" data-question-provider-option><span class="chat-question-option-text"><span class="chat-question-option-label">${escapeHtml(option.label)}</span>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}</span></label>`).join("");
    const custom = question.allowFreeForm
      ? `<label class="chat-question-option chat-question-custom-option"><input type="${type}" name="${question.multiple ? `q-${index}-custom-choice` : `q-${index}`}" data-question-custom-toggle aria-controls="${escapeHtmlAttribute(customInputId)}" aria-expanded="false"><span class="chat-question-option-text"><span class="chat-question-option-label">Type your own answer</span></span></label><label class="chat-question-custom-editor" data-question-custom-editor for="${escapeHtmlAttribute(customInputId)}" hidden><span class="sr-only">Type your own answer</span><input id="${escapeHtmlAttribute(customInputId)}" name="q-${index}-custom-text" type="text" data-question-custom-input autocomplete="off"></label>`
      : "";
    const hints = [question.multiple ? "choose one or more" : "", question.optional ? "optional" : ""].filter(Boolean);
    return `<fieldset class="chat-question-panel" data-question-panel="${index}"${question.optional ? ` data-question-optional="true"` : ""}${index === 0 ? "" : " hidden"}><legend${stepped ? ` class="sr-only"` : ""}>${escapeHtml(question.header)}</legend><p>${escapeHtml(question.prompt)}${hints.length ? ` <span class="chat-question-hint">${escapeHtml(hints.join(" · "))}</span>` : ""}</p>${options}${custom}</fieldset>`;
  }).join("");
  // Same receding as a permission: a resolved question carries its outcome in
  // the summary and drops the answered form. Its prompts stay in the collapsed
  // body so what was asked remains reachable.
  const resolvedBody = item.questions.map(question => `<p class="chat-request-asked">${escapeHtml(question.prompt)}</p>`).join("");
  const body = pending && active ? `<form data-question-form>${tabs}${questions}<div class="chat-request-actions"><button type="submit" data-question-primary disabled>${stepped ? "Next" : "Answer"}</button><button type="button" data-question-reject>Reject</button></div></form>` : pending ? `<p class="chat-request-outcome">Waiting its turn — answer the newest request first.</p>` : resolvedBody;
  const state = requestState(item.status, active);
  const summaryTrace = state === "resolved" ? ` <span class="chat-request-trace">${item.outcome?.kind === "rejected" ? "Rejected" : "Answered"}</span>` : requestBadge(state);
  // A dialog or elicitation says who is asking above the form, offers the
  // link it wants opened as a real link, and keeps the request as received
  // behind a collapsed "Raw request" for a reader auditing what an MCP
  // server or a tool asked for.
  const heading = item.source === "dialog" ? "Dialog" : item.source === "elicitation" ? "Input requested" : "Question";
  const intro = item.intro ? `<p class="chat-request-intro">${escapeHtml(item.intro)}</p>` : "";
  const link = item.link ? `<p class="chat-request-link"><a href="${escapeHtmlAttribute(item.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.link)}</a></p>` : "";
  const raw = item.schema && pending ? `<details class="chat-request-raw"><summary>Raw request</summary><pre>${escapeHtml(JSON.stringify(item.schema, null, 1))}</pre></details>` : "";
  return `<details class="chat-item chat-request" data-chat-item-id="${escapeHtmlAttribute(item.id)}"${requestAttributes(state)}${timestampAttribute(item.createdAt)}${open || pending ? " open" : ""}${item.source ? ` data-question-source="${escapeHtmlAttribute(item.source)}"` : ""}><summary>${heading}${summaryTrace}</summary>${requestOrigin(origin, allowSubagents)}${intro}${link}${body}${raw}</details>`;
}

export function decorateFileLinks(container: HTMLElement): void {
  for (const anchor of container.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    let candidate: string;
    try { candidate = decodeURIComponent(anchor.getAttribute("href") ?? "").replace(/^\.\//, ""); }
    catch { continue; }
    const reference = resolveWorkspaceFileReference(candidate, appState.roots);
    if (!reference) continue;
    anchor.removeAttribute("href");
    anchor.removeAttribute("target");
    anchor.removeAttribute("rel");
    anchor.setAttribute("role", "button");
    anchor.tabIndex = 0;
    anchor.dataset.fileRef = candidate;
  }
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest("a, button, code, pre, textarea")) textNodes.push(node);
  }
  const pattern = /(?:\/|\.\/)?[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)+(?::\d+)?/g;
  for (const node of textNodes) {
    const text = node.data;
    const matches = [...text.matchAll(pattern)].filter(match => resolveWorkspaceFileReference(match[0], appState.roots));
    if (matches.length === 0) continue;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of matches) {
      fragment.append(text.slice(offset, match.index));
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chat-inline-file-ref";
      button.dataset.fileRef = match[0];
      // Label with the workspace-relative path (the reference keeps the
      // absolute form so navigation still resolves), matching fileButton.
      // An absolute path as link text overruns a phone-width line on its own.
      button.textContent = workspaceRelative(match[0]);
      button.title = match[0];
      fragment.append(button);
      offset = match.index! + match[0].length;
    }
    fragment.append(text.slice(offset));
    node.replaceWith(fragment);
  }
}

/** "Context compacted · 180,000 → 40,000 tokens", or as much as was reported. */
export function compactionLabel(item: Extract<ConversationItem, { type: "compaction" }>): string {
  const figures = item.preTokens !== undefined && item.postTokens !== undefined
    ? `${item.preTokens.toLocaleString()} → ${item.postTokens.toLocaleString()} tokens`
    : item.postTokens !== undefined
      ? `now ${item.postTokens.toLocaleString()} tokens`
      : item.preTokens !== undefined
        ? `was ${item.preTokens.toLocaleString()} tokens`
        : "";
  const trigger = item.trigger === "manual" ? "Context compacted on request" : "Context compacted";
  return figures ? `${trigger} · ${figures}` : trigger;
}

export function statusLabel(status: ConversationStatus): string {
  return ({ idle: "Ready", sending: "Sending", running: "Working", completed: "Completed", interrupted: "Cancelled", failed: "Failed", background: "Background work running", retrying: "Retrying", compacting: "Compacting context" })[status];
}

function counts(additions?: number, deletions?: number): string {
  return additions === undefined && deletions === undefined ? "" : ` <span class="chat-change-counts">+${additions ?? 0} -${deletions ?? 0}</span>`;
}

function timestampAttribute(createdAt: number): string {
  if (!createdAt) return "";
  return ` title="${escapeHtmlAttribute(new Date(createdAt).toLocaleString())}"`;
}
