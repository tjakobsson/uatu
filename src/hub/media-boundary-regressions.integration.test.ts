import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubSessionStore, hubCookieName } from "./auth";
import { EMPTY_CREDENTIAL_CONTEXT_RESOLVER } from "./credential-context";
import { PersonalWorkspaceStateStore } from "./personal-state";
import { WorkspaceRegistry } from "./registry";
import { startHubServer } from "./server";
import { SessionManager } from "./sessions";

// Exercise the public product listener, not a second test HTTP boundary.
// The scripted child supplies observable HTTP/WS lifecycles without a PTY.
let directory = "", origin = "", cookie = "", bearer = "";
let hub: ReturnType<typeof startHubServer>;
let child: ReturnType<typeof Bun.serve<{ takeover: boolean }>>;
let sessions: SessionManager;
let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
let streamCancelled = false, wsRequests = 0, wsActive = 0;
let releaseUpgrade: (() => void) | null = null;
let upgradesSettled = 0, upgradesSucceeded = 0, wsOpened = 0;
const wsCloses: Array<{ code: number; reason: string }> = [];
const credential = "synthetic-boundary-child-credential";
const encoder = new TextEncoder();

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "uatu-boundary-regressions-"));
  child = Bun.serve<{ takeover: boolean }>({ hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/s/project/")) return new Response(null, { status: 404 });
      if (url.searchParams.get("t") !== credential || request.headers.get("origin") !== `http://127.0.0.1:${child.port}`) {
        return new Response(null, { status: 403 });
      }
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        wsRequests++;
        if (url.searchParams.has("delayed")) await new Promise<void>(resolve => { releaseUpgrade = resolve; });
        const upgraded = server.upgrade(request, { data: { takeover: url.searchParams.has("takeover") } });
        if (upgraded) upgradesSucceeded++;
        upgradesSettled++;
        if (upgraded) return;
        return new Response(null, { status: 500 });
      }
      if (url.pathname.endsWith("/api/search")) {
        streamCancelled = false;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { stream = controller; controller.enqueue(encoder.encode(": open\n\n")); },
          cancel() { streamCancelled = true; stream = null; },
        }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store, no-transform" } });
      }
      if (url.pathname.endsWith("/api/state")) return Response.json({
        method: request.method, host: request.headers.get("host"), origin: request.headers.get("origin"),
        body: request.method === "POST" ? await request.text() : null,
        privateMetadata: [...request.headers.keys()].filter(name => name.startsWith("x-uatu-hub-")),
      });
      return new Response(null, { status: 404 });
    },
    websocket: {
      open(socket) { wsOpened++; wsActive++; socket.send("ready"); if (socket.data.takeover) socket.close(4410, "session taken"); },
      message(socket, message) { socket.send(message); },
      close(_socket, code, reason) { wsActive--; wsCloses.push({ code, reason }); },
    },
  });
  const registry = new WorkspaceRegistry(path.join(directory, "registry.json"));
  await registry.load(); await registry.register(path.join(directory, "project"));
  sessions = new SessionManager(registry, { local: { start: async (workspace, basePath) => ({
    workspaceId: workspace.id, basePath, instanceId: crypto.randomUUID(), policyTrust: "unavailable",
    endpoint: { hostname: "127.0.0.1", port: child.port! }, token: credential,
    exited: new Promise(() => {}), async stop() {},
  }) } }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);
  await sessions.start("project");
  const sessionStore = new HubSessionStore(path.join(directory, "sessions.json"));
  bearer = (await sessionStore.issue("test", "synthetic boundary device")).id;
  const personalState = new PersonalWorkspaceStateStore(path.join(directory, "personal.json"));
  await personalState.load();
  hub = startHubServer({ config: { host: "127.0.0.1", port: 0, tls: null, stateDir: directory,
    users: [{ name: "test", passwordHash: "unused" }] }, registry, sessions, sessionStore, personalState });
  origin = `http://127.0.0.1:${hub.port}`;
  cookie = `${hubCookieName(new URL(origin))}=${bearer}`;
});

afterAll(async () => {
  hub?.live.endAll(); hub?.liveBroker.dispose(); await hub?.cloneJobs.close();
  await sessions?.stopAll(); await hub?.stop(true); await child?.stop(true);
  if (directory) await rm(directory, { recursive: true, force: true });
});

function websocket(headers: Record<string, string>, query = "") {
  const socket = new WebSocket(`${origin.replace("http:", "ws:")}/s/project/api/terminal?t=forged${query}`, { headers } as never);
  const frames: string[] = [];
  let closed: { code: number; reason: string } | null = null;
  socket.addEventListener("message", event => frames.push(String(event.data)));
  socket.addEventListener("close", event => { closed = { code: event.code, reason: event.reason }; });
  socket.addEventListener("error", () => {});
  return { socket, frames, closed: () => closed };
}

describe("media boundary preserves the other Hub protocols", () => {
  test("proxied SSE flushes startup and later chunks independently and cancellation reaches the child", async () => {
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 4000);
    try {
      const response = await fetch(`${origin}/s/project/api/search`, { headers: { cookie, "accept-encoding": "gzip" }, signal: abort.signal });
      expect(response.status).toBe(200); expect(response.headers.get("content-encoding")).toBeNull();
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(": open\n\n");
      for (const frame of ["event: result\ndata: first\n\n", "event: result\ndata: second\n\n"]) {
        stream!.enqueue(encoder.encode(frame));
        expect(new TextDecoder().decode((await reader.read()).value)).toBe(frame);
      }
      await reader.cancel();
      await waitFor(() => streamCancelled, "forwarded SSE cancellation");
    } finally { clearTimeout(deadline); abort.abort(); }
  });

  test("the original Host governs cookie Origin checks before the child receives brokered authority", async () => {
    const host = `public.example:${hub.port}`;
    const url = `${origin}/s/project/api/state?t=forged`;
    const accepted = await fetch(url, { method: "POST", headers: { host, origin: `http://${host}`, cookie,
      "x-uatu-hub-principal": "forged", "content-type": "text/plain" }, body: "streamed request" });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ method: "POST", host: `127.0.0.1:${child.port}`,
      origin: `http://127.0.0.1:${child.port}`, body: "streamed request", privateMetadata: [] });
    for (const foreign of [origin, "https://foreign.example", "null"]) {
      const refused = await fetch(url, { method: "POST", headers: { host, origin: foreign, cookie }, body: "refused" });
      expect(refused.status).toBe(403); await refused.body?.cancel();
    }
    const native = await fetch(url, { headers: { authorization: `Bearer ${bearer}`, origin: "https://native.example" } });
    expect(native.status).toBe(200); await native.body?.cancel();
  });

  test("WebSocket upgrades retain authentication, origin refusal, messages, close codes, and child release", async () => {
    const before = wsRequests;
    const refusedHeaders: Record<string, string>[] = [{ origin }, { cookie, origin: "https://foreign.example" }];
    for (const headers of refusedHeaders) {
      const refused = websocket(headers);
      try { await waitFor(() => refused.closed() !== null, "refused WebSocket"); expect(wsRequests).toBe(before); }
      finally { refused.socket.close(); }
    }
    const client = websocket({ cookie, origin });
    try {
      await waitFor(() => client.frames.includes("ready"), "WebSocket startup");
      expect(wsActive).toBe(1);
      client.socket.send("one transport");
      await waitFor(() => client.frames.includes("one transport"), "WebSocket echo");
      client.socket.close(4001, "user-close");
      await waitFor(() => wsActive === 0, "WebSocket child release");
      expect(wsCloses.at(-1)).toEqual({ code: 4001, reason: "user-close" });
    } finally { client.socket.close(); }
    const takeover = websocket({ cookie, origin }, "&takeover=1");
    try {
      await waitFor(() => takeover.closed() !== null, "child takeover close");
      expect(takeover.closed()).toEqual({ code: 4410, reason: "session taken" });
      await waitFor(() => wsActive === 0, "takeover child release");
    } finally { takeover.socket.close(); }
  });

  test("login rate limiting retains the trusted proxy's last client-IP hop", async () => {
    const login = async (forwardedFor: string) => {
      const response = await fetch(`${origin}/login`, { method: "POST", headers: {
        "content-type": "application/json", "x-forwarded-for": forwardedFor,
      }, body: JSON.stringify({ name: "nonexistent-boundary-user", password: "wrong" }) });
      await response.body?.cancel(); return response.status;
    };
    for (let i = 0; i < 5; i++) expect(await login(`192.0.2.${i + 1}, 198.51.100.17`)).toBe(401);
    expect(await login("192.0.2.99, 198.51.100.17")).toBe(429);
    expect(await login("192.0.2.99, 198.51.100.18")).toBe(401);
  });

  test("a WebSocket abandoned before child readiness does not leave a child connection", async () => {
    const settled = upgradesSettled, succeeded = upgradesSucceeded, opened = wsOpened;
    const client = websocket({ cookie, origin }, "&delayed=1");
    try {
      await waitFor(() => releaseUpgrade !== null && client.socket.readyState === WebSocket.OPEN, "pending child upgrade");
      client.socket.send("must not survive departure");
      client.socket.close(1001, "page hidden");
      await waitFor(() => client.closed() !== null, "early browser departure");
      releaseUpgrade!(); releaseUpgrade = null;
      await waitFor(() => upgradesSettled > settled, "pending child upgrade disposal");
      if (upgradesSucceeded > succeeded) await waitFor(() => wsOpened > opened, "late child open");
      await waitFor(() => wsActive === 0, "early departure child release");
      expect(client.frames).toEqual([]);
    } finally {
      releaseUpgrade?.(); releaseUpgrade = null; client.socket.close();
    }
  });
});
