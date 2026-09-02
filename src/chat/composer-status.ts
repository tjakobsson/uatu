// The composer's status region, decided once for the surface and its tests:
// the named state the dot and the accessible label show, the rate-limit
// badge beside it, and the plan utilization the meter can carry. Pure over
// the projection so the live surface and the unit tests read one rule.

import { backgroundStatusLabel } from "./background-tasks";
import { statusLabel } from "./timeline-renderer";
import type { BackgroundTaskItem, ConversationItem, ConversationStatus, NoticeItem, PlanUtilization } from "./types";

export type ComposerRoutineState = {
  stateName: "cancelling" | "sending" | "working" | "retrying" | "compacting" | "background" | "failed" | "ready";
  label: string;
  // The reason that came with the state (a retry's attempt and HTTP status).
};

export function composerRoutineState(input: {
  status: ConversationStatus | undefined;
  statusMessage?: string;
  cancelling: boolean;
  submitting: boolean;
  backgroundDeclared: boolean;
  backgroundTasks: readonly BackgroundTaskItem[];
}): ComposerRoutineState {
  const { status } = input;
  if (input.cancelling) return { stateName: "cancelling", label: "Cancelling" };
  if (input.submitting && status !== "running" && status !== "retrying" && status !== "compacting") return { stateName: "sending", label: "Sending" };
  if (status === "sending") return { stateName: "sending", label: "Sending" };
  if (status === "running") return { stateName: "working", label: statusLabel(status) };
  // A retry names what it waits on; compaction names itself. Both are live
  // states with their own accessible name (spec: a retry is not a silent
  // stall; a compaction in progress shows as compacting).
  if (status === "retrying") return { stateName: "retrying", label: input.statusMessage ? `Retrying (${input.statusMessage})` : "Retrying" };
  if (status === "compacting") return { stateName: "compacting", label: statusLabel(status) };
  if (status === "background" && input.backgroundDeclared) return { stateName: "background", label: backgroundStatusLabel(input.backgroundTasks) };
  if (status === "failed") return { stateName: "failed", label: statusLabel(status) };
  if (status === undefined) return { stateName: "ready", label: "Select a conversation" };
  return { stateName: "ready", label: status === "background" ? "Ready" : statusLabel(status) };
}

export type RateLimitStanding = { level: "warning" | "rejected"; message: string; resetsAt?: number };

/**
 * The latest rate-limit notice still standing: a rejection or a warning
 * until a later clearing notice retires it. Notices are scanned from the
 * tail, so the newest wins.
 */
export function latestRateLimit(items: readonly ConversationItem[]): RateLimitStanding | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || item.type !== "notice" || !item.code?.startsWith("rate-limit")) continue;
    const notice = item as NoticeItem;
    if (notice.code === "rate-limit-cleared") return undefined;
    return { level: notice.code === "rate-limit-rejected" ? "rejected" : "warning", message: notice.message, ...(notice.resetsAt === undefined ? {} : { resetsAt: notice.resetsAt }) };
  }
  return undefined;
}

export function rateLimitBadgeLabel(standing: RateLimitStanding): string {
  const resets = standing.resetsAt === undefined ? "" : ` · resets ${new Date(standing.resetsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return standing.level === "rejected" ? `Rate limited${resets}` : `Near rate limit${resets}`;
}

/**
 * The newest report that speaks to the plan: one carrying windows, or an
 * empty plan (the login reports none). A report without the field — a
 * compaction's post-count — says nothing about the plan and is skipped.
 */
export function latestPlanUtilization(items: readonly ConversationItem[]): PlanUtilization | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "context_report" && item.plan !== undefined) return item.plan;
  }
  return undefined;
}

/** "Plan 37% of 5h · 12% of 7d", whichever windows were reported. */
export function planUtilizationLabel(plan: PlanUtilization): string | undefined {
  const parts: string[] = [];
  if (plan.fiveHour?.utilization !== undefined) parts.push(`${Math.round(plan.fiveHour.utilization)}% of 5h`);
  if (plan.sevenDay?.utilization !== undefined) parts.push(`${Math.round(plan.sevenDay.utilization)}% of 7d`);
  return parts.length ? `Plan ${parts.join(" · ")}` : undefined;
}
