import { boundedSet } from "../shared/bounded-map";
import { backgroundTasksByTool } from "./background-tasks";
import { subagentEntries } from "./timeline-renderer";
import type { BackgroundTaskItem, ConversationItem } from "./types";
import { workerIsActive, workerState, type WorkerState } from "./worker-state";
import { totalTokens } from "./usage";

type DisclosureState = { open: boolean; active: boolean; collapsed: boolean };
type DisclosureMode = "touch" | "desktop";

/** Page-local conversation choices; desktop opens new batches, touch never does. */
export class CompactDisclosure {
  private readonly choices = new Map<string, Record<DisclosureMode, DisclosureState>>();
  private conversation: string | null = null;
  private mode: DisclosureMode = "touch";
  private open = false;

  paint(conversation: string | null, activeCount = 0, mode: DisclosureMode = "touch", actualOpen?: boolean): boolean {
    // Native details.toggle is deferred. Observe a human click before repaint
    // can overwrite it; a delayed echo of our last write matches known open.
    if (actualOpen !== undefined) this.toggled(actualOpen);
    // A refresh's temporary null selection is not the batch ending.
    if (conversation === null) return this.open;
    let states = this.choices.get(conversation);
    if (!states) {
      const closed = (): DisclosureState => ({ open: false, active: false, collapsed: false });
      states = { desktop: closed(), touch: closed() };
    }
    boundedSet(this.choices, conversation, states, 200);
    const desktop = states.desktop;
    const active = activeCount > 0;
    const enteringDesktop = mode === "desktop" && (this.mode !== mode || this.conversation !== conversation);
    if (mode === "desktop" && active && (!desktop.active || enteringDesktop) && !desktop.collapsed) desktop.open = true;
    if (!active) desktop.collapsed = false;
    desktop.active = active;
    this.conversation = conversation;
    this.mode = mode;
    this.open = states[mode].open;
    return this.open;
  }

  toggled(open: boolean): void {
    if (open === this.open) return; // includes delayed echoes of our own writes
    this.open = open;
    const state = this.conversation && this.choices.get(this.conversation)?.[this.mode];
    if (state) {
      state.open = open;
      state.collapsed = !open && state.active;
    }
  }
}

export type CompactWorker = {
  id: string;
  state: WorkerState;
  references: string[];
  name: string;
  kind: "agent" | "shell";
  agent?: string;
  since: number;
  // Sort clock: execution completion, terminal report, duration, or launch.
  settledAt: number;
  // Preserve terminal-clock provenance even when it equals launch (or zero).
  completedAt?: number;
  terminalReportedAt?: number;
  progress?: string;
  taskId?: string;
  stoppable?: boolean;
  conversationId?: string;
  model?: string;
  tokens?: number;
  effort?: string | null;
  costUsd?: number | null;
};

/** A projection fold, not another worker lifecycle or a task-id tombstone map. */
export function compactWorkers(items: readonly ConversationItem[]): CompactWorker[] {
  const shellTask = (type?: string) => /^(shell|local_bash|bash)$/i.test(type ?? "");
  // Launcher lookup uses the first match; session metadata uses the last
  // restatement. Keep both readings when a timeline contains duplicate ids.
  const itemsById = new Map<string, { first: ConversationItem; last: ConversationItem }>();
  const latestTasks = new Map<string, BackgroundTaskItem>();
  for (const item of items) {
    const known = itemsById.get(item.id);
    if (known) known.last = item;
    else itemsById.set(item.id, { first: item, last: item });
    if (item.type !== "background_task") continue;
    const latest = latestTasks.get(item.taskId);
    // Match taskById's newest occurrence and descending-id tie-break,
    // including foreground tasks which are not independently stoppable.
    if (!latest || (latest.createdAt - item.createdAt || latest.id.localeCompare(item.id)) < 0) latestTasks.set(item.taskId, item);
  }
  const aliases = backgroundTasksByTool(items);
  const workers = new Map<string, CompactWorker>();
  for (const item of items) {
    if (item.type !== "background_task") continue;
    if (item.foreground && shellTask(item.taskType)) continue;
    const terminalReportedAt = item.terminalReportedAt !== undefined && Number.isFinite(item.terminalReportedAt) && item.terminalReportedAt >= 0 ? item.terminalReportedAt : undefined;
    // A provisional result has a row timestamp, not a known launch. In
    // particular its local display fallback must not become a worker clock.
    const since = item.resultId && !item.toolUseId && !item.toolUseIds?.length ? 0 : item.createdAt;
    workers.set(item.id, {
      id: item.id, state: workerState(item.status, item.stateUncertain), references: [],
      name: item.description, kind: shellTask(item.taskType) ? "shell" : "agent", agent: item.subagentType,
      since, settledAt: terminalReportedAt ?? since + (item.usage?.durationMs ?? 0), terminalReportedAt,
      progress: item.progress, taskId: item.taskId, stoppable: !item.foreground && latestTasks.get(item.taskId)?.id === item.id, conversationId: item.childConversationId,
      tokens: item.usage?.totalTokens,
    });
  }
  for (const entry of subagentEntries(items)) {
    // Only proven launcher aliases can merge occurrences. A child can run
    // repeatedly, so a shared child id alone is not a deduplication key.
    if (workers.has(entry.id)) continue;
    const item = itemsById.get(entry.id)?.first;
    if (item?.type === "background_task" && shellTask(item.taskType) && item.foreground) continue;
    const canonical = aliases.get(entry.id);
    if (canonical) {
      const worker = workers.get(canonical.id);
      if (worker) {
        worker.references.push(entry.id);
        worker.model ??= entry.model;
        worker.agent ??= entry.subagent;
        // One occurrence's reported spend, not a sum of launcher aliases.
        worker.tokens ??= entry.usage ? totalTokens(entry.usage) : undefined;
      }
      continue;
    }
    const completedAt = item?.type === "tool" ? item.completedAt : undefined;
    workers.set(entry.id, {
      id: entry.id, state: workerState(entry.status), references: [entry.id],
      name: entry.description, kind: "agent", agent: entry.subagent, since: item?.createdAt ?? 0,
      settledAt: completedAt ?? item?.createdAt ?? 0, completedAt, progress: entry.progress, conversationId: entry.conversationId,
      model: entry.model, tokens: entry.usage ? totalTokens(entry.usage) : undefined,
    });
  }
  for (const worker of workers.values()) {
    if (worker.kind !== "agent") continue;
    const report = [worker.id, ...worker.references].map(id => itemsById.get(id)?.last)
      .find(item => (item?.type === "tool" || item?.type === "background_task") && item.workerSession);
    if (report?.type === "tool" || report?.type === "background_task") {
      worker.model = report.workerSession?.model;
      worker.effort = report.workerSession?.effort;
      worker.costUsd = report.workerSession?.costUsd;
    }
  }
  return [...workers.values()].sort((a, b) => {
    const rank = (worker: CompactWorker) => worker.state === "working" ? 0 : worker.state === "unknown" ? 1 : 2;
    return rank(a) - rank(b) || (workerIsActive(a.state) ? a.since - b.since : b.settledAt - a.settledAt) || a.id.localeCompare(b.id);
  });
}

export function workerSummary(workers: readonly CompactWorker[]): string {
  const count = (state: CompactWorker["state"]) => workers.filter(worker => worker.state === state).length;
  const working = count("working");
  const unknown = count("unknown");
  const finished = workers.filter(worker => !workerIsActive(worker.state)).length;
  return [working && `${working} working`, finished && `${finished} finished`, unknown && `${unknown} unknown`].filter(Boolean).join(" · ") || "No workers";
}
