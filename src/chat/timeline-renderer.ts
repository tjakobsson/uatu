import { escapeHtml, escapeHtmlAttribute } from "../shared/html";
import { appState } from "../shell/state";
import { renderChatMarkdown } from "./markdown";
import { resolveWorkspaceFileReference } from "./file-references";
import { describeToolDetail, deriveTodoActivities, patchDiffLines, todoActivitySummary, toolSubject, type DiffLine, type TodoEntry, type TodoSummary, type ToolDetail } from "./tool-detail";
import type { AcceptedDraft, ChatProjection } from "./projection";
import type { ActivityStatus, ConversationItem, ConversationStatus, PermissionOutcome, QuestionRequest, TokenUsage, ToolItem } from "./types";

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
  render(target: HTMLElement, projection: ChatProjection | null, expanded: Set<string>, queued: ReadonlySet<string> = new Set(), allowSubagents = true): HTMLElement[] {
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

    // An assistant message with no text is data, not a bubble: the usage
    // carrier for a tool-only message (`usage:<id>` from normalization) and a
    // part the stream has not filled yet both hold facts the readouts consume
    // while having nothing to show. Filtered before rendering AND before
    // grouping, so a carrier sitting between two tool calls cannot split a
    // finished run's group.
    const visible = projection.items.filter(item => !(item.type === "assistant_message" && item.markdown === ""));

    const nodes = new Map<string, HTMLElement>();
    for (const [visibleIndex, item] of visible.entries()) {
      const active = activeRequests.has(item.id);
      const todo = todoLabels.get(item.id);
      const isQueued = queued.has(item.id);
      const duration = durations.get(item.id);
      // Everything outside the item itself that changes its markup, so a
      // cached node is only reused when it would render identically.
      const foreign = (item.type === "permission" || item.type === "question")
        && item.conversationId !== undefined && item.conversationId !== projection.conversationId;
      const entry = this.entries.get(item.id);
      // Completion is monotonic for an item. A new turn makes the conversation
      // active again, but must not revoke copy actions from an answer that was
      // already observed in a terminal state. A steer never reaches that state,
      // so its still-streaming assistant remains incomplete.
      const completedAssistant = item.type === "assistant_message"
        && (entry?.node.dataset.complete === "true" || assistantMessageComplete(visible, visibleIndex, projection.status));
      const variant = [todo?.label ?? "", todo?.task ?? "", String(isQueued), duration === undefined ? "" : String(duration), String(foreign), String(allowSubagents), String(completedAssistant)].join("\u0001");
      if (entry && entry.item === item && entry.active === active && entry.variant === variant) {
        nodes.set(item.id, entry.node);
        continue;
      }
      if (entry && entry.active === active && patchInPlace(entry, item, completedAssistant)) {
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
      const node = buildNode(renderItem(item, open, active, todo, isQueued, duration, foreign, readerClosed, allowSubagents, completedAssistant));
      if (completedAssistant) decorateAssistantCopyActions(node);
      entry?.node.remove();
      this.entries.set(item.id, { node, item, active, variant });
      nodes.set(item.id, node);
      dirty.push(node);
    }

    // Assemble the top level: finished runs of activity rows collapse behind
    // one group line; everything else stays flat. Member nodes keep their
    // per-item identity — grouping only changes where they are parented.
    const liveGroupIds = new Set<string>();
    for (const segment of activitySegments(visible, projection.status)) {
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
        groupNode = buildNode(`<details class="chat-item chat-activity-group" data-chat-item-id="${escapeHtmlAttribute(segment.group.id)}"${expanded.has(segment.group.id) ? " open" : ""}><summary><span class="chat-group-count"></span><span class="chat-activity-subject"></span></summary><div class="chat-group-items"></div></details>`);
        this.groupEntries.set(segment.group.id, groupNode);
        dirty.push(groupNode);
      }
      const count = groupNode.querySelector(".chat-group-count");
      if (count) count.textContent = `${segment.items.length} steps`;
      const subject = groupNode.querySelector(".chat-activity-subject");
      if (subject) subject.textContent = segment.group.summary;
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

type TimelineSegment = {
  group: { id: string; summary: string } | null;
  items: ConversationItem[];
};

const GROUP_MIN = 3;

/**
 * Splits the timeline into flat items and groupable runs. A run of
 * consecutive activity rows (tool, command, reasoning) collapses behind one
 * group line when it is long enough and every member has finished — with one
 * exception: the trailing run of a still-running turn stays flat, because
 * that is the work the reader is watching happen.
 */
function activitySegments(items: readonly ConversationItem[], status: ConversationStatus): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  let run: ConversationItem[] = [];
  const flushRun = (isTail: boolean) => {
    if (run.length === 0) return;
    const finished = run.every(item => "status" in item && item.status !== "running" && item.status !== "pending");
    const live = isTail && (status === "running" || status === "sending");
    segments.push(run.length >= GROUP_MIN && finished && !live
      ? { group: { id: `group:${run[0]!.id}`, summary: groupSummary(run) }, items: run }
      : { group: null, items: run });
    run = [];
  };
  for (const item of items) {
    if (item.type === "tool" || item.type === "command" || item.type === "reasoning") {
      run.push(item);
      continue;
    }
    flushRun(false);
    segments.push({ group: null, items: [item] });
  }
  flushRun(true);
  return segments;
}

function groupSummary(run: readonly ConversationItem[]): string {
  const counts = new Map<string, number>();
  for (const item of run) {
    // Grouped reasoning stays "Thought" without a duration: the group line
    // counts kinds of steps, and per-entry timings belong on the entries.
    const label = item.type === "command" ? "Shell" : item.type === "reasoning" ? (item.status === "completed" ? "Thought" : "Thinking") : item.type === "tool" ? describeToolDetail(item).label : item.type;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => count > 1 ? `${label} ×${count}` : label).join(" · ");
}

/** "Thinking" while it streams; "Thought for 12s" (or just "Thought") after. */
export function reasoningLabel(item: Extract<ConversationItem, { type: "reasoning" }>): string {
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

function renderDraft(draft: AcceptedDraft): string {
  const label = draft.messageId.startsWith("pending:") ? "Sending…" : "Delivered, waiting for agent history";
  return `<article class="chat-item chat-user-message is-pending" data-chat-item-id="draft-${escapeHtmlAttribute(draft.requestId)}"><p>${escapeHtml(draft.text)}</p><small>${label}</small></article>`;
}

export function renderItem(item: ConversationItem, open: boolean, activeRequest: boolean, todo?: TodoSummary, queued = false, durationMs?: number, foreign = false, readerClosed = false, allowSubagents = true, completedAssistant = false): string {
  const id = escapeHtmlAttribute(item.id);
  const stamp = timestampAttribute(item.createdAt);
  // A message sent mid-turn is accepted but not yet acted on. Without a mark
  // it looks identical to one the agent has already read.
  if (item.type === "user_message") return `<article class="chat-item chat-user-message${queued ? " is-queued" : ""}" data-chat-item-id="${id}"${stamp}><div>${escapeHtml(item.text)}</div>${queued ? `<small class="chat-queued-tag">Queued — the agent is still working</small>` : ""}</article>`;
  if (item.type === "assistant_message") return `<article class="chat-item chat-assistant-message" data-chat-item-id="${id}" data-complete="${completedAssistant}"${stamp}><div class="chat-assistant-content markdown-body">${renderChatMarkdown(item.markdown)}</div></article>`;
  if (item.type === "turn_status") {
    const worked = durationMs === undefined ? "" : formatWorked(durationMs);
    return `<footer class="chat-item chat-turn-status is-${item.status}" data-chat-item-id="${id}"${stamp} role="status">${escapeHtml(statusLabel(item.status))}${item.message ? `: ${escapeHtml(item.message)}` : ""}${worked ? ` <span class="chat-turn-worked">· worked ${worked}</span>` : ""}</footer>`;
  }
  if (item.type === "notice") return `<aside class="chat-item chat-notice is-${item.level}" data-chat-item-id="${id}"${stamp} role="${item.level === "error" ? "alert" : "status"}">${escapeHtml(item.message)}</aside>`;
  if (item.type === "file_change") {
    return `<article class="chat-item chat-file-change" data-chat-item-id="${id}"${stamp}><span>${escapeHtml(item.operation)}</span> <button type="button" data-file-ref="${escapeHtmlAttribute(item.path)}">${escapeHtml(item.path)}</button>${counts(item.additions, item.deletions)}</article>`;
  }
  if (item.type === "permission") return renderPermission(item, open, activeRequest, foreign);
  if (item.type === "question") return renderQuestion(item, open, activeRequest, foreign);
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
  return status !== "sending" && status !== "running";
}

export function decorateAssistantCopyActions(container: HTMLElement): void {
  const article = container.matches(".chat-assistant-message")
    ? container
    : container.querySelector<HTMLElement>(".chat-assistant-message");
  if (!article || article.dataset.complete !== "true") return;
  const content = article.querySelector<HTMLElement>(".chat-assistant-content");
  if (!content) return;
  if (!article.querySelector(":scope > .chat-answer-actions > [data-chat-copy='answer']")) {
    let actions = article.querySelector<HTMLElement>(":scope > .chat-answer-actions");
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "chat-answer-actions";
      article.append(actions);
    }
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "chat-copy-action chat-answer-copy";
    copy.dataset.chatCopy = "answer";
    copy.setAttribute("aria-label", "Copy completed answer");
    copy.title = "Copy completed answer";
    actions.append(copy);
  }
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
  return activityShell(escapeHtmlAttribute(item.id), item.status, label, subject, body, open, autoOpen(item.status, item.output) && !readerClosed, readerClosed, timestampAttribute(item.createdAt));
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
function activityShell(id: string, status: string, label: string, subject: string | undefined, body: string, open: boolean, auto: boolean, readerClosed: boolean, stamp: string): string {
  const subjectHtml = subject ? `<span class="chat-activity-subject">${escapeHtml(workspaceRelative(subject))}</span>` : "";
  // Both markers ride on the rebuilt node, because a rebuild is how this row
  // survives streaming and neither state is recoverable from the item itself.
  const markers = `${!open && auto ? " data-auto-open" : ""}${readerClosed ? ` ${READER_CLOSED}` : ""}`;
  return `<details class="chat-item chat-activity is-${status}" data-chat-item-id="${id}"${stamp}${open || auto ? " open" : ""}${markers}><summary><span>${escapeHtml(label)}</span>${subjectHtml}<span class="chat-activity-status">${escapeHtml(status)}</span></summary>${body}</details>`;
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
function requestOrigin(foreign: boolean): string {
  return foreign ? `<p class="chat-request-origin">Requested by a subagent of this conversation.</p>` : "";
}

function renderPermission(item: Extract<ConversationItem, { type: "permission" }>, open: boolean, active: boolean, foreign = false): string {
  const pending = item.status === "pending";
  // `approved-session` is the transported value and stays. Verified against a
  // live OpenCode 1.18.18: this reply carries past the request into every later
  // conversation the same OpenCode server handles, and is lost when that server
  // restarts (it never reaches `/api/permission/saved`). It also grants the
  // request's `always` pattern — `echo *` for a literal `echo scoped` — so it
  // covers more than the resource on the card. "Allow session" implied one
  // conversation; the card now states the reach that was actually being given.
  // "OpenCode" is named on purpose in the scope line below and is not
  // neutralized like the rest of the agent copy: the sentence states
  // OpenCode's own persistent-approval lifetime (see the opencode-chat
  // permission spec), which is agent-specific behavior, not just an agent
  // name. A second agent that persists grants differently needs its own
  // statement here, not a find-and-replace.
  // A resolved request recedes: the outcome moves into the summary so it stays
  // legible at a glance, the choices and their scope note fall away, and the
  // resources it named stay in the collapsed body for a user auditing what was
  // granted. Only a pending request keeps its full footprint.
  const body = pending && active
    ? `<div class="chat-request-actions"><button type="button" data-permission-outcome="approved-once">Allow once</button><button type="button" data-permission-outcome="approved-session">Allow always</button><button type="button" data-permission-outcome="rejected">Reject</button></div><p class="chat-request-scope">“Allow always” also covers later conversations, and similar requests — until OpenCode restarts.</p>`
    : pending ? `<p class="chat-request-outcome">Waiting its turn — answer the newest request first.</p>` : "";
  const state = requestState(item.status, active);
  const summaryTrace = state === "resolved" ? ` <span class="chat-request-trace">${escapeHtml(permissionOutcomeLabel(item.outcome))}</span>` : requestBadge(state);
  // What "Allow" would apply, shown where the choice is made. Only while the
  // request is still open — a receded, resolved card does not re-show the diff.
  const changePreview = pending && item.diff ? `<div class="chat-request-change">${chatDiffMarkup(patchDiffLines(item.diff))}</div>` : "";
  return `<details class="chat-item chat-request" data-chat-item-id="${escapeHtmlAttribute(item.id)}"${requestAttributes(state)}${timestampAttribute(item.createdAt)}${open || pending ? " open" : ""}><summary>Permission: ${escapeHtml(item.action)}${summaryTrace}</summary>${requestOrigin(foreign)}<ul>${item.resources.map(resource => `<li><code>${escapeHtml(resource)}</code></li>`).join("")}</ul>${changePreview}${body}</details>`;
}

// The receded form's label — what was decided, in words, since the summary no
// longer sits beside the choices that produced it.
function permissionOutcomeLabel(outcome: PermissionOutcome | undefined): string {
  if (outcome === "approved-once") return "Allowed once";
  if (outcome === "approved-session") return "Allowed always";
  if (outcome === "rejected") return "Rejected";
  return "Resolved";
}

function renderQuestion(item: QuestionRequest, open: boolean, active: boolean, foreign = false): string {
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
    return `<fieldset class="chat-question-panel" data-question-panel="${index}"${index === 0 ? "" : " hidden"}><legend${stepped ? ` class="sr-only"` : ""}>${escapeHtml(question.header)}</legend><p>${escapeHtml(question.prompt)}${question.multiple ? ` <span class="chat-question-hint">choose one or more</span>` : ""}</p>${options}${custom}</fieldset>`;
  }).join("");
  // Same receding as a permission: a resolved question carries its outcome in
  // the summary and drops the answered form. Its prompts stay in the collapsed
  // body so what was asked remains reachable.
  const resolvedBody = item.questions.map(question => `<p class="chat-request-asked">${escapeHtml(question.prompt)}</p>`).join("");
  const body = pending && active ? `<form data-question-form>${tabs}${questions}<div class="chat-request-actions"><button type="submit" data-question-primary disabled>${stepped ? "Next" : "Answer"}</button><button type="button" data-question-reject>Reject</button></div></form>` : pending ? `<p class="chat-request-outcome">Waiting its turn — answer the newest request first.</p>` : resolvedBody;
  const state = requestState(item.status, active);
  const summaryTrace = state === "resolved" ? ` <span class="chat-request-trace">${item.outcome?.kind === "rejected" ? "Rejected" : "Answered"}</span>` : requestBadge(state);
  return `<details class="chat-item chat-request" data-chat-item-id="${escapeHtmlAttribute(item.id)}"${requestAttributes(state)}${timestampAttribute(item.createdAt)}${open || pending ? " open" : ""}><summary>Question${summaryTrace}</summary>${requestOrigin(foreign)}${body}</details>`;
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

export function statusLabel(status: ConversationStatus): string {
  return ({ idle: "Ready", sending: "Sending", running: "Working", completed: "Completed", interrupted: "Cancelled", failed: "Failed" })[status];
}

function counts(additions?: number, deletions?: number): string {
  return additions === undefined && deletions === undefined ? "" : ` <span class="chat-change-counts">+${additions ?? 0} -${deletions ?? 0}</span>`;
}

function timestampAttribute(createdAt: number): string {
  if (!createdAt) return "";
  return ` title="${escapeHtmlAttribute(new Date(createdAt).toLocaleString())}"`;
}
