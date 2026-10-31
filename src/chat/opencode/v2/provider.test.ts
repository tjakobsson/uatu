import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ClientError } from "@opencode/client";
import type { FormCancelled, FormCreated, FormReplied, PermissionAsked, PermissionReplied, ShellInfo, SessionCreated, SessionExecutionStarted, SessionExecutionSucceeded, SessionToolInputStarted, SessionToolCalled, SessionToolSuccess, SessionMessageContentUpdated } from "@opencode/client";

import { InvalidQuestionAnswerError, ReversibleHistoryTargetError } from "../../provider";
import { createOpenCodeV2Provider, formAnswerFromChoices, type OpenCodeV2Provider } from "./provider";
import { ChatAdapter, SteerAlreadyDeliveredError, SteerWithdrawalUnconfirmedError } from "../../adapter";
import { compactWorkers, workerSummary } from "../../compact-work";
import { startOpenCodeV2Fake } from "../../../../tests/e2e/opencode-v2-fake";

// The stored records of a real 2.0.13 session: user, assistant (read tool),
// assistant (text), idle, user — see normalization.test.ts for provenance.
const FIXTURES = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/real-2.0.13.json"), "utf8")) as {
  storedMessages: { data: Array<Record<string, unknown>> };
};
const STORED = FIXTURES.storedMessages.data;
const WORKSPACE = "/ws";
const AUTH = `Basic ${Buffer.from("opencode:pw").toString("base64")}`;

type Call = { method: string; path: string; query: URLSearchParams; body: unknown; headers: Headers; signal: AbortSignal };
const ENVELOPED = [
  /^GET \/api\/session\/[^/]+$/,
  /^POST \/api\/session$/,
  /^POST \/api\/session\/[^/]+\/(prompt|compact|revert\/stage)$/,
  /^GET \/api\/session\/[^/]+\/form\/[^/]+$/,
];
type Handler = (call: Call) => unknown;

// A 2.x server as the pinned client sees it: JSON bodies, `204` for void
// routes, a tagged JSON error for a missing session, SSE on `/api/event`.
function fakeOpenCode(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  // Every slash dispatch reads both catalogs; a test that does not care
  // about them serves empty ones.
  const catalogs: Record<string, Handler> = { "GET /api/command": () => scoped([]), "GET /api/skill": () => scoped([]) };
  const patterns = Object.entries({ ...catalogs, ...routes }).map(([pattern, handler]) => {
    const [method, route] = pattern.split(" ") as [string, string];
    const regex = new RegExp(`^${route.replace(/:[a-zA-Z]+/g, "[^/]+")}$`);
    return { method, regex, handler };
  });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    const url = new URL(request.url);
    const text = await request.clone().text().catch(() => "");
    const call: Call = { method: request.method, path: url.pathname, query: url.searchParams, body: text ? JSON.parse(text) : undefined, headers: request.headers, signal: request.signal };
    calls.push(call);
    const match = patterns.find(candidate => candidate.method === request.method && candidate.regex.test(url.pathname));
    if (!match) return Response.json({ _tag: "NotFoundError", message: `no route ${request.method} ${url.pathname}` }, { status: 404 });
    const result = await match.handler(call);
    if (result instanceof Response) return result;
    if (result === undefined) return new Response(null, { status: 204 });
    // Single-record routes answer `{ data: … }`, which the client unwraps;
    // list routes answer their own shapes, which it returns whole.
    return Response.json(ENVELOPED.some(pattern => pattern.test(`${request.method} ${url.pathname}`)) ? { data: result } : result);
  }) as typeof globalThis.fetch;
  const provider = (directory = WORKSPACE, options: { commandAdmissionMs?: number; reloadSettleMs?: number } = {}) => createOpenCodeV2Provider({ endpoint: "http://opencode.test", password: "pw", directory, fetch, ...options }) as OpenCodeV2Provider;
  const requests = (method: string, pathname: string) => calls.filter(call => call.method === method && call.path === pathname);
  return { calls, provider, requests };
}

function session(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectID: "global",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 100, updated: 200 },
    title: `Session ${id}`,
    location: { directory: WORKSPACE },
    ...overrides,
  };
}

const scoped = <T>(data: T) => ({ location: { directory: WORKSPACE }, data });
const skillInfo = (id: string, overrides: { name?: string; description?: string } = {}) => ({ id, name: overrides.name ?? id, ...(overrides.description ? { description: overrides.description } : {}), path: `/ws/.opencode/skills/${id}/SKILL.md`, content: `# ${id}` });
const notFound = (sessionID: string) => Response.json({ _tag: "SessionNotFoundError", sessionID, message: `Session not found: ${sessionID}` }, { status: 404 });

// Fresh native reads legitimately advance last-positive-observation clocks;
// projection/filtering assertions still compare every other task/control fact.
const withoutObservationClock = (tasks: import("../../types").BackgroundTaskItem[]) => tasks.map(task => ({ ...task,
  ...(task.activity ? { activity: { ...task.activity, observedAt: undefined } } : {}) }));

describe("newborn worker activity", () => {
  type Native = FormCancelled | FormCreated | FormReplied | PermissionAsked | PermissionReplied | SessionCreated | SessionExecutionStarted | SessionExecutionSucceeded | SessionToolInputStarted | SessionToolCalled | SessionToolSuccess | SessionMessageContentUpdated;
  for (const timing of [
    { created: 20, ran: 20, birth: 20, completed: 30, started: 23 },
    { created: 20, ran: 20, birth: 22, completed: 30, started: 23 },
    { created: 20, ran: 20, birth: 20, completed: 30, started: 31 },
    { created: 100, ran: 292, birth: 308, completed: 317, started: 318 },
    { created: 1_790_000_000_100, ran: 1_790_000_000_292, birth: 1_790_000_000_308, completed: 1_790_000_000_317, started: 1_790_000_000_318 },
  ]) for (const historyFirst of [false, true]) for (const order of ["content-first", "success-first", "start-between-success-content", "snapshot"] as const) test(`first native execution ${JSON.stringify(timing)} historyFirst=${historyFirst} ${order}`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const launch = fixture.launch, tool = launch.content[0];
    launch.time.created = timing.created;
    tool.time = { created: timing.created, ran: timing.ran, completed: timing.completed };
    let history: unknown[] = [], wire!: ReadableStreamDefaultController<Uint8Array>, sequence = 0, lastFrame!: Uint8Array;
    let activeUnavailable = false;
    let permissions: PermissionAsked["data"][] = [];
    let forms: FormCreated["data"]["form"][] = [];
    const sequences = new Map<string, number>();
    const frame = (type: string, data: unknown, created: number) => {
      const aggregateID = (data as { sessionID?: string }).sessionID;
      const seq = aggregateID ? (sequences.get(aggregateID) ?? 0) + 1 : undefined;
      if (aggregateID) sequences.set(aggregateID, seq!);
      lastFrame = new TextEncoder().encode(`data: ${JSON.stringify({ id: `evt_newborn_${++sequence}`, type, data, created,
        ...(aggregateID && type.startsWith("session.") ? { durable: { aggregateID, seq, version: type === "session.tool.success" ? 2 : 1 } } : {}), location: { directory: WORKSPACE } })}\n\n`);
      wire.enqueue(lastFrame);
    };
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}, 1); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/active": () => activeUnavailable ? new Response(null, { status: 500 }) : ({ ses_child: { type: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent", time: { created: timing.birth, updated: timing.started } } : { time: { created: 2, updated: 3 } }),
      "GET /api/session/ses_parent/message": () => ({ data: history, cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/permission/request": () => scoped(permissions),
      "GET /api/form": () => scoped(forms),
    });
    const provider = server.provider(), abort = new AbortController();
    const canonical: import("../../types").ConversationItem[] = [], workers: import("../../types").BackgroundTaskItem[] = [];
    let ack: { session: string; type: string; done: () => void } | undefined;
    const pump = (async () => { for await (const event of provider.events(abort.signal)) {
      for (const update of event.updates) if (update.kind === "upsert") {
        if (update.item.type === "permission" || update.item.type === "question") canonical.push(update.item);
        if (update.item.type === "background_task") workers.push(update.item);
      }
      if (event.eventType === ack?.type && event.conversationId === ack.session) { const done = ack.done; ack = undefined; done(); }
    } })();
    const send = <K extends Native["type"]>(type: K, data: Extract<Native, { type: K }>["data"], at: number) => new Promise<void>(resolve => { ack = { session: "sessionID" in data ? data.sessionID : data.form.sessionID, type, done: resolve }; frame(type, data, at); });
    const common = { sessionID: "ses_parent", assistantMessageID: launch.id, id: tool.id };
    const creation = { projectID: "global", slug: "synthetic-newborn", version: "2.1.2", location: { directory: WORKSPACE } };
    try {
      await provider.waitForEventStream(abort.signal);
      await send("session.created", { ...creation, sessionID: "ses_parent" }, 2);
      if (order !== "snapshot") {
        await send("session.tool.input.started", { ...common, name: "subagent" }, timing.created);
        await send("session.tool.called", { ...common, input: tool.state.input, executed: true }, timing.ran);
      }
      await send("session.created", { ...creation, sessionID: "ses_child", parentID: "ses_parent" }, timing.birth);
      let startFrame!: Uint8Array;
      const start = async () => { await send("session.execution.started", { sessionID: "ses_child" }, timing.started); startFrame = lastFrame; };
      if (timing.started <= timing.completed) await start();
      history = [launch];
      if (historyFirst) await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      const content = () => send("session.message.content.updated", { sessionID: "ses_parent", messageID: launch.id, content: launch.content }, timing.completed);
      const success = () => send("session.tool.success", { ...common, executed: true, content: tool.state.content, metadata: tool.state.metadata }, timing.completed);
      if (order !== "success-first" && order !== "start-between-success-content") await content();
      if (order !== "snapshot") await success();
      if (order === "start-between-success-content" && timing.started > timing.completed) await start();
      if (order === "success-first" || order === "start-between-success-content") await content();
      if (timing.started > timing.completed && order !== "start-between-success-content") await start();
      const rows = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "running", activity: { kind: "working" } });
      if (order === "snapshot") expect(rows[0]?.stateUncertain).toBe(false);
      await new Promise<void>(resolve => { ack = { session: "ses_child", type: "session.execution.started", done: resolve }; wire.enqueue(startFrame); });
      const repeat = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(repeat[0]?.activity).toMatchObject({ kind: "working", executionId: rows[0]?.activity?.executionId });
      const childTool = { sessionID: "ses_child", assistantMessageID: "child-message", id: "child-tool" };
      await send("session.tool.input.started", { ...childTool, name: "question" }, timing.started + 1);
      const permission: PermissionAsked["data"] = { id: "canonical-permission", sessionID: "ses_child", action: "question", resources: ["*"], source: { type: "tool", messageID: childTool.assistantMessageID, id: childTool.id } };
      const unlinkedPermission = { ...permission, id: "unlinked-permission", source: { ...permission.source!, messageID: "old-message" } };
      permissions = [unlinkedPermission];
      await send("permission.asked", unlinkedPermission, timing.started + 2);
      expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity?.kind).toBe("working");
      expect(canonical).toContainEqual(expect.objectContaining({ type: "permission", requestId: unlinkedPermission.id, status: "pending" }));
      permissions = [permission];
      await send("permission.asked", permission, timing.started + 3);
      const blocked = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(blocked[0]?.activity).toMatchObject({ kind: "needs-answer", request: { id: permission.id, kind: "permission" } });
      expect(workers.at(-1)?.activity).toMatchObject({ kind: "needs-answer", request: { id: permission.id, kind: "permission" } });
      expect(canonical).toContainEqual(expect.objectContaining({ type: "permission", requestId: permission.id, conversationId: "ses_child", status: "pending" }));
      expect(canonical.filter(item => item.type === "permission" && item.requestId === permission.id && item.status === "pending")).toHaveLength(1);
      activeUnavailable = true;
      expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]).toMatchObject({ activity: { kind: "needs-answer", request: { id: permission.id, kind: "permission" } }, control: { available: false } });
      activeUnavailable = false;
      permissions = [];
      await send("permission.replied", { sessionID: "ses_child", requestID: permission.id, reply: "once" }, timing.started + 4);
      const resumed = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(resumed[0]?.activity?.kind).toBe("working");
      expect(workers.at(-1)?.activity?.request).toBeUndefined();
      expect(canonical).toContainEqual(expect.objectContaining({ type: "permission", requestId: permission.id, status: "resolved" }));
      await send("session.tool.called", { ...childTool, input: { questions: [{ header: "Choose", question: "Proceed?", options: [{ label: "Yes", description: "Proceed" }] }] }, executed: true }, timing.started + 5);
      // QuestionTool producer at a517687f: native ephemeral permission/form
      // events reference the durable tool via this exact context tuple.
      const question: FormCreated["data"]["form"] = { id: "canonical-question", sessionID: "ses_child", title: "Questions", fields: [{ key: "q0", type: "string", title: "Choose", description: "Proceed?", custom: true, options: [{ value: "Yes", label: "Yes", description: "Proceed" }] }],
        metadata: { kind: "question", tool: { messageID: childTool.assistantMessageID, id: childTool.id } } };
      forms = [question];
      await send("form.created", { form: question }, timing.started + 5);
      expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity).toMatchObject({ kind: "needs-answer", request: { id: question.id, kind: "question" } });
      expect(workers.at(-1)?.activity).toMatchObject({ kind: "needs-answer", request: { id: question.id, kind: "question" } });
      expect(canonical).toContainEqual(expect.objectContaining({ type: "question", requestId: question.id, conversationId: "ses_child", status: "pending" }));
      expect(canonical.filter(item => item.type === "question" && item.requestId === question.id && item.status === "pending")).toHaveLength(1);
      forms = [];
      if (order === "snapshot") await send("form.cancelled", { sessionID: "ses_child", id: question.id }, timing.started + 6);
      else await send("form.replied", { sessionID: "ses_child", id: question.id, answer: { q0: "Yes" } }, timing.started + 6);
      const answered = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(answered[0]?.activity?.kind).toBe("working");
      expect(workers.at(-1)?.activity?.request).toBeUndefined();
      expect(canonical).toContainEqual(expect.objectContaining({ type: "question", requestId: question.id, status: "resolved" }));
      const unrelated = { ...question, id: "unlinked-question", metadata: { kind: "question", tool: { messageID: "old-message", id: childTool.id } } };
      forms = [unrelated];
      await send("form.created", { form: unrelated }, timing.started + 7);
      expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity?.kind).toBe("working");
      expect(canonical).toContainEqual(expect.objectContaining({ type: "question", requestId: unrelated.id, status: "pending" }));
      const arbitraryMetadata = { ...question, id: "arbitrary-form-metadata", metadata: { ...question.metadata, kind: "unrelated" } };
      forms = [arbitraryMetadata];
      await send("form.created", { form: arbitraryMetadata }, timing.started + 8);
      expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity?.kind).toBe("working");
      const lastPositive = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(rows[0]?.activity?.observedAt).toBeGreaterThan(timing.completed);
      activeUnavailable = true;
      const unavailable = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(unavailable[0]?.activity).toMatchObject({ kind: "unavailable", observedAt: lastPositive[0]?.activity?.observedAt });
      activeUnavailable = false;
      expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity?.kind).toBe("working");
      if (order === "snapshot" && timing.birth === 22 && !historyFirst) {
        await send("session.execution.succeeded", { sessionID: "ses_child" }, timing.started + 10);
        const ended = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
        expect(ended[0]).toMatchObject({ status: "running", activity: { kind: "ended", endedAt: timing.started + 10 }, control: { available: false } });
      } else {
        // Current child activity must not redirect the old task to a new run.
        await send("session.execution.started", { sessionID: "ses_child" }, timing.started + 10);
        const reused = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
        expect(reused[0]).toMatchObject({ activity: { kind: "session-active" }, control: { available: false } });
        permissions = [permission];
        await send("permission.asked", permission, timing.started + 11);
        expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity?.kind).toBe("session-active");
        forms = [question];
        await send("form.created", { form: question }, timing.started + 12);
        expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity?.kind).toBe("session-active");
      }
      await expect(provider.stopTask("ses_parent", rows[0]!.taskId)).rejects.toThrow();
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { abort.abort(); await pump; await provider.dispose(); }
  });
});

function historyWorkerLaunch(id: string, at: number) {
  return { id: `msg_${id}`, type: "assistant", time: { created: at }, content: [
    { id, type: "tool", name: "subagent", time: { created: at, ran: at + 1, completed: at + 2 }, state: {
      status: "completed", input: { description: "Fixture worker", background: true }, metadata: { sessionID: "ses_child", status: "running" },
    } },
  ] };
}

test("proven execution aliases bridge reversed live arrival and chronological history without merging reuse", async () => {
  const run = async (reverse: boolean) => {
    const first = historyWorkerLaunch("alias_a", 20), second = historyWorkerLaunch("alias_b", 25);
    let history: unknown[] = [first, second], idle: unknown[] = [], wire!: ReadableStreamDefaultController<Uint8Array>, seq = 0;
    const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `alias-event-${++seq}`, created: 30,
      type, data, location: { directory: WORKSPACE }, ...(type === "server.connected" ? {} : { durable: { aggregateID: "ses_parent", seq, version: 1 } }) })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/active": () => ({ ses_child: { type: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": () => ({ data: history, cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: idle, cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    });
    const provider = server.provider(), stream = observedNativeStream(provider);
    try {
      await stream.seen(event => event.eventType === "server.connected");
      let initial: string | undefined, final: import("../../types").WorkerActivity | undefined;
      for (const message of reverse ? [second, first] : [first, second]) {
        frame("session.message.content.updated", { sessionID: "ses_parent", messageID: message.id, content: message.content });
        await stream.seen(event => event.updates.some(update => {
          if (update.kind !== "upsert" || update.item.type !== "background_task" || !update.item.toolUseIds?.includes(message.content[0]!.id) && update.item.toolUseId !== message.content[0]!.id) return false;
          final = update.item.activity;
          initial ??= final?.executionId;
          return true;
        }));
      }
      const recovered = (await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity;
      expect(final?.executionAliases).toHaveLength(2);
      expect(final?.executionAliases).toContain(initial!);
      expect(recovered?.executionAliases).toEqual(final?.executionAliases);
      expect(recovered?.executionId).toBe(final?.executionId);
      history = [first, second, historyWorkerResult("old-result", 40), historyWorkerLaunch("separate", 50)];
      idle = [{ id: "idle-boundary", type: "idle", time: { created: 40 } }];
      const later = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      const settled = later.find(task => task.status === "completed");
      expect(settled?.activity).toMatchObject({ kind: "ended", executionId: recovered?.executionId, executionAliases: recovered?.executionAliases });
      expect(settled?.activity?.endedAt).toBeUndefined();
      const current = later.find(task => task.status === "running");
      expect(current?.activity?.executionId).toBeDefined();
      expect(final?.executionAliases).not.toContain(current?.activity?.executionId!);
      expect(current?.activity?.executionAliases).toHaveLength(1);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
      return recovered;
    } finally { stream.lifetime.abort(); await stream.pump; await provider.dispose(); }
  };
  const chronological = await run(false), reversed = await run(true);
  expect(reversed?.executionAliases).toEqual(chronological?.executionAliases);
  expect(reversed?.executionId).toBe(chronological?.executionId);
});

for (const scenario of ["activity revocation", "canonical request linkage", "contradictory canonical ran", "partial alias set"] as const) test(`reversed proven aliases retain ${scenario} across chronological recovery`, async () => {
  const request = scenario === "canonical request linkage";
  const first = historyWorkerLaunch("alias_a", 20), second = historyWorkerLaunch("alias_b", 21);
  first.content[0]!.time.completed = 30; second.content[0]!.time.completed = 31;
  let history = [first, second];
  let wire!: ReadableStreamDefaultController<Uint8Array>, seq = 0, pending = false;
  const sequences = new Map<string, number>();
  const permission: PermissionAsked["data"] = { id: "alias-permission", sessionID: "ses_child", action: "question", resources: ["*"], source: { type: "tool", messageID: "child-message", id: "child-tool" } };
  const frame = (type: string, data: Record<string, unknown>, created: number) => {
    const aggregateID = String(data.sessionID ?? ""), next = (sequences.get(aggregateID) ?? 0) + 1;
    sequences.set(aggregateID, next);
    wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `reversed-${++seq}`, type, data, created, location: { directory: WORKSPACE },
      ...(type.startsWith("session.") ? { durable: { aggregateID, seq: next, version: 1 } } : {}) })}\n\n`));
  };
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}, 1); } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/active": () => ({ ses_child: { type: "running" } }),
    "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
    "GET /api/session/ses_parent/message": () => ({ data: history, cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/permission/request": () => scoped(pending ? [permission] : []),
  });
  const provider = server.provider(), abort = new AbortController();
  let ack: { type: string; session: string; done: () => void } | undefined, now = 1_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const pump = (async () => { for await (const event of provider.events(abort.signal)) if (event.eventType === ack?.type && event.conversationId === ack.session) { const done = ack.done; ack = undefined; done(); } })();
  const send = (type: string, data: Record<string, unknown>, created: number) => new Promise<void>(done => { ack = { type, session: String(data.sessionID), done }; frame(type, data, created); });
  try {
    await provider.waitForEventStream(abort.signal);
    await send("session.execution.started", { sessionID: "ses_child" }, 25);
    for (const message of [second, first]) await send("session.message.content.updated", { sessionID: "ses_parent", messageID: message.id, content: message.content }, 31);
    if (request) {
      await send("session.tool.input.started", { sessionID: "ses_child", assistantMessageID: "child-message", id: "child-tool", name: "question" }, 26);
      pending = true;
      await send("permission.asked", permission, 27);
    }
    const initial = (await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]!;
    expect(initial.taskId).toBe("v2:ses_parent:alias_a");
    expect(initial.activity).toMatchObject({ kind: request ? "needs-answer" : "working", observedAt: 1_000,
      ...(request ? { request: { id: permission.id, kind: "permission" } } : {}) });
    if (request) {
      pending = false;
      await send("permission.replied", { sessionID: "ses_child", requestID: permission.id, reply: "once" }, 28);
      expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity).toMatchObject({ kind: "working", observedAt: 1_000 });
    }
    now = 2_000;
    if (scenario === "contradictory canonical ran" || scenario === "partial alias set") {
      const changed = structuredClone(first); changed.content[0]!.time.ran = 29;
      history = scenario === "partial alias set" ? [first] : [changed, second];
      const changedOccurrence = (await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]!;
      expect(changedOccurrence.activity?.kind).toBe("session-active");
      expect(changedOccurrence.activity?.observedAt).toBeUndefined();
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
      return;
    }
    await send("session.execution.started", { sessionID: "ses_child" }, 40);
    if (request) { pending = true; await send("permission.asked", permission, 41); }
    for (let index = 0; index < 2; index++) {
      const recovered = (await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]!;
      expect(recovered).toMatchObject({ taskId: "v2:ses_parent:alias_a", activity: { kind: "session-active", observedAt: 1_000 }, control: { available: false } });
      expect(recovered.activity?.request).toBeUndefined();
      now++;
    }
    await expect(provider.stopTask("ses_parent", initial.taskId)).rejects.toThrow();
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { abort.abort(); await pump; await provider.dispose(); clock.mockRestore(); }
});
const historyWorkerResult = (id: string, at: number) => ({ id, type: "synthetic", time: { created: at }, text: "Fixture done.", metadata: { source: "subagent", childID: "ses_child", state: "completed" } });
function workerHistoryServer(messages: unknown[], idle: unknown[], pending: unknown[] = []) {
  return fakeOpenCode({
    "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
    "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
    "GET /api/session/ses_parent/inbox": () => ({ data: pending }),
    "GET /api/session/ses_parent/message": () => ({ data: messages, cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: idle, cursor: {} }),
  });
}

function workerRecoveryServer() {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const state = { failure: "", childParent: "ses_parent", shellParent: "ses_parent", messages: [fixture.launch, fixture.shell] as unknown[], revert: undefined as string | undefined };
  let wire!: ReadableStreamDefaultController<Uint8Array>;
  let held: { path: string; entered: () => void; gate: Promise<void> } | undefined;
  const frame = (type: string, data: unknown, created = 90) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `${type}:${created}`, type, data, created, location: { directory: WORKSPACE } })}\n\n`));
  const answer = async (path: string, value: unknown) => {
    const result = state.failure === path ? new Response(null, { status: 500 }) : value;
    if (held?.path === path) { const pending = held; held = undefined; pending.entered(); await pending.gate; }
    return result;
  };
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/ses_parent": () => session("ses_parent", state.revert ? { revert: { messageID: state.revert } } : {}),
    "GET /api/session/ses_child": () => session("ses_child", { parentID: state.childParent }),
    "GET /api/session/ses_parent/message": () => ({ data: state.messages, cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/session/ses_child/message": ({ path }) => answer(path, { data: [], cursor: {} }),
    "GET /api/session/active": ({ path }) => answer(path, { ses_child: { status: "running" } }),
    "GET /api/shell/sh_fixture": ({ path }) => answer(path, scoped({ id: "sh_fixture", command: "printf fixture", status: "running", time: { started: 71 }, metadata: { sessionID: state.shellParent } })),
    "DELETE /api/shell/sh_fixture": () => undefined,
    "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
  });
  return { ...server, fixture, state, frame, disconnect: () => wire.close(), holdNext: (path: string) => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    held = { path, entered, gate }; return { started, release };
  } };
}

type StopEvidence = {
  parent: string; taskId: string; child?: string; launchCalls?: readonly string[]; occurrence?: unknown;
  pendingChanges: Set<string>;
  pendingLaunches: Map<string, { child?: string; call?: string; background?: boolean; selectedOnly?: boolean }>;
  pendingBytes: number;
  changed: boolean;
};
// Resource-budget inspection only; behavior still runs through the real SDK
// fetch/SSE seam. Independently serialize the retained evidence, not its ledger.
const stopEvidence = (provider: OpenCodeV2Provider) => [...(provider as unknown as { stopValidations: Set<StopEvidence> }).stopValidations];
const evidencePayloadBytes = (evidence: StopEvidence) => JSON.stringify([evidence.parent, evidence.taskId, evidence.child ?? null, evidence.launchCalls ?? null, evidence.occurrence ?? null, evidence.changed, [...evidence.pendingChanges], [...evidence.pendingLaunches]]).length * 2;

// The unchanged browser native fixture, real client, provider and adapter;
// capture only the fake's transport so these tests open no listener/service.
function nativeBackgroundStack() {
  let handle!: (request: Request) => Response | Promise<Response>;
  const serve = spyOn(Bun, "serve").mockImplementation((options: any) => {
    handle = options.fetch;
    return { port: 42400, stop: async () => undefined } as ReturnType<typeof Bun.serve>;
  });
  let fake: ReturnType<typeof startOpenCodeV2Fake>;
  try { fake = startOpenCodeV2Fake({ directory: WORKSPACE }); } finally { serve.mockRestore(); }
  const fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(new URL(request.url).origin).toBe(fake.url);
    const response = await handle(request);
    if (request.method === "GET" && /^\/api\/shell\/[^/]+$/.test(new URL(request.url).pathname) && response.ok) {
      // The shared browser fake omits required ShellInfo fields. Supply the
      // same synthetic command as its launcher so these provider tests exercise
      // the native schema rather than teaching product code a sparse fallback.
      const body = await response.json();
      const data: ShellInfo = { ...body.data, command: "printf 'safe shell output'", cwd: WORKSPACE,
        shell: "/bin/sh", file: "/fixture/shell.out", time: { started: 1 } };
      return Response.json({ ...body, data });
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory: WORKSPACE, fetch }) as OpenCodeV2Provider;
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, generation: "native-bootstrap", coalesceWindowMs: 0 });
  return { fake, provider, adapter };
}

function observedNativeStream(provider: OpenCodeV2Provider) {
  const lifetime = new AbortController(), events: import("../../provider").NormalizedProviderEvent[] = [];
  const waiting = new Set<{ matches: (event: import("../../provider").NormalizedProviderEvent) => boolean; resolve: () => void }>();
  const pump = (async () => {
    for await (const event of provider.events(lifetime.signal)) {
      events.push(event);
      for (const waiter of waiting) if (waiter.matches(event)) { waiting.delete(waiter); waiter.resolve(); }
    }
  })();
  void pump.catch(() => undefined);
  return { lifetime, pump, seen: (matches: (event: import("../../provider").NormalizedProviderEvent) => boolean) =>
    events.some(matches) ? Promise.resolve() : new Promise<void>(resolve => waiting.add({ matches, resolve })) };
}

test("interrupted child observation does not settle an occurrence from child session outcome alone", async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  let wire!: ReadableStreamDefaultController<Uint8Array>, settled = false;
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 30, location: { directory: WORKSPACE } })}\n\n`));
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent", ...(settled ? { outcome: "succeeded", time: { created: 10, updated: 40, idle: 40 } } : {}) }),
    "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/session/active": () => settled ? {} : { ses_child: { type: "running" } },
  });
  const provider = server.provider();
  let stream = observedNativeStream(provider);
  try {
    await stream.seen(event => event.eventType === "server.connected");
    frame("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
    await stream.seen(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task"));
    expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ status: "running", stateUncertain: false }));
    wire.close(); await stream.pump;
    settled = true; // The terminal SSE frame was lost while disconnected; streams do not replay it.
    stream = observedNativeStream(provider);
    await stream.seen(event => event.eventType === "server.connected");
    const recovered = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toThrow();
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
    expect(recovered).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", status: "running", stateUncertain: true }));
  } finally { stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose(); }
});

test("a cancelled child ownership reader does not cancel a concurrent history reader", async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = fakeOpenCode({
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
    "GET /api/session/ses_child": async ({ signal }) => { entered(); await gate; signal.throwIfAborted(); return session("ses_child", { parentID: "ses_parent" }); },
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
  });
  const provider = server.provider(), first = new AbortController();
  const cancelled = provider.listMessages("ses_parent", { limit: 10, signal: first.signal });
  void cancelled.catch(() => undefined);
  let concurrent: ReturnType<typeof provider.listMessages> | undefined;
  try {
    await started;
    concurrent = provider.listMessages("ses_parent", { limit: 10 });
    void concurrent.catch(() => undefined);
    const deadline = Date.now() + 1_000;
    while ((provider as unknown as { ownershipChecks: Set<unknown> }).ownershipChecks.size < 2 && Date.now() < deadline) await Bun.sleep(0);
    expect((provider as unknown as { ownershipChecks: Set<unknown> }).ownershipChecks.size).toBe(2);
    first.abort();
    await expect(cancelled).rejects.toThrow();
    release();
    expect((await concurrent).completeItems).toContainEqual(expect.objectContaining({ type: "background_task", childConversationId: "ses_child" }));
    expect(server.requests("GET", "/api/session/ses_child")).toHaveLength(1);
  } finally { release(); await Promise.allSettled([cancelled, ...(concurrent ? [concurrent] : [])]); await provider.dispose(); }
});

for (const matchingFirst of [false, true]) test(`cancelled matching-parent reader leaves foreign-parent ownership false (${matchingFirst ? "matching" : "foreign"} parent first)`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = fakeOpenCode({
    "GET /api/session/:id/message": () => ({ data: [fixture.launch], cursor: {} }),
    "GET /api/session/:id": async ({ path, signal }) => {
      const id = path.split("/").at(-1)!;
      if (id !== "ses_child") return session(id);
      entered(); await gate; signal.throwIfAborted();
      return session(id, { parentID: "ses_parent" });
    },
  });
  const provider = server.provider(), matching = new AbortController();
  const state = provider as unknown as { ownershipChecks: Set<unknown>; childParentReads: Map<string, { users: number }> };
  let cancelled: ReturnType<typeof provider.listMessages> | undefined, foreign: ReturnType<typeof provider.listMessages> | undefined;
  const startMatching = () => { cancelled = provider.listMessages("ses_parent", { limit: 10, signal: matching.signal }); void cancelled.catch(() => undefined); };
  const startForeign = () => { foreign = provider.listMessages("ses_other", { limit: 10 }); void foreign.catch(() => undefined); };
  try {
    (matchingFirst ? startMatching : startForeign)();
    await started;
    (matchingFirst ? startForeign : startMatching)();
    const deadline = Date.now() + 1_000;
    while (state.ownershipChecks.size < 2 && Date.now() < deadline) await Bun.sleep(0);
    expect(state.ownershipChecks.size).toBe(2);
    expect(state.childParentReads.get("ses_child")?.users).toBe(2);
    matching.abort();
    await expect(cancelled!).rejects.toThrow();
    expect(state.ownershipChecks.size).toBe(1);
    expect(state.childParentReads.get("ses_child")?.users).toBe(1);
    expect(server.requests("GET", "/api/session/ses_child")[0]!.signal.aborted).toBe(false);
    release();
    expect((await foreign!).completeItems?.some(item => item.type === "background_task")).toBe(false);
    expect(server.requests("GET", "/api/session/ses_child")).toHaveLength(1);
    expect(server.requests("GET", "/api/session/ses_child/message")).toHaveLength(0);
    expect(state.ownershipChecks.size).toBe(0);
    expect(state.childParentReads.size).toBe(0);
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { release(); await Promise.allSettled([...(cancelled ? [cancelled] : []), ...(foreign ? [foreign] : [])]); await provider.dispose(); }
});

for (const setup of ["readSignal", "childParents.read"] as const) test(`synchronous child ownership ${setup} failure retires only its unjoined guard`, async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = fakeOpenCode({
    "GET /api/session/ses_child": async ({ signal }) => { entered(); await gate; signal.throwIfAborted(); return session("ses_child", { parentID: "ses_parent" }); },
  });
  const provider = server.provider();
  // Inject only a synchronous setup fault; normal reads still use the real SDK.
  const state = provider as unknown as {
    verifiedChild(child: string, parent: string, signal: AbortSignal): Promise<boolean>;
    readSignal(signal?: AbortSignal): AbortSignal;
    childParents: { read(...args: unknown[]): Promise<readonly [string, string]> };
    ownershipChecks: Set<unknown>;
    childParentReads: Map<string, { users: number }>;
  };
  const signal = new AbortController().signal;
  const existing = state.verifiedChild("ses_child", "ses_parent", signal);
  let later: Promise<boolean> | undefined;
  try {
    await started;
    const fault = setup === "readSignal" ? spyOn(state, "readSignal") : spyOn(state.childParents, "read");
    fault.mockImplementation(() => { throw new Error("injected shared-read setup failure"); });
    try {
      // More failures than the guard capacity must not crowd out later checks.
      for (let index = 0; index < 16; index++) {
        await expect(state.verifiedChild("ses_failed", "ses_parent", signal)).rejects.toThrow("injected shared-read setup failure");
        expect(state.ownershipChecks.size).toBe(1);
        expect(state.childParentReads.size).toBe(1);
        expect(state.childParentReads.get("ses_child")?.users).toBe(1);
        expect(server.requests("GET", "/api/session/ses_child")[0]!.signal.aborted).toBe(false);
      }
    } finally { fault.mockRestore(); }
    later = state.verifiedChild("ses_child", "ses_parent", signal);
    expect(state.ownershipChecks.size).toBe(2);
    expect(state.childParentReads.get("ses_child")?.users).toBe(2);
    release();
    expect(await existing).toBe(true);
    expect(await later).toBe(true);
    expect(state.ownershipChecks.size).toBe(0);
    expect(state.childParentReads.size).toBe(0);
    expect(server.requests("GET", "/api/session/ses_child")).toHaveLength(1);
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { release(); await Promise.allSettled([existing, ...(later ? [later] : [])]); await provider.dispose(); }
});

for (const foreignWorkspace of [false, true]) test(`shared child ownership checks each caller's parent (${foreignWorkspace ? "foreign workspace" : "foreign parent first"})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = fakeOpenCode({
    "GET /api/session/:id/message": ({ path }) => ({ data: path.includes("ses_child/") ? [] : [fixture.launch], cursor: {} }),
    "GET /api/session/:id": async ({ path }) => {
      const id = path.split("/").at(-1)!;
      if (id !== "ses_child") return session(id);
      entered(); await gate;
      return session(id, { parentID: "ses_parent", ...(foreignWorkspace ? { location: { directory: "/foreign" } } : {}) });
    },
  });
  const provider = server.provider();
  const foreign = provider.listMessages("ses_other", { limit: 10 });
  let owned: ReturnType<typeof provider.listMessages> | undefined;
  try {
    await started;
    owned = provider.listMessages("ses_parent", { limit: 10 });
    const deadline = Date.now() + 1_000;
    while ((provider as unknown as { ownershipChecks: Set<unknown> }).ownershipChecks.size < 2 && Date.now() < deadline) await Bun.sleep(0);
    expect((provider as unknown as { ownershipChecks: Set<unknown> }).ownershipChecks.size).toBe(2);
    release();
    expect((await foreign).completeItems?.some(item => item.type === "background_task")).toBe(false);
    expect((await owned).completeItems?.some(item => item.type === "background_task")).toBe(!foreignWorkspace);
    expect(server.requests("GET", "/api/session/ses_child")).toHaveLength(1);
    if (foreignWorkspace) expect(server.requests("GET", "/api/session/ses_child/message")).toHaveLength(0);
  } finally { release(); await Promise.allSettled([foreign, ...(owned ? [owned] : [])]); await provider.dispose(); }
});

test("a stream child deadline leaves a concurrent history recovery alive", async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  let wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 30, location: { directory: WORKSPACE } })}\n\n`));
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
    "GET /api/session/ses_child": async ({ signal }) => { entered(); await gate; signal.throwIfAborted(); return session("ses_child", { parentID: "ses_parent" }); },
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
  });
  const provider = server.provider(), stream = observedNativeStream(provider);
  let recovery: ReturnType<typeof provider.listMessages> | undefined;
  try {
    await stream.seen(event => event.eventType === "server.connected");
    frame("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: [{ type: "text", text: "Survives deadline" }, ...fixture.launch.content] });
    await started;
    recovery = provider.listMessages("ses_parent", { limit: 10 });
    void recovery.catch(() => undefined);
    const deadline = Date.now() + 800;
    while ((provider as unknown as { ownershipChecks: Set<unknown> }).ownershipChecks.size < 2 && Date.now() < deadline) await Bun.sleep(0);
    expect((provider as unknown as { ownershipChecks: Set<unknown> }).ownershipChecks.size).toBe(2);
    await stream.seen(event => event.updates.some(update => update.kind === "text" && update.text === "Survives deadline"));
    expect(server.requests("GET", "/api/session/ses_child")[0]!.signal.aborted).toBe(false);
    release();
    expect((await recovery).completeItems).toContainEqual(expect.objectContaining({ type: "background_task", childConversationId: "ses_child" }));
    expect(server.requests("GET", "/api/session/ses_child")).toHaveLength(1);
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { release(); await recovery?.catch(() => undefined); stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose(); }
});

for (const kind of ["agent", "shell"] as const) for (const reconnect of [false, true]) test(`new live ${kind} is stoppable ${reconnect ? "after a native observation gap" : "without a gap"}`, async () => {
  const { fake, provider, adapter } = nativeBackgroundStack();
  let stream = observedNativeStream(provider);
  try {
    await stream.seen(event => event.eventType === "server.connected");
    const parent = (await provider.createSession("Fresh worker coverage")).id;
    if (reconnect) {
      fake.disconnect(); await stream.pump;
      stream = observedNativeStream(provider);
      await stream.seen(event => event.eventType === "server.connected");
    }
    const worker = kind === "agent" ? fake.launchWorker(parent, true) : fake.launchShell(parent, true);
    await stream.seen(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task" && update.item.taskId === worker.taskId));
    const rows = await provider.reconcileBackgroundTasks(parent, { fresh: true });
    let failure: unknown;
    try { await provider.stopTask(parent, worker.taskId); } catch (error) { failure = error; }
    const calls = fake.state().calls.filter(call => "childId" in worker
      ? call.startsWith(`POST /api/session/${worker.childId}/interrupt?`)
      : call.startsWith(`DELETE /api/shell/${worker.shellId}?`));
    expect(calls).toHaveLength(1);
    expect(failure).toBeUndefined();
    expect(rows).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "running", stateUncertain: false }));
    expect(fake.state().unhandled).toEqual([]);
  } finally {
    stream.lifetime.abort(); await stream.pump.catch(() => undefined);
    await adapter.dispose(); await fake.stop();
  }
});

for (const kind of ["agent", "shell"] as const) test(`history alone cannot authorize a ${kind} born while the native stream was disconnected`, async () => {
  const { fake, provider, adapter } = nativeBackgroundStack();
  let stream = observedNativeStream(provider);
  try {
    await stream.seen(event => event.eventType === "server.connected");
    const parent = (await provider.createSession("Uncovered worker")).id;
    fake.disconnect(); await stream.pump;
    const worker = kind === "agent" ? fake.launchWorker(parent, true) : fake.launchShell(parent, true);
    stream = observedNativeStream(provider);
    await stream.seen(event => event.eventType === "server.connected");
    expect(await provider.reconcileBackgroundTasks(parent, { fresh: true })).toContainEqual(expect.objectContaining({ taskId: worker.taskId, stateUncertain: true }));
    await expect(provider.stopTask(parent, worker.taskId)).rejects.toThrow();
    expect(fake.state().calls.filter(call => "childId" in worker
      ? call.startsWith(`POST /api/session/${worker.childId}/interrupt?`)
      : call.startsWith(`DELETE /api/shell/${worker.shellId}?`))).toEqual([]);
    expect(fake.state().unhandled).toEqual([]);
  } finally {
    stream.lifetime.abort(); await stream.pump.catch(() => undefined);
    await adapter.dispose(); await fake.stop();
  }
});

for (const change of ["replay", "new-envelope", "command", "started", "foreign-parent", "foreign-scope", "missing-proof", "during-owned-read", "user-after-rebirth"] as const) {
  test(`native shell rebirth fences the retained Stop: ${change}`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let wire!: ReadableStreamDefaultController<Uint8Array>, armed = false, entered!: () => void, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const frame = (raw: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(raw)}\n\n`));
    const shell = { id: "sh_fixture", status: "running", command: fixture.shell.content[0].state.input.command, metadata: { sessionID: "ses_parent" }, time: { started: 65 } };
    const birth = { id: "shell-birth", created: 66, type: "shell.created", location: { directory: WORKSPACE }, data: { info: shell } };
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame({ type: "server.connected", data: {} }); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.shell], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({}),
      "GET /api/shell/sh_fixture": async () => { const owned = scoped({ id: "sh_fixture", metadata: { sessionID: "ses_parent" } }); if (armed) { armed = false; entered(); await gate; } return owned; },
      "DELETE /api/shell/sh_fixture": () => undefined,
    });
    const provider = server.provider();
    let stream = observedNativeStream(provider), stop: Promise<void> | undefined;
    const taskId = "v2:ses_parent:call_shell";
    const barrier = async (label: string) => {
      frame({ id: `barrier-${label}`, created: 100, type: "session.text.delta", location: { directory: WORKSPACE },
        data: { sessionID: "ses_parent", assistantMessageID: `message-${label}`, id: `text-${label}`, delta: label } });
      await stream.seen(event => event.updates.some(update => update.kind === "text" && update.text === label));
    };
    try {
      await stream.seen(event => event.eventType === "server.connected");
      wire.close(); await stream.pump;
      stream = observedNativeStream(provider);
      await stream.seen(event => event.eventType === "server.connected");
      frame(birth);
      frame({ id: "launcher", created: 80, type: "session.message.content.updated", location: { directory: WORKSPACE }, data: {
        sessionID: "ses_parent", messageID: fixture.shell.id, content: fixture.shell.content } });
      await stream.seen(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task" && update.item.taskId === taskId));
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskId, stateUncertain: false }));
      if (change === "during-owned-read") {
        armed = true; stop = provider.stopTask("ses_parent", taskId); void stop.catch(() => undefined); await started;
      }
      const changed = structuredClone(birth) as { id?: string; created: number; type: string; location: { directory: string }; data: { info: typeof shell } };
      if (["new-envelope", "during-owned-read", "user-after-rebirth"].includes(change)) changed.id = "different-birth";
      if (change === "command") changed.data.info.command = "a replacement shell";
      if (change === "started") changed.data.info.time.started = 95;
      if (change === "foreign-parent") changed.data.info.metadata.sessionID = "foreign-parent";
      if (change === "foreign-scope") changed.location.directory = "/foreign";
      if (change === "missing-proof") delete changed.id;
      frame(changed); await barrier("after-rebirth");
      if (change === "user-after-rebirth") {
        frame({ id: "user-shell", created: 101, type: "session.shell.ended", location: { directory: WORKSPACE }, data: { sessionID: "ses_parent", shell, output: { output: "User output" } } });
        frame({ id: "user-note", created: 102, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_parent", inboxID: "user-result", item: {
          type: "synthetic", payload: { text: "User output", metadata: { source: "shell", shellID: "sh_fixture", state: "completed", exit: 0 } } } } });
        await barrier("after-user-note");
      }
      release();
      if (change === "replay") {
        await provider.stopTask("ses_parent", taskId);
        expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(1);
      } else {
        await expect(stop ?? provider.stopTask("ses_parent", taskId)).rejects.toThrow();
        expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(0);
        expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskId, stateUncertain: true }));
      }
    } finally {
      release(); await stop?.catch(() => undefined);
      stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose();
    }
  });
}

for (const change of ["compatible", "old-command", "missing-birth-command", "missing-launch-command", "alias-command"] as const) {
  test(`first-seen public shell Stop binds its command despite fresh same-ID ownership: ${change}`, async () => {
    let wire!: ReadableStreamDefaultController<Uint8Array>;
    const frame = (raw: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(raw)}\n\n`));
    const info = { id: "SH", status: "running", command: "NEW", metadata: { sessionID: "P" }, time: { started: 30 } };
    const birth = { id: "new-birth", created: 31, type: "shell.created", location: { directory: WORKSPACE }, data: { info: {
      ...info, command: change === "missing-birth-command" ? undefined : "NEW" } } };
    const message = { id: "owning-message", type: "assistant", time: { created: change === "old-command" ? 10 : 29 }, content: [{ type: "tool", id: "call", name: "shell",
      time: { created: change === "old-command" ? 10 : 29, completed: 32 }, state: { status: "completed", input: (change === "missing-launch-command" ? {} : { command: change === "old-command" ? "OLD" : "NEW" }) as Record<string, unknown>,
        metadata: { shellID: "SH", status: "running" } } }] };
    if (change === "alias-command") { const alias = structuredClone(message.content[0]!); alias.id = "alias"; alias.state.input.command = "OLD"; message.content.push(alias); }
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame({ type: "server.connected", data: {} }); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/P": () => session("P"),
      "GET /api/session/P/message": () => ({ data: [message], cursor: {} }),
      "GET /api/session/P/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({}),
      "GET /api/shell/SH": () => scoped(info),
      "DELETE /api/shell/SH": () => undefined,
    });
    const provider = server.provider();
    let stream = observedNativeStream(provider);
    try {
      await stream.seen(event => event.eventType === "server.connected");
      wire.close(); await stream.pump;
      stream = observedNativeStream(provider);
      await stream.seen(event => event.eventType === "server.connected");
      frame(birth);
      frame({ id: "live-launch", created: 40, type: "session.message.content.updated", location: { directory: WORKSPACE }, data: { sessionID: "P", messageID: message.id, content: message.content } });
      const taskId = "v2:P:call";
      await stream.seen(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task" && update.item.taskId === taskId));
      const rows = await provider.reconcileBackgroundTasks("P", { fresh: true });
      let failure: unknown;
      try { await provider.stopTask("P", taskId); } catch (error) { failure = error; }
      expect(server.requests("DELETE", "/api/shell/SH")).toHaveLength(change === "compatible" ? 1 : 0);
      expect(rows).toContainEqual(expect.objectContaining({ taskId, stateUncertain: change !== "compatible" }));
      if (change === "compatible") expect(failure).toBeUndefined(); else expect(failure).toBeDefined();
    } finally {
      stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose();
    }
  });
}

for (const kind of ["agent", "shell"] as const) test(`reverted live ${kind} remains independently inspectable and stoppable until settlement`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory }) as OpenCodeV2Provider;
  try {
    const parent = (await provider.createSession("Live work survives transcript revert")).id;
    const branch = await provider.prompt(parent, { id: "live-branch", text: "Revert the launch transcript", delivery: "queue" });
    const worker = kind === "agent" ? fake.launchWorker(parent, true) : fake.launchShell(parent, true);
    expect(await provider.reconcileBackgroundTasks(parent, { fresh: true })).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "running", stateUncertain: false }));
    await provider.interrupt(parent, { resume: false });
    fake.externalRevert(parent, branch.messageId);
    const transcript = await provider.listMessages(parent, { limit: 100 });
    expect(transcript.items).toEqual([]);
    const live = await provider.reconcileBackgroundTasks(parent, { fresh: true });
    expect(live).toEqual([expect.objectContaining({ taskId: worker.taskId, status: "running", stateUncertain: false })]);
    await provider.stopTask(parent, worker.taskId);
    const mutation = kind === "agent" ? `POST /api/session/${"childId" in worker ? worker.childId : ""}/interrupt?resume=false` : `DELETE /api/shell/${"shellId" in worker ? worker.shellId : ""}`;
    expect(fake.state().calls.filter(call => kind === "agent" ? call === mutation : call.split("?")[0] === mutation)).toHaveLength(1);
    if ("childId" in worker) fake.settleWorker(worker.childId, "completed", "Hidden worker finished");
    else { fake.shellPhase(worker.shellId, "exit"); fake.shellPhase(worker.shellId, "capture"); }
    expect(await provider.reconcileBackgroundTasks(parent, { fresh: true })).toEqual([]);
    fake.externalRevert(parent, null);
    expect(await provider.reconcileBackgroundTasks(parent, { fresh: true })).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: kind === "agent" ? "completed" : "failed" }));
    expect(fake.state().unhandled).toEqual([]);
  } finally { await provider.dispose(); await fake.stop(); }
});

for (const phase of [2, 3, 4]) test(`public visibility abort retires cancellation-ignoring parent read ${phase} and its control guard`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  let reads = 0, entered!: () => void, release!: () => void, returned!: () => void;
  const capture = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }), late = new Promise<void>(resolve => { returned = resolve; });
  const server = fakeOpenCode({
    "GET /api/session/ses_parent": async () => { if (++reads === phase) { entered(); await gate; returned(); } return session("ses_parent", { revert: { messageID: fixture.converted.id } }); },
    "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch, fixture.converted], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
    "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent" }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
  });
  const provider = server.provider(), controller = new AbortController();
  const controls = (provider as unknown as { controls: { activeReads: number; usage: unknown; basis(id: string): unknown } }).controls;
  let retired = false;
  const read = provider.reconcileBackgroundTasks("ses_parent", { fresh: true, signal: controller.signal }).finally(() => { retired = true; });
  void read.catch(() => undefined);
  try {
    await capture; controller.abort();
    await Promise.race([read.catch(() => undefined), Bun.sleep(50)]);
    expect(retired).toBe(true);
    expect(controls.activeReads).toBe(0);
    const usage = structuredClone(controls.usage), basis = controls.basis("v2:ses_parent:call_worker");
    release(); await late;
    await expect(read).rejects.toThrow();
    // A subsequent covered read gives the ignored SDK response time to decode;
    // the retired owner must not resume folding or recreate its control guard.
    await provider.getHistoryRevertBoundary("ses_parent", { signal: new AbortController().signal });
    expect(controls.activeReads).toBe(0);
    expect(controls.usage).toEqual(usage);
    expect(controls.basis("v2:ses_parent:call_worker")).toBe(basis);
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { release(); await read.catch(() => undefined); await provider.dispose(); }
});

test("public visibility abort also bounds waiting for an older fresh snapshot owner", async () => {
  let entered!: () => void, release!: () => void;
  const capture = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const server = fakeOpenCode({
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_parent/message": async () => { entered(); await gate; return { data: [], cursor: {} }; },
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/session/active": () => ({}),
  });
  const provider = server.provider(), controller = new AbortController();
  const previous = (provider as unknown as { backgroundSnapshot(id: string): Promise<unknown> }).backgroundSnapshot("ses_parent");
  let retired = false;
  const current = provider.reconcileBackgroundTasks("ses_parent", { fresh: true, signal: controller.signal }).finally(() => { retired = true; });
  void current.catch(() => undefined);
  try {
    await capture; controller.abort();
    await Promise.race([current.catch(() => undefined), Bun.sleep(50)]);
    expect(retired).toBe(true);
    expect((provider as unknown as { controls: { activeReads: number } }).controls.activeReads).toBe(1);
    release(); await previous;
    await expect(current).rejects.toThrow();
    expect(server.requests("GET", "/api/session/ses_parent")).toHaveLength(1);
    expect(server.requests("GET", "/api/session/ses_parent/message")).toHaveLength(1);
    expect((provider as unknown as { controls: { activeReads: number } }).controls.activeReads).toBe(0);
  } finally { release(); await previous.catch(() => undefined); await current.catch(() => undefined); await provider.dispose(); }
});

for (const unavailable of ["foreign", "revoked", "incomplete"] as const) test(`reverted live inventory never enables an ${unavailable} native target`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const launch = structuredClone(fixture.launch);
  if (unavailable === "incomplete") delete launch.content[0].state.input;
  let marker: string | undefined, owner = "ses_parent", wire!: ReadableStreamDefaultController<Uint8Array>;
  const frame = (event: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame({ type: "server.connected", data: {} }); } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/ses_parent": () => session("ses_parent", marker ? { revert: { messageID: marker } } : {}),
    "GET /api/session/ses_parent/message": () => ({ data: [launch], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
    "GET /api/session/ses_child": () => session("ses_child", { parentID: owner }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
  });
  const provider = server.provider(), controller = new AbortController();
  let events: AsyncIterator<import("../../provider").NormalizedProviderEvent> | undefined;
  try {
    if (unavailable !== "incomplete") expect(await provider.reconcileBackgroundTasks("ses_parent")).toEqual([expect.objectContaining({ stateUncertain: false })]);
    if (unavailable === "foreign") owner = "another_parent";
    if (unavailable === "revoked") {
      events = provider.events(controller.signal)[Symbol.asyncIterator](); await events.next();
      const next = events.next();
      frame({ type: "session.moved", location: { directory: WORKSPACE }, data: { sessionID: "ses_child", location: { directory: "/foreign" } } });
      await next;
    }
    marker = launch.id;
    const rows = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    expect(rows.every(item => item.stateUncertain === true)).toBe(true);
    if (unavailable === "incomplete" || unavailable === "foreign") expect(rows).toEqual([]);
    else expect(rows).toEqual([expect.objectContaining({ status: "running", stateUncertain: true })]);
    await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toThrow();
    expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { controller.abort(); await events?.return?.(); await provider.dispose(); }
});

test("public recovery excludes an exactly reverted completed worker while its private evidence remains", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory }) as OpenCodeV2Provider;
  try {
    const parent = (await provider.createSession("Public revert visibility")).id;
    const branch = await provider.prompt(parent, { id: "branch-to-revert", text: "Externally reverted turn", delivery: "queue" });
    const worker = fake.launchWorker(parent, true);
    fake.settleWorker(worker.childId, "completed", "Terminal worker report");
    fake.step(parent);
    const taskId = `task:${worker.taskId}`;
    expect(await provider.reconcileBackgroundTasks(parent, { fresh: true })).toContainEqual(expect.objectContaining({ id: taskId, status: "completed" }));
    fake.externalRevert(parent, branch.messageId);
    const visible = await provider.listMessages(parent, { limit: 100 });
    expect(visible.revertVisibility?.excludedItemIds).toContain(taskId);
    expect(visible.completeItems?.some(item => item.id === taskId)).toBe(false);
    // Inspection only: public hiding must not erase the private Stop basis.
    const privateSnapshot = await (provider as unknown as { backgroundSnapshot(id: string, options: { fresh: boolean }): Promise<{ tasks: unknown[]; occurrences: ReadonlyMap<string, unknown>; controls: ReadonlyMap<string, unknown> }> }).backgroundSnapshot(parent, { fresh: true });
    expect(privateSnapshot.tasks).toContainEqual(expect.objectContaining({ id: taskId, status: "completed" }));
    const recovered = await provider.reconcileBackgroundTasks(parent, { fresh: true });
    expect(recovered.filter(item => item.id === taskId)).toHaveLength(0);
    fake.externalRevert(parent, null);
    expect(await provider.reconcileBackgroundTasks(parent, { fresh: true })).toContainEqual(expect.objectContaining({ id: taskId, status: "completed" }));
    expect(fake.state().unhandled).toEqual([]);
  } finally { await provider.dispose(); await fake.stop(); }
});

for (const kind of ["running", "shell", "reused-child"] as const) test(`public revert visibility preserves retained work and private evidence: ${kind}`, async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory }) as OpenCodeV2Provider;
  const privateRead = () => (provider as unknown as { backgroundSnapshot(id: string, options: { fresh: boolean }): Promise<{ tasks: import("../../types").BackgroundTaskItem[]; occurrences: ReadonlyMap<string, unknown>; controls: ReadonlyMap<string, unknown> }> }).backgroundSnapshot(parent, { fresh: true });
  let parent: string;
  try {
    parent = (await provider.createSession("Retained public worker prefix")).id;
    await provider.prompt(parent, { id: "retained", text: "Keep this turn", delivery: "queue" });
    const kept = fake.launchWorker(parent, true);
    fake.settleWorker(kept.childId, "completed", "Retained completion");
    fake.step(parent); fake.finish(parent);
    const branch = await provider.prompt(parent, { id: "hidden", text: "Revert only this suffix", delivery: "queue" });
    if (kind === "shell") fake.launchShell(parent, true);
    else fake.launchWorker(parent, true, kind === "reused-child" ? kept.childId : undefined);
    const full = await privateRead();
    expect(full.tasks.some(item => item.status === "running")).toBe(true);
    fake.externalRevert(parent, branch.messageId);
    const history = await provider.listMessages(parent, { limit: 1 });
    const publicRows = await provider.reconcileBackgroundTasks(parent, { fresh: true });
    // User-approved: the completed retained prefix and independently current
    // detached suffix are both listed; only its launch transcript is hidden.
    expect(publicRows).toHaveLength(2);
    expect(publicRows).toContainEqual(expect.objectContaining({ id: `task:${kept.taskId}`, status: "completed" }));
    expect(publicRows.filter(item => item.status === "running")).toEqual([expect.objectContaining({ stateUncertain: false })]);
    expect(publicRows.filter(item => !history.revertVisibility!.excludedItemIds.includes(item.id)).map(item => [item.id, item.status, item.toolUseIds])).toEqual(history.completeItems!.filter(item => item.type === "background_task").map(item => [item.id, item.status, item.toolUseIds]));
    // Filtering never mutates/clears the full fold, occurrences or Stop witnesses.
    const reread = await privateRead();
    expect({ ...reread, tasks: withoutObservationClock(reread.tasks) }).toEqual({ ...full, tasks: withoutObservationClock(full.tasks) });
    if (kind === "reused-child") {
      await expect(provider.stopTask(parent, kept.taskId)).rejects.toThrow();
      expect(fake.state().calls.filter(call => call.startsWith(`POST /api/session/${kept.childId}/interrupt`))).toEqual([]);
    }
    fake.externalRevert(parent, null);
    expect(withoutObservationClock(await provider.reconcileBackgroundTasks(parent, { fresh: true }))).toEqual(withoutObservationClock(full.tasks));
    expect(fake.state().unhandled).toEqual([]);
  } finally { await provider.dispose(); await fake.stop(); }
});

test("public revert visibility uses the visible prefix of a folded alias without erasing its private suffix", async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  let boundary: string | undefined = fixture.converted.id;
  const server = fakeOpenCode({
    "GET /api/session/ses_parent": () => session("ses_parent", boundary ? { revert: { messageID: boundary } } : {}),
    "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch, fixture.converted], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
    "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent" }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
  });
  const provider = server.provider();
  const privateRead = () => (provider as unknown as { backgroundSnapshot(id: string, options: { fresh: boolean }): Promise<{ tasks: import("../../types").BackgroundTaskItem[] }> }).backgroundSnapshot("ses_parent", { fresh: true });
  try {
    const full = await privateRead();
    expect(full.tasks[0]?.toolUseIds).toEqual(["call_worker", "call_converted"]);
    const prefix = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    expect(prefix).toHaveLength(1);
    expect(prefix[0]?.taskId).toBe("v2:ses_parent:call_worker");
    expect(prefix[0]?.toolUseId).toBe("call_worker");
    expect(prefix[0]?.toolUseIds).toBeUndefined();
    const reread = await privateRead();
    expect({ ...reread, tasks: withoutObservationClock(reread.tasks) }).toEqual({ ...full, tasks: withoutObservationClock(full.tasks) });
    boundary = fixture.launch.id;
    expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toEqual([expect.objectContaining({ taskId: "v2:ses_parent:call_worker", status: "running", stateUncertain: false })]);
    boundary = undefined;
    expect(withoutObservationClock(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))).toEqual(withoutObservationClock(full.tasks));
  } finally { await provider.dispose(); }
});

for (const change of ["boundary", "restore", "stream-generation", "parent-unavailable", "child-unavailable"] as const) test(`public revert visibility refuses a captured view changed during filtering: ${change}`, async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let parent: string, child: string, unavailable = false, unavailableChild = false, hold = false, reads = 0, captured!: () => void, release!: () => void;
  const capture = new Promise<void>(resolve => { captured = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const isParent = new URL(request.url).pathname === `/api/session/${parent}`;
    if (unavailable && isParent) return Response.json({ _tag: "InternalError", message: "Fixture native parent unavailable" }, { status: 500 });
    if (unavailableChild && new URL(request.url).pathname === `/api/session/${child}`) return Response.json({ _tag: "InternalError", message: "Fixture native child unavailable" }, { status: 500 });
    const response = await fetch(request);
    if (hold && isParent && ++reads === 3) {
      hold = false;
      const body = await response.text(); captured(); await gate;
      return new Response(body, { status: response.status, headers: response.headers });
    }
    return response;
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport }) as OpenCodeV2Provider;
  const controller = new AbortController();
  let events: AsyncIterator<import("../../provider").NormalizedProviderEvent> | undefined;
  let recovery: Promise<unknown> | undefined;
  try {
    parent = (await provider.createSession("Captured public visibility")).id;
    const branch = await provider.prompt(parent, { id: "branch", text: "Revert boundary", delivery: "queue" });
    child = fake.launchWorker(parent, true).childId;
    // Keep the launcher visible for a failed canonical ownership read: absence
    // from an incomplete fold must not authorize its private inventory copy.
    if (change === "child-unavailable") fake.appendHistory(parent, 1);
    fake.externalRevert(parent, change === "child-unavailable" ? fake.state().sessions[parent]!.messages.at(-1)!.id : branch.messageId);
    hold = true;
    recovery = provider.reconcileBackgroundTasks(parent, { fresh: true });
    void recovery.catch(() => undefined);
    await capture;
    if (change === "stream-generation") { events = provider.events(controller.signal)[Symbol.asyncIterator](); await events.next(); }
    else if (change === "parent-unavailable") unavailable = true;
    else if (change === "child-unavailable") unavailableChild = true;
    else fake.externalRevert(parent, change === "restore" ? null : fake.state().sessions[parent]!.messages.at(-1)!.id);
    release();
    await expect(recovery).rejects.toThrow(change === "parent-unavailable" || change === "child-unavailable" ? "OpenCode session lookup failed" : "Background visibility changed");
    expect(fake.state().unhandled).toEqual([]);
  } finally { release(); await recovery?.catch(() => undefined); controller.abort(); await events?.return?.(); await provider.dispose(); await fake.stop(); }
});

for (const failRevalidation of [false, true]) test(`public revert visibility rereads the native parent after an older worker snapshot: ${failRevalidation ? "unavailable" : "reverted"}`, async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let hold = false, fail = false, captured!: () => void, release!: () => void;
  const capture = new Promise<void>(resolve => { captured = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let parent: string;
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), pathname = new URL(request.url).pathname;
    if (fail && pathname === `/api/session/${parent}`) return Response.json({ _tag: "InternalError", message: "Fixture native parent unavailable" }, { status: 500 });
    const response = await fetch(request);
    if (hold && pathname === "/api/session/active") {
      hold = false;
      const body = await response.text(); captured(); await gate;
      return new Response(body, { status: response.status, headers: response.headers });
    }
    return response;
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport }) as OpenCodeV2Provider;
  let recovery: Promise<unknown> | undefined;
  try {
    parent = (await provider.createSession("Delayed native worker snapshot")).id;
    const branch = await provider.prompt(parent, { id: "branch", text: "Revert during inventory read", delivery: "queue" });
    const worker = fake.launchWorker(parent, true);
    hold = true;
    recovery = provider.reconcileBackgroundTasks(parent, { fresh: true });
    void recovery.catch(() => undefined);
    await capture;
    fake.externalRevert(parent, branch.messageId);
    fail = failRevalidation;
    release();
    if (failRevalidation) await expect(recovery).rejects.toThrow("OpenCode session lookup failed");
    else {
      expect(await recovery).toEqual([expect.objectContaining({ taskId: worker.taskId, status: "running", stateUncertain: false })]);
      expect((await provider.listMessages(parent, { limit: 100 })).items).toEqual([]);
    }
    expect(fake.state().unhandled).toEqual([]);
  } finally { release(); await recovery?.catch(() => undefined); await provider.dispose(); await fake.stop(); }
});

describe("native bootstrap admission through the real adapter", () => {
  for (const [missing, uncertain] of [["created", true], ["input", true], ["both", true], ["native-zero-empty", false], ["native-created-empty", false]] as const) test(`cold immutable invocation proof: ${missing}`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const complete = structuredClone(fixture.launch);
    delete complete.content[0].time.ran; delete complete.content[0].time.completed;
    if (!uncertain) { complete.content[0].time.created = missing === "native-zero-empty" ? 0 : 20; complete.content[0].state.input = {}; }
    const partial = structuredClone(complete);
    if (missing === "created" || missing === "both") delete partial.content[0].time.created;
    if (missing === "input" || missing === "both") delete partial.content[0].state.input;
    let history = partial, wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined, sequence = 0;
    const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `cold-proof-${++sequence}`, type, data, created: 30, location: { directory: WORKSPACE } })}\n\n`));
    const send = (type: string, data: unknown) => new Promise<void>(resolve => { acknowledge = resolve; frame(type, data); });
    const snapshot = (message: typeof complete) => send("session.message.content.updated", { sessionID: "ses_parent", messageID: message.id, content: message.content });
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { ...(path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}), time: { created: 0, updated: 30 } }),
      "GET /api/session/ses_parent/message": () => ({ data: [history], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), lifetime = new AbortController();
    const pump = (async () => { for await (const event of provider.events(lifetime.signal)) if (event.eventType !== "server.connected") { const done = acknowledge; acknowledge = undefined; done?.(); } })();
    const recovered = () => provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    try {
      await provider.waitForEventStream(lifetime.signal);
      expect(await recovered()).toEqual([expect.objectContaining({ taskId: "v2:ses_parent:call_worker", stateUncertain: uncertain })]);
      if (uncertain) {
        await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toThrow(/no longer/);
        expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
        // Display clocks and lookalike proof fields are not canonical native evidence.
        history = structuredClone(partial);
        history.content[0].createdAt = 20;
        history.content[0].inputFingerprint = "f".repeat(64);
        expect(await recovered()).toEqual([expect.objectContaining({ stateUncertain: true })]);
        await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toThrow(/no longer/);
        expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
        history = complete;
        await snapshot(complete);
        expect(await recovered()).toEqual([expect.objectContaining({ stateUncertain: false })]);
      }
      await provider.stopTask("ses_parent", "v2:ses_parent:call_worker");
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(1);
      // Sparse progress neither erases nor replaces the now-complete retained basis.
      await send("session.tool.progress", { sessionID: "ses_parent", assistantMessageID: complete.id, id: "call_worker", metadata: { sessionID: "ses_child", status: "running" } });
      expect(await recovered()).toEqual([expect.objectContaining({ stateUncertain: false })]);
      await provider.stopTask("ses_parent", "v2:ses_parent:call_worker");
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(2);
      // Completing/forging fields cannot repair a subsequently revoked native owner.
      await snapshot({ ...complete, id: "different_native_owner" });
      await snapshot(complete);
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toThrow(/no longer/);
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(2);
    } finally { lifetime.abort(); await pump; await provider.dispose(); }
  });

  for (const change of ["foreign-payload-birth", "move", "delete", "new-generation"] as const) test(`pre-admission ${change} cannot authorize a stale native occurrence`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined, sequence = 0;
    const frame = (type: string, data: unknown, created: number) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `negative-${++sequence}`, type, data, created, location: { directory: WORKSPACE } })}\n\n`));
    const send = (type: string, data: unknown, created: number) => new Promise<void>(resolve => { acknowledge = resolve; frame(type, data, created); });
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}, 1); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), lifetime = new AbortController();
    const pump = (async () => { for await (const event of provider.events(lifetime.signal)) if (event.eventType !== "server.connected") { const done = acknowledge; acknowledge = undefined; done?.(); } })();
    try {
      await provider.waitForEventStream(lifetime.signal);
      const type = change === "move" ? "session.moved" : change === "delete" ? "session.deleted" : "session.created";
      await send(type, { sessionID: "ses_child", parentID: "ses_parent", location: { directory: change === "foreign-payload-birth" ? "/foreign" : WORKSPACE } }, change === "new-generation" ? 40 : 10);
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content }, 50);
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toThrow(/no longer/);
        expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toEqual([expect.objectContaining({ stateUncertain: true })]);
      }
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
    } finally { lifetime.abort(); await pump; await provider.dispose(); }
  });

  test("native initial foreground work stays certain and detaches with its original identity", async () => {
    const { fake, provider, adapter } = nativeBackgroundStack();
    const pump = adapter.startEventPump(); void pump.catch(() => undefined);
    try {
      await provider.waitForEventStream(new AbortController().signal);
      const parent = (await adapter.createConversation()).conversation.id;
      await adapter.prompt(parent, "fixture-prompt", "Start fixture work");
      const worker = fake.launchWorker(parent, false);
      await adapter.history(parent);
      expect(workerSummary(compactWorkers(adapter.projectionForTests(parent).items()))).toBe("1 working");
      expect((await provider.reconcileBackgroundTasks(parent)).filter(item => item.status === "running")).toEqual([]);
      await provider.backgroundBlockingWork(parent);
      let rows = await provider.reconcileBackgroundTasks(parent, { fresh: true });
      for (let attempt = 0; attempt < 100 && rows.some(row => row.stateUncertain); attempt++) {
        await Bun.sleep(1); rows = await provider.reconcileBackgroundTasks(parent, { fresh: true });
      }
      expect(rows).toEqual([expect.objectContaining({ taskId: worker.taskId, childConversationId: worker.childId, stateUncertain: false })]);
      await adapter.history(parent);
      expect(workerSummary(compactWorkers(adapter.projectionForTests(parent).items()))).toBe("1 working");
      await provider.stopTask(parent, worker.taskId);
      expect(fake.state().sessions[parent]?.running).toBe(true);
      expect(fake.state().calls.filter(call => call.startsWith(`POST /api/session/${worker.childId}/interrupt?`))).toHaveLength(1);
    } finally {
      await adapter.dispose(); await pump.catch(error => { expect(String(error)).toMatch(/aborted/i); }); await fake.stop();
    }
  });

  test("history overtaking child creation and first start stays pending until the exact live occurrence binds", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined, sequence = 0;
    const frame = (type: string, data: unknown, created: number) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `bootstrap-${++sequence}`, type, data, created, location: { directory: WORKSPACE } })}\n\n`));
    const send = (type: string, data: unknown, created: number) => new Promise<void>(resolve => { acknowledge = resolve; frame(type, data, created); });
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}, 1); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), lifetime = new AbortController();
    const pump = (async () => { for await (const event of provider.events(lifetime.signal)) if (event.eventType !== "server.connected") { const done = acknowledge; acknowledge = undefined; done?.(); } })();
    try {
      await provider.waitForEventStream(lifetime.signal);
      await send("session.created", { sessionID: "ses_parent", location: { directory: WORKSPACE } }, 2);
      await send("session.execution.started", { sessionID: "ses_parent" }, 3);
      await send("session.created", { sessionID: "ses_child", parentID: "ses_parent", location: { directory: WORKSPACE } }, 10);
      expect(await provider.reconcileBackgroundTasks("ses_parent")).toEqual([expect.objectContaining({ stateUncertain: true })]);
      await send("session.execution.started", { sessionID: "ses_child" }, 21);
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toEqual([expect.objectContaining({ stateUncertain: true })]);
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content }, 30);
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toEqual([expect.objectContaining({ stateUncertain: false })]);
      await provider.stopTask("ses_parent", "v2:ses_parent:call_worker");
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(1);
      await send("session.execution.started", { sessionID: "ses_child" }, 40);
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toThrow(/no longer/);
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toEqual([expect.objectContaining({ stateUncertain: true })]);
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(1);
    } finally { lifetime.abort(); await pump; await provider.dispose(); }
  });

  for (const order of ["live", "cold-history"] as const) test(`native bootstrap ${order} preserves three working rows and confined Stops`, async () => {
    const { fake, provider, adapter } = nativeBackgroundStack();
    let pump: Promise<void> | undefined;
    try {
      let parent: string;
      if (order === "live") {
        pump = adapter.startEventPump(); void pump.catch(() => undefined);
        await provider.waitForEventStream(new AbortController().signal);
        parent = (await adapter.createConversation()).conversation.id;
        await adapter.prompt(parent, "fixture-prompt", "Start fixture work");
        await adapter.history(parent);
      } else {
        parent = (await provider.createSession("ignored")).id;
        await provider.prompt(parent, { id: "fixture-prompt", text: "Start fixture work", delivery: "queue" });
      }
      const shell = fake.launchShell(parent, true), first = fake.launchWorker(parent, true), active = fake.launchWorker(parent, true);
      if (order === "cold-history") { pump = adapter.startEventPump(); void pump.catch(() => undefined); await provider.waitForEventStream(new AbortController().signal); }
      let summary = "";
      for (let attempt = 0; attempt < 100; attempt++) {
        await adapter.history(parent);
        summary = workerSummary(compactWorkers(adapter.projectionForTests(parent).items()));
        if (summary === "3 working") break;
        await Bun.sleep(1);
      }
      expect(summary).toBe("3 working");
      fake.settleWorker(first.childId, "completed", "Safe native report");
      await adapter.history(parent);
      expect(workerSummary(compactWorkers(adapter.projectionForTests(parent).items()))).toBe("2 working · 1 finished");
      // Working is no longer a Stop-readiness signal. Wait for this separate
      // native control cohort rather than making activity depend on its ledger.
      let controllable = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await provider.reconcileBackgroundTasks(parent, { fresh: true });
        controllable = [active.taskId, shell.taskId].every(id => rows.find(row => row.taskId === id)?.control?.available === true);
        if (controllable) break;
        await Bun.sleep(1);
      }
      expect(controllable).toBe(true);
      await provider.stopTask(parent, active.taskId);
      await provider.stopTask(parent, shell.taskId);
      expect(fake.state().sessions[parent]?.running).toBe(true);
      expect(fake.state().calls.filter(call => call.startsWith(`POST /api/session/${active.childId}/interrupt?`))).toHaveLength(1);
      expect(fake.state().calls.filter(call => call.startsWith(`DELETE /api/shell/${shell.shellId}?`))).toHaveLength(1);
      expect(fake.state().unhandled).toEqual([]);
    } finally {
      await adapter.dispose();
      await pump?.catch(error => { expect(String(error)).toMatch(/aborted/i); });
      await fake.stop();
    }
  });
});

describe("OpenCode 2.x provider: identity and catalogs", () => {
  test("event readiness requires a consumed native handshake in the current generation", async () => {
    let push!: ReadableStreamDefaultController<Uint8Array>, opened!: () => void, heartbeat!: () => void;
    let opening = new Promise<void>(resolve => { opened = resolve; });
    const frame = (type: string) => push.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data: {} })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { push = controller; opened(); } }), { headers: { "content-type": "text/event-stream" } }),
    });
    const provider = server.provider();
    const lifetime = new AbortController();
    // A readiness read never creates a stream itself.
    await expect(provider.waitForEventStream(lifetime.signal)).rejects.toThrow("unavailable");
    expect(server.calls).toHaveLength(0);
    let controller = new AbortController();
    const consume = () => (async () => { for await (const event of provider.events(controller.signal)) if (event.eventType === "server.heartbeat") heartbeat(); })();
    let pump = consume();
    try {
      await opening;
      let ready = false;
      const waiting = provider.waitForEventStream(lifetime.signal).then(() => { ready = true; });
      const observed = new Promise<void>(resolve => { heartbeat = resolve; });
      frame("server.heartbeat");
      await observed;
      expect(ready).toBe(false);
      frame("server.connected");
      await waiting;
      expect(ready).toBe(true);
      await provider.waitForEventStream(lifetime.signal);
      controller.abort();
      // Even before generator cleanup, an aborted generation is not ready.
      await expect(provider.waitForEventStream(lifetime.signal)).rejects.toThrow("unavailable");
      await pump;
      opening = new Promise<void>(resolve => { opened = resolve; });
      controller = new AbortController();
      pump = consume();
      await opening;
      const cancelled = new AbortController();
      const aborted = provider.waitForEventStream(cancelled.signal).catch(error => error);
      cancelled.abort();
      expect(await aborted).toBeInstanceOf(Error);
      const ended = provider.waitForEventStream(lifetime.signal).catch(error => error);
      push.close();
      expect(await ended).toBeInstanceOf(Error);
      await pump;
      expect(server.requests("GET", "/api/event")).toHaveLength(2);
    } finally { controller.abort(); await pump; await provider.dispose(); }
  });

  test("side generation uses the native isolated endpoint, never prompt/interrupt/background", async () => {
    const server = fakeOpenCode({
      "POST /api/session/ses/generate": call => {
        expect(call.body).toEqual({ prompt: "Side question" });
        return { data: { text: "Side answer" } };
      },
    });
    expect(await server.provider().generate("ses", "Side question")).toBe("Side answer");
    expect(server.calls.map(call => `${call.method} ${call.path}`)).toEqual(["POST /api/session/ses/generate"]);
  });
  test("declares the capabilities the 2.x stack backs", () => {
    const { provider } = fakeOpenCode({});
    expect(provider().describe()).toMatchObject({ id: "opencode", name: "OpenCode" });
    expect(provider().describe().capabilities).toEqual(["modes", "models", "commands", "questions", "permissions", "subagents", "variants", "context", "conversation-rename", "attachments", "reversible-history", "steering", "send-now", "background-tasks", "background-blocking-work", "side-generation"]);
    expect(provider().describe().permissionScopeNote).toContain("until OpenCode restarts");
  });

  test("every catalog call is scoped to the workspace directory and authenticated", async () => {
    const server = fakeOpenCode({
      "GET /api/command": () => scoped([{ name: "review", description: "review changes" }, { name: "bad name" }, { name: "review" }]),
      // 2.x keeps skills apart from commands: listed under their id, a
      // config command's name wins, and so does a skill's over a built-in.
      "GET /api/skill": () => scoped([
        skillInfo("openspec-apply-change", { description: "Apply a change" }),
        skillInfo("review", { description: "shadowed by the config command" }),
        skillInfo("pdf", { name: "PDF tools", description: "Work with PDFs" }),
        skillInfo("compact", { description: "shadows the built-in" }),
        skillInfo("bad id"),
      ]),
      "GET /api/agent": () => scoped([
        { id: "build", name: "Build", description: "The default agent", mode: "primary", hidden: false },
        { id: "plan", name: "Plan", description: "Plans", mode: "primary", hidden: false },
        { id: "title", name: "Title", mode: "primary", hidden: true },
        { id: "explore", name: "Explore", mode: "subagent", hidden: false },
      ]),
    });
    const provider = server.provider();
    expect(await provider.listCommands()).toEqual([
      { name: "review", description: "review changes", argumentHint: "", kind: "command" },
      { name: "openspec-apply-change", description: "Apply a change", argumentHint: "", kind: "skill" },
      { name: "pdf", description: "PDF tools — Work with PDFs", argumentHint: "", kind: "skill" },
      { name: "compact", description: "shadows the built-in", argumentHint: "", kind: "skill" },
      { name: "reload", description: "Reload OpenCode's configuration for this workspace", argumentHint: "", kind: "command" },
    ]);
    expect(await provider.listModes()).toEqual([
      { name: "build", description: "The default agent" },
      { name: "plan", description: "Plans" },
    ]);
    for (const call of server.calls) {
      expect(call.path.startsWith("/api/")).toBe(true);
      expect(call.headers.get("authorization")).toBe(AUTH);
      expect(call.query.get("location[directory]")).toBe(WORKSPACE);
    }
  });

  test("models carry provider names, variants, context limits, and image input", async () => {
    const { provider } = fakeOpenCode({
      "GET /api/model": () => scoped([
        { id: "flash", modelID: "flash", providerID: "opencode", name: "Flash", capabilities: { tools: true, input: ["text", "image"], output: ["text"] }, variants: [], limit: { context: 200000, output: 32000 }, status: "active", enabled: true, cost: [], time: { released: 0 } },
        { id: "think", modelID: "think", providerID: "berget", name: "Thinker", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [{ id: "high" }, { id: "low" }], limit: { context: 128000, output: 8000 }, status: "active", enabled: true, cost: [], time: { released: 0 } },
        { id: "old", modelID: "old", providerID: "berget", name: "Old", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [], limit: { context: 8000, output: 800 }, status: "deprecated", enabled: true, cost: [], time: { released: 0 } },
        { id: "off", modelID: "off", providerID: "berget", name: "Off", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [], limit: { context: 8000, output: 800 }, status: "active", enabled: false, cost: [], time: { released: 0 } },
      ]),
      "GET /api/provider": () => scoped([{ id: "opencode", name: "OpenCode Zen", activation: "auto", package: "x" }, { id: "berget", name: "Berget", activation: "enabled", package: "y" }]),
    });
    expect(await provider().listModels()).toEqual([
      { selection: { providerId: "berget", modelId: "think" }, provider: "Berget", name: "Thinker", variants: ["high", "low"], contextLimit: 128000, contextWindow: { source: "catalog", freshness: "current" } },
      { selection: { providerId: "opencode", modelId: "flash" }, provider: "OpenCode Zen", name: "Flash", contextLimit: 200000, contextWindow: { source: "catalog", freshness: "current" }, imageInput: true },
    ]);
  });

  test("a new conversation takes the build agent and its model, else the server default", async () => {
    const withAgentModel = fakeOpenCode({
      "GET /api/model/default": () => scoped({ id: "flash", modelID: "flash", providerID: "opencode" }),
      "GET /api/agent": () => scoped([{ id: "build", name: "Build", mode: "primary", hidden: false, model: { id: "think", providerID: "berget" } }]),
    });
    expect(await withAgentModel.provider().newConversationConfiguration()).toEqual({ model: { providerId: "berget", modelId: "think" }, mode: "build" });

    const fallback = fakeOpenCode({
      "GET /api/model/default": () => scoped({ id: "flash", modelID: "flash", providerID: "opencode" }),
      "GET /api/agent": () => scoped([{ id: "plan", name: "Plan", mode: "primary", hidden: false }]),
    });
    expect(await fallback.provider().newConversationConfiguration()).toEqual({ model: { providerId: "opencode", modelId: "flash" }, mode: "plan" });
  });
});

describe("OpenCode 2.x provider: sessions", () => {
  test("repeated child references reuse verified parentage without dropping unrelated streamed text", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const frames = [{ type: "server.connected", data: {} }, ...[1, 2, 3].map(index => ({
      type: "session.message.content.updated", location: { directory: WORKSPACE }, created: index,
      data: { sessionID: "ses_parent", messageID: `answer${index}`, content: [{ type: "text", id: `text${index}`, text: `Answer ${index}` }, ...fixture.launch.content] },
    }))];
    let lookups = 0;
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_child": () => ++lookups === 3 ? new Response(null, { status: 500 }) : session("ses_child", { parentID: "ses_parent" }),
    });
    const provider = server.provider();
    try {
      const events = [];
      for await (const event of provider.events(new AbortController().signal)) events.push(event);
      expect(events.slice(1)).toHaveLength(3);
      for (const [index, event] of events.slice(1).entries()) {
        expect(event).toMatchObject({ conversationId: "ses_parent", eventType: "session.message.content.updated", outcome: "handled" });
        expect(event.updates).toContainEqual(expect.objectContaining({ kind: "text", text: `Answer ${index + 1}` }));
      }
      expect(lookups).toBe(1);
    } finally { await provider.dispose(); }
  });
  test("a failed child lookup preserves the frame and retries ownership on the next frame", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let reads = 0;
    const frames = ["server.connected", ...Array(2).fill("session.message.content.updated")].map((type, index) => ({
      type, location: { directory: WORKSPACE }, created: index,
      data: index ? { sessionID: "ses_parent", messageID: `answer${index}`, content: [{ type: "text", text: `Answer ${index}` }, ...fixture.launch.content] } : {},
    }));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_child": () => ++reads === 1 ? new Response(null, { status: 500 }) : session("ses_child", { parentID: "ses_parent" }),
    });
    const provider = server.provider();
    try {
      const events = [];
      for await (const event of provider.events(new AbortController().signal)) events.push(event);
      for (const [index, event] of events.slice(1).entries()) {
        expect(event).toMatchObject({ conversationId: "ses_parent", eventType: "session.message.content.updated" });
        expect(event.updates).toContainEqual(expect.objectContaining({ kind: "text", text: `Answer ${index + 1}` }));
      }
      expect(events[1]!.updates.some(update => update.kind === "upsert" && update.item.type === "background_task")).toBe(false);
      expect(events[2]!.updates).toContainEqual(expect.objectContaining({ kind: "upsert", item: expect.objectContaining({ type: "background_task" }) }));
      expect(reads).toBe(2);
    } finally { await provider.dispose(); }
  });
  for (const abort of [false, true]) test(`hung child verification has a batch deadline, bounded fanout, and stream cancellation (${abort ? "abort" : "deadline"})`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const content = Array.from({ length: 12 }, (_, index) => {
      const part = structuredClone(fixture.launch.content[0]);
      part.id = `call${index}`;
      part.state.metadata.sessionID = `child${index}`;
      return part;
    });
    let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    const frame = { type: "session.message.content.updated", location: { directory: WORKSPACE }, data: { sessionID: "ses_parent", messageID: "answer", content: [{ type: "text", text: "Still readable" }, ...content, ...content] } };
    const frames = [{ type: "server.connected", data: {} }, frame, { type: "session.text.delta", data: { sessionID: "other", messageID: "other-answer", id: "other-text", delta: "Other conversation" } }];
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }),
      // Deliberately ignore cancellation to cover transports that never settle.
      "GET /api/session/:id": () => { reading(); return new Promise(() => {}); },
    });
    const provider = server.provider();
    const controller = new AbortController();
    const events: Array<{ eventType: string; conversationId?: string; updates: unknown[] }> = [];
    const pump = (async () => { for await (const event of provider.events(controller.signal)) events.push(event); })();
    try {
      await started;
      if (abort) controller.abort();
      await pump;
      const children = server.calls.filter(call => call.path.startsWith("/api/session/"));
      expect(children).toHaveLength(4);
      expect(children.every(call => call.signal.aborted)).toBe(true);
      if (abort) expect(events.map(event => event.eventType)).toEqual(["server.connected"]);
      else {
        expect(events[1]).toMatchObject({ conversationId: "ses_parent", eventType: frame.type });
        expect(events[1]!.updates).toContainEqual(expect.objectContaining({ kind: "text", text: "Still readable" }));
        expect(events[2]).toMatchObject({ conversationId: "other", eventType: "session.text.delta" });
      }
    } finally { controller.abort(); await pump; await provider.dispose(); }
  }, 5_000);
  test("underlying child lookup slots remain bounded across timed-out frames, history reads, reconnect, and late settlement", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let stream!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined;
    let outstanding = 0, peak = 0, hanging = true;
    const held: Array<{ release: () => void; settled: Promise<void> }> = [];
    const frame = (type: string, data: unknown) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, location: { directory: WORKSPACE }, created: 30 })}\n\n`));
    const launch = (child: string) => {
      const part = structuredClone(fixture.launch.content[0]);
      part.id = `call_${child}`; part.state.metadata.sessionID = child;
      return part;
    };
    const send = (children: string[], text: string) => new Promise<void>(resolve => {
      acknowledge = resolve;
      frame("session.message.content.updated", { sessionID: "ses_parent", messageID: text, content: [{ type: "text", text }, ...children.map(launch)] });
    });
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_parent/message": () => ({ data: [{ ...fixture.launch, content: [launch("history_child")] }], cursor: {} }),
      "GET /api/session/:id": async ({ path }) => {
        outstanding++; peak = Math.max(peak, outstanding);
        try {
          if (hanging) {
            let release!: () => void, settled!: () => void;
            const gate = new Promise<void>(resolve => { release = resolve; });
            held.push({ release, settled: new Promise<void>(resolve => { settled = resolve; }) });
            // This transport ignores cancellation; only actual settlement frees it.
            try { await gate; } finally { settled(); }
          }
          return session(path.split("/").at(-1)!, { parentID: "ses_parent" });
        } finally { outstanding--; }
      },
    });
    const provider = server.provider();
    let controller = new AbortController();
    const events: Array<{ updates: unknown[] }> = [];
    const consume = () => (async () => { for await (const event of provider.events(controller.signal)) {
      events.push(event);
      if (event.eventType === "session.message.content.updated") { acknowledge?.(); acknowledge = undefined; }
    } })();
    let pump = consume();
    const childCalls = () => server.calls.filter(call => call.path.startsWith("/api/session/") && call.path !== "/api/session/ses_parent" && !call.path.endsWith("/message"));
    try {
      await provider.waitForEventStream(controller.signal);
      const counts = [];
      for (let batch = 0; batch < 3; batch++) {
        await send(Array.from({ length: 4 }, (_, index) => `child${batch}_${index}`), `Text ${batch}`);
        counts.push(outstanding);
      }
      expect(counts).toEqual([4, 4, 4]);
      expect(childCalls()).toHaveLength(4);
      for (let batch = 0; batch < 3; batch++) expect(events.flatMap(event => event.updates)).toContainEqual(expect.objectContaining({ kind: "text", text: `Text ${batch}` }));
      await expect(provider.listMessages("ses_parent", { limit: 1 })).rejects.toThrow("capacity");
      expect(childCalls()).toHaveLength(4);
      controller.abort(); await pump;
      controller = new AbortController(); pump = consume();
      await provider.waitForEventStream(controller.signal);
      await send(["child_after_reconnect"], "Still readable after reconnect");
      expect(childCalls()).toHaveLength(4);
      hanging = false;
      held[0]!.release(); await held[0]!.settled;
      // Retry read-only frames until the actual SDK promise (including response
      // decoding) settles, not merely the fake handler's gate.
      const deadline = Date.now() + 2_000;
      while (childCalls().length === 4 && Date.now() < deadline) {
        await send(["child0_0"], "Fresh retry");
        if (childCalls().length === 4) await Bun.sleep(0);
      }
      expect(childCalls()).toHaveLength(5);
      expect(server.requests("GET", "/api/session/child0_0")).toHaveLength(2);
      expect(events.flatMap(event => event.updates)).toContainEqual(expect.objectContaining({ kind: "upsert", item: expect.objectContaining({ type: "background_task", childConversationId: "child0_0" }) }));
      expect(peak).toBe(4);
      expect(outstanding).toBe(3);
      controller.abort(); await pump; await provider.dispose();
      const count = events.length;
      held.forEach(read => read.release()); await Promise.all(held.map(read => read.settled));
      await expect(provider.listMessages("ses_parent", { limit: 1 })).rejects.toThrow();
      expect(events).toHaveLength(count);
      expect(childCalls()).toHaveLength(5);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { controller.abort(); held.forEach(read => read.release()); await pump; await provider.dispose(); }
  }, 10_000);
  test("paged and staged-revert folds reuse only parentage while refreshing cost and visible worker state", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let boundary: string | undefined;
    let cost = 1;
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`));
      } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent": () => session("ses_parent", { cost, ...(boundary ? { revert: { messageID: boundary } } : {}) }),
      "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent" }),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch, fixture.stored], cursor: {} }),
    });
    const provider = server.provider();
    const controller = new AbortController();
    const events = provider.events(controller.signal)[Symbol.asyncIterator]();
    try {
      await events.next();
      const first = await provider.listMessages("ses_parent", { limit: 1 });
      expect(first.completeItems).toContainEqual(expect.objectContaining({ type: "background_task", status: "completed" }));
      expect(first.sessionCostUsd).toBe(1);
      await provider.listMessages("ses_parent", { limit: 1, cursor: first.nextCursor });
      cost = 2;
      boundary = fixture.stored.id;
      for (let index = 0; index < 3; index++) {
        const staged = await provider.listMessages("ses_parent", { limit: 1 });
        expect(staged.completeItems).toContainEqual(expect.objectContaining({ type: "background_task", status: "running" }));
        expect(staged.completeItems?.some(item => item.type === "background_task" && item.status === "completed")).toBe(false);
        expect(staged.sessionCostUsd).toBe(2);
        expect(staged.revertVisibility?.boundaryId).toBe(boundary);
      }
      expect(server.requests("GET", "/api/session/ses_parent")).toHaveLength(5);
      expect(server.requests("GET", "/api/session/ses_child")).toHaveLength(1);
      expect(server.requests("GET", "/api/session/ses_parent/message")).toHaveLength(1);
    } finally { controller.abort(); await events.return?.(); await provider.dispose(); }
  });
  test("moved and deleted session events retire cached ownership, including foreign-location events", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const launch = { type: "session.message.content.updated", location: { directory: WORKSPACE }, data: { sessionID: "ses_parent", messageID: "answer", content: fixture.launch.content } };
    const frames = [
      { type: "server.connected", data: {} }, launch,
      { type: "session.moved", location: { directory: "/other" }, data: { sessionID: "ses_child", location: { directory: "/other" } } }, launch,
      { type: "session.deleted", data: { sessionID: "ses_child" } }, launch,
    ];
    let reads = 0;
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_child": () => ++reads === 3 ? notFound("ses_child") : session("ses_child", { parentID: "ses_parent", location: { directory: reads === 1 ? WORKSPACE : "/other" } }),
    });
    const provider = server.provider();
    try {
      const launches = [];
      for await (const event of provider.events(new AbortController().signal)) {
        if (event.eventType === launch.type) launches.push(event);
      }
      expect(launches.map(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task"))).toEqual([true, false, false]);
      expect(reads).toBe(3);
    } finally { await provider.dispose(); }
  });
  for (const lifecycle of ["session.moved", "session.deleted", "session.updated", "location.shutdown"]) test(`unrelated foreign ${lifecycle} preserves terminal worker occurrences and notice tombstones`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const launch = { type: "session.message.content.updated", location: { directory: WORKSPACE }, created: 30, data: { sessionID: "ses_parent", messageID: "answer", content: fixture.launch.content } };
    const report = { type: "session.inbox.enqueued", location: { directory: WORKSPACE }, created: 41, data: { sessionID: "ses_parent", inboxID: fixture.pending.id, item: fixture.pending } };
    const frames = [
      { type: "server.connected", data: {} }, launch, report,
      { type: lifecycle, location: { directory: "/other" }, data: { sessionID: "unrelated_foreign", location: { directory: "/other" } } },
      { ...launch, created: 43 }, { ...report, created: 44 },
    ];
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent" }),
    });
    const provider = server.provider();
    try {
      const observed = [];
      for await (const event of provider.events(new AbortController().signal)) {
        observed.push(event.updates.flatMap(update => update.kind === "upsert" && update.item.type === "background_task" ? [{ status: update.item.status, resultId: update.item.resultId }] : []));
      }
      expect(observed).toEqual([[], [{ status: "running", resultId: undefined }], [{ status: "completed", resultId: fixture.pending.id }], [], [{ status: "completed", resultId: fixture.pending.id }], []]);
      expect(server.requests("GET", "/api/event")).toHaveLength(1);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { await provider.dispose(); }
  });
  test("lifecycle invalidation cannot leave a saturated worker stream's recovery-only mode", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const launch = { type: "session.message.content.updated", location: { directory: WORKSPACE }, created: 30, data: { sessionID: "ses_parent", messageID: "answer", content: fixture.launch.content } };
    const frames: unknown[] = Array.from({ length: 2200 }, (_, index) => ({ type: "session.created", location: { directory: WORKSPACE }, data: { sessionID: `filler${index}`.padEnd(500, "x"), parentID: "p".repeat(500) } }));
    frames.push({ type: "server.connected", data: {} }, launch,
      { type: "session.moved", location: { directory: "/other" }, data: { sessionID: "unrelated_foreign", location: { directory: "/other" } } }, launch,
      { type: "session.moved", location: { directory: WORKSPACE }, data: { sessionID: "ses_child", location: { directory: WORKSPACE } } }, launch);
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent" }),
    });
    const provider = server.provider();
    try {
      const observed = [];
      for await (const event of provider.events(new AbortController().signal)) {
        if (event.eventType === launch.type) observed.push(event.updates.filter(update => update.kind === "upsert" && update.item.type === "background_task"));
      }
      expect(observed).toEqual([[], [], []]);
      expect(server.requests("GET", "/api/event")).toHaveLength(1);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { await provider.dispose(); }
  });
  for (const foreign of [false, true]) test(`history never caches unverified child ownership (${foreign ? "foreign workspace" : "wrong parent"})`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n')); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_child": () => session("ses_child", { parentID: foreign ? "ses_parent" : "other", location: { directory: foreign ? "/other" : WORKSPACE } }),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch, fixture.stored], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
    });
    const provider = server.provider();
    const controller = new AbortController();
    const events = provider.events(controller.signal)[Symbol.asyncIterator]();
    try {
      await events.next();
      for (let index = 0; index < 2; index++) {
        expect((await provider.listMessages("ses_parent", { limit: 1 })).completeItems?.some(item => item.type === "background_task")).toBe(false);
        expect(await provider.reconcileBackgroundTasks("ses_parent")).toEqual([]);
      }
      expect(server.requests("GET", "/api/session/ses_child")).toHaveLength(4);
      expect(server.requests("GET", "/api/session/ses_child/message")).toHaveLength(0);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { controller.abort(); await events.return?.(); await provider.dispose(); }
  });
  test("failed recovery ownership reads stay unknown and retry rather than caching an empty inventory", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let reads = 0, active = true;
    const server = fakeOpenCode({
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_child": () => ++reads === 1 ? new Response(null, { status: 500 }) : session("ses_child", { parentID: "ses_parent" }),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => active ? { ses_child: { status: "running" } } : {},
    });
    const provider = server.provider();
    try {
      await expect(provider.reconcileBackgroundTasks("ses_parent")).rejects.toThrow("lookup failed");
      expect(await provider.reconcileBackgroundTasks("ses_parent")).toContainEqual(expect.objectContaining({ type: "background_task", status: "running", stateUncertain: false }));
      active = false;
      expect(await provider.reconcileBackgroundTasks("ses_parent")).toContainEqual(expect.objectContaining({ type: "background_task", status: "running", stateUncertain: true }));
      expect(server.requests("GET", "/api/session/active")).toHaveLength(3);
    } finally { await provider.dispose(); }
  });
  for (const path of ["/api/shell/sh_fixture", "/api/session/active", "/api/session/ses_child/message"]) {
    test(`partial first live inventory recovers after ${path} succeeds without another launcher frame`, async () => {
      const server = workerRecoveryServer(), provider = server.provider(), stream = observedNativeStream(provider);
      const failedType = path.includes("/shell/") ? "shell" : "agent";
      try {
        await stream.seen(event => event.eventType === "server.connected"); server.state.failure = path;
        const initial = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
        expect(initial.find(task => task.taskType === failedType)).toMatchObject({ status: "running", stateUncertain: true });
        expect(initial.find(task => task.taskType !== failedType)).toMatchObject({ status: "running", stateUncertain: false });
        server.state.failure = "";
        for (let retry = 0; retry < 3; retry++) {
          const recovered = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
          expect(recovered).toHaveLength(2);
          expect(recovered.every(task => task.status === "running" && task.stateUncertain === false)).toBe(true);
          expect(compactWorkers(recovered).every(worker => worker.state === "working")).toBe(true);
        }
        await provider.stopTask("ses_parent", failedType === "shell" ? "v2:ses_parent:call_shell" : "v2:ses_parent:call_worker");
        expect(server.calls.filter(call => call.method !== "GET").map(call => `${call.method} ${call.path}`)).toEqual([
          failedType === "shell" ? "DELETE /api/shell/sh_fixture" : "POST /api/session/ses_child/interrupt",
        ]);
      } finally { stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose(); }
    });
  }

  test("partial first live transcript history does not consume recovery's initial inventory", async () => {
    const server = workerRecoveryServer(), provider = server.provider(), stream = observedNativeStream(provider);
    try {
      await stream.seen(event => event.eventType === "server.connected"); server.state.failure = "/api/session/ses_child/message";
      const page = await provider.listMessages("ses_parent", { limit: 100 });
      expect(page.completeItems).toContainEqual(expect.objectContaining({ type: "background_task", taskType: "agent", stateUncertain: true }));
      server.state.failure = "";
      for (let retry = 0; retry < 3; retry++) expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).every(task => task.stateUncertain === false)).toBe(true);
    } finally { stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose(); }
  });

  for (const removed of [true, false]) test(`failed first shell inventory cannot be replaced by transcript proof for a ${removed ? "removed" : "running"} target`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let failure = true, gone = false;
    const healthy = structuredClone(fixture.shell);
    healthy.id = "healthy_shell_message";
    healthy.content[0].id = "healthy_shell";
    healthy.content[0].state.metadata.shellID = "sh_healthy";
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch, fixture.shell, healthy], cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/shell/:id": ({ path }) => path.endsWith("sh_fixture") && failure ? new Response(null, { status: 500 })
        : path.endsWith("sh_fixture") && gone ? new Response(null, { status: 404 })
          : scoped({ id: path.split("/").at(-1), command: "printf fixture", status: "running", time: { started: 71 }, metadata: { sessionID: "ses_parent" } }),
    });
    const provider = server.provider(), stream = observedNativeStream(provider);
    const controls = (provider as unknown as { controls: { current(taskId: string): boolean } }).controls;
    try {
      await stream.seen(event => event.eventType === "server.connected");
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ toolUseId: "call_shell", stateUncertain: true }));
      expect(controls.current("v2:ses_parent:call_shell")).toBe(false);
      failure = false; gone = removed;
      const reads = server.requests("GET", "/api/shell/sh_fixture").length;
      for (let retry = 0; retry < 2; retry++) {
        const page = await provider.listMessages("ses_parent", { limit: 100 });
        expect(page.completeItems).toContainEqual(expect.objectContaining({ toolUseId: "call_shell", status: "running", stateUncertain: true }));
        expect(controls.current("v2:ses_parent:call_shell")).toBe(false);
        for (const call of ["call_worker", "healthy_shell"]) {
          expect(page.completeItems).toContainEqual(expect.objectContaining({ toolUseId: call, status: "running", stateUncertain: false }));
          expect(controls.current(`v2:ses_parent:${call}`)).toBe(true);
        }
      }
      expect(server.requests("GET", "/api/shell/sh_fixture")).toHaveLength(reads);
      const recovered = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(recovered.find(task => task.toolUseId === "call_shell")).toMatchObject({ status: "running", stateUncertain: removed });
      expect(controls.current("v2:ses_parent:call_shell")).toBe(!removed);
      expect(server.requests("GET", "/api/shell/sh_fixture")).toHaveLength(reads + 1);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose(); }
  });

  for (const target of ["removed", "running", "foreign"] as const) test(`sixteen held reads cannot let transcript proof replace rejected inventory for a ${target} shell`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const healthy = structuredClone(fixture.shell);
    healthy.id = "healthy_message"; healthy.content[0].id = "healthy_call"; healthy.content[0].state.metadata.shellID = "sh_healthy";
    let failure = true, held = 0, wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
        wire = controller; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.shell, healthy], cursor: {} }),
      "GET /api/session/:id/message": async () => { if (++held === 16) entered(); await gate; return { data: [], cursor: {} }; },
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({}),
      "GET /api/shell/:id": ({ path }) => path.endsWith("sh_fixture") && failure ? new Response(null, { status: 500 })
        : path.endsWith("sh_fixture") && target === "removed" ? new Response(null, { status: 404 })
          : scoped({ id: path.split("/").at(-1), command: "printf fixture", status: "running", time: { started: 71 },
            metadata: { sessionID: path.endsWith("sh_fixture") && target === "foreign" ? "other_parent" : "ses_parent" } }),
    });
    const provider = server.provider(), stream = observedNativeStream(provider), blockers: ReturnType<typeof provider.listMessages>[] = [];
    const controls = (provider as unknown as { controls: { current(taskId: string): boolean; activeReads: number } }).controls;
    try {
      await stream.seen(event => event.eventType === "server.connected");
      // Seed only the healthy sibling through native live evidence, leaving
      // initial inventory open for the previously unobserved target.
      wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "healthy_launch", created: 81, type: "session.message.content.updated",
        location: { directory: WORKSPACE }, data: { sessionID: "ses_parent", messageID: healthy.id, content: healthy.content } })}\n\n`));
      await stream.seen(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task" && update.item.toolUseId === "healthy_call"));
      expect(controls.current("v2:ses_parent:healthy_call")).toBe(true);
      for (let index = 0; index < 16; index++) blockers.push(provider.listMessages(`ses_block_${index}`, { limit: 1 }));
      await started; expect(controls.activeReads).toBe(16);
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ toolUseId: "call_shell", stateUncertain: true }));
      expect(controls.current("v2:ses_parent:call_shell")).toBe(false);
      expect(controls.current("v2:ses_parent:healthy_call")).toBe(true);
      release(); await Promise.all(blockers); failure = false;
      const reads = server.requests("GET", "/api/shell/sh_fixture").length;
      for (let retry = 0; retry < 2; retry++) {
        const page = await provider.listMessages("ses_parent", { limit: 100 });
        expect(page.completeItems).toContainEqual(expect.objectContaining({ toolUseId: "call_shell", status: "running", stateUncertain: true }));
        expect(page.completeItems).toContainEqual(expect.objectContaining({ toolUseId: "healthy_call", status: "running", stateUncertain: false }));
        expect(controls.current("v2:ses_parent:call_shell")).toBe(false);
        expect(controls.current("v2:ses_parent:healthy_call")).toBe(true);
      }
      expect(server.requests("GET", "/api/shell/sh_fixture")).toHaveLength(reads);
      const fresh = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(fresh.find(task => task.toolUseId === "call_shell")).toMatchObject({ status: "running", stateUncertain: target !== "running" });
      expect(fresh.find(task => task.toolUseId === "healthy_call")).toMatchObject({ status: "running", stateUncertain: false });
      expect(controls.current("v2:ses_parent:call_shell")).toBe(target === "running");
      expect(server.requests("GET", "/api/shell/sh_fixture")).toHaveLength(reads + 1);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { release(); await Promise.allSettled(blockers); stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose(); }
  });

  for (const target of ["removed", "running", "foreign"] as const) test(`older in-flight transcript respects a newer ${target} shell inventory`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const healthy = structuredClone(fixture.shell);
    healthy.id = "healthy_message"; healthy.content[0].id = "healthy_call"; healthy.content[0].state.metadata.shellID = "sh_healthy";
    let failure = true, held = 0, holdParent = true, wire!: ReadableStreamDefaultController<Uint8Array>;
    let entered!: () => void, release!: () => void, parentEntered!: () => void, releaseParent!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const parentStarted = new Promise<void>(resolve => { parentEntered = resolve; }), parentGate = new Promise<void>(resolve => { releaseParent = resolve; });
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
        wire = controller; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!),
      "GET /api/session/ses_parent/message": async () => {
        if (holdParent) { holdParent = false; parentEntered(); await parentGate; }
        return { data: [fixture.shell, healthy], cursor: {} };
      },
      "GET /api/session/:id/message": async () => { if (++held === 15) entered(); await gate; return { data: [], cursor: {} }; },
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({}),
      "GET /api/shell/:id": ({ path }) => path.endsWith("sh_fixture") && failure ? new Response(null, { status: 500 })
        : path.endsWith("sh_fixture") && target === "removed" ? new Response(null, { status: 404 })
          : scoped({ id: path.split("/").at(-1), command: "printf fixture", status: "running", time: { started: 71 },
            metadata: { sessionID: path.endsWith("sh_fixture") && target === "foreign" ? "other_parent" : "ses_parent" } }),
    });
    const provider = server.provider(), stream = observedNativeStream(provider), blockers: ReturnType<typeof provider.listMessages>[] = [];
    const controls = (provider as unknown as { controls: { current(taskId: string): boolean; activeReads: number } }).controls;
    let older: ReturnType<typeof provider.listMessages> | undefined;
    try {
      await stream.seen(event => event.eventType === "server.connected");
      wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "healthy_launch", created: 81, type: "session.message.content.updated",
        location: { directory: WORKSPACE }, data: { sessionID: "ses_parent", messageID: healthy.id, content: healthy.content } })}\n\n`));
      await stream.seen(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task" && update.item.toolUseId === "healthy_call"));
      older = provider.listMessages("ses_parent", { limit: 100 }); await parentStarted;
      for (let index = 0; index < 15; index++) blockers.push(provider.listMessages(`ses_block_${index}`, { limit: 1 }));
      await started; expect(controls.activeReads).toBe(16);
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ toolUseId: "call_shell", stateUncertain: true }));
      release(); await Promise.all(blockers); failure = false;
      // This inventory must not discharge outstanding verification merely
      // because the transport returned a shell owned by another parent.
      const fresh = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(fresh.find(task => task.toolUseId === "call_shell")).toMatchObject({ status: "running", stateUncertain: target !== "running" });
      expect(fresh.find(task => task.toolUseId === "healthy_call")).toMatchObject({ status: "running", stateUncertain: false });
      const shellReads = server.requests("GET", "/api/shell/sh_fixture").length;
      releaseParent(); const page = await older;
      expect(page.completeItems).toContainEqual(expect.objectContaining({ toolUseId: "call_shell", status: "running", stateUncertain: target !== "running" }));
      expect(page.completeItems).toContainEqual(expect.objectContaining({ toolUseId: "healthy_call", status: "running", stateUncertain: false }));
      expect(controls.current("v2:ses_parent:call_shell")).toBe(target === "running");
      expect(controls.current("v2:ses_parent:healthy_call")).toBe(true);
      expect(server.requests("GET", "/api/shell/sh_fixture")).toHaveLength(shellReads);
      if (target !== "running") await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_shell")).rejects.toThrow();
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally {
      release(); releaseParent(); await Promise.allSettled([...blockers, ...(older ? [older] : [])]);
      stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose();
    }
  });

  for (const connected of [false, true]) for (const active of [false, true]) test(`older agent transcript requires positive active inventory: ${active ? "active" : "absent"}/${connected ? "connected" : "standalone"}`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const healthy = structuredClone(fixture.launch);
    healthy.id = "healthy_message"; healthy.content[0].id = "healthy_agent"; healthy.content[0].state.metadata.sessionID = "ses_healthy";
    let includeTarget = false, holdParent = false, failActive = true, targetActive = active, entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/active": () => failActive ? new Response(null, { status: 500 })
        : { ses_healthy: { status: "running" }, ...(targetActive ? { ses_child: { status: "running" } } : {}) },
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") || path.endsWith("ses_healthy") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": async () => {
        if (holdParent) { holdParent = false; entered(); await gate; }
        return { data: [...(includeTarget ? [fixture.launch] : []), healthy, fixture.shell], cursor: {} };
      },
      "GET /api/session/:id/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/shell/sh_fixture": () => scoped({ id: "sh_fixture", command: "printf fixture", status: "running", time: { started: 71 }, metadata: { sessionID: "ses_parent" } }),
    });
    const provider = server.provider(), controls = (provider as unknown as { controls: { current(taskId: string): boolean } }).controls;
    let stream: ReturnType<typeof observedNativeStream> | undefined, older: ReturnType<typeof provider.listMessages> | undefined;
    const healthyCalls = ["healthy_agent", "call_shell"];
    try {
      // Retain both healthy kinds without closing initial live inventory.
      await provider.listMessages("ses_parent", { limit: 100 });
      for (const call of healthyCalls) expect(controls.current(`v2:ses_parent:${call}`)).toBe(true);
      if (connected) { stream = observedNativeStream(provider); await stream.seen(event => event.eventType === "server.connected"); }
      includeTarget = holdParent = true;
      older = provider.listMessages("ses_parent", { limit: 100 }); await started;
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ toolUseId: "call_worker", stateUncertain: true }));
      failActive = false;
      const fresh = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(fresh.find(task => task.toolUseId === "call_worker")).toMatchObject({ status: "running", stateUncertain: !active });
      for (const call of healthyCalls) expect(fresh.find(task => task.toolUseId === call)).toMatchObject({ status: "running", stateUncertain: false });
      const activeReads = server.requests("GET", "/api/session/active").length;
      release(); const page = await older;
      expect(page.completeItems).toContainEqual(expect.objectContaining({ toolUseId: "call_worker", status: "running", stateUncertain: !active }));
      expect(controls.current("v2:ses_parent:call_worker")).toBe(active);
      for (const call of healthyCalls) {
        expect(page.completeItems).toContainEqual(expect.objectContaining({ toolUseId: call, status: "running", stateUncertain: false }));
        expect(controls.current(`v2:ses_parent:${call}`)).toBe(true);
      }
      expect(server.requests("GET", "/api/session/active")).toHaveLength(activeReads);
      if (!active) await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toThrow();
      // Missing activity is not completion or revocation. Positive fresh
      // verification can still recover the unchanged target without a frame.
      targetActive = true;
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ toolUseId: "call_worker", status: "running", stateUncertain: false }));
      expect(controls.current("v2:ses_parent:call_worker")).toBe(true);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { release(); await older?.catch(() => undefined); stream?.lifetime.abort(); await stream?.pump.catch(() => undefined); await provider.dispose(); }
  });

  for (const negative of ["foreign-directory", "failed-history", "malformed-idle"] as const) test(`filtered or inconclusive ${negative} child evidence cannot discharge outstanding inventory`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let holdParent = true, phase: "failed-active" | "negative" | "owned" = "failed-active", entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const server = fakeOpenCode({
      "GET /api/session/active": () => phase === "failed-active" ? new Response(null, { status: 500 }) : phase === "owned" ? { ses_child: { status: "running" } } : {},
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent", location: { directory: phase === "negative" && negative === "foreign-directory" ? "/other" : WORKSPACE } }),
      "GET /api/session/ses_parent/message": async () => {
        if (holdParent) { holdParent = false; entered(); await gate; }
        return { data: [fixture.launch, fixture.shell], cursor: {} };
      },
      "GET /api/session/ses_child/message": () => phase === "negative" && negative === "failed-history" ? new Response(null, { status: 500 })
        : { data: phase === "negative" && negative === "malformed-idle" ? [{ id: "idle", type: "idle", time: {} }] : [], cursor: {} },
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/shell/sh_fixture": () => scoped({ id: "sh_fixture", command: "printf fixture", status: "running", time: { started: 71 }, metadata: { sessionID: "ses_parent" } }),
    });
    const provider = server.provider(), controls = (provider as unknown as { controls: { current(taskId: string): boolean } }).controls;
    let older: ReturnType<typeof provider.listMessages> | undefined;
    try {
      older = provider.listMessages("ses_parent", { limit: 100 }); await started;
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ toolUseId: "call_worker", stateUncertain: true }));
      phase = "negative";
      const fresh = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      if (negative === "foreign-directory") expect(fresh.some(task => task.toolUseId === "call_worker")).toBe(false);
      else expect(fresh.find(task => task.toolUseId === "call_worker")).toMatchObject({ status: "running", stateUncertain: true });
      expect(fresh.find(task => task.toolUseId === "call_shell")).toMatchObject({ status: "running", stateUncertain: false });
      // Without a subscription, a session may move out of this directory and
      // back before the older caller verifies it. Parentage and IDs stay fixed;
      // recovered ownership/history alone cannot replace pending active proof.
      phase = "owned"; release(); const page = await older;
      expect(page.completeItems).toContainEqual(expect.objectContaining({ toolUseId: "call_worker", status: "running", stateUncertain: true }));
      expect(page.completeItems).toContainEqual(expect.objectContaining({ toolUseId: "call_shell", status: "running", stateUncertain: false }));
      expect(controls.current("v2:ses_parent:call_worker")).toBe(false);
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ toolUseId: "call_worker", status: "running", stateUncertain: false }));
      expect(controls.current("v2:ses_parent:call_worker")).toBe(true);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { release(); await older?.catch(() => undefined); await provider.dispose(); }
  });

  for (const path of ["/api/shell/sh_fixture", "/api/session/active", "/api/session/ses_child/message"]) {
    test(`queued fresh mixed-worker recovery follows partial ${path} evidence`, async () => {
      const server = workerRecoveryServer(), provider = server.provider(), stream = observedNativeStream(provider), hold = server.holdNext(path);
      let first: ReturnType<typeof provider.reconcileBackgroundTasks> | undefined, next: typeof first;
      try {
        await stream.seen(event => event.eventType === "server.connected"); server.state.failure = path;
        first = provider.reconcileBackgroundTasks("ses_parent", { fresh: true }); await hold.started;
        server.state.failure = ""; next = provider.reconcileBackgroundTasks("ses_parent", { fresh: true }); hold.release();
        expect((await first).some(task => task.stateUncertain === true)).toBe(true);
        const recovered = await next;
        expect(recovered).toHaveLength(2); expect(recovered.every(task => task.stateUncertain === false)).toBe(true);
        expect(server.requests("GET", path)).toHaveLength(2);
        expect(server.calls.every(call => call.method === "GET")).toBe(true);
      } finally { hold.release(); await Promise.allSettled([first, next].filter(Boolean)); stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose(); }
    });
  }

  test("partial first live inventory stays retryable through public revert visibility filtering", async () => {
    const server = workerRecoveryServer(), provider = server.provider(), stream = observedNativeStream(provider);
    server.state.messages.push({ id: "reverted_prompt", type: "user", text: "Synthetic hidden turn", time: { created: 100 } });
    server.state.revert = "reverted_prompt";
    try {
      await stream.seen(event => event.eventType === "server.connected"); server.state.failure = "/api/session/ses_child/message";
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskType: "agent", stateUncertain: true }));
      server.state.failure = "";
      for (let retry = 0; retry < 3; retry++) {
        const recovered = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
        expect(recovered).toHaveLength(2); expect(recovered.every(task => task.stateUncertain === false)).toBe(true);
      }
    } finally { stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose(); }
  });

  test("partial first inventory cannot authorize pre-gap workers after reconnect", async () => {
    const server = workerRecoveryServer(), provider = server.provider();
    let stream = observedNativeStream(provider);
    try {
      await stream.seen(event => event.eventType === "server.connected"); server.state.failure = "/api/shell/sh_fixture";
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskType: "shell", stateUncertain: true }));
      server.disconnect(); await stream.pump;
      server.state.failure = ""; stream = observedNativeStream(provider); await stream.seen(event => event.eventType === "server.connected");
      for (let retry = 0; retry < 3; retry++) {
        const recovered = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
        expect(recovered).toHaveLength(2); expect(recovered.every(task => task.stateUncertain === true)).toBe(true);
      }
      for (const call of ["call_shell", "call_worker"]) await expect(provider.stopTask("ses_parent", `v2:ses_parent:${call}`)).rejects.toThrow(/no longer confirmed/);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose(); }
  });

  for (const kind of ["agent", "shell"] as const) test(`partial first inventory does not restore ${kind} controls after changed native ownership`, async () => {
    const server = workerRecoveryServer(), provider = server.provider(), stream = observedNativeStream(provider);
    try {
      await stream.seen(event => event.eventType === "server.connected"); server.state.failure = kind === "shell" ? "/api/shell/sh_fixture" : "/api/session/active";
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskType: kind, stateUncertain: true }));
      server.state.failure = "";
      if (kind === "agent") {
        server.state.childParent = "foreign_parent";
        server.frame("session.updated", { sessionID: "ses_child", parentID: "foreign_parent" });
        await stream.seen(event => event.eventType === "session.updated");
      } else server.state.shellParent = "foreign_parent";
      for (let retry = 0; retry < 3; retry++) {
        const recovered = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
        if (kind === "agent") expect(recovered.some(task => task.taskType === "agent")).toBe(false);
        else expect(recovered.find(task => task.taskType === "shell")).toMatchObject({ status: "running", stateUncertain: true });
        expect(recovered.find(task => task.taskType !== kind)).toMatchObject({ status: "running", stateUncertain: false });
      }
      await expect(provider.stopTask("ses_parent", kind === "shell" ? "v2:ses_parent:call_shell" : "v2:ses_parent:call_worker")).rejects.toThrow();
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose(); }
  });

  test("ownership reuse evicts at the incumbent worker entry limit and reconnect starts cold", async () => {
    const reference = (index: number) => ({ type: "tool", name: "subagent", id: `call${index}`, state: { status: "running", input: {}, metadata: { sessionID: `child${index}` } } });
    const frame = (content: unknown[]) => ({ type: "session.message.content.updated", location: { directory: WORKSPACE }, data: { sessionID: "ses_parent", messageID: "answer", content } });
    const frames: unknown[] = [{ type: "server.connected", data: {} }];
    for (let start = 0; start < 8_193; start += 128) frames.push(frame(Array.from({ length: Math.min(128, 8_193 - start) }, (_, offset) => reference(start + offset))));
    frames.push(frame([reference(0)]));
    let subscriptions = 0;
    const server = fakeOpenCode({
      "GET /api/event": () => new Response((subscriptions++ === 0 ? frames : [{ type: "server.connected", data: {} }, frame([reference(0)])]).map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
    });
    const provider = server.provider();
    try {
      for await (const _event of provider.events(new AbortController().signal)) { /* consume the actual SDK subscription */ }
      expect(server.requests("GET", "/api/session/child0")).toHaveLength(2);
      expect(server.calls.filter(call => call.path.startsWith("/api/session/"))).toHaveLength(8_194);
      for await (const _event of provider.events(new AbortController().signal)) { /* a new generation revalidates */ }
      expect(server.requests("GET", "/api/session/child0")).toHaveLength(3);
    } finally { await provider.dispose(); }
  }, 15_000);
  test("a failed stream child lookup preserves text and triggers read-only adapter worker recovery on the same subscription", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let messages: unknown[] = [], pending: unknown[] = [];
    let childReads = 0;
    const frame = (type: string, data: unknown, created = 30) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created, location: { directory: WORKSPACE } })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session": () => ({ data: [session("ses_parent")], cursor: {} }),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_child": () => ++childReads === 1 ? new Response(null, { status: 500 }) : session("ses_child", { parentID: "ses_parent" }),
      "GET /api/session/ses_parent/message": () => ({ data: messages, cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: pending }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/permission/request": () => scoped([]),
      "GET /api/form": () => scoped([]),
    });
    const adapter = new ChatAdapter({ provider: server.provider(), workspacePath: WORKSPACE, generation: "child-lookup", coalesceWindowMs: 0 });
    const pump = adapter.startEventPump();
    const items = () => adapter.projectionForTests("ses_parent").items();
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 4_000;
      while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
      expect(predicate()).toBe(true);
    };
    try {
      await until(() => server.requests("GET", "/api/session/ses_parent/message").length > 0);
      messages = [fixture.launch];
      frame("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: [{ type: "text", text: "Not lost" }, ...fixture.launch.content] });
      await until(() => items().some(item => item.type === "background_task" && item.status === "running" && item.stateUncertain === false));
      expect(items()).toContainEqual(expect.objectContaining({ type: "assistant_message", markdown: "Not lost" }));
      pending = [fixture.pending];
      frame("session.inbox.enqueued", { sessionID: "ses_parent", inboxID: fixture.pending.id, item: fixture.pending }, 41);
      await until(() => items().some(item => item.type === "background_task" && item.status === "completed"));
      expect(childReads).toBe(2);
      expect(server.requests("GET", "/api/event")).toHaveLength(1);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { await adapter.dispose(); await pump; }
  }, 10_000);
  for (const active of [false, true]) test(`lost relevant control observation stays unavailable across later Stops and public recovery (${active ? "active Stop" : "before Stop"})`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const healthy = structuredClone(fixture.launch);
    healthy.id = "healthy_message"; healthy.content[0].id = "healthy_call"; healthy.content[0].state.metadata.sessionID = "healthy_child";
    let wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined, armed = false, used = false, entered!: () => void, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    let sequence = 0;
    const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `gap${++sequence}`, type, data, created: 40, durable: { aggregateID: "ses_parent", seq: sequence, version: 1 }, location: { directory: WORKSPACE } })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent": async () => { if (armed && !used) { used = true; entered(); await gate; } return session("ses_parent"); },
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch, healthy], cursor: {} }),
      "GET /api/session/:id/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { type: "running" }, healthy_child: { type: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
      "POST /api/session/:id/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider();
    let controller = new AbortController();
    const rows = new Map<string, import("../../types").BackgroundTaskItem>();
    const consume = () => (async () => { for await (const event of provider.events(controller.signal)) {
      for (const update of event.updates) if (update.kind === "upsert" && update.item.type === "background_task") rows.set(update.item.taskId, update.item);
      if (event.eventType !== "server.connected") { acknowledge?.(); acknowledge = undefined; }
    } })();
    let pump = consume(), first: Promise<unknown> | undefined;
    const send = (type: string, data: unknown) => new Promise<void>(resolve => { acknowledge = resolve; frame(type, data); });
    try {
      await provider.waitForEventStream(controller.signal);
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: healthy.id, content: healthy.content });
      if (active) { armed = true; first = provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error); await started; }
      for (let index = 0; index < 2_049; index++) await send("session.tool.called", { sessionID: "ses_parent", id: `unknown${index}`, input: {} });
      await send("session.tool.input.started", { sessionID: "ses_parent", id: "new_relevant_call", name: "subagent" });
      await send("session.tool.called", { sessionID: "ses_parent", id: "new_relevant_call", assistantMessageID: "new_message", executed: true, input: { sessionID: "ses_child", prompt: "Different invocation" } });
      release();
      if (first) expect(await first).toMatchObject({ name: "BackgroundTaskUnavailableError" });
      else await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
      expect(rows.get("v2:ses_parent:call_worker")).toMatchObject({ status: "running", stateUncertain: true });
      expect((await provider.listMessages("ses_parent", { limit: 100 })).items).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", status: "running", stateUncertain: true }));
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", status: "running", stateUncertain: true }));
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
      await provider.stopTask("ses_parent", "v2:ses_parent:healthy_call");
      expect(server.requests("POST", "/api/session/healthy_child/interrupt")).toHaveLength(1);
      expect(server.requests("GET", "/api/event")).toHaveLength(1);
      controller.abort(); await pump; controller = new AbortController(); pump = consume();
      await provider.waitForEventStream(controller.signal);
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.converted.id, content: fixture.converted.content });
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
      expect(server.calls.filter(call => call.method === "POST")).toHaveLength(1);
    } finally { release(); controller.abort(); await first; await pump; await provider.dispose(); }
  });

  for (const kind of ["agent", "shell"] as const) for (const warm of [false, true]) for (const alias of [false, true]) {
    const phases = kind === "agent" ? ["parent", "parent-history", "inbox", "active", "ownership", "child-history", "final-ownership"] : ["parent", "parent-history", "inbox", "active", "shell-ownership"];
    for (const phase of [...(warm ? ["before-stop"] : []), ...phases]) for (const change of ["kind", "message", "typed-message", "progress", "replay", "new-id-old-clock"] as const) test(`Stop binds immutable native identity: ${kind}/${warm ? "warm" : "cold"}/${alias ? "alias" : "direct"}/${phase}/${change}`, async () => {
      const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
      const original = structuredClone(fixture.launch), converted = structuredClone(fixture.converted);
      const setKind = (part: { name: string; state: { metadata: Record<string, unknown> } }, workerKind: "agent" | "shell") => { part.name = workerKind === "agent" ? "subagent" : "shell"; part.state.metadata = { [workerKind === "agent" ? "sessionID" : "shellID"]: "ses_child", status: "running" }; };
      if (kind === "shell") { setKind(original.content[0], kind); setKind(converted.content[0], kind); }
      let history = alias ? [original, converted] : [original];
      const selected = alias ? converted : original;
      let wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined, armed = false, used = false, entered!: () => void, release!: () => void, lookups = 0;
      const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
      const waitAt = async (point: string) => { if (armed && !used && phase === point) { used = true; entered(); await gate; } };
      let sequence = 0;
      const raw = (type: string, data: unknown, created = 60) => ({ id: `identity${++sequence}`, type, data, created, durable: { aggregateID: "ses_parent", seq: sequence, version: 1 }, location: { directory: WORKSPACE } });
      const frame = (event: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      const server = fakeOpenCode({
        "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame(raw("server.connected", {})); } }), { headers: { "content-type": "text/event-stream" } }),
        "GET /api/session/ses_parent": async () => { await waitAt("parent"); return session("ses_parent"); },
        "GET /api/session/ses_parent/message": async () => { await waitAt("parent-history"); return { data: history, cursor: {} }; },
        "GET /api/session/ses_parent/inbox": async () => { await waitAt("inbox"); return { data: [] }; },
        "GET /api/session/active": async () => { await waitAt("active"); return { ses_child: { type: "running" } }; },
        "GET /api/session/ses_child/message": async () => { await waitAt("child-history"); return { data: [], cursor: {} }; },
        "GET /api/session/ses_child": async () => { if (armed) { lookups++; if (phase === "ownership") await waitAt("ownership"); else if (lookups === (warm ? 1 : 2)) await waitAt("final-ownership"); } return session("ses_child", { parentID: "ses_parent" }); },
        "GET /api/shell/ses_child": async () => { await waitAt("shell-ownership"); return scoped({ id: "ses_child", metadata: { sessionID: "ses_parent" } }); },
        "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
        "DELETE /api/shell/ses_child": () => undefined,
      });
      const provider = server.provider(), controller = new AbortController();
      const published: import("../../types").BackgroundTaskItem[] = [];
      const pump = (async () => { for await (const event of provider.events(controller.signal)) {
        for (const update of event.updates) if (update.kind === "upsert" && update.item.type === "background_task") published.push(update.item);
        if (event.eventType !== "server.connected") { acknowledge?.(); acknowledge = undefined; }
      } })();
      const sendRaw = (event: unknown) => new Promise<void>(resolve => { acknowledge = resolve; frame(event); });
      const send = (type: string, data: unknown, created?: number) => sendRaw(raw(type, data, created));
      let stop: Promise<unknown> | undefined;
      try {
        await provider.waitForEventStream(controller.signal);
        await send("session.tool.input.started", { sessionID: "ses_parent", id: selected.content[0].id, name: kind === "agent" ? "subagent" : "shell", assistantMessageID: selected.id });
        if (warm) {
          await send("session.message.content.updated", { sessionID: "ses_parent", messageID: original.id, content: original.content });
          if (alias) await send("session.message.content.updated", { sessionID: "ses_parent", messageID: converted.id, content: converted.content });
        }
        if (phase === "ownership") await send("session.moved", { sessionID: "unrelated" });
        if (phase !== "before-stop") { armed = true; stop = provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error); await started; }
        const changed = structuredClone(selected);
        if (change === "kind") setKind(changed.content[0], kind === "agent" ? "shell" : "agent");
        if (change === "message" || change === "typed-message") changed.id = "different_native_owner";
        if (change === "typed-message" || change === "progress") await send("session.tool.progress", { sessionID: "ses_parent", id: changed.content[0].id, assistantMessageID: changed.id, metadata: changed.content[0].state.metadata });
        else if (change === "new-id-old-clock") await send("session.tool.called", { sessionID: "ses_parent", id: selected.content[0].id, assistantMessageID: selected.id, executed: true, input: selected.content[0].state.input }, 1);
        else {
          const event = raw("session.message.content.updated", { sessionID: "ses_parent", messageID: changed.id, content: changed.content });
          await sendRaw(event);
          if (change === "replay") await sendRaw(structuredClone(event));
        }
        if (phase === "before-stop" && (change === "kind" || change === "message")) history = alias ? [original, changed] : [changed];
        release();
        stop ??= provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error);
        const result = await stop, allowed = change === "progress" || change === "replay";
        expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(allowed && kind === "agent" ? 1 : 0);
        expect(server.requests("DELETE", "/api/shell/ses_child")).toHaveLength(allowed && kind === "shell" ? 1 : 0);
        if (allowed) expect(result).toBeUndefined();
        else {
          expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
          // Exercise a live restatement after recovery has bound the cold
          // occurrence. A cold alias can publish under its own canonical id.
          await send("session.message.content.updated", { sessionID: "ses_parent", messageID: original.id, content: original.content });
          expect(published.filter(item => item.taskId === "v2:ses_parent:call_worker" || item.toolUseId === "call_worker" || item.toolUseIds?.includes("call_worker")).at(-1)).toMatchObject({ stateUncertain: true });
          expect((await provider.listMessages("ses_parent", { limit: 100 })).items).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", stateUncertain: true }));
          expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", stateUncertain: true }));
          await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
        }
      } finally { release(); controller.abort(); await stop; await pump; await provider.dispose(); }
    });
  }

  test("cold alias with a missing native owner cannot weaken a subsequently confirmed owner", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let history = [fixture.launch], wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined, sequence = 0;
    const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `partial${++sequence}`, type, data, created: 60,
      durable: { aggregateID: "ses_parent", seq: sequence, version: type === "session.tool.success" ? 2 : 1 }, location: { directory: WORKSPACE } })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent/message": () => ({ data: history, cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { type: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), controller = new AbortController();
    const pump = (async () => { for await (const event of provider.events(controller.signal)) if (event.eventType !== "server.connected") { acknowledge?.(); acknowledge = undefined; } })();
    const send = (type: string, data: unknown) => new Promise<void>(resolve => { acknowledge = resolve; frame(type, data); });
    try {
      await provider.waitForEventStream(controller.signal);
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", stateUncertain: false }));
      await send("session.tool.input.started", { sessionID: "ses_parent", id: fixture.converted.content[0].id, name: "subagent" });
      await send("session.tool.success", { sessionID: "ses_parent", id: fixture.converted.content[0].id, executed: true, input: fixture.converted.content[0].state.input, metadata: fixture.converted.content[0].state.metadata });
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
      history = [fixture.launch, fixture.converted];
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", stateUncertain: false }));
      const replacement = structuredClone(fixture.converted); replacement.id = "different_confirmed_owner";
      history = [fixture.launch, replacement];
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
      expect((await provider.listMessages("ses_parent", { limit: 100 })).items).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", stateUncertain: true }));
      expect(server.requests("GET", "/api/event")).toHaveLength(1);
    } finally { controller.abort(); await pump; await provider.dispose(); }
  });

  test("control-cohort growth revokes only its target and keeps another parent's shell stoppable", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined;
    const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 60, location: { directory: WORKSPACE } })}\n\n`));
    const rows = new Map<string, import("../../types").BackgroundTaskItem>();
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
      "GET /api/session/other/message": () => ({ data: [fixture.shell], cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/:id/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { type: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
      "GET /api/shell/sh_fixture": () => scoped({ id: "sh_fixture", metadata: { sessionID: "other" } }),
      "DELETE /api/shell/sh_fixture": () => undefined,
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), controller = new AbortController();
    const pump = (async () => { for await (const event of provider.events(controller.signal)) {
      for (const update of event.updates) if (update.kind === "upsert" && update.item.type === "background_task") rows.set(update.item.taskId, update.item);
      if (event.eventType === "session.message.content.updated") { acknowledge?.(); acknowledge = undefined; }
    } })();
    const send = (parent: string, content: unknown[]) => new Promise<void>(resolve => { acknowledge = resolve; frame("session.message.content.updated", { sessionID: parent, messageID: parent === "other" ? fixture.shell.id : fixture.launch.id, content }); });
    try {
      await provider.waitForEventStream(controller.signal);
      await send("ses_parent", fixture.launch.content);
      await send("other", fixture.shell.content);
      expect(rows.get("v2:ses_parent:call_worker")?.stateUncertain).toBe(false);
      expect(rows.get("v2:other:call_shell")?.stateUncertain).toBe(false);
      await send("ses_parent", Array.from({ length: 1_100 }, (_, index) => ({ ...structuredClone(fixture.launch.content[0]), id: `alias${index}` })));
      expect(rows.get("v2:ses_parent:call_worker")?.stateUncertain).toBe(true);
      expect((await provider.listMessages("ses_parent", { limit: 100 })).items).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", stateUncertain: true }));
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", stateUncertain: true }));
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
      await send("ses_parent", fixture.launch.content);
      expect(rows.get("v2:ses_parent:call_worker")?.stateUncertain).toBe(true);
      await provider.stopTask("other", "v2:other:call_shell");
      expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(1);
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
      expect(server.requests("GET", "/api/event")).toHaveLength(1);
    } finally { controller.abort(); await pump; await provider.dispose(); }
  });

  test("provider-lifetime revocations survive stream replacement and ordinary history or progress", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined;
    const frame = (content: unknown[]) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "session.message.content.updated", data: { sessionID: "ses_parent", messageID: fixture.launch.id, content }, created: 60, location: { directory: WORKSPACE } })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; wire.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n')); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { type: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider();
    let controller = new AbortController();
    const rows: import("../../types").BackgroundTaskItem[] = [];
    const consume = () => (async () => { for await (const event of provider.events(controller.signal)) {
      for (const update of event.updates) if (update.kind === "upsert" && update.item.type === "background_task") rows.push(update.item);
      if (event.eventType === "session.message.content.updated") { acknowledge?.(); acknowledge = undefined; }
    } })();
    let pump = consume();
    const send = (content: unknown[]) => new Promise<void>(resolve => { acknowledge = resolve; frame(content); });
    try {
      await provider.waitForEventStream(controller.signal);
      await send(fixture.launch.content);
      const changed = structuredClone(fixture.launch.content[0]); changed.time.ran = 90;
      await send([changed]);
      expect(rows.at(-1)?.stateUncertain).toBe(true);
      controller.abort(); await pump;
      controller = new AbortController(); pump = consume();
      await provider.waitForEventStream(controller.signal);
      await send(fixture.launch.content);
      expect(rows.at(-1)?.stateUncertain).toBe(true);
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", stateUncertain: true }));
      expect((await provider.listMessages("ses_parent", { limit: 100 })).items).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", stateUncertain: true }));
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
      expect(server.requests("GET", "/api/event")).toHaveLength(2);
      expect(server.calls.filter(call => call.method === "POST")).toHaveLength(0);
    } finally { controller.abort(); await pump; await provider.dispose(); }
    expect((provider as unknown as { controls: { usage: { entries: number } } }).controls.usage.entries).toBe(0);
  });

  for (const relevant of [false, true]) test(`projection saturation during retained Stop preserves per-target fences (${relevant ? "relevant negative" : "unrelated capacity"})`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined, entered!: () => void, release!: () => void, armed = false;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 60, location: { directory: WORKSPACE } })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent": async () => { if (armed) { entered(); await gate; } return session("ses_parent"); },
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { type: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), controller = new AbortController();
    const updates: import("../../types").BackgroundTaskItem[] = [];
    const pump = (async () => { for await (const event of provider.events(controller.signal)) {
      for (const update of event.updates) if (update.kind === "upsert" && update.item.type === "background_task") updates.push(update.item);
      if (event.eventType === "session.message.content.updated" || event.eventType === "server.heartbeat" || event.eventType === "session.tool.progress") { acknowledge?.(); acknowledge = undefined; }
    } })();
    const send = (type: string, data: unknown) => new Promise<void>(resolve => { acknowledge = resolve; frame(type, data); });
    let stop: Promise<unknown> | undefined;
    try {
      await provider.waitForEventStream(controller.signal);
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
      armed = true;
      stop = provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error);
      await started;
      for (let index = 0; index < 2_200; index++) frame("session.created", { sessionID: `filler${index}`.padEnd(500, "x"), parentID: "p".repeat(500) });
      await send("server.heartbeat", {});
      expect((provider as unknown as { eventMemory: { workers: { controlEvidenceAvailable: boolean } } }).eventMemory.workers.controlEvidenceAvailable).toBe(false);
      if (relevant) await send("session.tool.progress", { sessionID: "ses_parent", assistantMessageID: fixture.launch.id, id: "call_worker", metadata: { sessionID: "replacement", status: "running" } });
      release();
      const result = await stop;
      if (!relevant) expect(result).toBeUndefined();
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(relevant ? 0 : 1);
      if (relevant) {
        expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
        expect(updates.at(-1)).toMatchObject({ taskId: "v2:ses_parent:call_worker", stateUncertain: true });
        expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", stateUncertain: true }));
      } else expect(result).toBeUndefined();
      expect(server.requests("GET", "/api/event")).toHaveLength(1);
    } finally { release(); controller.abort(); await stop; await pump; await provider.dispose(); }
  });

  test("a saturated native stream keeps discovering and completing later workers through adapter recovery without reconnecting", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const encoder = new TextEncoder();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const retainedLaunch = structuredClone(fixture.launch);
    retainedLaunch.id = "retained_message";
    retainedLaunch.content[0].id = "retained_call";
    retainedLaunch.content[0].state.metadata.sessionID = "ses_retained";
    let messages: unknown[] = [retainedLaunch];
    let pending: unknown[] = [];
    let unavailable = false;
    const frame = (type: string, data: unknown, created = 30) => stream.enqueue(encoder.encode(`data: ${JSON.stringify({ type, data, created, location: { directory: WORKSPACE } })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller;
        frame("server.connected", {});
      } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session": () => ({ data: [session("ses_parent")], cursor: {} }),
      "GET /api/session/active": () => ({ ses_retained: { status: "running" }, ses_child: { status: "running" }, ses_later: { status: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_parent") ? {} : { parentID: "ses_parent" }),
      "GET /api/session/ses_parent/message": () => unavailable ? new Response(null, { status: 503 }) : { data: messages, cursor: {} },
      "GET /api/session/ses_parent/inbox": () => ({ data: pending }),
      "GET /api/session/:id/message": () => ({ data: [], cursor: {} }),
      "GET /api/permission/request": () => scoped([]),
      "GET /api/form": () => scoped([]),
      "POST /api/session/ses_retained/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider();
    const nativeEvents = provider.events.bind(provider);
    const liveWorkerIds: string[] = [];
    provider.events = async function* (signal) {
      for await (const event of nativeEvents(signal)) {
        for (const update of event.updates) if (update.kind === "upsert" && update.item.type === "background_task") liveWorkerIds.push(update.item.id);
        yield event;
      }
    };
    const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, generation: "saturation", coalesceWindowMs: 0 });
    const pump = adapter.startEventPump();
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 4000;
      while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
      if (!predicate()) throw new Error(`Saturation recovery stalled: ${JSON.stringify(rows().map(({ taskId, status, stateUncertain, resultId }) => ({ taskId, status, stateUncertain, resultId })))}; recent reads ${server.calls.slice(-12).map(call => `${call.method} ${call.path}`).join(", ")}`);
      expect(predicate()).toBe(true);
    };
    const rows = () => adapter.projectionForTests("ses_parent").items().filter(item => item.type === "background_task");
    try {
      await until(() => !!stream && server.requests("GET", "/api/session/ses_parent/message").length > 0);
      await until(() => rows().some(item => item.toolUseId === "retained_call" && !item.stateUncertain));
      // Saturate only disposable correlation after this target has acquired
      // its bounded control basis. Recovery must not reset the live latch.
      for (let i = 0; i < 2200; i++) frame("session.created", { sessionID: `filler${i}`.padEnd(500, "x"), parentID: "p".repeat(500) });
      await until(() => !(provider as unknown as { eventMemory?: { workers: { controlEvidenceAvailable: boolean } } }).eventMemory?.workers.controlEvidenceAvailable);
      await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      await provider.stopTask("ses_parent", "v2:ses_parent:retained_call");
      expect(server.requests("POST", "/api/session/ses_retained/interrupt")).toHaveLength(1);
      for (const [index, child] of ["ses_child", "ses_later"].entries()) {
        const launch = structuredClone(fixture.launch);
        launch.id = `launch${index}`;
        launch.content[0].id = `worker${index}`;
        launch.content[0].state.metadata.sessionID = child;
        const result = structuredClone(fixture.pending);
        result.id = `result${index}`;
        result.payload.metadata.childID = child;
        messages = [...messages, launch];
        frame("session.message.content.updated", { sessionID: "ses_parent", messageID: launch.id, content: launch.content });
        await until(() => rows().some(item => item.toolUseId === `worker${index}` && item.status === "running"));
        // The saturated live detector cannot create this later row: only a
        // successful authoritative read can discover it on this subscription.
        expect(rows().find(item => item.toolUseId === `worker${index}`)).toMatchObject({ childConversationId: child, stateUncertain: true });
        await expect(provider.stopTask("ses_parent", `v2:ses_parent:worker${index}`)).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
        expect(server.calls.filter(call => call.method === "POST")).toHaveLength(1);
        unavailable = true;
        const reads = server.requests("GET", "/api/session/ses_parent/message").length;
        frame("session.message.content.updated", { sessionID: "ses_parent", messageID: `invalidate${index}`, content: [] });
        await until(() => server.requests("GET", "/api/session/ses_parent/message").length > reads && rows().some(item => item.toolUseId === `worker${index}` && item.stateUncertain));
        expect(rows().find(item => item.toolUseId === `worker${index}`)?.status).toBe("running");
        unavailable = false;
        pending = [...pending, result];
        frame("session.inbox.enqueued", { sessionID: "ses_parent", inboxID: result.id, item: result }, 41);
        await until(() => rows().some(item => item.toolUseId === `worker${index}` && item.status === "completed"));
        expect(rows().find(item => item.toolUseId === `worker${index}`)).toMatchObject({ resultId: result.id, summary: "Fixture checked.", stateUncertain: false });
      }
      expect(server.requests("GET", "/api/event")).toHaveLength(1);
      expect(liveWorkerIds).toEqual([]);
      expect(server.calls.filter(call => call.method === "POST")).toEqual([expect.objectContaining({ path: "/api/session/ses_retained/interrupt" })]);
    } finally {
      await adapter.dispose();
      await pump;
    }
  }, 30_000);
  test("post-admission fresh worker evidence cannot join a read begun before the action", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let release!: () => void, entered!: () => void, reads = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const server = fakeOpenCode({
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": async () => {
        const first = reads++ === 0;
        if (first) { entered(); await gate; }
        return { data: first ? [] : [fixture.stored], cursor: {} };
      },
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({}),
    });
    const provider = server.provider();
    const earlier = provider.reconcileBackgroundTasks("ses_parent");
    await started;
    const fresh = provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    release();
    expect(await earlier).toEqual([]);
    expect(await fresh).toEqual([expect.objectContaining({ status: "completed", resultId: fixture.stored.id })]);
    expect(reads).toBe(2);
    await provider.dispose();
  });
  test("steer and resume response loss is unknown, explicit refusal stays definitive, and resume preserves native acceptance evidence", async () => {
    for (const operation of ["prompt", "interrupt"] as const) {
      for (const refused of [false, true]) {
        const server = fakeOpenCode({
          [`POST /api/session/ses_parent/${operation}`]: () => refused ? notFound("ses_parent") : new Response("lost after application", { status: 502 }),
        });
        const provider = server.provider();
        const mutation = operation === "prompt" ? provider.prompt("ses_parent", { id: "stable", text: "steer", delivery: "steer" }) : provider.interrupt("ses_parent", { resume: true });
        await expect(mutation).rejects.toMatchObject({ ...(refused ? { _tag: "SessionNotFoundError" } : { name: "OperationOutcomeUnknownError" }) });
        expect(server.requests("POST", `/api/session/ses_parent/${operation}`)).toHaveLength(1);
      }
    }
    for (const interrupted of [true, false]) {
      const server = fakeOpenCode({ "POST /api/session/ses_parent/interrupt": () => ({ interrupted }) });
      expect(await server.provider().interrupt("ses_parent", { resume: true })).toEqual({ interrupted });
    }
  });
  test("SDK transport refusal and undeclared 403 remain definitive for steer and resume without replay", async () => {
    for (const operation of ["prompt", "interrupt"] as const) for (const failure of ["socket", "forbidden"] as const) {
      const server = fakeOpenCode({
        [`POST /api/session/ses_parent/${operation}`]: () => {
          if (failure === "socket") throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ConnectionRefused" });
          return Response.json({ _tag: "ForbiddenError", message: "Forbidden" }, { status: 403 });
        },
      });
      const provider = server.provider();
      try {
        const error = await (operation === "prompt"
          ? provider.prompt("ses_parent", { id: "stable", text: "steer", delivery: "steer" })
          : provider.interrupt("ses_parent", { resume: true })).catch(error => error);
        expect(error).toBeInstanceOf(ClientError);
        expect(error).toMatchObject({ reason: failure === "socket" ? "Transport" : "UnexpectedStatus", cause: failure === "socket" ? { code: "ConnectionRefused" } : { status: 403 } });
        expect(server.requests("POST", `/api/session/ses_parent/${operation}`)).toHaveLength(1);
      } finally { await provider.dispose(); }
    }
  });
  test("steer and resume preserve known request refusals but keep timeout, disconnect, and server failures unknown", async () => {
    for (const operation of ["prompt", "interrupt"] as const) for (const failure of [400, 401, 404, 500, 503, "timeout", "disconnect"] as const) {
      const tag = failure === 400 ? "InvalidRequestError" : failure === 401 ? "UnauthorizedError" : "SessionNotFoundError";
      const server = fakeOpenCode({
        [`POST /api/session/ses_parent/${operation}`]: () => {
          if (failure === "timeout") throw new DOMException("Timed out after dispatch", "TimeoutError");
          if (failure === "disconnect") throw new TypeError("Socket closed after dispatch");
          return Response.json({ _tag: tag, message: "Request failed", sessionID: "ses_parent" }, { status: failure });
        },
      });
      const provider = server.provider();
      try {
        const result = operation === "prompt"
          ? provider.prompt("ses_parent", { id: "stable", text: "steer", delivery: "steer" })
          : provider.interrupt("ses_parent", { resume: true });
        await expect(result).rejects.toMatchObject(typeof failure === "number" && failure < 500 ? { _tag: tag } : { name: "OperationOutcomeUnknownError" });
        expect(server.requests("POST", `/api/session/ses_parent/${operation}`)).toHaveLength(1);
      } finally { await provider.dispose(); }
    }
  });
  test("background-all is one parent-scoped native mutation, including an accepted empty no-op", async () => {
    const server = fakeOpenCode({
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "POST /api/session/ses_parent/background": () => undefined,
    });
    await server.provider().backgroundBlockingWork("ses_parent");
    expect(server.calls.filter(call => call.method === "POST")).toEqual([expect.objectContaining({ path: "/api/session/ses_parent/background", body: undefined })]);
    expect(server.calls.some(call => /prompt|interrupt|inbox/.test(call.path))).toBe(false);
  });
  test("background parent validation refuses foreign sessions before mutation; dispatched response loss is unknown", async () => {
    const server = fakeOpenCode({
      "GET /api/session/ses_parent": () => session("ses_parent", { location: { directory: "/other" } }),
      "POST /api/session/ses_parent/background": () => undefined,
    });
    await expect(server.provider().backgroundBlockingWork("ses_parent")).rejects.toThrow(/unavailable/);
    expect(server.calls.some(call => call.method === "POST")).toBe(false);
    const lost = fakeOpenCode({
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "POST /api/session/ses_parent/background": () => new Response("lost", { status: 502 }),
    });
    await expect(lost.provider().backgroundBlockingWork("ses_parent")).rejects.toMatchObject({ name: "OperationOutcomeUnknownError" });
    expect(lost.requests("POST", "/api/session/ses_parent/background")).toHaveLength(1);
  });
  test("worker stop verifies its occurrence and interrupts only its child without resuming", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let completed = false;
    const server = fakeOpenCode({
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": () => ({ data: completed ? [fixture.launch, fixture.stored] : [fixture.launch], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider();
    await provider.stopTask("ses_parent", "v2:ses_parent:call_worker");
    expect(server.calls.filter(call => call.method === "POST")).toEqual([expect.objectContaining({ path: "/api/session/ses_child/interrupt", body: undefined })]);
    expect(server.requests("POST", "/api/session/ses_child/interrupt")[0]!.query.get("resume")).toBe("false");
    completed = true;
    await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toThrow(/no longer/);
    expect(server.calls.filter(call => call.method === "POST")).toHaveLength(1);
  });
  for (const type of ["session.execution.started", "session.execution.succeeded"]) test(`Stop refuses ${type} already known before validation without trusting lagging history`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let wire!: ReadableStreamDefaultController<Uint8Array>;
    const acknowledgements = new Map<string, () => void>();
    const frame = (type: string, data: unknown, created = 30) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `native-${type}`, type, data, created, location: { directory: WORKSPACE } })}\n\n`));
    const send = (type: string, data: unknown, created?: number) => new Promise<void>(resolve => { acknowledgements.set(type, resolve); frame(type, data, created); });
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent" }),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), controller = new AbortController();
    const pump = (async () => { for await (const event of provider.events(controller.signal)) { acknowledgements.get(event.eventType)?.(); acknowledgements.delete(event.eventType); } })();
    try {
      await provider.waitForEventStream(controller.signal);
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
      await send(type, { sessionID: "ses_child" }, 40);
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
      expect(server.calls.filter(call => call.method === "POST")).toHaveLength(0);
      expect(server.requests("GET", "/api/session/ses_parent/message")).toHaveLength(0);
    } finally { controller.abort(); await pump; await provider.dispose(); }
  });
  for (const alias of [false, true]) for (const change of ["foreground", "foreground-no-child", "changed-child-progress", "changed-child-progress-in-flight", "ambiguous-backdated-notification", "same-child-progress"] as const) test(`Stop retains pre-validation ${change} through progress and stale recovery (${alias ? "alias" : "direct"})`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let wire!: ReadableStreamDefaultController<Uint8Array>, sequence = 0;
    const acknowledgements: Array<() => void> = [];
    let entered!: () => void, release!: () => void, pendingProgress: Promise<void> | undefined;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const frame = (type: string, data: unknown, created = 100) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `retained${++sequence}`, type, data, created, durable: { aggregateID: "ses_parent", seq: sequence, version: 1 }, location: { directory: WORKSPACE } })}\n\n`));
    const send = (type: string, data: unknown, created?: number) => new Promise<void>(resolve => { acknowledgements.push(resolve); frame(type, data, created); });
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent/message": () => ({ data: alias ? [fixture.launch, fixture.converted] : [fixture.launch], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/new_child": async () => { if (change.endsWith("in-flight")) { entered(); await gate; } return session("new_child", { parentID: "ses_parent" }); },
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_parent") ? {} : { parentID: "ses_parent" }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), controller = new AbortController();
    const pump = (async () => { for await (const event of provider.events(controller.signal)) if (event.eventType !== "server.connected") acknowledgements.shift()?.(); })();
    try {
      await provider.waitForEventStream(controller.signal);
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
      if (alias) await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.converted.id, content: fixture.converted.content });
      const selected = alias ? fixture.converted : fixture.launch, part = structuredClone(selected.content[0]);
      await send("session.tool.input.started", { sessionID: "ses_parent", id: part.id, name: "subagent", assistantMessageID: selected.id });
      const common = { sessionID: "ses_parent", id: part.id, assistantMessageID: selected.id };
      if (change.startsWith("foreground")) {
        part.state.status = "running"; part.state.input.background = false;
        if (change === "foreground-no-child") delete part.state.metadata.sessionID;
        await send("session.message.content.updated", { sessionID: "ses_parent", messageID: selected.id, content: [part] });
      } else if (change === "ambiguous-backdated-notification") {
        await send("session.inbox.enqueued", { sessionID: "ses_parent", inboxID: "unproven_old_report", item: fixture.pending }, 1);
      } else {
        pendingProgress = send("session.tool.progress", { ...common, metadata: { sessionID: change.startsWith("changed-child") ? "new_child" : "ses_child", status: "running" } });
        if (change.endsWith("in-flight")) {
          await started;
          await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
          expect(server.calls.filter(call => call.method === "POST")).toHaveLength(0);
          release();
        }
        await pendingProgress;
      }
      await send("session.tool.progress", { ...common, metadata: { sessionID: "ses_child", status: "running" } });
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: selected.id, content: selected.content });
      await provider.reconcileBackgroundTasks("ses_parent");
      const result = await provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error);
      const allowed = change === "same-child-progress";
      expect(server.calls.filter(call => call.method === "POST")).toHaveLength(allowed ? 1 : 0);
      if (!allowed) expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
      else expect(result).toBeUndefined();
      expect(stopEvidence(provider)).toHaveLength(0);
    } finally { release(); await pendingProgress; controller.abort(); await pump; await provider.dispose(); }
  });
  test("a processed ownership revocation fences Stop while its child execution history is in flight", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let stream!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, revoked!: () => void;
    let foreign = false;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const observed = new Promise<void>(resolve => { revoked = resolve; });
    const frame = (type: string, data: unknown) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, location: { directory: WORKSPACE }, created: 30 })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent", location: { directory: foreign ? "/other" : WORKSPACE } }),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/session/ses_child/message": async () => { entered(); await gate; return { data: [], cursor: {} }; },
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider();
    const controller = new AbortController();
    let primed!: () => void;
    const priming = new Promise<void>(resolve => { primed = resolve; });
    const pump = (async () => { for await (const event of provider.events(controller.signal)) {
      if (event.eventType === "session.message.content.updated") primed();
      if (event.eventType === "session.moved") revoked();
    } })();
    let stop: Promise<unknown> | undefined;
    try {
      await provider.waitForEventStream(controller.signal);
      frame("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
      await priming;
      stop = provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error);
      await started;
      foreign = true;
      frame("session.moved", { sessionID: "ses_child", location: { directory: "/other" } });
      await observed;
      release();
      const result = await stop;
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
      expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
    } finally { release(); controller.abort(); await stop; await pump; await provider.dispose(); }
  });
  test("Stop cannot interrupt a reused child execution observed during final ownership verification", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let stream!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, childReads = 0;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const acknowledgements = new Map<string, () => void>();
    const frame = (type: string, data: unknown, created = 30) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created, location: { directory: WORKSPACE } })}\n\n`));
    const send = (type: string, data: unknown, created?: number) => new Promise<void>(resolve => { acknowledgements.set(type, resolve); frame(type, data, created); });
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_child": async () => { if (++childReads === 2) { entered(); await gate; } return session("ses_child", { parentID: "ses_parent" }); },
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), controller = new AbortController();
    const facts: unknown[] = [];
    const pump = (async () => { for await (const event of provider.events(controller.signal)) {
      facts.push(...event.updates.flatMap(update => update.kind === "upsert" && update.item.type === "background_task" ? [update.item] : []));
      acknowledgements.get(event.eventType)?.(); acknowledgements.delete(event.eventType);
    } })();
    let stop: Promise<unknown> | undefined;
    try {
      await provider.waitForEventStream(controller.signal);
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
      stop = provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error);
      await started;
      await send("session.execution.succeeded", { sessionID: "ses_child" }, 40);
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.converted.id, content: fixture.converted.content }, 60);
      expect(facts).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", stateUncertain: true }));
      expect(facts).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_converted", status: "running" }));
      release();
      const result = await stop;
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
      expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
    } finally { release(); controller.abort(); await stop; await pump; await provider.dispose(); }
  });
  for (const phase of ["parent-history", "child-history", "final-ownership"] as const) {
    for (const change of ["terminal", "restart", "launcher", "notification", "unrelated", "alias"] as const) test(`Stop scopes ${change} evidence during ${phase} to the requested occurrence`, async () => {
      const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
      let stream!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, childReads = 0;
      const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const acknowledgements = new Map<string, () => void>();
      const frame = (type: string, data: unknown, created = 30) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created, location: { directory: WORKSPACE } })}\n\n`));
      const send = (type: string, data: unknown, created?: number) => new Promise<void>(resolve => { acknowledgements.set(type, resolve); frame(type, data, created); });
      const waitAt = async (point: string) => { if (point === phase) { entered(); await gate; } };
      const server = fakeOpenCode({
        "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
        "GET /api/session/ses_parent": () => session("ses_parent"),
        "GET /api/session/ses_child": async () => { if (++childReads === 2) await waitAt("final-ownership"); return session("ses_child", { parentID: "ses_parent" }); },
        "GET /api/session/ses_parent/message": async () => { await waitAt("parent-history"); return { data: change === "alias" ? [fixture.launch, fixture.converted] : [fixture.launch], cursor: {} }; },
        "GET /api/session/ses_child/message": async () => { await waitAt("child-history"); return { data: [], cursor: {} }; },
        "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
        "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
        "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
        "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
      });
      const provider = server.provider(), controller = new AbortController();
      const pump = (async () => { for await (const event of provider.events(controller.signal)) {
        acknowledgements.get(event.eventType)?.(); acknowledgements.delete(event.eventType);
      } })();
      let stop: Promise<unknown> | undefined;
      try {
        await provider.waitForEventStream(controller.signal);
        await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
        if (change === "alias") await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.converted.id, content: fixture.converted.content }, 60);
        stop = provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error);
        await started;
        if (change === "terminal" || change === "restart") await send(change === "terminal" ? "session.execution.succeeded" : "session.execution.started", { sessionID: "ses_child" }, 40);
        if (change === "launcher") {
          // Observe supersession inside the selected validation window. A
          // terminal already known before Stop now refuses before these reads.
          await send("session.execution.succeeded", { sessionID: "ses_child" }, 40);
          await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.converted.id, content: fixture.converted.content }, 60);
        }
        if (change === "alias") await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.converted.id, content: fixture.converted.content }, 61);
        if (change === "notification") await send("session.inbox.enqueued", { sessionID: "ses_parent", inboxID: fixture.pending.id, item: fixture.pending }, 41);
        if (change === "unrelated") {
          await send("session.execution.started", { sessionID: "unrelated_child" }, 40);
          const other = structuredClone(fixture.converted.content[0]); other.state.metadata.sessionID = "other_child";
          await send("session.message.content.updated", { sessionID: "ses_parent", messageID: "other_worker", content: [other] }, 60);
          await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: [{ type: "text", text: "Still the same occurrence" }, ...fixture.launch.content] }, 61);
          await send("session.execution.succeeded", { sessionID: "another_parent" }, 62);
        }
        release();
        const result = await stop;
        const allowed = change === "unrelated" || change === "alias";
        expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(allowed ? 1 : 0);
        if (!allowed) expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
        else expect(result).toBeUndefined();
      } finally { release(); controller.abort(); await stop; await pump; await provider.dispose(); }
    });
  }
  for (const phase of ["parent", "parent-history", "inbox", "active", "ownership", "child-history", "final-ownership"] as const) {
    for (const change of ["child", "alias-child", "alias-foreground-missing-child", "foreground", "foreground-missing-child", "new-created", "new-ran", "alias-new-created", "alias-new-ran", "cold-new-created", "cold-new-ran", "cold-unchanged", "cold-alias-unchanged", "unchanged", "sibling-updated", "sibling-moved", "sibling-created", "sibling-deleted", "foreign-shutdown", "parent-updated", "parent-moved", "parent-created", "parent-deleted",
      "new-ran-then-progress", "new-created-then-progress", "changed-input-then-progress",
      "alias-new-ran-then-progress", "alias-new-created-then-progress", "alias-changed-input-then-progress",
      "cold-new-ran-then-progress", "cold-new-created-then-progress", "cold-changed-input-then-progress",
      "cold-alias-new-ran-then-progress", "cold-alias-new-created-then-progress", "cold-alias-changed-input-then-progress",
    ] as const) test(`Stop compares same-call target identity during ${phase} (${change})`, async () => {
      const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
      let stream!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void;
      let armed = false, used = false;
      const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const waitAt = async (point: string) => { if (armed && !used && phase === point) { used = true; entered(); await gate; } };
      const acknowledgements = new Map<string, () => void>();
      const frame = (type: string, data: unknown, created = 30, directory = WORKSPACE) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created, location: { directory } })}\n\n`));
      const send = (type: string, data: unknown, created?: number, directory?: string) => new Promise<void>(resolve => { acknowledgements.set(type, resolve); frame(type, data, created, directory); });
      const server = fakeOpenCode({
        "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
        "GET /api/session/ses_parent": async () => { await waitAt("parent"); return session("ses_parent"); },
        "GET /api/session/ses_parent/message": async () => { await waitAt("parent-history"); return { data: change.includes("alias-") ? [fixture.launch, fixture.converted] : [fixture.launch], cursor: {} }; },
        "GET /api/session/ses_parent/inbox": async () => { await waitAt("inbox"); return { data: [] }; },
        "GET /api/session/active": async () => { await waitAt("active"); return { ses_child: { status: "running" } }; },
        "GET /api/session/ses_child/message": async () => { await waitAt("child-history"); return { data: [], cursor: {} }; },
        "GET /api/session/ses_child": async () => { await waitAt(phase === "ownership" ? "ownership" : "final-ownership"); return session("ses_child", { parentID: "ses_parent" }); },
        "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
        "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
      });
      const provider = server.provider(), controller = new AbortController();
      const facts: unknown[] = [];
      const pump = (async () => { for await (const event of provider.events(controller.signal)) {
        facts.push(...event.updates);
        acknowledgements.get(event.eventType)?.(); acknowledgements.delete(event.eventType);
      } })();
      let stop: Promise<unknown> | undefined;
      try {
        await provider.waitForEventStream(controller.signal);
        const selected = change.includes("alias-") ? fixture.converted : fixture.launch;
        if (change.endsWith("then-progress")) await send("session.tool.input.started", { sessionID: "ses_parent", id: selected.content[0].id, name: "subagent", assistantMessageID: selected.id });
        if (!change.startsWith("cold-")) await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
        if (!change.startsWith("cold-") && change.includes("alias-")) await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.converted.id, content: fixture.converted.content }, 60);
        if (phase === "ownership") await send("session.moved", { sessionID: "unrelated" });
        armed = true;
        stop = provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error);
        await started;
        const part = structuredClone(selected.content[0]);
        if (change === "child" || change === "alias-child") part.state.metadata.sessionID = "new_child";
        if (change.includes("foreground")) { part.state.status = "running"; part.state.input.background = false; }
        if (change.endsWith("missing-child")) delete part.state.metadata.sessionID;
        if (change.includes("new-created") || change.includes("new-ran")) { part.time[change.includes("new-created") ? "created" : "ran"] = 81; part.time.completed = 90; }
        if (change.includes("changed-input")) part.state.input.prompt = "Not the selected invocation";
        if (change.startsWith("sibling-")) await send(`session.${change.slice(8)}`, { sessionID: "other_sibling", title: "Unrelated update" }, 60);
        else if (change.startsWith("parent-")) await send(`session.${change.slice(7)}`, { sessionID: "ses_parent" }, 60);
        else if (change === "foreign-shutdown") await send("location.shutdown", {}, 60, "/other");
        else await send("session.message.content.updated", { sessionID: "ses_parent", messageID: change === "cold-alias-unchanged" ? selected.id : fixture.launch.id, content: [part] }, 60);
        if (change.endsWith("then-progress")) {
          await send("session.tool.progress", { sessionID: "ses_parent", id: part.id, assistantMessageID: selected.id, metadata: { sessionID: "ses_child", status: "running" } }, 100);
          // Neither ordinary progress nor a lagging restatement may erase the
          // native contradiction while recovery is still discovering aliases.
          await send("session.message.content.updated", { sessionID: "ses_parent", messageID: selected.id, content: selected.content }, 110);
          for (const evidence of stopEvidence(provider)) {
            expect(evidence.pendingBytes).toBe(evidencePayloadBytes(evidence));
            expect(evidence.pendingBytes).toBeLessThanOrEqual(1024 * 1024);
            expect(evidence.pendingChanges.size + evidence.pendingLaunches.size).toBeLessThanOrEqual(2_048);
          }
        }
        if (change === "child" || change === "alias-child") expect(facts).toContainEqual(expect.objectContaining({ kind: "upsert", item: expect.objectContaining({ type: "tool", id: `tool:${part.id}`, childConversationId: "new_child" }) }));
        release();
        const result = await stop;
        const allowed = change !== "child" && !change.startsWith("alias-") && !change.startsWith("foreground") && !change.startsWith("parent-") && !change.includes("new-") && !change.includes("changed-input");
        expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(allowed ? 1 : 0);
        if (!allowed) expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
        else expect(result).toBeUndefined();
        if (change.endsWith("then-progress")) expect(stopEvidence(provider)).toHaveLength(0);
      } finally { release(); controller.abort(); await stop; await pump; await provider.dispose(); }
    });
  }
  for (const phase of ["parent", "parent-history", "inbox", "active", "ownership", "child-history", "final-ownership"] as const) {
    for (const alias of [false, true]) for (const [form, allowed] of [
      ["foreground invocation", false], ["background invocation", false], ["invocation child replacement", false],
      ["invocation without child", false], ["invocation without background", false], ["invocation without name", false],
      ["same-child progress", true], ["changed-child progress", false], ["lowercase-child progress", false], ["empty progress", true],
      ["same-child success", true], ["success without metadata", true], ["changed-child success", false],
      ["same-child failure", true], ["failure without metadata", true], ["changed-child failure", false],
      ["input delta", true], ["input ended", true], ["input started", true],
      ["unrelated invocation", true], ["unknown unrelated invocation", true], ["other-child invocation", true],
      ["new foreground launcher", false], ["new background launcher", false],
      ["empty progress after invocation", false], ["metadata-free success after invocation", false],
      ["properties changed-child progress", false], ["sessionId changed-child progress", false],
      ["properties same-child progress", true], ["sessionId same-child progress", true],
      ["properties execution restart", false], ["sessionId execution restart", false], ["lifecycle info identity", false],
      ["foreign lifecycle info identity", false],
      ["consumed invocation replay", true], ["new identity old-clock invocation", false], ["contradictory consumed invocation", false],
      ["consumed terminal replay", true], ["consumed notification replay", true],
      ["consumed execution-start replay", true],
      ["first-seen backdated terminal", false], ["first-seen backdated notification", false],
    ] as const) test(`Stop observes typed ${form} during ${phase} (${alias ? "folded alias" : "selected call"})`, async () => {
      const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
      let stream!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void;
      let armed = false, used = false;
      const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const waitAt = async (point: string) => { if (armed && !used && phase === point) { used = true; entered(); await gate; } };
      const acknowledgements = new Map<string, () => void>();
      let sequence = 0;
      let lastFrame: Record<string, unknown>;
      const frame = (type: string, data: unknown, created = 30) => { lastFrame = {
        id: `typed_event${++sequence}`, type, data, created, location: { directory: WORKSPACE },
        ...(["session.message.content.updated", "session.tool.input.started", "session.tool.input.ended", "session.tool.called", "session.tool.success", "session.tool.failed"].includes(type)
          ? { durable: { aggregateID: "ses_parent", seq: sequence, version: type === "session.tool.success" || type === "session.tool.failed" ? 2 : 1 } } : {}),
      }; stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(lastFrame)}\n\n`)); };
      const send = (type: string, data: unknown) => new Promise<void>(resolve => { acknowledgements.set(type, resolve); frame(type, data, 60); });
      const server = fakeOpenCode({
        "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
        "GET /api/session/ses_parent": async () => { await waitAt("parent"); return session("ses_parent"); },
        "GET /api/session/ses_parent/message": async () => { await waitAt("parent-history"); return { data: alias ? [fixture.launch, fixture.converted] : [fixture.launch], cursor: {} }; },
        "GET /api/session/ses_parent/inbox": async () => { await waitAt("inbox"); return { data: [] }; },
        "GET /api/session/active": async () => { await waitAt("active"); return { ses_child: { status: "running" } }; },
        "GET /api/session/ses_child/message": async () => { await waitAt("child-history"); return { data: [], cursor: {} }; },
        "GET /api/session/ses_child": async () => { await waitAt(phase === "ownership" ? "ownership" : "final-ownership"); return session("ses_child", { parentID: "ses_parent" }); },
        "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
        "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
      });
      const provider = server.provider(), controller = new AbortController();
      const facts: unknown[] = [];
      const pump = (async () => { for await (const event of provider.events(controller.signal)) {
        facts.push(...event.updates);
        acknowledgements.get(event.eventType)?.(); acknowledgements.delete(event.eventType);
      } })();
      let stop: Promise<unknown> | undefined;
      try {
        await provider.waitForEventStream(controller.signal);
        let consumed: Record<string, unknown> | undefined;
        if (form === "consumed execution-start replay") {
          await new Promise<void>(resolve => { acknowledgements.set("session.execution.started", resolve); frame("session.execution.started", { sessionID: "ses_child" }, 10); });
          consumed = structuredClone(lastFrame!);
        }
        if (form === "consumed terminal replay" || form === "consumed notification replay") {
          const old = structuredClone(fixture.launch);
          old.id = "old_message"; old.content[0].id = "old_call"; old.content[0].time = { created: 1, completed: 2 };
          await send("session.message.content.updated", { sessionID: "ses_parent", messageID: old.id, content: old.content });
          const type = form === "consumed terminal replay" ? "session.execution.succeeded" : "session.inbox.enqueued";
          const data = form === "consumed terminal replay" ? { sessionID: "ses_child" } : { sessionID: "ses_parent", inboxID: "old_notice", item: fixture.pending };
          await new Promise<void>(resolve => { acknowledgements.set(type, resolve); frame(type, data, 3); });
          consumed = structuredClone(lastFrame!);
        }
        if (form === "consumed invocation replay" || form === "contradictory consumed invocation") {
          const prior = alias ? fixture.converted : fixture.launch;
          await send("session.tool.input.started", { sessionID: "ses_parent", id: prior.content[0].id, name: "subagent" });
          await send("session.tool.called", { sessionID: "ses_parent", id: prior.content[0].id, assistantMessageID: prior.id, executed: true, input: prior.content[0].state.input });
          consumed = structuredClone(lastFrame!);
        }
        await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
        if (alias) await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.converted.id, content: fixture.converted.content });
        const part = alias ? fixture.converted.content[0] : fixture.launch.content[0];
        const assistantMessageID = alias ? fixture.converted.id : fixture.launch.id;
        if (form !== "invocation without name") await send("session.tool.input.started", { sessionID: "ses_parent", id: part.id, name: "subagent", assistantMessageID });
        const otherCall = form === "unrelated invocation" || form === "unknown unrelated invocation" || form === "other-child invocation" || form === "new foreground launcher" || form === "new background launcher";
        if (otherCall && form !== "unknown unrelated invocation") await send("session.tool.input.started", { sessionID: "ses_parent", id: "another_call", name: form === "unrelated invocation" ? "read" : "subagent", assistantMessageID });
        if (phase === "ownership") await send("session.moved", { sessionID: "unrelated" });
        armed = true;
        stop = provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error);
        await started;
        const common = { sessionID: "ses_parent", id: otherCall ? "another_call" : part.id, assistantMessageID };
        const input: Record<string, unknown> = { ...part.state.input, background: form === "background invocation" || form === "new background launcher", sessionID: form === "invocation child replacement" ? "new_child" : form === "other-child invocation" ? "other_child" : "ses_child" };
        if (form === "invocation without child") delete input.sessionID;
        if (form === "invocation without background") delete input.background;
        switch (form) {
          case "properties changed-child progress": case "sessionId changed-child progress": case "properties same-child progress": case "sessionId same-child progress": case "properties execution restart": case "sessionId execution restart": case "lifecycle info identity": case "foreign lifecycle info identity": {
            const restart = form.includes("restart");
            const type = form.includes("lifecycle info") ? "session.updated" : restart ? "session.execution.started" : "session.tool.progress";
            const data = form.includes("lifecycle info") ? { info: { id: "ses_child", directory: "/foreign", parentID: "other", title: "Moved" } }
              : restart ? { [form.startsWith("sessionId") ? "sessionId" : "sessionID"]: "ses_child" }
                : { ...common, ...(form.startsWith("sessionId") ? { sessionID: undefined, sessionId: "ses_parent" } : {}), metadata: { sessionID: form.includes("same-child") ? "ses_child" : "new_child", status: "running" } };
            await new Promise<void>(resolve => { acknowledgements.set(type, resolve); const raw = { type, created: 60, location: { directory: form.startsWith("foreign") ? "/foreign" : WORKSPACE }, [form.startsWith("properties") ? "properties" : "data"]: data }; stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(raw)}\n\n`)); });
            break;
          }
          case "consumed invocation replay": case "contradictory consumed invocation": {
            const raw = structuredClone(consumed!);
            if (form === "contradictory consumed invocation") (raw.data as Record<string, unknown>).input = { ...input, prompt: "Not the consumed invocation" };
            await new Promise<void>(resolve => { acknowledgements.set("session.tool.called", resolve); stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(raw)}\n\n`)); });
            break;
          }
          case "consumed terminal replay": case "consumed notification replay": case "consumed execution-start replay": {
            await new Promise<void>(resolve => { acknowledgements.set(consumed!.type as string, resolve); stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(consumed)}\n\n`)); });
            break;
          }
          case "first-seen backdated terminal": case "first-seen backdated notification": {
            const type = form === "first-seen backdated terminal" ? "session.execution.succeeded" : "session.inbox.enqueued";
            const data = form === "first-seen backdated terminal" ? { sessionID: "ses_child" } : { sessionID: "ses_parent", inboxID: "unseen_notice", item: fixture.pending };
            await new Promise<void>(resolve => { acknowledgements.set(type, resolve); frame(type, data, 1); });
            break;
          }
          case "new identity old-clock invocation": await new Promise<void>(resolve => { acknowledgements.set("session.tool.called", resolve); frame("session.tool.called", { ...common, executed: true, input }, 1); }); break;
          case "same-child progress": case "changed-child progress": case "lowercase-child progress": case "empty progress":
            await send("session.tool.progress", { ...common, metadata: form === "empty progress" ? {} : form === "lowercase-child progress" ? { sessionId: "new_child", status: "running" } : { sessionID: form === "changed-child progress" ? "new_child" : "ses_child", status: "running" } });
            break;
          case "same-child success": case "success without metadata": case "changed-child success":
            await send("session.tool.success", { ...common, executed: true, content: [{ type: "text", text: "Previously reported launcher result" }], ...(form === "success without metadata" ? {} : { metadata: { sessionID: form === "changed-child success" ? "new_child" : "ses_child", status: "running" } }) });
            break;
          case "same-child failure": case "failure without metadata": case "changed-child failure":
            await send("session.tool.failed", { ...common, executed: true, error: { type: "unknown", message: "Previously reported launcher error" }, ...(form === "failure without metadata" ? {} : { metadata: { sessionID: form === "changed-child failure" ? "new_child" : "ses_child", status: "running" } }) });
            break;
          case "input delta": await send("session.tool.input.delta", { ...common, delta: JSON.stringify(input) }); break;
          case "input ended": await send("session.tool.input.ended", { ...common, text: JSON.stringify(input) }); break;
          case "input started": await send("session.tool.input.started", { ...common, name: "subagent" }); break;
          case "empty progress after invocation":
            await send("session.tool.called", { ...common, executed: true, input });
            await send("session.tool.progress", { ...common, metadata: {} });
            break;
          case "metadata-free success after invocation":
            await send("session.tool.called", { ...common, executed: true, input });
            await send("session.tool.success", { ...common, executed: true, content: [{ type: "text", text: "Old report cannot clear the new invocation" }] });
            break;
          default: await send("session.tool.called", { ...common, executed: true, input });
        }
        if (form === "foreground invocation") expect(facts).toContainEqual(expect.objectContaining({ kind: "upsert", item: expect.objectContaining({ id: `tool:${part.id}`, type: "tool", name: "subagent", status: "running" }) }));
        if (form === "invocation child replacement") expect(server.requests("GET", "/api/session/new_child")).toHaveLength(0); // Request intent is never ownership proof.
        release();
        const result = await stop;
        expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(allowed ? 1 : 0);
        if (allowed) expect(result).toBeUndefined();
        else expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
      } finally { release(); controller.abort(); await stop; await pump; await provider.dispose(); }
    });
  }
  test("Stop discovery overflow keeps unretained targets unavailable while retained healthy controls survive the same flood", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const retained = structuredClone(fixture.launch);
    retained.id = "retained_message"; retained.content[0].id = "retained_call"; retained.content[0].state.metadata.sessionID = "retained_child";
    let stream!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, acknowledge: (() => void) | undefined;
    let history = [fixture.launch, retained];
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const frame = (type: string, data: unknown) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 40, location: { directory: WORKSPACE } })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent/message": async () => { entered(); await gate; return { data: history, cursor: {} }; },
      "GET /api/session/:id/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" }, later_child: { status: "running" }, retained_child: { status: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
      "POST /api/session/:id/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), controller = new AbortController();
    const published: import("../../types").BackgroundTaskItem[] = [];
    const pump = (async () => { for await (const event of provider.events(controller.signal)) {
      for (const update of event.updates) if (update.kind === "upsert" && update.item.type === "background_task") published.push(update.item);
      if (event.eventType === "session.execution.started" || event.eventType === "session.message.content.updated") { acknowledge?.(); acknowledge = undefined; }
    } })();
    let stop: Promise<unknown> | undefined;
    try {
      await provider.waitForEventStream(controller.signal);
      await new Promise<void>(resolve => { acknowledge = resolve; frame("session.message.content.updated", { sessionID: "ses_parent", messageID: retained.id, content: retained.content }); });
      expect(published).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:retained_call", status: "running", stateUncertain: false }));
      stop = provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error);
      await started;
      for (let index = 0; index <= 2_048; index++) await new Promise<void>(resolve => { acknowledge = resolve; frame("session.execution.started", { sessionID: index === 2_048 ? "ses_child" : `candidate${index}` }); });
      release();
      expect(await stop).toMatchObject({ name: "BackgroundTaskUnavailableError" });
      expect(server.calls.filter(call => call.method === "POST")).toHaveLength(0);
      const later = structuredClone(fixture.launch);
      later.id = "later_message"; later.content[0].id = "later_call"; later.content[0].state.metadata.sessionID = "later_child";
      history = [later, retained];
      // Lead-approved bounded-cohort policy: the old expectation admitted this
      // previously unretained identity from history after 2,049 unknown facts.
      // Lost coverage now stays unavailable for this provider's lifetime;
      // retiring the transient Stop guard must not recreate control trust.
      const recovered = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(recovered).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:later_call", status: "running", stateUncertain: true }));
      expect(recovered).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:retained_call", status: "running", stateUncertain: false }));
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:later_call")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
      expect(server.requests("POST", "/api/session/later_child/interrupt")).toHaveLength(0);
      expect(server.calls.filter(call => call.method === "POST")).toHaveLength(0);
      await provider.stopTask("ses_parent", "v2:ses_parent:retained_call");
      expect(server.requests("POST", "/api/session/retained_child/interrupt")).toHaveLength(1);
      expect(server.calls.filter(call => call.method === "POST")).toEqual([expect.objectContaining({ path: "/api/session/retained_child/interrupt" })]);
      expect(server.requests("GET", "/api/event")).toHaveLength(1);
    } finally { release(); controller.abort(); await stop; await pump; await provider.dispose(); }
  });
  test("Stop admits at most four concurrent authorizations without an unbounded validation queue", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const history = Array.from({ length: 4 }, (_, index) => {
      const message = structuredClone(fixture.launch);
      message.id = `message${index}`; message.content[0].id = `call${index}`; message.content[0].state.metadata.sessionID = `child${index}`;
      return message;
    });
    const server = fakeOpenCode({
      "GET /api/session/ses_parent": async () => { entered(); await gate; return session("ses_parent"); },
      "GET /api/session/ses_parent/message": () => ({ data: history, cursor: {} }),
      "GET /api/session/:id/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`child${index}`, { status: "running" }])),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
      "POST /api/session/:id/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider();
    const stops = Array.from({ length: 4 }, (_, index) => provider.stopTask("ses_parent", `v2:ses_parent:call${index}`));
    try {
      await started;
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:call0")).rejects.toThrow("capacity");
      expect(server.calls.filter(call => call.method === "POST")).toHaveLength(0);
      release(); await Promise.all(stops);
      expect(server.calls.filter(call => call.method === "POST")).toHaveLength(4);
    } finally { release(); await Promise.allSettled(stops); await provider.dispose(); }
  });
  for (const escaped of [false, true]) test(`Stop accounts complete candidate payloads at the byte limit (${escaped ? "escaped Unicode" : "maximum strings"})`, async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, acknowledge: (() => void) | undefined;
    let fail = false;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const frame = (type: string, data: unknown) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 30, location: { directory: WORKSPACE } })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent/message": async () => { entered(); await gate; if (fail) throw new Error("Intentional history failure"); return { data: [], cursor: {} }; },
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({}),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
    });
    const provider = server.provider(), controller = new AbortController();
    const pump = (async () => { for await (const event of provider.events(controller.signal)) if (event.eventType === "session.tool.progress") { acknowledge?.(); acknowledge = undefined; } })();
    const stops: Promise<unknown>[] = [];
    try {
      await provider.waitForEventStream(controller.signal);
      for (let index = 0; index < 4; index++) stops.push(provider.stopTask("ses_parent", `v2:ses_parent:target${index}`).catch(error => error));
      await started;
      const retained = stopEvidence(provider);
      expect(retained).toHaveLength(4);
      let overflow = false;
      for (let index = 0; index < 600; index++) {
        const call = `${index}:`.padEnd(512, escaped ? '\\"\n\ud800' : "x").slice(0, 512);
        await new Promise<void>(resolve => { acknowledge = resolve; frame("session.tool.progress", { sessionID: "ses_parent", id: call, metadata: { sessionID: "c".repeat(512) } }); });
        for (const evidence of retained) {
          const payload = evidencePayloadBytes(evidence);
          expect(evidence.pendingBytes).toBe(payload);
          expect(payload).toBeLessThanOrEqual(1024 * 1024);
          expect(evidence.pendingChanges.size + evidence.pendingLaunches.size).toBeLessThanOrEqual(2_048);
        }
        expect(retained.reduce((bytes, evidence) => bytes + evidencePayloadBytes(evidence), 0)).toBeLessThanOrEqual(4 * 1024 * 1024);
        if (retained.every(evidence => evidence.changed)) { overflow = true; break; }
      }
      expect(overflow).toBe(true);
      release();
      for (const result of await Promise.all(stops)) expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
      expect(stopEvidence(provider)).toHaveLength(0);
      for (const evidence of retained) {
        expect(evidence.pendingChanges.size + evidence.pendingLaunches.size).toBe(0);
        expect(evidence.pendingBytes).toBe(evidencePayloadBytes(evidence));
      }
      fail = true;
      for (let index = 0; index < 5; index++) {
        await expect(provider.stopTask("ses_parent", "v2:ses_parent:failed")).rejects.toThrow();
        expect(stopEvidence(provider)).toHaveLength(0);
      }
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { release(); controller.abort(); await Promise.allSettled(stops); await pump; await provider.dispose(); }
  });
  test("Stop evidence replacement and pruning keep an exact incremental payload ledger", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let stream!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void;
    let ownershipEntered!: () => void, releaseOwnership!: () => void, finalEntered!: () => void, releaseFinal!: () => void, reads = 0;
    const started = new Promise<void>(resolve => { entered = resolve; }), historyGate = new Promise<void>(resolve => { release = resolve; });
    const ownershipStarted = new Promise<void>(resolve => { ownershipEntered = resolve; }), ownershipGate = new Promise<void>(resolve => { releaseOwnership = resolve; });
    const finalStarted = new Promise<void>(resolve => { finalEntered = resolve; }), finalGate = new Promise<void>(resolve => { releaseFinal = resolve; });
    const acknowledgements = new Map<string, () => void>();
    const frame = (type: string, data: unknown) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 30, location: { directory: WORKSPACE } })}\n\n`));
    const send = (type: string, data: unknown) => new Promise<void>(resolve => { acknowledgements.set(type, resolve); frame(type, data); });
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent/message": async () => { entered(); await historyGate; return { data: [fixture.launch], cursor: {} }; },
      "GET /api/session/ses_child": async () => {
        if (++reads === 2) { ownershipEntered(); await ownershipGate; }
        if (reads === 3) { finalEntered(); await finalGate; }
        return session("ses_child", { parentID: "ses_parent" });
      },
      "GET /api/session/:id/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), controller = new AbortController();
    const pump = (async () => { for await (const event of provider.events(controller.signal)) { acknowledgements.get(event.eventType)?.(); acknowledgements.delete(event.eventType); } })();
    let stop: Promise<unknown> | undefined;
    try {
      await provider.waitForEventStream(controller.signal);
      stop = provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error);
      await started;
      const evidence = stopEvidence(provider)[0]!;
      const exact = () => { expect(evidence.pendingBytes).toBe(evidencePayloadBytes(evidence)); expect(evidence.changed).toBe(false); };
      await send("session.execution.started", { sessionID: "other_execution" }); exact();
      await send("session.tool.called", { sessionID: "ses_parent", assistantMessageID: "third_message", id: "restricted_call", executed: true, input: { sessionID: "third_child", background: false } }); exact();
      expect(server.requests("GET", "/api/session/third_child")).toHaveLength(0);
      const restrictedBytes = evidence.pendingBytes;
      await send("session.tool.progress", { sessionID: "ses_parent", assistantMessageID: "third_message", id: "restricted_call", metadata: { sessionID: "third_child", status: "running" } }); exact();
      expect(evidence.pendingBytes).toBeLessThan(restrictedBytes); // Stronger reported provenance removes the restriction field.
      const part = structuredClone(fixture.launch.content[0]);
      part.id = 'other\\"call🚀'; part.state.metadata.sessionID = "other_child";
      await send("session.tool.progress", { sessionID: "ses_parent", id: part.id, metadata: { sessionID: "other_child" } }); exact();
      const before = evidence.pendingBytes;
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: "other_message", content: [part] }); exact();
      expect(evidence.pendingBytes).toBeGreaterThan(before);
      const backgroundBytes = evidence.pendingBytes;
      part.state.status = "running";
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: "other_message", content: [part] }); exact();
      expect(evidence.pendingBytes).toBe(backgroundBytes + 2); // JSON false versus true.
      const foregroundBytes = evidence.pendingBytes;
      part.state.status = "completed";
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: "other_message", content: [part] }); exact();
      expect(evidence.pendingBytes).toBe(foregroundBytes); // Preserve the earlier contradictory fact.
      await send("session.tool.progress", { sessionID: "ses_parent", id: "call_worker", metadata: { sessionID: "ses_child" } }); exact();
      await send("session.moved", { sessionID: "unrelated" }); exact();
      expect(evidence.pendingChanges.size).toBeGreaterThan(0);
      release(); await ownershipStarted;
      expect(evidence.pendingChanges.size).toBe(0);
      expect(evidence.pendingLaunches.size).toBe(3); exact();
      releaseOwnership(); await finalStarted;
      expect(evidence.pendingChanges.size + evidence.pendingLaunches.size).toBe(0); exact();
      releaseFinal();
      expect(await stop).toBeUndefined();
      expect(stopEvidence(provider)).toHaveLength(0);
      expect(evidence.pendingBytes).toBe(evidencePayloadBytes(evidence));
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(1);
    } finally { release(); releaseOwnership(); releaseFinal(); controller.abort(); await stop; await pump; await provider.dispose(); }
  });
  for (const phase of ["previous-recovery", "parent", "history", "inbox", "active", "ownership", "child-history", "final-ownership"] as const) {
    for (const lifecycle of ["session.moved", "session.deleted", "location.shutdown", "reconnect"] as const) test(`Stop refuses ${lifecycle} during ${phase} without dispatching a child mutation`, async () => {
      const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
      let stream!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void;
      let blocking = false, enteredOnce = false, foreign = false, childReads = 0;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const waitAt = async (point: string) => {
        if (!blocking || enteredOnce || point !== (phase === "previous-recovery" ? "child-history" : phase)) return;
        enteredOnce = true; entered(); await gate;
      };
      const acknowledgements = new Map<string, () => void>();
      const frame = (type: string, data: unknown) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, location: { directory: WORKSPACE }, created: 30 })}\n\n`));
      const send = (type: string, data: unknown) => new Promise<void>(resolve => { acknowledgements.set(type, resolve); frame(type, data); });
      const server = fakeOpenCode({
        "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
        "GET /api/session/ses_parent": async () => { await waitAt("parent"); return session("ses_parent"); },
        "GET /api/session/ses_child": async () => {
          if (++childReads > 1) await waitAt(phase === "ownership" ? "ownership" : "final-ownership");
          return session("ses_child", { parentID: "ses_parent", location: { directory: foreign ? "/other" : WORKSPACE } });
        },
        "GET /api/session/ses_parent/message": async () => { await waitAt("history"); return { data: [fixture.launch], cursor: {} }; },
        "GET /api/session/ses_parent/inbox": async () => { await waitAt("inbox"); return { data: [] }; },
        "GET /api/session/active": async () => { await waitAt("active"); return { ses_child: { status: "running" } }; },
        "GET /api/session/ses_child/message": async () => { await waitAt("child-history"); return { data: [], cursor: {} }; },
        "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
      });
      const provider = server.provider();
      let controller = new AbortController();
      const consume = () => (async () => { for await (const event of provider.events(controller.signal)) {
        acknowledgements.get(event.eventType)?.(); acknowledgements.delete(event.eventType);
      } })();
      let pump = consume(), stop: Promise<unknown> | undefined, previous: Promise<unknown> | undefined;
      try {
        await provider.waitForEventStream(controller.signal);
        await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
        // Force a new ordinary verification only for the lookup-await case;
        // other cases deliberately exercise already-cached ownership.
        if (phase === "ownership") await send("session.moved", { sessionID: "unrelated" });
        blocking = true;
        if (phase === "previous-recovery") {
          previous = provider.reconcileBackgroundTasks("ses_parent").catch(error => error);
          await started;
        }
        stop = provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error);
        await started;
        foreign = true;
        if (lifecycle === "reconnect") {
          controller.abort(); await pump;
          controller = new AbortController(); pump = consume();
          await provider.waitForEventStream(controller.signal);
        } else await send(lifecycle, lifecycle === "location.shutdown" ? {} : { sessionID: "ses_child", location: { directory: "/other" } });
        release();
        const result = await stop;
        expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
        expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
      } finally { release(); controller.abort(); await stop; await previous; await pump; await provider.dispose(); }
    });
  }
  for (const foreign of ["workspace", "parent"] as const) test(`Stop bypasses cached ownership and refuses a fresh mismatched ${foreign}`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let childReads = 0;
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n')); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_child": () => session("ses_child", { parentID: ++childReads > 1 && foreign === "parent" ? "other" : "ses_parent", location: { directory: childReads > 1 && foreign === "workspace" ? "/other" : WORKSPACE } }),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), controller = new AbortController();
    const events = provider.events(controller.signal)[Symbol.asyncIterator]();
    try {
      await events.next();
      expect(await provider.reconcileBackgroundTasks("ses_parent")).toContainEqual(expect.objectContaining({ status: "running", stateUncertain: false }));
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
      expect(childReads).toBe(2);
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
    } finally { controller.abort(); await events.return?.(); await provider.dispose(); }
  });
  test("worker stop does not authorize from a recovery read that predates the stop request", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { started = resolve; });
    let reads = 0;
    const server = fakeOpenCode({
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/ses_child/message": () => ({ data: [{ id: "idle", type: "idle", time: { created: 40 } }], cursor: {} }),
      "GET /api/session/ses_parent/message": async () => {
        if (++reads === 1) { started(); await gate; return { data: [fixture.launch], cursor: {} }; }
        return { data: [fixture.launch, fixture.stored, fixture.converted], cursor: {} };
      },
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider();
    const recovery = provider.reconcileBackgroundTasks("ses_parent");
    await reading;
    const stop = provider.stopTask("ses_parent", "v2:ses_parent:call_worker");
    release();
    // Even the older parent read cannot authorize a task past the child's
    // independently observed execution boundary.
    expect(await recovery).toContainEqual(expect.objectContaining({ toolUseId: "call_worker", stateUncertain: true }));
    await expect(stop).rejects.toThrow(/no longer confirmed/);
    expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
  });
  for (const withForegroundLauncher of [false, true]) test(`an unresolved old background task cannot stop a newer child occurrence (${withForegroundLauncher ? "foreground launcher running" : "external child continuation"})`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const foreground = structuredClone(fixture.converted);
    foreground.content[0].state.status = "running";
    foreground.content[0].time = { created: 50 };
    foreground.time = { created: 50 };
    const server = fakeOpenCode({
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": () => ({ data: withForegroundLauncher ? [fixture.launch, foreground] : [fixture.launch], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/ses_child/message": () => ({ data: [
        { id: "idle-old", type: "idle", time: { created: 40 } },
        { id: "prompt-new", type: "user", text: "New foreground occurrence", time: { created: 50 } },
      ], cursor: {} }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider();
    expect(await provider.reconcileBackgroundTasks("ses_parent")).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", status: "running", stateUncertain: true }));
    await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toThrow(/no longer confirmed/);
    expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
  });
  test("shell output is an owned bounded tail; removal acknowledgement is not a terminal result", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let removed = false;
    const server = fakeOpenCode({
      "GET /api/session/active": () => ({}),
      "GET /api/session/:id": () => session("ses_parent"),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.shell], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/shell/sh_fixture": () => removed ? Response.json({ _tag: "ShellNotFoundError" }, { status: 404 }) : scoped({ id: "sh_fixture", status: "exited", metadata: { sessionID: "ses_parent" } }),
      "GET /api/shell/sh_fixture/output": ({ query }) => scoped({ output: query.get("cursor") === String(Number.MAX_SAFE_INTEGER) ? "" : "tail", size: 1000, cursor: 1000, truncated: false }),
      "DELETE /api/shell/sh_fixture": () => { removed = true; return undefined; },
    });
    const provider = server.provider();
    expect(await provider.taskOutput("ses_parent", "v2:ses_parent:call_shell", { tailBytes: 4 })).toEqual({ text: "tail", truncated: true, settled: false });
    await expect(provider.taskOutput("ses_parent", "/private/secret", { tailBytes: 4 })).rejects.toThrow(/unavailable/);
    await provider.stopTask("ses_parent", "v2:ses_parent:call_shell");
    expect(await provider.reconcileBackgroundTasks("ses_parent")).toEqual([expect.objectContaining({ status: "running", stateUncertain: true })]);
    expect(await provider.taskOutput("ses_parent", "v2:ses_parent:call_shell", { tailBytes: 4 })).toBeNull();
    expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(1);
    expect(server.calls.filter(call => call.path.startsWith("/api/shell/")).every(call => call.query.get("location[directory]") === WORKSPACE)).toBe(true);
  });
  test("foreign shell ownership refuses output and removal; already-missing removal 204 alone settles nothing", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let owner = "other-parent";
    const server = fakeOpenCode({
      "GET /api/session/active": () => ({}),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.shell], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/shell/sh_fixture": () => scoped({ id: "sh_fixture", metadata: { sessionID: owner } }),
      // A removal can race another client's removal after our ownership read.
      "DELETE /api/shell/sh_fixture": () => undefined,
    });
    const provider = server.provider();
    await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_shell")).rejects.toThrow(/no longer confirmed/);
    await expect(provider.taskOutput("ses_parent", "v2:ses_parent:call_shell", { tailBytes: 10 })).rejects.toThrow(/unavailable/);
    expect(server.calls.some(call => call.method === "DELETE" || call.path.endsWith("/output"))).toBe(false);
    owner = "ses_parent";
    await provider.stopTask("ses_parent", "v2:ses_parent:call_shell");
    expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(1);
    expect(await provider.reconcileBackgroundTasks("ses_parent")).toEqual([expect.objectContaining({ status: "running" })]);
  });
  test("background reconciliation reads pending results even when the parent is idle; active absence is uncertainty", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let pending = false;
    let active = true;
    const server = fakeOpenCode({
      "GET /api/session/active": () => active ? { ses_child: { status: "running" } } : {},
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: pending ? [fixture.pending] : [] }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    });
    const provider = server.provider();
    expect(await provider.reconcileBackgroundTasks("ses_parent")).toEqual([expect.objectContaining({ status: "running", stateUncertain: false })]);
    active = false;
    expect(await provider.reconcileBackgroundTasks("ses_parent")).toEqual([expect.objectContaining({ status: "running", stateUncertain: true })]);
    pending = true;
    expect(await provider.reconcileBackgroundTasks("ses_parent")).toEqual([expect.objectContaining({ status: "completed", summary: "Fixture checked.", stateUncertain: false })]);
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  });
  test("concurrent recovery requests for one parent share every read", async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const server = fakeOpenCode({
      "GET /api/session/active": () => ({}),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_parent/message": async () => { await wait; return { data: [], cursor: {} }; },
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    });
    const provider = server.provider();
    const first = provider.reconcileBackgroundTasks("ses_parent");
    const second = provider.reconcileBackgroundTasks("ses_parent");
    release();
    expect(await Promise.all([first, second])).toEqual([[], []]);
    expect(server.requests("GET", "/api/session/ses_parent/inbox")).toHaveLength(1);
    expect(server.requests("GET", "/api/session/active")).toHaveLength(1);
    expect(server.requests("GET", "/api/session/ses_parent/message")).toHaveLength(1);
  });
  test("successive background reconciliations reuse complete history but refresh current execution and pending inbox", async () => {
    const encoder = new TextEncoder();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`));
      } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/active": () => ({}),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_parent/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    });
    const provider = server.provider();
    const controller = new AbortController();
    const events = provider.events(controller.signal)[Symbol.asyncIterator]();
    await events.next();
    await provider.reconcileBackgroundTasks("ses_parent");
    await provider.reconcileBackgroundTasks("ses_parent");
    expect(server.requests("GET", "/api/session/ses_parent/message")).toHaveLength(1);
    expect(server.requests("GET", "/api/session/active")).toHaveLength(2);
    expect(server.requests("GET", "/api/session/ses_parent/inbox")).toHaveLength(2);
    expect(server.calls.some(call => call.method !== "GET")).toBe(false);
    const updated = events.next();
    stream.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "session.message.content.updated", data: { sessionID: "ses_parent", messageID: "msg_new", content: [] } })}\n\n`));
    await updated;
    await provider.reconcileBackgroundTasks("ses_parent");
    expect(server.requests("GET", "/api/session/ses_parent/message")).toHaveLength(2);
    stream.close();
    await events.next();
    // With no stream/replay guarantee, even unchanged history must be read.
    await provider.reconcileBackgroundTasks("ses_parent");
    expect(server.requests("GET", "/api/session/ses_parent/message")).toHaveLength(3);
    await provider.dispose();
  });
  test("disposing cancels and awaits owned background reads without touching provider execution", async () => {
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const server = fakeOpenCode({
      "GET /api/session/active": () => ({}),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/ses_parent/message": call => new Promise((_resolve, reject) => {
        signal = call.signal;
        release = () => reject(new DOMException("Stopped read", "AbortError"));
        signal.addEventListener("abort", release, { once: true });
        started();
      }),
    });
    const provider = server.provider();
    const pending = provider.reconcileBackgroundTasks("ses_parent").catch(() => undefined);
    await reading;
    try {
      await provider.dispose();
      expect(signal?.aborted).toBe(true);
    } finally { release(); await pending; }
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  });
  test("a notification for an existing verified child is readable without its creation event", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const event = { id: "evt_notice", type: "session.inbox.enqueued", created: 41, location: { directory: WORKSPACE }, data: { sessionID: "ses_parent", inboxID: "msg_result", item: fixture.pending } };
    const server = fakeOpenCode({
      "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent" }),
      "GET /api/event": () => new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } }),
    });
    const updates = [];
    for await (const event of server.provider().events(new AbortController().signal)) updates.push(...event.updates);
    expect(updates).toContainEqual({ kind: "upsert", item: expect.objectContaining({ type: "background_task", resultId: "msg_result", status: "completed", summary: "Fixture checked." }) });
    expect(updates.some(update => update.kind === "upsert" && update.item.type === "notice")).toBe(false);
  });
  test("complete history correlates a worker result before paging, without duplicating its envelope", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const server = fakeOpenCode({
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch, fixture.stored], cursor: {} }),
    });
    const provider = server.provider();
    const latest = await provider.listMessages("ses_parent", { limit: 1 });
    expect(latest.items).toContainEqual(expect.objectContaining({ type: "background_task", status: "completed", summary: "Fixture checked.", childConversationId: "ses_child" }));
    expect(latest.items.some(item => item.type === "notice")).toBe(false);
    const older = await provider.listMessages("ses_parent", { limit: 1, cursor: latest.nextCursor });
    expect(older.items.filter(item => item.type === "background_task")).toEqual([]);
    expect(latest.completeItems?.filter(item => item.type === "background_task")).toHaveLength(1);
    expect(latest.completeItems).toContainEqual(expect.objectContaining({ type: "tool", id: "tool:call_worker", status: "completed" }));
  });

  test("notification-first stored history retires its provisional result when the older launch is restated", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const server = fakeOpenCode({
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.stored, { ...fixture.launch, time: { created: 50 } }], cursor: {} }),
    });
    const result = await server.provider().listMessages("ses_parent", { limit: 100 });
    expect(result.items.filter(item => item.type === "background_task")).toEqual([expect.objectContaining({ toolUseId: "call_worker", resultId: "msg_result", status: "completed" })]);
  });
  test("the first history page carries every live worker and its out-of-page launcher aliases", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const server = fakeOpenCode({
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch, { id: "latest", type: "user", time: { created: 100 }, text: "Later prompt" }], cursor: {} }),
    });
    const provider = server.provider();
    const result = await provider.listMessages("ses_parent", { limit: 1 });
    expect(result.items).toContainEqual(expect.objectContaining({ id: "tool:call_worker", status: "completed" }));
    expect(result.items.filter(item => item.type === "background_task")).toHaveLength(1);
    const older = await provider.listMessages("ses_parent", { cursor: result.nextCursor, limit: 1 });
    expect(new Set([...result.items, ...older.items].filter(item => item.type === "background_task").map(item => item.id)).size).toBe(1);
  });
  test("historical execution intervals correlate six launchers to five explicit results without reordering tools", async () => {
    const launch = historyWorkerLaunch, result = historyWorkerResult;
    const messages = [launch("call_a", 10), launch("call_b", 20), result("result_0", 40),
      ...[1, 2, 3, 4].flatMap(i => [launch(`call_${i}`, i * 100), result(`result_${i}`, i * 100 + 40)])];
    const server = fakeOpenCode({
      "GET /api/session/active": () => ({}),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/ses_parent/message": () => ({ data: messages, cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [30, 130, 230, 330, 430].map(at => ({ id: `idle_${at}`, type: "idle", time: { created: at } })), cursor: {} }),
    });
    const provider = server.provider();
    try {
      const page = await provider.listMessages("ses_parent", { limit: 100 });
      const tasks = page.items.filter(item => item.type === "background_task");
      expect(tasks).toHaveLength(5);
      expect(tasks).toContainEqual(expect.objectContaining({ toolUseId: "call_a", toolUseIds: ["call_a", "call_b"], status: "completed", resultId: "result_0" }));
      for (const i of [1, 2, 3, 4]) expect(tasks).toContainEqual(expect.objectContaining({ toolUseId: `call_${i}`, status: "completed", resultId: `result_${i}` }));
      expect(page.items.filter(item => item.type === "tool").map(item => item.id)).toEqual(["tool:call_a", "tool:call_b", "tool:call_1", "tool:call_2", "tool:call_3", "tool:call_4"]);
      const recovered = await provider.reconcileBackgroundTasks("ses_parent");
      expect(recovered).toHaveLength(5);
      expect(recovered.every(item => item.status === "completed" && item.stateUncertain === false)).toBe(true);
    } finally { await provider.dispose(); }
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  });

  for (const combined of [true, false]) test(`historical interleaved execution clocks correlate aliases ${combined ? "within one assistant" : "across assistants"} without reordering tools`, async () => {
    // Native content is appended on tool.input.started; time.ran is recorded
    // on tool.called. Input order therefore need not be execution-start order.
    const first = historyWorkerLaunch("call_a", 10), second = historyWorkerLaunch("call_b", 12);
    first.content[0]!.time = { created: 10, ran: 21, completed: 23 };
    second.content[0]!.time = { created: 12, ran: 13, completed: 15 };
    const launches = combined ? [{ ...first, content: [...first.content, ...second.content] }] : [first, second];
    const server = workerHistoryServer([...launches, historyWorkerResult("result", 40)],
      [3, 30].map(at => ({ id: `idle_${at}`, type: "idle", time: { created: at } })));
    const provider = server.provider();
    try {
      const page = await provider.listMessages("ses_parent", { limit: 100 });
      expect(page.completeItems?.filter(item => item.type === "tool").map(item => item.id)).toEqual(["tool:call_a", "tool:call_b"]);
      for (const tasks of [page.completeItems?.filter(item => item.type === "background_task"), await provider.reconcileBackgroundTasks("ses_parent")]) {
        expect(tasks).toEqual([expect.objectContaining({ toolUseId: "call_a", toolUseIds: ["call_a", "call_b"], status: "completed", stateUncertain: false, resultId: "result" })]);
      }
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { await provider.dispose(); }
  });

  for (const combined of [true, false]) for (const order of [
    ["new_a", "old", "new_b"], ["new_a", "new_b", "old"], ["old", "new_a", "new_b"],
    ["old", "new_b", "new_a"], ["new_b", "new_a", "old"], ["new_b", "old", "new_a"],
  ]) test(`historical supersession preserves separate intervals: ${order.join("/")} ${combined ? "combined" : "split"} assistants with pending results`, async () => {
    const starts: Record<string, number> = { old: 13, new_a: 21, new_b: 25 };
    const launches = order.map((call, index) => {
      const message = historyWorkerLaunch(call, index + 2);
      message.content[0]!.time = { created: index + 2, ran: starts[call]!, completed: starts[call]! + 1 };
      return message;
    });
    const messages: unknown[] = combined ? [{ ...launches[0]!, content: launches.flatMap(message => message.content) }] : launches;
    const reports = [historyWorkerResult("old_result", 18), historyWorkerResult("new_result", 40)];
    const pending: unknown[] = reports.map(({ id, time, text, metadata }) => ({ id, time, type: "synthetic", delivery: "steer", payload: { text, metadata } }));
    const server = workerHistoryServer(messages, [17, 30].map(at => ({ id: `idle_${at}`, type: "idle", time: { created: at } })), pending);
    const aliases = order.filter(call => call !== "old");
    const expected = [
      { toolUseId: "old", toolUseIds: undefined, status: "completed" as const, stateUncertain: false, resultId: "old_result" },
      { toolUseId: aliases[0], toolUseIds: aliases, status: "completed" as const, stateUncertain: false, resultId: "new_result" },
    ].sort((left, right) => left.toolUseId!.localeCompare(right.toolUseId!));
    const recovering = server.provider();
    try {
      const tasks = await recovering.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(tasks).toHaveLength(2);
      expect(tasks.map(({ toolUseId, toolUseIds, status, stateUncertain, resultId }) => ({ toolUseId, toolUseIds, status, stateUncertain, resultId }))
        .sort((left, right) => (left.toolUseId ?? "").localeCompare(right.toolUseId ?? ""))).toEqual(expected);
    } finally { await recovering.dispose(); }
    // Delivery changes the envelope, not the occurrence/result identities.
    messages.push(...reports);
    pending.length = 0;
    const history = server.provider();
    try {
      const page = await history.listMessages("ses_parent", { limit: 100 });
      expect(page.completeItems?.filter(item => item.type === "tool").map(item => item.id)).toEqual(order.map(call => `tool:${call}`));
      expect(page.completeItems?.filter(item => item.type === "background_task")
        .map(({ toolUseId, toolUseIds, status, stateUncertain, resultId }) => ({ toolUseId, toolUseIds, status, stateUncertain, resultId }))
        .sort((left, right) => (left.toolUseId ?? "").localeCompare(right.toolUseId ?? ""))).toEqual(expected);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { await history.dispose(); }
  });

  for (const completed of [false, true]) for (const reversed of [false, true]) for (const combined of [false, true]) {
    for (const clock of ["straddling", "missing-acceptance", "missing-start", "tied-boundary", "tied-window", "reversed-window"] as const) {
      test(`permission-delayed admission stays uncertain: ${clock}/${completed ? "completed" : "running"}/${reversed ? "reversed" : "forward"}/${combined ? "combined" : "split"}`, async () => {
        const old = historyWorkerLaunch("old", 3), delayed = historyWorkerLaunch("delayed", 4);
        old.content[0]!.time = { created: 3, ran: 13, completed: 16 };
        const time: { created?: number; ran?: number; completed?: number } = { created: 4, ran: 15, completed: 23 };
        if (clock === "missing-acceptance") delete time.completed;
        if (clock === "missing-start") { delete time.created; delete time.ran; }
        if (clock === "tied-boundary") time.completed = 17;
        if (clock === "tied-window") time.completed = 15;
        if (clock === "reversed-window") time.completed = 14;
        delayed.content[0]!.time = time as typeof delayed.content[0]["time"];
        const launches = reversed ? [delayed, old] : [old, delayed];
        const messages: unknown[] = combined ? [{ ...old, content: launches.flatMap(message => message.content) }] : launches;
        const reports = [historyWorkerResult("old_result", 18), ...(completed ? [historyWorkerResult("new_result", 40)] : [])];
        const pending = reports.map(({ id, time, text, metadata }) => ({ id, time, type: "synthetic", delivery: "steer", payload: { text, metadata } }));
        const server = workerHistoryServer(messages, (completed ? [17, 30] : [17]).map(at => ({ id: `idle_${at}`, type: "idle", time: { created: at } })), pending);
        const provider = server.provider();
        try {
          const tasks = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
          const launches = tasks.filter(task => task.toolUseId);
          expect(launches).toHaveLength(2);
          expect(launches.every(task => task.status === "running" && task.stateUncertain && !task.toolUseIds && !task.resultId)).toBe(true);
          for (const report of reports) expect(tasks).toContainEqual(expect.objectContaining({ resultId: report.id, status: "completed" }));
          expect(tasks.filter(task => task.resultId).map(task => task.resultId).sort()).toEqual(reports.map(report => report.id).sort());
          expect(server.calls.every(call => call.method === "GET")).toBe(true);
        } finally { await provider.dispose(); }
      });
    }
  }

  for (const boundary of [true, false]) for (const reportAt of [18, 23]) test(`permission-delayed admission cannot consume a pre-acceptance/tied report as the only launch: ${boundary}/${reportAt}`, async () => {
    const delayed = historyWorkerLaunch("delayed", 4);
    delayed.content[0]!.time = { created: 4, ran: 15, completed: 23 };
    const server = workerHistoryServer([delayed, historyWorkerResult("old_result", reportAt)], boundary ? [{ id: "idle", type: "idle", time: { created: 17 } }] : []);
    const provider = server.provider();
    try {
      const tasks = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(tasks).toHaveLength(2);
      expect(tasks.find(task => task.toolUseId === "delayed")).toMatchObject({ status: "running", stateUncertain: true });
      expect(tasks.find(task => task.toolUseId === "delayed")?.resultId).toBeUndefined();
      expect(tasks.find(task => task.resultId === "old_result")?.toolUseId).toBeUndefined();
    } finally { await provider.dispose(); }
  });

  for (const reversed of [false, true]) for (const clock of ["between", "at-earlier", "at-later", "tied", "missing-launch", "missing-boundary"] as const) {
    test(`historical interval coordinates reject ${clock} ambiguity in ${reversed ? "reverse" : "forward"} execution order`, async () => {
      const first = historyWorkerLaunch("call_a", 10), second = historyWorkerLaunch("call_b", 12);
      first.content[0]!.time = { created: 10, ran: reversed ? 21 : 13, completed: 23 };
      second.content[0]!.time = { created: 12, ran: reversed ? 13 : 21, completed: 23 };
      if (clock === "tied") second.content[0]!.time.ran = first.content[0]!.time.ran;
      if (clock === "missing-launch") second.content[0]!.time = {} as typeof second.content[0]["time"];
      const boundary = { id: "idle_boundary", type: "idle", time: { created: clock === "at-earlier" ? 13 : clock === "at-later" ? 21 : 17 } as { created?: number } };
      if (clock === "missing-boundary") delete boundary.time.created;
      const server = workerHistoryServer([{ ...first, content: [...first.content, ...second.content] }, historyWorkerResult("result", 40)], [boundary]);
      const provider = server.provider();
      try {
        const tasks = await provider.reconcileBackgroundTasks("ses_parent");
        const launches = tasks.filter(task => task.toolUseId);
        expect(launches).toHaveLength(2);
        expect(launches.every(task => !task.toolUseIds && task.status === "running" && task.stateUncertain && !task.resultId)).toBe(true);
      } finally { await provider.dispose(); }
    });
  }

  for (const reversed of [false, true]) test(`historical boundary-separated ${reversed ? "reverse" : "forward"} starts cannot apply an old result to the new execution`, async () => {
    const older = historyWorkerLaunch("call_old", 10), newer = historyWorkerLaunch("call_new", 12);
    older.content[0]!.time = { created: 10, ran: 13, completed: 15 };
    newer.content[0]!.time = { created: 12, ran: 21, completed: 23 };
    const content = reversed ? [...newer.content, ...older.content] : [...older.content, ...newer.content];
    const server = workerHistoryServer([{ ...older, content }, historyWorkerResult("result_old", 16)], [{ id: "idle_old", type: "idle", time: { created: 17 } }]);
    const provider = server.provider();
    try {
      const tasks = await provider.reconcileBackgroundTasks("ses_parent");
      expect(tasks).toHaveLength(2);
      expect(tasks.find(task => task.toolUseId === "call_old")).toMatchObject({ status: "completed", resultId: "result_old", stateUncertain: false });
      expect(tasks.find(task => task.toolUseId === "call_new")).toMatchObject({ status: "running" });
      expect(tasks.find(task => task.toolUseId === "call_new")?.resultId).toBeUndefined();
    } finally { await provider.dispose(); }
  });

  test("historical aliases without an explicit result remain uncertain and cannot stop a continued child", async () => {
    const server = workerHistoryServer([historyWorkerLaunch("call_a", 10), historyWorkerLaunch("call_b", 20)],
      [{ id: "idle", type: "idle", time: { created: 30 } }]);
    const provider = server.provider();
    try {
      expect(await provider.reconcileBackgroundTasks("ses_parent")).toEqual([expect.objectContaining({ toolUseIds: ["call_a", "call_b"], status: "running", stateUncertain: true })]);
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_a")).rejects.toThrow(/no longer confirmed/);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { await provider.dispose(); }
  });

  for (const clock of ["missing-launch", "tied-launch", "tied-boundary", "missing-boundary"] as const) test(`historical interval grouping preserves ambiguity with ${clock} clocks`, async () => {
    const first = historyWorkerLaunch("call_a", 10), second = historyWorkerLaunch("call_b", 20);
    const idle = { id: "idle", type: "idle", time: { created: 30 } as { created?: number } };
    if (clock === "missing-launch") second.content[0]!.time = {} as typeof second.content[0]["time"];
    if (clock === "tied-launch") second.content[0]!.time = { ...first.content[0]!.time };
    if (clock === "tied-boundary") second.content[0]!.time.ran = 30;
    if (clock === "missing-boundary") delete idle.time.created;
    const server = workerHistoryServer([first, second, historyWorkerResult("result", 40)], [idle]);
    const provider = server.provider();
    try {
      const tasks = await provider.reconcileBackgroundTasks("ses_parent");
      const launchers = tasks.filter(task => task.toolUseId);
      expect(launchers).toHaveLength(2);
      expect(launchers.every(task => task.status === "running" && task.stateUncertain && !task.resultId)).toBe(true);
    } finally { await provider.dispose(); }
  });

  for (const datedBeforeNewRun of [true, false]) test(`historical delayed result ${datedBeforeNewRun ? "settles only the old run and deduplicates" : "cannot choose a run from a late clock"}`, async () => {
    const report = historyWorkerResult("result", datedBeforeNewRun ? 40 : 140);
    const server = workerHistoryServer([historyWorkerLaunch("call_a", 10), historyWorkerLaunch("call_b", 20), historyWorkerLaunch("call_new", 100), report, report],
      [{ id: "idle", type: "idle", time: { created: 30 } }]);
    const provider = server.provider();
    try {
      const tasks = await provider.reconcileBackgroundTasks("ses_parent");
      expect(tasks.filter(task => task.resultId === "result")).toHaveLength(1);
      expect(tasks).toContainEqual(expect.objectContaining({ toolUseId: "call_new", status: "running" }));
      expect(tasks.find(task => task.toolUseId === "call_new")?.resultId).toBeUndefined();
      const old = tasks.find(task => task.toolUseId === "call_a");
      expect(old?.toolUseIds).toEqual(["call_a", "call_b"]);
      expect(old?.status).toBe(datedBeforeNewRun ? "completed" : "running");
      expect(old?.resultId).toBe(datedBeforeNewRun ? "result" : undefined);
    } finally { await provider.dispose(); }
  });

  test("child execution boundaries separate reused occurrences; an ambiguous delayed notice settles neither", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const notice = { ...fixture.stored, time: { created: 70 } };
    const server = fakeOpenCode({
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch, fixture.converted, notice], cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [{ id: "msg_idle", type: "idle", outcome: "succeeded", time: { created: 40 } }, { id: "msg_continue", type: "user", text: "Check another fixture", time: { created: 50 } }], cursor: {} }),
    });
    const result = await server.provider().listMessages("ses_parent", { limit: 50 });
    expect(result.items.filter(item => item.type === "background_task" && item.status === "running")).toEqual([
      expect.objectContaining({ toolUseId: "call_worker", stateUncertain: true }),
      expect.objectContaining({ toolUseId: "call_converted", stateUncertain: true }),
    ]);
    expect(result.items.filter(item => item.type === "background_task" && item.status === "completed")).toEqual([expect.objectContaining({ summary: "Fixture checked." })]);
    const provider = server.provider();
    expect((await provider.reconcileBackgroundTasks("ses_parent")).filter(item => item.status === "running").every(item => item.stateUncertain)).toBe(true);
    await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_converted")).rejects.toThrow(/no longer confirmed/);
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  });

  test("lists only the workspace's sessions, following the cursor", async () => {
    const server = fakeOpenCode({
      "GET /api/session": ({ query }) => query.get("cursor") === "page2"
        ? { data: [session("ses_3", { parentID: "ses_1", title: "child" })], cursor: { next: null } }
        : { data: [session("ses_1"), session("ses_other", { location: { directory: "/elsewhere" } })], cursor: { next: "page2" } },
    });
    expect(await server.provider().listSessions()).toEqual([
      { id: "ses_1", title: "Session ses_1", directory: WORKSPACE, createdAt: 100, updatedAt: 200 },
      { id: "ses_3", title: "child", directory: WORKSPACE, createdAt: 100, updatedAt: 200, parentId: "ses_1" },
    ]);
    const [first, second] = server.requests("GET", "/api/session");
    expect(first?.query.get("directory")).toBe(WORKSPACE);
    expect(first?.query.get("order")).toBe("desc");
    expect(second?.query.get("cursor")).toBe("page2");
    expect(second?.query.has("order")).toBe(false);
  });

  test("creates a session in the workspace with the chosen agent and model", async () => {
    const server = fakeOpenCode({
      "POST /api/session": ({ body }) => session("ses_new", { title: undefined, ...(body as Record<string, unknown>) }),
    });
    const created = await server.provider().createSession("ignored", { mode: "plan", model: { providerId: "berget", modelId: "think" }, variant: "high" });
    expect(created).toMatchObject({ id: "ses_new", directory: WORKSPACE, title: "" });
    expect(server.requests("POST", "/api/session")[0]?.body).toEqual({
      location: { directory: WORKSPACE },
      agent: "plan",
      model: { id: "think", providerID: "berget", variant: "high" },
    });
  });

  test("a foreign or missing session is null; a server failure propagates", async () => {
    const server = fakeOpenCode({
      "GET /api/session/:id": ({ path }) => path.endsWith("ses_foreign")
        ? session("ses_foreign", { location: { directory: "/elsewhere" } })
        : path.endsWith("ses_gone") ? notFound("ses_gone")
        : path.endsWith("ses_ok") ? session("ses_ok")
        : new Response("boom", { status: 500 }),
    });
    const provider = server.provider();
    expect(await provider.getSession("ses_foreign")).toBeNull();
    expect(await provider.getSession("ses_gone")).toBeNull();
    expect(await provider.getSession("ses_ok")).toMatchObject({ id: "ses_ok", directory: WORKSPACE });
    await expect(provider.getSession("ses_broken")).rejects.toThrow("session lookup failed");
  });

  test("rename patches the title and reads the session back", async () => {
    let title = "old";
    const server = fakeOpenCode({
      "PATCH /api/session/:id": ({ body }) => { title = (body as { title: string }).title; return undefined; },
      "GET /api/session/:id": () => session("ses_1", { title }),
    });
    expect(await server.provider().renameSession("ses_1", "new name")).toMatchObject({ id: "ses_1", title: "new name" });
    expect(server.requests("PATCH", "/api/session/ses_1")[0]?.body).toEqual({ title: "new name" });
  });

  test("configuration comes from the session record, with 'default' as no variant", async () => {
    const server = fakeOpenCode({
      "GET /api/session/:id": ({ path }) => session(path.slice(path.lastIndexOf("/") + 1), path.endsWith("ses_high")
        ? { agent: "plan", model: { id: "think", providerID: "berget", variant: "high" } }
        : { agent: "build", model: { id: "flash", providerID: "opencode", variant: "default" } }),
    });
    expect(await server.provider().getConversationConfiguration("ses_high")).toEqual({ model: { providerId: "berget", modelId: "think" }, mode: "plan", variant: "high" });
    expect(await server.provider().getConversationConfiguration("ses_plain")).toEqual({ model: { providerId: "opencode", modelId: "flash" }, mode: "build" });
  });

  test("switching the model rides the variant on the model reference", async () => {
    const server = fakeOpenCode({ "POST /api/session/:id/model": () => undefined });
    await server.provider().switchModel("ses_1", { providerId: "berget", modelId: "think" }, "high");
    await server.provider().switchModel("ses_1", { providerId: "berget", modelId: "think" });
    expect(server.requests("POST", "/api/session/ses_1/model").map(call => call.body)).toEqual([
      { model: { id: "think", providerID: "berget", variant: "high" } },
      { model: { id: "think", providerID: "berget" } },
    ]);
  });
});

describe("OpenCode 2.x provider: history", () => {
  function historyServer(overrides: Record<string, unknown> = {}) {
    return fakeOpenCode({
      "GET /api/session/:id": () => session("ses_h", overrides),
      "GET /api/session/:id/message": ({ query }) => query.get("cursor") === "more"
        ? { data: STORED.slice(3), cursor: { next: null } }
        : { data: STORED.slice(0, 3), cursor: { next: "more" } },
    });
  }

  test("reads the whole transcript across pages and maps every record kind", async () => {
    const server = historyServer();
    const page = await server.provider().listMessages("ses_h", { limit: 50 });
    const [first, second] = server.requests("GET", "/api/session/ses_h/message");
    expect(first?.query.get("order")).toBe("asc");
    expect(second?.query.get("cursor")).toBe("more");
    expect(second?.query.has("order")).toBe(false);

    const kinds = page.items.map(item => item.type);
    expect(kinds).toEqual(["user_message", "reasoning", "tool", "assistant_message", "reasoning", "assistant_message", "assistant_message", "user_message"]);
    const tool = page.items.find(item => item.type === "tool");
    expect(tool).toMatchObject({ name: "read", status: "completed" });
    expect(tool?.id).toMatch(/^tool:call_/);
    const carriers = page.items.filter(item => item.type === "assistant_message" && item.markdown === "");
    expect(carriers).toHaveLength(2);
    expect(carriers[0]).toMatchObject({ model: { providerId: "opencode", modelId: "mimo-v2.6-flash-free" }, agent: "build", usage: { input: expect.any(Number), costUsd: 0 } });
    expect(page.completeItems).toEqual(page.items);
    expect(page.nextCursor).toBeUndefined();
  });

  test("accounting pairs each assistant record with the prompt before it", async () => {
    const page = await historyServer().provider().listMessages("ses_h", { limit: 50 });
    const promptId = String(STORED[0]!.id);
    expect(page.accounting).toHaveLength(2);
    for (const entry of page.accounting) {
      expect(entry.promptId).toBe(promptId);
      expect(entry.model).toBe("mimo-v2.6-flash-free");
      expect(entry.usage?.input).toBeGreaterThan(0);
    }
  });

  test("session aggregate survives paging/revert independently of visible message costs; zero and missing stay distinct", async () => {
    const provider = historyServer({ cost: 1.75, revert: { messageID: String(STORED[0]!.id) } }).provider();
    const reverted = await provider.listMessages("ses_h", { limit: 1 });
    expect(reverted.items).toEqual([]);
    expect(reverted.accounting).toEqual([]);
    expect(reverted.sessionCostUsd).toBe(1.75); // includes native compaction/reverted spend, not the visible page's sum
    const zero = historyServer({ cost: 0 });
    expect((await zero.provider().listMessages("ses_h", { limit: 1 })).sessionCostUsd).toBe(0);
    expect(zero.requests("GET", "/api/session/ses_h")).toHaveLength(1); // reuse existing metadata read
    expect((await historyServer({ cost: undefined }).provider().listMessages("ses_h", { limit: 1 })).sessionCostUsd).toBeUndefined();
    expect((await historyServer({ cost: -1 }).provider().listMessages("ses_h", { limit: 1 })).sessionCostUsd).toBeUndefined();
  });

  test("pages locally from the newest record and continues from the cursor", async () => {
    const provider = historyServer().provider();
    const newest = await provider.listMessages("ses_h", { limit: 2 });
    expect(newest.items.map(item => item.type)).toEqual(["user_message"]);
    expect(newest.nextCursor).toBeDefined();
    const older = await provider.listMessages("ses_h", { cursor: newest.nextCursor, limit: 2 });
    expect(older.items.map(item => item.type)).toEqual(["reasoning", "tool", "assistant_message", "reasoning", "assistant_message", "assistant_message"]);
    expect(older.nextCursor).toBeDefined();
  });

  test("a staged revert hides the reverted suffix", async () => {
    const boundary = String(STORED[4]!.id);
    const page = await historyServer({ revert: { messageID: boundary } }).provider().listMessages("ses_h", { limit: 50 });
    expect(page.items.map(item => item.type)).not.toContain("idle");
    expect(page.items.filter(item => item.type === "user_message")).toHaveLength(1);
    expect(page.revertVisibility).toEqual({
      boundaryId: boundary,
      state: { staged: true, canUndo: true, canRedo: true, revertedMessages: [{ id: `message:${boundary}`, text: String(STORED[4]!.text) }] },
      excludedItemIds: [`message:${boundary}`],
    });
  });

  test("revert visibility authority is independent of the requested page; an unknown boundary grants no exclusions", async () => {
    const boundary = String(STORED[4]!.id);
    const provider = historyServer({ revert: { messageID: boundary } }).provider();
    const small = await provider.listMessages("ses_h", { limit: 1 });
    const large = await provider.listMessages("ses_h", { limit: 50 });
    expect(small.items).not.toEqual(large.items);
    expect(small.revertVisibility).toEqual(large.revertVisibility);
    expect((await historyServer({ revert: { messageID: "unknown-native-boundary" } }).provider().listMessages("ses_h", { limit: 1 })).revertVisibility).toEqual({
      boundaryId: "unknown-native-boundary",
      state: { staged: true, canUndo: false, canRedo: false, revertedMessages: [] },
      excludedItemIds: [],
    });
    expect((await historyServer().provider().listMessages("ses_h", { limit: 1 })).revertVisibility?.excludedItemIds).toEqual([]);
  });

  test("boundary revalidation distinguishes unknown native markers that have identical UI state and honors read cancellation", async () => {
    let marker = "unknown-native-A";
    const server = fakeOpenCode({
      "GET /api/session/:id": () => session("ses_h", { revert: { messageID: marker } }),
      "GET /api/session/:id/message": () => ({ data: STORED, cursor: { next: null } }),
    });
    const provider = server.provider();
    const page = await provider.listMessages("ses_h", { limit: 1 });
    marker = "unknown-native-B";
    const controller = new AbortController();
    expect(page.revertVisibility?.boundaryId).toBe("unknown-native-A");
    expect(await provider.getReversibleHistoryState("ses_h")).toEqual(page.revertVisibility!.state);
    expect(await provider.getHistoryRevertBoundary("ses_h", { signal: controller.signal })).toBe("unknown-native-B");
    controller.abort();
    await expect(provider.getHistoryRevertBoundary("ses_h", { signal: controller.signal })).rejects.toThrow();
  });

  test("complete visible history cannot prove delivery absence across a revert boundary", async () => {
    const boundary = String(STORED[0]!.id);
    const reverted = await historyServer({ revert: { messageID: boundary } }).provider().listMessages("ses_h", { limit: 50 });
    expect(reverted.completeItems).toEqual([]);
    expect(reverted.deliveryHistoryIncomplete).toBe(true);
    const unfiltered = await historyServer().provider().listMessages("ses_h", { limit: 50 });
    expect(unfiltered.deliveryHistoryIncomplete).toBeUndefined();
  });
});

describe("OpenCode 2.x provider: prompting and events", () => {
  test("a prompt switches model and agent first, then queues a client-minted message with file attachments", async () => {
    const server = fakeOpenCode({
      "POST /api/session/:id/model": () => undefined,
      "POST /api/session/:id/agent": () => undefined,
      "POST /api/session/:id/prompt": ({ body }) => ({ id: (body as { id: string }).id, sessionID: "ses_1", time: { created: 1 }, type: "user", payload: { text: (body as { text: string }).text }, delivery: "queue" }),
    });
    const result = await server.provider().prompt("ses_1", {
      id: "req-1",
      text: "hello",
      delivery: "queue",
      attachments: [{ id: "att_1", name: "shot.png", mimeType: "image/png", absolutePath: "/tmp/uatu/att_1.png" }],
      model: { providerId: "berget", modelId: "think" },
      mode: "plan",
      variant: "high",
    });
    expect(result.messageId).toMatch(/^msg_[0-9a-f]{26}$/);
    expect(server.calls.map(call => `${call.method} ${call.path}`)).toEqual([
      "POST /api/session/ses_1/model",
      "POST /api/session/ses_1/agent",
      "POST /api/session/ses_1/prompt",
    ]);
    expect(server.requests("POST", "/api/session/ses_1/agent")[0]?.body).toEqual({ agent: "plan" });
    expect(server.requests("POST", "/api/session/ses_1/prompt")[0]?.body).toEqual({
      id: result.messageId,
      text: "hello",
      files: [{ uri: "file:///tmp/uatu/att_1.png", name: "shot.png" }],
      delivery: "queue",
      resume: true,
    });
  });

  test("a steer is handed to the inbox with resume, and never retargets the session it steers", async () => {
    // opencode-v2-steering D6: a mid-turn switchModel/switchAgent would
    // retarget the turn being steered, so a steer carries no model or mode
    // to the session and runs under whatever it has at delivery.
    const server = fakeOpenCode({
      "POST /api/session/:id/model": () => undefined,
      "POST /api/session/:id/agent": () => undefined,
      "POST /api/session/:id/prompt": ({ body }) => ({ id: (body as { id: string }).id, sessionID: "ses_1", time: { created: 1 }, type: "user", payload: { text: (body as { text: string }).text }, delivery: "steer" }),
    });
    const result = await server.provider().prompt("ses_1", {
      id: "req-s",
      text: "stop, do the other thing",
      delivery: "steer",
      attachments: [{ id: "att_1", name: "shot.png", mimeType: "image/png", absolutePath: "/tmp/uatu/att_1.png" }],
      model: { providerId: "berget", modelId: "think" },
      mode: "plan",
      variant: "high",
    });
    expect(result.messageId).toMatch(/^msg_[0-9a-f]{26}$/);
    expect(server.calls.map(call => `${call.method} ${call.path}`)).toEqual(["POST /api/session/ses_1/prompt"]);
    expect(server.requests("POST", "/api/session/ses_1/prompt")[0]?.body).toEqual({
      id: result.messageId,
      text: "stop, do the other thing",
      files: [{ uri: "file:///tmp/uatu/att_1.png", name: "shot.png" }],
      delivery: "steer",
      resume: true,
    });
  });

  test("interrupt passes resume through, and sends none when the caller names none", async () => {
    const server = fakeOpenCode({ "POST /api/session/:id/interrupt": () => ({ interrupted: true }) });
    const provider = server.provider();
    await provider.interrupt("ses_1");
    await provider.interrupt("ses_1", { resume: false });
    await provider.interrupt("ses_1", { resume: true });
    // The pinned client carries `resume` as a query parameter.
    expect(server.requests("POST", "/api/session/ses_1/interrupt").map(call => call.query.get("resume"))).toEqual([null, "false", "true"]);
  });

  test("the pending inbox lists the user's steers only, as pending entries", async () => {
    const server = fakeOpenCode({
      "GET /api/session/:id/inbox": () => ({ data: [
        { id: "msg_steer", sessionID: "ses_1", time: { created: 5 }, type: "user", payload: { text: "steer me", files: [{ mime: "image/png", name: "shot.png", source: { type: "uri", uri: "file:///tmp/uatu/11111111-2222-4333-8444-555555555555.png" } }] }, delivery: "steer" },
        { id: "msg_queued", sessionID: "ses_1", time: { created: 6 }, type: "user", payload: { text: "native queue" }, delivery: "queue" },
        { id: "msg_syn", sessionID: "ses_1", time: { created: 7 }, type: "synthetic", payload: { text: "note" }, delivery: "steer" },
        { id: "msg_cmp", sessionID: "ses_1", time: { created: 8 }, type: "compaction", payload: {}, delivery: "steer" },
        { id: "msg_mv", sessionID: "ses_1", time: { created: 9 }, type: "move", payload: { location: { directory: "/x" } }, delivery: "steer" },
      ] }),
    });
    expect(await server.provider().listPendingInbox("ses_1")).toEqual([
      { id: "msg_steer", text: "steer me", delivery: "steer", at: 5, attachments: [{ id: "11111111-2222-4333-8444-555555555555", name: "shot.png", mimeType: "image/png" }] },
    ]);
  });

  test("cancelling an inbox entry hits its route", async () => {
    const server = fakeOpenCode({ "DELETE /api/session/:id/inbox/:inboxId": () => undefined });
    await server.provider().cancelInbox("ses_1", "msg_steer");
    expect(server.requests("DELETE", "/api/session/ses_1/inbox/msg_steer")).toHaveLength(1);
  });

  for (const outcome of ["delivered", "response-lost"] as const) test(`real V2 withdrawal with ${outcome} cannot convert a steer using cached empty history`, async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let messages: unknown[] = [];
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller;
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`));
      } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses": () => session("ses"),
      "GET /api/session/ses/message": () => ({ data: messages, cursor: {} }),
      "GET /api/session/ses/inbox": () => ({ data: [] }),
      "POST /api/session/ses/prompt": ({ body }) => {
        const input = body as { id: string; text: string; delivery: string };
        return { id: input.id, sessionID: "ses", type: "user", time: { created: 1 }, payload: { text: input.text }, delivery: input.delivery };
      },
      // Native delivery has already removed the entry. Cancel's missing-id
      // acknowledgement is a no-op, not proof that it was cancelled.
      "DELETE /api/session/ses/inbox/:id": () => outcome === "response-lost" ? Response.json({ _tag: "UnknownError", message: "response lost" }, { status: 500 }) : undefined,
    });
    const provider = server.provider();
    const controller = new AbortController();
    const events = provider.events(controller.signal)[Symbol.asyncIterator]();
    const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, steerWithdrawTimeoutMs: 100 });
    try {
      await events.next();
      adapter.projectionForTests("ses").statusUpdate("running");
      const accepted = await adapter.prompt("ses", "original-request", "deliver once", undefined, undefined, undefined, undefined, "steer");
      expect((await provider.listMessages("ses", { limit: 50 })).completeItems).toEqual([]);
      const reads = server.requests("GET", "/api/session/ses/message").length;
      // Persist delivery without releasing its delayed stream event.
      if (outcome === "delivered") messages = [{ id: accepted.messageId, type: "user", text: "deliver once", time: { created: 2 } }];
      const conversion = await adapter.changeDelivery("ses", accepted.messageId, "convert", "queue").catch(error => error);
      const withdrawalReads = server.requests("GET", "/api/session/ses/message").length;
      const pending = [...adapter.pendingSteersForTests("ses")];
      const snapshot = await adapter.history("ses");
      const prompts = server.requests("POST", "/api/session/ses/prompt").length;
      // Complete the parent and cross the public admission lane with an
      // independent submission. An incorrectly re-held steer would dispatch
      // here with a new identity, duplicating the already-delivered text.
      adapter.projectionForTests("ses").statusUpdate("completed");
      await adapter.prompt("ses", "next-request", "independent next turn", undefined, undefined, undefined, undefined, "queue");
      expect(server.requests("POST", "/api/session/ses/prompt").filter(call => (call.body as { text: string }).text === "deliver once")).toHaveLength(1);
      expect(conversion).toBeInstanceOf(outcome === "delivered" ? SteerAlreadyDeliveredError : SteerWithdrawalUnconfirmedError);
      expect(withdrawalReads).toBe(reads + (outcome === "delivered" ? 1 : 0));
      if (outcome === "delivered") {
        expect(pending).toEqual([]);
        expect(snapshot.queued ?? []).toEqual([]);
      } else {
        // Empty history after an uncertain cancel response is not authority
        // to re-hold input; keep its original inspectable handle instead.
        expect(snapshot.queued).toEqual([expect.objectContaining({ id: accepted.messageId, requestId: "original-request", delivery: "steer", unconfirmed: true })]);
      }
      expect(prompts).toBe(1);
    } finally {
      stream.close();
      await events.next();
      await adapter.dispose();
    }
  });

  for (const overlap of ["before-pending", "during-resolved", "during-pending"] as const) for (const outcome of ["success", "error"] as const) test(`cancel ${outcome} fences ${overlap} history reads from later reuse`, async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let releaseCancel!: () => void, cancelStarted!: () => void, releaseHistory!: () => void, historyStarted!: () => void;
    const cancellation = new Promise<void>(resolve => { releaseCancel = resolve; });
    const cancelling = new Promise<void>(resolve => { cancelStarted = resolve; });
    const history = new Promise<void>(resolve => { releaseHistory = resolve; });
    const reading = new Promise<void>(resolve => { historyStarted = resolve; });
    let messages: unknown[] = [], reads = 0;
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller;
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`));
      } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses": () => session("ses"),
      "GET /api/session/ses/message": async () => {
        const snapshot = [...messages];
        if (++reads === 1) { historyStarted(); await history; }
        return { data: snapshot, cursor: {} };
      },
      "DELETE /api/session/ses/inbox/msg": async () => {
        cancelStarted(); await cancellation;
        return outcome === "error" ? Response.json({ _tag: "UnknownError", message: "response lost" }, { status: 500 }) : undefined;
      },
    });
    const provider = server.provider();
    const events = provider.events(new AbortController().signal)[Symbol.asyncIterator]();
    try {
      await events.next();
      const oldRead = overlap === "before-pending" ? provider.listMessages("ses", { limit: 50 }) : undefined;
      if (oldRead) await reading;
      const cancel = provider.cancelInbox("ses", "msg").then(() => undefined, error => error);
      await cancelling;
      const overlappingRead = oldRead ?? provider.listMessages("ses", { limit: 50 });
      await reading;
      if (overlap === "during-resolved") {
        releaseHistory();
        expect((await overlappingRead).completeItems).toEqual([]);
      }
      // Native delivery wins while both its event and the cancel response
      // are withheld. A pre-boundary read still owns an empty snapshot.
      messages = [{ id: "msg", type: "user", text: "delivered", time: { created: 2 } }];
      releaseCancel();
      const result = await cancel;
      if (outcome === "error") expect(result).toBeInstanceOf(Error);
      else expect(result).toBeUndefined();
      // The post-cancel read must finish independently of the older read.
      const fresh = await provider.listMessages("ses", { limit: 50 });
      expect(fresh.completeItems?.map(item => item.id)).toEqual(["message:msg"]);
      releaseHistory(); await overlappingRead;
      // Late completion cannot replace the new boundary's retained value.
      expect((await provider.listMessages("ses", { limit: 50 })).completeItems).toEqual(fresh.completeItems);
      expect(reads).toBe(2);
    } finally {
      releaseCancel(); releaseHistory();
      stream.close(); await events.next(); await provider.dispose();
    }
  });

  test("a retried prompt is the same message to OpenCode", async () => {
    const server = fakeOpenCode({ "POST /api/session/:id/prompt": ({ body }) => ({ id: (body as { id: string }).id, sessionID: "ses_1", time: { created: 1 }, type: "user", payload: { text: "x" }, delivery: "queue" }) });
    const first = await server.provider().prompt("ses_1", { id: "req-9", text: "x", delivery: "queue" });
    const second = await server.provider().prompt("ses_1", { id: "req-9", text: "x", delivery: "queue" });
    expect(second.messageId).toBe(first.messageId);
  });

  test("commands and compaction queue through their own routes; interrupt hits its route", async () => {
    const server = fakeOpenCode({
      "POST /api/session/:id/command": () => undefined,
      "POST /api/session/:id/compact": ({ body }) => ({ id: (body as { id: string }).id, sessionID: "ses_1", time: { created: 1 }, type: "compaction", payload: {}, delivery: "queue" }),
      "POST /api/session/:id/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider();
    // With no stream to name the server's row, the local id stands.
    const command = await provider.command("ses_1", { id: "req-2", name: "review", arguments: "branch" });
    const compaction = await provider.command("ses_1", { id: "req-3", name: "compact", arguments: "" });
    await provider.interrupt("ses_1");
    expect(command.messageId).toMatch(/^msg_[0-9a-f]{26}$/);
    expect(server.requests("POST", "/api/session/ses_1/command")[0]?.body).toEqual({ name: "review", text: "branch", delivery: "queue" });
    // Compaction carries the stable id like a prompt, so the inbox item is
    // the one this process already holds.
    expect(server.requests("POST", "/api/session/ses_1/compact")[0]?.body).toEqual({ id: compaction.messageId, delivery: "queue" });
    expect(compaction.messageId).toMatch(/^msg_[0-9a-f]{26}$/);
    expect(compaction.messageId).not.toBe(command.messageId);
    expect(server.requests("POST", "/api/session/ses_1/interrupt")).toHaveLength(1);
  });

  test("a skill runs as a prompt carrying the skill, its text opening with the mention", async () => {
    const server = fakeOpenCode({
      "GET /api/skill": () => scoped([skillInfo("openspec-apply-change")]),
      "POST /api/session/:id/prompt": ({ body }) => ({ id: (body as { id: string }).id, sessionID: "ses_1", time: { created: 1 }, type: "user", payload: {}, delivery: "queue" }),
    });
    const provider = server.provider();
    const withArguments = await provider.command("ses_1", { id: "req-s1", name: "openspec-apply-change", arguments: "my-change" });
    const bare = await provider.command("ses_1", { id: "req-s2", name: "openspec-apply-change", arguments: "" });
    // The row reads as what was sent, so the adapter's acceptance agrees with the stream's.
    expect(withArguments.text).toBe("@openspec-apply-change my-change");
    expect(bare.text).toBe("@openspec-apply-change");
    const prompts = server.requests("POST", "/api/session/ses_1/prompt");
    const mention = { start: 0, end: 22, text: "@openspec-apply-change" };
    expect(prompts[0]?.body).toEqual({ id: withArguments.messageId, text: "@openspec-apply-change my-change", skills: [{ id: "openspec-apply-change", mention }], delivery: "queue", resume: true });
    expect(prompts[1]?.body).toEqual({ id: bare.messageId, text: "@openspec-apply-change", skills: [{ id: "openspec-apply-change", mention }], delivery: "queue", resume: true });
    expect(server.requests("POST", "/api/session/ses_1/command")).toHaveLength(0);
  });

  test("a config command of the same name runs as a command, not the skill", async () => {
    const server = fakeOpenCode({
      "GET /api/command": () => scoped([{ name: "review" }]),
      "GET /api/skill": () => scoped([skillInfo("review")]),
      "POST /api/session/:id/command": () => undefined,
    });
    await server.provider().command("ses_1", { id: "req-r", name: "review", arguments: "branch" });
    expect(server.requests("POST", "/api/session/ses_1/command")[0]?.body).toEqual({ name: "review", text: "branch", delivery: "queue" });
    expect(server.requests("POST", "/api/session/ses_1/prompt")).toHaveLength(0);
  });

  test("a skill gone from the catalog at dispatch is refused by the server, never sent as prose", async () => {
    const server = fakeOpenCode({
      "POST /api/session/:id/command": () => Response.json({ _tag: "CommandNotFoundError", message: "Command not found: gone-skill" }, { status: 404 }),
    });
    await expect(server.provider().command("ses_1", { id: "req-g", name: "gone-skill", arguments: "" })).rejects.toThrow("gone-skill");
    expect(server.requests("POST", "/api/session/ses_1/prompt")).toHaveLength(0);
  });

  // A reload as the pinned client sees it: the reply, then (as a real 2.x
  // server does) the rebuilt location announcing its catalogs.
  async function reloadHarness(reply: () => unknown, options: { reloadSettleMs?: number } = {}) {
    const events = pushableEvents();
    const server = fakeOpenCode({ "GET /api/event": events.route, "POST /api/location/reload": reply });
    const provider = server.provider(WORKSPACE, options);
    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) {
        if (update.kind === "upsert" && update.item.type === "notice") seen.push(`notice ${update.item.level} ${update.item.message}`);
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
        if (update.kind === "status") seen.push(`status ${update.status}`);
      }
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    const announce = (type: string, directory = WORKSPACE) => events.frame({ id: `evt_${type}_${directory}`, created: 9, type, location: { directory }, data: {} });
    const settle = async (count: number) => {
      const deadline = Date.now() + 2_000;
      while (seen.length < count && Date.now() < deadline) await Bun.sleep(5);
    };
    const stop = async () => { controller.abort(); await pump; };
    return { server, provider, seen, announce, settle, stop };
  }

  test("/reload applies staged model and mode before reloading, since the adapter commits them", async () => {
    const server = fakeOpenCode({
      "POST /api/session/:id/model": () => undefined,
      "POST /api/session/:id/agent": () => undefined,
      "POST /api/location/reload": () => undefined,
    });
    const provider = server.provider(WORKSPACE, { reloadSettleMs: 20 });
    await provider.command("ses_1", { id: "req-reload-staged", name: "reload", arguments: "", model: { providerId: "berget", modelId: "think" }, mode: "plan", variant: "high" });
    const deadline = Date.now() + 2_000;
    while (server.requests("POST", "/api/location/reload").length === 0 && Date.now() < deadline) await Bun.sleep(5);
    expect(server.calls.map(call => `${call.method} ${call.path}`).filter(call => call.startsWith("POST"))).toEqual([
      "POST /api/session/ses_1/model",
      "POST /api/session/ses_1/agent",
      "POST /api/location/reload",
    ]);
    expect(server.requests("POST", "/api/session/ses_1/agent")[0]?.body).toEqual({ agent: "plan" });
  });

  test("/reload reports success once the rebuilt location announces its catalogs", async () => {
    const harness = await reloadHarness(() => undefined);
    const accepted = await harness.provider.command("ses_1", { id: "req-reload", name: "reload", arguments: "" });
    // The acceptance says what ran, so clients need not guess from their catalogs.
    expect(accepted.operation).toBe("reload");
    await harness.settle(1);
    expect(harness.seen).toEqual(["notice info Reloading OpenCode configuration…"]);
    // Another directory's rebuild, and this one's announcements before its
    // shutdown, say nothing about this workspace's reload.
    harness.announce("location.shutdown", "/elsewhere");
    harness.announce("command.updated", "/elsewhere");
    harness.announce("skill.updated", "/elsewhere");
    harness.announce("skill.updated");
    await Bun.sleep(40);
    expect(harness.seen).toHaveLength(1);
    harness.announce("location.shutdown");
    harness.announce("command.updated");
    harness.announce("skill.updated");
    await Bun.sleep(40);
    // Commands and skills alone are not the whole rebuild: models and modes too.
    expect(harness.seen).toHaveLength(1);
    harness.announce("model.updated");
    harness.announce("agent.updated");
    await harness.settle(4);
    expect(harness.seen.slice(1)).toEqual([`remove message:${accepted.messageId}`, "notice info Configuration reloaded", "status completed"]);
    expect(harness.server.requests("POST", "/api/location/reload")).toHaveLength(1);
    // The server's configuration, not the conversation: no session route.
    expect(harness.server.calls.filter(call => call.path.startsWith("/api/session/"))).toHaveLength(0);
    await harness.stop();
  });

  test("concurrent /reloads run one at a time, each settled by its own rebuild", async () => {
    const harness = await reloadHarness(() => undefined);
    await harness.provider.command("ses_1", { id: "req-first", name: "reload", arguments: "" });
    await harness.provider.command("ses_2", { id: "req-second", name: "reload", arguments: "" });
    await Bun.sleep(40);
    // The second waits for the first: its waiter must not see the first rebuild.
    expect(harness.server.requests("POST", "/api/location/reload")).toHaveLength(1);
    const done = () => harness.seen.filter(line => line === "notice info Configuration reloaded").length;
    const rebuild = () => ["location.shutdown", "command.updated", "skill.updated", "model.updated", "agent.updated"].forEach(type => harness.announce(type));
    rebuild();
    const deadline = Date.now() + 2_000;
    while (done() < 1 && Date.now() < deadline) await Bun.sleep(5);
    expect(done()).toBe(1);
    while (harness.server.requests("POST", "/api/location/reload").length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(harness.server.requests("POST", "/api/location/reload")).toHaveLength(2);
    await Bun.sleep(40);
    // Its reply alone does not settle it.
    expect(done()).toBe(1);
    rebuild();
    while (done() < 2 && Date.now() < deadline + 2_000) await Bun.sleep(5);
    expect(done()).toBe(2);
    await harness.stop();
  });

  test("/reload that OpenCode never confirms is reported as unconfirmed, not reloaded", async () => {
    const harness = await reloadHarness(() => undefined, { reloadSettleMs: 60 });
    const started = Date.now();
    await harness.provider.command("ses_1", { id: "req-quiet", name: "reload", arguments: "" });
    await harness.settle(4);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(harness.seen[2]).toStartWith("notice warning Reload sent, but OpenCode did not confirm its reloaded configuration");
    // Not the success path: the invoking client must not bank catalogs mid-rebuild.
    expect(harness.seen[3]).toBe("status failed");
    expect(harness.seen).not.toContain("notice info Configuration reloaded");
    await harness.stop();
  });

  test("/reload reports OpenCode's failure at once, with its message", async () => {
    const harness = await reloadHarness(() => Response.json({ _tag: "ServiceUnavailableError", service: "location", message: "bad config: opencode.json" }, { status: 503 }));
    const accepted = await harness.provider.command("ses_1", { id: "req-bad", name: "reload", arguments: "" });
    await harness.settle(4);
    expect(harness.seen).toEqual([
      "notice info Reloading OpenCode configuration…",
      `remove message:${accepted.messageId}`,
      "notice error Reloading the configuration failed: bad config: opencode.json",
      "status failed",
    ]);
    await harness.stop();
  });

  test("a skill or config command named compact runs as listed, not as compaction", async () => {
    const skillServer = fakeOpenCode({
      "GET /api/skill": () => scoped([skillInfo("compact")]),
      "POST /api/session/:id/prompt": ({ body }) => ({ id: (body as { id: string }).id, sessionID: "ses_1", time: { created: 1 }, type: "user", payload: {}, delivery: "queue" }),
    });
    const accepted = await skillServer.provider().command("ses_1", { id: "req-cs", name: "compact", arguments: "" });
    expect(accepted.text).toBe("@compact");
    expect(skillServer.requests("POST", "/api/session/ses_1/compact")).toHaveLength(0);

    const commandServer = fakeOpenCode({ "GET /api/command": () => scoped([{ name: "compact" }]), "POST /api/session/:id/command": () => undefined });
    await commandServer.provider().command("ses_1", { id: "req-cc", name: "compact", arguments: "" });
    expect(commandServer.requests("POST", "/api/session/ses_1/command")[0]?.body).toEqual({ name: "compact", text: "", delivery: "queue" });
    expect(commandServer.requests("POST", "/api/session/ses_1/compact")).toHaveLength(0);
  });

  test("dispatch runs the entry the text was classified against, whatever a later listing says", async () => {
    let skills = [skillInfo("compact")];
    let commands: Array<{ name: string }> = [{ name: "reload" }];
    const server = fakeOpenCode({
      "GET /api/skill": () => scoped(skills),
      "GET /api/command": () => scoped(commands),
      "POST /api/session/:id/prompt": () => Response.json({ _tag: "SkillNotFoundError", skill: "compact", message: "Skill not found: compact" }, { status: 404 }),
      "POST /api/session/:id/command": () => Response.json({ _tag: "CommandNotFoundError", message: "Command not found: reload" }, { status: 404 }),
    });
    const provider = server.provider();
    const classified = await provider.listCommands();
    const compactSkill = classified.find(entry => entry.name === "compact")!;
    const reloadCommand = classified.find(entry => entry.name === "reload")!;
    expect(compactSkill.kind).toBe("skill");
    // Both entries vanish, and another dispatch's listing now names the built-ins.
    skills = [];
    commands = [];
    const later = await provider.listCommands();
    expect(later.filter(entry => entry.name === "compact" || entry.name === "reload").map(entry => entry.kind)).toEqual(["command", "command"]);
    await expect(provider.command("ses_1", { id: "req-gone-skill", name: "compact", arguments: "", listed: compactSkill })).rejects.toThrow("Skill not found");
    await expect(provider.command("ses_1", { id: "req-gone-command", name: "reload", arguments: "", listed: reloadCommand })).rejects.toThrow("Command not found");
    // Sent as what the user chose, refused by OpenCode — never the built-ins.
    expect(server.requests("POST", "/api/session/ses_1/compact")).toHaveLength(0);
    expect(server.requests("POST", "/api/location/reload")).toHaveLength(0);
    // Dispatch reads no catalogs of its own when handed the entry.
    expect(server.requests("GET", "/api/skill")).toHaveLength(2);
  });

  test("a built-in entry handed back dispatches as the built-in", async () => {
    const server = fakeOpenCode({ "POST /api/location/reload": () => undefined });
    const provider = server.provider();
    const builtin = (await provider.listCommands()).find(entry => entry.name === "reload")!;
    await provider.command("ses_1", { id: "req-builtin", name: "reload", arguments: "", listed: builtin });
    await Bun.sleep(20);
    expect(server.requests("POST", "/api/location/reload")).toHaveLength(1);
  });

  test("a config command named reload shadows the built-in", async () => {
    const server = fakeOpenCode({ "GET /api/command": () => scoped([{ name: "reload" }]), "POST /api/session/:id/command": () => undefined });
    const accepted = await server.provider().command("ses_1", { id: "req-cr", name: "reload", arguments: "" });
    expect(accepted.operation).toBeUndefined();
    expect(server.requests("POST", "/api/session/ses_1/command")).toHaveLength(1);
    expect(server.requests("POST", "/api/location/reload")).toHaveLength(0);
  });

  // The stream as the pinned client reads it, with a handle to push frames
  // after the subscription is open.
  function pushableEvents() {
    const encoder = new TextEncoder();
    let push: ReadableStreamDefaultController<Uint8Array> | undefined;
    const frame = (event: Record<string, unknown>) => push?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    const route = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { push = controller; frame({ id: "evt_0", type: "server.connected", data: {} }); },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
    return { route, frame };
  }
  // The inbox delivering an entry: only then does its row join the timeline
  // (opencode-v2-steering D4). `enqueued` helpers below push both frames.
  const delivered = (inboxID: string, created = 10) => ({ id: `evt_${inboxID}_d`, created, type: "session.inbox.delivered", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID } });

  test("a slash command's row takes the inbox id the stream names, ahead of the 204", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": () => {
        // The server enqueues the item and announces it before answering,
        // with its own id and the expanded template as the text.
        events.frame({ id: "evt_1", created: 5, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: "msg_srv1", item: { type: "user", payload: { text: "Create or update AGENTS.md" }, delivery: "queue" } } });
        events.frame(delivered("msg_srv1", 6));
        return undefined;
      },
    });
    const provider = server.provider();
    const controller = new AbortController();
    const rows: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) if (update.kind === "upsert") rows.push(update.item.id);
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    expect(await provider.command("ses_1", { id: "req-5", name: "init", arguments: "" })).toEqual({ messageId: "msg_srv1" });
    // The enqueue named the row's id before the admission returned; the row
    // itself lands with the delivery that followed it.
    const deadline = Date.now() + 2_000;
    while (rows.length < 1 && Date.now() < deadline) await Bun.sleep(5);
    expect(rows).toEqual(["message:msg_srv1"]);
    controller.abort();
    await pump;
  });

  test("a server id that arrives after the window retires the local row", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({ "GET /api/event": events.route, "POST /api/session/:id/command": () => undefined });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) {
        if (update.kind === "upsert") seen.push(`upsert ${update.item.id}`);
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
      }
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    const accepted = await provider.command("ses_1", { id: "req-7", name: "init", arguments: "" });
    expect(accepted.messageId).toMatch(/^msg_[0-9a-f]{26}$/);
    // The stream names the row only now, after the caller's own upsert.
    events.frame({ id: "evt_9", created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: "msg_late", item: { type: "user", payload: { text: "Create or update AGENTS.md" }, delivery: "queue" } } });
    events.frame(delivered("msg_late", 10));
    const deadline = Date.now() + 2_000;
    while (seen.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`remove message:${accepted.messageId}`, "upsert message:msg_late"]);
    controller.abort();
    await pump;
  });

  test("a late row goes to the oldest admission; a newer waiter takes the next one", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({ "GET /api/event": events.route, "POST /api/session/:id/command": () => undefined });
    // B's window has to outlast the wait for A's late row below, which is real
    // time a loaded machine can stretch; A's window simply passes first.
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 500 });
    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) {
        if (update.kind === "upsert") seen.push(`upsert ${update.item.id}`);
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
      }
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    const enqueued = (inboxID: string) => { events.frame({ id: `evt_${inboxID}`, created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID, item: { type: "user", payload: { text: "expanded" }, delivery: "queue" } } }); events.frame(delivered(inboxID)); };
    const a = await provider.command("ses_1", { id: "req-a", name: "init", arguments: "" });
    // B is admitted while A's row is still on its way.
    const b = provider.command("ses_1", { id: "req-b", name: "review", arguments: "" });
    await Bun.sleep(5);
    enqueued("msg_a");
    let deadline = Date.now() + 2_000;
    while (seen.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`remove message:${a.messageId}`, "upsert message:msg_a"]);
    enqueued("msg_b");
    expect(await b).toEqual({ messageId: "msg_b" });
    deadline = Date.now() + 2_000;
    while (seen.length < 3 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`remove message:${a.messageId}`, "upsert message:msg_a", "upsert message:msg_b"]);
    controller.abort();
    await pump;
  });

  test("several admissions past their window take their rows in admission order", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({ "GET /api/event": events.route, "POST /api/session/:id/command": () => undefined });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) {
        if (update.kind === "upsert") seen.push(`upsert ${update.item.id}`);
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
      }
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    const enqueued = (inboxID: string) => { events.frame({ id: `evt_${inboxID}`, created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID, item: { type: "user", payload: { text: "expanded" }, delivery: "queue" } } }); events.frame(delivered(inboxID)); };
    const a = await provider.command("ses_1", { id: "req-a2", name: "init", arguments: "" });
    const b = await provider.command("ses_1", { id: "req-b2", name: "review", arguments: "" });
    enqueued("msg_a");
    enqueued("msg_b");
    const deadline = Date.now() + 2_000;
    while (seen.length < 4 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`remove message:${a.messageId}`, "upsert message:msg_a", `remove message:${b.messageId}`, "upsert message:msg_b"]);
    controller.abort();
    await pump;
  });

  test("a refusal that lands after the window reaches the stream: placeholder gone, refusal shown, turn failed, no claim on the next row", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": async () => { await Bun.sleep(60); return Response.json({ _tag: "CommandNotFoundError", message: "Command not found: nope" }, { status: 404 }); },
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) {
        if (update.kind === "upsert") seen.push(`upsert ${update.item.id}${update.item.type === "notice" ? ` ${update.item.level}` : ""}`);
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
        if (update.kind === "status") seen.push(`status ${update.status}`);
      }
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    const accepted = await provider.command("ses_1", { id: "req-n", name: "nope", arguments: "" });
    expect(accepted.messageId).toMatch(/^msg_/);
    let deadline = Date.now() + 2_000;
    while (seen.length < 3 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`remove message:${accepted.messageId}`, `upsert notice:${accepted.messageId}:refused error`, "status failed"]);
    events.frame({ id: "evt_x", created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: "msg_x", item: { type: "user", payload: { text: "someone else's prompt" }, delivery: "queue" } } });
    events.frame(delivered("msg_x", 10));
    deadline = Date.now() + 2_000;
    while (seen.length < 4 && Date.now() < deadline) await Bun.sleep(5);
    await Bun.sleep(30);
    expect(seen.slice(3)).toEqual(["upsert message:msg_x"]);
    controller.abort();
    await pump;
  });

  test("a lost response after the window is not a refusal: the admission stays and its row retires the placeholder", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": async () => { await Bun.sleep(60); throw new TypeError("fetch failed"); },
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) {
        if (update.kind === "upsert") seen.push(`upsert ${update.item.id}`);
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
        if (update.kind === "status") seen.push(`status ${update.status}`);
      }
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    const accepted = await provider.command("ses_1", { id: "req-t", name: "init", arguments: "" });
    await Bun.sleep(120);
    expect(seen).toEqual([]);
    events.frame({ id: "evt_t", created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: "msg_t", item: { type: "user", payload: { text: "expanded" }, delivery: "queue" } } });
    events.frame(delivered("msg_t", 10));
    const deadline = Date.now() + 2_000;
    while (seen.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`remove message:${accepted.messageId}`, "upsert message:msg_t"]);
    controller.abort();
    await pump;
  });

  test("a prompt's own row never satisfies a waiting command admission", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": () => undefined,
      "POST /api/session/:id/prompt": ({ body }) => ({ id: (body as { id: string }).id, sessionID: "ses_1", time: { created: 1 }, type: "user", payload: { text: "x" }, delivery: "queue" }),
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) {
        if (update.kind === "upsert") seen.push(`upsert ${update.item.id}`);
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
      }
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    const enqueued = (inboxID: string) => { events.frame({ id: `evt_${inboxID}`, created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID, item: { type: "user", payload: { text: "t" }, delivery: "queue" } } }); events.frame(delivered(inboxID)); };
    const command = await provider.command("ses_1", { id: "req-c", name: "init", arguments: "" });
    const prompt = await provider.prompt("ses_1", { id: "req-p", text: "x", delivery: "queue" });
    enqueued(prompt.messageId);
    enqueued("msg_cmd");
    const deadline = Date.now() + 2_000;
    while (seen.length < 3 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`upsert message:${prompt.messageId}`, `remove message:${command.messageId}`, "upsert message:msg_cmd"]);
    controller.abort();
    await pump;
  });

  test("a prompt's row announced before the prompt is answered is still a prompt's", async () => {
    const events = pushableEvents();
    const enqueued = (inboxID: string) => { events.frame({ id: `evt_${inboxID}`, created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID, item: { type: "user", payload: { text: "t" }, delivery: "queue" } } }); events.frame(delivered(inboxID)); };
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": () => undefined,
      // The server announces the row, then takes its time answering.
      "POST /api/session/:id/prompt": async ({ body }) => { const id = (body as { id: string }).id; enqueued(id); await Bun.sleep(30); return { id, sessionID: "ses_1", time: { created: 1 }, type: "user", payload: { text: "x" }, delivery: "queue" }; },
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) {
        if (update.kind === "upsert") seen.push(`upsert ${update.item.id}`);
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
      }
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    const command = await provider.command("ses_1", { id: "req-c3", name: "init", arguments: "" });
    const prompt = await provider.prompt("ses_1", { id: "req-p3", text: "x", delivery: "queue" });
    enqueued("msg_cmd3");
    const deadline = Date.now() + 2_000;
    while (seen.length < 3 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`upsert message:${prompt.messageId}`, `remove message:${command.messageId}`, "upsert message:msg_cmd3"]);
    controller.abort();
    await pump;
  });

  test("a refusal that lands while the stream is down goes out on the next stream", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": async () => { await Bun.sleep(80); return Response.json({ _tag: "CommandNotFoundError", message: "Command not found: nope" }, { status: 404 }); },
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    const first = new AbortController();
    const firstPump = (async () => { for await (const _ of provider.events(first.signal)) { /* drain */ } })();
    const accepted = await provider.command("ses_1", { id: "req-d", name: "nope", arguments: "" });
    first.abort();
    await firstPump;
    await Bun.sleep(120);
    const second = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(second.signal)) for (const update of event.updates) {
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
        if (update.kind === "status") seen.push(`status ${update.status}`);
      }
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    const deadline = Date.now() + 2_000;
    while (seen.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`remove message:${accepted.messageId}`, "status failed"]);
    second.abort();
    await pump;
  });

  test("a stream that ends during the window leaves no record for the next stream to misapply", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({ "GET /api/event": events.route, "POST /api/session/:id/command": () => undefined });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 120 });
    const first = new AbortController();
    const firstPump = (async () => { for await (const _ of provider.events(first.signal)) { /* drain */ } })();
    await Bun.sleep(10);
    const admission = provider.command("ses_1", { id: "req-g", name: "init", arguments: "" });
    // The stream dies mid-window; the window then closes on its own.
    await Bun.sleep(30);
    first.abort();
    await firstPump;
    const accepted = await admission;
    expect(accepted.messageId).toMatch(/^msg_[0-9a-f]{26}$/);
    const second = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(second.signal)) for (const update of event.updates) {
        if (update.kind === "upsert") seen.push(`upsert ${update.item.id}`);
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
      }
    })();
    await Bun.sleep(20);
    events.frame({ id: "evt_z", created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: "msg_z", item: { type: "user", payload: { text: "next command" }, delivery: "queue" } } });
    events.frame(delivered("msg_z", 10));
    const deadline = Date.now() + 2_000;
    while (seen.length < 1 && Date.now() < deadline) await Bun.sleep(5);
    await Bun.sleep(30);
    expect(seen).toEqual(["upsert message:msg_z"]);
    second.abort();
    await pump;
  });

  test("a refusal after a window the stream did not outlive still reaches the next stream", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": async () => { await Bun.sleep(200); return Response.json({ _tag: "CommandNotFoundError", message: "Command not found: nope" }, { status: 404 }); },
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 120 });
    const first = new AbortController();
    const firstPump = (async () => { for await (const _ of provider.events(first.signal)) { /* drain */ } })();
    await Bun.sleep(10);
    const admission = provider.command("ses_1", { id: "req-h", name: "nope", arguments: "" });
    await Bun.sleep(30);
    first.abort();
    await firstPump;
    const accepted = await admission;
    expect(accepted.messageId).toMatch(/^msg_[0-9a-f]{26}$/);
    await Bun.sleep(150);
    const second = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(second.signal)) for (const update of event.updates) {
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
        if (update.kind === "status") seen.push(`status ${update.status}`);
      }
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    const deadline = Date.now() + 2_000;
    while (seen.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`remove message:${accepted.messageId}`, "status failed"]);
    second.abort();
    await pump;
  });

  test("a command dispatched with no stream that is refused after the window is reconciled once a stream starts", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": async () => { await Bun.sleep(60); return Response.json({ _tag: "CommandNotFoundError", message: "Command not found: nope" }, { status: 404 }); },
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    // No stream yet: the pump is starting up or reconnecting.
    const accepted = await provider.command("ses_1", { id: "req-n2", name: "nope", arguments: "" });
    expect(accepted.messageId).toMatch(/^msg_[0-9a-f]{26}$/);
    await Bun.sleep(80);
    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) {
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
        if (update.kind === "status") seen.push(`status ${update.status}`);
      }
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    const deadline = Date.now() + 2_000;
    while (seen.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`remove message:${accepted.messageId}`, "status failed"]);
    controller.abort();
    await pump;
  });

  test("a command admitted before the stream's first frame waits on nothing and leaves no record", async () => {
    const encoder = new TextEncoder();
    let push: ReadableStreamDefaultController<Uint8Array> | undefined;
    const frame = (event: Record<string, unknown>) => push?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    const server = fakeOpenCode({
      // The subscription opens, but its first frame takes its time.
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { push = controller; setTimeout(() => frame({ id: "evt_0", type: "server.connected", data: {} }), 80); } }), { status: 200, headers: { "content-type": "text/event-stream" } }),
      "POST /api/session/:id/command": () => undefined,
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) {
        if (update.kind === "upsert") seen.push(`upsert ${update.item.id}`);
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
      }
    })();
    await Bun.sleep(10);
    const accepted = await provider.command("ses_1", { id: "req-pre", name: "init", arguments: "" });
    expect(accepted.messageId).toMatch(/^msg_[0-9a-f]{26}$/);
    await Bun.sleep(100);
    frame({ id: "evt_q", created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: "msg_q", item: { type: "user", payload: { text: "next command" }, delivery: "queue" } } });
    frame(delivered("msg_q", 10));
    const deadline = Date.now() + 2_000;
    while (seen.length < 1 && Date.now() < deadline) await Bun.sleep(5);
    await Bun.sleep(30);
    expect(seen).toEqual(["upsert message:msg_q"]);
    controller.abort();
    await pump;
  });

  test("a command admitted before the handshake still takes a row the stream delivers after it", async () => {
    const encoder = new TextEncoder();
    let push: ReadableStreamDefaultController<Uint8Array> | undefined;
    const frame = (event: Record<string, unknown>) => push?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { push = controller; setTimeout(() => frame({ id: "evt_0", type: "server.connected", data: {} }), 80); } }), { status: 200, headers: { "content-type": "text/event-stream" } }),
      "POST /api/session/:id/command": () => undefined,
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 500 });
    const controller = new AbortController();
    const pump = (async () => { for await (const _ of provider.events(controller.signal)) { /* drain */ } })();
    await Bun.sleep(10);
    const admission = provider.command("ses_1", { id: "req-hs", name: "init", arguments: "" });
    await Bun.sleep(120);
    frame({ id: "evt_h", created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: "msg_h", item: { type: "user", payload: { text: "expanded" }, delivery: "queue" } } });
    frame(delivered("msg_h", 10));
    expect(await admission).toEqual({ messageId: "msg_h" });
    controller.abort();
    await pump;
  });

  test("a connection refused after the window reaches the stream like a server refusal", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": async () => { await Bun.sleep(60); throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); },
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) {
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
        if (update.kind === "status") seen.push(`status ${update.status}`);
      }
    })();
    await Bun.sleep(10);
    const accepted = await provider.command("ses_1", { id: "req-cr", name: "init", arguments: "" });
    const deadline = Date.now() + 2_000;
    while (seen.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`remove message:${accepted.messageId}`, "status failed"]);
    controller.abort();
    await pump;
  });

  test("a compaction's inbox item never satisfies a waiting command admission", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": () => undefined,
      "POST /api/session/:id/compact": ({ body }) => ({ id: (body as { id: string }).id, sessionID: "ses_1", time: { created: 1 }, type: "compaction", payload: {}, delivery: "queue" }),
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) {
        if (update.kind === "upsert") seen.push(`upsert ${update.item.id}`);
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
      }
    })();
    await Bun.sleep(10);
    const command = await provider.command("ses_1", { id: "req-c9", name: "init", arguments: "" });
    const compaction = await provider.command("ses_1", { id: "req-k9", name: "compact", arguments: "" });
    // As 2.0.13 announces it: a compaction item, which is no row at all.
    events.frame({ id: "evt_k1", created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: compaction.messageId, item: { type: "compaction", payload: {}, delivery: "queue" } } });
    // And the shape the finding supposed: a user row under the compaction's id.
    events.frame({ id: "evt_k2", created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: compaction.messageId, item: { type: "user", payload: { text: "compact" }, delivery: "queue" } } });
    events.frame(delivered(compaction.messageId, 10));
    events.frame({ id: "evt_k3", created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: "msg_cmd9", item: { type: "user", payload: { text: "expanded" }, delivery: "queue" } } });
    events.frame(delivered("msg_cmd9", 10));
    const deadline = Date.now() + 2_000;
    while (seen.length < 3 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`upsert message:${compaction.messageId}`, `remove message:${command.messageId}`, "upsert message:msg_cmd9"]);
    controller.abort();
    await pump;
  });

  test("an admission still waiting when the stream ends claims nothing on the next stream", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({ "GET /api/event": events.route, "POST /api/session/:id/command": () => undefined });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    const first = new AbortController();
    const firstPump = (async () => { for await (const _ of provider.events(first.signal)) { /* drain */ } })();
    await provider.command("ses_1", { id: "req-s", name: "init", arguments: "" });
    first.abort();
    await firstPump;
    const second = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(second.signal)) for (const update of event.updates) {
        if (update.kind === "upsert") seen.push(`upsert ${update.item.id}`);
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
      }
    })();
    await Bun.sleep(20);
    events.frame({ id: "evt_y", created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: "msg_y", item: { type: "user", payload: { text: "later" }, delivery: "queue" } } });
    events.frame(delivered("msg_y", 10));
    const deadline = Date.now() + 2_000;
    while (seen.length < 1 && Date.now() < deadline) await Bun.sleep(5);
    await Bun.sleep(30);
    expect(seen).toEqual(["upsert message:msg_y"]);
    second.abort();
    await pump;
  });

  test("a slash command the stream never names keeps its local id once the window closes", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({ "GET /api/event": events.route, "POST /api/session/:id/command": () => undefined });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    const controller = new AbortController();
    const pump = (async () => { for await (const _ of provider.events(controller.signal)) { /* drain */ } })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    const started = Date.now();
    const accepted = await provider.command("ses_1", { id: "req-6", name: "init", arguments: "" });
    expect(accepted.messageId).toMatch(/^msg_[0-9a-f]{26}$/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    controller.abort();
    await pump;
  });

  test("a lost response inside the window is not a refusal: the row, or the window, decides", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": async () => { await Bun.sleep(10); throw new TypeError("fetch failed"); },
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 500 });
    const controller = new AbortController();
    const pump = (async () => { for await (const _ of provider.events(controller.signal)) { /* drain */ } })();
    await Bun.sleep(10);
    const admission = provider.command("ses_1", { id: "req-l", name: "init", arguments: "" });
    await Bun.sleep(40);
    events.frame({ id: "evt_l", created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: "msg_l", item: { type: "user", payload: { text: "expanded" }, delivery: "queue" } } });
    events.frame(delivered("msg_l", 10));
    expect(await admission).toEqual({ messageId: "msg_l" });
    controller.abort();
    await pump;
  });

  test("a refused connection inside the window is a refusal even with a stream listening", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); },
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 500 });
    const controller = new AbortController();
    const pump = (async () => { for await (const _ of provider.events(controller.signal)) { /* drain */ } })();
    await Bun.sleep(10);
    const started = Date.now();
    // The client wraps it as a transport error; the refusal sits in its cause.
    await expect(provider.command("ses_1", { id: "req-r", name: "init", arguments: "" })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(400);
    controller.abort();
    await pump;
  });

  test("an invalid command rejects within the admission window", async () => {
    const server = fakeOpenCode({ "POST /api/session/:id/command": () => Response.json({ _tag: "CommandNotFoundError", message: "Command not found: nope" }, { status: 404 }) });
    await expect(server.provider().command("ses_1", { id: "req-4", name: "nope", arguments: "" })).rejects.toThrow();
  });

  test("events stream from /api/event, normalized and scoped, until the signal aborts", async () => {
    const frames = [
      { id: "evt_1", type: "server.connected", data: {} },
      { id: "evt_2", created: 5, type: "session.execution.started", data: { sessionID: "ses_1" } },
      { id: "evt_3", created: 6, type: "session.text.delta", location: { directory: "/elsewhere" }, data: { sessionID: "ses_x", assistantMessageID: "msg_x", ordinal: 0, delta: "not ours" } },
      { id: "evt_4", created: 7, type: "session.step.started", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", assistantMessageID: "msg_a", agent: "build", model: { id: "flash", providerID: "opencode" }, started: 7 } },
    ];
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } }),
    });
    const controller = new AbortController();
    const seen: Array<{ type: string; outcome: string; conversationId?: string; turns?: number }> = [];
    for await (const event of server.provider().events(controller.signal)) {
      seen.push({ type: event.eventType, outcome: event.outcome, conversationId: event.conversationId, turns: event.notificationTurns?.length });
      if (seen.length === frames.length) controller.abort();
    }
    expect(seen).toEqual([
      { type: "server.connected", outcome: "ignored", conversationId: undefined, turns: undefined },
      { type: "session.execution.started", outcome: "handled", conversationId: "ses_1", turns: undefined },
      { type: "session.text.delta", outcome: "ignored", conversationId: undefined, turns: undefined },
      { type: "session.step.started", outcome: "handled", conversationId: "ses_1", turns: 1 },
    ]);
    expect(server.requests("GET", "/api/event")).toHaveLength(1);
  });
});

describe("OpenCode 2.x provider: permissions and forms", () => {
  test("pending permissions come from the workspace list with their patterns and owner", async () => {
    const server = fakeOpenCode({
      "GET /api/permission/request": () => scoped([
        { id: "per_1", sessionID: "ses_1", action: "external_directory", resources: ["/etc/*"], save: ["/etc/*"], source: { type: "tool", messageID: "msg_a", id: "call_1" } },
        { id: "per_2", sessionID: "ses_2", action: "edit", resources: ["src/a.ts"], metadata: { diff: "--- a\n+++ b\n" } },
        { id: "per_3", sessionID: "ses_1", action: "tracker_create_issue", resources: ["*"], save: ["*"], metadata: {}, source: { type: "tool", messageID: "msg_b", id: "call_2" } },
      ]),
      // A server named `external` must not claim the built-in
      // external_directory ask above.
      "GET /api/mcp": () => scoped([{ name: "tracker", status: { status: "connected" } }, { name: "external", status: { status: "connected" } }]),
    });
    expect(await server.provider().listPermissions()).toEqual([
      // `source` names the tool row the request belongs to; a card rebuilt
      // from this list must be able to show the call it would allow.
      { requestId: "per_1", conversationId: "ses_1", action: "external_directory", resources: ["/etc/*"], alwaysPatterns: ["/etc/*"], sourceToolId: "tool:call_1" },
      { requestId: "per_2", conversationId: "ses_2", action: "edit", resources: ["src/a.ts"], alwaysPatterns: [], diff: "--- a\n+++ b\n" },
      // An MCP tool's action resolves against the reported servers, so the
      // recovered card names the server as a live one would.
      { requestId: "per_3", conversationId: "ses_1", action: "tracker_create_issue", resources: ["*"], alwaysPatterns: ["*"], sourceToolId: "tool:call_2", mcp: { server: "tracker", tool: "create_issue" } },
    ]);
    expect(server.calls[0]?.query.get("location[directory]")).toBe(WORKSPACE);
  });

  test("a live ask for an MCP tool carries its server and tool; a built-in ask carries none", async () => {
    const encoder = new TextEncoder();
    let push: ReadableStreamDefaultController<Uint8Array> | undefined;
    const events = {
      frame: (event: Record<string, unknown>) => push?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
      route: () => new Response(new ReadableStream<Uint8Array>({ start(controller) { push = controller; controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "evt_0", type: "server.connected", data: {} })}\n\n`)); } }), { status: 200, headers: { "content-type": "text/event-stream" } }),
    };
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "GET /api/mcp": () => scoped([{ name: "tracker", status: { status: "connected" } }]),
    });
    const provider = server.provider();
    const controller = new AbortController();
    const seen: Array<Record<string, unknown>> = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) if (update.kind === "upsert" && update.item.type === "permission") seen.push(update.item as unknown as Record<string, unknown>);
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    events.frame({ id: "evt_1", created: 1, type: "permission.asked", location: { directory: WORKSPACE }, data: { id: "per_1", sessionID: "ses_1", action: "tracker_create_issue", resources: ["*"], save: ["*"], metadata: {}, source: { type: "tool", messageID: "msg_a", id: "call_1" } } });
    events.frame({ id: "evt_2", created: 2, type: "permission.asked", location: { directory: WORKSPACE }, data: { id: "per_2", sessionID: "ses_1", action: "bash", resources: ["git status"], save: ["git status *"], metadata: {} } });
    events.frame({ id: "evt_3", created: 3, type: "permission.asked", location: { directory: WORKSPACE }, data: { id: "per_3", sessionID: "ses_1", action: "tracker_directory", resources: ["/etc/*"], save: ["/etc/*"], metadata: {} } });
    for (let i = 0; i < 400 && seen.length < 3; i++) await Bun.sleep(5);
    controller.abort();
    await pump;
    expect(seen.map(item => ({ action: item.action, mcp: item.mcp }))).toEqual([
      { action: "tracker_create_issue", mcp: { server: "tracker", tool: "create_issue" } },
      // A built-in action, and an action over a path rather than a
      // wildcard, are not MCP asks and cost no lookup.
      { action: "bash", mcp: undefined },
      { action: "tracker_directory", mcp: undefined },
    ]);
    expect(server.requests("GET", "/api/mcp")).toHaveLength(1);
  });

  test("a permission reply is one decision on the request's own route", async () => {
    const server = fakeOpenCode({ "POST /api/session/:id/permission/:request/reply": () => undefined });
    await server.provider().replyPermission("ses_1", "per_1", "always");
    expect(server.requests("POST", "/api/session/ses_1/permission/per_1/reply").map(call => call.body)).toEqual([{ decision: "always" }]);
  });

  test("pending forms are structured questions with their owner and intro", async () => {
    const server = fakeOpenCode({
      "GET /api/form": () => scoped([{ id: "frm_1", sessionID: "ses_1", title: "Pick one", fields: [
        { key: "choice", title: "Which?", type: "string", options: [{ value: "a", label: "A" }], custom: true },
        { key: "many", title: "Several", type: "multiselect", options: [{ value: "x", label: "X" }] },
      ] }]),
    });
    expect(await server.provider().listQuestions()).toEqual([{
      requestId: "frm_1",
      conversationId: "ses_1",
      intro: "Pick one",
      questions: [
        { prompt: "Which?", header: "", options: [{ label: "A", description: "" }], multiple: false, allowFreeForm: true, optional: true },
        { prompt: "Several", header: "", options: [{ label: "X", description: "" }], multiple: true, allowFreeForm: false, optional: true },
      ],
    }]);
  });

  test("ordered answers fold back into the form's keyed answer, validated before the reply", async () => {
    const fields = [
      { key: "choice", type: "string", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], custom: true, required: true },
      { key: "many", type: "multiselect", options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }], minItems: 2, maxItems: 2 },
      { key: "sure", type: "boolean", required: true },
      { key: "count", type: "integer", minimum: 1, maximum: 10 },
      { key: "note", type: "string" },
    ];
    const server = fakeOpenCode({
      "GET /api/session/:id/form/:form": () => ({ id: "frm_1", sessionID: "ses_1", title: "t", fields, state: { status: "pending" } }),
      "POST /api/session/:id/form/:form/reply": () => undefined,
      "DELETE /api/session/:id/form/:form": () => undefined,
    });
    const provider = server.provider();
    await provider.replyQuestion("ses_1", "frm_1", [["B"], ["X", "Y"], ["Yes"], ["3"], ["free text"]]);
    expect(server.requests("POST", "/api/session/ses_1/form/frm_1/reply").map(call => call.body)).toEqual([{ answer: { choice: "b", many: ["x", "y"], sure: true, count: 3, note: "free text" } }]);

    await provider.replyQuestion("ses_1", "frm_1", [["something else"], [], ["No"], [], []]);
    expect(server.requests("POST", "/api/session/ses_1/form/frm_1/reply").at(-1)?.body).toEqual({ answer: { choice: "something else", sure: false } });

    await expect(provider.replyQuestion("ses_1", "frm_1", [["A"], ["X"], ["Yes"], ["2.5"], []])).rejects.toBeInstanceOf(InvalidQuestionAnswerError);
    await expect(provider.replyQuestion("ses_1", "frm_1", [["A"], ["Z"], ["Yes"], ["2"], []])).rejects.toBeInstanceOf(InvalidQuestionAnswerError);
    await expect(provider.replyQuestion("ses_1", "frm_1", [["A"], [], ["maybe"], ["2"], []])).rejects.toBeInstanceOf(InvalidQuestionAnswerError);
    await expect(provider.replyQuestion("ses_1", "frm_1", [["A"], [], ["Yes"], ["11"], []])).rejects.toBeInstanceOf(InvalidQuestionAnswerError);
    // One choice where the form wants two: refused here, not by the server.
    await expect(provider.replyQuestion("ses_1", "frm_1", [["A"], ["X"], ["Yes"], ["2"], []])).rejects.toThrow(/at least 2 choices/);
    expect(server.requests("POST", "/api/session/ses_1/form/frm_1/reply")).toHaveLength(2);

    await provider.rejectQuestion("ses_1", "frm_1");
    expect(server.requests("DELETE", "/api/session/ses_1/form/frm_1")).toHaveLength(1);
  });

  test("recovered forms drop unsupported fields, and the reply folds against the same filtered list", async () => {
    const fields = [
      { key: "login", type: "external", url: "https://example.test/login" },
      { key: "region", type: "string", title: "Region", options: [{ value: "eu", label: "EU" }] },
      { key: "token", type: "string", hidden: true },
    ];
    const server = fakeOpenCode({
      "GET /api/form": () => scoped([{ id: "frm_2", sessionID: "ses_1", title: "Setup", fields }]),
      "GET /api/session/:id/form/:form": () => ({ id: "frm_2", sessionID: "ses_1", title: "Setup", fields, state: { status: "pending" } }),
      "POST /api/session/:id/form/:form/reply": () => undefined,
    });
    const provider = server.provider();
    expect((await provider.listQuestions())[0]?.questions).toEqual([expect.objectContaining({ prompt: "Region" })]);
    await provider.replyQuestion("ses_1", "frm_2", [["EU"]]);
    expect(server.requests("POST", "/api/session/ses_1/form/frm_2/reply")[0]?.body).toEqual({ answer: { region: "eu" } });
  });

  test("a recovered form with no supported field is a cancel-only card, and its reply cancels the form", async () => {
    const fields = [{ key: "login", type: "external", url: "https://example.test/login" }];
    const server = fakeOpenCode({
      "GET /api/form": () => scoped([{ id: "frm_3", sessionID: "ses_1", title: "Sign in", fields }]),
      "GET /api/session/:id/form/:form": () => ({ id: "frm_3", sessionID: "ses_1", title: "Sign in", fields, state: { status: "pending" } }),
      "POST /api/session/:id/form/:form/reply": () => undefined,
      "DELETE /api/session/:id/form/:form": () => undefined,
    });
    const provider = server.provider();
    expect((await provider.listQuestions())[0]).toMatchObject({ intro: "Sign in", link: "https://example.test/login", questions: [{ options: [{ label: "Cancel this form" }] }] });
    await provider.replyQuestion("ses_1", "frm_3", [["Cancel this form"]]);
    expect(server.requests("DELETE", "/api/session/ses_1/form/frm_3")).toHaveLength(1);
    expect(server.requests("POST", "/api/session/ses_1/form/frm_3/reply")).toHaveLength(0);
  });

  test("a multiselect over its maximum is refused; an optional one left empty is not", () => {
    const field = { key: "k", type: "multiselect", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], maxItems: 1 };
    expect(() => formAnswerFromChoices([field], [["A", "B"]])).toThrow(/at most 1 choices/);
    expect(formAnswerFromChoices([field], [[]])).toEqual({});
  });

  test("a required choice with no answer is refused", () => {
    expect(() => formAnswerFromChoices([{ key: "k", type: "string", required: true }], [[]])).toThrow(InvalidQuestionAnswerError);
    expect(formAnswerFromChoices([{ key: "k", type: "string" }], [[]])).toEqual({});
  });
});

describe("OpenCode 2.x provider: reversible history", () => {
  const userIds = STORED.filter(message => message.type === "user").map(message => String(message.id));

  function revertServer(revert?: { messageID: string }) {
    return fakeOpenCode({
      "GET /api/session/:id": () => session("ses_r", revert ? { revert } : {}),
      "GET /api/session/:id/message": () => ({ data: STORED, cursor: { next: null } }),
      "POST /api/session/:id/revert/stage": ({ body }) => ({ messageID: (body as { messageID: string }).messageID }),
      "DELETE /api/session/:id/revert": () => undefined,
    });
  }

  test("undo stages the latest user turn and restores it as a draft", async () => {
    const server = revertServer();
    const provider = server.provider();
    expect(await provider.getReversibleHistoryState("ses_r")).toEqual({ staged: false, canUndo: true, canRedo: false, revertedMessages: [] });
    const result = await provider.undo("ses_r");
    expect(server.requests("POST", "/api/session/ses_r/revert/stage")[0]?.body).toEqual({ messageID: userIds[1] });
    expect(result).toEqual({
      outcome: "changed",
      state: { staged: true, canUndo: true, canRedo: true, revertedMessages: [{ id: `message:${userIds[1]}`, text: "Reply with exactly: second" }] },
      restoredDraft: { text: "Reply with exactly: second" },
    });
  });

  test("repeated undo walks back; redo at the newest boundary clears the revert", async () => {
    const staged = revertServer({ messageID: userIds[1]! });
    const provider = staged.provider();
    expect(await provider.getReversibleHistoryState("ses_r")).toMatchObject({ staged: true, canUndo: true, canRedo: true });
    const back = await provider.undo("ses_r");
    expect(staged.requests("POST", "/api/session/ses_r/revert/stage")[0]?.body).toEqual({ messageID: userIds[0] });
    expect(back.state).toMatchObject({ staged: true, canUndo: false, canRedo: true });
    expect(back.state.revertedMessages.map(message => message.id)).toEqual(userIds.map(id => `message:${id}`));

    const redo = await provider.redo("ses_r");
    expect(staged.requests("DELETE", "/api/session/ses_r/revert")).toHaveLength(1);
    expect(redo).toEqual({ outcome: "changed", state: { staged: false, canUndo: true, canRedo: false, revertedMessages: [] } });
  });

  test("revert and restore address a specific turn, and refuse one out of reach", async () => {
    const server = revertServer({ messageID: userIds[1]! });
    const provider = server.provider();
    await expect(provider.revert("ses_r", `message:${userIds[1]}`)).rejects.toBeInstanceOf(ReversibleHistoryTargetError);
    const reverted = await provider.revert("ses_r", `message:${userIds[0]}`);
    expect(reverted.restoredDraft).toEqual({ text: String(STORED[0]!.text) });
    await expect(provider.restore("ses_r", "message:nope")).rejects.toBeInstanceOf(ReversibleHistoryTargetError);
    const restored = await provider.restore("ses_r", `message:${userIds[1]}`);
    expect(restored.state.staged).toBe(false);
  });

  test("nothing to undo or redo is reported, not staged", async () => {
    const empty = fakeOpenCode({
      "GET /api/session/:id": () => session("ses_e"),
      "GET /api/session/:id/message": () => ({ data: [], cursor: { next: null } }),
    });
    expect(await empty.provider().undo("ses_e")).toEqual({ outcome: "nothing-to-undo", state: { staged: false, canUndo: false, canRedo: false, revertedMessages: [] } });
    expect(await empty.provider().redo("ses_e")).toMatchObject({ outcome: "nothing-to-redo" });
    expect(empty.requests("POST", "/api/session/ses_e/revert/stage")).toHaveLength(0);
  });
});

describe("OpenCodeV2Provider accounts", () => {
  const model = (providerID: string, id: string) => ({ id, modelID: id, providerID, name: id, capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [], limit: { context: 8000, output: 800 }, status: "active", enabled: true, cost: [], time: { released: 0 } });

  test("login state is unknown before the catalog is read, ok while any model is offered, missing when none is", async () => {
    let models = [model("opencode", "free")];
    const { provider } = fakeOpenCode({
      "GET /api/model": () => scoped(models),
      "GET /api/provider": () => scoped([{ id: "opencode", name: "OpenCode Zen", activation: "auto", package: "x" }]),
    });
    const instance = provider();
    expect(instance.loginState()).toBe("unknown");
    await instance.listModels();
    expect(instance.loginState()).toBe("ok");
    models = [];
    await instance.listModels();
    expect(instance.loginState()).toBe("missing");
  });

  test("a removal or switch is replayed on this server by credential id; an addition is only re-read", async () => {
    const { provider, calls } = fakeOpenCode({
      "GET /api/model": () => scoped([model("opencode", "free")]),
      "GET /api/provider": () => scoped([{ id: "opencode", name: "OpenCode Zen", activation: "auto", package: "x" }]),
    });
    const instance = provider();
    await instance.accountsChanged({ kind: "added" });
    expect(calls.filter(call => call.path.includes("credential"))).toEqual([]);
    // The credential routes are absent here (as on 2.0.13): the 404s are ignored.
    await expect(instance.accountsChanged({ kind: "removed", target: "groq", credential: "cred_a" })).resolves.toBeUndefined();
    await expect(instance.accountsChanged({ kind: "activated", credential: "cred_b" })).resolves.toBeUndefined();
    expect(calls.filter(call => call.path.includes("credential")).map(call => `${call.method} ${call.path}`)).toEqual([
      "DELETE /api/credential/cred_a",
      "POST /api/credential/cred_b/activate",
    ]);
  });
});
