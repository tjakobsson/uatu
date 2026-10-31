import { expect, test } from "bun:test";
import { compactWorkers, workerSummary } from "./compact-work";
import type { BackgroundTaskItem } from "./types";

const task: BackgroundTaskItem = { id: "task", type: "background_task", taskId: "run", description: "Worker", status: "running", createdAt: 10, taskType: "agent" };

test("compact projection preserves activity evidence independently of Stop uncertainty", () => {
  const activity = { kind: "working" as const, executionId: "execution:one", observedAt: 20 };
  const [worker] = compactWorkers([{ ...task, activity, stateUncertain: true, control: { available: false, reason: "Control evidence unavailable" } }]);
  expect(worker).toMatchObject({ state: "working", activity, controlAvailable: false, clockRunning: true });
  expect(workerSummary([worker!])).toBe("1 working");
});

test("summary shares one activity classification for blocked, checking, missing and finished work", () => {
  const workers = compactWorkers([
    { ...task, id: "blocked", taskId: "blocked", activity: { kind: "needs-answer", request: { id: "q", kind: "question" } } },
    { ...task, id: "checking", taskId: "checking", activity: { kind: "checking" } },
    { ...task, id: "session", taskId: "session", activity: { kind: "session-active" } },
    { ...task, id: "missing", taskId: "missing", activity: { kind: "unavailable", observedAt: 5 } },
    { ...task, id: "ended", taskId: "ended", activity: { kind: "ended", endedAt: 9 } },
    { ...task, id: "failed", taskId: "failed", status: "failed" },
    { ...task, id: "stopped", taskId: "stopped", status: "stopped" },
  ]);
  expect(workerSummary(workers)).toBe("1 working · 4 unresolved · 2 finished");
  expect(workers.filter(worker => worker.clockRunning)).toHaveLength(0);
  expect(workers.find(worker => worker.id === "ended")?.state).toBe("unknown");
});
