import { describe, expect, test } from "bun:test";

import { composerRoutineState, latestPlanUtilization, latestRateLimit, planUtilizationLabel, rateLimitBadgeLabel } from "./composer-status";
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
    expect(planUtilizationLabel(latestPlanUtilization([report])!)).toBe("Plan 37% of 5h · 12% of 7d");
    expect(planUtilizationLabel({ sevenDay: { utilization: 3 } })).toBe("Plan 3% of 7d");
    expect(planUtilizationLabel({})).toBeUndefined();
    // An API-key session states an empty plan; the newest statement decides.
    expect(latestPlanUtilization([report, apiKeyReport])).toEqual({});
    // A compaction's post-count says nothing about the plan: the last one stands.
    expect(latestPlanUtilization([report, compactionReport])).toEqual(report.plan);
    expect(latestPlanUtilization([])).toBeUndefined();
  });
});
