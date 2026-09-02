import { describe, expect, test } from "bun:test";

import { composerRoutineState, latestPlanUtilization, latestRateLimit, planName, planReadoutRows, planUtilizationLabel, planUtilizationLevel, rateLimitBadgeLabel, relativeReset } from "./composer-status";
import type { ConversationItem } from "./types";

const base = { cancelling: false, submitting: false, backgroundDeclared: true, backgroundTasks: [] as [] };

describe("composer routine state", () => {
  test("each conversation status maps to a named state with an accessible label", () => {
    expect(composerRoutineState({ ...base, status: "running" })).toEqual({ stateName: "working", label: "Working" });
    expect(composerRoutineState({ ...base, status: "sending" })).toEqual({ stateName: "sending", label: "Sending" });
    expect(composerRoutineState({ ...base, status: "retrying", statusMessage: "attempt 2 of 10, HTTP 529" })).toEqual({ stateName: "retrying", label: "Retrying (attempt 2 of 10, HTTP 529)" });
    expect(composerRoutineState({ ...base, status: "retrying" })).toEqual({ stateName: "retrying", label: "Retrying" });
    expect(composerRoutineState({ ...base, status: "compacting" })).toEqual({ stateName: "compacting", label: "Compacting context" });
    expect(composerRoutineState({ ...base, status: "failed" })).toEqual({ stateName: "failed", label: "Failed" });
    expect(composerRoutineState({ ...base, status: "completed" })).toEqual({ stateName: "ready", label: "Completed" });
    expect(composerRoutineState({ ...base, status: undefined })).toEqual({ stateName: "ready", label: "Select a conversation" });
  });

  test("cancelling and sending outrank the conversation's own state; a retry is still a live turn", () => {
    expect(composerRoutineState({ ...base, status: "retrying", cancelling: true })).toEqual({ stateName: "cancelling", label: "Cancelling" });
    expect(composerRoutineState({ ...base, status: "completed", submitting: true })).toEqual({ stateName: "sending", label: "Sending" });
    // A submission during a live turn is held, so the turn's state stays.
    expect(composerRoutineState({ ...base, status: "compacting", submitting: true }).stateName).toBe("compacting");
  });

  test("background work names its count only where the agent declares it", () => {
    const task: ConversationItem = { id: "task:1", type: "background_task", createdAt: 1, taskId: "1", description: "Sleep then report", status: "running" };
    expect(composerRoutineState({ ...base, status: "background", backgroundTasks: [task] as never })).toEqual({ stateName: "background", label: "1 background task running · Sleep then report" });
    expect(composerRoutineState({ ...base, status: "background", backgroundDeclared: false })).toEqual({ stateName: "ready", label: "Ready" });
  });
});

describe("rate-limit badge and plan utilization", () => {
  const notice = (id: string, code: string, level: "warning" | "error" | "info", resetsAt?: number): ConversationItem => ({ id, type: "notice", createdAt: 1, level, message: `${code} message`, code, ...(resetsAt === undefined ? {} : { resetsAt }) });

  test("the newest rate-limit notice stands until a clearing one retires it", () => {
    const warning = notice("n1", "rate-limit-warning", "warning", 1_788_400_000_000);
    const rejected = notice("n2", "rate-limit-rejected", "error", 1_788_400_000_000);
    expect(latestRateLimit([warning])).toEqual({ level: "warning", message: "rate-limit-warning message", resetsAt: 1_788_400_000_000 });
    expect(latestRateLimit([warning, rejected])?.level).toBe("rejected");
    expect(latestRateLimit([warning, rejected, notice("n3", "rate-limit-cleared", "info")])).toBeUndefined();
    expect(latestRateLimit([notice("n4", "refusal-fallback", "warning")])).toBeUndefined();
    expect(rateLimitBadgeLabel({ level: "rejected", message: "" })).toBe("Rate limited");
    expect(rateLimitBadgeLabel({ level: "warning", message: "", resetsAt: 1_788_400_000_000 })).toMatch(/^Near rate limit · resets /);
  });

  test("plan utilization reads the newest report and is absent without one", () => {
    const report: ConversationItem = { id: "context:1", type: "context_report", createdAt: 2, total: 100, max: 200_000, plan: { fiveHour: { utilization: 37.4, resetsAt: 1 }, sevenDay: { utilization: 12 } } };
    const apiKeyReport: ConversationItem = { id: "context:2", type: "context_report", createdAt: 3, total: 100, max: 200_000, plan: {} };
    const compactionReport: ConversationItem = { id: "context:3", type: "context_report", createdAt: 4, total: 40 };
    expect(planUtilizationLabel(latestPlanUtilization([report])!)).toBe("Session 37% · Week 12%");
    expect(planUtilizationLabel({ sevenDay: { utilization: 3 } })).toBe("Week 3%");
    expect(planUtilizationLabel({})).toBeUndefined();
    // An API-key session states an empty plan; the newest statement decides.
    expect(latestPlanUtilization([report, apiKeyReport])).toEqual({});
    // A compaction's post-count says nothing about the plan: the last one stands.
    expect(latestPlanUtilization([report, compactionReport])).toEqual(report.plan);
    expect(latestPlanUtilization([])).toBeUndefined();
  });

  test("the summary warns at 80% of any window, base or per-model", () => {
    expect(planUtilizationLevel({ fiveHour: { utilization: 9 }, sevenDay: { utilization: 79.9 } })).toBe("normal");
    expect(planUtilizationLevel({ fiveHour: { utilization: 80 } })).toBe("warning");
    expect(planUtilizationLevel({ fiveHour: { utilization: 9 }, modelScoped: [{ label: "Fable", utilization: 83 }] })).toBe("warning");
    expect(planUtilizationLevel({ fiveHour: { utilization: 9 }, sevenDayOpus: { utilization: 95 } })).toBe("warning");
    // Extra usage is credits, not a window: it never trips the chip.
    expect(planUtilizationLevel({ fiveHour: { utilization: 9 }, extraUsage: { enabled: true, utilization: 99 } })).toBe("normal");
    expect(planUtilizationLevel({})).toBe("normal");
  });

  test("readout rows keep a fixed order and name per-model windows under their own labels", () => {
    const now = Date.parse("2026-09-02T10:00:00.000Z");
    const rows = planReadoutRows({
      subscription: "max",
      sevenDayOauthApps: { utilization: 0, resetsAt: now + 4 * 86_400_000 + 11 * 3_600_000 },
      modelScoped: [{ label: "Fable", utilization: 83, resetsAt: now + 4 * 86_400_000 + 11 * 3_600_000 }],
      sevenDaySonnet: { utilization: 4 },
      sevenDayOpus: { utilization: 61, resetsAt: now + 4 * 86_400_000 + 11 * 3_600_000 },
      sevenDay: { utilization: 25, resetsAt: now + 4 * 86_400_000 + 11 * 3_600_000 },
      fiveHour: { utilization: 9, resetsAt: now + 35 * 60_000 },
      extraUsage: { enabled: true, usedCredits: 12.5, monthlyLimit: 100, utilization: 12.5, currency: "USD" },
    }, now);
    expect(rows.map(row => row.label)).toEqual(["Session", "Week", "Week · Opus", "Week · Sonnet", "Week · Fable", "Week · OAuth apps", "Extra usage"]);
    expect(rows[0]).toMatchObject({ key: "session", utilization: 9 });
    expect(rows[0]!.resetLabel).toMatch(/^resets \d{1,2}:\d{2}( [AP]M)? · in 35m$/);
    expect(rows[1]!.resetLabel).toMatch(/^resets \w{3} \d{1,2}:\d{2}( [AP]M)? · in 4d 11h$/);
    expect(rows[3]).toEqual({ key: "week-sonnet", label: "Week · Sonnet", utilization: 4, resetLabel: "" });
    expect(rows[6]).toMatchObject({ key: "extra-usage", utilization: 12.5, note: "$12.50 of $100.00" });
    expect(planName({ subscription: "max" })).toBe("Max plan");
    expect(planName({})).toBeUndefined();
    // A minimal report degrades to its two rows; disabled extra usage is not a row.
    expect(planReadoutRows({ fiveHour: { utilization: 1 }, sevenDay: { utilization: 2 }, extraUsage: { enabled: false } }, now).map(row => row.key)).toEqual(["session", "week"]);
    expect(planReadoutRows({}, now)).toEqual([]);
  });

  test("relative resets read in the largest useful unit", () => {
    const now = Date.parse("2026-09-02T10:00:00.000Z");
    expect(relativeReset(now + 35 * 60_000, now)).toBe("in 35m");
    expect(relativeReset(now + 2 * 3_600_000 + 5 * 60_000, now)).toBe("in 2h 05m");
    expect(relativeReset(now + 4 * 86_400_000 + 11 * 3_600_000 + 40 * 60_000, now)).toBe("in 4d 11h");
    expect(relativeReset(now + 10_000, now)).toBe("now");
    expect(relativeReset(now - 60_000, now)).toBe("now");
  });
});
