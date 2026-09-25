// The next time a Claude Code session cron fires, read from its five-field
// expression, for display only: the CLI keeps its own clock and fires on it.
// A session cron's schedule is evaluated in the host's local time (a one-shot
// wakeup is encoded as minute and hour, e.g. "3 20 * * *" — spike, D2), so
// this reads the same local clock. Supported syntax is the vixie-cron core:
// `*`, numbers, `a-b` ranges, `,` lists, and `/n` steps; day-of-week 0–7 with
// both 0 and 7 meaning Sunday; when both day fields are restricted a day
// matches either (the cron rule). Anything else yields no reading.

type CronFields = {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
};

const MINUTE_MS = 60_000;
// Far enough to reach a leap-day expression from any start.
const SEARCH_DAYS = 366 * 8;

function parseField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) return null;
    const [, range, stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;
    let low = min;
    let high = max;
    if (range !== "*") {
      const [from, to] = range!.split("-").map(Number);
      low = from!;
      // "5/15" means from 5 to the end, stepping; a bare "5" is just 5.
      high = to ?? (stepText === undefined ? from! : max);
    }
    if (low < min || high > max || low > high) return null;
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return values;
}

function parseCron(expression: string): CronFields | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const minutes = parseField(minute, 0, 59);
  const hours = parseField(hour, 0, 23);
  const days = parseField(day, 1, 31);
  const months = parseField(month, 1, 12);
  const weekdays = parseField(weekday, 0, 7);
  if (!minutes || !hours || !days || !months || !weekdays) return null;
  if (weekdays.has(7)) weekdays.add(0);
  return { minutes, hours, days, months, weekdays, daysRestricted: day !== "*", weekdaysRestricted: weekday !== "*" };
}

function dayMatches(fields: CronFields, date: Date): boolean {
  const byDay = fields.days.has(date.getDate());
  const byWeekday = fields.weekdays.has(date.getDay());
  if (fields.daysRestricted && fields.weekdaysRestricted) return byDay || byWeekday;
  if (fields.daysRestricted) return byDay;
  if (fields.weekdaysRestricted) return byWeekday;
  return true;
}

/**
 * The first minute strictly after `after` (epoch ms) that the expression
 * matches, as epoch ms; undefined for an expression this does not read or
 * one that never matches (e.g. "0 0 31 2 *").
 */
export function nextCronFire(expression: string, after: number): number | undefined {
  const fields = parseCron(expression);
  if (!fields) return undefined;
  const cursor = new Date(after);
  cursor.setSeconds(0, 0);
  cursor.setTime(cursor.getTime() + MINUTE_MS);
  const limit = after + SEARCH_DAYS * 24 * 60 * MINUTE_MS;
  while (cursor.getTime() <= limit) {
    if (!fields.months.has(cursor.getMonth() + 1)) {
      // First minute of the next month.
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(fields, cursor)) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!fields.hours.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!fields.minutes.has(cursor.getMinutes())) {
      cursor.setTime(cursor.getTime() + MINUTE_MS);
      continue;
    }
    return cursor.getTime();
  }
  return undefined;
}
