import { expect, test } from "bun:test";
import { CompactDisclosure, compactWorkers, workerSummary } from "./compact-work";
import type { ConversationItem } from "./types";

test("canonical worker uses real launcher model and cumulative spend without double-counting aliases", () => {
  const workers = compactWorkers([
    { type: "tool", id: "tool:launch", name: "task", status: "completed", input: '{"description":"Task"}', model: "GPT-6.1 Sol", usage: { input: 200, output: 50 }, createdAt: 1 },
    { type: "background_task", id: "worker", taskId: "native", toolUseId: "launch", status: "running", description: "Worker", createdAt: 1 },
  ]);
  expect(workers).toHaveLength(1);
  expect(workers[0]).toMatchObject({ model: "GPT-6.1 Sol", tokens: 250 });
});

test("touch disclosure is deliberate, conversation-scoped, and survives settlement and reselection", () => {
  const state = new CompactDisclosure();
  expect(state.paint("a")).toBe(false);
  state.toggled(true);
  expect(state.paint("a")).toBe(true);
  expect(state.paint(null)).toBe(true);
  expect(state.paint("b")).toBe(false);
  state.toggled(false); // async echo of the selection, not a choice for a
  expect(state.paint("a")).toBe(true);
  state.toggled(false);
  expect(state.paint("b")).toBe(false);
  expect(state.paint("a")).toBe(false);
});

test("canonical executions fold launcher aliases but keep repeated occurrences and uncertain outcomes distinct", () => {
  const items = [
    { type: "tool", id: "tool:one", name: "task", status: "completed", input: '{"description":"First reference"}', childConversationId: "child" },
    { type: "tool", id: "tool:two", name: "task", status: "completed", input: '{"description":"Second reference"}', childConversationId: "child" },
    { type: "background_task", id: "first", taskId: "reused", toolUseIds: ["one", "two"], status: "failed", description: "Failed run", childConversationId: "child" },
    { type: "background_task", id: "second", taskId: "reused", status: "running", description: "Later execution", childConversationId: "child" },
    { type: "background_task", id: "third", taskId: "other", status: "stopped", description: "Stopped run" },
    { type: "background_task", id: "unknown", taskId: "uncertain", status: "running", stateUncertain: true, description: "Unknown run" },
    { type: "tool", id: "tool:shell", name: "shell", status: "running", input: "fixture" },
  ] as ConversationItem[];
  const workers = compactWorkers(items);
  expect(workers).toHaveLength(4);
  expect(workers.find(worker => worker.id === "first")?.references).toEqual(["tool:one", "tool:two"]);
  expect(workerSummary(workers)).toBe("1 working · 2 finished · 1 unknown");
  expect(workers.find(worker => worker.id === "first")?.state).toBe("failed");
  expect(workers.find(worker => worker.id === "third")?.state).toBe("stopped");
  expect(workerSummary([])).toBe("No workers");
});

test("pending/generating is not confirmed working and failed tools are finished, not successful", () => {
  const workers = compactWorkers([
    { type: "tool", id: "task", name: "task", status: "pending", input: '{"description":"Pending task"}' },
    { type: "command", id: "shell", command: "fixture", status: "error" },
    { type: "text", id: "text", text: "generating" },
  ] as ConversationItem[]);
  expect(workerSummary(workers)).toBe("1 unknown");
});

test("worker summaries describe only visible work without losing terminal outcomes", () => {
  const workers = compactWorkers([
    { type: "background_task", id: "live", taskId: "live", description: "Live", status: "running", createdAt: 1 },
    { type: "background_task", id: "failed", taskId: "failed", description: "Failed", status: "failed", createdAt: 2 },
    { type: "background_task", id: "stopped", taskId: "stopped", description: "Stopped", status: "stopped", createdAt: 3 },
  ]);
  expect(workerSummary(workers.filter(worker => worker.state === "working"))).toBe("1 working");
  expect(workerSummary(workers.filter(worker => worker.state !== "working"))).toBe("2 finished");
  expect(workerSummary(workers)).toBe("1 working · 2 finished");
  expect(workerSummary([])).toBe("No workers");
});

test("active workers precede newest-first history; only real background shell tasks are workers", () => {
  const workers = compactWorkers([
    { type: "background_task", id: "old", taskId: "old", description: "Old result", status: "completed", createdAt: 1 },
    { type: "background_task", id: "new", taskId: "new", taskType: "local_bash", description: "Background test suite", status: "failed", createdAt: 10 },
    { type: "command", id: "foreground", command: "pwd", status: "running", createdAt: 11 },
    { type: "background_task", id: "foreground-shell", taskId: "fg-shell", taskType: "shell", foreground: true, description: "Blocking command", status: "running", createdAt: 11 },
    { type: "background_task", id: "live", taskId: "live", description: "Live worker", status: "running", createdAt: 12 },
  ] as ConversationItem[]);
  expect(workers.map(worker => worker.id)).toEqual(["live", "new", "old"]);
  expect(workers[1]?.kind).toBe("shell");
  expect(workers[1]?.name).toBe("Background test suite");
});
