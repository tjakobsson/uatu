import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { InvalidQuestionAnswerError, ReversibleHistoryTargetError } from "../../provider";
import { createOpenCodeV2Provider, formAnswerFromChoices, type OpenCodeV2Provider } from "./provider";

// The stored records of a real 2.0.13 session: user, assistant (read tool),
// assistant (text), idle, user — see normalization.test.ts for provenance.
const FIXTURES = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/real-2.0.13.json"), "utf8")) as {
  storedMessages: { data: Array<Record<string, unknown>> };
};
const STORED = FIXTURES.storedMessages.data;
const WORKSPACE = "/ws";
const AUTH = `Basic ${Buffer.from("opencode:pw").toString("base64")}`;

type Call = { method: string; path: string; query: URLSearchParams; body: unknown; headers: Headers };
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
  const patterns = Object.entries(routes).map(([pattern, handler]) => {
    const [method, route] = pattern.split(" ") as [string, string];
    const regex = new RegExp(`^${route.replace(/:[a-zA-Z]+/g, "[^/]+")}$`);
    return { method, regex, handler };
  });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    const url = new URL(request.url);
    const text = await request.clone().text().catch(() => "");
    const call: Call = { method: request.method, path: url.pathname, query: url.searchParams, body: text ? JSON.parse(text) : undefined, headers: request.headers };
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
  const provider = (directory = WORKSPACE, options: { commandAdmissionMs?: number } = {}) => createOpenCodeV2Provider({ endpoint: "http://opencode.test", password: "pw", directory, fetch, ...options }) as OpenCodeV2Provider;
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
const notFound = (sessionID: string) => Response.json({ _tag: "SessionNotFoundError", sessionID, message: `Session not found: ${sessionID}` }, { status: 404 });

describe("OpenCode 2.x provider: identity and catalogs", () => {
  test("declares the capabilities the 2.x stack backs", () => {
    const { provider } = fakeOpenCode({});
    expect(provider().describe()).toMatchObject({ id: "opencode", name: "OpenCode" });
    expect(provider().describe().capabilities).toEqual(["modes", "models", "commands", "questions", "permissions", "subagents", "variants", "context", "conversation-rename", "attachments", "reversible-history"]);
    expect(provider().describe().permissionScopeNote).toContain("until OpenCode restarts");
  });

  test("every catalog call is scoped to the workspace directory and authenticated", async () => {
    const server = fakeOpenCode({
      "GET /api/command": () => scoped([{ name: "review", description: "review changes" }, { name: "bad name" }, { name: "review" }]),
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
      { name: "compact", description: "Compact the conversation context", argumentHint: "", kind: "command" },
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
      { selection: { providerId: "berget", modelId: "think" }, provider: "Berget", name: "Thinker", variants: ["high", "low"], contextLimit: 128000 },
      { selection: { providerId: "opencode", modelId: "flash" }, provider: "OpenCode Zen", name: "Flash", contextLimit: 200000, imageInput: true },
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

  test("a slash command's row takes the inbox id the stream names, ahead of the 204", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": () => {
        // The server enqueues the item and announces it before answering,
        // with its own id and the expanded template as the text.
        events.frame({ id: "evt_1", created: 5, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: "msg_srv1", item: { type: "user", payload: { text: "Create or update AGENTS.md" }, delivery: "queue" } } });
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
    // The streamed row had already been consumed when the admission returned.
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
    const deadline = Date.now() + 2_000;
    while (seen.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual(["upsert message:msg_late", `remove message:${accepted.messageId}`]);
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
    const enqueued = (inboxID: string) => events.frame({ id: `evt_${inboxID}`, created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID, item: { type: "user", payload: { text: "expanded" }, delivery: "queue" } } });
    const a = await provider.command("ses_1", { id: "req-a", name: "init", arguments: "" });
    // B is admitted while A's row is still on its way.
    const b = provider.command("ses_1", { id: "req-b", name: "review", arguments: "" });
    await Bun.sleep(5);
    enqueued("msg_a");
    let deadline = Date.now() + 2_000;
    while (seen.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual(["upsert message:msg_a", `remove message:${a.messageId}`]);
    enqueued("msg_b");
    expect(await b).toEqual({ messageId: "msg_b" });
    deadline = Date.now() + 2_000;
    while (seen.length < 3 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual(["upsert message:msg_a", `remove message:${a.messageId}`, "upsert message:msg_b"]);
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
    const enqueued = (inboxID: string) => events.frame({ id: `evt_${inboxID}`, created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID, item: { type: "user", payload: { text: "expanded" }, delivery: "queue" } } });
    const a = await provider.command("ses_1", { id: "req-a2", name: "init", arguments: "" });
    const b = await provider.command("ses_1", { id: "req-b2", name: "review", arguments: "" });
    enqueued("msg_a");
    enqueued("msg_b");
    const deadline = Date.now() + 2_000;
    while (seen.length < 4 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual(["upsert message:msg_a", `remove message:${a.messageId}`, "upsert message:msg_b", `remove message:${b.messageId}`]);
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
    const deadline = Date.now() + 2_000;
    while (seen.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual(["upsert message:msg_t", `remove message:${accepted.messageId}`]);
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
    const enqueued = (inboxID: string) => events.frame({ id: `evt_${inboxID}`, created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID, item: { type: "user", payload: { text: "t" }, delivery: "queue" } } });
    const command = await provider.command("ses_1", { id: "req-c", name: "init", arguments: "" });
    const prompt = await provider.prompt("ses_1", { id: "req-p", text: "x", delivery: "queue" });
    enqueued(prompt.messageId);
    enqueued("msg_cmd");
    const deadline = Date.now() + 2_000;
    while (seen.length < 3 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`upsert message:${prompt.messageId}`, "upsert message:msg_cmd", `remove message:${command.messageId}`]);
    controller.abort();
    await pump;
  });

  test("a prompt's row announced before the prompt is answered is still a prompt's", async () => {
    const events = pushableEvents();
    const enqueued = (inboxID: string) => events.frame({ id: `evt_${inboxID}`, created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID, item: { type: "user", payload: { text: "t" }, delivery: "queue" } } });
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
    expect(seen).toEqual([`upsert message:${prompt.messageId}`, "upsert message:msg_cmd3", `remove message:${command.messageId}`]);
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
    events.frame({ id: "evt_k3", created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: "msg_cmd9", item: { type: "user", payload: { text: "expanded" }, delivery: "queue" } } });
    const deadline = Date.now() + 2_000;
    while (seen.length < 3 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`upsert message:${compaction.messageId}`, "upsert message:msg_cmd9", `remove message:${command.messageId}`]);
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
      ]),
    });
    expect(await server.provider().listPermissions()).toEqual([
      { requestId: "per_1", conversationId: "ses_1", action: "external_directory", resources: ["/etc/*"], alwaysPatterns: ["/etc/*"] },
      { requestId: "per_2", conversationId: "ses_2", action: "edit", resources: ["src/a.ts"], alwaysPatterns: [], diff: "--- a\n+++ b\n" },
    ]);
    expect(server.calls[0]?.query.get("location[directory]")).toBe(WORKSPACE);
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
