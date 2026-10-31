import { expect, spyOn, test } from "bun:test";
import { BackgroundControls, BackgroundWorkers, launcherChanged, nativeProof, prepareTool, retainLauncherEvidence, shellCommandFingerprint, type WorkerOccurrenceEvidence } from "./background";
import fc from "fast-check";
import { compactWorkers } from "../../compact-work";
import type { BackgroundTaskItem, ConversationItem } from "../../types";
import { taskInspection } from "../../task-inspection";
import { createOpenCodeV2Normalizer } from "./normalization";

const launch = (id: string, worker = id, command = "fixture") => ({ id, name: "shell", state: { status: "completed", input: { command }, metadata: { status: "running", shellID: worker } } });

test("owned shell exit ends activity without inventing a captured result or revoking control", () => {
  const workers = new BackgroundWorkers();
  const birth = nativeProof({ id: "shell-birth", created: 10 }, { id: "shell", command: "fixture" })!;
  const end = nativeProof({ id: "shell-exit", created: 30 }, { id: "shell", status: "exited" })!;
  workers.observeBirth("shell", "parent", birth, shellCommandFingerprint("fixture"));
  workers.launchPrepared("parent", prepareTool({ ...launch("call", "shell"), time: { created: 9, ran: 9, completed: 11 } }, 11, "snapshot", "message"), 11);
  const initial = workers.occurrence("v2:parent:call")!;
  expect(workers.shellActivity(initial)).toBe(true);
  workers.shellEnded("shell", nativeProof({ id: "early-exit", created: 8 }, { id: "shell" }));
  expect(workers.occurrence(initial.taskId)?.executionEnd).toBeUndefined();
  workers.shellEnded("shell", end);
  const ended = workers.occurrence(initial.taskId)!;
  expect(ended.executionEnd).toEqual(end);
  expect(ended.uncertain).toBeUndefined();
  expect(workers.activityEvidence(ended)?.executionEnd).toEqual(end);
  const controls = new BackgroundControls();
  expect(controls.project({ id: "task", type: "background_task", taskId: initial.taskId, taskType: "shell", outputFile: "shell:shell", description: "Fixture", createdAt: 9, status: "running" }, ended)).toMatchObject({ status: "running", control: { available: true } });
  workers.shellEnded("shell", end);
  expect(workers.occurrence(initial.taskId)).toEqual(ended);
});

test("shell exit before launcher remains occurrence-ended, not Working", () => {
  const workers = new BackgroundWorkers();
  const birth = nativeProof({ id: "birth", created: 10 }, { id: "shell", command: "fixture" })!;
  const end = nativeProof({ id: "exit", created: 11 }, { id: "shell", status: "exited" })!;
  workers.observeBirth("shell", "parent", birth, shellCommandFingerprint("fixture"));
  workers.shellEnded("shell", end);
  workers.launchPrepared("parent", prepareTool({ ...launch("call", "shell"), time: { created: 9, ran: 9, completed: 12 } }, 12, "snapshot", "message"), 12);
  const occurrence = workers.occurrence("v2:parent:call")!;
  expect(occurrence.executionEnd).toEqual(end);
  expect(workers.activityEvidence(occurrence)?.executionEnd).toEqual(end);
  expect(workers.shellActivity(occurrence)).toBe(false);
});

for (const veto of ["reuse", "end", "competitor", "gap", "rebirth", "contradictory-clock"] as const) test(`provisional newborn start cannot bind after ${veto}`, () => {
  const workers = new BackgroundWorkers();
  workers.verifyChild("child", "parent");
  workers.observeBirth("child", "parent", nativeProof({ id: "birth", created: 22 }, { child: "child", parent: "parent" }));
  const part = { id: "call", name: "subagent", state: { executed: true, status: "completed", input: { prompt: "fixture" }, metadata: { sessionID: "child", status: "running" } } };
  workers.launchPrepared("parent", prepareTool(part, 30, "success", "message", { id: "success", created: 30 }), 30);
  workers.executionStarted("child", nativeProof({ id: "initial-start", created: 31 }, { session: "child" }));
  expect(workers.occurrence("v2:parent:call")?.executionStart).toBeUndefined();
  if (veto === "reuse") workers.executionStarted("child", nativeProof({ id: "second-start", created: 32 }, { session: "child" }));
  if (veto === "end") workers.executionEnded("child", 32, nativeProof({ id: "end", created: 32 }, { session: "child" }));
  if (veto === "competitor") workers.invocation("parent", prepareTool({ ...part, id: "other", state: { ...part.state, input: { sessionID: "child" } } }, 32, "called", "other-message", { id: "other-call", created: 32 }).fact);
  if (veto === "gap") { workers.invalidateActivity(); workers.invalidateOwnership(); workers.verifyChild("child", "parent"); }
  if (veto === "rebirth") workers.observeBirth("child", "parent", nativeProof({ id: "rebirth", created: 32 }, { child: "child", parent: "parent" }));
  workers.launchPrepared("parent", prepareTool({ ...part, time: { created: 20, ran: 20, completed: veto === "contradictory-clock" ? 21 : 30 } }, 33, "snapshot", "message"), 33);
  const occurrence = workers.occurrence("v2:parent:call")!;
  expect(occurrence.executionStart).toBeUndefined();
  expect(workers.activityEvidence(occurrence)?.executionStart).toBeUndefined();
});

test("unmatched prelaunch shell exit cannot become positive activity from a later birth", () => {
  const workers = new BackgroundWorkers();
  workers.shellEnded("shell", nativeProof({ id: "unknown-exit", created: 11 }, { id: "shell" }));
  workers.observeBirth("shell", "parent", nativeProof({ id: "later-birth", created: 12 }, { id: "shell" }), shellCommandFingerprint("fixture"));
  workers.launchPrepared("parent", prepareTool({ ...launch("call", "shell"), time: { created: 9, ran: 9, completed: 13 } }, 13, "snapshot", "message"), 13);
  const occurrence = workers.occurrence("v2:parent:call")!;
  expect(workers.activityEvidence(occurrence)).toBeUndefined();
  expect(workers.shellActivity(occurrence)).toBe(false);
});

test("canonical request links require current durable child-tool proof and retain bounded resolution fences", () => {
  const workers = new BackgroundWorkers();
  workers.verifyChild("child", "parent");
  workers.observeBirth("child", "parent", nativeProof({ id: "birth", created: 10 }, { child: "child" }));
  const proof = (id: string, seq: number, aggregate = "child") => nativeProof({ id, created: 11 + seq, durable: { aggregateID: aggregate, seq, version: 1 } }, { id })!;
  workers.executionStarted("child", proof("start", 1));
  workers.launchPrepared("parent", prepareTool({ id: "launch", name: "subagent", time: { created: 9, ran: 9, completed: 12 }, state: {
    status: "completed", input: { prompt: "fixture" }, metadata: { sessionID: "child", status: "running" },
  } }, 12, "snapshot", "message"), 12);
  const source = { message: "child-message", tool: "child-tool" };
  for (const invalid of [proof("old", 1), proof("foreign", 2, "other"), nativeProof({ id: "ephemeral", created: 13 }, {})]) {
    workers.observeRequestTool("child", source, invalid);
    expect(workers.linkRequest("child", "pending", "permission", source)).toBe(false);
  }
  workers.observeRequestTool("child", source, proof("current-tool", 2));
  expect(workers.linkRequest("child", "pending", "permission", source)).toBe(true);
  expect(workers.linkedRequest("v2:parent:launch")).toEqual({ id: "pending", kind: "permission" });
  expect(workers.resolveRequest("pending", "permission", "foreign-child")).toEqual([]);
  expect(workers.linkedRequest("v2:parent:launch")).toBeDefined();
  expect(workers.resolveRequest("pending", "permission", "child")).toEqual(["child"]);
  expect(workers.linkRequest("child", "pending", "permission", source)).toBe(false);
  expect(workers.linkRequest("child", "form", "question", source)).toBe(true);
  workers.resolveRequest("form", "question", "child");
  for (let index = 0; index < 15; index++) {
    expect(workers.linkRequest("child", `request-${index}`, "permission", source)).toBe(true);
    workers.resolveRequest(`request-${index}`, "permission", "child");
  }
  expect(workers.linkRequest("child", "beyond-resolution-capacity", "permission", source)).toBe(false);
  expect(workers.controlEvidenceAvailable).toBe(true);
  checkBytes(workers);
});

test("activity observations resolve only positive immutable launcher aliases, never child-only or forged canonical IDs", () => {
  const workers = new BackgroundWorkers();
  workers.verifyChild("child", "parent");
  workers.executionStarted("child", nativeProof({ id: "start", created: 25, durable: { aggregateID: "child", seq: 1, version: 1 } }, { child: "child" }));
  for (const [call, created] of [["b", 21], ["a", 20]] as const) workers.launchPrepared("parent", prepareTool({ id: call, name: "subagent", time: { created, ran: created, completed: 31 }, state: {
    status: "completed", input: { prompt: "fixture" }, metadata: { sessionID: "child", status: "running" },
  } }, 31, "snapshot", `message-${call}`), 31);
  const live = workers.occurrence("v2:parent:b")!;
  workers.rememberActivity(live.taskId, { kind: "working", observedAt: 1_000 });
  const history = { ...live, taskId: "v2:parent:a" };
  expect(workers.activityEvidence(history)).toBe(live);
  expect(workers.lastActivity(history.taskId, history)?.observedAt).toBe(1_000);
  for (const invalid of [
    { ...history, taskId: "v2:parent:*" },
    { ...history, launches: history.launches.map(launch => ({ ...launch, inputFingerprint: "contradiction" })) },
    { ...history, launches: history.launches.map(launch => launch.call === "a" ? { ...launch, ran: 29 } : launch) },
    { ...history, launches: history.launches.filter(launch => launch.call === "a") },
    { ...history, taskId: "v2:parent:unknown", launches: history.launches.map(launch => ({ ...launch, call: "unknown" })) },
  ]) {
    expect(workers.activityEvidence(invalid)).toBeUndefined();
    expect(workers.lastActivity(invalid.taskId, invalid)).toBeUndefined();
    expect(workers.linkedRequest(invalid.taskId, invalid)).toBeUndefined();
  }
  expect(workers.hasRetainedReference({ ...history, launches: history.launches.map(launch => ({ ...launch, inputFingerprint: "contradiction" })) })).toBe(true);
  expect(workers.hasRetainedReference({ ...history, taskId: "v2:parent:unknown", launches: history.launches.map(launch => ({ ...launch, call: "unknown" })) })).toBe(false);
  workers.invalidateActivity(); workers.invalidateOwnership();
  expect(workers.activityEvidence({ ...history, uncertain: true })).toBeUndefined();
  expect(workers.lastActivity(history.taskId, { ...history, uncertain: true })?.observedAt).toBe(1_000);
  expect(workers.lastActivity(live.taskId)?.observedAt).toBe(1_000);
  checkBytes(workers);
});

for (const boundary of ["separated", "live", "missing-history", "missing-start", "tied-start", "tied-earlier", "tied-later"] as const) {
  test(`historical supersession requires strict interval separation: ${boundary}`, () => {
    const ends = boundary === "tied-earlier" ? [13, 30] : boundary === "tied-later" ? [21, 30] : [17, 30];
    const workers = new BackgroundWorkers(boundary === "live" ? {} : { executionHistory: new Map(boundary === "missing-history" ? [] : [["child", ends]]) });
    workers.verifyChild("child", "parent");
    const tool = (id: string, ran?: number) => ({ id, name: "subagent", ...(ran === undefined ? {} : { time: { created: ran, ran, completed: ran + 1 } }),
      state: { status: "completed", metadata: { status: "running", sessionID: "child" } } });
    workers.launch("parent", tool("new_a", 21), 21);
    if (boundary === "live") workers.executionEnded("child", 17);
    workers.launch("parent", tool("old", boundary === "missing-start" ? undefined : boundary === "tied-start" ? 21 : 13), 13);
    expect(workers.occurrence("v2:parent:new_a")?.uncertain === true).toBe(boundary !== "separated");
    workers.launch("parent", tool("new_b", 25), 25);
    expect(workers.occurrence("v2:parent:new_a")?.launches.map(launch => launch.call)).toEqual(boundary === "separated" ? ["new_a", "new_b"] : ["new_a"]);
  });
}

function controlFixture(call: string, parent = "parent", worker = call, kind: "agent" | "shell" = "shell") {
  const workers = new BackgroundWorkers();
  const part = kind === "shell" ? launch(call, worker) : { id: call, name: "subagent", state: { status: "completed", input: { prompt: "fixture" }, metadata: { status: "running", sessionID: worker } } };
  if (kind === "agent") workers.verifyChild(worker, parent);
  workers.launchPrepared(parent, prepareTool({ ...part, time: { created: 10, completed: 20 } }, 10, "snapshot", `message:${call}`), 10);
  const evidence = workers.occurrence(`v2:${parent}:${call}`)!;
  const item: BackgroundTaskItem = { id: `task:${evidence.taskId}`, type: "background_task", taskId: evidence.taskId,
    taskType: kind, ...(kind === "shell" ? { outputFile: `shell:${worker}` } : { childConversationId: worker }), toolUseId: call, description: "Fixture", status: "running", createdAt: 10 };
  return { item, evidence };
}

function controlOracle(controls: BackgroundControls) {
  const state = controls as unknown as { closed: boolean; projectionLost: boolean; gapSequence: number | null; scopes: Map<string, "retained" | "partial" | "inventoried" | "gap">;
    records: Map<string, { parent: string; taskId: string; unavailable?: true; aliases?: string[]; pendingCalls?: string[]; evidence?: WorkerOccurrenceEvidence; witnesses?: unknown[]; item?: BackgroundTaskItem }>;
    reads: Map<number, unknown>; observations: Map<string, { witness?: unknown }> };
  const bytes = JSON.stringify([state.closed, state.projectionLost, state.gapSequence, [...state.scopes], [...state.records], [...state.reads], [...state.observations]]).length * 2;
  const entries = state.scopes.size + state.reads.size + [...state.observations.values()].reduce((sum, observation) => sum + 1 + (observation.witness ? 1 : 0), 0)
    + [...state.records.values()].reduce((sum, record) => sum + 1 + (record.evidence?.launches.length ?? 0) + (record.witnesses?.length ?? 0) + (record.aliases?.length ?? 0) + (record.pendingCalls?.length ?? 0)
      + (record.item ? 1 + (record.item.toolUseIds?.length ?? 0) : 0), 0);
  expect(controls.usage).toEqual({ bytes, entries });
  expect(bytes).toBeLessThanOrEqual(1024 * 1024);
  expect(entries).toBeLessThanOrEqual(2_048);
  return state;
}

test("initial parent creation and execution do not revoke a positively identified first worker", () => {
  const fixture = controlFixture("initial", "parent", "child", "agent");
  const controls = new BackgroundControls();
  controls.observe({ shutdown: false, session: "parent", launchers: [], lifecycle: {
    kind: "session.created", id: "parent", directory: "/ws", proof: nativeProof({ id: "parent-birth", created: 1 }, { session: "parent" }),
  } }, true);
  controls.observe({ shutdown: false, session: "parent", launchers: [], execution: {
    phase: "started", historical: false, proof: nativeProof({ id: "parent-start", created: 2 }, { session: "parent" }),
  } }, true);
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(false);
  expect(controls.unavailable(fixture.item.taskId)).toBe(false);
  controlOracle(controls);
});

test("initial child creation waits for an exact occurrence-linked start instead of retiring the first identity", () => {
  const fixture = controlFixture("initial-child", "parent", "child", "agent"), controls = new BackgroundControls();
  const proof = nativeProof({ id: "first-start", created: 11 }, { session: "child" })!;
  controls.observe({ shutdown: false, session: "child", launchers: [], lifecycle: { kind: "session.created", id: "child", parent: "parent", directory: "/ws",
    proof: nativeProof({ id: "child-birth", created: 5 }, { session: "child", parent: "parent" }) } }, true);
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(true);
  expect(controls.unavailable(fixture.item.taskId)).toBe(false);
  controls.observe({ shutdown: false, session: "child", launchers: [], execution: { phase: "started", historical: false, proof } }, true);
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(true);
  expect(controls.unavailable(fixture.item.taskId)).toBe(false);
  const linked = { ...fixture.evidence, executionStart: proof };
  const earlier = nativeProof({ id: "earlier-run", created: 6 }, { session: "child" })!;
  expect(controls.project(fixture.item, { ...linked, executionStart: earlier }, undefined, [{ kind: "started", proof: earlier }]).stateUncertain).toBe(true);
  const incomplete = { ...linked, launches: linked.launches.map(launch => ({ ...launch, inputFingerprint: undefined })) };
  expect(controls.project(fixture.item, incomplete, undefined, [{ kind: "started", proof }]).stateUncertain).toBe(true);
  expect(controls.unavailable(fixture.item.taskId)).toBe(false);
  expect(controls.project(fixture.item, linked, undefined, [{ kind: "started", proof }]).stateUncertain).toBe(false);
  controlOracle(controls);
});

test.each(["session.moved", "session.deleted", "session.updated", "foreign-birth", "new-generation"])("initial classification cannot launder destructive %s through old history", kind => {
  const fixture = controlFixture("old", "parent", "child", "agent"), controls = new BackgroundControls();
  const birth = kind === "foreign-birth" || kind === "new-generation";
  controls.observe({ shutdown: false, session: "child", launchers: [], lifecycle: { kind: birth ? "session.created" : kind, id: "child", parent: "parent", directory: kind === "foreign-birth" ? "/foreign" : "/ws",
    proof: nativeProof({ id: "changed", created: kind === "new-generation" ? 30 : 5 }, { kind }) } }, kind !== "foreign-birth");
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(true);
  expect(controls.unavailable(fixture.item.taskId)).toBe(true);
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(true);
  controlOracle(controls);
});

test("a positively identical pre-admission foreground snapshot can detach without rehabilitating an admitted identity", () => {
  const fixture = controlFixture("detach", "parent", "child", "agent"), controls = new BackgroundControls();
  const full = fixture.evidence.launches[0]!;
  controls.observe({ shutdown: false, session: "parent", launchers: [{ ...full, background: false }] }, true);
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(true);
  expect(controls.unavailable(fixture.item.taskId)).toBe(false);
  controls.observe({ shutdown: false, session: "parent", launchers: [full] }, true);
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(false);
  controls.observe({ shutdown: false, session: "parent", launchers: [{ ...full, background: false }] }, true);
  controls.observe({ shutdown: false, session: "parent", launchers: [full] }, true);
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(true);
  expect(controls.unavailable(fixture.item.taskId)).toBe(true);
  controlOracle(controls);
});

test.each(["child", "message", "workerType", "created", "inputFingerprint"] as const)("initial detachment cannot erase a mismatching native %s", field => {
  const fixture = controlFixture("detach", "parent", "child", "agent"), controls = new BackgroundControls();
  const full = fixture.evidence.launches[0]!;
  const changed = { ...full, background: false, [field]: field === "created" ? 9 : field === "workerType" ? "shell" : "different" };
  controls.observe({ shutdown: false, session: "parent", launchers: [changed] }, true);
  controls.observe({ shutdown: false, session: "parent", launchers: [full] }, true);
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(true);
  expect(controls.unavailable(fixture.item.taskId)).toBe(true);
  controlOracle(controls);
});

test("later live-scope inventory reserves unobserved work pending, without confusing it with cold history or a gap", () => {
  const fixture = controlFixture("discovered"), controls = new BackgroundControls();
  const initial = controls.beginRead("parent", true, true, true);
  expect(initial.initialInventory).toBe(true);
  expect(controls.project(fixture.item, fixture.evidence, initial).stateUncertain).toBe(false);
  controls.endRead(initial, true);
  const later = controlFixture("later"), read = controls.beginRead("parent", true, true, true);
  expect(read.initialInventory).toBe(false);
  expect(controls.project(later.item, later.evidence, read).stateUncertain).toBe(true);
  expect(controls.unavailable(later.item.taskId)).toBe(false);
  controls.observe({ shutdown: false, session: "parent", launchers: [...later.evidence.launches] }, true);
  expect(controls.project(later.item, later.evidence, read).stateUncertain).toBe(false);
  controls.endRead(read);
  controls.observationGap();
  expect(controls.project(later.item, later.evidence).stateUncertain).toBe(true);
  controlOracle(controls);
});

test("a failed initial inventory does not discard the right to classify fresh cold evidence", () => {
  const controls = new BackgroundControls(), fixture = controlFixture("cold-after-failed-read");
  const failed = controls.beginRead("parent", true, true, true);
  controls.endRead(failed);
  const recovered = controls.beginRead("parent", true, true, true);
  expect(recovered.initialInventory).toBe(true);
  expect(controls.project(fixture.item, fixture.evidence, recovered).stateUncertain).toBe(false);
  controls.endRead(recovered, true);
  controlOracle(controls);
});

test("partial inventories preserve healthy sibling proof and completion accounting across callers", () => {
  const controls = new BackgroundControls(), healthy = controlFixture("healthy"), pending = controlFixture("pending");
  const first = controls.beginRead("parent", true, true, true);
  controls.incompleteRead(first);
  expect(first.failed).toBe(false);
  expect(controls.project(healthy.item, healthy.evidence, first).stateUncertain).toBe(false);
  expect(controls.project({ ...pending.item, stateUncertain: true }, pending.evidence, first).stateUncertain).toBe(true);
  controlOracle(controls);
  // Every provider caller can finish publishing its partial result. None may
  // close initial classification while a relevant evidence read is incomplete.
  controls.endRead(first, true);
  const retry = controls.beginRead("parent", true, true, true);
  expect(retry.initialInventory).toBe(true);
  expect(controls.project(pending.item, pending.evidence, retry).stateUncertain).toBe(false);
  expect(controls.project(healthy.item, healthy.evidence, retry).stateUncertain).toBe(false);
  controls.endRead(retry, true);
  const later = controls.beginRead("parent", true, true, true);
  expect(later.initialInventory).toBe(false);
  controls.incompleteRead(later); controls.endRead(later, true);
  const afterPartial = controls.beginRead("parent", true, true, true);
  expect(afterPartial.initialInventory).toBe(false);
  controls.endRead(afterPartial); controlOracle(controls);
});

for (const connected of [false, true]) test(`control reads default to transcript-only across partial inventory: connected=${connected}`, () => {
  const controls = new BackgroundControls(), healthy = controlFixture("healthy"), pending = controlFixture("pending");
  const first = controls.beginRead("parent", true, connected, true);
  controls.incompleteRead(first);
  expect(controls.project(healthy.item, healthy.evidence, first).stateUncertain).toBe(false);
  controls.endRead(first, true);
  for (let retry = 0; retry < 2; retry++) {
    const transcript = controls.beginRead("parent", true, connected);
    expect(controls.project(pending.item, pending.evidence, transcript).stateUncertain).toBe(true);
    expect(controls.current(pending.item.taskId)).toBe(false);
    expect(controls.project(healthy.item, healthy.evidence, transcript).stateUncertain).toBe(false);
    controls.endRead(transcript, true);
    expect(controlOracle(controls).scopes.get("parent")).toBe("partial");
    expect(transcript.inventory).toBe(false);
  }
  const fresh = controls.beginRead("parent", true, connected, true);
  expect(controls.project(pending.item, pending.evidence, fresh).stateUncertain).toBe(false);
  controls.endRead(fresh, true);
  expect(controls.current(pending.item.taskId)).toBe(true);
  expect(controlOracle(controls).scopes.get("parent")).toBe(connected ? "inventoried" : "retained");
});

test("transcript callers cannot discharge an incomplete initial inventory requirement", () => {
  const controls = new BackgroundControls(), healthy = controlFixture("healthy"), pending = controlFixture("pending");
  const first = controls.beginRead("parent", true, true, true);
  controls.incompleteRead(first);
  expect(controls.project(healthy.item, healthy.evidence, first).stateUncertain).toBe(false);
  expect(controls.project({ ...pending.item, stateUncertain: true }, pending.evidence, first).stateUncertain).toBe(true);
  controls.endRead(first, true);
  for (let retry = 0; retry < 2; retry++) {
    const transcript = controls.beginRead("parent", true, true, false);
    expect(controls.project(pending.item, pending.evidence, transcript).stateUncertain).toBe(true);
    expect(controls.current(pending.item.taskId)).toBe(false);
    expect(controls.project(healthy.item, healthy.evidence, transcript).stateUncertain).toBe(false);
    controls.endRead(transcript, true);
    controlOracle(controls);
  }
  const fresh = controls.beginRead("parent", true, true, true);
  expect(fresh.initialInventory).toBe(true);
  expect(controls.project(pending.item, pending.evidence, fresh).stateUncertain).toBe(false);
  controls.endRead(fresh, true);
  expect(controls.current(pending.item.taskId)).toBe(true);
  controlOracle(controls);
});

for (const rejection of ["capacity", "admission"] as const) test(`rejected ${rejection} reads retain outstanding inventory without granting proof`, () => {
  const controls = new BackgroundControls(), healthy = controlFixture("healthy"), pending = controlFixture("pending");
  expect(controls.project(healthy.item, healthy.evidence).stateUncertain).toBe(false);
  const held = rejection === "capacity" ? Array.from({ length: 16 }, (_, index) => controls.beginRead(`held${index}`)) : [];
  const rejected = controls.beginRead("parent", rejection !== "admission", true, true);
  expect(rejected.failed).toBe(true);
  expect(controls.activeReads).toBe(held.length);
  // Fence other callers immediately, not only after the rejected caller ends.
  expect(controlOracle(controls).scopes.get("parent")).toBe("partial");
  expect(controls.project(pending.item, pending.evidence, rejected).stateUncertain).toBe(true);
  expect(controls.current(pending.item.taskId)).toBe(false);
  expect(controls.current(healthy.item.taskId)).toBe(true);
  controls.endRead(rejected, true);
  for (const read of held) controls.endRead(read, true);
  for (let retry = 0; retry < 2; retry++) {
    const transcript = controls.beginRead("parent", true, true, false);
    expect(controls.project(pending.item, pending.evidence, transcript).stateUncertain).toBe(true);
    expect(controls.project(healthy.item, healthy.evidence, transcript).stateUncertain).toBe(false);
    controls.endRead(transcript, true);
    expect(controlOracle(controls).scopes.get("parent")).toBe("partial");
  }
  const fresh = controls.beginRead("parent", true, true, true);
  expect(controls.project(pending.item, pending.evidence, fresh).stateUncertain).toBe(false);
  controls.endRead(fresh, true);
  expect(controls.current(pending.item.taskId)).toBe(true);
  expect(controlOracle(controls).scopes.get("parent")).toBe("inventoried");
});

test("overlong rejected read identities close new admission without retaining oversized scope keys", () => {
  const controls = new BackgroundControls(), healthy = controlFixture("healthy"), pending = controlFixture("pending");
  controls.project(healthy.item, healthy.evidence);
  const parent = "x".repeat(513), rejected = controls.beginRead(parent);
  expect(rejected.failed).toBe(true);
  controls.endRead(rejected, true);
  const state = controlOracle(controls);
  expect(state.scopes.has(parent)).toBe(false);
  expect(state.closed).toBe(true);
  expect(controls.project(healthy.item, healthy.evidence).stateUncertain).toBe(false);
  const fresh = controls.beginRead("parent", true, true, true);
  expect(controls.project(pending.item, pending.evidence, fresh).stateUncertain).toBe(true);
  controls.endRead(fresh, true); controlOracle(controls);
});

for (const budget of [{ entries: 12 }, { bytes: 5_000 }]) test(`rejected read scopes stay within ${JSON.stringify(budget)} and preserve retained controls on overflow`, () => {
  const controls = new BackgroundControls(budget), healthy = controlFixture("healthy"), pending = controlFixture("pending");
  expect(controls.project(healthy.item, healthy.evidence).stateUncertain).toBe(false);
  for (let index = 0; index < 40; index++) {
    const rejected = controls.beginRead(`rejected${index}`.padEnd(512, "x"), false, true, true);
    expect(rejected.failed).toBe(true);
    controls.endRead(rejected, true);
    controlOracle(controls);
    expect(controls.usage.bytes).toBeLessThanOrEqual(budget.bytes ?? Infinity);
    expect(controls.usage.entries).toBeLessThanOrEqual(budget.entries ?? Infinity);
  }
  expect(controlOracle(controls).closed).toBe(true);
  expect(controls.activeReads).toBe(0);
  expect(controls.project(healthy.item, healthy.evidence).stateUncertain).toBe(false);
  expect(controls.project(pending.item, pending.evidence).stateUncertain).toBe(true);
  controlOracle(controls);
});

test("rejected reads cannot reopen completed inventory or overwrite scope gaps and revocations", () => {
  const controls = new BackgroundControls({ entries: 12 }), retired = controlFixture("retired");
  const complete = controls.beginRead("parent", true, true, true);
  controls.project(retired.item, retired.evidence, complete); controls.endRead(complete, true);
  controls.endRead(controls.beginRead("parent", false, true, true), true);
  expect(controlOracle(controls).scopes.get("parent")).toBe("inventoried");
  controls.project({ ...retired.item, status: "completed" }, retired.evidence);
  for (let index = 0; index < 30; index++) controls.observe({ shutdown: false, session: "parent", launchers: [{ call: `unknown${index}`, phase: "called", background: false }] }, true);
  expect(controlOracle(controls).scopes.get("parent")).toBe("gap");
  controls.endRead(controls.beginRead("parent", false, true, true), true);
  expect(controlOracle(controls).scopes.get("parent")).toBe("gap");
  const fresh = controls.beginRead("parent", true, true, true);
  expect(controls.project(retired.item, retired.evidence, fresh).stateUncertain).toBe(true);
  controls.endRead(fresh, true); controlOracle(controls);
});

for (const guard of ["gap", "unavailable", "capacity", "foreign-birth"] as const) test(`partial inventory completion cannot clear ${guard} control guards`, () => {
  const controls = new BackgroundControls(guard === "capacity" ? { entries: 12 } : {});
  const pending = controlFixture("pending", "parent", "child", "agent"), healthy = controlFixture("healthy");
  if (guard === "unavailable") {
    controls.project(pending.item, pending.evidence);
    controls.project({ ...pending.item, status: "completed" }, pending.evidence);
  }
  const first = controls.beginRead("parent", true, true, true);
  expect(controls.project(healthy.item, healthy.evidence, first).stateUncertain).toBe(false);
  controls.incompleteRead(first); controls.endRead(first, true);
  if (guard === "gap") controls.observationGap();
  if (guard === "capacity") for (let index = 0; index < 30; index++) controls.observe({ shutdown: false, session: `unknown${index}`, launchers: [], execution: { phase: "started", historical: false } }, true);
  if (guard === "foreign-birth") controls.observe({ shutdown: false, launchers: [], lifecycle: { kind: "session.created", id: "child", parent: "other", directory: "/foreign", proof: nativeProof({ id: "foreign-birth", created: 1 }, {}) } }, false);
  for (let retry = 0; retry < 3; retry++) {
    const read = controls.beginRead("parent", true, true, true);
    expect(controls.project(pending.item, pending.evidence, read).stateUncertain).toBe(true);
    expect(controls.current(pending.item.taskId)).toBe(false);
    controls.incompleteRead(read); controls.endRead(read, true);
    controlOracle(controls);
  }
});

test("one live sibling does not consume the first complete inventory of previously unobserved cold work", () => {
  const controls = new BackgroundControls(), live = controlFixture("live"), cold = controlFixture("preexisting");
  expect(controls.project(live.item, live.evidence).stateUncertain).toBe(false);
  const read = controls.beginRead("parent", true, true, true);
  expect(read.initialInventory).toBe(true);
  expect(controls.project(cold.item, cold.evidence, read).stateUncertain).toBe(false);
  controls.endRead(read, true);
  controlOracle(controls);
});

test("one child's consumed birth cannot launder a sibling candidate predating the parent's native generation", () => {
  const controls = new BackgroundControls(), first = controlFixture("first"), stale = controlFixture("stale");
  const birth = nativeProof({ id: "parent-birth", created: 5 }, { parent: "parent" })!;
  controls.observe({ shutdown: false, session: "parent", launchers: [], lifecycle: { kind: "session.created", id: "parent", directory: "/ws", proof: birth } }, true);
  expect(controls.project(first.item, first.evidence).stateUncertain).toBe(false);
  const beforeBirth = { ...stale.evidence, launches: stale.evidence.launches.map(launch => ({ ...launch, created: 1 })) };
  expect(controls.project(stale.item, beforeBirth).stateUncertain).toBe(true);
  expect(controls.unavailable(stale.item.taskId)).toBe(true);
  controlOracle(controls);
});

test("exact consumed native birth replay is not a new creation, but a new native event retires the admitted identity", () => {
  const controls = new BackgroundControls(), fixture = controlFixture("original");
  const lifecycle = { kind: "session.created", id: "parent", directory: "/ws", proof: nativeProof({ id: "birth", created: 5 }, { parent: "parent" })! };
  controls.observe({ shutdown: false, session: "parent", launchers: [], lifecycle }, true);
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(false);
  controls.observe({ shutdown: false, session: "parent", launchers: [], lifecycle }, true);
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(false);
  controls.observe({ shutdown: false, session: "parent", launchers: [], lifecycle: { ...lifecycle, proof: { ...lifecycle.proof, id: "new-birth" } } }, true);
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(true);
  controlOracle(controls);
});

test("control growth reserves sticky identity stubs and isolates entry and byte overflow", () => {
  for (const budget of [{ entries: 16 }, { bytes: 5_000 }]) {
    const controls = new BackgroundControls(budget), healthy = controlFixture("healthy", "other"), growing = controlFixture("growing");
    expect(controls.project(healthy.item, healthy.evidence).stateUncertain).toBe(false);
    expect(controls.project(growing.item, growing.evidence).stateUncertain).toBe(false);
    const launches = Array.from({ length: 32 }, (_, index) => ({ ...growing.evidence.launches[0]!, call: `alias${index}` }));
    expect(controls.project({ ...growing.item, toolUseIds: launches.map(fact => fact.call) }, { ...growing.evidence, launches }).stateUncertain).toBe(true);
    expect(controls.unavailable(growing.item.taskId)).toBe(true);
    expect(controls.project(growing.item, growing.evidence).stateUncertain).toBe(true);
    expect(controls.project(healthy.item, healthy.evidence).stateUncertain).toBe(false);
    const state = controlOracle(controls);
    expect(state.records.get(growing.item.taskId)).toEqual({ parent: "parent", taskId: growing.item.taskId, unavailable: true, aliases: ["growing"] });
    expect(controls.usage.bytes).toBeLessThanOrEqual(budget.bytes ?? Infinity);
    expect(controls.usage.entries).toBeLessThanOrEqual(budget.entries ?? Infinity);
  }
});

test("control accounting covers guards, witnesses, aliases, provisional facts and tombstone containers", () => {
  const controls = new BackgroundControls(), fixture = controlFixture("accounting");
  const proof = nativeProof({ id: "native", created: 10 }, { input: "fixture" })!;
  const read = controls.beginRead("parent");
  expect(controls.project(fixture.item, fixture.evidence, read, [{ kind: "called", proof }]).stateUncertain).toBe(false);
  controlOracle(controls);
  controls.observe({ shutdown: false, session: "unrelated", launchers: [{ call: "other", phase: "progress", child: "elsewhere" }] }, true);
  controlOracle(controls);
  controls.endRead(read);
  controlOracle(controls);
  controls.observe({ shutdown: false, session: fixture.evidence.worker, execution: { phase: "ended", proof, historical: false }, launchers: [] }, true);
  controls.project({ ...fixture.item, status: "completed" }, fixture.evidence);
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(true);
  controlOracle(controls);
});

test("pre-read contradictory facts survive sparse progress and later recovery reads", () => {
  const controls = new BackgroundControls(), fixture = controlFixture("cold");
  const snapshot = { ...fixture.evidence.launches[0]!, ran: 100 };
  controls.observe({ shutdown: false, session: "parent", launchers: [snapshot] }, true);
  controls.observe({ shutdown: false, session: "parent", launchers: [{ call: "cold", phase: "progress", child: "cold" }] }, true);
  const read = controls.beginRead("parent");
  expect(controls.project(fixture.item, fixture.evidence, read).stateUncertain).toBe(true);
  controls.endRead(read);
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(true);
  controlOracle(controls);
});

test("pending call identities are charged and absence cannot resolve an unbound invocation", () => {
  const controls = new BackgroundControls(), fixture = controlFixture("selected", "parent", "child", "agent");
  controls.project(fixture.item, fixture.evidence);
  controls.observe({ shutdown: false, session: "parent", launchers: [{ call: "new_call", phase: "called", workerType: "agent", message: "new_owner", requestedChild: "child", background: false }] }, true);
  expect(controlOracle(controls).records.get(fixture.item.taskId)?.pendingCalls).toEqual(["new_call"]);
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(true);
  controlOracle(controls);
});

test("missing native kind or owner is unproven, while sparse facts cannot erase or contradict a proven identity", () => {
  const fixture = controlFixture("identity", "parent", "child", "agent");
  for (const candidate of [
    { ...fixture.evidence, kind: undefined },
    { ...fixture.evidence, launches: fixture.evidence.launches.map(launch => ({ ...launch, message: undefined })) },
    { ...fixture.evidence, launches: fixture.evidence.launches.map(launch => ({ ...launch, workerType: undefined })) },
    { ...fixture.evidence, launches: fixture.evidence.launches.map(launch => ({ ...launch, created: undefined })) },
    { ...fixture.evidence, launches: fixture.evidence.launches.map(launch => ({ ...launch, inputFingerprint: undefined })) },
    { ...fixture.evidence, launches: fixture.evidence.launches.map(launch => ({ ...launch, created: undefined, inputFingerprint: undefined })) },
  ]) {
    const controls = new BackgroundControls();
    expect(controls.project(fixture.item, candidate).stateUncertain).toBe(true);
    expect(controls.proof(fixture.item.taskId)).toBeUndefined();
    controlOracle(controls);
  }
  const controls = new BackgroundControls();
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(false);
  const sparse = { call: "identity", phase: "progress" as const, child: "child" };
  controls.observe({ shutdown: false, session: "parent", launchers: [sparse] }, true);
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(false);
  const changed = retainLauncherEvidence(fixture.evidence.launches[0], { ...sparse, message: "different_owner", workerType: "shell" });
  expect(changed).toMatchObject({ message: "message:identity", workerType: "agent", conflicted: true });
  controls.observe({ shutdown: false, session: "parent", launchers: [changed] }, true);
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(true);
  controlOracle(controls);
});

test("an unproven cold alias cannot seed missing owner evidence into another retained basis", () => {
  const controls = new BackgroundControls(), original = controlFixture("original", "parent", "child", "agent"), alias = controlFixture("alias", "parent", "child", "agent");
  expect(controls.project(original.item, original.evidence).stateUncertain).toBe(false);
  const full = { ...original.evidence, launches: [...original.evidence.launches, ...alias.evidence.launches] };
  const partial = { ...alias.evidence, launches: [...original.evidence.launches, ...alias.evidence.launches.map(launch => ({ ...launch, message: undefined }))] };
  expect(controls.project(alias.item, partial).stateUncertain).toBe(true);
  expect(controls.project(original.item, full).stateUncertain).toBe(false);
  const replacement = { ...full, launches: full.launches.map(launch => launch.call === "alias" ? { ...launch, message: "replacement_owner" } : launch) };
  expect(controls.project(original.item, replacement).stateUncertain).toBe(true);
  controlOracle(controls);
});

test.each(["created", "inputFingerprint", "both"] as const)("a cold alias missing %s cannot weaken or enrich a complete retained invocation", field => {
  const controls = new BackgroundControls(), original = controlFixture("original", "parent", "child", "agent"), alias = controlFixture("alias", "parent", "child", "agent");
  expect(controls.project(original.item, original.evidence).stateUncertain).toBe(false);
  const partial = { ...alias.evidence, launches: [...original.evidence.launches, ...alias.evidence.launches.map(launch => ({ ...launch,
    ...(field !== "inputFingerprint" ? { created: undefined } : {}), ...(field !== "created" ? { inputFingerprint: undefined } : {}) }))] };
  expect(controls.project(alias.item, partial).stateUncertain).toBe(true);
  expect(controls.proof(alias.item.taskId)).toBeUndefined();
  expect(controls.basis(original.item.taskId)?.launches).toHaveLength(1);
  expect(controls.project(original.item, original.evidence).stateUncertain).toBe(false);
  const complete = { ...alias.evidence, launches: [...original.evidence.launches, ...alias.evidence.launches] };
  expect(controls.project(alias.item, complete).stateUncertain).toBe(false);
  expect(controls.basis(original.item.taskId)?.launches).toHaveLength(2);
  const changed = { ...complete, launches: complete.launches.map(launch => launch.call === "alias" ? { ...launch, inputFingerprint: "different-native-input" } : launch) };
  expect(controls.project(original.item, changed).stateUncertain).toBe(true);
  expect(controls.project(alias.item, complete).stateUncertain).toBe(true);
  controlOracle(controls);
});

test("space released after a scope gap cannot admit previously uncovered aliases into a retained target", () => {
  const controls = new BackgroundControls(), original = controlFixture("original", "parent", "child", "agent"), healthy = controlFixture("healthy");
  const retired = controlFixture("retired"), launches = Array.from({ length: 4 }, (_, index) => ({ ...retired.evidence.launches[0]!, call: `retired${index}`, message: `retired_owner${index}` }));
  const retiredEvidence = { ...retired.evidence, launches }, retiredItem = { ...retired.item, toolUseIds: launches.map(launch => launch.call) };
  controls.project(original.item, original.evidence);
  controls.project(healthy.item, healthy.evidence);
  controls.project(retiredItem, retiredEvidence);
  for (let index = 0; index < 2_049; index++) controls.observe({ shutdown: false, session: "parent", launchers: [{ call: `unknown${index}`, phase: "called", background: false }] }, true);
  expect(controls.project(original.item, original.evidence).stateUncertain).toBe(false);
  controls.project({ ...retiredItem, status: "completed" }, retiredEvidence);
  const alias = controlFixture("alias", "parent", "child", "agent");
  const candidate = { ...original.evidence, launches: [...original.evidence.launches, ...alias.evidence.launches] };
  expect(controls.project({ ...original.item, toolUseIds: ["original", "alias"] }, candidate).stateUncertain).toBe(true);
  expect(controls.project(healthy.item, healthy.evidence).stateUncertain).toBe(false);
  controlOracle(controls);
});

test("terminal compaction cannot readmit a retired alias as a new canonical identity", () => {
  const controls = new BackgroundControls(), fixture = controlFixture("original"), alias = controlFixture("alias", "parent", "original");
  const evidence = { ...fixture.evidence, launches: [...fixture.evidence.launches, ...alias.evidence.launches] };
  expect(controls.project({ ...fixture.item, toolUseIds: ["original", "alias"] }, evidence).stateUncertain).toBe(false);
  controls.project({ ...fixture.item, status: "completed" }, evidence);
  expect(controls.project(alias.item, alias.evidence).stateUncertain).toBe(true);
  controlOracle(controls);
});

test("a retained cold alias can join canonical history but all published identities share revocation", () => {
  const controls = new BackgroundControls(), fixture = controlFixture("original"), alias = controlFixture("alias", "parent", "original");
  expect(controls.project(alias.item, alias.evidence).stateUncertain).toBe(false);
  const evidence = { ...fixture.evidence, launches: [...fixture.evidence.launches, ...alias.evidence.launches] };
  expect(controls.project({ ...fixture.item, toolUseIds: ["original", "alias"] }, evidence).stateUncertain).toBe(false);
  controls.project({ ...fixture.item, status: "completed" }, evidence);
  expect(controls.project(alias.item, alias.evidence).stateUncertain).toBe(true);
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(true);
  controlOracle(controls);
});

test("published row mutation cannot change private control payload or its accounting", () => {
  const controls = new BackgroundControls(), fixture = controlFixture("private");
  const projected = controls.project({ ...fixture.item, toolUseIds: ["private"] }, fixture.evidence);
  projected.toolUseIds!.push("not-a-native-alias");
  projected.description = "Changed by a consumer";
  const updates = controls.observe({ shutdown: false, session: "parent", launchers: [{ ...fixture.evidence.launches[0]!, child: "replacement" }] }, true);
  expect(updates[0]?.item.toolUseIds).toEqual(["private"]);
  expect(updates[0]?.item.description).toBe("Fixture");
  controlOracle(controls);
});

test("projection saturation and unclassified coverage overflow leave retained controls usable", () => {
  const controls = new BackgroundControls({ entries: 12 }), retained = controlFixture("retained"), missing = controlFixture("missing");
  expect(controls.project(retained.item, retained.evidence).stateUncertain).toBe(false);
  const read = controls.beginRead("parent");
  controls.projectionSaturated();
  for (let i = 0; i < 30; i++) controls.observe({ shutdown: false, session: `unknown${i}`, execution: { phase: "started", historical: false }, launchers: [] }, true);
  expect(read.failed).toBe(false);
  expect(controls.project(retained.item, retained.evidence, read).stateUncertain).toBe(false);
  expect(controls.project(missing.item, missing.evidence, read).stateUncertain).toBe(true);
  controls.endRead(read);
  controls.observe({ shutdown: false, session: "parent", launchers: [{ ...retained.evidence.launches[0]!, child: "replacement" }] }, true);
  expect(controls.project(retained.item, retained.evidence).stateUncertain).toBe(true);
  controlOracle(controls);
});

test("control observation gaps persist until disposal and guard admission never exceeds sixteen", () => {
  const controls = new BackgroundControls(), fixture = controlFixture("gap");
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(false);
  const reads = Array.from({ length: 20 }, () => controls.beginRead("parent"));
  expect(controls.activeReads).toBe(16);
  expect(reads.filter(read => read.failed)).toHaveLength(4);
  controls.observationGap();
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(true);
  for (const read of reads) controls.endRead(read);
  expect(controls.activeReads).toBe(0);
  controlOracle(controls);
  controls.clear();
  expect(controlOracle(controls).records.size).toBe(0);
});

for (const kind of ["agent", "shell"] as const) test(`observation gaps require a new covered ${kind} birth and exact live launcher without reviving old aliases`, () => {
  const controls = new BackgroundControls(), old = controlFixture("old", "parent", "old-worker", kind);
  const alias = controlFixture("alias", "parent", "old-worker", kind);
  controls.project({ ...old.item, toolUseIds: ["old", "alias"] }, { ...old.evidence, launches: [...old.evidence.launches, ...alias.evidence.launches] });
  const before = controlFixture("before", "parent", "before-worker", kind);
  const birth = (fixture: ReturnType<typeof controlFixture>, id: string) => {
    const proof = nativeProof({ id, created: 5 }, { worker: fixture.evidence.worker })!;
    controls.observe({ shutdown: false, launchers: [], ...(kind === "shell" ? { directory: "/ws", shellBirth: { id: fixture.evidence.worker, parent: "parent", proof, commandFingerprint: shellCommandFingerprint("fixture") } }
      : { lifecycle: { kind: "session.created", id: fixture.evidence.worker, parent: "parent", directory: "/ws", proof } }) }, true);
  };
  birth(before, "before-birth");
  const read = controls.beginRead("parent");
  controls.observationGap();
  expect(read.failed).toBe(true); controls.endRead(read);
  expect(controls.project(alias.item, alias.evidence).stateUncertain).toBe(true);
  expect(controls.project(old.item, old.evidence).stateUncertain).toBe(true);
  // Replaying the exact pre-gap birth and restating its launcher is not coverage.
  birth(before, "before-birth");
  controls.observe({ shutdown: false, session: "parent", launchers: before.evidence.launches }, true);
  expect(controls.project(before.item, before.evidence).stateUncertain).toBe(true);
  for (let gap = 0; gap < 2; gap++) {
    const fresh = controlFixture(`fresh${gap}`, "parent", `worker${gap}`, kind);
    controls.observe({ shutdown: false, session: "parent", launchers: fresh.evidence.launches }, true);
    expect(controls.project(fresh.item, fresh.evidence).stateUncertain).toBe(true);
    birth(fresh, `fresh-birth${gap}`);
    let evidence = fresh.evidence;
    const proof = nativeProof({ id: `start${gap}`, created: 11 }, { worker: evidence.worker })!;
    if (kind === "agent") {
      evidence = { ...evidence, executionStart: proof };
      controls.observe({ shutdown: false, session: evidence.worker, launchers: [], execution: { phase: "started", proof, historical: false } }, true);
    }
    expect(controls.project(fresh.item, evidence, undefined, kind === "agent" ? [{ kind: "started", proof }] : []).stateUncertain).toBe(false);
    controlOracle(controls);
    controls.observationGap();
    expect(controls.project(fresh.item, evidence).stateUncertain).toBe(true);
    controlOracle(controls);
  }
});

test("a new covered birth cannot reopen true control capacity closure", () => {
  const controls = new BackgroundControls({ entries: 12 });
  for (let index = 0; index < 30; index++) controls.observe({ shutdown: false, session: `unknown${index}`, launchers: [], execution: { phase: "started", historical: false } }, true);
  expect(controlOracle(controls).closed).toBe(true);
  controls.observationGap();
  const fresh = controlFixture("fresh");
  controls.observe({ shutdown: false, directory: "/ws", launchers: [], shellBirth: { id: fresh.evidence.worker, parent: "parent", proof: nativeProof({ id: "birth" }, {}) } }, true);
  controls.observe({ shutdown: false, session: "parent", launchers: fresh.evidence.launches }, true);
  expect(controls.project(fresh.item, fresh.evidence).stateUncertain).toBe(true);
  expect(controlOracle(controls).closed).toBe(true);
});

for (const change of ["replay", "new-envelope", "command", "started", "foreign-parent", "foreign-scope", "missing-proof", "user-after-rebirth"] as const) {
  test(`retained shell birth comparison: ${change}`, () => {
    const controls = new BackgroundControls(), fixture = controlFixture("selected", "parent", "shell");
    const info = { id: "shell", command: "fixture", time: { started: 5 }, metadata: { sessionID: "parent" } };
    const envelope = { id: "birth", created: 5 };
    const proof = nativeProof(envelope, { type: "shell.created", info })!;
    controls.observationGap();
    controls.observe({ shutdown: false, launchers: [], shellBirth: { id: "shell", parent: "parent", proof, commandFingerprint: shellCommandFingerprint(info.command) } }, true);
    controls.observe({ shutdown: false, session: "parent", launchers: fixture.evidence.launches }, true);
    expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(false);
    const basis = controls.proof(fixture.item.taskId)!;
    const read = controls.beginRead("parent");
    const changedInfo = { ...info, ...(change === "command" ? { command: "replacement" } : {}), ...(change === "started" ? { time: { started: 90 } } : {}) };
    const changedProof = change === "missing-proof" ? undefined : nativeProof({ ...envelope,
      ...(change === "new-envelope" || change === "user-after-rebirth" ? { id: "another-birth" } : {}) }, { type: "shell.created", info: changedInfo });
    const updates = controls.observe({ shutdown: false, launchers: [], shellBirth: { id: "shell",
      parent: change === "foreign-parent" ? "other" : "parent", proof: changedProof, commandFingerprint: shellCommandFingerprint(changedInfo.command) } }, change !== "foreign-scope");
    if (change === "user-after-rebirth") controls.observe({ shutdown: false, launchers: [], userShell: { id: "shell", parent: "parent" } }, true);
    if (change === "replay") {
      expect(controls.proof(fixture.item.taskId)).toEqual(basis);
      expect(updates).toEqual([]);
      expect(controls.project(fixture.item, fixture.evidence, read).stateUncertain).toBe(false);
    } else {
      expect(updates).toMatchObject([{ parent: "parent", item: { taskId: fixture.item.taskId, stateUncertain: true } }]);
      expect(controls.proof(fixture.item.taskId)).toBeUndefined();
      expect(controls.project(fixture.item, fixture.evidence, read).stateUncertain).toBe(true);
      expect(controls.unavailable(fixture.item.taskId)).toBe(true);
    }
    controls.endRead(read); controlOracle(controls);
  });
}

for (const change of ["compatible", "old-command", "missing-birth-command", "missing-launch-command", "alias-command", "foreign-parent", "wrong-kind", "no-birth", "delayed-old"] as const) {
  test(`first shell admission binds canonical birth command: ${change}`, () => {
    const controls = new BackgroundControls(), workers = new BackgroundWorkers(), normalize = createOpenCodeV2Normalizer("/ws");
    const parent = "parent", worker = "SH";
    const birth = { id: "native-birth", created: 31, type: "shell.created", location: { directory: "/ws" }, data: { info: {
      id: worker, ...(change === "missing-birth-command" ? {} : { command: "NEW" }), time: { started: 30 }, metadata: { sessionID: change === "foreign-parent" ? "other" : parent } } } };
    controls.observationGap();
    if (change !== "no-birth") controls.observe(normalize.prepare(birth).evidence, true);
    const tool = (call: string, command: string | undefined, created = 29) => prepareTool({ id: call, name: "shell", time: { created, completed: 32 }, state: {
      status: "completed", input: command === undefined ? {} : { command }, metadata: { shellID: worker, status: "running" } } }, 40, "snapshot", `message-${call}`);
    if (change === "delayed-old") {
      const incomplete = prepareTool({ id: "call", name: "shell", time: { created: 10 }, state: { status: "completed", metadata: { shellID: worker, status: "running" } } }, 40, "snapshot", "message-call");
      workers.launchPrepared(parent, incomplete, 40);
      expect(controls.project(controlFixture("call", parent, worker).item, workers.occurrence("v2:parent:call")).stateUncertain).toBe(true);
      expect(controls.proof("v2:parent:call")).toBeUndefined();
    }
    const prepared = tool("call", change === "missing-launch-command" ? undefined : change === "old-command" || change === "delayed-old" ? "OLD" : "NEW", change === "old-command" || change === "delayed-old" ? 10 : 29);
    controls.observe({ shutdown: false, session: parent, launchers: [prepared.fact] }, true);
    const projectedWorkers = new BackgroundWorkers();
    projectedWorkers.launchPrepared(parent, prepared, 40);
    if (change === "alias-command") {
      const alias = tool("alias", "OLD");
      controls.observe({ shutdown: false, session: parent, launchers: [alias.fact] }, true);
      projectedWorkers.launchPrepared(parent, alias, 40);
    }
    const fixture = change === "wrong-kind" ? controlFixture("call", parent, worker, "agent") : controlFixture("call", parent, worker);
    const evidence = change === "wrong-kind" ? fixture.evidence : projectedWorkers.occurrence("v2:parent:call");
    const read = controls.beginRead(parent, true, true, true);
    expect(controls.project(fixture.item, evidence, read).stateUncertain).toBe(change !== "compatible");
    expect(!!controls.proof(fixture.item.taskId)).toBe(change === "compatible");
    controls.endRead(read, true); controlOracle(controls);
  });
}

test("a command-unproven post-gap alias cannot enrich another retained shell basis", () => {
  const controls = new BackgroundControls(), fixture = controlFixture("original", "parent", "SH");
  const normalize = createOpenCodeV2Normalizer("/ws");
  controls.observationGap();
  controls.observe(normalize.prepare({ id: "birth", created: 5, type: "shell.created", location: { directory: "/ws" }, data: { info: {
    id: "SH", command: "fixture", metadata: { sessionID: "parent" } } } }).evidence, true);
  controls.observe({ shutdown: false, session: "parent", launchers: fixture.evidence.launches }, true);
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(false);
  const retained = controls.basis(fixture.item.taskId);
  const alias = controlFixture("alias", "parent", "SH");
  const unproven = prepareTool({ id: "alias", name: "shell", time: { created: 10, completed: 20 }, state: {
    status: "completed", input: {}, metadata: { shellID: "SH", status: "running" } } }, 20, "snapshot", "message:alias").fact;
  controls.observe({ shutdown: false, session: "parent", launchers: [unproven] }, true);
  expect(controls.project(alias.item, { ...alias.evidence, launches: [unproven, ...fixture.evidence.launches] }).stateUncertain).toBe(true);
  expect(controls.basis(fixture.item.taskId)).toBe(retained);
  expect(controls.proof(alias.item.taskId)).toBeUndefined();
  expect(controls.project(fixture.item, { ...fixture.evidence, launches: [...fixture.evidence.launches, unproven] }).stateUncertain).toBe(true);
  controlOracle(controls);
});

test("initial cold shell admission preserves native zero and an empty input without inventing a command facet", () => {
  const workers = new BackgroundWorkers(), controls = new BackgroundControls();
  const prepared = prepareTool({ id: "cold", name: "shell", time: { created: 0, completed: 1 }, state: {
    status: "completed", input: {}, metadata: { shellID: "SH", status: "running" } } }, 1, "snapshot", "owning-message");
  const update = workers.launchPrepared("parent", prepared, 1)[0]!;
  if (update.kind !== "upsert" || update.item.type !== "background_task") throw new Error("expected cold shell");
  expect(prepared.fact.commandFingerprint).toBeUndefined();
  expect(controls.project(update.item, workers.occurrence(update.item.taskId)).stateUncertain).toBe(false);
  controlOracle(controls);
  const uncovered = new BackgroundControls(); uncovered.observationGap();
  expect(uncovered.project(update.item, workers.occurrence(update.item.taskId)).stateUncertain).toBe(true);
  controlOracle(uncovered);
});

test("post-gap shell association consumes only a matching birth covered by that occurrence", () => {
  const controls = new BackgroundControls(), fixture = controlFixture("fresh", "parent", "SH"), normalize = createOpenCodeV2Normalizer("/ws");
  const birth = (id: string, command: unknown = "fixture") => normalize.prepare({ id, created: 5, type: "shell.created", location: { directory: "/ws" }, data: { info: {
    id: "SH", command, metadata: { sessionID: "parent" } } } }).evidence;
  const uncovered = birth("uncovered");
  controls.observe(uncovered, true);
  controls.observationGap();
  controls.observe(birth("covered"), true);
  controls.observe({ shutdown: false, session: "parent", launchers: fixture.evidence.launches }, true);
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(false);
  // Same command does not make this pre-gap, never-associated birth a replay.
  controls.observe(uncovered, true);
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(true);
  controlOracle(controls);
});

test("a canonical command contradiction in sparse progress immediately revokes a retained shell", () => {
  const controls = new BackgroundControls(), fixture = controlFixture("known", "parent", "SH");
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(false);
  const progress = prepareTool({ id: "known", name: "shell", state: { input: { command: "different" }, metadata: { shellID: "SH", status: "running" } } }, 30, "progress", "message:known");
  expect(controls.observe({ shutdown: false, session: "parent", launchers: [progress.fact] }, true)).toMatchObject([
    { parent: "parent", item: { taskId: fixture.item.taskId, stateUncertain: true } },
  ]);
  expect(controls.proof(fixture.item.taskId)).toBeUndefined();
  controlOracle(controls);
});

test("idle entry and byte pressure preserve fresh guard headroom for retained controls", () => {
  for (const padded of [false, true]) {
    const controls = new BackgroundControls(), fixture = controlFixture("retained");
    expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(false);
    for (let index = 0; index < 2_049; index++) controls.observe({ shutdown: false,
      session: padded ? `unknown${index}`.padEnd(512, "x") : `unknown${index}`, execution: { phase: "started", historical: false }, launchers: [] }, true);
    expect(controls.activeReads).toBe(0);
    const reads = Array.from({ length: 16 }, () => controls.beginRead("\ud800".repeat(512)));
    expect(reads.every(read => !read.failed)).toBe(true);
    expect(controls.project(fixture.item, fixture.evidence, reads[0]).stateUncertain).toBe(false);
    expect(controls.beginRead("overflow").failed).toBe(true);
    controlOracle(controls);
    for (const read of reads) controls.endRead(read);
    const later = controls.beginRead("parent");
    expect(later.failed).toBe(false);
    expect(controls.project(fixture.item, fixture.evidence, later).stateUncertain).toBe(false);
    controls.endRead(later);
    controlOracle(controls);
    if (padded) {
      const short = Array.from({ length: 16 }, () => controls.beginRead("parent"));
      expect(short.every(read => !read.failed)).toBe(true);
      for (let index = 0; index < 2_049; index++) controls.observe({ shutdown: false,
        session: `more${index}`.padEnd(512, "y"), execution: { phase: "started", historical: false }, launchers: [] }, true);
      for (const read of short) controls.endRead(read);
      const long = Array.from({ length: 16 }, () => controls.beginRead("\ud800".repeat(512)));
      expect(long.every(read => !read.failed)).toBe(true);
      controlOracle(controls);
      for (const read of long) controls.endRead(read);
    }
  }
});

test("actual controls and disposable projection jointly respect the live aggregate", () => {
  const controls = new BackgroundControls({ changed: () => workers.enforceBudget() });
  const workers = new BackgroundWorkers({ retained: () => controls.usage, onSaturation: () => controls.projectionSaturated() });
  for (let index = 0; index < 2_200; index++) {
    const fixture = controlFixture(`call${index}`);
    controls.project(fixture.item, fixture.evidence);
    workers.verifyChild(`child${index}`.padEnd(512, "x"), "parent".padEnd(512, "y"));
    workers.enforceBudget();
    const state = retained(workers), controlsState = controlOracle(controls);
    const projectionEntries = [state.parents, state.tasks, state.notices, state.unmatched, state.ended, state.aliases, state.invocations, state.terminalProofs, state.userShells].reduce((sum, values) => sum + values.size, 0) + state.boundaries;
    expect(state.bytes + controls.usage.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(projectionEntries + controls.usage.entries).toBeLessThanOrEqual(8_192);
    expect(controlsState.records.size).toBeLessThanOrEqual(2_048);
  }
  expect(retained(workers).recoveryOnly).toBe(true);
});

test("control-budget serialization scales with changed entries, not the retained collection", () => {
  const stringify = JSON.stringify;
  const work = (count: number) => {
    const fixtures = Array.from({ length: count }, (_, index) => controlFixture(`call${index}`));
    const controls = new BackgroundControls();
    let characters = 0;
    const spy = spyOn(JSON, "stringify").mockImplementation((value: unknown) => { const result = stringify(value); characters += result?.length ?? 0; return result; });
    try { for (const fixture of fixtures) controls.project(fixture.item, fixture.evidence); }
    finally { spy.mockRestore(); }
    controlOracle(controls);
    return characters;
  };
  expect(work(256)).toBeLessThan(work(128) * 2.2);
});

test.each([[0, null], [5, 5]] as const)("uncorrelated shell result at %s retains shell projection and output inspection", (at, reportClock) => {
  const workers = new BackgroundWorkers();
  const started = workers.launch("parent", launch("call", "sh1"), 10);
  const result = workers.notification("parent", "result", { text: "<shell>\nCaptured output\n</shell>", metadata: { source: "shell", shellID: "sh1", state: "completed", exit: 0 } }, at, reportClock);
  expect(started[0]).toMatchObject({ item: { status: "running", createdAt: 10 } });
  expect(result).toHaveLength(1);
  const update = result![0]!;
  if (update.kind !== "upsert" || update.item.type !== "background_task") throw new Error("expected independent result");
  expect(update.item).toMatchObject({ taskType: "shell", outputFile: "shell:sh1", summary: "Captured output", resultId: "result" });
  expect(update.item).not.toHaveProperty("childConversationId");
  expect(update.item).not.toHaveProperty("toolUseId");
  if (reportClock === null) expect(update.item).not.toHaveProperty("terminalReportedAt");
  expect(compactWorkers([update.item])).toMatchObject([{ kind: "shell", since: 0 }]);
  expect(taskInspection(update.item)).toEqual({ view: "output" });
  expect(workers.launch("parent", launch("call", "sh1"), 10)).toEqual(started);
});

test("settling a pending result also publishes uncertainty for the superseded occurrence", () => {
  const workers = new BackgroundWorkers();
  const items = new Map<string, ConversationItem>();
  const apply = (updates: ReturnType<BackgroundWorkers["launch"]> = []) => {
    for (const update of updates) {
      if (update.kind === "upsert") items.set(update.item.id, update.item);
      if (update.kind === "remove") items.delete(update.itemId);
    }
  };
  workers.verifyChild("child", "parent");
  const result = { text: "Report", metadata: { source: "subagent", childID: "child", state: "completed" } };
  apply(workers.notification("parent", "r1", result, 15));
  apply(workers.notification("parent", "r2", result, 25));
  const part = (id: string) => ({ id, name: "subagent", state: { status: "completed", input: { description: id }, metadata: { status: "running", sessionID: "child" } } });
  apply(workers.launch("parent", part("A"), 10));
  expect(compactWorkers([...items.values()]).find(worker => worker.taskId === "v2:parent:A")?.state).toBe("working");
  workers.executionEnded("child", 18);
  const next = workers.launch("parent", part("B"), 20);
  apply(next);
  expect(next).toContainEqual(expect.objectContaining({ kind: "upsert", item: expect.objectContaining({ taskId: "v2:parent:A", stateUncertain: true }) }));
  expect(items.get("task:v2:parent:A")).toMatchObject({ status: "running", stateUncertain: true });
  expect(items.get("task:v2:parent:B")).toMatchObject({ status: "completed", resultId: "r2", terminalReportedAt: 25 });
  expect(items.has("task:v2:parent:notification:r2")).toBe(false);
  expect(items.get("task:v2:parent:notification:r1")).toMatchObject({ resultId: "r1" });
  expect(compactWorkers([...items.values()]).find(worker => worker.taskId === "v2:parent:A")?.state).toBe("unknown");
  expect(compactWorkers([...items.values()]).find(worker => worker.taskId === "v2:parent:B")?.state).toBe("completed");
});

test("a native-clock shell result waits silently for its scoped background launch", () => {
  const workers = new BackgroundWorkers();
  const payload = { text: "<shell>\nEarly result\n</shell>", metadata: { source: "shell", shellID: "sh1", state: "completed", exit: 0 } };
  expect(workers.notification("parent", "result", payload, 15) ?? []).toEqual([]);
  expect(workers.launch("other-parent", launch("foreign", "sh1"), 10)).toMatchObject([{ item: { status: "running" } }]);
  const updates = workers.launch("parent", launch("call", "sh1"), 10);
  expect(updates).toMatchObject([{ kind: "upsert", item: { taskType: "shell", outputFile: "shell:sh1", toolUseId: "call", status: "completed", resultId: "result", summary: "Early result", terminalReportedAt: 15 } }]);
  const update = updates[0]!;
  if (update.kind !== "upsert" || update.item.type !== "background_task") throw new Error("expected correlated shell");
  expect(taskInspection(update.item)).toEqual({ view: "output" });
  expect(compactWorkers([update.item])).toMatchObject([{ kind: "shell", state: "completed", since: 10, settledAt: 15 }]);
  expect(workers.notification("parent", "result", payload, 30)).toEqual([]);
});

test("unpublished shell payloads have a separate count and byte bound without discarding their negative facts", () => {
  const workers = new BackgroundWorkers();
  const payload = (worker: string, summary: string) => ({ text: summary, metadata: { source: "shell", shellID: worker, state: "completed", exit: 0 } });
  for (let index = 0; index < 140; index++) workers.notification("parent", `pending${index}`, payload(`worker${index}`, "Pending output"), 20);
  expect(retained(workers).unmatched.size).toBeLessThanOrEqual(128);
  expect(workers.controlEvidenceAvailable).toBe(true);
  workers.notification("parent", "large", payload("reused", "x".repeat(300 * 1024)), 20);
  expect(workers.controlEvidenceAvailable).toBe(true);
  checkBytes(workers);
  const state = workers as unknown as { unmatched: Map<string, unknown>; sizes: Map<object, Map<string, number>> };
  expect([...(state.sizes.get(state.unmatched)?.values() ?? [])].reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(256 * 1024);
  const discarded = workers.launch("parent", { ...launch("old", "reused"), time: { created: 10, completed: 11 } }, 10);
  expect(discarded).toMatchObject([{ item: { taskId: "v2:parent:old", status: "running", stateUncertain: true } }]);
  expect(workers.notification("parent", "large", payload("reused", "duplicate"), 30)).toEqual([]);
  const newer = workers.launch("parent", { ...launch("new", "reused"), time: { created: 40, completed: 41 } }, 40);
  expect(newer.at(-1)).toMatchObject({ item: { taskId: "v2:parent:new", status: "running" } });
  expect((newer.at(-1) as { item: BackgroundTaskItem }).item.resultId).toBeUndefined();
  checkBytes(workers);
});

test("typed user-shell classifications share the aggregate ledger and have their own disposable bound", () => {
  const workers = new BackgroundWorkers();
  for (let index = 0; index < 140; index++) {
    workers.observeUserShell("parent", `shell${index}`);
    checkBytes(workers);
  }
  const state = retained(workers);
  expect(state.userShells.size).toBe(128);
  expect(workers.isUserShell("parent", "shell0")).toBe(false);
  expect(workers.isUserShell("parent", "shell139")).toBe(true);
  expect(workers.isUserShell("other", "shell139")).toBe(false);
  for (let index = 0; index < 140; index++) workers.observeUserShell("parent".padEnd(512, "x"), `shell${index}`.padEnd(512, "y"));
  const sizes = state.sizes as Map<object, Map<string, number>>;
  expect([...(sizes.get(state.userShells)?.values() ?? [])].reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(64 * 1024);
  expect(workers.controlEvidenceAvailable).toBe(true);
  checkBytes(workers);
  workers.observeUserShell("parent", "shell139");
  expect(workers.isUserShell("parent", "shell139")).toBe(true);
  workers.launch("parent", launch("actual-worker", "shell139"), 10);
  expect(workers.isUserShell("parent", "shell139")).toBe(false);
});

test("positive user-shell classification never clears a genuine retained worker revocation", () => {
  const controls = new BackgroundControls(), fixture = controlFixture("worker", "parent", "shell");
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(false);
  controls.observe({ shutdown: false, launchers: [], userShell: { id: "shell", parent: "parent" } }, true);
  expect(controls.project(fixture.item, fixture.evidence).stateUncertain).toBe(true);
  const read = controls.beginRead("parent");
  expect(controls.project(fixture.item, fixture.evidence, read).stateUncertain).toBe(true);
  controls.endRead(read);
  controlOracle(controls);
});

test.each([[100, null], [5, 5]] as const)("a prelaunch shell report with unproven occurrence at %s stays independent", (at, reportClock) => {
  const workers = new BackgroundWorkers();
  const payload = { text: "Old or undated result", metadata: { source: "shell", shellID: "reused", state: "completed", exit: 0 } };
  expect(workers.notification("parent", "result", payload, at, reportClock)).toEqual([]);
  const updates = workers.launch("parent", launch("new", "reused"), 10);
  expect(updates).toHaveLength(2);
  const items = updates.flatMap(update => update.kind === "upsert" ? [update.item] : []);
  expect(items).toContainEqual(expect.objectContaining({ taskId: "v2:parent:new", status: "running" }));
  const result = items.find(item => item.type === "background_task" && item.resultId === "result");
  if (result?.type !== "background_task") throw new Error("expected independent shell result");
  expect(result).toMatchObject({ taskType: "shell", outputFile: "shell:reused", status: "completed" });
  expect(result).not.toHaveProperty("toolUseId");
  expect(taskInspection(result)).toEqual({ view: "output" });
  if (reportClock === null) expect(result).not.toHaveProperty("terminalReportedAt");
  expect(compactWorkers(items).map(worker => [worker.taskId, worker.kind, worker.state])).toEqual([
    ["v2:parent:new", "shell", "working"], ["v2:parent:notification:result", "shell", "completed"],
  ]);
  expect(workers.notification("parent", "result", payload, 200)).toEqual([]);
});

test("prior shell membership cannot make an undated old report settle a later occurrence", () => {
  const workers = new BackgroundWorkers();
  const items = new Map<string, ConversationItem>();
  const apply = (updates: ReturnType<BackgroundWorkers["launch"]> = []) => {
    for (const update of updates) {
      if (update.kind === "upsert") items.set(update.item.id, update.item);
      if (update.kind === "remove") items.delete(update.itemId);
    }
  };
  const payload = { text: "Confirmed A result", metadata: { source: "shell", shellID: "reused", state: "completed", exit: 0 } };
  apply(workers.launch("parent", launch("A", "reused"), 10));
  apply(workers.notification("parent", "A-result", payload, 20));
  apply(workers.notification("parent", "undated-old", { ...payload, text: "Old report without a native clock" }, 100, null));
  const next = workers.launch("parent", launch("B", "reused"), 30);
  apply(next);
  expect(items.get("task:v2:parent:B")).toMatchObject({ status: "running", createdAt: 30 });
  expect(items.get("task:v2:parent:B")).not.toHaveProperty("resultId");
  const report = items.get("task:v2:parent:notification:undated-old");
  if (report?.type !== "background_task") throw new Error("expected retained independent old report");
  expect(report).toMatchObject({ taskType: "shell", outputFile: "shell:reused", summary: "Old report without a native clock", resultId: "undated-old" });
  expect(report).not.toHaveProperty("toolUseId");
  expect(report).not.toHaveProperty("terminalReportedAt");
  expect(taskInspection(report)).toEqual({ view: "output" });
  expect(compactWorkers([...items.values()]).find(worker => worker.taskId === "v2:parent:B")?.state).not.toBe("completed");
  expect(items.get("task:v2:parent:A")).toMatchObject({ status: "completed", resultId: "A-result", terminalReportedAt: 20 });
  checkBytes(workers);
});

test.each([0, 100])("an undated report at fallback %s arriving after shell reuse leaves the current occurrence uncertain", at => {
  const workers = new BackgroundWorkers();
  const payload = { text: "Report", metadata: { source: "shell", shellID: "reused", state: "completed", exit: 0 } };
  workers.launch("parent", launch("A", "reused"), 10);
  workers.notification("parent", "A-result", payload, 20);
  workers.launch("parent", launch("B", "reused"), 30);
  const updates = workers.notification("parent", "undated-old", payload, at, null);
  expect(updates).toMatchObject([
    { kind: "upsert", item: { taskId: "v2:parent:B", status: "running", stateUncertain: true } },
    { kind: "upsert", item: { taskType: "shell", outputFile: "shell:reused", resultId: "undated-old" } },
  ]);
  const items = updates!.flatMap(update => update.kind === "upsert" ? [update.item] : []);
  expect(compactWorkers(items).find(worker => worker.taskId === "v2:parent:B")?.state).toBe("unknown");
  const report = items.find(item => item.type === "background_task" && item.resultId === "undated-old");
  if (report?.type !== "background_task") throw new Error("expected independent undated report");
  expect(report).not.toHaveProperty("terminalReportedAt");
  expect(report).not.toHaveProperty("toolUseId");
  expect(taskInspection(report)).toEqual({ view: "output" });
  checkBytes(workers);
});

test("pending shell results cannot settle a verified agent with the same native identity", () => {
  const workers = new BackgroundWorkers();
  const payload = { text: "Shell result", metadata: { source: "shell", shellID: "shared-id", state: "completed", exit: 0 } };
  expect(workers.notification("parent", "shell-result", payload, 15)).toEqual([]);
  workers.verifyChild("shared-id", "parent");
  expect(workers.launch("parent", { id: "agent", name: "subagent", state: { status: "completed", metadata: { status: "running", sessionID: "shared-id" } } }, 10)).toMatchObject([
    { item: { taskType: "agent", childConversationId: "shared-id", status: "running" } },
  ]);
  expect(workers.launch("parent", launch("shell", "shared-id"), 10)).toMatchObject([
    { item: { taskType: "shell", status: "completed", resultId: "shell-result" } },
  ]);
});

test("an ambiguous reused-shell result preserves distinct unknown occurrences and output inspection", () => {
  const workers = new BackgroundWorkers();
  const items = new Map<string, ConversationItem>();
  const apply = (updates: ReturnType<BackgroundWorkers["launch"]> = []) => {
    for (const update of updates) if (update.kind === "upsert") items.set(update.item.id, update.item);
  };
  workers.verifyChild("reused", "parent");
  apply(workers.launch("parent", launch("A", "reused"), 10));
  workers.executionEnded("reused", 18);
  apply(workers.launch("parent", launch("B", "reused"), 20));
  apply(workers.notification("parent", "ambiguous", { text: "Ambiguous result", metadata: { source: "shell", shellID: "reused", state: "completed", exit: 0 } }, 25));
  expect(items.get("task:v2:parent:A")).toMatchObject({ status: "running", stateUncertain: true });
  expect(items.get("task:v2:parent:B")).toMatchObject({ status: "running", stateUncertain: true });
  const result = items.get("task:v2:parent:notification:ambiguous");
  if (result?.type !== "background_task") throw new Error("expected independent ambiguous result");
  expect(result).toMatchObject({ taskType: "shell", outputFile: "shell:reused" });
  expect(result).not.toHaveProperty("toolUseId");
  expect(taskInspection(result)).toEqual({ view: "output" });
  expect(compactWorkers([...items.values()]).map(worker => [worker.taskId, worker.kind, worker.state])).toEqual([
    ["v2:parent:A", "shell", "unknown"], ["v2:parent:B", "shell", "unknown"], ["v2:parent:notification:ambiguous", "shell", "completed"],
  ]);
});

test("silent prelaunch shell results consume the entry and byte budgets and latch recovery on saturation", () => {
  for (const budget of [{ entries: 2 }, { bytes: 900 }]) {
    const workers = new BackgroundWorkers(budget);
    const state = retained(workers);
    for (let i = 0; i < 10; i++) {
      expect(workers.notification("parent", `result${i}`, { text: "Unconfirmed shell output", metadata: { source: "shell", shellID: `shell${i}`, state: "completed", exit: 0 } }, i)).toEqual([]);
      checkBytes(workers);
    }
    expect(state.recoveryOnly).toBe(true);
    expect([state.parents, state.tasks, state.notices, state.unmatched, state.ended, state.aliases].every(values => values.size === 0)).toBe(true);
    expect(state.bytes).toBe(62);
    expect(state.sizes.size).toBe(0);
    expect(workers.launch("parent", launch("later", "shell0"), 0)).toEqual([]);
  }
});

test.each(["shell", "subagent"])("native %s results sort newest report first, not newest launch", kind => {
  const workers = new BackgroundWorkers();
  const items = new Map<string, ConversationItem>();
  const apply = (updates: ReturnType<BackgroundWorkers["launch"]> = []) => {
    for (const update of updates) {
      if (update.kind === "upsert") items.set(update.item.id, update.item);
      if (update.kind === "remove") items.delete(update.itemId);
    }
  };
  for (const [id, at] of [["long", 10], ["short", 20]] as const) {
    workers.verifyChild(id, "parent");
    const part = launch(id);
    apply(workers.launch("parent", kind === "shell" ? part : { ...part, name: kind, state: { ...part.state, input: { description: "fixture" }, metadata: { sessionID: id, status: "running" } } }, at));
  }
  const finish = (id: string, at: number) => apply(workers.notification("parent", `notice-${id}`, { text: "Result", metadata: { source: kind, ...(kind === "shell" ? { shellID: id, exit: 0 } : { childID: id }), state: "completed" } }, at));
  finish("short", 30);
  finish("long", 40);
  expect(compactWorkers([...items.values()]).map(({ name, settledAt }) => [name, settledAt])).toEqual([["fixture", 40], ["fixture", 30]]);
  expect([...items.values()].filter(item => item.type === "background_task").map(item => item.terminalReportedAt)).toEqual([40, 30]);
  expect([...items.values()].every(item => !("completedAt" in item) && !("usage" in item))).toBe(true);
  expect(workers.notification("parent", "notice-long", { text: "duplicate", metadata: { source: kind, shellID: "long", childID: "long", state: "completed" } }, 99)).toEqual([]);
});

test("a relaunched worker has no previous report clock and duplicate old notices cannot settle it", () => {
  const workers = new BackgroundWorkers();
  workers.launch("parent", launch("old", "reused"), 10);
  const payload = { text: "Done", metadata: { source: "shell", shellID: "reused", state: "completed", exit: 0 } };
  expect(workers.notification("parent", "old-result", payload, 20)?.[0]).toMatchObject({ item: { status: "completed", terminalReportedAt: 20 } });
  const next = workers.launch("parent", launch("new", "reused"), 30);
  expect(next[0]).toMatchObject({ item: { status: "running", createdAt: 30 } });
  if (next[0]?.kind !== "upsert") throw new Error("expected relaunched item");
  expect(next[0].item).not.toHaveProperty("terminalReportedAt");
  expect(workers.notification("parent", "old-result", payload, 40)).toEqual([]);
  expect(workers.launch("parent", launch("new", "reused"), 50)).toEqual(next);
});

test.each(["created", "ran"])("same-call native %s advancement cannot reuse an old occurrence", clock => {
  const workers = new BackgroundWorkers();
  workers.verifyChild("child", "parent");
  const part = { id: "call", name: "subagent", time: { created: 20, completed: 30 }, state: { status: "completed", input: { prompt: "First" }, metadata: { sessionID: "child", status: "running" } } };
  workers.launch("parent", part, 30);
  const before = workers.evidenceSnapshot().get("v2:parent:call");
  const next = workers.launch("parent", { ...part, time: { ...part.time, [clock]: 81, completed: 90 } }, 90);
  expect(next).toMatchObject([{ item: { taskId: "v2:parent:call", stateUncertain: true } }]);
  expect(before?.launches[0]).toMatchObject({ created: 20, completed: 30 });
  expect(before?.launches[0]).not.toHaveProperty("ran");
});

test("provisional snapshot evidence survives sparse progress and contradictory restatements", () => {
  const part = { id: "call", name: "subagent", time: { created: 20, ran: 81, completed: 90 }, state: { status: "completed", input: { prompt: "New invocation" }, metadata: { sessionID: "child", status: "running" } } };
  const snapshot = prepareTool(part, 100).fact;
  const progress = prepareTool({ id: "call", name: "subagent", state: { status: "running", metadata: { sessionID: "child", status: "running" } } }, 110, "progress").fact;
  const retained = retainLauncherEvidence(snapshot, progress);
  expect(retained).toMatchObject({ phase: "snapshot", created: 20, ran: 81, completed: 90, inputFingerprint: snapshot.inputFingerprint });
  const stale = prepareTool({ ...part, time: { created: 20, completed: 30 }, state: { ...part.state, input: { prompt: "Old invocation" } } }, 120).fact;
  const both = retainLauncherEvidence(retained, stale);
  expect(both.conflicted).toBe(true);
  expect(both.proof).toBeUndefined();
  expect(launcherChanged(both, { key: "old", taskId: "v2:parent:call", parent: "parent", worker: "child", launches: [stale] })).toBe(true);
  expect(snapshot.ran).toBe(81);
});

test.each([false, true])("a foreground snapshot retires a known occurrence before background eligibility (missing child: %s)", missingChild => {
  const workers = new BackgroundWorkers();
  workers.verifyChild("child", "parent");
  const part = { id: "call", name: "subagent", time: { created: 10, completed: 20 }, state: { status: "completed", metadata: { sessionID: "child", status: "running" } } };
  workers.launch("parent", part, 20);
  const before = workers.occurrence("v2:parent:call");
  expect(workers.launch("parent", { ...part, state: { status: "running", input: { background: false }, metadata: missingChild ? {} : part.state.metadata } }, 30)).toEqual([]);
  expect(before?.uncertain).not.toBe(true);
  expect(workers.occurrence("v2:parent:call")).toMatchObject({ uncertain: true, worker: "child" });
  workers.launch("parent", part, 40);
  expect(workers.occurrence("v2:parent:call")?.uncertain).toBe(true);
});

// Inspect the budget invariant without exposing accounting as provider API.
function retained(workers: BackgroundWorkers) {
  return workers as unknown as {
    parents: Map<string, unknown>; births: Map<string, unknown>; tasks: Map<string, unknown>; notices: Set<string>;
    unmatched: Map<string, unknown>; ended: Map<string, unknown>; aliases: Map<string, unknown>;
    invocations: Map<string, unknown>; terminalProofs: Map<string, unknown>; userShells: Map<string, unknown>;
    bytes: number; recoveryOnly: boolean; sizes: Map<object, unknown>; boundaries: number;
  };
}

function checkBytes(workers: BackgroundWorkers) {
  const state = retained(workers);
  const actual = JSON.stringify([state.parents, state.births, state.tasks, state.notices, state.unmatched, state.ended, state.aliases, state.invocations, state.terminalProofs, state.userShells].map(values => [...values])).length * 2;
  expect(state.bytes).toBeGreaterThanOrEqual(actual);
  expect(state.bytes).toBeLessThanOrEqual(actual + 20);
}

test("occurrence-linked replay records share the worker ledger and its irreversible saturation latch", () => {
  const workers = new BackgroundWorkers({ entries: 8 });
  workers.verifyChild("child", "parent");
  const part = { id: "call", name: "subagent", state: { status: "running", input: { prompt: 'Safe "fixture"' }, metadata: { sessionID: "child", status: "running" } } };
  const fact = prepareTool(part, 10, "called", "message", { id: "invocation", created: 10, durable: { aggregateID: "parent", seq: 1, version: 1 } }).fact;
  workers.invocation("parent", fact); checkBytes(workers);
  expect(workers.invocationReplay("parent", fact)).toBe(false);
  workers.launch("parent", { ...part, time: { created: 10, completed: 20 }, state: { ...part.state, status: "completed" } }, 20); checkBytes(workers);
  expect(workers.invocationReplay("parent", fact)).toBe(true);
  const proof = nativeProof({ id: "terminal", created: 30, durable: { aggregateID: "child", seq: 1, version: 1 } }, { child: "child", phase: "ended" });
  workers.executionEnded("child", 30, proof); checkBytes(workers);
  expect(workers.terminalReplay("child", proof)).toBe(true);
  workers.invalidateOwnership("child"); checkBytes(workers);
  expect(workers.invocationReplay("parent", fact)).toBe(true);
  expect(workers.terminalReplay("child", proof)).toBe(true);
  for (let index = 0; index < 10; index++) { workers.verifyChild(`peer${index}`, "parent"); checkBytes(workers); }
  const state = retained(workers);
  expect(state.recoveryOnly).toBe(true);
  expect(workers.controlEvidenceAvailable).toBe(false);
  expect([state.parents, state.tasks, state.notices, state.unmatched, state.ended, state.aliases, state.invocations, state.terminalProofs, state.userShells].every(values => values.size === 0)).toBe(true);
  workers.invalidateOwnership(); workers.verifyChild("child", "parent");
  expect(workers.invocationReplay("parent", fact)).toBe(false);
  expect(workers.terminalReplay("child", proof)).toBe(false);
  expect(state.recoveryOnly).toBe(true); checkBytes(workers);
});

test.each(["child", "parent", "foreign", undefined])("ownership invalidation revokes only affected verification (%s), preserving occurrence history", sessionId => {
  const workers = new BackgroundWorkers();
  const state = retained(workers);
  workers.verifyChild("child", "parent");
  workers.verifyChild("peer", "parent");
  workers.verifyChild("foreign", "other-parent");
  const part = (id: string) => ({ id, name: "subagent", state: { status: "completed", metadata: { status: "running", sessionID: "child" } } });
  workers.launch("parent", part("A"), 10);
  workers.launch("parent", part("alias"), 12);
  workers.executionEnded("child", 18);
  const payload = { text: "Confirmed result", metadata: { source: "subagent", childID: "child", state: "completed" } };
  const terminal = workers.notification("parent", "result", payload, 20);
  if (!terminal) throw new Error("expected verified terminal result");
  workers.notification("parent", "unmatched", { text: "Pending result", metadata: { source: "subagent", childID: "peer", state: "completed" } }, 50);
  const history = () => JSON.stringify([state.tasks, state.notices, state.unmatched, state.ended, state.aliases].map(values => [...values]));
  const before = history();
  const boundaries = state.boundaries;
  workers.invalidateOwnership(sessionId);
  expect(history()).toBe(before);
  expect(state.boundaries).toBe(boundaries);
  expect(state.recoveryOnly).toBe(false);
  expect([...state.parents]).toEqual(sessionId === undefined ? [] : sessionId === "parent"
    ? [["foreign", "other-parent"]]
    : sessionId === "child" ? [["peer", "parent"], ["foreign", "other-parent"]]
    : [["child", "parent"], ["peer", "parent"]]);
  checkBytes(workers);
  if (sessionId !== "foreign") {
    expect(workers.launch("parent", part("A"), 100)).toEqual([]);
    expect(workers.notification("parent", "unverified", payload, 100)).toBeUndefined();
    workers.executionEnded("child", 100);
    expect(history()).toBe(before);
    workers.verifyChild("child", "parent");
  }
  expect(workers.launch("parent", part("A"), 100)).toEqual(terminal);
  expect(workers.launch("parent", part("alias"), 100)).toEqual(terminal);
  expect(workers.notification("parent", "result", payload, 100)).toEqual([]);
  expect(history()).toBe(before);
  checkBytes(workers);
});

test("a revoked running agent cannot republish trusted worker facts until its actual parent is reverified", () => {
  const workers = new BackgroundWorkers();
  const part = { id: "running", name: "subagent", state: { status: "completed", metadata: { status: "running", sessionID: "child" } } };
  workers.verifyChild("child", "parent");
  const running = workers.launch("parent", part, 10);
  expect(running).toMatchObject([{ item: { status: "running", childConversationId: "child" } }]);
  workers.invalidateOwnership("child");
  expect(workers.launch("parent", part, 20)).toEqual([]);
  expect(workers.notification("parent", "unverified", { text: "Unverified result", metadata: { source: "subagent", childID: "child", state: "completed" } }, 20)).toBeUndefined();
  workers.verifyChild("child", "other-parent");
  expect(workers.launch("parent", part, 20)).toEqual([]);
  workers.invalidateOwnership("unrelated-lifecycle");
  workers.verifyChild("child", "parent");
  expect(workers.launch("parent", part, 20)).toEqual(running);
  checkBytes(workers);
});

test("incremental byte ledger bounds the serialized oracle through replacements, aliases, results and deletions", () => {
  const workers = new BackgroundWorkers();
  const check = () => checkBytes(workers);
  const notice = (id: string, worker: string, at: number) => workers.notification("parent", id, { text: '\"\\\n\u0000\ud800𐀀', metadata: { source: "subagent", childID: worker, state: "completed" } }, at);
  for (let i = 0; i < 40; i++) {
    const child = `child${i}`;
    workers.verifyChild(child, "parent"); check();
    workers.verifyChild(child, "changed"); check();
    workers.verifyChild(child, "parent"); check();
    // Result before launch exercises unmatched removal and notice tombstones.
    notice(`early${i}`, child, 3); check();
    workers.launch("parent", { ...launch(`agent${i}`, child), name: "subagent", state: { ...launch(`agent${i}`, child).state, metadata: { sessionID: child, status: "running" } } }, 1); check();
    workers.launch("parent", launch(`shell${i}`, `worker${i}`, '\"\\\n\u0000\ud800𐀀'), 4); check();
    workers.launch("parent", launch(`alias${i}`, `worker${i}`), 5); check();
    workers.verifyChild(`worker${i}`, "parent");
    workers.executionEnded(`worker${i}`, 6); check();
    workers.executionEnded(`worker${i}`, 6); check();
    workers.executionEnded(`worker${i}`, 7); check();
    workers.launch("parent", launch(`next${i}`, `worker${i}`), 8); check();
    workers.notification("parent", `done${i}`, { text: "result", metadata: { source: "shell", shellID: `worker${i}`, state: "completed", exit: 0 } }, 9); check();
    notice(`ambiguous${i}`, `worker${i}`, 10); check();
  }
});

test("mixed occurrence updates keep the byte bound conservative against an independent full serialization", () => {
  fc.assert(fc.property(fc.array(fc.record({
    operation: fc.integer({ min: 0, max: 5 }),
    id: fc.integer({ min: 0, max: 8 }),
    body: fc.oneof(fc.string(), fc.constant('\"\\\n\u0000\ud800𐀀')),
  }), { minLength: 1, maxLength: 100 }), operations => {
    const workers = new BackgroundWorkers();
    operations.forEach(({ operation, id, body }, at) => {
      const child = `child${id}`;
      switch (operation) {
        case 0: workers.verifyChild(child, "parent"); break;
        case 1: workers.launch("parent", launch(`call${at}`, child, body), at); break;
        case 2: workers.executionEnded(child, at); break;
        case 3: workers.notification("parent", `notice${id}`, { text: body, metadata: { source: "subagent", childID: child, state: "completed" } }, at); break;
        case 4: workers.notification("parent", `shell${id}`, { text: body, metadata: { source: "shell", shellID: child, state: "completed", exit: 0 } }, at); break;
        case 5: workers.launch("parent", launch(`call${id}`, child, body), at); break;
      }
      checkBytes(workers);
    });
  }), { seed: 518, numRuns: 50 });
});

test("byte and entry saturation clear the complete ledger and never resume partial correlation", () => {
  for (const budget of [{ bytes: 900 }, { entries: 2 }]) {
    const workers = new BackgroundWorkers(budget);
    const state = retained(workers);
    for (let i = 0; i < 10; i++) workers.launch("parent", launch(`call${i}`), i);
    expect(state.recoveryOnly).toBe(true);
    expect([state.parents, state.tasks, state.notices, state.unmatched, state.ended, state.aliases, state.invocations, state.terminalProofs, state.userShells].every(values => values.size === 0)).toBe(true);
    expect(state.sizes.size).toBe(0);
    expect(state.bytes).toBe(62);
    expect(state.boundaries).toBe(0);
    workers.invalidateOwnership("child");
    workers.invalidateOwnership();
    workers.verifyChild("child", "parent");
    expect(state.recoveryOnly).toBe(true);
    expect(state.parents.size).toBe(0);
    expect(state.bytes).toBe(62);
    expect(workers.launch("parent", launch("later"), 20)).toEqual([]);
  }
});

test("live byte-budget serialization work grows with changed entries, not retained history", () => {
  const stringify = JSON.stringify;
  const work = (count: number) => {
    const workers = new BackgroundWorkers();
    let characters = 0;
    const spy = spyOn(JSON, "stringify").mockImplementation((value: unknown) => {
      const result = stringify(value);
      characters += result?.length ?? 0;
      return result;
    });
    try {
      for (let i = 0; i < count; i++) {
        workers.launch("parent", { id: `call${i}`, name: "shell", state: { status: "completed", input: { command: "echo fixture" }, metadata: { status: "running", shellID: `shell${i}` } } }, i);
      }
      const before = characters;
      for (let i = 0; i < count; i++) workers.launch("parent", { name: "irrelevant" }, i);
      expect(characters).toBe(before);
    } finally {
      spy.mockRestore();
    }
    return characters;
  };
  const small = work(128);
  expect(work(256)).toBeLessThan(small * 2.2);
});
