import { expect, test } from "bun:test";
import { compactWorkers } from "./compact-work";
import { workerDismissalIdentities } from "./worker-dismissal-identity";
import { visibleWorkers, workerExecutionIds } from "./worker-dismissal-client";
import type { BackgroundTaskItem, ConversationItem, ToolItem } from "./types";
import { normalizeProviderMessage } from "./opencode/v1/normalization";
import { BackgroundWorkers } from "./opencode/v2/background";
import { createClaudeEventMemory, normalizeClaudeMessage } from "./claude/normalization";

test("actual V1 and Claude terminal tool projections retain immutable launcher identities", () => {
  for (const failed of [false, true]) {
    const [v1] = normalizeProviderMessage({ info: { id: "message", role: "assistant", time: { created: 10 } }, parts: [
      { id: `call-${failed}`, type: "tool", tool: "task", state: { status: failed ? "error" : "completed", input: { description: "Review", prompt: "Review" }, time: { start: 10, end: 20 } } },
    ] });
    const memory = createClaudeEventMemory();
    normalizeClaudeMessage({ type: "assistant", uuid: "launch", timestamp: "2026-09-15T10:00:00Z", message: { content: [
      { type: "tool_use", id: `call-${failed}`, name: "Agent", input: { description: "Review", prompt: "Review" } },
    ] } }, memory, "live");
    const result = normalizeClaudeMessage({ type: "user", uuid: "result", timestamp: "2026-09-15T10:00:01Z", message: { content: [
      { type: "tool_result", tool_use_id: `call-${failed}`, content: "Done", is_error: failed },
    ] } }, memory, "live").updates[0];
    expect(result?.kind).toBe("upsert");
    if (result?.kind !== "upsert") throw new Error("missing normalized tool");
    for (const item of [v1!, result.item]) {
      expect(item.type).toBe("tool");
      const [worker] = compactWorkers([item]);
      expect(workerExecutionIds(worker!)).toEqual(workerDismissalIdentities(item));
      expect(workerExecutionIds(worker!)).toHaveLength(1);
      expect(worker!.state).toBe(failed ? "failed" : "completed");
    }
  }
});

test("actual V2 completed, failed and stopped background projections have identities without activity", () => {
  for (const [state, status] of [["completed", "completed"], ["error", "failed"], ["cancelled", "stopped"]] as const) {
    const workers = new BackgroundWorkers();
    workers.verifyChild("child", "parent");
    workers.launch("parent", { id: "call", name: "subagent", time: { created: 10, ran: 10, completed: 11 }, state: {
      status: "completed", input: { description: "Review", prompt: "Review" }, metadata: { sessionID: "child", status: "running" },
    } }, 11);
    const updates = workers.notification("parent", "result", { text: "Done", metadata: { source: "subagent", childID: "child", state } }, 20)!;
    const task = updates.find(update => update.kind === "upsert" && update.item.type === "background_task");
    expect(task?.kind).toBe("upsert");
    if (task?.kind !== "upsert") throw new Error("missing terminal background task");
    expect(task.item).toMatchObject({ status });
    expect(task.item).not.toHaveProperty("activity");
    expect(workerExecutionIds(compactWorkers([task.item])[0]!)).toContain("worker-dismissal:tool:call");
  }
});

test("launcher aliases survive pages, replay, completion and new primary order without sharing child scope", () => {
  const tool: ToolItem = { type: "tool", id: "tool:first", name: "task", input: '{"description":"Review"}', status: "completed", createdAt: 10, childConversationId: "same-child" };
  const task: BackgroundTaskItem = { type: "background_task", id: "task:run", taskId: "run", toolUseId: "first", toolUseIds: ["second", "first"], status: "completed", description: "Review", createdAt: 10, childConversationId: "same-child" };
  const saved = new Set(workerDismissalIdentities(tool));
  for (const items of [[tool], [task], [tool, task], [task, tool], JSON.parse(JSON.stringify([task, tool]))] as ConversationItem[][]) {
    expect(visibleWorkers(compactWorkers(items), saved)).toHaveLength(0);
  }
  const next = { ...task, id: "task:next", taskId: "next", toolUseId: "next", toolUseIds: ["next"] };
  expect(visibleWorkers(compactWorkers([next]), saved)).toHaveLength(1);
  const nativeOnly = { ...task, toolUseId: undefined, toolUseIds: undefined };
  expect(visibleWorkers(compactWorkers([task]), new Set(workerDismissalIdentities(nativeOnly)))).toHaveLength(0);
  for (const kind of ["working", "needs-answer"] as const) {
    const active = { ...task, status: "running" as const, activity: { kind, executionId: "positive" } };
    expect(visibleWorkers(compactWorkers([active]), saved)).toHaveLength(1);
  }
});

test("identities never borrow clocks, outcomes, a child-only scope or malformed positive aliases", () => {
  const task = { type: "background_task", id: "task:run", taskId: "run", status: "completed", createdAt: 10 };
  expect(workerDismissalIdentities(task)).toEqual(workerDismissalIdentities({ ...task, createdAt: 999, terminalReportedAt: 1000, status: "failed" }));
  expect(workerDismissalIdentities({ ...task, taskId: "child", childConversationId: "child" })).toEqual([]);
  expect(workerDismissalIdentities({ ...task, taskId: undefined, childConversationId: "child" })).toEqual([]);
  expect(workerDismissalIdentities({ ...task, activity: { kind: "unavailable" } })).toEqual(["worker-dismissal:task:run"]);
  expect(workerDismissalIdentities({ ...task, activity: { executionId: "exact", executionAliases: ["other"] } })).toEqual([]);
  expect(workerDismissalIdentities({ ...task, toolUseId: "x".repeat(513) })).toEqual([]);
});

test("optional activity primary does not erase immutable anchors, but explicit malformed identities and alias overflow refuse", () => {
  const task = { type: "background_task", id: "task:run", taskId: "run", toolUseId: "call", status: "running", activity: { kind: "working" } };
  expect(workerDismissalIdentities(task)).toEqual(["worker-dismissal:tool:call", "worker-dismissal:task:run"]);
  for (const activity of [
    { kind: "working", executionId: "" }, { kind: "working", executionId: null },
    { kind: "working", executionAliases: [] }, { kind: "working", executionAliases: ["alias"] },
    { kind: "working", executionId: "primary", executionAliases: ["primary", "primary"] },
    { kind: "working", executionId: "primary", executionAliases: ["alias"] },
  ]) {
    expect(workerDismissalIdentities({ ...task, activity })).toEqual([]);
    expect(workerExecutionIds(compactWorkers([{ ...task, activity } as unknown as BackgroundTaskItem])[0]!)).toEqual([]);
  }
  // V2 deliberately withholds its primary on proven launch-alias overflow.
  // Missing optional identity must not turn this explicit provider bound into
  // a partial occurrence alias set that silently drops old marks.
  expect(workerDismissalIdentities({ ...task, toolUseIds: Array.from({ length: 65 }, (_, i) => `call-${i}`) })).toEqual([]);
});

test("legacy subagent and fork tool rows use their own immutable calls, never the shared child", () => {
  for (const [name, input] of [["Agent", '{"description":"Review"}'], ["Skill", '{"skill":"review"}']] as const) {
    const tool: ToolItem = { type: "tool", id: "legacy-call", name, input, status: "cancelled", createdAt: 0, childConversationId: "same-child" };
    expect(workerExecutionIds(compactWorkers([tool])[0]!)).toEqual(["worker-dismissal:tool:legacy-call"]);
    const marks = new Set(workerDismissalIdentities(tool));
    expect(visibleWorkers(compactWorkers([tool, { ...tool, id: "different-call" }]), marks).map(worker => worker.id)).toEqual(["different-call"]);
  }
});
