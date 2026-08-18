import { escapeHtml, escapeHtmlAttribute } from "../shared/html";
import { appState } from "../shell/state";
import { renderChatMarkdown } from "./markdown";
import { resolveWorkspaceFileReference } from "./file-references";
import { describeToolDetail, deriveTodoActivities, patchDiffLines, todoActivitySummary, toolSubject, type DiffLine, type TodoEntry, type TodoSummary, type ToolDetail } from "./tool-detail";
import type { AcceptedDraft, ChatProjection } from "./projection";
import type { ConversationItem, ConversationStatus, PermissionOutcome, QuestionRequest, ToolItem } from "./types";

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
  render(target: HTMLElement, projection: ChatProjection | null, expanded: Set<string>, queued: ReadonlySet<string> = new Set()): HTMLElement[] {
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

    const nodes = new Map<string, HTMLElement>();
    for (const item of projection.items) {
      const active = activeRequests.has(item.id);
      const todo = todoLabels.get(item.id);
      const isQueued = queued.has(item.id);
      const duration = durations.get(item.id);
      // Everything outside the item itself that changes its markup, so a
      // cached node is only reused when it would render identically.
      const foreign = (item.type === "permission" || item.type === "question")
        && item.conversationId !== undefined && item.conversationId !== projection.conversationId;
      const variant = [todo?.label ?? "", todo?.task ?? "", String(isQueued), duration === undefined ? "" : String(duration), String(foreign)].join("\u0001");
      const entry = this.entries.get(item.id);
      if (entry && entry.item === item && entry.active === active && entry.variant === variant) {
        nodes.set(item.id, entry.node);
        continue;
      }
      if (entry && entry.active === active && entry.variant === variant && patchInPlace(entry, item)) {
        nodes.set(item.id, entry.node);
        dirty.push(entry.node);
        continue;
      }
      // A request does not take its open state from `expanded`: a pending one
      // is force-open (below), and force-opening it fires a toggle that records
      // it as "expanded" — so honouring that set would keep it open once it
      // resolves and defeat the receding. Instead a pending request opens and a
      // resolved one starts closed; a resolved card the user opens by hand stays
      // open because a stable item is patched in place, never rebuilt. Every
      // other item preserves its DOM open state across re-renders as before.
      const isRequest = item.type === "permission" || item.type === "question";
      const open = isRequest ? false : entry ? entry.node.hasAttribute("open") : expanded.has(item.id);
      const node = buildNode(renderItem(item, open, active, todo, isQueued, duration, foreign));
      entry?.node.remove();
      this.entries.set(item.id, { node, item, active, variant });
      nodes.set(item.id, node);
      dirty.push(node);
    }

    // Assemble the top level: finished runs of activity rows collapse behind
    // one group line; everything else stays flat. Member nodes keep their
    // per-item identity — grouping only changes where they are parented.
    const liveGroupIds = new Set<string>();
    for (const segment of activitySegments(projection.items, projection.status)) {
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

export type SubagentEntry = { id: string; description: string; subagent?: string; status: ConversationStatus | string; conversationId?: string };

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
function patchInPlace(entry: RenderedEntry, item: ConversationItem): boolean {
  const current = entry.item;
  if (current.type !== item.type) return false;
  if (item.type === "assistant_message" && current.type === "assistant_message") {
    if (current.markdown !== item.markdown) entry.node.innerHTML = renderChatMarkdown(item.markdown);
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

export function renderItem(item: ConversationItem, open: boolean, activeRequest: boolean, todo?: TodoSummary, queued = false, durationMs?: number, foreign = false): string {
  const id = escapeHtmlAttribute(item.id);
  const stamp = timestampAttribute(item.createdAt);
  // A message sent mid-turn is accepted but not yet acted on. Without a mark
  // it looks identical to one the agent has already read.
  if (item.type === "user_message") return `<article class="chat-item chat-user-message${queued ? " is-queued" : ""}" data-chat-item-id="${id}"${stamp}><div>${escapeHtml(item.text)}</div>${queued ? `<small class="chat-queued-tag">Queued — the agent is still working</small>` : ""}</article>`;
  if (item.type === "assistant_message") return `<article class="chat-item chat-assistant-message markdown-body" data-chat-item-id="${id}"${stamp}>${renderChatMarkdown(item.markdown)}</article>`;
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
  if (item.type === "tool") return renderTool(item, open, todo);
  // A command's text is the subject, not the label. As a label it lands in the
  // summary's non-shrinking slot, so a long pipeline overruns the row instead
  // of truncating; "Shell" names the step and the command ellipsizes beside it.
  if (item.type === "command") {
    return activityShell(id, item.status, "Shell", item.command, `<pre>${escapeHtml(item.output ?? "")}</pre>`, open, stamp);
  }
  return activityShell(id, item.status, reasoningLabel(item), undefined, `<pre>${escapeHtml(item.text)}</pre>`, open, stamp);
}

function renderTool(item: ToolItem, open: boolean, todo?: TodoSummary): string {
  const detail = describeToolDetail(item);
  const body = toolBody(detail, item);
  // A todo update stays collapsed, but its summary reports what moved and to
  // which task — every todowrite call carries the whole list, so showing the
  // list each time reprints it verbatim on every tool call.
  const label = detail.kind === "todo" && todo ? todo.label : detail.label;
  const subject = detail.kind === "todo" ? todo?.task : toolSubject(detail);
  return activityShell(escapeHtmlAttribute(item.id), item.status, label, subject, body, open, timestampAttribute(item.createdAt));
}

// One rendering for every diff the chat shows — a tool's edit, a patch, and a
// permission's pending change all read the same way.
function chatDiffMarkup(diff: DiffLine[]): string {
  return `<pre class="chat-diff">${diff.map(line => `<span class="chat-diff-line is-${line.sign === "-" ? "del" : "add"}">${escapeHtml(`${line.sign} ${line.text}`)}</span>`).join("\n")}</pre>`;
}

function toolBody(detail: ToolDetail, item: ToolItem): string {
  const error = item.error ? `<pre class="chat-tool-error">${escapeHtml(item.error)}</pre>` : "";
  switch (detail.kind) {
    case "edit":
      return `${fileButton(detail.path)}${chatDiffMarkup(detail.diff)}${error}`;
    case "write":
      return `${fileButton(detail.path)}<pre>${escapeHtml(detail.content)}</pre>${error}`;
    case "read":
      return `${fileButton(detail.startLine ? `${detail.path}:${detail.startLine}` : detail.path)}${outputBlock(item)}${error}`;
    case "search":
      return `<p class="chat-tool-meta"><code>${escapeHtml(detail.query)}</code>${detail.where ? ` in <code>${escapeHtml(detail.where)}</code>` : ""}</p>${outputBlock(item)}${error}`;
    case "fetch":
      return `<p class="chat-tool-meta"><code>${escapeHtml(detail.url)}</code></p>${outputBlock(item)}${error}`;
    case "todo":
      return `<ul class="chat-todo">${detail.entries.map(entry => `<li class="is-${entry.state}">${escapeHtml(entry.text)}</li>`).join("")}</ul>${error}`;
    case "patch":
      return `${detail.files.map(file => fileButton(file)).join("")}${chatDiffMarkup(detail.diff)}${error}`;
    case "question":
      return `${detail.asked.map(entry => `<p class="chat-tool-meta"><strong>${escapeHtml(entry.header)}</strong></p><p>${escapeHtml(entry.prompt)}</p>`).join("")}${detail.answer ? `<p class="chat-request-outcome">${escapeHtml(detail.answer)}</p>` : ""}${error}`;
    case "agent":
      // The result is the subagent's report — prose, rendered like assistant
      // markdown rather than dumped as the raw task envelope.
      return `<p class="chat-tool-meta">${detail.subagent ? `<code>${escapeHtml(detail.subagent)}</code> ` : ""}${escapeHtml(detail.description)}${detail.conversationId ? ` <button type="button" data-open-conversation="${escapeHtmlAttribute(detail.conversationId)}">Open transcript</button>` : ""}</p><pre>${escapeHtml(detail.prompt)}</pre>${detail.result ? `<div class="chat-subagent-result markdown-body">${renderChatMarkdown(detail.result)}</div>` : ""}${error}`;
    case "skill":
      return `${outputBlock(item)}${error}`;
    default:
      return `<pre>${escapeHtml([item.input, item.output, item.error].filter(Boolean).join("\n\n"))}</pre>`;
  }
}

function outputBlock(item: ToolItem): string {
  return item.output ? `<pre>${escapeHtml(item.output)}</pre>` : "";
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

function activityShell(id: string, status: string, label: string, subject: string | undefined, body: string, open: boolean, stamp: string): string {
  const subjectHtml = subject ? `<span class="chat-activity-subject">${escapeHtml(workspaceRelative(subject))}</span>` : "";
  return `<details class="chat-item chat-activity is-${status}" data-chat-item-id="${id}"${stamp}${open ? " open" : ""}><summary><span>${escapeHtml(label)}</span>${subjectHtml}<span class="chat-activity-status">${escapeHtml(status)}</span></summary>${body}</details>`;
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
  const questions = item.questions.map((question, index) => `<fieldset class="chat-question-panel" data-question-panel="${index}"${index === 0 ? "" : " hidden"}><legend${stepped ? ` class="sr-only"` : ""}>${escapeHtml(question.header)}</legend><p>${escapeHtml(question.prompt)}${question.multiple ? ` <span class="chat-question-hint">choose one or more</span>` : ""}</p>${question.options.map(option => `<label class="chat-question-option"><input type="${question.multiple ? "checkbox" : "radio"}" name="q-${index}" value="${escapeHtmlAttribute(option.label)}"><span class="chat-question-option-text"><span class="chat-question-option-label">${escapeHtml(option.label)}</span>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}</span></label>`).join("")}${question.allowFreeForm ? `<label class="chat-question-freeform">Other <input name="q-${index}" type="text"></label>` : ""}</fieldset>`).join("");
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
