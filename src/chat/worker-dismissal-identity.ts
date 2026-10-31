import { describeToolDetail } from "./tool-detail";
import type { ToolItem } from "./types";

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && new TextEncoder().encode(value).length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const anchor = (kind: string, value: unknown): string[] => {
  if (!identifier(value)) return [];
  const id = `worker-dismissal:${kind}:${value}`;
  return identifier(id) ? [id] : [];
};

/** Immutable provider occurrence anchors, never a child id or display clock.
 * Tool-use ids survive live/history/restart and bridge launcher-only pages.
 * Native task/result ids cover executions without a launcher. Activity remains
 * separate: adding an identity makes no claim about outcome or current work.
 */
export function workerDismissalIdentities(value: unknown): string[] {
  const item = record(value);
  if (!item || (item.type !== "background_task" && item.type !== "tool")) return [];
  if (item.type === "tool") {
    if (!identifier(item.id) || typeof item.name !== "string" || typeof item.status !== "string"
      || (item.input !== undefined && typeof item.input !== "string")
      || (item.output !== undefined && typeof item.output !== "string")
      || (item.childConversationId !== undefined && typeof item.childConversationId !== "string")) return [];
    const detail = describeToolDetail(item as ToolItem);
    if (detail.kind !== "agent" && !(detail.kind === "skill" && detail.conversationId)) return [];
    // Normalized tool ids are immutable call ids; support legacy rows whose
    // provider used the call id directly instead of the tool: prefix.
    return anchor("tool", item.id.startsWith("tool:") ? item.id.slice(5) : item.id);
  }
  const activityIds: string[] = [];
  if (item.activity !== undefined) {
    const activity = record(item.activity);
    if (!activity || activity.executionId !== undefined && !identifier(activity.executionId)) return [];
    const aliases = activity.executionAliases;
    if (aliases !== undefined && (!Array.isArray(aliases) || aliases.length > 2048 || !aliases.every(identifier)
      || !identifier(activity.executionId) || new Set(aliases).size !== aliases.length || !aliases.includes(activity.executionId))) return [];
    if (identifier(activity.executionId)) activityIds.push(activity.executionId, ...(aliases as string[] | undefined ?? []));
  }
  const calls = item.toolUseIds;
  if (calls !== undefined && (!Array.isArray(calls) || calls.length > 2048 || !calls.every(identifier))) return [];
  if (item.toolUseId !== undefined && !identifier(item.toolUseId)) return [];
  const launchers = [...new Set([...(calls as string[] | undefined ?? []), ...(identifier(item.toolUseId) ? [item.toolUseId] : [])])];
  // V2 withholds its positive execution aliases above 64 immutable launches.
  // An absent optional primary alone is valid, but must not bypass that bound
  // by replacing a deliberately withheld complete set with fallback anchors.
  if (item.activity !== undefined && !activityIds.length && launchers.length > 64) return [];
  const ids: string[] = [];
  for (const call of launchers) ids.push(...anchor("tool", call));
  if (item.resultId !== undefined) ids.push(...anchor("result", item.resultId));
  // A task id is the native occurrence, not a reusable child session. Refuse
  // rows which expose only that child as their purported task identity.
  // Retain it even after recovering a launcher/result: an earlier page may
  // already have saved a dismissal against this native task occurrence.
  if (item.taskId !== item.childConversationId) ids.push(...anchor("task", item.taskId));
  // Prefer the launcher/native anchor when saving: terminal DTOs need not
  // retain the optional current-activity envelope.
  return [...new Set([...ids, ...activityIds])];
}
