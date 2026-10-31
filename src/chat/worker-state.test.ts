import { expect, test } from "bun:test";
import { unverifyWorkerTask, workerCanStop, workerExecutionClockRuns, workerState, workerStateLabel } from "./worker-state";
import type { BackgroundTaskItem, WorkerActivity } from "./types";

const task: BackgroundTaskItem = { id: "task", type: "background_task", taskId: "execution", description: "Worker", createdAt: 1, status: "running", taskType: "agent" };

test("verified activity is Working independently of unavailable Stop proof", () => {
  const active = { ...task, stateUncertain: true, activity: { kind: "working" as const }, control: { available: false } };
  expect(workerState(active.status, active.stateUncertain, active.activity)).toBe("working");
  expect(workerStateLabel(active.status, active.stateUncertain, active.activity)).toBe("Working");
  expect(workerExecutionClockRuns(active)).toBe(true);
  expect(workerCanStop(active)).toBe(false);
});

test.each(["checking", "session-active", "unavailable", "ended"] as const)("%s is unresolved, not running, despite historical metadata", kind => {
  const unresolved = { ...task, activity: { kind } };
  expect(workerState(task.status, false, unresolved.activity)).toBe("unknown");
  expect(workerExecutionClockRuns(unresolved)).toBe(false);
  expect(workerCanStop(unresolved)).toBe(false);
});

test("a blocking request counts as Working but has no productive execution clock", () => {
  const activity: WorkerActivity = { kind: "needs-answer", request: { id: "question", kind: "question" } };
  expect(workerState("running", true, activity)).toBe("working");
  expect(workerStateLabel("running", true, activity)).toBe("Needs your answer");
  expect(workerExecutionClockRuns({ ...task, activity })).toBe(false);
});

test("activity labels distinguish checks, ambiguous sessions and missing results", () => {
  expect(workerStateLabel("running", false, { kind: "checking" })).toBe("Checking status…");
  expect(workerStateLabel("running", false, { kind: "session-active" })).toBe("Session active · task unverified");
  expect(workerStateLabel("running", false, { kind: "ended" })).toBe("Ended · result unavailable");
  expect(workerStateLabel("running", false, { kind: "unavailable" })).toBe("Status unavailable · last seen unknown");
  expect(workerStateLabel("running", true, { kind: "unavailable", observedAt: 123 })).toStartWith("Status unavailable · last seen ");
});

test("legacy supported providers retain live and terminal vocabulary without granting uncertain Stop", () => {
  expect(workerState("running")).toBe("working");
  expect(workerState("completed")).toBe("completed");
  expect(workerState("error")).toBe("failed");
  expect(workerState("cancelled")).toBe("stopped");
  expect(workerState("running", true)).toBe("unknown");
  expect(workerCanStop(task)).toBe(true);
  expect(workerCanStop({ ...task, stateUncertain: true })).toBe(false);
  expect(workerCanStop({ ...task, foreground: true })).toBe(false);
  expect(workerState("completed", false, { kind: "working" })).toBe("completed");
});

test("an observation gap drops current activity without losing last-seen identity or inventing an end", () => {
  const active = { ...task, activity: { kind: "working" as const, executionId: "run", observedAt: 50, generation: 3 }, control: { available: true } };
  const unavailable = unverifyWorkerTask(active);
  expect(unavailable).toMatchObject({ stateUncertain: true, activity: { kind: "unavailable", observedAt: 50, executionId: "run", generation: 3 }, control: { available: false } });
  expect(workerState(unavailable.status, unavailable.stateUncertain, unavailable.activity)).toBe("unknown");
  expect(unavailable.activity?.endedAt).toBeUndefined();
  expect(active.activity.kind).toBe("working");
  const ended = { ...active, activity: { ...active.activity, kind: "ended" as const, endedAt: 60 } };
  expect(unverifyWorkerTask(ended).activity).toEqual(ended.activity);
  const request = { ...active, activity: { ...active.activity, kind: "needs-answer" as const, request: { id: "q", kind: "question" as const } } };
  expect(unverifyWorkerTask(request).activity?.request).toBeUndefined();
});
