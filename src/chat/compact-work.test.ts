import { expect, test } from "bun:test";
import { CompactDisclosure, compactWorkers, workerSummary } from "./compact-work";
import type { ConversationItem } from "./types";

test("worker projection timeline access grows linearly as retained occurrences double", () => {
  const measure = (count: number) => {
    const items: ConversationItem[] = Array.from({ length: count }, (_, index) => [
      { type: "tool", id: `tool:launch-${index}`, name: "task", status: "completed", input: '{"description":"Worker"}', createdAt: index },
      { type: "background_task", id: `worker-${index}`, taskId: `task-${index}`, toolUseId: `launch-${index}`, description: "Worker", status: "running", createdAt: index },
    ] satisfies ConversationItem[]).flat();
    let accesses = 0;
    // Observe actual reads at the public timeline boundary, not helper calls
    // or elapsed time. Both launcher correlation and task selection must scale.
    const timeline = new Proxy(items, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property)) accesses++;
        return Reflect.get(target, property, receiver);
      },
    });
    const workers = compactWorkers(timeline);
    expect(workers).toHaveLength(count);
    expect(workers.every(worker => worker.stoppable && worker.references.length === 1)).toBe(true);
    return accesses;
  };
  const small = measure(128);
  const large = measure(256);
  console.info(`compactWorkers timeline accesses: 128 workers=${small}; 256 workers=${large}`);
  expect(small).toBeGreaterThan(0);
  expect(large).toBeLessThan(small * 2.5);
});

test("finished tool workers sort by reported completion, not launch time", () => {
  const workers = compactWorkers([
    { type: "tool", id: "tool:long", name: "task", status: "completed", input: '{"description":"Long worker"}', childConversationId: "reused-child", createdAt: 1000, completedAt: 9000 },
    { type: "tool", id: "tool:short", name: "task", status: "completed", input: '{"description":"Short worker"}', childConversationId: "reused-child", createdAt: 2000, completedAt: 3000 },
  ]);
  expect(workers.map(({ id, settledAt }) => ({ id, settledAt }))).toEqual([
    { id: "tool:long", settledAt: 9000 }, { id: "tool:short", settledAt: 3000 },
  ]);
});

test("native reports outrank duration and never borrow an aliased launcher's completion", () => {
  const workers = compactWorkers([
    { type: "background_task", id: "native", taskId: "native", toolUseId: "launch", description: "Native", status: "completed", createdAt: 10, terminalReportedAt: 40, usage: { durationMs: 900, totalTokens: 1, toolUses: 0 } },
    { type: "tool", id: "tool:launch", name: "task", status: "completed", input: '{"description":"Launcher"}', createdAt: 10, completedAt: 999 },
    { type: "tool", id: "foreground", name: "task", status: "completed", input: '{"description":"Foreground"}', createdAt: 20, completedAt: 50 },
    { type: "background_task", id: "no-report", taskId: "no-report", toolUseId: "other-launch", description: "No report", status: "completed", createdAt: 5 },
    { type: "tool", id: "tool:other-launch", name: "task", status: "completed", input: '{"description":"Other launcher"}', createdAt: 5, completedAt: 1000 },
  ]);
  expect(workers.map(({ id, settledAt }) => [id, settledAt])).toEqual([["foreground", 50], ["native", 40], ["no-report", 5]]);
  expect(workers[1]).toMatchObject({ terminalReportedAt: 40, references: ["tool:launch"] });
  expect(workers[1]?.completedAt).toBeUndefined();
  expect(workers[2]?.completedAt).toBeUndefined();
  expect(workers[2]?.terminalReportedAt).toBeUndefined();
});

test("invalid native report clocks fall back to launch without becoming completion evidence", () => {
  for (const terminalReportedAt of [-1, NaN, Infinity]) {
    const [worker] = compactWorkers([{ type: "background_task", id: "worker", taskId: "worker", status: "completed", description: "Worker", createdAt: 10, terminalReportedAt }]);
    expect(worker).toMatchObject({ settledAt: 10 });
    expect(worker?.terminalReportedAt).toBeUndefined();
    expect(worker?.completedAt).toBeUndefined();
  }
});

test("all terminal outcomes share completion ordering while active and unknown workers remain oldest first", () => {
  const workers = compactWorkers([
    { type: "tool", id: "done", name: "task", input: '{"description":"Done"}', status: "completed", createdAt: 1000, completedAt: 4000 },
    { type: "tool", id: "failed", name: "task", input: '{"description":"Failed"}', status: "failed", createdAt: 2000, completedAt: 6000 },
    { type: "tool", id: "stopped", name: "task", input: '{"description":"Stopped"}', status: "cancelled", createdAt: 3000, completedAt: 5000 },
    { type: "tool", id: "working-new", name: "task", input: '{"description":"New"}', status: "running", createdAt: 20, completedAt: 1 },
    { type: "tool", id: "working-old", name: "task", input: '{"description":"Old"}', status: "running", createdAt: 10, completedAt: 99 },
    { type: "tool", id: "unknown-new", name: "task", input: '{"description":"New"}', status: "pending", createdAt: 40 },
    { type: "tool", id: "unknown-old", name: "task", input: '{"description":"Old"}', status: "pending", createdAt: 30 },
  ]);
  expect(workers.map(worker => worker.id)).toEqual(["working-old", "working-new", "unknown-old", "unknown-new", "failed", "stopped", "done"]);
  expect(workers.slice(-3).map(worker => worker.state)).toEqual(["failed", "stopped", "completed"]);
});

test("missing completion uses reported task execution duration then launch, with deterministic ties", () => {
  const workers = compactWorkers([
    { type: "tool", id: "b", name: "task", input: '{"description":"B"}', status: "completed", createdAt: 2000 },
    { type: "background_task", id: "duration", taskId: "duration", description: "Duration", status: "completed", createdAt: 1000, usage: { durationMs: 4000, totalTokens: 12, toolUses: 1 } },
    { type: "tool", id: "a", name: "task", input: '{"description":"A"}', status: "completed", createdAt: 2000 },
    { type: "background_task", id: "zero-duration", taskId: "zero-duration", description: "Zero duration", status: "stopped", createdAt: 0, usage: { durationMs: 0, totalTokens: 0, toolUses: 0 } },
  ]);
  expect(workers.map(({ id, settledAt }) => ({ id, settledAt }))).toEqual([
    { id: "duration", settledAt: 5000 }, { id: "a", settledAt: 2000 }, { id: "b", settledAt: 2000 },
    { id: "zero-duration", settledAt: 0 },
  ]);
  expect(workers.find(worker => worker.id === "a")?.completedAt).toBeUndefined();
  expect(workers.find(worker => worker.id === "duration")?.completedAt).toBeUndefined();
  const ties: ConversationItem[] = [
    { type: "tool", id: "b", name: "task", input: '{"description":"B"}', status: "completed", createdAt: 2000 },
    { type: "tool", id: "a", name: "task", input: '{"description":"A"}', status: "completed", createdAt: 1000, completedAt: 2000 },
  ];
  expect(compactWorkers(ties).map(worker => worker.id)).toEqual(["a", "b"]);
  expect(compactWorkers(ties.reverse()).map(worker => worker.id)).toEqual(["a", "b"]);
});

test("zero, equal-launch and backward completion timestamps remain raw provider facts", () => {
  const workers = compactWorkers([
    { type: "tool", id: "zero", name: "task", input: '{"description":"Zero"}', status: "completed", createdAt: 1000, completedAt: 0 },
    { type: "tool", id: "same", name: "task", input: '{"description":"Same"}', status: "completed", createdAt: 2000, completedAt: 2000 },
    { type: "tool", id: "backward", name: "task", input: '{"description":"Backward"}', status: "failed", createdAt: 9000, completedAt: 1000 },
  ]);
  expect(workers.map(({ id, settledAt }) => ({ id, settledAt }))).toEqual([
    { id: "same", settledAt: 2000 }, { id: "backward", settledAt: 1000 }, { id: "zero", settledAt: 0 },
  ]);
});

test("canonical aliases display child session metadata once, not task cost or a parent's selection", () => {
  const workerSession = { model: "Latest model", effort: null, costUsd: 0.125 };
  const workers = compactWorkers([
    { type: "tool", id: "tool:a", name: "task", input: '{"description":"Review"}', status: "completed", model: "Old task model", usage: { costUsd: 12 }, workerSession, createdAt: 1 },
    { type: "tool", id: "tool:b", name: "task", input: '{"description":"Review"}', status: "completed", workerSession, createdAt: 2 },
    { type: "background_task", id: "canonical", taskId: "native", toolUseIds: ["a", "b"], description: "Review", status: "running", createdAt: 1 },
  ]);
  expect(workers).toHaveLength(1);
  expect(workers[0]).toMatchObject({ model: "Latest model", effort: null, costUsd: 0.125 });
  expect(compactWorkers([{ type: "background_task", id: "shell", taskId: "shell", taskType: "shell", description: "Tests", status: "running", workerSession, createdAt: 1 }])[0]).not.toHaveProperty("costUsd");
});

test("canonical worker uses real launcher model and cumulative spend without double-counting aliases", () => {
  const workers = compactWorkers([
    { type: "tool", id: "tool:launch", name: "task", status: "completed", input: '{"description":"Task"}', model: "GPT-6.1 Sol", usage: { input: 200, output: 50 }, createdAt: 1 },
    { type: "background_task", id: "worker", taskId: "native", toolUseId: "launch", status: "running", description: "Worker", createdAt: 1 },
  ]);
  expect(workers).toHaveLength(1);
  expect(workers[0]).toMatchObject({ model: "GPT-6.1 Sol", tokens: 250 });
});

test("authoritative session reports clear historical model while preserving zero and unavailable metadata", () => {
  const launcher: ConversationItem = { type: "tool", id: "tool:launch", name: "task", status: "completed", input: '{"description":"Worker"}', model: "Reported task model", createdAt: 1 };
  const task = { type: "background_task", id: "worker", taskId: "native", toolUseId: "launch", description: "Worker", status: "running", createdAt: 1 } satisfies ConversationItem;
  const [withoutReport] = compactWorkers([launcher, task]);
  expect(withoutReport).toMatchObject({ model: "Reported task model" });
  expect(withoutReport).not.toHaveProperty("effort");
  expect(withoutReport).not.toHaveProperty("costUsd");
  expect(compactWorkers([launcher, { ...task, workerSession: { model: "Latest execution", effort: "high", costUsd: 1 } }])[0])
    .toMatchObject({ model: "Latest execution", effort: "high", costUsd: 1 });
  for (const costUsd of [0, null]) {
    // An omitted model in the authoritative report is not permission to
    // resurrect a historical task model after execution metadata is withdrawn.
    expect(compactWorkers([launcher, { ...task, workerSession: { effort: null, costUsd } }])[0])
      .toMatchObject({ model: undefined, effort: null, costUsd });
  }
});

test("duplicate item ids retain first launcher clocks and last session metadata", () => {
  const workers = compactWorkers([
    { type: "tool", id: "tool:duplicate", name: "task", status: "completed", input: '{"description":"First launcher"}', model: "Historical model", workerSession: { model: "Earlier report", effort: "high", costUsd: 1 }, createdAt: 10, completedAt: 30 },
    { type: "tool", id: "tool:duplicate", name: "task", status: "completed", input: '{"description":"Restated launcher"}', model: "Restated model", workerSession: { effort: null, costUsd: 0 }, createdAt: 99, completedAt: 100 },
  ]);
  expect(workers).toHaveLength(1);
  expect(workers[0]).toMatchObject({ name: "First launcher", since: 10, settledAt: 30, completedAt: 30, model: undefined, effort: null, costUsd: 0 });
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

test("desktop opens active batches, holds manual collapse until empty, and leaves settled history as-is", () => {
  const state = new CompactDisclosure();
  expect(state.paint("a", 0, "desktop")).toBe(false); // finished-only history
  expect(state.paint("a", 1, "desktop")).toBe(true);
  state.toggled(true); // delayed programmatic echo
  state.toggled(false);
  expect(state.paint("a", 2, "desktop")).toBe(false);
  expect(state.paint(null, 0, "desktop")).toBe(false);
  expect(state.paint("a", 1, "desktop")).toBe(false);
  expect(state.paint("a", 0, "desktop")).toBe(false);
  expect(state.paint("a", 1, "desktop")).toBe(true);
  expect(state.paint("a", 0, "desktop")).toBe(true);
  state.toggled(false); // closing finished history doesn't veto the next batch
  expect(state.paint("a", 1, "desktop")).toBe(true);
});

test("work seen only on touch does not auto-open finished desktop history", () => {
  const state = new CompactDisclosure();
  expect(state.paint("a", 1, "touch")).toBe(false);
  expect(state.paint("a", 0, "touch")).toBe(false);
  expect(state.paint("a", 0, "desktop")).toBe(false);
  expect(state.paint("a", 1, "touch")).toBe(false);
  expect(state.paint("a", 1, "desktop")).toBe(true);
});

test("native collapse before deferred toggle is observed before live repaint, not overwritten", () => {
  const state = new CompactDisclosure();
  expect(state.paint("a", 1, "desktop", false)).toBe(true);
  // Human closes the DOM; a stream repaint beats the browser's toggle task.
  expect(state.paint("a", 2, "desktop", false)).toBe(false);
  state.toggled(false);
  state.toggled(false);
  expect(state.paint("a", 3, "desktop", false)).toBe(false);
  expect(state.paint("a", 0, "desktop", false)).toBe(false);
  expect(state.paint("a", 1, "desktop", false)).toBe(true);
});

test("desktop and touch choices stay conversation-local and independent through mode flips", () => {
  const state = new CompactDisclosure();
  expect(state.paint("a", 1, "desktop")).toBe(true);
  expect(state.paint("a", 1, "touch")).toBe(false);
  state.toggled(false); // mode-write echo, not a desktop collapse
  expect(state.paint("a", 1, "desktop")).toBe(true);
  state.toggled(false);
  expect(state.paint("b", 1, "desktop")).toBe(true);
  state.toggled(true);
  expect(state.paint("a", 1, "desktop")).toBe(false);
  expect(state.paint("a", 1, "touch")).toBe(false);
  state.toggled(true);
  expect(state.paint("b", 1, "touch")).toBe(false);
  expect(state.paint("a", 0, "touch")).toBe(true);
  expect(state.paint("a", 1, "touch")).toBe(true);
  // Ending/restarting work while touch is selected ends desktop's batch veto,
  // without making the touch expansion a desktop user gesture.
  expect(state.paint("a", 1, "desktop")).toBe(true);
  expect(state.paint("b", 0, "desktop")).toBe(true);
});

test("page-local disclosure cache retains at most 200 conversation choices", () => {
  const state = new CompactDisclosure();
  state.paint("old");
  state.toggled(true);
  for (let index = 0; index < 200; index++) state.paint(`other-${index}`);
  expect(state.paint("old")).toBe(false);
});

test("recently revisited conversation choices survive bounded-cache eviction", () => {
  const state = new CompactDisclosure();
  state.paint("hot"); state.toggled(true);
  for (let index = 0; index < 199; index++) state.paint(`other-${index}`);
  expect(state.paint("hot")).toBe(true);
  state.paint("next");
  expect(state.paint("hot")).toBe(true);
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

test("reused task ids select only the newest occurrence with a descending-id tie-break", () => {
  const items: ConversationItem[] = [
    { type: "tool", id: "tool:old", name: "task", status: "completed", input: '{"description":"Old launcher"}', childConversationId: "child", createdAt: 1 },
    { type: "background_task", id: "z-old", taskId: "reused", toolUseId: "old", description: "Old occurrence", status: "running", childConversationId: "child", createdAt: 1 },
    { type: "tool", id: "tool:new-one", name: "task", status: "completed", input: '{"description":"New launcher"}', childConversationId: "child", createdAt: 2 },
    { type: "tool", id: "tool:new-two", name: "task", status: "completed", input: '{"description":"Alias"}', childConversationId: "child", createdAt: 2 },
    { type: "background_task", id: "a-new", taskId: "reused", toolUseIds: ["new-one", "new-two"], description: "New occurrence", status: "running", childConversationId: "child", createdAt: 2 },
    { type: "background_task", id: "B-new", taskId: "reused", description: "Uncertain occurrence", status: "running", stateUncertain: true, childConversationId: "child", createdAt: 2 },
  ];
  for (const timeline of [items, [...items].reverse()]) {
    const workers = compactWorkers(timeline);
    expect(workers.map(({ id, state, stoppable }) => ({ id, state, stoppable }))).toEqual([
      { id: "z-old", state: "working", stoppable: false },
      { id: "a-new", state: "working", stoppable: false },
      { id: "B-new", state: "unknown", stoppable: true },
    ]);
    expect(workers[0]?.references).toEqual(["tool:old"]);
    expect(workers[1]?.references.toSorted()).toEqual(["tool:new-one", "tool:new-two"]);
  }
});

test("latest foreground or terminal occurrences never authorize stopping an older background occurrence", () => {
  const workers = compactWorkers([
    { type: "background_task", id: "old-shell", taskId: "shell", taskType: "shell", description: "Old shell", status: "running", createdAt: 1 },
    { type: "background_task", id: "foreground-shell", taskId: "shell", taskType: "shell", foreground: true, description: "Foreground shell", status: "running", createdAt: 2 },
    { type: "background_task", id: "old-agent", taskId: "agent", description: "Old agent", status: "running", createdAt: 3 },
    { type: "background_task", id: "foreground-agent", taskId: "agent", foreground: true, description: "Foreground agent", status: "running", createdAt: 4 },
    { type: "background_task", id: "old-running", taskId: "terminal", description: "Old running", status: "running", createdAt: 5 },
    { type: "background_task", id: "latest-terminal", taskId: "terminal", description: "Latest terminal", status: "completed", createdAt: 6 },
  ]);
  expect(workers.map(({ id, state, stoppable }) => ({ id, state, stoppable }))).toEqual([
    { id: "old-shell", state: "working", stoppable: false },
    { id: "old-agent", state: "working", stoppable: false },
    { id: "foreground-agent", state: "working", stoppable: false },
    { id: "old-running", state: "working", stoppable: false },
    { id: "latest-terminal", state: "completed", stoppable: true },
  ]);
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
