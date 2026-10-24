import { backgroundTasksByTool } from "./background-tasks";
import { isLiveConversationStatus, type ConversationItem, type ConversationStatus } from "./types";

/** Conservative blocker evidence, not a native job inventory or target list. */
export function hasVerifiedBlockingWork(status: ConversationStatus, items: readonly ConversationItem[]): boolean {
  if (!isLiveConversationStatus(status)) return false;
  const workers = backgroundTasksByTool(items);
  return items.some(item => {
    if (item.type === "background_task") return item.foreground === true && item.status === "running" && !item.stateUncertain;
    if (item.type !== "tool" && item.type !== "command" || item.status !== "running") return false;
    const worker = workers.get(item.id);
    return !worker || worker.foreground === true && worker.status === "running" && !worker.stateUncertain;
  });
}
