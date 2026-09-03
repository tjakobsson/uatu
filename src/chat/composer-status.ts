// The composer's status region, decided once for the surface and its tests:
// the named state the dot and the accessible label show, the rate-limit
// badge beside it, and the plan utilization the meter can carry. Pure over
// the projection so the live surface and the unit tests read one rule.

import { backgroundStatusLabel } from "./background-tasks";
import { statusLabel } from "./timeline-renderer";
import type { BackgroundTaskItem, ContextReportItem, ConversationItem, ConversationStatus, NoticeItem, PlanUtilization, PlanUtilizationWindow, SessionTotals } from "./types";

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
  return latestPlanReport(items)?.plan;
}

/** The report behind `latestPlanUtilization`, for the session totals that ride with it. */
export function latestPlanReport(items: readonly ConversationItem[]): ContextReportItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "context_report" && item.plan !== undefined) return item;
  }
  return undefined;
}

/**
 * "Session 37% · Week 12%", whichever base windows were reported. The words
 * are Claude Code's own: its `/usage` dialog calls the 5-hour window the
 * current session and the 7-day window the current week, and a reader who
 * has seen that dialog must not meet different names here.
 */
export function planUtilizationLabel(plan: PlanUtilization): string | undefined {
  const parts: string[] = [];
  if (plan.fiveHour?.utilization !== undefined) parts.push(`Session ${Math.round(plan.fiveHour.utilization)}%`);
  if (plan.sevenDay?.utilization !== undefined) parts.push(`Week ${Math.round(plan.sevenDay.utilization)}%`);
  return parts.length ? parts.join(" · ") : undefined;
}

/**
 * Dollars as the readout shows them: cents for anything a reader would
 * budget, four places below ten cents so a cheap turn does not round to
 * nothing.
 */
export function formatUsd(value: number): string {
  return value.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < 0.1 ? 4 : 2 });
}

/** "$1.23 this conversation": the chip's words for a login that has no windows to report. */
export function sessionCostLabel(session: SessionTotals): string {
  return `${formatUsd(session.costUsd)} this conversation`;
}

/**
 * What the composer chip says for a report: the plan windows where the login
 * has them, else this conversation's cost where the agent tallied one. An
 * API-key, Bedrock, or Vertex login reports an empty plan with real session
 * totals, and the cost is the figure that login budgets by. Undefined when
 * the report says neither, and the chip stays hidden.
 */
export function planSummaryLabel(report: Pick<ContextReportItem, "plan" | "session">): string | undefined {
  if (report.plan) {
    const base = planUtilizationLabel(report.plan);
    if (base) return base;
    // Windows without a base percentage — a model-scoped bucket alone, or
    // base windows that came with a reset and no figure — are still a plan,
    // and the readout can show them. The chip names the first row that has
    // a figure, else the plan itself, rather than falling through to the
    // cost and claiming the login has no limits.
    const rows = planReadoutRows(report.plan);
    if (rows.length) {
      const measured = rows.find(row => row.utilization !== undefined);
      return measured ? `${measured.label} ${Math.round(measured.utilization!)}%` : "Plan usage";
    }
  }
  return report.session ? sessionCostLabel(report.session) : undefined;
}

/**
 * Whether the plan gives the readout anything to draw: one rule for the
 * chip's plan-or-cost classification and the readout's rows, so a plan the
 * rows can render is never filed as "no plan" by a stricter summary test.
 */
export function planHasRows(plan: PlanUtilization): boolean {
  return planReadoutRows(plan).length > 0;
}

// The chip turns to the warning colour at this fill — the point where the
// rest of the window is a plan, not a margin.
export const PLAN_WARNING_UTILIZATION = 80;

/**
 * Warning when any reported window, or enabled extra usage, is at or past
 * the threshold — the same meters the readout draws, so the collapsed chip
 * never reads calm above a row the readout marks as a warning.
 */
export function planUtilizationLevel(plan: PlanUtilization): "warning" | "normal" {
  const extra = plan.extraUsage?.enabled ? plan.extraUsage : undefined;
  const windows: Array<PlanUtilizationWindow | undefined> = [plan.fiveHour, plan.sevenDay, plan.sevenDayOpus, plan.sevenDaySonnet, plan.sevenDayOauthApps, ...(plan.modelScoped ?? []), extra];
  return windows.some(window => window?.utilization !== undefined && window.utilization >= PLAN_WARNING_UTILIZATION) ? "warning" : "normal";
}

export type PlanReadoutRow = {
  key: string;
  label: string;
  // Percent used, 0-100; absent when the login reported the window without
  // a figure (the meter then draws empty and the figure reads "?").
  utilization?: number;
  resetsAt?: number;
  // "resets 14:00 · in 35m", or "" where the window carries no reset. Both
  // forms because neither answers alone: the clock time survives a glance
  // away, the relative one says whether to wait.
  resetLabel: string;
  // What the row is measuring when it is not time: "$12.50 of $100".
  note?: string;
};

/**
 * The readout's rows in a fixed order — the two base windows, the per-model
 * weeks, the server-labelled buckets, OAuth apps, then extra usage — so the
 * eye lands in the same place on every open. Extra usage appears only when
 * the login has it enabled: a disabled row would be a feature advertisement.
 */
export function planReadoutRows(plan: PlanUtilization, now = Date.now()): PlanReadoutRow[] {
  const rows: PlanReadoutRow[] = [];
  const window = (key: string, label: string, entry: PlanUtilizationWindow | undefined) => {
    if (!entry) return;
    rows.push({
      key,
      label,
      ...(entry.utilization === undefined ? {} : { utilization: entry.utilization }),
      ...(entry.resetsAt === undefined ? {} : { resetsAt: entry.resetsAt }),
      resetLabel: entry.resetsAt === undefined ? "" : `resets ${resetClock(entry.resetsAt, now)} · ${relativeReset(entry.resetsAt, now)}`,
    });
  };
  window("session", "Session", plan.fiveHour);
  window("week", "Week", plan.sevenDay);
  window("week-opus", "Week · Opus", plan.sevenDayOpus);
  window("week-sonnet", "Week · Sonnet", plan.sevenDaySonnet);
  (plan.modelScoped ?? []).forEach((entry, index) => window(`week-model-${index}`, `Week · ${entry.label}`, entry));
  window("week-oauth-apps", "Week · OAuth apps", plan.sevenDayOauthApps);
  const extra = plan.extraUsage;
  if (extra?.enabled) {
    const currency = extra.currency ?? "USD";
    const money = (value: number) => {
      try { return value.toLocaleString(undefined, { style: "currency", currency, maximumFractionDigits: 2 }); }
      catch { return `${value.toFixed(2)} ${currency}`; }
    };
    const note = extra.usedCredits !== undefined && extra.monthlyLimit !== undefined
      ? `${money(extra.usedCredits)} of ${money(extra.monthlyLimit)}`
      : extra.usedCredits !== undefined ? `${money(extra.usedCredits)} used` : undefined;
    rows.push({ key: "extra-usage", label: "Extra usage", ...(extra.utilization === undefined ? {} : { utilization: extra.utilization }), resetLabel: "", ...(note ? { note } : {}) });
  }
  return rows;
}

/**
 * "in 4d 11h" / "in 2h 05m" / "in 35m"; "now" once the reset has passed
 * and the next report has not yet said so. Minutes are dropped past a day
 * because a weekly window is not waited on to the minute.
 */
export function relativeReset(resetsAt: number, now = Date.now()): string {
  const remaining = resetsAt - now;
  if (remaining < 30_000) return "now";
  const minutes = Math.round(remaining / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  const days = Math.floor(hours / 24);
  return `in ${days}d ${hours % 24}h`;
}

/**
 * The reset as a clock time — bare within the coming day ("14:00"), with
 * the weekday beyond it ("Sat 21:00"), since a bare time a week out would
 * read as today.
 */
export function resetClock(resetsAt: number, now = Date.now()): string {
  const date = new Date(resetsAt);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return resetsAt - now < 86_400_000 ? time : `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** The plan name as a reader says it: "Max plan", "Pro plan"; "Team", "Enterprise" likewise. */
export function planName(plan: PlanUtilization): string | undefined {
  const subscription = plan.subscription?.trim();
  if (!subscription) return undefined;
  return `${subscription.charAt(0).toUpperCase()}${subscription.slice(1)} plan`;
}
