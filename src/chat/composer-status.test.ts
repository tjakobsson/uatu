import { describe, expect, test } from "bun:test";

import { composerRoutineState, latestPlanUtilization, latestRateLimit, planChip, planHasRows, planName, planReadoutRows, planSummaryLabel, planUtilizationLabel, planUtilizationLevel, rateLimitBadgeLabel, relativeReset, sessionCostLabel, sessionTotalsTitle } from "./composer-status";
import { isRateLimitStanding, RATE_LIMIT_ITEM_ID, type ConversationItem } from "./types";
import type { RateLimitStanding } from "./composer-status";

const base = { cancelling: false, submitting: false, backgroundDeclared: true, backgroundTasks: [] as [] };

describe("session totals title", () => {
  const user = (createdAt: number): ConversationItem => ({ id: `m${createdAt}`, type: "user_message", createdAt, text: "hi" });
  const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  test("a tally that began at or before the first message is the whole conversation", () => {
    expect(sessionTotalsTitle({}, [user(10)])).toBe("This conversation");
    expect(sessionTotalsTitle({ since: 5 }, [user(10)])).toBe("This conversation");
    expect(sessionTotalsTitle({ since: 10 }, [user(10)])).toBe("This conversation");
    expect(sessionTotalsTitle({ since: 10 }, [])).toBe("This conversation");
    // The oldest message decides, wherever the items put it.
    expect(sessionTotalsTitle({ since: 10 }, [user(20), user(30)])).toBe("This conversation");
  });

  test("a tally that began after the first message is stated since when, with the weekday once a day has passed", () => {
    const since = Date.parse("2026-09-02T21:33:00");
    const items = [user(since - 3_600_000), user(since + 60_000)];
    expect(sessionTotalsTitle({ since }, items, since + 5_000)).toBe(`This conversation · since ${clock(since)}`);
    const weekday = new Date(since).toLocaleDateString([], { weekday: "short" });
    expect(sessionTotalsTitle({ since }, items, since + 2 * 86_400_000)).toBe(`This conversation · since ${weekday} ${clock(since)}`);
  });
});

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

  test("the standing is the one item the agent keeps, and its absence means not limited", () => {
    const warning = notice(RATE_LIMIT_ITEM_ID, "rate-limit-warning", "warning", 1_788_400_000_000);
    const rejected = notice(RATE_LIMIT_ITEM_ID, "rate-limit-rejected", "error", 1_788_400_000_000);
    expect(latestRateLimit([warning])).toEqual({ level: "warning", message: "rate-limit-warning message", resetsAt: 1_788_400_000_000 });
    // The agent upserts that one id, so the projection holds the current
    // standing rather than a history to scan.
    expect(latestRateLimit([rejected])?.level).toBe("rejected");
    // Retired: the agent removed the item, so there is nothing to find.
    expect(latestRateLimit([])).toBeUndefined();
    // Found by its code, not by the id one producer happens to use — the
    // contract gives clients the code, and the timeline filters on it, so a
    // standing under another stable id must not vanish from both surfaces.
    const elsewhere = notice("agent:standing:7", "rate-limit-warning", "warning", 1_788_400_000_000);
    expect(latestRateLimit([elsewhere])?.level).toBe("warning");
    expect(isRateLimitStanding(elsewhere)).toBe(true);
    // Newest wins: one item id is a producer's property, not the wire's.
    expect(latestRateLimit([warning, { ...rejected, id: "agent:standing:8" }])?.level).toBe("rejected");
    // Exactly the two coded standings. A later rate-limit-adjacent notice
    // is someone else's message, not a standing to report as a warning.
    const adjacent = notice("notice:policy", "rate-limit-policy-changed", "info");
    expect(latestRateLimit([adjacent])).toBeUndefined();
    expect(isRateLimitStanding(adjacent)).toBe(false);
    expect(latestRateLimit([notice("n4", "refusal-fallback", "warning")])).toBeUndefined();
    expect(rateLimitBadgeLabel({ level: "rejected", message: "" })).toBe("Rate limited");
    expect(rateLimitBadgeLabel({ level: "warning", message: "", resetsAt: 1_788_400_000_000 })).toMatch(/^Near rate limit · resets /);
  });

  test("the chip folds the standing and the plan into one control", () => {
    const withWindows = { plan: { fiveHour: { utilization: 9 }, sevenDay: { utilization: 25 } } };
    const spentWindow = { plan: { fiveHour: { utilization: 9 }, sevenDay: { utilization: 83 } } };
    const noPlan = { plan: {}, session: { costUsd: 1.23, apiDurationMs: 42_000, durationMs: 90_000, linesAdded: 0, linesRemoved: 0, models: [] } };
    const warning: RateLimitStanding = { level: "warning", message: "Approaching your 7-day rate limit (77% used).", resetsAt: 1_788_400_000_000 };
    const rejected: RateLimitStanding = { level: "rejected", message: "Rate limit reached for your 7-day window.", resetsAt: 1_788_400_000_000 };

    // A rejection displaces the figures: blocked is the fact that matters.
    expect(planChip(withWindows, rejected)).toEqual({ text: expect.stringMatching(/^Rate limited · resets /), level: "rejected", kind: "rate-limit" });
    // A warning keeps them and raises the level — including for a window
    // the summary does not name, which is the whole reason the level is not
    // derived from the percentages.
    expect(planChip(withWindows, warning)).toEqual({ text: "Session 9% · Week 25%", level: "warning", kind: "plan" });
    expect(planChip(withWindows, undefined)).toEqual({ text: "Session 9% · Week 25%", level: "normal", kind: "plan" });
    expect(planChip(spentWindow, undefined)?.level).toBe("warning");
    // A login with no plan can still be rate limited; before this the fact
    // had nowhere to go.
    expect(planChip(noPlan, warning)).toEqual({ text: expect.stringMatching(/^Near rate limit · resets /), level: "warning", kind: "rate-limit" });
    expect(planChip(undefined, rejected)?.kind).toBe("rate-limit");
    // Unchanged without a standing: the cost chip, and nothing at all.
    expect(planChip(noPlan, undefined)).toEqual({ text: "$1.23 this conversation", level: "normal", kind: "cost" });
    expect(planChip(undefined, undefined)).toBeUndefined();
    expect(planChip({ plan: {} }, undefined)).toBeUndefined();
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

  test("the chip states the conversation's cost when the login reports no windows", () => {
    const session = { costUsd: 1.2345, apiDurationMs: 42_000, durationMs: 90_000, linesAdded: 12, linesRemoved: 3, models: [] };
    // Windows win wherever the login has them; the cost is the API-key,
    // Bedrock, and Vertex reading, whose plan comes back empty.
    expect(planSummaryLabel({ plan: { fiveHour: { utilization: 9 } }, session })).toBe("Session 9%");
    expect(planSummaryLabel({ plan: {}, session })).toBe("$1.23 this conversation");
    expect(planSummaryLabel({ session })).toBe("$1.23 this conversation");
    // Neither reading: nothing to say, and the chip stays hidden.
    expect(planSummaryLabel({ plan: {} })).toBeUndefined();
    expect(planSummaryLabel({})).toBeUndefined();
    // A cheap turn keeps its figure rather than rounding to nothing.
    expect(sessionCostLabel({ ...session, costUsd: 0.0123 })).toBe("$0.0123 this conversation");
    expect(sessionCostLabel({ ...session, costUsd: 0 })).toBe("$0.00 this conversation");
  });

  test("a plan with rows but no base percentage is a plan, not a cost-only login", () => {
    const now = Date.parse("2026-09-02T10:00:00.000Z");
    const session = { costUsd: 1.2345, apiDurationMs: 42_000, durationMs: 90_000, linesAdded: 12, linesRemoved: 3, models: [] };
    // Only a model-scoped bucket: no base summary, yet a row to draw. The
    // chip names that row; the readout classifies as a plan and shows it.
    const modelOnly = { modelScoped: [{ label: "Fable", utilization: 83.4, resetsAt: now + 3_600_000 }] };
    expect(planUtilizationLabel(modelOnly)).toBeUndefined();
    expect(planHasRows(modelOnly)).toBe(true);
    expect(planReadoutRows(modelOnly, now).map(row => row.label)).toEqual(["Week · Fable"]);
    expect(planSummaryLabel({ plan: modelOnly, session })).toBe("Week · Fable 83%");
    // Base windows that came with a reset and no figure: rows with an empty
    // meter, a chip that names the plan rather than the cost.
    const resetOnly = { fiveHour: { resetsAt: now + 35 * 60_000 }, sevenDay: { resetsAt: now + 4 * 86_400_000 } };
    expect(planUtilizationLabel(resetOnly)).toBeUndefined();
    expect(planHasRows(resetOnly)).toBe(true);
    expect(planReadoutRows(resetOnly, now).map(row => [row.key, row.utilization])).toEqual([["session", undefined], ["week", undefined]]);
    expect(planSummaryLabel({ plan: resetOnly, session })).toBe("Plan usage");
    expect(planSummaryLabel({ plan: resetOnly })).toBe("Plan usage");
    // The genuinely empty plan is the one that falls through to the cost.
    expect(planHasRows({})).toBe(false);
    expect(planHasRows({ extraUsage: { enabled: false } })).toBe(false);
    expect(planSummaryLabel({ plan: { extraUsage: { enabled: false } }, session })).toBe("$1.23 this conversation");
  });

  test("the summary warns at 80% of any window, base or per-model, or of enabled extra usage", () => {
    expect(planUtilizationLevel({ fiveHour: { utilization: 9 }, sevenDay: { utilization: 79.9 } })).toBe("normal");
    expect(planUtilizationLevel({ fiveHour: { utilization: 80 } })).toBe("warning");
    expect(planUtilizationLevel({ fiveHour: { utilization: 9 }, modelScoped: [{ label: "Fable", utilization: 83 }] })).toBe("warning");
    expect(planUtilizationLevel({ fiveHour: { utilization: 9 }, sevenDayOpus: { utilization: 95 } })).toBe("warning");
    // Enabled extra usage is a meter the readout warns on, so the chip
    // warns with it; disabled or unmeasured credits say nothing.
    expect(planUtilizationLevel({ fiveHour: { utilization: 9 }, extraUsage: { enabled: true, utilization: 99 } })).toBe("warning");
    expect(planUtilizationLevel({ extraUsage: { enabled: true, utilization: 80 } })).toBe("warning");
    expect(planUtilizationLevel({ fiveHour: { utilization: 9 }, extraUsage: { enabled: false, utilization: 99 } })).toBe("normal");
    expect(planUtilizationLevel({ fiveHour: { utilization: 9 }, extraUsage: { enabled: true, usedCredits: 95, monthlyLimit: 100 } })).toBe("normal");
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
    // Credits read as money in the login's currency; a derived 0% is a
    // figure, not a "?" (a Pro login with 85 € enabled and nothing spent).
    const euro = planReadoutRows({ fiveHour: { utilization: 30 }, extraUsage: { enabled: true, usedCredits: 0, monthlyLimit: 85, utilization: 0, currency: "EUR" } }, now);
    expect(euro[1]).toMatchObject({ key: "extra-usage", utilization: 0, note: "€0.00 of €85.00" });
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
