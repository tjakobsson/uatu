import { describe, expect, test } from "bun:test";
import { nextCronFire } from "./cron";

// Local-time constructors throughout: the evaluator reads the host's local
// clock, as the CLI does, so the tests hold in any zone.
const at = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0) =>
  new Date(year, month - 1, day, hour, minute, second).getTime();

describe("nextCronFire", () => {
  test("a one-shot wakeup (minute and hour) fires later the same day, or the next day once passed", () => {
    // The spike's shape: ScheduleWakeup(60 s) at 20:01:07 became "3 20 * * *".
    expect(nextCronFire("3 20 * * *", at(2026, 9, 24, 20, 1, 7))).toBe(at(2026, 9, 24, 20, 3));
    expect(nextCronFire("3 20 * * *", at(2026, 9, 24, 20, 3, 0))).toBe(at(2026, 9, 25, 20, 3));
  });

  test("a recurring expression fires at its next match, strictly after the given time", () => {
    expect(nextCronFire("* * * * *", at(2026, 9, 24, 20, 1, 7))).toBe(at(2026, 9, 24, 20, 2));
    expect(nextCronFire("*/15 * * * *", at(2026, 9, 24, 20, 1))).toBe(at(2026, 9, 24, 20, 15));
    expect(nextCronFire("0 9 * * 1-5", at(2026, 9, 25, 10))).toBe(at(2026, 9, 28, 9)); // Friday → Monday
    expect(nextCronFire("5,35 8-9 * * *", at(2026, 9, 24, 8, 40))).toBe(at(2026, 9, 24, 9, 5));
    expect(nextCronFire("30/10 * * * *", at(2026, 9, 24, 20, 51))).toBe(at(2026, 9, 24, 21, 30));
  });

  test("month and day-of-week boundaries: year rollover, month ends, Sunday as 0 or 7, and either day field", () => {
    expect(nextCronFire("0 0 1 1 *", at(2026, 12, 31, 23, 59))).toBe(at(2027, 1, 1, 0, 0));
    expect(nextCronFire("0 12 31 * *", at(2026, 9, 1))).toBe(at(2026, 10, 31, 12)); // September has no 31st
    expect(nextCronFire("0 0 29 2 *", at(2026, 3, 1))).toBe(at(2028, 2, 29)); // next leap day
    expect(nextCronFire("0 10 * * 0", at(2026, 9, 24))).toBe(at(2026, 9, 27, 10));
    expect(nextCronFire("0 10 * * 7", at(2026, 9, 24))).toBe(at(2026, 9, 27, 10));
    // Both day fields restricted: the 1st of the month OR a Monday, whichever comes first.
    expect(nextCronFire("0 8 1 * 1", at(2026, 9, 24))).toBe(at(2026, 9, 28, 8));
    expect(nextCronFire("0 8 1 * 1", at(2026, 9, 29))).toBe(at(2026, 10, 1, 8));
  });

  test("an expression it cannot read, or one that never matches, has no reading", () => {
    for (const expression of ["", "* * * *", "61 * * * *", "* * * * MON", "@daily", "*/0 * * * *", "5-2 * * * *"]) {
      expect(nextCronFire(expression, at(2026, 9, 24))).toBeUndefined();
    }
    expect(nextCronFire("0 0 31 2 *", at(2026, 9, 24))).toBeUndefined();
  });
});
