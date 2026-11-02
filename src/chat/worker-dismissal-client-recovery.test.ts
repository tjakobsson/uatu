import { expect, test } from "bun:test";
import { WorkerDismissalClient } from "./worker-dismissal-client";
import { visibleWorkers, workerExecutionIds as dismissalIds } from "./worker-dismissal-client";
import type { CompactWorker } from "./compact-work";
import { compactWorkers } from "./compact-work";
import { BackgroundWorkers, nativeProof, prepareTool, workerExecutionIds } from "./opencode/v2/background";
import type { BackgroundTaskItem } from "./types";

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function nativeQualification() {
  const workers = new BackgroundWorkers();
  const part = { id: "call", name: "subagent", state: { status: "completed", input: { prompt: "fixture", background: true }, metadata: { status: "running", sessionID: "child" } } };
  workers.verifyChild("child", "parent");
  workers.invocation("parent", prepareTool(part, 20, "called", "message", { id: "native-called", created: 20, durable: { aggregateID: "parent", seq: 1, version: 1 } }).fact);
  workers.observeBirth("child", "parent", nativeProof({ id: "native-birth", created: 22 }, { child: "child", parent: "parent" }));
  const project = (value: unknown, phase: "success" | "snapshot") => {
    const update = workers.launchPrepared("parent", prepareTool(value, 30, phase, "message", phase === "success" ? { id: "native-success", created: 30 } : undefined), 30)
      .find(update => update.kind === "upsert" && update.item.type === "background_task");
    if (update?.kind !== "upsert" || update.item.type !== "background_task") throw new Error("missing task");
    const occurrence = workers.occurrence(update.item.taskId)!;
    const ids = workerExecutionIds(occurrence), reference = workers.launchReference(occurrence);
    const item: BackgroundTaskItem = { ...update.item, activity: { kind: "working", generation: 1, launchRef: reference && `v1:launch:1:${reference}`, ...(ids.length ? { executionId: ids[0], executionAliases: ids } : {}) } };
    return { item, row: compactWorkers([item])[0]! };
  };
  return { partial: project(part, "success"), qualified: project({ ...part, time: { created: 19, ran: 20, completed: 30 } }, "snapshot") };
}

test("partial native Working then qualified Working and durable retirement recovers identity guidance", async () => {
  const { partial: { row: partial }, qualified: { row: qualified } } = nativeQualification();
  expect(partial.activity!.launchRef).toBe(qualified.activity!.launchRef);
  expect(partial.activity!.launchRef).toBeDefined();
  expect(partial.dismissalIds).toEqual([]);
  const executionId = qualified.dismissalIds![0]!;
  const client = new WorkerDismissalClient({ changed: () => {}, fetcher: async () => Response.json({ version: 1, conversationId: "opencode:parent",
    entries: [{ executionId, revision: 1, dismissed: false }] }) });
  try {
    client.select("opencode:parent"); await flush();
    client.observe([partial]);
    expect(client.error).toContain("complete execution identity");
    client.observe([qualified]);
    client.refresh(); await flush();
    expect(client.error).toBe("");
    expect(dismissalIds(qualified)).not.toContain(partial.activity!.launchRef!);
    client.observe([{ ...qualified, state: "unknown", activity: { ...qualified.activity!, kind: "unavailable" } }]);
    expect(visibleWorkers([qualified], client.dismissed)).toHaveLength(1);
  } finally { client.dispose(); }
});

test("a qualified terminal update can resolve the same partial launch after authoritative retirement", async () => {
  const { partial: { row: partial }, qualified: { row: qualified } } = nativeQualification();
  const executionId = qualified.dismissalIds![0]!;
  const client = new WorkerDismissalClient({ changed: () => {}, fetcher: async () => Response.json({ version: 1, conversationId: "opencode:parent",
    entries: [{ executionId, revision: 1, dismissed: false }] }) });
  try {
    client.select("opencode:parent"); await flush();
    client.observe([partial]);
    const ended = { ...qualified, state: "completed" as const, activity: { ...qualified.activity!, kind: "ended" as const } };
    client.observe([ended]); client.refresh(); await flush();
    expect(client.error).toBe("");
    expect(visibleWorkers([ended], client.dismissed)).toHaveLength(1);
  } finally { client.dispose(); }
});

test("terminal qualification without confirmed retirement cannot clear guidance or retire a mark", async () => {
  const { partial: { row: partial }, qualified: { row: qualified } } = nativeQualification();
  const executionId = qualified.dismissalIds![0]!;
  let posts = 0;
  const client = new WorkerDismissalClient({ changed: () => {}, fetcher: async (_url, init) => {
    if (init?.method === "POST") posts++;
    return Response.json({ version: 1, conversationId: "opencode:parent", entries: [{ executionId, revision: 1, dismissed: true }] });
  } });
  try {
    client.select("opencode:parent"); await flush(); client.observe([partial]);
    const ended = { ...qualified, state: "completed" as const, activity: { ...qualified.activity!, kind: "ended" as const } };
    client.observe([ended]); await flush();
    expect(client.error).toContain("complete execution identity");
    expect(client.dismissed.size).toBe(0);
    expect(visibleWorkers([ended], client.dismissed)).toHaveLength(1);
    expect(posts).toBe(0);
  } finally { client.dispose(); }
});

test.each(["missing", "dismissed", "failed-read", "failed-retirement"])("%s acknowledgement keeps recovery guidance and visibility", async failure => {
  const { partial: { row: partial }, qualified: { row: qualified } } = nativeQualification();
  const executionId = qualified.dismissalIds![0]!;
  let initial = true;
  const client = new WorkerDismissalClient({ changed: () => {}, fetcher: async (_url, init) => {
    if (init?.method === "POST" || !initial && failure === "failed-read") return new Response(null, { status: 503 });
    const entries = initial || failure === "dismissed" || failure === "failed-retirement"
      ? [{ executionId, revision: 1, dismissed: true }] : [];
    return Response.json({ version: 1, conversationId: "opencode:parent", entries });
  } });
  try {
    client.select("opencode:parent"); await flush(); initial = false;
    client.observe([partial]); client.observe([qualified]); await flush(); await flush();
    client.observe([{ ...qualified, state: "unknown", activity: { ...qualified.activity!, kind: "unavailable" } }]);
    expect(client.error).not.toBe("");
    expect(client.dismissed.size).toBe(0);
    expect(visibleWorkers([qualified], client.dismissed)).toHaveLength(1);
  } finally { client.dispose(); }
});

test("pre-qualification reads and earlier multi-worker acknowledgements cannot clear later fences", async () => {
  const { partial: { row: partial }, qualified: { row: qualified } } = nativeQualification();
  const executionId = qualified.dismissalIds![0]!;
  const replies: Array<(response: Response) => void> = [];
  const response = (entries: Array<{ executionId: string; revision: number; dismissed: boolean }>) => Response.json({ version: 1, conversationId: "opencode:parent", entries });
  const client = new WorkerDismissalClient({ changed: () => {}, fetcher: () => new Promise(resolve => replies.push(resolve)) });
  try {
    client.select("opencode:parent");
    client.observe([partial]); client.observe([qualified]);
    replies[0]!(response([{ executionId, revision: 1, dismissed: false }])); await flush();
    expect(client.error).toContain("complete execution identity");
    expect(replies).toHaveLength(2);
    // A second native occurrence arrives after the first confirmation began.
    const other = { ...partial, activity: { ...partial.activity!, launchRef: "another-native-reference" } };
    const otherQualified = { ...qualified, dismissalIds: ["exec:other"], activity: { ...qualified.activity!, executionId: "exec:other", executionAliases: ["exec:other"], launchRef: other.activity.launchRef } };
    client.observe([qualified, other]); client.observe([qualified, otherQualified]);
    replies[1]!(response([{ executionId, revision: 1, dismissed: false }, { executionId: "exec:other", revision: 1, dismissed: false }])); await flush();
    expect(client.error).toContain("complete execution identity");
    expect(replies).toHaveLength(3);
    replies[2]!(response([{ executionId, revision: 1, dismissed: false }, { executionId: "exec:other", revision: 1, dismissed: false }])); await flush();
    expect(client.error).toBe("");
  } finally { client.dispose(); }
});

test("same reference still needs the same native generation and positive qualification", async () => {
  const { partial: { row: partial }, qualified: { row: qualified } } = nativeQualification();
  const executionId = qualified.dismissalIds![0]!;
  const client = new WorkerDismissalClient({ changed: () => {}, fetcher: async () => Response.json({ version: 1, conversationId: "opencode:parent", entries: [{ executionId, revision: 1, dismissed: false }] }) });
  try {
    client.select("opencode:parent"); await flush(); client.observe([partial]);
    client.observe([{ ...qualified, activity: { ...qualified.activity!, generation: 2 } }]);
    client.refresh(); await flush(); expect(client.error).toContain("complete execution identity");
    client.observe([{ ...qualified, state: "unknown", activity: { ...qualified.activity!, kind: "unavailable" } }]);
    client.refresh(); await flush(); expect(client.error).toContain("complete execution identity");
    client.observe([qualified]); // A replay of generation 1 after generation 2.
    client.refresh(); await flush(); expect(client.error).toContain("complete execution identity");
  } finally { client.dispose(); }
});

test("identity-fence budget fails closed without evictions, and selection/disposal clear it", async () => {
  const { partial: { row: partial }, qualified: { row: qualified } } = nativeQualification();
  let posts = 0;
  const client = new WorkerDismissalClient({ changed: () => {}, fetcher: async (_url, init) => {
    if (init?.method === "POST") posts++;
    return Response.json({ version: 1, conversationId: "opencode:parent", entries: [] });
  } });
  try {
    client.select("opencode:parent"); await flush();
    client.observe(Array.from({ length: 8193 }, (_, i) => ({ ...partial, activity: { ...partial.activity!, launchRef: `native:${i}` } })));
    client.observe([{ ...qualified, activity: { ...qualified.activity!, launchRef: "native:0" } }]); await flush();
    await client.dismiss(qualified.dismissalIds![0]);
    expect(posts).toBe(0); expect(client.error).toContain("tracking is full"); expect(client.dismissed.size).toBe(0);
    client.select(null); client.select("opencode:parent"); await flush(); expect(client.error).toBe("");
    client.dispose(); expect(client.dismissed.size).toBe(0);
  } finally { client.dispose(); }
});

test("every proven alias needs confirmation; a new partial frame fences an earlier acknowledgement", async () => {
  const { partial: { row: partial }, qualified: { row: qualified } } = nativeQualification();
  const executionId = qualified.dismissalIds![0]!;
  const expanded = { ...qualified, dismissalIds: [executionId, "exec:alias"], activity: { ...qualified.activity!, executionAliases: [executionId, "exec:alias"] } };
  let reply: (response: Response) => void = () => {};
  const client = new WorkerDismissalClient({ changed: () => {}, fetcher: () => new Promise(resolve => { reply = resolve; }) });
  const response = (alias: boolean) => Response.json({ version: 1, conversationId: "opencode:parent", entries: [
    { executionId, revision: 1, dismissed: false }, ...(alias ? [{ executionId: "exec:alias", revision: 1, dismissed: false }] : []),
  ] });
  try {
    client.select("opencode:parent"); reply(response(false)); await flush();
    client.observe([partial]); client.observe([expanded]); reply(response(false)); await flush();
    expect(client.error).toContain("complete execution identity");
    client.refresh();
    client.observe([partial]); // Reopens the fence while that read is in flight.
    reply(response(true)); await flush();
    expect(client.error).toContain("complete execution identity");
    client.observe([expanded]); reply(response(true)); await flush();
    expect(client.error).toBe("");
  } finally { client.dispose(); }
});

test("late dismissal responses never acknowledge identity recovery or hide a current request", async () => {
  const { partial: { row: partial }, qualified: { row: qualified } } = nativeQualification();
  const executionId = qualified.dismissalIds![0]!;
  let post: (response: Response) => void = () => {}, read: (response: Response) => void = () => {};
  const response = (dismissed: boolean) => Response.json({ version: 1, conversationId: "opencode:parent", entries: [{ executionId, revision: 1, dismissed }] });
  const client = new WorkerDismissalClient({ changed: () => {}, fetcher: (_url, init) => new Promise(resolve => {
    if (init?.method === "POST") post = resolve; else read = resolve;
  }) });
  try {
    client.select("opencode:parent"); read(response(false)); await flush();
    const dismissal = client.dismiss(executionId);
    client.observe([partial]);
    const request = { ...qualified, activity: { ...qualified.activity!, kind: "needs-answer" as const, request: { id: "canonical", kind: "question" as const } } };
    client.observe([request]);
    post(response(true)); await dismissal; await flush();
    expect(client.error).toContain("complete execution identity");
    expect(visibleWorkers([request], client.dismissed)).toHaveLength(1);
    read(response(false)); await flush();
    expect(client.error).toBe("");
    const unavailable = { ...qualified, state: "unknown" as const, activity: { ...qualified.activity!, kind: "unavailable" as const } };
    client.observe([unavailable]); expect(visibleWorkers([unavailable], client.dismissed)).toHaveLength(1);
    expect(request.activity.request).toEqual({ id: "canonical", kind: "question" });
  } finally { client.dispose(); }
});

test("sign-out and personal epochs fence late recovery reads", async () => {
  const { partial: { row: partial }, qualified: { row: qualified } } = nativeQualification();
  const executionId = qualified.dismissalIds![0]!;
  const replies: Array<(response: Response) => void> = [];
  const client = new WorkerDismissalClient({ changed: () => {}, fetcher: () => new Promise(resolve => replies.push(resolve)) });
  try {
    client.select("opencode:parent");
    client.observe([partial]); client.observe([qualified]);
    client.select(null);
    replies[0]!(Response.json({ version: 1, conversationId: "opencode:parent", entries: [{ executionId, revision: 1, dismissed: false }] })); await flush();
    expect(client.error).toBe(""); expect(client.dismissed.size).toBe(0); expect(replies).toHaveLength(1);
    client.select("opencode:parent"); client.observe([partial]);
    replies[1]!(Response.json({ version: 1, conversationId: "opencode:parent", entries: [{ executionId, revision: 1, dismissed: false }] })); await flush();
    expect(client.error).toContain("complete execution identity");
  } finally { client.dispose(); }
});

test("native folds can reuse every compact row anchor while changing the exact execution", () => {
  const part = { id: "call", name: "subagent", time: { created: 1, ran: 1, completed: 2 }, state: {
    status: "completed", input: { description: "Worker", prompt: "fixture" }, metadata: { sessionID: "child", status: "running" },
  } };
  const project = (message: string) => {
    // Provider history folds are fresh BackgroundWorkers instances. These are
    // native records, not hand-authored matching compact-worker identities.
    const workers = new BackgroundWorkers();
    workers.verifyChild("child", "parent");
    const update = workers.launchPrepared("parent", prepareTool(part, 2, "snapshot", message), 2)
      .find(update => update.kind === "upsert" && update.item.type === "background_task");
    if (update?.kind !== "upsert" || update.item.type !== "background_task") throw new Error("missing native task");
    const ids = workerExecutionIds(workers.occurrence(update.item.taskId));
    const task: BackgroundTaskItem = { ...update.item, activity: { kind: "working", generation: 1, executionId: ids[0], executionAliases: ids } };
    return compactWorkers([task])[0]!;
  };
  const first = project("first-message"), reused = project("second-message");
  expect(first.dismissalIds).toHaveLength(1);
  expect(reused.dismissalIds).toHaveLength(1);
  expect(reused.dismissalIds).not.toEqual(first.dismissalIds);
  // Redacting the missing execution proof leaves indistinguishable inputs to
  // any proposed row/generation-based recovery rule, including child/time.
  const partial = (row: CompactWorker) => ({ ...row, dismissalIds: [], activity: { kind: "working", generation: row.activity!.generation } });
  expect(partial(first)).toEqual(partial(reused));
});

test.each(["unrelated-row", "new-generation", "same-child", "reused-call"])("%s cannot discharge an identity-free active fence", async scenario => {
  const first: CompactWorker = { id: "task:v2:parent:call", taskId: "v2:parent:call", name: "Worker", kind: "agent", references: [], conversationId: "child",
    since: 1, settledAt: 1, state: "working", dismissalIds: [], activity: { kind: "working", generation: 1, launchRef: "original-native-reference" } };
  const executionId = `v1:${"a".repeat(64)}`;
  let operations = 0;
  const client = new WorkerDismissalClient({ changed: () => {}, fetcher: async (_url, init) => {
    if (init?.method === "POST") operations++;
    return Response.json({ version: 1, conversationId: "opencode:parent", entries: [{ executionId, revision: 1, dismissed: false }] });
  } });
  try {
    client.select("opencode:parent"); await flush(); client.observe([first]);
    const qualified: CompactWorker = { ...first, id: scenario === "unrelated-row" || scenario === "same-child" ? "task:other" : first.id,
      dismissalIds: [executionId], activity: { kind: "working", generation: scenario === "new-generation" ? 2 : 1,
        launchRef: scenario === "new-generation" ? first.activity!.launchRef : "different-native-reference", executionId } };
    client.observe([qualified]); client.refresh(); await flush();
    client.observe([{ ...qualified, state: "unknown", activity: { ...qualified.activity!, kind: "unavailable" } }]);
    expect(client.error).toContain("complete execution identity");
    await client.dismiss(executionId);
    expect(operations).toBe(0);
    expect(client.dismissed.size).toBe(0);
  } finally { client.dispose(); }
});
