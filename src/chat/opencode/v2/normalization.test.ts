import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { normalizeProviderEvent as normalizeV1 } from "../v1/normalization";
import { createOpenCodeV2Memory, createOpenCodeV2Normalizer, formFieldToQuestion, type OpenCodeV2Memory } from "./normalization";
import type { NormalizedProviderEvent, NormalizedProviderUpdate } from "../../provider";

// Captured from a real OpenCode 2.0.13 `/api/event` stream (sandboxed home,
// the free public model), workspace directory `/tmp/oc-v2-ws`. The shapes
// are the contract; the values are whatever the model said that day.
const FIXTURES = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/real-2.0.13.json"), "utf8")) as {
  turnWithPermissionAndTool: Array<Record<string, unknown>>;
  formsShellRenameDelete: Array<Record<string, unknown>>;
  compactionFailedAndAgentSwitch: Array<Record<string, unknown>>;
  interruptedTool: Array<Record<string, unknown>>;
  storedMessages: { data: Array<Record<string, unknown>> };
};
const WORKSPACE = "/tmp/oc-v2-ws";

function run(events: Array<Record<string, unknown>>, memory: OpenCodeV2Memory = createOpenCodeV2Memory()) {
  const normalize = createOpenCodeV2Normalizer(WORKSPACE);
  const normalized = events.map(event => normalize(event, memory));
  const byType = (type: string) => normalized.filter(entry => entry.eventType === type);
  const items = (entry: NormalizedProviderEvent) => entry.updates.flatMap(update => update.kind === "upsert" ? [update.item] : update.kind === "text" && update.item ? [update.item] : []);
  return { normalized, byType, items };
}

function upserts(entry: NormalizedProviderEvent) {
  return entry.updates.filter((update): update is Extract<NormalizedProviderUpdate, { kind: "upsert" }> => update.kind === "upsert").map(update => update.item);
}

describe("OpenCode 2.x normalization: a real turn", () => {
  const { normalized, byType } = run(FIXTURES.turnWithPermissionAndTool);

  test("nothing in a real 2.x turn is unrecognized", () => {
    expect(normalized.filter(entry => entry.outcome === "unrecognized").map(entry => entry.eventType)).toEqual([]);
    expect(normalized.filter(entry => entry.outcome === "unparseable").map(entry => entry.eventType)).toEqual([]);
  });

  test("the running total and the inbox plumbing are ignored, not dropped", () => {
    for (const type of ["session.usage.updated", "session.inbox.delivered", "session.instructions.updated", "session.step.streamed"]) {
      expect(byType(type).map(entry => entry.outcome)).toEqual(byType(type).map(() => "ignored"));
    }
  });

  test("session creation is a lifecycle event scoped to the workspace", () => {
    const [created] = byType("session.created");
    expect(created?.sessionLifecycle).toEqual({ kind: "created", id: created!.conversationId!, directory: WORKSPACE, title: "capture4" });
  });

  test("an enqueued prompt is the user's message, keyed by its inbox id", () => {
    const [first] = byType("session.inbox.enqueued");
    const [item] = upserts(first!);
    expect(item).toMatchObject({ type: "user_message", text: "Read the file /etc/hosts using the read tool and reply with its first line only." });
    expect(item?.id).toMatch(/^message:msg_/);
    expect((item as { requestId?: string }).requestId).toBe(item!.id.slice("message:".length));
  });

  test("execution lifecycle drives the conversation status", () => {
    expect(byType("session.execution.started")[0]?.updates).toEqual([{ kind: "status", status: "running" }]);
    expect(byType("session.execution.succeeded")[0]?.updates).toEqual([{ kind: "status", status: "completed" }]);
  });

  test("reasoning and text stream under message-and-ordinal identities", () => {
    const [delta] = byType("session.reasoning.delta");
    const update = delta!.updates[0];
    expect(update).toMatchObject({ kind: "text", mode: "incremental" });
    if (update?.kind !== "text") throw new Error("expected a text update");
    expect(update.itemId).toMatch(/^reasoning:msg_[A-Za-z0-9]+:reasoning:0$/);
    expect(update.item).toMatchObject({ type: "reasoning", status: "running" });

    const [ended] = byType("session.reasoning.ended");
    expect(ended!.updates[0]).toMatchObject({ kind: "text", mode: "cumulative", item: { status: "completed" } });

    const [textDelta] = byType("session.text.delta");
    expect(textDelta!.updates[0]).toMatchObject({ kind: "text", mode: "incremental", text: "`##`" });
    if (textDelta!.updates[0]?.kind !== "text") throw new Error("expected a text update");
    expect(textDelta!.updates[0].itemId).toMatch(/^part:msg_[A-Za-z0-9]+:text:0$/);
    // Text and reasoning ordinals are numbered independently, so one message
    // streams a text 0 and a reasoning 0; their reconciler identities must
    // not meet, or the answer accumulates the thinking.
    const identities = (type: string) => byType(type).flatMap(entry => entry.updates.flatMap(update => update.kind === "text" ? [update.identity] : []));
    const reasoning = new Set(identities("session.reasoning.delta"));
    expect(identities("session.text.delta").some(identity => reasoning.has(identity))).toBe(false);
    const [textEnded] = byType("session.text.ended");
    expect(textEnded!.updates[0]).toMatchObject({ kind: "text", mode: "cumulative", text: "`##`" });
  });

  test("a tool call is named from its input announcement and settles with its output", () => {
    const [called] = byType("session.tool.called");
    const [tool] = upserts(called!);
    expect(tool).toMatchObject({ type: "tool", name: "read", status: "running", input: JSON.stringify({ path: "/etc/hosts" }) });
    expect(tool?.id).toMatch(/^tool:call_/);
    expect(byType("session.tool.input.started")[0]?.outcome).toBe("ignored");

    const [success] = byType("session.tool.success");
    const [done] = upserts(success!);
    expect(done).toMatchObject({ id: tool!.id, type: "tool", name: "read", status: "completed" });
    expect((done as { output?: string }).output).toContain("localhost");
    expect((done as { completedAt?: number }).completedAt).toBeGreaterThan(0);
  });

  test("a permission round-trip reads as it does on 1.x", () => {
    const [asked] = byType("permission.asked");
    const [request] = upserts(asked!);
    expect(request).toMatchObject({
      type: "permission",
      status: "pending",
      action: "external_directory",
      resources: ["/etc/*"],
      alwaysPatterns: ["/etc/*"],
    });
    expect(request?.id).toMatch(/^permission:per_/);
    const [replied] = byType("permission.replied");
    const [resolved] = upserts(replied!);
    expect(resolved).toMatchObject({ id: request!.id, type: "permission", status: "resolved", outcome: "approved-once" });
  });

  test("a step's end carries the message's own usage, model, agent, and prompt", () => {
    const [stepEnded] = byType("session.step.ended");
    const carrier = upserts(stepEnded!).find(item => item.id.startsWith("usage:"));
    expect(carrier).toMatchObject({
      type: "assistant_message",
      markdown: "",
      usage: { input: expect.any(Number), output: expect.any(Number), reasoning: expect.any(Number), cacheRead: expect.any(Number), cacheWrite: 0, costUsd: 0 },
      model: { providerId: "opencode", modelId: "mimo-v2.6-flash-free" },
      agent: "build",
    });
    const messageId = carrier!.id.slice("usage:".length);
    expect(stepEnded?.assistantUsage).toMatchObject({ messageId, usage: expect.any(Object) });
    expect(stepEnded?.assistantUsage?.promptId).toMatch(/^msg_/);
    // The step's start attributed the model to the message before any usage.
    const [stepStarted] = byType("session.step.started");
    expect(stepStarted?.assistantModel).toMatchObject({ messageId, model: "mimo-v2.6-flash-free", promptId: stepEnded?.assistantUsage?.promptId });
  });
});

describe("OpenCode 2.x normalization: forms, shell, lifecycle", () => {
  const { byType } = run(FIXTURES.formsShellRenameDelete);

  test("a rename is a sparse lifecycle update: the workspace directory and the title, no claim on parentage", () => {
    const [renamed] = byType("session.renamed");
    expect(renamed?.outcome).toBe("handled");
    expect(renamed?.sessionLifecycle).toEqual({ kind: "updated", id: renamed!.conversationId!, directory: WORKSPACE, title: "captured", sparse: true });
  });

  test("a synthetic note is a notice; a shell transcript's note is not repeated", () => {
    const [note, shellNote] = byType("session.inbox.enqueued");
    expect(upserts(note!)).toEqual([expect.objectContaining({ type: "notice", level: "info", message: "a synthetic note" })]);
    expect(shellNote?.updates).toEqual([]);
    expect(shellNote?.outcome).toBe("ignored");
  });

  test("a user-run shell command is a command item from start to exit", () => {
    const [started] = byType("session.shell.started");
    expect(upserts(started!)).toEqual([expect.objectContaining({ id: expect.stringMatching(/^command:sh_/), type: "command", command: "echo hello-from-shell", status: "running" })]);
    const [ended] = byType("session.shell.ended");
    const [item] = upserts(ended!);
    expect(item).toMatchObject({ type: "command", command: "echo hello-from-shell", status: "completed", output: "hello-from-shell\n", exitCode: 0 });
    expect((item as { completedAt?: number }).completedAt).toBeGreaterThan(0);
  });

  test("a form is one structured question per field, answered once, in field order", () => {
    const [created, cancelled] = byType("form.created");
    const [question] = upserts(created!);
    expect(question).toMatchObject({
      type: "question",
      status: "pending",
      intro: "Pick one",
      questions: [
        { prompt: "Which?", options: [{ label: "A", description: "" }, { label: "B", description: "" }], multiple: false, allowFreeForm: true },
        { prompt: "Several", options: [{ label: "X", description: "" }, { label: "Y", description: "" }], multiple: true, allowFreeForm: false },
        { prompt: "Say more", options: [], multiple: false, allowFreeForm: true },
      ],
    });
    expect(question?.id).toMatch(/^question:frm_/);
    const [replied] = byType("form.replied");
    expect(upserts(replied!)).toEqual([expect.objectContaining({ id: question!.id, type: "question", status: "resolved", outcome: { kind: "answered", answers: [["a"], ["x", "y"], ["hi"]] } })]);

    const [boolean] = upserts(cancelled!);
    expect((boolean as { questions: unknown[] }).questions).toEqual([
      { prompt: "Yes?", header: "", options: [{ label: "Yes", description: "" }, { label: "No", description: "" }], multiple: false, allowFreeForm: false, optional: true },
    ]);
    const [rejected] = byType("form.cancelled");
    expect(upserts(rejected!)).toEqual([expect.objectContaining({ id: boolean!.id, status: "resolved", outcome: { kind: "rejected" } })]);
  });

  test("a Stop is an aborted step with no failure to show; the interrupted execution ends the turn", () => {
    const [failed] = byType("session.step.failed");
    expect(failed?.updates).toEqual([]);
    expect(byType("session.execution.interrupted")[0]?.updates).toEqual([{ kind: "status", status: "interrupted" }]);
  });

  test("a deletion is a lifecycle event", () => {
    const [deleted] = byType("session.deleted");
    expect(deleted?.sessionLifecycle).toMatchObject({ kind: "deleted", directory: WORKSPACE });
  });
});

describe("OpenCode 2.x normalization: compaction, switches, interrupted tools", () => {
  test("compaction is marked in place, and its failure is a warning", () => {
    const { byType } = run(FIXTURES.compactionFailedAndAgentSwitch);
    expect(upserts(byType("session.compaction.started")[0]!)).toEqual([expect.objectContaining({ type: "notice", message: "Compacting conversation context…" })]);
    expect(upserts(byType("session.compaction.failed")[0]!)).toEqual([expect.objectContaining({ type: "notice", level: "warning", message: expect.stringContaining("Compaction failed") })]);
    expect(byType("session.agent.selected")[0]?.configuration).toEqual({ mode: "plan" });
  });

  test("a compaction that finishes summarizes in place", () => {
    const normalize = createOpenCodeV2Normalizer(WORKSPACE);
    const ended = normalize({ id: "evt_c", created: 1_790_000_000_000, type: "session.compaction.ended", location: { directory: WORKSPACE }, data: { sessionID: "ses_c", reason: "manual", text: "Earlier turns, summarized.", recent: "msg_x" } });
    expect(upserts(ended)).toEqual([expect.objectContaining({ type: "notice", message: "Earlier turns, summarized." })]);
  });

  test("a model switch replaces the model and carries its variant", () => {
    const normalize = createOpenCodeV2Normalizer(WORKSPACE);
    const selected = normalize({ id: "evt_m", created: 1, type: "session.model.selected", location: { directory: WORKSPACE }, data: { sessionID: "ses_m", model: { id: "mimo-v2.6-flash-free", providerID: "opencode", variant: "high" } } });
    expect(selected.configuration).toEqual({ model: { providerId: "opencode", modelId: "mimo-v2.6-flash-free" }, variant: "high" });
    expect(selected.replaceModel).toBe(true);
  });

  test("a tool interrupted before its name was seen still settles as failed", () => {
    const { byType } = run(FIXTURES.interruptedTool);
    const [failed] = byType("session.tool.failed");
    expect(upserts(failed!)).toEqual([expect.objectContaining({ id: expect.stringMatching(/^tool:call_/), type: "tool", status: "failed", error: "Tool execution interrupted" })]);
  });

  test("the revert lifecycle is carried as such", () => {
    const normalize = createOpenCodeV2Normalizer(WORKSPACE);
    const base = { created: 1, location: { directory: WORKSPACE } };
    expect(normalize({ ...base, id: "e1", type: "session.revert.staged", data: { sessionID: "ses_r", revert: { messageID: "msg_1" } } }).revertLifecycle).toBe("staged");
    expect(normalize({ ...base, id: "e2", type: "session.revert.committed", data: { sessionID: "ses_r", to: "msg_1" } }).revertLifecycle).toBe("committed");
    expect(normalize({ ...base, id: "e3", type: "session.revert.cleared", data: { sessionID: "ses_r" } }).revertLifecycle).toBe("cleared");
  });
});

describe("OpenCode 2.x normalization: scoping and restatement", () => {
  test("another directory's activity yields nothing and is not counted as unrecognized", () => {
    const normalize = createOpenCodeV2Normalizer(WORKSPACE);
    const foreign = normalize({ id: "evt_f", created: 1, type: "session.text.delta", location: { directory: "/somewhere/else" }, data: { sessionID: "ses_f", assistantMessageID: "msg_f", ordinal: 0, delta: "not ours" } });
    expect(foreign).toEqual({ conversationId: undefined, updates: [], outcome: "ignored", eventType: "session.text.delta" });
  });

  test("an unknown type is counted as unrecognized", () => {
    const normalize = createOpenCodeV2Normalizer(WORKSPACE);
    expect(normalize({ id: "evt_u", created: 1, type: "session.future.thing", data: { sessionID: "ses_u" } })).toMatchObject({ conversationId: "ses_u", updates: [], outcome: "unrecognized", eventType: "session.future.thing" });
  });

  test("a content restatement lands on the streamed identities", () => {
    const normalize = createOpenCodeV2Normalizer(WORKSPACE);
    const memory = createOpenCodeV2Memory();
    const base = { created: 5, location: { directory: WORKSPACE } };
    const streamed = normalize({ ...base, id: "e1", type: "session.text.delta", data: { sessionID: "ses_s", assistantMessageID: "msg_s", ordinal: 0, delta: "hel" } }, memory);
    const restated = normalize({ ...base, id: "e2", type: "session.message.content.updated", data: { sessionID: "ses_s", messageID: "msg_s", content: [
      { type: "reasoning", text: "thinking", time: { created: 1, completed: 3 } },
      { type: "text", text: "hello" },
      { type: "tool", id: "call_1", name: "shell", state: { status: "completed", input: { command: "echo hi" }, content: [{ type: "text", text: "hi\n" }], metadata: { exit: 0 } }, time: { completed: 4 } },
    ] } }, memory);
    const streamedText = streamed.updates[0];
    if (streamedText?.kind !== "text") throw new Error("expected a text update");
    expect(restated.updates).toEqual([
      expect.objectContaining({ kind: "text", itemId: "reasoning:msg_s:reasoning:0", identity: "msg_s:reasoning:0", mode: "cumulative", text: "thinking", item: expect.objectContaining({ type: "reasoning", status: "completed", durationMs: 2 }) }),
      expect.objectContaining({ kind: "text", itemId: streamedText.itemId, identity: streamedText.identity, mode: "cumulative", text: "hello" }),
      { kind: "upsert", item: expect.objectContaining({ id: "tool:call_1", type: "command", command: "echo hi", status: "completed", output: "hi\n", exitCode: 0, completedAt: 4 }) },
    ]);
  });
});

describe("OpenCode 2.x normalization agrees with 1.x for the same activity", () => {
  const normalizeV2 = createOpenCodeV2Normalizer(WORKSPACE);
  const shape = (event: NormalizedProviderEvent) => event.updates.map(update => {
    if (update.kind === "text") return { kind: update.kind, mode: update.mode, text: update.text, type: update.item?.type };
    if (update.kind === "upsert") {
      const { id: _id, createdAt: _createdAt, ...rest } = update.item as Record<string, unknown>;
      return { kind: update.kind, ...rest };
    }
    return update;
  });

  test("text, reasoning, tool, permission, revert, compaction, and failure", () => {
    const v1 = (type: string, properties: Record<string, unknown>) => normalizeV1({ type, properties: { sessionID: "ses_p", timestamp: 7, ...properties } });
    const v2 = (type: string, data: Record<string, unknown>, memory?: OpenCodeV2Memory) => normalizeV2({ id: "evt", created: 7, type, location: { directory: WORKSPACE }, data: { sessionID: "ses_p", ...data } }, memory);

    expect(shape(v2("session.text.delta", { assistantMessageID: "msg_p", ordinal: 0, delta: "hi" })))
      .toEqual(shape(v1("session.next.text.delta", { textID: "part_1", delta: "hi" })));
    expect(shape(v2("session.reasoning.ended", { assistantMessageID: "msg_p", ordinal: 0, text: "why" })))
      .toEqual(shape(v1("session.next.reasoning.ended", { reasoningID: "part_2", text: "why" })));

    const memory = createOpenCodeV2Memory();
    v2("session.tool.input.started", { assistantMessageID: "msg_p", id: "call_1", name: "read" }, memory);
    expect(shape(v2("session.tool.success", { assistantMessageID: "msg_p", id: "call_1", content: [{ type: "text", text: "line" }], metadata: {}, executed: true }, memory)))
      .toEqual(shape(v1("session.next.tool.success", { callID: "call_1", tool: "read", content: [{ type: "text", text: "line" }], metadata: {} })));

    const permission = { id: "per_1", action: "external_directory", resources: ["/etc/*"], save: ["/etc/*"] };
    expect(shape(v2("permission.asked", permission))).toEqual(shape(v1("permission.asked", permission)));
    expect(shape(v2("permission.replied", { requestID: "per_1", reply: "always" }))).toEqual(shape(v1("permission.replied", { requestID: "per_1", reply: "always" })));

    expect(v2("session.revert.staged", { revert: { messageID: "msg_1" } }).revertLifecycle).toBe(v1("session.next.revert.staged", { messageID: "msg_1" }).revertLifecycle);
    expect(shape(v2("session.compaction.ended", { reason: "manual", text: "summary", recent: "msg_1" })))
      .toEqual(shape(v1("session.next.compaction.ended", { summary: "summary" })));
    expect(shape(v2("session.step.failed", { assistantMessageID: "msg_p", error: { type: "unknown", message: "boom" } })))
      .toEqual(shape(v1("session.next.step.failed", { assistantMessageID: "msg_p", error: { message: "boom" } })));
    // The one divergence: 2.x reports a Stop as an aborted step, which is
    // not a failure, before the interrupted execution that ends the turn.
    expect(v2("session.step.failed", { assistantMessageID: "msg_p", error: { type: "aborted", message: "Step interrupted" } }).updates).toEqual([]);
  });
});

describe("form fields as structured questions", () => {
  test("each field kind maps to the choice shape the surface can render", () => {
    expect(formFieldToQuestion({ key: "k", type: "string", title: "T", description: "D", required: true, options: [{ value: "a", label: "A", description: "first" }] }))
      .toEqual({ prompt: "T", header: "D", options: [{ label: "A", description: "first" }], multiple: false, allowFreeForm: true });
    expect(formFieldToQuestion({ key: "k", type: "string", options: [{ value: "a", label: "A" }], custom: false }))
      .toEqual({ prompt: "k", header: "", options: [{ label: "A", description: "" }], multiple: false, allowFreeForm: false, optional: true });
    expect(formFieldToQuestion({ key: "n", type: "integer", title: "How many?", required: true }))
      .toEqual({ prompt: "How many?", header: "Whole number", options: [], multiple: false, allowFreeForm: true });
    expect(formFieldToQuestion({ key: "m", type: "multiselect", title: "Pick", options: [{ value: "x", label: "X" }], custom: true, required: true }))
      .toEqual({ prompt: "Pick", header: "", options: [{ label: "X", description: "" }], multiple: true, allowFreeForm: true });
  });
});
