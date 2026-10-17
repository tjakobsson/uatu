import { boundedSet } from "../shared/bounded-map";
import { backgroundTasksByTool } from "./background-tasks";
import { subagentEntries } from "./timeline-renderer";
import type { ConversationItem } from "./types";
import { workerIsActive, workerState, type WorkerState } from "./worker-state";
import { taskById } from "./task-inspection";
import { totalTokens } from "./usage";

/** Deliberate touch state, independent of the desktop automatic disclosure. */
export class CompactDisclosure {
  private readonly choices = new Map<string, boolean>();
  private conversation: string | null = null;
  private open = false;

  paint(conversation: string | null): boolean {
    if (conversation !== null) {
      this.conversation = conversation;
      this.open = this.choices.get(conversation) ?? false;
    }
    return this.open;
  }

  toggled(open: boolean): void {
    if (open === this.open) return; // includes delayed echoes of our own writes
    this.open = open;
    if (this.conversation) boundedSet(this.choices, this.conversation, open, 200);
  }
}

export type CompactWorker = {
  id: string;
  state: WorkerState;
  references: string[];
  name: string;
  kind: "agent" | "shell";
  since: number;
  settledAt: number;
  progress?: string;
  taskId?: string;
  stoppable?: boolean;
  conversationId?: string;
  model?: string;
  tokens?: number;
};

/** A projection fold, not another worker lifecycle or a task-id tombstone map. */
export function compactWorkers(items: readonly ConversationItem[]): CompactWorker[] {
  const shellTask = (type?: string) => /^(shell|local_bash|bash)$/i.test(type ?? "");
  const aliases = backgroundTasksByTool(items);
  const workers = new Map<string, CompactWorker>();
  for (const item of items) {
    if (item.type !== "background_task") continue;
    if (item.foreground && shellTask(item.taskType)) continue;
     workers.set(item.id, {
       id: item.id, state: workerState(item.status, item.stateUncertain), references: [],
       name: item.description, kind: shellTask(item.taskType) ? "shell" : "agent",
       since: item.createdAt, settledAt: item.createdAt + (item.usage?.durationMs ?? 0),
        progress: item.progress, taskId: item.taskId, stoppable: !item.foreground && taskById(items, item.taskId)?.id === item.id, conversationId: item.childConversationId,
        tokens: item.usage?.totalTokens,
     });
  }
  for (const entry of subagentEntries(items)) {
    // Only proven launcher aliases can merge occurrences. A child can run
    // repeatedly, so a shared child id alone is not a deduplication key.
    if (workers.has(entry.id)) continue;
    const item = items.find(item => item.id === entry.id);
    if (item?.type === "background_task" && shellTask(item.taskType) && item.foreground) continue;
    const canonical = aliases.get(entry.id);
    if (canonical) {
      const worker = workers.get(canonical.id);
      if (worker) {
        worker.references.push(entry.id);
        worker.model ??= entry.model;
        // One occurrence's reported spend, not a sum of launcher aliases.
        worker.tokens ??= entry.usage ? totalTokens(entry.usage) : undefined;
      }
      continue;
    }
    workers.set(entry.id, {
      id: entry.id, state: workerState(entry.status), references: [entry.id],
      name: entry.description, kind: "agent", since: item?.createdAt ?? 0,
      settledAt: item?.createdAt ?? 0, progress: entry.progress, conversationId: entry.conversationId,
      model: entry.model, tokens: entry.usage ? totalTokens(entry.usage) : undefined,
    });
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
