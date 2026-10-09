// Ages for timestamps the client already has, so they stay current without
// asking the server again. Two forms:
// - short ("2m ago"), the facts strip's freshness segment;
// - long ("2 minutes ago"), the Git Log and the commit preview, matching the
//   wording and rounding of Git's own `%cr` (show_date_relative in date.c).

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// Short form. Beyond a week it degrades to the absolute date: "modified 94d
// ago" reads worse than the date itself.
export function formatRelativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return "";
  }
  const delta = Math.max(0, nowMs - then);
  if (delta < MINUTE_MS) {
    return "just now";
  }
  if (delta < HOUR_MS) {
    return `${Math.floor(delta / MINUTE_MS)}m ago`;
  }
  if (delta < DAY_MS) {
    return `${Math.floor(delta / HOUR_MS)}h ago`;
  }
  if (delta < 7 * DAY_MS) {
    return `${Math.floor(delta / DAY_MS)}d ago`;
  }
  return formatAbsoluteDate(iso);
}

export function formatAbsoluteDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function count(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

// Long form, Git's `%cr`. Every step rounds the way Git's integer arithmetic
// does, so a just-collected entry reads the same as Git's own text.
export function formatCommitAge(thenMs: number, nowMs: number): string {
  if (!Number.isFinite(thenMs)) return "";
  const now = Math.floor(nowMs / 1000);
  const then = Math.floor(thenMs / 1000);
  if (now < then) return "in the future";
  let diff = now - then;
  if (diff < 90) return `${count(diff, "second")} ago`;
  diff = Math.floor((diff + 30) / 60);
  if (diff < 90) return `${count(diff, "minute")} ago`;
  diff = Math.floor((diff + 30) / 60);
  if (diff < 36) return `${count(diff, "hour")} ago`;
  diff = Math.floor((diff + 12) / 24);
  if (diff < 14) return `${count(diff, "day")} ago`;
  if (diff < 70) return `${count(Math.floor((diff + 3) / 7), "week")} ago`;
  if (diff < 365) return `${count(Math.floor((diff + 15) / 30), "month")} ago`;
  if (diff < 1825) {
    const totalMonths = Math.floor((diff * 12 * 2 + 365) / (365 * 2));
    const years = Math.floor(totalMonths / 12);
    const months = totalMonths % 12;
    return months ? `${count(years, "year")}, ${count(months, "month")} ago` : `${count(years, "year")} ago`;
  }
  return `${count(Math.floor((diff + 183) / 365), "year")} ago`;
}

// How often a visible age should be redrawn: every 30 s while it is under an
// hour old (minutes still move), every 5 minutes after that.
export function commitAgeRefreshMs(thenMs: number, nowMs: number): number {
  return nowMs - thenMs < HOUR_MS ? 30_000 : 5 * MINUTE_MS;
}
