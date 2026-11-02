import { expect, test } from "bun:test";
import { compactWorkers } from "./compact-work";
import { workerDismissalIdentities } from "./worker-dismissal-identity";
import { WorkerDismissalClient, visibleWorkers, workerExecutionIds } from "./worker-dismissal-client";
import { createOpenCodeV2Provider } from "./opencode/v2/provider";
import { workerDismissalEvidenceForItem } from "../hub/worker-dismissals-observation";
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

test("low-level completed, failed and stopped correlation rows retain fallback before the public provider activity overlay", () => {
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
  expect(workerDismissalIdentities({ ...task, activity: { kind: "unavailable" } })).toEqual([]);
  expect(workerDismissalIdentities({ ...task, activity: { executionId: "exact", executionAliases: ["other"] } })).toEqual([]);
  expect(workerDismissalIdentities({ ...task, toolUseId: "x".repeat(513) })).toEqual([]);
});

test("an activity envelope without a proven primary refuses fallback, as do malformed identities and alias overflow", () => {
  const task = { type: "background_task", id: "task:run", taskId: "run", toolUseId: "call", status: "running", activity: { kind: "working" } };
  expect(workerDismissalIdentities(task)).toEqual([]);
  for (const activity of [
    { kind: "working", executionId: "" }, { kind: "working", executionId: null },
    { kind: "working", executionAliases: [] }, { kind: "working", executionAliases: ["alias"] },
    { kind: "working", executionId: "primary", executionAliases: ["primary", "primary"] },
    { kind: "working", executionId: "primary", executionAliases: ["alias"] },
  ]) {
    expect(workerDismissalIdentities({ ...task, activity })).toEqual([]);
    expect(workerExecutionIds(compactWorkers([{ ...task, activity } as unknown as BackgroundTaskItem])[0]!)).toEqual([]);
  }
  for (const executionId of ["x".repeat(513), "é".repeat(257), "opaque\nidentity"]) {
    expect(workerDismissalIdentities({ ...task, activity: { kind: "unavailable", executionId } })).toEqual([]);
  }
  // V2 deliberately withholds its primary on proven launch-alias overflow.
  // Missing optional identity must not turn this explicit provider bound into
  // a partial occurrence alias set that silently drops old marks.
  expect(workerDismissalIdentities({ ...task, toolUseIds: Array.from({ length: 65 }, (_, i) => `call-${i}`) })).toEqual([]);
});

// Drive the public provider, not its lower-level correlation projection: the
// provider always adds an activity envelope, even when identity is withheld.
for (const [shape, terminal] of [["notification-only", true], ["missing-run", false], ["missing-run", true]] as const) {
  test(`public V2 ${shape} terminal=${terminal} ${shape === "notification-only" ? "admits only a notification-scoped mark" : "refuses unqualified marks and explains dismissal refusal"}`, async () => {
    const launch = { id: "owner", type: "assistant", time: { created: 20 }, content: [
      { id: "call", type: "tool", name: "subagent", time: { created: 20, ran: 21, completed: 22 }, state: {
        status: "completed", input: { description: "Review", background: true }, metadata: { sessionID: "ses_child", status: "running" },
      } },
    ] };
    if (shape === "missing-run") Reflect.deleteProperty(launch.content[0]!.time, "ran");
    const result = { id: "result", type: "synthetic", time: { created: 40 }, text: "Done", metadata: { source: "subagent", childID: "ses_child", state: "completed" } };
    const messages = shape === "notification-only" ? [result] : terminal ? [launch, result] : [launch];
    const provider = createOpenCodeV2Provider({ endpoint: "http://opencode.test", directory: "/ws", password: "fixture", fetch: (async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      expect(request.method).toBe("GET");
      if (/\/api\/session\/[^/]+$/.test(url.pathname)) {
        const id = url.pathname.split("/").at(-1)!;
        return Response.json({ data: { id, projectID: "global", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 100, updated: 200 }, title: id, location: { directory: "/ws" }, ...(id === "ses_child" ? { parentID: "ses_parent" } : {}) } });
      }
      if (url.pathname.endsWith("/message")) return Response.json({ data: url.pathname.includes("/ses_parent/") ? messages : [], cursor: {} });
      if (url.pathname.endsWith("/inbox")) return Response.json({ data: [] });
      if (url.pathname === "/api/session/active") return Response.json({});
      return Response.json({ _tag: "NotFoundError", message: url.pathname }, { status: 404 });
    }) as typeof fetch });
    try {
      const rows = (await provider.listMessages("ses_parent", { limit: 100 })).items.filter((item): item is BackgroundTaskItem => item.type === "background_task");
      expect(rows).toHaveLength(1);
      const task = rows[0]!;
      expect(task.activity).toBeDefined();
      const notification = shape === "notification-only";
      if (notification) {
        expect(task.activity?.executionId).toMatch(/^v1:notification:[a-f0-9]{64}$/);
        expect(workerDismissalIdentities(task)).toEqual([task.activity!.executionId!]);
        expect(workerDismissalEvidenceForItem(task)).toHaveLength(1);
      } else {
        expect(task.activity?.executionId).toBeUndefined();
        expect(workerDismissalIdentities(task)).toEqual([]);
        expect(workerDismissalEvidenceForItem(task)).toEqual([]);
      }
      const [worker] = compactWorkers([task]);
      expect(workerExecutionIds(worker!)).toEqual(notification ? [task.activity!.executionId!] : []);
      const bare = new Set(["worker-dismissal:tool:call", `worker-dismissal:task:${task.taskId}`, "worker-dismissal:result:result"]);
      expect(visibleWorkers([worker!], bare)).toHaveLength(1);
      let posts = 0;
      const client = new WorkerDismissalClient({ changed: () => {}, fetcher: async (_url, init) => {
        if (init?.method === "POST") posts++;
        return Response.json({ version: 1, conversationId: "opencode:ses_parent", entries: [] });
      } });
      try {
        client.select("opencode:ses_parent");
        await client.dismiss(workerExecutionIds(worker!)[0]);
        if (notification) { expect(client.error).toBe(""); expect(posts).toBe(1); }
        else { expect(client.error).toContain("exact execution identity is unverified"); expect(posts).toBe(0); }
      } finally { client.dispose(); }
    } finally { await provider.dispose?.(); }
  });
}

test("legacy subagent and fork tool rows use their own immutable calls, never the shared child", () => {
  for (const [name, input] of [["Agent", '{"description":"Review"}'], ["Skill", '{"skill":"review"}']] as const) {
    const tool: ToolItem = { type: "tool", id: "legacy-call", name, input, status: "cancelled", createdAt: 0, childConversationId: "same-child" };
    expect(workerExecutionIds(compactWorkers([tool])[0]!)).toEqual(["worker-dismissal:tool:legacy-call"]);
    const marks = new Set(workerDismissalIdentities(tool));
    expect(visibleWorkers(compactWorkers([tool, { ...tool, id: "different-call" }]), marks).map(worker => worker.id)).toEqual(["different-call"]);
  }
});

test("strong provider aliases exclude unqualified launch/task/result anchors and survive reorder and partial pages", () => {
  const task: BackgroundTaskItem = { type: "background_task", id: "task:run", taskId: "run", toolUseId: "call", resultId: "result", status: "running", description: "Review", createdAt: 10,
    activity: { kind: "unavailable", executionId: "v1:exact", executionAliases: ["v1:exact", "v1:alias"] } };
  expect(workerDismissalIdentities(task)).toEqual(["v1:exact", "v1:alias"]);
  const marks = new Set(["v1:exact"]);
  for (const activity of [
    { kind: "unavailable" as const, executionId: "v1:exact" },
    { kind: "unavailable" as const, executionId: "v1:alias", executionAliases: ["v1:alias", "v1:exact"] },
  ]) {
    const recovered = { ...task, activity };
    expect(visibleWorkers(compactWorkers([recovered]), marks)).toHaveLength(0);
    expect(visibleWorkers(compactWorkers([recovered]), new Set(["worker-dismissal:tool:call", "worker-dismissal:task:run", "worker-dismissal:result:result"]))).toHaveLength(1);
    for (const kind of ["working", "needs-answer"] as const) {
      expect(visibleWorkers(compactWorkers([{ ...recovered, activity: { ...activity, kind } }]), marks)).toHaveLength(1);
    }
  }
  // No activity identity: retain existing finished-history compatibility.
  expect(workerDismissalIdentities({ ...task, status: "completed", activity: undefined })).toEqual([
    "worker-dismissal:tool:call", "worker-dismissal:result:result", "worker-dismissal:task:run",
  ]);
});
