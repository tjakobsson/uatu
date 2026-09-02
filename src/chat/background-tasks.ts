// The composer's view of background work: which tasks are live and how the
// status region names them. Pure over the projection's items so the surface
// and its tests share one reading of the state (spec: the composer status
// names how many tasks run; the list names each task with its progress).

import type { BackgroundTaskItem, ConversationItem } from "./types";

export function runningBackgroundTasks(items: readonly ConversationItem[]): BackgroundTaskItem[] {
  return items.filter((item): item is BackgroundTaskItem => item.type === "background_task" && item.status === "running");
}

/** "1 background task running · Sleep for 20 seconds" / "3 background tasks running". */
export function backgroundStatusLabel(tasks: readonly BackgroundTaskItem[]): string {
  if (tasks.length === 0) return "Background work running";
  const noun = tasks.length === 1 ? "background task" : "background tasks";
  const detail = tasks.length === 1 ? ` · ${tasks[0]!.description}` : "";
  return `${tasks.length} ${noun} running${detail}`;
}
