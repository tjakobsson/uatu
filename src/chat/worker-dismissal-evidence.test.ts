import { expect, test } from "bun:test";
import { compactWorkerEvidence, validatedWorkerDismissalSource, workerDismissalSourceStrength, workerSourceIsProtected, WORKER_EVIDENCE_LIMIT } from "./worker-dismissal-evidence";
import type { BackgroundTaskItem, ConversationItem } from "./types";
import { BackgroundWorkers, prepareTool, workerExecutionIds } from "./opencode/v2/background";

test("protected worker source classification preserves activity and lifecycle distinctions", () => {
  const protectedKinds = {
    running: ["working", "needs-answer", "checking", "session-active"],
    completed: ["working", "needs-answer"],
    failed: ["working", "needs-answer"],
    stopped: ["working", "needs-answer"],
  };
  for (const status of ["running", "completed", "failed", "stopped"] as const) {
    const task: BackgroundTaskItem = { type: "background_task", id: "task:fixture", taskId: "fixture", description: "Fixture", createdAt: 1, status };
    expect(workerSourceIsProtected(task)).toBe(false);
    for (const kind of ["working", "needs-answer", "checking", "session-active", "unavailable", "ended"] as const) {
      expect(workerSourceIsProtected({ ...task, activity: { kind } })).toBe(protectedKinds[status].includes(kind));
    }
  }
  expect(workerSourceIsProtected({ type: "tool", id: "tool:fixture", name: "subagent", status: "completed", createdAt: 1 })).toBe(false);
});

function nativeAliasFixture(complete: boolean): BackgroundTaskItem[] {
  const workers = new BackgroundWorkers({ executionHistory: new Map(complete ? [["child", []]] : []) });
  workers.verifyChild("child", "parent");
  const rows = new Map<string, BackgroundTaskItem>();
  for (const [call, created] of [["call-A", 10], ["call-B", 30]] as const) {
    const part = { id: call, name: "subagent", time: { created, ran: created, completed: created + 10 }, state: { status: "completed", input: { description: "Fixture", prompt: "Fixture", background: true }, metadata: { sessionID: "child", status: "running" } } };
    for (const update of workers.launchPrepared("parent", prepareTool(part, created, "snapshot", `message-${call}`), created)) {
      if (update.kind === "upsert" && update.item.type === "background_task") rows.set(update.item.id, update.item);
    }
  }
  return [...rows.values()].map(item => {
    const ids = workerExecutionIds(workers.occurrence(item.taskId));
    return { ...item, activity: { kind: "unavailable", executionId: ids[0], executionAliases: ids, ...(complete ? { generation: 1 } : {}) } };
  });
}

test("native complete history certifies call-scoped alias shadows without creating completion", () => {
  const before = nativeAliasFixture(false), current = nativeAliasFixture(true);
  expect(before).toHaveLength(2); expect(current).toHaveLength(1);
  const canonical = current[0]!, shadow = before[1]!;
  expect(canonical.taskId).not.toBe(shadow.taskId);
  expect(canonical.toolUseIds).toEqual(["call-A", "call-B"]);
  expect(canonical.activity!.executionAliases).toContain(shadow.activity!.executionId!);
  expect(() => workerDismissalSourceStrength(before)(current)).not.toThrow();
  for (const rows of [[canonical, shadow], [shadow, canonical]]) {
    expect(validatedWorkerDismissalSource(rows)).toEqual([canonical]);
    expect(compactWorkerEvidence(rows)).toEqual(compactWorkerEvidence([canonical]));
    expect(() => workerDismissalSourceStrength(rows)([canonical])).not.toThrow();
  }
  const ended: BackgroundTaskItem = { ...canonical, status: "completed", resultId: "report", activity: { ...canonical.activity!, kind: "ended" } };
  expect(compactWorkerEvidence([shadow, ended])).toEqual(compactWorkerEvidence([ended]));
  // This is dismissal-only alias canonicalization, not Stop/completion proof.
  expect(shadow.status).toBe("running");
});

for (const difference of ["working", "needs-answer", "checking", "session-active", "child", "parent", "task-key", "launcher", "aliases", "result", "outcome", "launch-ref", "generation", "task-type", "foreground", "subagent-type"] as const) test(`native alias shadows do not excuse ${difference} conflicts`, () => {
  let canonical = nativeAliasFixture(true)[0]!;
  let shadow = nativeAliasFixture(false)[1]!;
  if (["working", "needs-answer", "checking", "session-active"].includes(difference)) shadow = { ...shadow, activity: { ...shadow.activity!, kind: difference as "working" } };
  if (difference === "needs-answer") shadow = { ...shadow, activity: { ...shadow.activity!, kind: "needs-answer", request: { kind: "question", id: "question" } } };
  if (difference === "child") shadow = { ...shadow, childConversationId: "foreign" };
  if (difference === "parent") shadow = { ...shadow, id: "task:v2:other:call-B", taskId: "v2:other:call-B" };
  if (difference === "task-key") shadow = { ...shadow, taskId: "arbitrary" };
  if (difference === "launcher") shadow = { ...shadow, toolUseIds: ["uncovered-call"] };
  if (difference === "aliases") canonical = { ...canonical, toolUseIds: ["call-A", "call-B", "unanchored-call"] };
  if (difference === "result") shadow = { ...shadow, resultId: "another-result" };
  if (difference === "outcome") shadow = { ...shadow, status: "failed" };
  if (difference === "launch-ref") shadow = { ...shadow, activity: { ...shadow.activity!, launchRef: "other" } };
  if (difference === "generation") shadow = { ...shadow, activity: { ...shadow.activity!, generation: 2 } };
  if (difference === "task-type") shadow = { ...shadow, taskType: "shell" };
  if (difference === "foreground") shadow = { ...shadow, foreground: true };
  if (difference === "subagent-type") { shadow = { ...shadow, subagentType: "one" }; canonical = { ...canonical, subagentType: "two" }; }
  for (const rows of [[canonical, shadow], [shadow, canonical]]) expect(() => compactWorkerEvidence(rows)).toThrow("ambiguous");
});

test("native alias shadows cannot bridge incompatible canonical outcomes or same-row duplicates", () => {
  const canonical = nativeAliasFixture(true)[0]!, shadow = nativeAliasFixture(false)[1]!;
  const conflicting: BackgroundTaskItem = { ...canonical, id: "task:other", status: "failed" };
  expect(() => compactWorkerEvidence([canonical, shadow, conflicting])).toThrow("ambiguous");
  expect(() => compactWorkerEvidence([canonical, shadow, { ...shadow, status: "failed" }])).toThrow("ambiguous");
  expect(() => validatedWorkerDismissalSource([canonical], [shadow])).toThrow("ambiguous");
});

for (const kind of ["working", "needs-answer", "checking", "session-active"] as const) test(`native canonical ${kind} cannot erase even an abstaining shadow`, () => {
  const original = nativeAliasFixture(true)[0]!, shadow = nativeAliasFixture(false)[1]!;
  const canonical: BackgroundTaskItem = { ...original, activity: { ...original.activity!, kind,
    ...(kind === "needs-answer" ? { request: { kind: "question", id: "question" } as const } : {}) } };
  for (const rows of [[canonical, shadow], [shadow, canonical]]) expect(() => compactWorkerEvidence(rows)).toThrow("ambiguous");
});

test("compact folding refuses source/evidence overflow and contradictory identities", () => {
  const task: BackgroundTaskItem = { type: "background_task", id: "task:fixture", taskId: "fixture", description: "Fixture", createdAt: 1, status: "completed", activity: { kind: "ended", executionId: "exact" } };
  expect(() => compactWorkerEvidence(Array.from({ length: WORKER_EVIDENCE_LIMIT + 1 }, (_, i) => ({ ...task, id: `task:${i}` })))).toThrow("source capacity");
  const many = Array.from({ length: 5 }, (_, i) => {
    const aliases = Array.from({ length: 2048 }, (_, j) => `execution:${i}:${j}`);
    return { ...task, id: `task:${i}`, activity: { kind: "ended" as const, executionId: aliases[0], executionAliases: aliases } };
  });
  expect(() => compactWorkerEvidence(many)).toThrow("evidence capacity");
  expect(() => compactWorkerEvidence([task, { ...task, id: "task:other", status: "failed" }])).toThrow("ambiguous");
});

test("complete folding resolves a terminal launcher against an unresolved worker before authorizing dismissals", () => {
  const rows: ConversationItem[] = [
    { type: "tool", id: "tool:call", name: "task", input: '{"description":"Fixture"}', status: "completed", createdAt: 1 },
    { type: "background_task", id: "task:run", taskId: "run", toolUseId: "call", description: "Fixture", createdAt: 1, status: "running", activity: { kind: "checking", executionId: "exact" } },
  ];
  expect(compactWorkerEvidence(rows)).toEqual([expect.objectContaining({ executionId: "exact", active: false, dismissible: false })]);
  expect(compactWorkerEvidence([...rows].reverse())).toEqual(compactWorkerEvidence(rows));
});

test("a malformed active source row cannot be omitted beside a valid terminal identity", () => {
  const task: BackgroundTaskItem = { type: "background_task", id: "task:fixture", taskId: "fixture", description: "Fixture", createdAt: 1, status: "completed", activity: { kind: "ended", executionId: "exact" } };
  const malformed = { ...task, id: "task:active", status: "running", activity: { kind: "working", executionId: "exact", generation: -1 } } as BackgroundTaskItem;
  expect(() => compactWorkerEvidence([task, malformed])).toThrow("invalid authoritative worker source");
});

test("compatible duplicate rows preserve alias/launcher order independence and ignore presentation clocks/text", () => {
  const task: BackgroundTaskItem = { type: "background_task", id: "task:one", taskId: "one", description: "Fixture", createdAt: 1, childConversationId: "child", toolUseId: "call-a", toolUseIds: ["call-b", "call-a"], status: "completed",
    activity: { kind: "ended", executionId: "exact:a", executionAliases: ["exact:a", "exact:b"], generation: 1, endedAt: 4, observedAt: 5 } };
  const duplicate: BackgroundTaskItem = { ...task, createdAt: 2, description: "Enriched display text", summary: "New display summary", toolUseId: "call-b", toolUseIds: ["call-a", "call-b"],
    activity: { ...task.activity!, executionId: "exact:b", executionAliases: ["exact:b", "exact:a"], observedAt: 50, reason: "New observation" } };
  expect(validatedWorkerDismissalSource([task, duplicate])).toEqual([duplicate]);
  const sorted = (items: ConversationItem[]) => compactWorkerEvidence(items).sort((a, b) => a.executionId.localeCompare(b.executionId));
  expect(sorted([task, duplicate])).toEqual(sorted([duplicate, task]));
  expect(compactWorkerEvidence([task, duplicate])).toHaveLength(2);
});

for (const difference of ["occurrence", "association", "launcher", "outcome", "withheld-positive", "dto-type", "nonworker"] as const) test(`strict same-ID compact source rejects ${difference} conflict`, () => {
  const task: BackgroundTaskItem = { type: "background_task", id: "task:one", taskId: "one", description: "Fixture", createdAt: 1, childConversationId: "child", toolUseId: "call", status: "completed", activity: { kind: "ended", executionId: "exact" } };
  let duplicate: ConversationItem = { ...task };
  if (difference === "occurrence") duplicate = { ...task, activity: { kind: "ended", executionId: "other" } };
  if (difference === "association") duplicate = { ...task, childConversationId: "other" };
  if (difference === "launcher") duplicate = { ...task, toolUseId: "other" };
  if (difference === "outcome") duplicate = { ...task, status: "failed" };
  if (difference === "withheld-positive") duplicate = { ...task, status: "running", activity: { kind: "working" } };
  if (difference === "dto-type") duplicate = { type: "tool", id: task.id, createdAt: 1, name: "task", input: '{"description":"Fixture"}', status: "completed" };
  if (difference === "nonworker") duplicate = { type: "notice", id: task.id, createdAt: 1, level: "info", message: "Fixture" };
  expect(() => compactWorkerEvidence([task, duplicate])).toThrow("ambiguous");
  expect(() => compactWorkerEvidence([duplicate, task])).toThrow("ambiguous");
});

test("distinct proven executions may share a child session without sharing dismissal authority", () => {
  const task: BackgroundTaskItem = { type: "background_task", id: "task:one", taskId: "one", description: "Fixture", createdAt: 1, childConversationId: "shared-child", status: "completed", activity: { kind: "ended", executionId: "execution:one" } };
  const other: BackgroundTaskItem = { ...task, id: "task:two", taskId: "two", status: "running", activity: { kind: "working", executionId: "execution:two" } };
  expect(compactWorkerEvidence([task, other])).toEqual([
    expect.objectContaining({ executionId: "execution:one", active: false, dismissible: true }),
    expect.objectContaining({ executionId: "execution:two", active: true, dismissible: false }),
  ]);
});

test("legacy terminal occurrences keep compatible alias enrichment across distinct source rows", () => {
  const task: BackgroundTaskItem = { type: "background_task", id: "task:partial", taskId: "native-task", description: "Fixture", createdAt: 1, status: "completed" };
  const enriched: BackgroundTaskItem = { ...task, id: "task:enriched", toolUseId: "call" };
  expect(compactWorkerEvidence([task, enriched]).map(item => item.executionId).sort()).toEqual(["worker-dismissal:task:native-task", "worker-dismissal:tool:call"]);
});

for (const difference of ["task", "child", "launcher", "launch-ref", "result", "task-type"] as const) test(`shared exact alias refuses conflicting immutable ${difference} facts across row ids`, () => {
  const first: BackgroundTaskItem = { type: "background_task", id: "task:one", taskId: "native-one", taskType: "agent", childConversationId: "child-one", toolUseId: "call-one", resultId: "result-one", description: "Fixture", createdAt: 1, status: "completed", activity: { kind: "ended", executionId: "exact", generation: 1, launchRef: "launch:one" } };
  const second: BackgroundTaskItem = { ...first, id: "task:two",
    ...(difference === "task" ? { taskId: "native-two" } : {}), ...(difference === "child" ? { childConversationId: "child-two" } : {}),
    ...(difference === "launcher" ? { toolUseId: "call-two" } : {}), ...(difference === "result" ? { resultId: "result-two" } : {}),
    ...(difference === "task-type" ? { taskType: "shell" } : {}), ...(difference === "launch-ref" ? { activity: { ...first.activity!, launchRef: "launch:two" } } : {}),
  };
  expect(() => compactWorkerEvidence([first, second])).toThrow("ambiguous");
  expect(() => compactWorkerEvidence([second, first])).toThrow("ambiguous");
});

test("an unknown intermediate association cannot erase known shared-alias facts", () => {
  const task: BackgroundTaskItem = { type: "background_task", id: "task:one", taskId: "native", childConversationId: "child-one", description: "Fixture", createdAt: 1, status: "completed", activity: { kind: "ended", executionId: "exact" } };
  const unknown = { ...task, id: "task:unknown", childConversationId: undefined };
  const conflicting = { ...task, id: "task:other", childConversationId: "child-other" };
  for (const rows of [[task, unknown, conflicting], [unknown, task, conflicting], [task, conflicting, unknown]]) expect(() => compactWorkerEvidence(rows)).toThrow("ambiguous");
});

test("legacy alias-group bridges retain every known occurrence fact", () => {
  const task: BackgroundTaskItem = { type: "background_task", id: "task:one", taskId: "native-one", childConversationId: "native-one", toolUseId: "call-one", description: "Fixture", createdAt: 1, status: "completed" };
  const other = { ...task, id: "task:other", taskId: "native-other", childConversationId: "native-other", toolUseId: "call-other" };
  const bridge = { ...task, id: "task:bridge", toolUseIds: ["call-one", "call-other"] };
  for (const rows of [[task, other, bridge], [task, bridge, other], [bridge, task, other]]) expect(() => compactWorkerEvidence(rows)).toThrow("ambiguous");
});

test("legacy enrichment cannot resurrect a bare task anchor proven to be only a child id", () => {
  const task: BackgroundTaskItem = { type: "background_task", id: "task:unknown", taskId: "child-only", toolUseId: "call", description: "Fixture", createdAt: 1, status: "completed" };
  const known = { ...task, id: "task:known", childConversationId: "child-only" };
  expect(() => compactWorkerEvidence([task, known])).toThrow("ambiguous");
  expect(() => compactWorkerEvidence([known, task])).toThrow("ambiguous");
});

for (const weakening of ["ended", "unavailable", "checking", "missing", "different-execution", "different-child"] as const) test(`source-strength guard rejects ${weakening} after any intermediate merge`, () => {
  const source: BackgroundTaskItem = { type: "background_task", id: "task:one", taskId: "native", childConversationId: "child", description: "Fixture", createdAt: 1, status: "running", activity: { kind: "working", executionId: "exact", generation: 1 } };
  const guard = workerDismissalSourceStrength([source]);
  let current: BackgroundTaskItem = { ...source };
  if (weakening === "ended") current = { ...source, status: "completed", activity: { ...source.activity!, kind: "ended" } };
  if (weakening === "unavailable" || weakening === "checking") current = { ...source, activity: { ...source.activity!, kind: weakening } };
  if (weakening === "different-execution") current = { ...source, activity: { ...source.activity!, executionId: "other" } };
  if (weakening === "different-child") current = { ...source, childConversationId: "other" };
  expect(() => guard(weakening === "missing" ? [] : [current])).toThrow();
});

test("source-strength guard permits qualification without discarding active identity-withheld evidence", () => {
  const source: BackgroundTaskItem = { type: "background_task", id: "task:one", taskId: "native", description: "Fixture", createdAt: 1, status: "running", activity: { kind: "working", generation: 1, launchRef: "launch" } };
  const guard = workerDismissalSourceStrength([source]);
  expect(() => guard([source])).not.toThrow();
  expect(() => guard([{ ...source, activity: { ...source.activity!, executionId: "qualified" } }])).not.toThrow();
});

test("nonterminal legacy tools sharing a canonical execution cannot disappear before evidence folding", () => {
  const tool: ConversationItem = { type: "tool", id: "tool:call", createdAt: 1, name: "task", input: '{"description":"Fixture"}', status: "completed" };
  expect(() => compactWorkerEvidence([tool, { ...tool, id: "call", status: "running" }])).toThrow("ambiguous");
});

test("a visible page cannot contradict or extend its claimed complete worker coverage", () => {
  const task: BackgroundTaskItem = { type: "background_task", id: "task:one", taskId: "one", description: "Fixture", createdAt: 1, status: "completed", activity: { kind: "ended", executionId: "exact" } };
  expect(() => validatedWorkerDismissalSource([task], [{ ...task, status: "running", activity: { kind: "working", executionId: "exact" } }])).toThrow("ambiguous");
  expect(() => validatedWorkerDismissalSource([task], [{ ...task, id: "task:other" }])).toThrow("ambiguous");
});
