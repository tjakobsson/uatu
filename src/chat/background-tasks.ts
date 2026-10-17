// The composer's view of background work: which tasks are live and how the
// status region names them. Pure over the projection's items so the surface
// and its tests share one reading of the state (spec: the composer status
// names how many tasks run; the list names each task with its progress).

import type { BackgroundTaskItem, ConversationItem } from "./types";

/** Tool rows retain their individual costs; aliases refer to one worker. */
export function backgroundTasksByTool(items: readonly ConversationItem[]): Map<string, BackgroundTaskItem> {
  const tasks = new Map<string, BackgroundTaskItem>();
  for (const item of items) {
    if (item.type !== "background_task") continue;
    for (const call of new Set([...(item.toolUseIds ?? []), ...(item.toolUseId ? [item.toolUseId] : [])])) tasks.set(`tool:${call}`, item);
  }
  return tasks;
}

/**
 * The background work running now. A foreground run's row (the review a
 * typed command launches, design D13) is not background work: the turn that
 * ran it is still the conversation's turn, and the run is listed with the
 * subagents instead.
 */
export function runningBackgroundTasks(items: readonly ConversationItem[]): BackgroundTaskItem[] {
  return items.filter((item): item is BackgroundTaskItem => item.type === "background_task" && item.status === "running" && item.foreground !== true);
}

/** "1 background task running · Sleep for 20 seconds" / "3 background tasks running". */
export function backgroundStatusLabel(tasks: readonly BackgroundTaskItem[]): string {
  if (tasks.length === 0) return "Background work running";
  const uncertain = tasks.filter(task => task.stateUncertain).length;
  if (uncertain === tasks.length) return "Status unavailable — reconnecting";
  if (uncertain) {
    const confirmed = tasks.length - uncertain;
    return `${confirmed} background ${confirmed === 1 ? "task" : "tasks"} running · ${uncertain} status unavailable`;
  }
  const noun = tasks.length === 1 ? "background task" : "background tasks";
  const detail = tasks.length === 1 ? ` · ${tasks[0]!.description}` : "";
  return `${tasks.length} ${noun} running${detail}`;
}
