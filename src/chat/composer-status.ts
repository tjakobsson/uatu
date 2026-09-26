// The composer's status region, decided once for the surface and its tests:
// the named state the dot and the accessible label show, the rate-limit
// badge beside it, and the plan utilization the meter can carry. Pure over
// the projection so the live surface and the unit tests read one rule.

import { backgroundStatusLabel } from "./background-tasks";
import { scheduledStatusLabel } from "./scheduled-wakeups";
import { statusLabel } from "./timeline-renderer";
import { clockTime, localDaysBetween, relativeReset, resetClock, resetMoment, weekdayClock } from "./dates";
import { isRateLimitStanding, type BackgroundTaskItem, type ScheduledWakeupItem, type ContextReportItem, type ConversationItem, type ConversationStatus, type NoticeItem, type PlanUtilization, type PlanUtilizationWindow, type SessionTotals, type UsageReadFailure } from "./types";

export type ComposerRoutineState = {
  stateName: "cancelling" | "sending" | "working" | "retrying" | "compacting" | "background" | "scheduled" | "failed" | "ready";
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
  scheduledDeclared?: boolean;
  // Pending, soonest first (pendingWakeups).
  scheduledWakeups?: readonly ScheduledWakeupItem[];
  now?: number;
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
  // The background state is the list's state: the status is raised because a
  // task is running and is only lowered when the agent says the turn moved on,
  // so between a task settling and that word the status would name background
  // work with no task left to name. An empty list falls back to ready.
  if (status === "background" && input.backgroundDeclared && input.backgroundTasks.length > 0) return { stateName: "background", label: backgroundStatusLabel(input.backgroundTasks) };
  // Nothing runs, but the session is held for the agent's own future turns
  // (spec: the composer names the state, the pending count, and the next fire).
  if (status === "scheduled" && input.scheduledDeclared) return { stateName: "scheduled", label: scheduledStatusLabel(input.scheduledWakeups ?? [], input.now) };
  if (status === "failed") return { stateName: "failed", label: statusLabel(status) };
  if (status === undefined) return { stateName: "ready", label: "Select a conversation" };
  return { stateName: "ready", label: status === "background" || status === "scheduled" ? "Ready" : statusLabel(status) };
}

export type RateLimitStanding = { level: "warning" | "rejected"; message: string; resetsAt?: number };

/**
 * The rate-limit standing in force, or none.
 *
 * Found by its code, not by an id: the code is what the contract gives a
 * client to recognize a standing by, and it is what the timeline filters
 * on. Keying this on the id the Claude normalizer happens to use would
 * make the two disagree — an agent that kept its standing under another
 * stable id would have it filtered out of the timeline and not found here,
 * so the standing would show nowhere at all.
 *
 * The newest wins. One producer keeping one item id is a property of that
 * producer, not a guarantee of the wire, so this reads the last one in
 * order rather than assuming there is only ever one to find. Its absence
 * is the answer "not limited": the agent removes the item when requests
 * are allowed again.
 */
export function latestRateLimit(items: readonly ConversationItem[]): RateLimitStanding | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || !isRateLimitStanding(item)) continue;
    const notice = item as NoticeItem;
    return {
      level: notice.code === "rate-limit-rejected" ? "rejected" : "warning",
      message: notice.message,
      ...(notice.resetsAt === undefined ? {} : { resetsAt: notice.resetsAt }),
    };
  }
  return undefined;
}

/**
 * The one chip beside the composer, resolved from the plan report and the
 * rate-limit standing together.
 *
 * They were two controls saying one thing: a plan summary that could not
 * see it was rate limited, and a badge that could not be opened. Folding
 * them gives the standing somewhere to be read in full — the readout the
 * chip opens already names every window and its reset.
 *
 * Order matters. A rejection displaces the percentages deliberately: once
 * requests are blocked, how full the window is has stopped being the
 * actionable fact, and the figures are one click away. A warning keeps
 * them and only raises the level, because there the percentage IS the
 * warning — and the level cannot be derived from the figures alone, since
 * the login warns on windows the summary does not list.
 */
export type PlanChip = {
  text: string;
  level: "normal" | "warning" | "rejected";
  // What the chip is saying, for the surface's styling and its title.
  kind: "plan" | "cost" | "rate-limit";
};

export function planChip(report: Pick<ContextReportItem, "plan" | "session"> | undefined, standing: RateLimitStanding | undefined): PlanChip | undefined {
  if (standing?.level === "rejected") return { text: rateLimitBadgeLabel(standing), level: "rejected", kind: "rate-limit" };
  const plan = report?.plan;
  const summary = report ? planSummaryLabel(report) : undefined;
  if (plan && planHasRows(plan) && summary) {
    const level = standing || planUtilizationLevel(plan) === "warning" ? "warning" : "normal";
    return { text: summary, level, kind: "plan" };
  }
  // No windows to show. A standing still has to be sayable — a login with
  // no plan can still be rate limited, and before this it had nowhere to go.
  if (standing) return { text: rateLimitBadgeLabel(standing), level: "warning", kind: "rate-limit" };
  return summary ? { text: summary, level: "normal", kind: "cost" } : undefined;
}

export function rateLimitBadgeLabel(standing: RateLimitStanding, now = Date.now()): string {
  // The chip is tight for room: the clock, with its day when not today, is
  // what removes the ambiguity; the readout carries the relative time.
  const resets = standing.resetsAt === undefined ? "" : ` · resets ${resetClock(standing.resetsAt, now)}`;
  return standing.level === "rejected" ? `Rate limited${resets}` : `Near rate limit${resets}`;
}

/**
 * The standing as one sentence — the readout's standing line and what is
 * announced to assistive technology — with its reset phrased as the plan
 * rows phrase theirs: "… Resets Thu 23:00 · in 3d 4h."
 */
export function standingSentence(standing: Pick<RateLimitStanding, "message" | "resetsAt">, now = Date.now()): string {
  return standing.resetsAt === undefined ? standing.message : `${standing.message} Resets ${resetMoment(standing.resetsAt, now)}.`;
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

import { formatUsd } from "./usage";

export { formatUsd };

/** "$1.23 this conversation": the chip's words for a login that has no windows to report. */
export function sessionCostLabel(session: SessionTotals): string {
  return `${formatUsd(session.costUsd)} this conversation`;
}

/**
 * The readout block's title. The agent counts per query and each turn of an
 * idle conversation resumes a fresh one, so the totals are summed by the
 * workspace process from `since`, when it first saw the conversation. A
 * conversation with a message older than that — one resumed after a restart
 * — is titled "since HH:MM" rather than claiming the whole conversation.
 * Like every other day decision in the chat, the reader's local calendar day
 * decides the form: a start earlier today is the bare clock ("since 23:00"),
 * one on any earlier local day gains its weekday ("since Fri 23:00") — even
 * when less than 24 hours have passed.
 */
export function sessionTotalsTitle(session: Pick<SessionTotals, "since">, items: readonly ConversationItem[], now = Date.now()): string {
  let firstMessageAt: number | undefined;
  for (const item of items) {
    if (item.type === "user_message" && (firstMessageAt === undefined || item.createdAt < firstMessageAt)) firstMessageAt = item.createdAt;
  }
  if (session.since === undefined || firstMessageAt === undefined || session.since <= firstMessageAt) return "This conversation";
  return `This conversation · since ${localDaysBetween(session.since, now) <= 0 ? clockTime(session.since) : weekdayClock(session.since)}`;
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
 * A usage report older than this is stale: still shown, marked as such.
 * The 5-hour window moves about 0.3 %/min at full burn, so ten minutes
 * bounds the error at a few percent.
 */
export const USAGE_STALE_MS = 10 * 60_000;

export function usageStale(readAt: number, now = Date.now()): boolean {
  return now - readAt >= USAGE_STALE_MS;
}

/** "just now", "12 min ago", "3 h ago", "2 d ago": how long since the read. */
export function usageAge(readAt: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - readAt);
  if (elapsed < 60_000) return "just now";
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** "as of 21:33 · 12 min ago" — the read's clock time and its age together. */
export function usageAsOf(readAt: number, now = Date.now()): string {
  return `as of ${clockTime(readAt)} · ${usageAge(readAt, now)}`;
}

/** Why a read did not answer, as the readout says it. */
export function usageReadFailureLabel(reason: UsageReadFailure | "network"): string {
  switch (reason) {
    case "timeout": return "timed out";
    case "unavailable": return "Claude Code could not answer";
    case "no-live-session": return "no session is running";
    case "network": return "the workspace did not answer";
  }
}

/** The plan name as a reader says it: "Max plan", "Pro plan"; "Team", "Enterprise" likewise. */
export function planName(plan: PlanUtilization): string | undefined {
  const subscription = plan.subscription?.trim();
  if (!subscription) return undefined;
  return `${subscription.charAt(0).toUpperCase()}${subscription.slice(1)} plan`;
}
