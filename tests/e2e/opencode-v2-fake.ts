// A scripted fake OpenCode 2.0.28 server for e2e (opencode-v2-steering D13).
//
// The REAL `OpenCodeV2Provider` and `ChatAdapter` talk to it over HTTP and
// SSE exactly as they talk to `opencode serve`: the routes the pinned
// `@opencode/client` calls, its envelopes (`{ data }` for single records,
// `{ location, data }` for scoped catalogs, `{ data, cursor }` for pages,
// `204` for void routes, tagged JSON errors), and the `/api/event` stream.
//
// Turns are scripted, not simulated: a turn starts when OpenCode would start
// one and then waits for the test. `step()` is a step boundary (pending
// steers are delivered), `finish()` ends the turn with an assistant answer.
// The inbox follows 2.0.28 as design.md records it:
//   - a steer pending behind a running turn is delivered at the next step
//     boundary, in enqueue order;
//   - `resume: true` on an idle session wakes steer-scope input; a queue
//     prompt on an idle session starts a turn; a turn's start delivers
//     everything pending, oldest first;
//   - `interrupt` never deletes pending input; `?resume=true` starts a new
//     turn delivering the pending steers, absent or false wakes nothing;
//   - `inbox.cancel` answers 204 always, and only a pending entry is
//     cancelled (and announced); a delivered or missing one is a silent no-op.

import path from "node:path";
import type { FormCreated, PermissionAsked } from "@opencode/client";

export type NativeWorkerRequestReply = { kind: "permission" | "question"; childId: string; requestId: string; body: Record<string, unknown> };

type InboxDelivery = "steer" | "queue";
type InboxFile = { mime: string; name: string; source: { type: "uri"; uri: string } };
type InboxEntry = {
  id: string;
  sessionID: string;
  time: { created: number };
  type: "user" | "synthetic";
  payload: { text: string; files?: InboxFile[]; description?: string; metadata?: Record<string, unknown> };
  delivery: InboxDelivery;
};
type StoredMessage = Record<string, unknown> & { id: string; time: { created: number; completed?: number } };
type SessionState = {
  info: {
    id: string;
    projectID: string;
    title: string;
    location: { directory: string };
    time: { created: number; updated: number };
    agent: string;
    model: { id: string; providerID: string; variant?: string };
    parentID?: string;
    revert?: { messageID: string };
    cost?: number;
  };
  running: boolean;
  // Pending entries in enqueue order: not delivered, not cancelled.
  inbox: InboxEntry[];
  messages: StoredMessage[];
};

export type OpenCodeV2FakeSessionState = {
  running: boolean;
  pending: InboxEntry[];
  messages: Array<{ id: string; type: unknown; text?: unknown }>;
};

export type OpenCodeV2Fake = {
  readonly url: string;
  readonly password: string;
  /** Forget every session and close every event stream. */
  reset(): void;
  /** A step boundary in the running turn: delivers the pending steers. */
  step(sessionId: string): { delivered: string[] };
  /** Ends the running turn with an assistant answer; null when nothing runs. */
  finish(sessionId: string, text?: string): { assistantMessageId: string; delivered: string[] } | null;
  /** The next cancel of `inboxId` finds it already delivered (the too-late race). */
  raceDeliverOnCancel(inboxId: string): void;
  launchWorker(sessionId: string, background: boolean, existingChildId?: string): { childId: string; taskId: string; callId: string };
  launchRequestWorker(sessionId: string): { childId: string; taskId: string; callId: string };
  workerObservation(childId: string, observed: boolean): void;
  workerRequest(childId: string, kind: "permission" | "question"): { requestId: string; childId: string; messageId: string; toolId: string; kind: "permission" | "question" };
  launchShell(sessionId: string, background: boolean): { shellId: string; taskId: string };
  shellPhase(shellId: string, phase: "exit" | "capture" | "captureBeforeRemove"): void;
  settleWorker(childId: string, state: "completed" | "error" | "cancelled", text: string): void;
  workerReport(childId: string, model: string, effort: string | undefined, cost: number | undefined): void;
  disconnect(): void;
  pauseEvents(paused: boolean): void;
  externalRevert(sessionId: string, messageId: string | null): void;
  appendHistory(sessionId: string, count: number): void;
  holdNextMessageRead(sessionId: string): void;
  releaseMessageRead(): void;
  loseNextBackgroundResponse(): void;
  loseNextPromptResponse(): void;
  unknownNextPromptBeforeAdmission(): void;
  loseNextResumeResponse(): void;
  refuseNextBackground(): void;
  launchShellOnNextSteer(sessionId: string): void;
  loseNextWorkerResponse(): void;
  wakeParent(sessionId: string): void;
  state(): { eventSubscribers: number; heldMessageRead: string | null; sessions: Record<string, OpenCodeV2FakeSessionState>; shells: Record<string, { removed: boolean; waiter: string; captured: boolean; outputAvailable: boolean }>; unhandled: string[]; calls: string[]; requestReplies: NativeWorkerRequestReply[]; requestEvidence: Array<{ type: string; sessionID?: string; durable?: { aggregateID: string; seq: number; version: number } }> };
  stop(): Promise<void>;
};

const MODEL = { providerID: "opencode", modelID: "fake-model" };
const AGENTS = [
  { id: "build", name: "Build", description: "The default agent", mode: "primary", hidden: false },
  { id: "plan", name: "Plan", description: "Plans without editing", mode: "primary", hidden: false },
];
const MODELS = [{
  id: MODEL.modelID,
  modelID: MODEL.modelID,
  providerID: MODEL.providerID,
  name: "Fake Model",
  capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
  variants: [],
  limit: { context: 200_000, output: 32_000 },
  status: "active",
  enabled: true,
  cost: [],
  time: { released: 0 },
}];
const PROVIDERS = [{ id: MODEL.providerID, name: "OpenCode Zen", activation: "auto", package: "fake" }];

export function startOpenCodeV2Fake(options: { directory: string; password?: string }): OpenCodeV2Fake {
  const directory = path.resolve(options.directory);
  const password = options.password ?? "e2e-opencode-v2";
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const encoder = new TextEncoder();
  const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let eventsPaused = false;
  let messageReadHold: { sessionId: string; claimed: boolean; gate: Promise<void>; release: () => void } | undefined;
  const releaseMessageRead = () => { messageReadHold?.release(); messageReadHold = undefined; };
  const sessions = new Map<string, SessionState>();
  const raceOnCancel = new Set<string>();
  const unhandled: string[] = [];
  const calls: string[] = [];
  const workers = new Map<string, { parent: SessionState; child: SessionState; message: StoredMessage; background: boolean; settled: boolean }>();
  const hiddenWorkerObservations = new Set<string>();
  const permissions = new Map<string, PermissionAsked["data"]>();
  const forms = new Map<string, FormCreated["data"]["form"]>();
  const requestReplies: NativeWorkerRequestReply[] = [];
  const requestEvidence: Array<{ type: string; sessionID?: string; durable?: { aggregateID: string; seq: number; version: number } }> = [];
  const durableSequences = new Map<string, number>();
  const shells = new Map<string, { parent: SessionState; message: StoredMessage; background: boolean; removed: boolean; exited: boolean; waiter: "pending" | "exited" | "failed"; captured: boolean; captureBeforeRemove: boolean; output: string | null }>();
  let loseBackground = false;
  let losePrompt = false, loseResume = false, refuseBackground = false;
  let unknownBeforeAdmission = false;
  const shellAfterAdmission = new Set<string>();
  let loseWorker = false;
  let counter = 0;
  let clock = 0;
  // Strictly increasing: stored records sort by creation time.
  const now = () => (clock = Math.max(Date.now(), clock + 1));
  const mint = (prefix: string) => `${prefix}_fake${String(++counter).padStart(6, "0")}`;

  const write = (controller: ReadableStreamDefaultController<Uint8Array>, chunk: string) => {
    try {
      controller.enqueue(encoder.encode(chunk));
    } catch {
      subscribers.delete(controller);
    }
  };
  function emit(type: string, data: Record<string, unknown>, located = true, durableVersion?: number): number {
    const created = now();
    const aggregateID = typeof data.sessionID === "string" ? data.sessionID : undefined;
    const durable = durableVersion && aggregateID ? { aggregateID, seq: (durableSequences.get(aggregateID) ?? 0) + 1, version: durableVersion } : undefined;
    if (durable) durableSequences.set(durable.aggregateID, durable.seq);
    if (durable || type === "form.created" || type === "permission.asked") requestEvidence.push({ type, ...(aggregateID ? { sessionID: aggregateID } : {}), ...(durable ? { durable } : {}) });
    const frame = { id: mint("evt"), created, type, ...(located ? { location: { directory } } : {}), ...(durable ? { durable } : {}), data };
    for (const subscriber of [...subscribers]) write(subscriber, `data: ${JSON.stringify(frame)}\n\n`);
    return created;
  }
  const keepalive = setInterval(() => {
    for (const subscriber of [...subscribers]) write(subscriber, ": keepalive\n\n");
  }, 3_000);

  function deliver(session: SessionState, entry: InboxEntry): void {
    session.inbox = session.inbox.filter(candidate => candidate.id !== entry.id);
    const created = emit("session.inbox.delivered", { sessionID: session.info.id, inboxID: entry.id });
    session.messages.push({ id: entry.id, type: entry.type, time: { created }, ...entry.payload });
    session.info.time.updated = created;
  }
  function deliverAll(session: SessionState, filter: (entry: InboxEntry) => boolean): string[] {
    const due = session.inbox.filter(filter);
    for (const entry of due) deliver(session, entry);
    return due.map(entry => entry.id);
  }
  // A turn starts and takes everything pending with it, oldest first.
  function startTurn(session: SessionState, filter: (entry: InboxEntry) => boolean = () => true): string[] {
    session.running = true;
    emit("session.execution.started", { sessionID: session.info.id }, false);
    return deliverAll(session, filter);
  }

  function enqueue(session: SessionState, input: { id: string; text: string; files?: InboxFile[]; delivery: InboxDelivery; resume: boolean }): InboxEntry {
    // A replacement prompt commits the staged branch before admission.
    // Pending inbox entries are independent of that discarded history.
    if (session.info.revert) {
      const boundary = session.messages.findIndex(message => message.id === session.info.revert!.messageID);
      if (boundary >= 0) session.messages.splice(boundary);
      delete session.info.revert;
    }
    const entry: InboxEntry = {
      id: input.id,
      sessionID: session.info.id,
      time: { created: now() },
      type: "user",
      payload: { text: input.text, ...(input.files?.length ? { files: input.files } : {}) },
      delivery: input.delivery,
    };
    session.inbox.push(entry);
    emit("session.inbox.enqueued", { sessionID: session.info.id, inboxID: entry.id, item: { type: "user", payload: entry.payload, delivery: entry.delivery } });
    if (!session.running) {
      // A queued prompt on a resting session starts a turn; a steer wakes it
      // only when asked to resume.
      if (input.delivery === "queue" || input.resume) startTurn(session);
    }
    return entry;
  }

  function finish(session: SessionState, text: string): { assistantMessageId: string; delivered: string[] } {
    const sessionID = session.info.id;
    // The final step begins at a boundary: steers pending now are part of it.
    const delivered = deliverAll(session, entry => entry.delivery === "steer");
    const assistantMessageID = mint("msg");
    const started = emit("session.step.started", { sessionID, agent: session.info.agent, model: session.info.model, assistantMessageID, started: now() });
    emit("session.text.started", { sessionID, assistantMessageID, ordinal: 0 });
    emit("session.text.delta", { sessionID, assistantMessageID, ordinal: 0, delta: text });
    emit("session.text.ended", { sessionID, assistantMessageID, ordinal: 0, text });
    const completed = emit("session.step.ended", { sessionID, assistantMessageID, finish: "stop", rawFinish: "stop" });
    session.messages.push({
      id: assistantMessageID,
      type: "assistant",
      time: { created: started, completed },
      agent: session.info.agent,
      model: session.info.model,
      content: [{ type: "text", text }],
      finish: "stop",
    });
    session.running = false;
    session.info.time.updated = completed;
    emit("session.execution.succeeded", { sessionID }, false);
    // Natively queued input waits for the turn to end, then starts the next.
    if (session.inbox.some(entry => entry.delivery === "queue")) startTurn(session);
    return { assistantMessageId: assistantMessageID, delivered };
  }

  function createSession(body: Record<string, unknown>, durable = false): SessionState {
    const created = now();
    const model = body.model as { id?: string; providerID?: string; variant?: string } | undefined;
    const info: SessionState["info"] = {
      id: mint("ses"),
      projectID: "global",
      title: typeof body.title === "string" && body.title ? body.title : `New session - ${new Date(created).toISOString()}`,
      location: { directory },
      time: { created, updated: created },
      agent: typeof body.agent === "string" ? body.agent : "build",
      ...(typeof body.parentID === "string" ? { parentID: body.parentID } : {}),
      model: model?.id && model.providerID
        ? { id: model.id, providerID: model.providerID, ...(model.variant ? { variant: model.variant } : {}) }
        : { id: MODEL.modelID, providerID: MODEL.providerID },
    };
    const session: SessionState = { info, running: false, inbox: [], messages: [] };
    sessions.set(info.id, session);
    emit("session.created", { sessionID: info.id, parentID: info.parentID, title: info.title, location: info.location, projectID: info.projectID, version: durable ? "2.1.2" : "2.0.28" }, true, durable ? 1 : undefined);
    return session;
  }

  // Source-shaped 2.0.29 tool and notification records (see the pinned
  // background-2.0.29 fixture). Interrupt acknowledgement does not settle a
  // worker; the test advances its provider-owned notification separately.
  function launchWorker(sessionId: string, background: boolean, existingChildId?: string) {
    const parent = sessions.get(sessionId);
    if (!parent) throw new Error("Unknown fixture parent");
    const child = existingChildId ? sessions.get(existingChildId) : createSession({ parentID: sessionId, title: "Inspect safe fixture" });
    if (!child || child.info.parentID !== sessionId || child.running) throw new Error("Unavailable fixture continuation");
    const childId = child.info.id;
    const callId = mint("call");
    const created = now();
    const message: StoredMessage = { id: mint("msg"), type: "assistant", time: { created }, content: [{ type: "tool", id: callId, name: "subagent", time: { created }, state: { status: background ? "completed" : "running", input: { agent: "explore", description: "Inspect safe fixture", prompt: "Check fixture", ...(background ? { background: true } : {}) }, metadata: { sessionID: childId, status: "running" }, content: background ? [{ type: "text", text: "The subagent is working in the background. You will be notified automatically." }] : [] } }] };
    child.messages.push({ id: mint("msg"), type: "user", text: "Check fixture", time: { created } });
    startTurn(child);
    parent.messages.push(message);
    workers.set(childId, { parent, child, message, background, settled: false });
    emit("session.message.content.updated", { sessionID: sessionId, messageID: message.id, content: message.content });
    return { childId, callId, taskId: `v2:${sessionId}:${callId}` };
  }

  // Isolated 2.1.2 request fixture: retain actual durable launcher/child tool
  // tuples; pending permission/form creation remains an ephemeral event.
  function launchRequestWorker(sessionID: string) {
    const parent = sessions.get(sessionID);
    if (!parent) throw new Error("Unknown fixture parent");
    const callId = mint("call"), messageId = mint("msg");
    const common = { sessionID, assistantMessageID: messageId, id: callId };
    const input = { agent: "explore", description: "Native request fixture worker", prompt: "Ask the fixture question", background: true };
    const created = emit("session.tool.input.started", { ...common, name: "subagent" }, true, 1);
    const ran = emit("session.tool.called", { ...common, input, executed: true }, true, 1);
    const child = createSession({ parentID: sessionID, title: "Native request fixture child" }, true);
    child.messages.push({ id: mint("msg"), type: "user", text: input.prompt, time: { created: now() } });
    child.running = true;
    emit("session.execution.started", { sessionID: child.info.id }, false, 1);
    const metadata = { sessionID: child.info.id, status: "running" };
    const content = [{ type: "text", text: "The subagent is working in the background. You will be notified automatically." }];
    const completed = now();
    const message: StoredMessage = { id: messageId, type: "assistant", time: { created }, content: [{ type: "tool", id: callId, name: "subagent", time: { created, ran, completed }, state: { status: "completed", input, metadata, content } }] };
    parent.messages.push(message);
    workers.set(child.info.id, { parent, child, message, background: true, settled: false });
    emit("session.message.content.updated", { sessionID, messageID: messageId, content: message.content }, true, 1);
    emit("session.tool.success", { ...common, executed: true, content, metadata }, true, 2);
    return { childId: child.info.id, callId, taskId: `v2:${sessionID}:${callId}` };
  }

  function workerRequest(childId: string, kind: "permission" | "question") {
    const worker = workers.get(childId);
    if (!worker || worker.settled || !worker.child.running) throw new Error("No current owned fixture worker");
    hiddenWorkerObservations.delete(childId);
    const messageId = mint("msg"), toolId = mint("call"), requestId = mint(kind === "permission" ? "per" : "form");
    const common = { sessionID: childId, assistantMessageID: messageId, id: toolId };
    const input = { questions: [{ header: "Choose", question: "Proceed with the native fixture?", options: [{ label: "Yes", description: "Proceed" }] }] };
    const created = emit("session.tool.input.started", { ...common, name: "question" }, true, 1);
    const ran = emit("session.tool.called", { ...common, input, executed: true }, true, 1);
    worker.child.messages.push({ id: messageId, type: "assistant", time: { created }, content: [{ type: "tool", id: toolId, name: "question", time: { created, ran }, state: { status: "running", input } }] });
    if (kind === "permission") {
      const permission: PermissionAsked["data"] = { id: requestId, sessionID: childId, action: "question", resources: ["fixture"], source: { type: "tool", messageID: messageId, id: toolId } };
      permissions.set(requestId, permission);
      emit("permission.asked", permission);
    } else {
      const form: FormCreated["data"]["form"] = { id: requestId, sessionID: childId, title: "Questions", fields: [{ key: "q0", type: "string", title: "Choose", description: "Proceed with the native fixture?", custom: true, options: [{ value: "Yes", label: "Yes", description: "Proceed" }] }], metadata: { kind: "question", tool: { messageID: messageId, id: toolId } } };
      forms.set(requestId, form);
      emit("form.created", { form });
    }
    return { requestId, childId, messageId, toolId, kind };
  }

  function settleWorker(childId: string, state: "completed" | "error" | "cancelled", text: string) {
    const worker = workers.get(childId);
    if (!worker || worker.settled) return;
    worker.settled = true;
    finish(worker.child, text);
    const created = now();
    worker.child.messages.push({ id: mint("msg"), type: "idle", time: { created } });
    const entry: InboxEntry = { id: mint("msg"), sessionID: worker.parent.info.id, type: "synthetic", delivery: "steer", time: { created }, payload: { description: "Inspect safe fixture", text: `<subagent sessionID="${childId}" state="${state}">\n${text}\n</subagent>`, metadata: { source: "subagent", childID: childId, state, agent: "explore" } } };
    worker.parent.inbox.push(entry);
    emit("session.inbox.enqueued", { sessionID: worker.parent.info.id, inboxID: entry.id, item: entry });
  }

  // Synthetic execution metadata, never a paid model call or a parent's selection.
  function workerReport(childId: string, model: string, effort: string | undefined, cost: number | undefined) {
    const child = sessions.get(childId);
    if (!child) throw new Error("Unknown fixture child");
    const assistantMessageID = mint("msg");
    const selected = { id: model, providerID: "fixture", ...(effort === undefined ? {} : { variant: effort }) };
    const started = emit("session.step.started", { sessionID: childId, assistantMessageID, agent: "explore", model: selected, started: now() });
    const tokens = { input: 1200, output: 100, reasoning: 20, cache: { read: 0, write: 0 } };
    const completed = emit("session.step.ended", { sessionID: childId, assistantMessageID, finish: "tool-calls", tokens, ...(cost === undefined ? {} : { cost }) });
    if (cost === undefined) delete child.info.cost;
    else {
      child.info.cost = (child.info.cost ?? 0) + cost;
      emit("session.usage.updated", { sessionID: childId, cost: child.info.cost, tokens });
    }
    child.messages.push({ id: assistantMessageID, type: "assistant", time: { created: started, completed }, model: selected, agent: "explore", content: [], tokens, ...(cost === undefined ? {} : { cost }) });
  }

  function launchShell(sessionId: string, background: boolean) {
    const parent = sessions.get(sessionId);
    if (!parent) throw new Error("Unknown fixture parent");
    const shellId = mint("sh");
    const callId = mint("call");
    const created = now();
    const message: StoredMessage = { id: mint("msg"), type: "assistant", time: { created }, content: [{ type: "tool", id: callId, name: "shell", time: { created }, state: { status: background ? "completed" : "running", input: { command: "printf 'safe shell output'" }, metadata: { shellID: shellId, status: "running" }, content: background ? [{ type: "text", text: "Command moved to the background." }] : [] } }] };
    shells.set(shellId, { parent, message, background, removed: false, exited: false, waiter: "pending", captured: false, captureBeforeRemove: false, output: "safe shell output" });
    parent.messages.push(message);
    // Native ephemeral birth, as captured in real-2.0.13.json. Metadata is
    // association only: the provider still verifies launcher and owned inventory.
    emit("shell.created", { info: { id: shellId, status: "running", command: "printf 'safe shell output'", cwd: directory,
      shell: "/bin/sh", file: `/fixture/${shellId}.out`, metadata: { sessionID: sessionId, background }, time: { started: created } } });
    emit("session.message.content.updated", { sessionID: sessionId, messageID: message.id, content: message.content });
    return { shellId, taskId: `v2:${sessionId}:${callId}` };
  }

  // Pinned 2.0.29 removal deletes registry/output and fails a pending waiter.
  // The plugin's later capture (not DELETE or shell.deleted) produces the
  // source-shaped error. Exit and capture are deliberately separate controls.
  function shellPhase(shellId: string, phase: "exit" | "capture" | "captureBeforeRemove") {
    const shell = shells.get(shellId);
    if (!shell) throw new Error("Unknown fixture shell");
    if (phase === "captureBeforeRemove") { shell.captureBeforeRemove = true; return; }
    shell.exited = true;
    if (shell.waiter === "pending") shell.waiter = "exited";
    if (phase === "exit") { emit("shell.exited", { shellID: shellId }); return; }
    if (shell.captured) return;
    shell.captured = true;
    const state = shell.output === null ? "error" : "completed";
    const text = shell.output ?? "Shell not found: final output capture unavailable";
    const entry: InboxEntry = { id: mint("msg"), sessionID: shell.parent.info.id, type: "synthetic", delivery: "steer", time: { created: now() }, payload: { text: `<shell id="${shellId}" state="${state}">\n${text}\n</shell>`, metadata: { source: "shell", shellID: shellId, jobID: shellId, state, ...(state === "completed" ? { exit: 0 } : {}) } } };
    shell.parent.inbox.push(entry);
    emit("session.inbox.enqueued", { sessionID: shell.parent.info.id, inboxID: entry.id, item: entry });
  }

  const scoped = (data: unknown) => Response.json({ location: { directory }, data });
  const enveloped = (data: unknown) => Response.json({ data });
  const noContent = () => new Response(null, { status: 204 });
  const sessionNotFound = (sessionID: string) => Response.json({ _tag: "SessionNotFoundError", sessionID, message: `Session not found: ${sessionID}` }, { status: 404 });
  const notFound = (what: string) => Response.json({ _tag: "NotFoundError", message: what }, { status: 404 });
  const mimeOf = (name: string) => ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" })[path.extname(name).toLowerCase()] ?? "application/octet-stream";

  function eventStream(signal: AbortSignal): Response {
    let self: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        self = controller;
        subscribers.add(controller);
        write(controller, `data: ${JSON.stringify({ id: mint("evt"), type: "server.connected", data: {} })}\n\n`);
      },
      cancel() {
        if (self) subscribers.delete(self);
      },
    });
    signal.addEventListener("abort", () => { if (self) subscribers.delete(self); }, { once: true });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }

  async function handle(request: Request): Promise<Response> {
    if (request.headers.get("authorization") !== authorization) return Response.json({ _tag: "UnauthorizedError", message: "unauthorized" }, { status: 401 });
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    calls.push(`${route}${url.search}`);
    const body = request.method === "GET" || request.method === "DELETE" ? {} : await request.json().catch(() => ({})) as Record<string, unknown>;
    if (route === "GET /api/event") return eventsPaused ? new Response("Fixture event connection unavailable", { status: 503 }) : eventStream(request.signal);
    if (route === "GET /api/session/active") return enveloped(Object.fromEntries([...sessions.values()].filter(session => session.running && !hiddenWorkerObservations.has(session.info.id)).map(session => [session.info.id, { status: "running" }])));
    if (route === "GET /api/agent") return scoped(AGENTS);
    if (route === "GET /api/form") return scoped([...forms.values()]);
    if (route === "GET /api/permission/request") return scoped([...permissions.values()]);
    if (route === "GET /api/command" || route === "GET /api/skill" || route === "GET /api/mcp") return scoped([]);
    if (route === "GET /api/model") return scoped(MODELS);
    if (route === "GET /api/model/default") return scoped({ id: MODEL.modelID, ...MODEL });
    if (route === "GET /api/provider") return scoped(PROVIDERS);
    if (route === "POST /api/location/reload") {
      emit("location.shutdown", {});
      for (const type of ["command.updated", "skill.updated", "model.updated", "agent.updated"]) emit(type, {});
      return noContent();
    }
    if (route === "GET /api/session") {
      const wanted = url.searchParams.get("directory");
      const listed = [...sessions.values()]
        .filter(session => !wanted || path.resolve(wanted) === session.info.location.directory)
        .map(session => session.info)
        .sort((left, right) => url.searchParams.get("order") === "asc" ? left.time.updated - right.time.updated : right.time.updated - left.time.updated);
      return Response.json({ data: listed, cursor: { next: null } });
    }
    if (route === "POST /api/session") return enveloped(createSession(body).info);
    const shellMatch = /^\/api\/shell\/([^/]+)(\/output)?$/.exec(url.pathname);
    if (shellMatch) {
      const id = decodeURIComponent(shellMatch[1]!);
      const shell = shells.get(id);
      if (request.method === "DELETE") {
        if (shell) {
          if (shell.captureBeforeRemove) shellPhase(id, "capture");
          shell.removed = true; shell.output = null;
          if (shell.waiter === "pending") shell.waiter = "failed";
          emit("shell.deleted", { shellID: id });
        }
        if (loseWorker) { loseWorker = false; return new Response("truncated response", { status: 502 }); }
        return noContent();
      }
      if (!shell || shell.removed) return Response.json({ _tag: "ShellNotFoundError", id }, { status: 404 });
      if (shellMatch[2]) {
        const output = shell.output ?? "";
        const cursor = Math.min(Number(url.searchParams.get("cursor") ?? 0), output.length);
        const limit = Number(url.searchParams.get("limit") ?? output.length);
        return scoped({ output: output.slice(cursor, cursor + limit), size: output.length, cursor: output.length, truncated: false });
      }
      return scoped({ id, status: shell.exited ? "exited" : "running", metadata: { sessionID: shell.parent.info.id } });
    }
    if (url.pathname.startsWith("/api/permission/request/") && request.method === "POST") return noContent();

    const match = /^\/api\/session\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!match) {
      unhandled.push(route);
      return notFound(`no route ${route}`);
    }
    const sessionID = decodeURIComponent(match[1]!);
    const rest = match[2] ?? "";
    const session = sessions.get(sessionID);
    if (!session) return sessionNotFound(sessionID);
    const sub = `${request.method} ${rest}`;

    const permissionReply = /^POST permission\/([^/]+)\/reply$/.exec(sub);
    if (permissionReply) {
      const requestId = decodeURIComponent(permissionReply[1]!);
      const permission = permissions.get(requestId);
      if (!permission || permission.sessionID !== sessionID || !["once", "always", "reject"].includes(String(body.decision))) return notFound("No pending permission in this child");
      requestReplies.push({ kind: "permission", childId: sessionID, requestId, body });
      permissions.delete(requestId);
      emit("permission.replied", { sessionID, requestID: requestId, reply: body.decision });
      return noContent();
    }
    const formRequest = /^(GET|POST) form\/([^/]+)(\/reply)?$/.exec(sub);
    if (formRequest) {
      const requestId = decodeURIComponent(formRequest[2]!);
      const form = forms.get(requestId);
      if (!form || form.sessionID !== sessionID) return notFound("No pending form in this child");
      if (formRequest[1] === "GET" && !formRequest[3]) return enveloped({ ...form, state: { status: "pending" } });
      if (formRequest[1] === "POST" && formRequest[3] && body.answer && typeof body.answer === "object") {
        requestReplies.push({ kind: "question", childId: sessionID, requestId, body });
        forms.delete(requestId);
        emit("form.replied", { sessionID, id: requestId, answer: body.answer });
        return noContent();
      }
      return notFound("Unsupported fixture form operation");
    }

    if (sub === "GET ") return enveloped(session.info);
    // Pinned SessionGenerate makes one inference, admits no inbox/history
    // entry, runs no tool executor and leaves the foreground runner alone.
    if (sub === "POST generate") return enveloped({ text: "A native side answer from the existing context." });
    if (sub === "PATCH ") {
      if (typeof body.title === "string") {
        session.info.title = body.title;
        session.info.time.updated = emit("session.renamed", { sessionID, title: body.title });
      }
      return noContent();
    }
    if (sub === "POST model") {
      const model = body.model as { id: string; providerID: string; variant?: string };
      session.info.model = { id: model.id, providerID: model.providerID, ...(model.variant ? { variant: model.variant } : {}) };
      return noContent();
    }
    if (sub === "POST agent") {
      session.info.agent = String(body.agent);
      return noContent();
    }
    if (sub === "POST prompt") {
      if (body.delivery === "steer" && unknownBeforeAdmission) {
        unknownBeforeAdmission = false;
        return new Response("synthetic unknown response before fixture admission", { status: 500 });
      }
      const files = Array.isArray(body.files)
        ? (body.files as Array<{ uri: string; name: string }>).map(file => ({ mime: mimeOf(file.name), name: file.name, source: { type: "uri" as const, uri: file.uri } }))
        : undefined;
      const entry = enqueue(session, {
        id: typeof body.id === "string" ? body.id : mint("msg"),
        text: String(body.text ?? ""),
        ...(files?.length ? { files } : {}),
        // 2.x's default delivery is steer.
        delivery: body.delivery === "queue" ? "queue" : "steer",
        resume: body.resume === true,
      });
      if (body.delivery === "steer" && shellAfterAdmission.delete(sessionID)) launchShell(sessionID, false);
      if (body.delivery === "steer" && losePrompt) { losePrompt = false; return new Response("lost prompt acknowledgement after application", { status: 502 }); }
      return enveloped(entry);
    }
    if (sub === "POST command") {
      // The server mints the id and expands the template; this fake runs the
      // command's text as a natively queued prompt.
      enqueue(session, { id: mint("msg"), text: `/${String(body.name)}${body.text ? ` ${String(body.text)}` : ""}`, delivery: "queue", resume: true });
      return noContent();
    }
    if (sub === "POST compact") {
      return enveloped({ id: typeof body.id === "string" ? body.id : mint("msg"), sessionID, time: { created: now() }, type: "compaction", payload: {}, delivery: "queue" });
    }
    if (sub === "POST interrupt") {
      const wasRunning = session.running;
      if (wasRunning && !workers.has(sessionID)) {
        // Native jobs.cancel(parent) cancels only jobs still blocking it.
        // Detached jobs are no longer in that scope. Foreground cancellation
        // settles its tool, not a background synthetic completion.
        for (const worker of workers.values()) {
          if (worker.parent !== session || worker.background || worker.settled) continue;
          worker.settled = true;
          worker.child.running = false;
          emit("session.execution.interrupted", { sessionID: worker.child.info.id, reason: "user" }, false);
          const part = (worker.message.content as Array<{ state: { status: string; error?: string } }>)[0]!;
          part.state.status = "error";
          part.state.error = "Interrupted with parent";
          emit("session.message.content.updated", { sessionID, messageID: worker.message.id, content: worker.message.content });
        }
        session.running = false;
        emit("session.execution.interrupted", { sessionID, reason: "user" }, false);
      }
      // Pending input is never deleted; only `resume=true` wakes the steers.
      if (url.searchParams.get("resume") === "true" && session.inbox.some(entry => entry.delivery === "steer")) {
        startTurn(session, entry => entry.delivery === "steer");
      }
      if (workers.has(sessionID) && loseWorker) { loseWorker = false; return new Response("truncated response", { status: 502 }); }
      if (url.searchParams.get("resume") === "true" && loseResume) { loseResume = false; return new Response("lost resume acknowledgement after application", { status: 502 }); }
      return Response.json({ interrupted: wasRunning });
    }
    if (sub === "POST background") {
      if (refuseBackground) { refuseBackground = false; return Response.json({ _tag: "SessionNotFoundError", sessionID, message: "Fixture refuses backgrounding" }, { status: 404 }); }
      for (const shell of shells.values()) {
        if (shell.parent !== session || shell.background || shell.captured) continue;
        shell.background = true;
        const part = (shell.message.content as Array<{ state: { status: string; content: unknown[] } }>)[0]!;
        part.state.status = "completed";
        part.state.content = [{ type: "text", text: "Command moved to the background." }];
        emit("session.message.content.updated", { sessionID, messageID: shell.message.id, content: shell.message.content });
      }
      for (const worker of workers.values()) {
        if (worker.parent !== session || worker.background || worker.settled) continue;
        worker.background = true;
        const part = (worker.message.content as Array<{ state: { status: string; content: unknown[] } }>)[0]!;
        part.state.status = "completed";
        part.state.content = [{ type: "text", text: "The subagent is working in the background. You will be notified automatically." }];
        emit("session.message.content.updated", { sessionID, messageID: worker.message.id, content: worker.message.content });
      }
      if (loseBackground) { loseBackground = false; return new Response("truncated response", { status: 502 }); }
      return noContent();
    }
    if (sub === "GET inbox") return Response.json({ data: session.inbox });
    const inboxMatch = /^(DELETE|PATCH) inbox\/(.+)$/.exec(sub);
    if (inboxMatch) {
      const inboxID = decodeURIComponent(inboxMatch[2]!);
      const entry = session.inbox.find(candidate => candidate.id === inboxID);
      if (inboxMatch[1] === "PATCH") {
        // Uatu never switches delivery through the inbox (design D1).
        if (entry && (body.delivery === "steer" || body.delivery === "queue") && entry.delivery !== body.delivery) {
          entry.delivery = body.delivery;
          emit("session.inbox.delivery.changed", { sessionID, inboxID, delivery: entry.delivery });
        }
        return noContent();
      }
      if (entry && raceOnCancel.delete(inboxID)) {
        // Too late: the boundary took it before the cancel arrived.
        if (!session.running) startTurn(session, () => false);
        deliver(session, entry);
        return noContent();
      }
      if (entry) {
        session.inbox = session.inbox.filter(candidate => candidate !== entry);
        emit("session.inbox.cancelled", { sessionID, inboxID });
      }
      // A delivered or missing entry: 204 and nothing announced (2.0.28).
      return noContent();
    }
    if (sub === "GET message") {
      const ordered = [...session.messages].sort((left, right) => left.time.created - right.time.created);
      const hold = messageReadHold;
      if (hold?.sessionId === sessionID && !hold.claimed) {
        hold.claimed = true;
        await hold.gate;
      }
      return Response.json({ data: url.searchParams.get("order") === "desc" ? ordered.reverse() : ordered, cursor: { next: null } });
    }
    if (sub === "POST revert/stage") {
      session.info.revert = { messageID: String(body.messageID) };
      return enveloped({});
    }
    if (sub === "DELETE revert") {
      delete session.info.revert;
      return noContent();
    }
    unhandled.push(route);
    return notFound(`no route ${route}`);
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // Event streams sit quiet between keepalives; never time them out.
    idleTimeout: 0,
    fetch: request => handle(request).catch(error => Response.json({ _tag: "InternalError", message: String(error) }, { status: 500 })),
  });

  function closeStreams(): void {
    for (const subscriber of [...subscribers]) {
      try {
        subscriber.close();
      } catch {
        // already closed
      }
    }
    subscribers.clear();
  }

  return {
    url: `http://127.0.0.1:${server.port}`,
    password,
    reset() {
      releaseMessageRead();
      closeStreams();
      sessions.clear();
      raceOnCancel.clear();
      unhandled.length = 0;
      calls.length = 0;
      workers.clear();
      hiddenWorkerObservations.clear(); permissions.clear(); forms.clear(); requestReplies.length = 0; requestEvidence.length = 0; durableSequences.clear();
      shells.clear();
      loseBackground = false;
      losePrompt = loseResume = refuseBackground = false;
      unknownBeforeAdmission = false;
      shellAfterAdmission.clear();
      loseWorker = false;
      eventsPaused = false;
    },
    launchWorker,
    launchRequestWorker,
    workerObservation(childId, observed) {
      if (!workers.has(childId)) throw new Error("Unknown fixture worker");
      if (observed) hiddenWorkerObservations.delete(childId); else hiddenWorkerObservations.add(childId);
    },
    workerRequest,
    launchShell,
    shellPhase,
    settleWorker,
    workerReport,
    disconnect: closeStreams,
    pauseEvents(paused) { eventsPaused = paused; if (paused) closeStreams(); },
    externalRevert(sessionId, messageId) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error("Unknown fixture revert owner");
      if (messageId === null) delete session.info.revert;
      else {
        if (!session.messages.some(message => message.id === messageId)) throw new Error("Unknown fixture revert boundary");
        session.info.revert = { messageID: messageId };
      }
    },
    appendHistory(sessionId, count) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error("Unknown fixture history owner");
      for (let index = 0; index < Math.min(120, count); index++) {
        session.messages.push({ id: mint("msg"), type: "user", text: `Historical fixture prompt ${index}`, time: { created: now() } });
        session.messages.push({ id: mint("msg"), type: "assistant", time: { created: now() }, content: [{ id: mint("part"), type: "text", text: `Historical fixture answer ${index}` }] });
      }
      emit("session.message.content.updated", { sessionID: sessionId, messageID: session.messages.at(-1)!.id, content: session.messages.at(-1)!.content });
    },
    loseNextBackgroundResponse() { loseBackground = true; },
    holdNextMessageRead(sessionId) {
      releaseMessageRead();
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      messageReadHold = { sessionId, claimed: false, gate, release };
    },
    releaseMessageRead,
    loseNextPromptResponse() { losePrompt = true; },
    unknownNextPromptBeforeAdmission() { unknownBeforeAdmission = true; },
    loseNextResumeResponse() { loseResume = true; },
    refuseNextBackground() { refuseBackground = true; },
    launchShellOnNextSteer(sessionId) { if (!sessions.has(sessionId)) throw new Error("Unknown fixture parent"); shellAfterAdmission.add(sessionId); },
    loseNextWorkerResponse() { loseWorker = true; },
    wakeParent(sessionId) {
      const session = sessions.get(sessionId);
      if (!session || session.running || !session.inbox.some(entry => entry.type === "synthetic")) throw new Error("No pending native completion to wake parent");
      startTurn(session);
    },
    step(sessionId) {
      const session = sessions.get(sessionId);
      if (!session?.running) return { delivered: [] };
      return { delivered: deliverAll(session, entry => entry.delivery === "steer") };
    },
    finish(sessionId, text) {
      const session = sessions.get(sessionId);
      if (!session?.running) return null;
      const answers = session.messages.filter(message => message.type === "assistant").length;
      return finish(session, text ?? `Answer ${answers + 1}`);
    },
    raceDeliverOnCancel(inboxId) {
      raceOnCancel.add(inboxId);
    },
    state() {
      const result: Record<string, OpenCodeV2FakeSessionState> = {};
      for (const [id, session] of sessions) {
        result[id] = {
          running: session.running,
          pending: session.inbox.map(entry => ({ ...entry })),
          messages: session.messages.map(message => ({ id: message.id, type: message.type, ...(message.type === "user" ? { text: message.text } : {}) })),
        };
      }
      return { eventSubscribers: subscribers.size, heldMessageRead: messageReadHold?.claimed ? messageReadHold.sessionId : null, sessions: result, shells: Object.fromEntries([...shells].map(([id, shell]) => [id, { removed: shell.removed, waiter: shell.waiter, captured: shell.captured, outputAvailable: shell.output !== null }])), unhandled: [...unhandled], calls: [...calls], requestReplies: structuredClone(requestReplies), requestEvidence: structuredClone(requestEvidence) };
    },
    async stop() {
      releaseMessageRead();
      clearInterval(keepalive);
      closeStreams();
      await server.stop(true);
    },
  };
}
