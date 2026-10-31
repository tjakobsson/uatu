import { expect, test } from "bun:test";
import { observeWorkerProjection, workerDismissalEvidence, workerDismissalEvidenceForItem } from "./worker-dismissals-observation";
import type { WorkerDismissalsStore } from "./worker-dismissals";

test("observation accepts only exact authoritative parent/execution positives and leaves requests untouched", () => {
  const calls: unknown[] = [];
  const store = { observe: (...args: unknown[]) => { calls.push(args); } } as unknown as WorkerDismissalsStore;
  const task = { type: "background_task", status: "running", activity: { kind: "needs-answer", executionId: "v1:exact", request: { kind: "question", id: "canonical" } } };
  const question = { type: "question", id: "canonical", status: "pending" };
  const snapshot = { conversation: { id: "opencode:parent" }, items: [task, question] };
  const before = structuredClone(snapshot);
  observeWorkerProjection(store, "ws", "opencode:parent", snapshot);
  observeWorkerProjection(store, "ws", "opencode:parent", { type: "item.upsert", conversationId: "opencode:parent", item: task });
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject(["ws", "opencode:parent", [{ executionId: "v1:exact", active: true, dismissible: false }]]);
  for (const kind of ["checking", "unavailable", "session-active", "ended"]) observeWorkerProjection(store, "ws", "opencode:parent", { ...snapshot, items: [{ ...task, activity: { ...task.activity, kind } }] });
  observeWorkerProjection(store, "ws", "opencode:foreign", snapshot);
  observeWorkerProjection(store, "ws", "opencode:foreign", { type: "item.upsert", conversationId: "opencode:parent", item: task });
  observeWorkerProjection(store, "ws", "opencode:parent", { ...snapshot, items: [{ ...task, activity: { kind: "working" } }] });
  expect(calls).toHaveLength(2);
  expect(snapshot).toEqual(before);
});

test("observation signatures exclude aging observation clocks but bound identities and request references", () => {
  const item = { type: "background_task", status: "running", activity: { kind: "working", executionId: "v1:exact", observedAt: 1 } };
  expect(workerDismissalEvidence(item)).toEqual(workerDismissalEvidence({ ...item, activity: { ...item.activity, observedAt: 999 } }));
  for (const activity of [{ executionId: "x".repeat(513) }, { generation: -1 }, { request: { id: "x".repeat(513), kind: "question" } }]) {
    expect(workerDismissalEvidence({ ...item, activity: { ...item.activity, ...activity } })).toBeNull();
  }
});

test("all positively proven aliases share one signature, while malformed alias sets remain untrusted", () => {
  const item = { type: "background_task", status: "running", activity: { kind: "working", executionId: "A", executionAliases: ["A", "B"] } };
  const evidence = workerDismissalEvidenceForItem(item);
  expect(evidence.map(entry => entry.executionId)).toEqual(["A", "B"]);
  expect(new Set(evidence.map(entry => entry.signature)).size).toBe(1);
  for (const executionAliases of [["B"], ["A", "A"], ["A", "x".repeat(513)], Array.from({ length: 2049 }, (_, i) => i === 0 ? "A" : String(i))]) {
    expect(workerDismissalEvidenceForItem({ ...item, activity: { ...item.activity, executionAliases } })).toEqual([]);
  }
});

test("terminal identities authorize private reads but the trusted hook still observes only positive active evidence", () => {
  const calls: unknown[] = [];
  const store = { observe: (...args: unknown[]) => { calls.push(args); } } as unknown as WorkerDismissalsStore;
  const task = { type: "background_task", id: "task:run", taskId: "run", toolUseId: "launch", status: "completed" };
  const tool = { type: "tool", id: "tool:launch", name: "Agent", input: '{"description":"Review"}', status: "cancelled" };
  for (const item of [task, tool]) {
    expect(workerDismissalEvidenceForItem(item)[0]).toMatchObject({ executionId: "worker-dismissal:tool:launch", active: false, dismissible: true });
    observeWorkerProjection(store, "ws", "opencode:parent", { type: "item.upsert", conversationId: "opencode:parent", item });
  }
  expect(calls).toHaveLength(0);
  observeWorkerProjection(store, "ws", "opencode:parent", { type: "item.upsert", conversationId: "opencode:parent", item: {
    ...task, status: "running", activity: { kind: "needs-answer", executionId: "positive", request: { kind: "question", id: "canonical" } },
  } });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject(["ws", "opencode:parent", [
    { executionId: "worker-dismissal:tool:launch", active: true, dismissible: false },
    { executionId: "worker-dismissal:task:run", active: true, dismissible: false },
    { executionId: "positive", active: true, dismissible: false },
  ]]);
});
