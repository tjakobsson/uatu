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
 * Strong provider aliases are the complete namespace when present: a native
 * call/task id alone can recur with contradictory immutable launch facts.
 * Legacy and finished rows without that envelope retain their recorded
 * task/launcher/result anchors. Identity makes no claim about current work.
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
  // Do not bridge a strong occurrence to an unqualified call/task/result.
  // Old bare marks remain stored, but cannot safely hide these V2 rows; a
  // fresh dismissal saves only a provider-proven immutable execution alias.
  // The public V2 provider always emits this envelope, including terminal and
  // notification-only history. No primary means proof was withheld, not that
  // a reusable native call/result/task id can replace the missing proof.
  if (item.activity !== undefined) return [...new Set(activityIds)];
  const ids: string[] = [];
  for (const call of launchers) ids.push(...anchor("tool", call));
  if (item.resultId !== undefined) ids.push(...anchor("result", item.resultId));
  // A task id is the native occurrence, not a reusable child session. Refuse
  // rows which expose only that child as their purported task identity.
  // Retain it even after recovering a launcher/result: an earlier page may
  // already have saved a dismissal against this native task occurrence.
  if (item.taskId !== item.childConversationId) ids.push(...anchor("task", item.taskId));
  // Compatibility for providers without the activity envelope. Public V2
  // history (including terminal rows) takes the proof-only branch above.
  return [...new Set(ids)];
}
