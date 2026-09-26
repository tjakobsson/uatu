// Chat's reader-local date wording: when a rate limit resets and which day a
// run of the timeline happened. Everything is decided by the reader's local
// calendar day and zone — never by a millisecond distance, which misreads
// "06:00 tomorrow" as today and miscounts DST days. Clock times are always
// 24-hour "HH:MM" and dates ISO "YYYY-MM-DD", whatever the locale; only
// weekday names (and the long dates given to assistive technology) follow
// the browser's locale.
// A leaf module (no chat imports) so the timeline renderer and the composer
// status can both use it without an import cycle.

const DAY_MS = 86_400_000;

/**
 * Whether a time is real enough to date: missing times arrive as `0`, and
 * anything before 2001-09-09 (1e12 ms) is a placeholder or a
 * seconds-for-milliseconds slip, which "1 January 1970" would misstate.
 */
export function knownTime(at: number): boolean {
  return Number.isFinite(at) && at >= 1e12;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** The reader-local clock time, 24-hour and zero-padded: "14:32", "02:06". */
export function clockTime(at: number): string {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The locale's short weekday name, "Mon". */
function weekday(at: number): string {
  return new Date(at).toLocaleDateString([], { weekday: "short" });
}

/** Weekday and clock time, "Mon 23:00". */
export function weekdayClock(at: number): string {
  return `${weekday(at)} ${clockTime(at)}`;
}

/** A full moment for a tooltip or a record: "Sun 2026-09-20 19:43". */
export function dateTime(at: number): string {
  return `${weekday(at)} ${localDayKey(at)} ${clockTime(at)}`;
}

/** Whole local calendar days from `from` to `to` (negative when earlier). */
export function localDaysBetween(from: number, to: number): number {
  const a = new Date(from);
  const b = new Date(to);
  // Date.UTC over the local Y/M/D counts calendar days without the 23/25 h
  // of a DST change leaking in.
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / DAY_MS);
}

/**
 * The local calendar day as ISO `YYYY-MM-DD`, from local fields (not
 * `toISOString`, which is the UTC day).
 */
export function localDayKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The next local midnight after `now`, as epoch ms. */
export function nextLocalMidnight(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
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
 * The reset as a clock time: bare on the reader's current day ("14:00"),
 * with the weekday on any other day ("Sat 21:00"). No date: a rate-limit
 * window is at most a week, and where a reset is stated alongside, the
 * time remaining says how far off it is.
 */
export function resetClock(resetsAt: number, now = Date.now()): string {
  return localDaysBetween(now, resetsAt) === 0 ? clockTime(resetsAt) : weekdayClock(resetsAt);
}

/** "Thu 23:00 · in 3d 4h": the clock that survives a glance away, and whether to wait. */
export function resetMoment(resetsAt: number, now = Date.now()): string {
  return `${resetClock(resetsAt, now)} · ${relativeReset(resetsAt, now)}`;
}

/** A day's visible label: "Today", "Yesterday", else the short weekday and ISO date, "Sun 2026-09-20". */
export function dayLabel(at: number, now = Date.now()): string {
  const days = localDaysBetween(at, now);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${weekday(at)} ${localDayKey(at)}`;
}

/** The full day in the locale's long form, with the year when not this year: for assistive technology. */
export function fullDate(at: number, now = Date.now()): string {
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", ...(sameYear ? {} : { year: "numeric" }) });
}
