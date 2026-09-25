import { describe, expect, test } from "bun:test";

import { pausedStatusLabel, pausedWakeups, pendingWakeups, wakeupFireTime } from "./scheduled-wakeups";
import type { ConversationItem } from "./types";

const at = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime();
const clock = (time: number) => new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

describe("scheduled wakeups", () => {
  test("pending wakeups only, soonest first, unreadable schedules last", () => {
    const wakeup = (id: string, status: "pending" | "fired", nextFireAt?: number): ConversationItem => ({ id: `wakeup:${id}`, type: "scheduled_wakeup", createdAt: 1, wakeupId: id, prompt: id, recurring: false, schedule: "* * * * *", ...(nextFireAt === undefined ? {} : { nextFireAt }), status });
    expect(pendingWakeups([wakeup("late", "pending", 30), wakeup("done", "fired"), wakeup("odd", "pending"), wakeup("soon", "pending", 10)]).map(item => item.wakeupId)).toEqual(["soon", "late", "odd"]);
  });

  test("paused crons are their own list with their own label", () => {
    const paused = (id: string, createdAt: number): ConversationItem => ({ id: `wakeup:${id}`, type: "scheduled_wakeup", createdAt, wakeupId: id, prompt: id, recurring: true, schedule: "* * * * *", status: "paused" });
    const list = pausedWakeups([paused("b", 2), paused("a", 1)]);
    expect(list.map(item => item.wakeupId)).toEqual(["a", "b"]);
    expect(pendingWakeups(list)).toEqual([]);
    expect(pausedStatusLabel(list.slice(0, 1))).toBe("1 schedule paused · fires again when this conversation runs");
    expect(pausedStatusLabel(list)).toBe("2 schedules paused · fire again when this conversation runs");
  });

  test("a fire time is always 'about', with the day once it is not today", () => {
    const now = at(9, 24, 20, 1);
    expect(wakeupFireTime(at(9, 24, 20, 3), now)).toBe(`about ${clock(at(9, 24, 20, 3))}`);
    expect(wakeupFireTime(at(9, 25, 9), now)).toBe(`about ${new Date(at(9, 25, 9)).toLocaleDateString([], { weekday: "short" })} ${clock(at(9, 25, 9))}`);
    expect(wakeupFireTime(at(10, 5, 9), now)).toBe(`about ${new Date(at(10, 5, 9)).toLocaleDateString([], { day: "numeric", month: "short" })} ${clock(at(10, 5, 9))}`);
    expect(wakeupFireTime(undefined, now)).toBeUndefined();
  });
});
