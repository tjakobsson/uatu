import { describe, expect, test } from "bun:test";

import { clockTime, dateTime, dayLabel, fullDate, knownTime, localDayKey, localDaysBetween, nextLocalMidnight, relativeReset, resetClock, resetMoment, weekdayClock } from "./dates";

// Local wall-clock instants, so every case holds in whatever zone runs it.
const at = (month: number, day: number, hour = 12, minute = 0, year = 2026) => new Date(year, month - 1, day, hour, minute).getTime();
const weekday = (value: number) => new Date(value).toLocaleDateString([], { weekday: "short" });

describe("local calendar days", () => {
  test("days are counted by the calendar, not by 24-hour spans", () => {
    expect(localDaysBetween(at(9, 25, 23, 30), at(9, 26, 6, 0))).toBe(1);
    expect(localDaysBetween(at(9, 25, 0, 5), at(9, 25, 23, 55))).toBe(0);
    expect(localDaysBetween(at(9, 25), at(9, 22))).toBe(-3);
    // Across a (European) DST change the day count stays whole.
    expect(localDaysBetween(at(3, 28, 12), at(3, 30, 12))).toBe(2);
    expect(localDaysBetween(at(10, 24, 12), at(10, 26, 12))).toBe(2);
  });

  test("a day key is the local date and the next midnight starts the next day", () => {
    expect(localDayKey(at(9, 5, 0, 1))).toBe("2026-09-05");
    expect(localDayKey(at(12, 31, 23, 59))).toBe("2026-12-31");
    expect(nextLocalMidnight(at(9, 25, 23, 30))).toBe(new Date(2026, 8, 26).getTime());
    expect(localDayKey(nextLocalMidnight(at(12, 31, 18)))).toBe("2027-01-01");
  });
});

describe("reset wording", () => {
  test("a reset later today is a bare 24-hour clock time", () => {
    const now = at(9, 25, 14);
    expect(resetClock(at(9, 25, 23), now)).toBe("23:00");
  });

  test("a reset early tomorrow names the day although it is under 24 hours away", () => {
    const now = at(9, 25, 23, 30);
    const reset = at(9, 26, 6);
    expect(resetClock(reset, now)).toBe(`${weekday(reset)} 06:00`);
  });

  test("a reset on any later day names its weekday, never its date", () => {
    const now = at(9, 21, 9);
    const thursday = at(9, 24, 23);
    expect(resetClock(thursday, now)).toBe(`${weekday(thursday)} 23:00`);
    const nextWeek = at(10, 5, 23);
    expect(resetClock(nextWeek, now)).toBe(`${weekday(nextWeek)} 23:00`);
    expect(resetClock(nextWeek, now)).not.toContain("2026");
  });

  test("a reset already passed keeps its day and reads as now", () => {
    const now = at(9, 25, 9);
    const yesterday = at(9, 24, 23);
    expect(resetMoment(yesterday, now)).toBe(`${weekday(yesterday)} 23:00 · now`);
  });

  test("the weekday clock names the weekday whatever day it is read", () => {
    const reset = at(9, 28, 14, 5);
    expect(weekdayClock(reset)).toBe(`${weekday(reset)} 14:05`);
    expect(weekdayClock(reset)).not.toContain("now");
  });

  test("the moment pairs the clock with the time remaining", () => {
    const now = at(9, 21, 19);
    const reset = at(9, 24, 23);
    expect(resetMoment(reset, now)).toBe(`${weekday(reset)} 23:00 · in 3d 4h`);
    const later = at(10, 1, 23);
    expect(resetMoment(later, now)).toBe(`${weekday(later)} 23:00 · in 10d 4h`);
  });
});

describe("day labels", () => {
  test("today and yesterday are named; older days read their short weekday and ISO date", () => {
    const now = at(9, 25, 10);
    expect(dayLabel(at(9, 25, 0, 1), now)).toBe("Today");
    expect(dayLabel(at(9, 24, 23, 59), now)).toBe("Yesterday");
    const older = at(9, 20);
    expect(dayLabel(older, now)).toBe(`${weekday(older)} 2026-09-20`);
  });

  test("the ISO date is the local day, not the UTC one", () => {
    const now = at(9, 25, 10);
    expect(dayLabel(at(9, 5, 0, 5), now)).toEndWith(" 2026-09-05");
    expect(dayLabel(at(9, 5, 23, 55), now)).toEndWith(" 2026-09-05");
  });

  test("a day in another year carries its year; the long form for assistive technology adds it only then", () => {
    const now = at(1, 3, 10, 0, 2027);
    const lastYear = at(12, 20, 10, 0, 2026);
    expect(dayLabel(lastYear, now)).toBe(`${weekday(lastYear)} 2026-12-20`);
    expect(fullDate(lastYear, now)).toBe(new Date(lastYear).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" }));
    expect(fullDate(at(1, 1, 10, 0, 2027), now)).not.toContain("2027");
  });

  test("23:50 and 00:10 fall on different days", () => {
    expect(localDayKey(at(9, 24, 23, 50))).not.toBe(localDayKey(at(9, 25, 0, 10)));
  });
});

describe("usable times", () => {
  test("missing and placeholder times are not dated; real ones are", () => {
    expect(knownTime(0)).toBe(false);
    expect(knownTime(Number.NaN)).toBe(false);
    expect(knownTime(1_727_000_000)).toBe(false);
    expect(knownTime(at(9, 25))).toBe(true);
  });

  test("the clock time is the reader-local hour and minute, 24-hour and zero-padded", () => {
    expect(clockTime(at(9, 25, 14, 32))).toBe("14:32");
    expect(clockTime(at(9, 25, 2, 6))).toBe("02:06");
    expect(clockTime(at(9, 25, 0, 0))).toBe("00:00");
    expect(clockTime(at(9, 25, 19, 43))).not.toMatch(/AM|PM/i);
  });

  test("a full moment is short weekday, local ISO date, and 24-hour clock", () => {
    const moment = at(9, 20, 19, 43);
    expect(dateTime(moment)).toBe(`${weekday(moment)} 2026-09-20 19:43`);
    expect(dateTime(at(9, 5, 0, 5))).toEndWith(" 2026-09-05 00:05");
  });
});
