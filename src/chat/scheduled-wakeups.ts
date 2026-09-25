// The composer's and the timeline's reading of scheduled wakeups: which are
// pending, how the scheduled state names them, and how a fire time is said.
// Pure over the projection's items so the surfaces and their tests share one
// reading (spec: the composer names the state and lists each pending wakeup
// with its prompt, whether it recurs, and when it next fires).

import type { ConversationItem, ScheduledWakeupItem } from "./types";

/** Crons the agent rebuilds when the conversation runs again, oldest first. */
export function pausedWakeups(items: readonly ConversationItem[]): ScheduledWakeupItem[] {
  return items
    .filter((item): item is ScheduledWakeupItem => item.type === "scheduled_wakeup" && item.status === "paused")
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** "1 schedule paused · fires again when this conversation runs". */
export function pausedStatusLabel(wakeups: readonly ScheduledWakeupItem[]): string {
  const noun = wakeups.length === 1 ? "schedule" : "schedules";
  return `${wakeups.length} ${noun} paused · ${wakeups.length === 1 ? "fires" : "fire"} again when this conversation runs`;
}

export function pendingWakeups(items: readonly ConversationItem[]): ScheduledWakeupItem[] {
  return items
    .filter((item): item is ScheduledWakeupItem => item.type === "scheduled_wakeup" && item.status === "pending")
    .sort((a, b) => (a.nextFireAt ?? Number.POSITIVE_INFINITY) - (b.nextFireAt ?? Number.POSITIVE_INFINITY));
}

/**
 * "about 20:03", "about Fri 09:00", "about 1 Oct 09:00". Always "about": the
 * time is the workspace's reading of the agent's cron, and the agent fires on
 * its own clock. Absent when the expression could not be read.
 */
export function wakeupFireTime(nextFireAt: number | undefined, now = Date.now()): string | undefined {
  if (nextFireAt === undefined) return undefined;
  const at = new Date(nextFireAt);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const today = new Date(now);
  const days = Math.round((startOfDay(at) - startOfDay(today)) / 86_400_000);
  if (days <= 0) return `about ${time}`;
  if (days < 7) return `about ${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `about ${at.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "1 wakeup scheduled · next about 20:03" / "3 wakeups scheduled · next about 09:00". */
export function scheduledStatusLabel(wakeups: readonly ScheduledWakeupItem[], now = Date.now()): string {
  if (wakeups.length === 0) return "Wakeup scheduled";
  const noun = wakeups.length === 1 ? "wakeup" : "wakeups";
  const next = wakeupFireTime(wakeups[0]!.nextFireAt, now);
  return `${wakeups.length} ${noun} scheduled${next ? ` · next ${next}` : ""}`;
}

/** The timeline row's words for a wakeup at each point of its life. */
export function wakeupRowLabel(item: ScheduledWakeupItem, now = Date.now()): string {
  const kind = item.recurring ? "Recurring wakeup" : "Wakeup";
  if (item.status === "fired") return `${kind} fired`;
  if (item.status === "cancelled") return `${kind} cancelled`;
  if (item.status === "lost") return `${kind} lost`;
  if (item.status === "paused") return `${kind} paused`;
  const next = wakeupFireTime(item.nextFireAt, now);
  return next ? `${kind} scheduled · ${item.recurring ? "next " : ""}${next}` : `${kind} scheduled`;
}
