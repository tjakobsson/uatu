import { describe, expect, spyOn, test } from "bun:test";

import {
  classifyProxyTransport,
  isCompressibleType,
  proxyHttp,
  sendableCloseCode,
  setProxyStreamDiagnostics,
  statusCategoryOf,
  PROXY_STATUS_CATEGORIES,
  PROXY_TRANSPORT_CLASSES,
  type ProxyStreamDiagnostic,
} from "./proxy";
import type { RunningSession } from "./backend";

describe("isCompressibleType", () => {
  test("compresses text, JS, JSON, and SVG", () => {
    expect(isCompressibleType("text/javascript;charset=utf-8")).toBe(true);
    expect(isCompressibleType("text/css")).toBe(true);
    expect(isCompressibleType("text/html; charset=utf-8")).toBe(true);
    expect(isCompressibleType("application/json")).toBe(true);
    expect(isCompressibleType("application/manifest+json")).toBe(true);
    expect(isCompressibleType("image/svg+xml")).toBe(true);
  });

  test("never buffers incremental feeds or binary media", () => {
    expect(isCompressibleType("text/event-stream")).toBe(false);
    expect(isCompressibleType("application/x-ndjson; charset=utf-8")).toBe(false);
    expect(isCompressibleType("font/woff2")).toBe(false);
    expect(isCompressibleType("image/png")).toBe(false);
    expect(isCompressibleType("")).toBe(false);
  });
});

describe("sendableCloseCode", () => {
  test("passes app codes through and maps report-only codes to 1000", () => {
    expect(sendableCloseCode(4001)).toBe(4001);
    expect(sendableCloseCode(4410)).toBe(4410);
    expect(sendableCloseCode(1005)).toBe(1000);
    expect(sendableCloseCode(1006)).toBe(1000);
  });
});

describe("chat SSE proxying", () => {
  test("Hub discard enforces authentication and CSRF before forwarding caller-scoped workspace requests", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { HubSessionStore, hubCookieName } = await import("./auth");
    const { WorkspaceRegistry } = await import("./registry");
    const { SessionManager } = await import("./sessions");
    const { PersonalWorkspaceStateStore } = await import("./personal-state");
    const { PersonalChatPreferencesStore } = await import("./personal-chat-preferences");
    const { EMPTY_CREDENTIAL_CONTEXT_RESOLVER } = await import("./credential-context");
    const { startHubServer } = await import("./server");
    const root = await mkdtemp(join(tmpdir(), "discard-hub-protection-"));
    const seen: Array<{ workspace: string; messageId: string; body: Record<string, unknown>; trustedOnly: boolean }> = [];
    const child = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const url = new URL(request.url);
      const workspace = url.pathname.split("/")[2]!;
      if (!url.pathname.endsWith("/discard-unconfirmed")) return new Response(null, { status: 404 });
      if (url.searchParams.get("t") !== `synthetic-${workspace}` || request.headers.get("origin") !== `http://127.0.0.1:${child.port}`) return new Response(null, { status: 403 });
      seen.push({ workspace, messageId: decodeURIComponent(url.pathname.split("/").at(-2)!), body: await request.json(), trustedOnly: !request.headers.has("x-uatu-hub-principal") && !request.headers.has("x-uatu-hub-chat-policy") && !request.headers.has("x-uatu-hub-operation-receipt") });
      return Response.json({ discarded: true, outcomeUnconfirmed: true });
    } });
    const registry = new WorkspaceRegistry(join(root, "registry.json"));
    await registry.load();
    await registry.register(join(root, "alpha"));
    await registry.register(join(root, "beta"));
    const sessions = new SessionManager(registry, { local: { start: async (workspace, basePath) => ({ workspaceId: workspace.id, basePath, instanceId: crypto.randomUUID(), policyTrust: "unavailable", endpoint: { hostname: "127.0.0.1", port: child.port! }, token: `synthetic-${workspace.id}`, exited: new Promise(() => {}), stop: async () => {} }) } }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);
    const sessionStore = new HubSessionStore(join(root, "synthetic-sessions.json"));
    const alice = await sessionStore.issue("alice", "synthetic test device"), bob = await sessionStore.issue("bob", "synthetic test device");
    const aliceSibling = await sessionStore.issue("alice", "second synthetic test device");
    const personalChatPreferences = new PersonalChatPreferencesStore(join(root, "chat-preferences.json"));
    await personalChatPreferences.load();
    let preferenceReads = 0;
    const readPreferences = personalChatPreferences.get.bind(personalChatPreferences);
    personalChatPreferences.get = user => { preferenceReads++; return readPreferences(user); };
    const hub = startHubServer({ config: { port: 0, host: "127.0.0.1", tls: null, stateDir: root, users: [{ name: "alice", passwordHash: "unused-no-login" }, { name: "bob", passwordHash: "unused-no-login" }] }, registry, sessions, sessionStore, personalState: new PersonalWorkspaceStateStore(join(root, "personal.json")), personalChatPreferences });
    const origin = `http://127.0.0.1:${hub.port}`;
    const path = (workspace: string, messageId = "unknown") => `${origin}/s/${workspace}/api/chat/conversations/opencode:one/queue/${encodeURIComponent(messageId)}/discard-unconfirmed`;
    const data = JSON.stringify({ requestId: "shared-client-id", uncertaintyId: "opaque-uncertainty" });
    const cookie = `${hubCookieName(new URL(origin))}=${alice.id}`;
    try {
      await sessions.start("alpha"); await sessions.start("beta");
      expect((await fetch(path("alpha"), { method: "POST", headers: { "content-type": "application/json" }, body: data })).status).toBe(401);
      expect((await fetch(path("alpha"), { method: "POST", headers: { cookie, origin: "https://foreign.example", "content-type": "application/json" }, body: data })).status).toBe(403);
      expect((await fetch(path("alpha"), { method: "POST", headers: { cookie, origin: "null", "content-type": "application/json" }, body: data })).status).toBe(403);
      expect(seen).toEqual([]);
      const send = async (workspace: string, headers: Record<string, string>, messageId = "unknown", uncertaintyId = "opaque-uncertainty") => {
        const response = await fetch(path(workspace, messageId), { method: "POST", headers: { "content-type": "application/json", "x-uatu-hub-principal": "forged", "x-uatu-hub-chat-policy": "forged-policy", "x-uatu-hub-operation-receipt": "opr_forged", ...headers }, body: JSON.stringify({ requestId: "shared-client-id", uncertaintyId }) });
        expect(await response.json()).toEqual({ discarded: true, outcomeUnconfirmed: true });
        return seen.at(-1)!;
      };
      const first = await send("alpha", { cookie, origin });
      const retry = await send("alpha", { authorization: `Bearer ${alice.id}` });
      const sibling = await send("alpha", { authorization: `Bearer ${aliceSibling.id}` });
      const otherCaller = await send("alpha", { authorization: `Bearer ${bob.id}`, origin: "https://native-client.example" });
      const otherWorkspace = await send("beta", { cookie, origin });
      expect(first.body.requestId).not.toBe("shared-client-id");
      expect(retry.body.requestId).toBe(first.body.requestId);
      expect(sibling.body.requestId).toBe(first.body.requestId);
      expect(otherCaller.body.requestId).not.toBe(first.body.requestId);
      expect(otherWorkspace.body.requestId).not.toBe(first.body.requestId);
      expect(seen.every(entry => entry.trustedOnly && entry.body.uncertaintyId === "opaque-uncertainty")).toBe(true);
      const otherMessage = await send("alpha", { cookie, origin }, "other-message");
      expect(otherMessage.messageId).toBe("other-message");
      expect(otherMessage.body.requestId).not.toBe(first.body.requestId);
      const otherUncertainty = await send("alpha", { cookie, origin }, "unknown", "fresh-uncertainty");
      expect(otherUncertainty.messageId).toBe("unknown");
      expect(otherUncertainty.body.uncertaintyId).toBe("fresh-uncertainty");
      expect(otherUncertainty.trustedOnly).toBe(true);
      const count = seen.length;
      expect((await fetch(path("absent"), { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: data })).status).toBe(503);
      expect(seen).toHaveLength(count);
      expect(preferenceReads).toBe(0);
    } finally {
      await hub.cloneJobs.close(); await sessions.stopAll(); await hub.stop(true); await child.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  });
  test("local discard namespaces request IDs by verified caller and running workspace without policy side effects", async () => {
    const seen: Array<{ pathname: string; body: Record<string, unknown>; headers: Headers }> = [];
    const child = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      seen.push({ pathname: new URL(request.url).pathname, body: await request.json(), headers: request.headers });
      return Response.json({ discarded: true, outcomeUnconfirmed: true });
    } });
    const session: RunningSession = { workspaceId: "alpha", endpoint: { hostname: "127.0.0.1", port: child.port! }, token: "synthetic-child-token", basePath: "/s/alpha/", instanceId: crypto.randomUUID(), policyTrust: "unavailable", exited: new Promise(() => {}), stop: async () => {} };
    const send = async (principal: string, workspace = session, requestId: unknown = "same-client-request") => {
      const response = await proxyHttp(new Request(`http://hub${workspace.basePath}api/chat/conversations/opencode:one/queue/unknown/discard-unconfirmed`, {
        method: "POST", headers: { "content-type": "application/json", "x-uatu-hub-principal": "forged-account", "x-uatu-hub-chat-policy": "forged-policy", "x-uatu-hub-operation-receipt": "opr_forged" },
        body: JSON.stringify({ requestId, uncertaintyId: "opaque-uncertainty" }),
      }), workspace, { principal, revision: 1, autoBackgroundOnSteer: true });
      expect(await response.json()).toEqual({ discarded: true, outcomeUnconfirmed: true });
      return seen.at(-1)!;
    };
    try {
      const alice = await send("alice"), retry = await send("alice"), bob = await send("bob");
      expect(alice.body.requestId).not.toBe("same-client-request");
      expect(retry.body.requestId).toBe(alice.body.requestId);
      expect(bob.body.requestId).not.toBe(alice.body.requestId);
      const other: RunningSession = { ...session, workspaceId: "beta", basePath: "/s/beta/", instanceId: crypto.randomUUID() };
      expect((await send("alice", other)).body.requestId).not.toBe(alice.body.requestId);
      for (const entry of seen) {
        expect(entry.body.uncertaintyId).toBe("opaque-uncertainty");
        expect(entry.headers.get("x-uatu-hub-principal")).toBeNull();
        expect(entry.headers.get("x-uatu-hub-chat-policy")).toBeNull();
        expect(entry.headers.get("x-uatu-hub-operation-receipt")).toBeNull();
        expect(JSON.stringify(entry.body)).not.toMatch(/alice|bob|forged/);
      }
      // Rewriting must not turn an invalid caller identity into a valid one.
      for (const requestId of [null, 1, "", "bad\nidentity", "x".repeat(513)]) expect((await send("alice", session, requestId)).body.requestId).toBe(requestId);
    } finally { await child.stop(true); }
  });
  test("degraded Hub operation tokens separate accounts without asserting a principal or changing client correlation", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      return Response.json({ delivery: "steer", headers: Object.fromEntries(request.headers), body: await request.json() });
    } });
    const session: RunningSession = { workspaceId: "project", endpoint: { hostname: "127.0.0.1", port: server.port! }, token: "workspace-credential", basePath: "/s/project/", instanceId: crypto.randomUUID(), policyTrust: "unavailable", exited: new Promise(() => {}), stop: async () => {} };
    const send = async (principal: string, enabled = true) => await (await proxyHttp(new Request("http://hub/s/project/api/chat/conversations/opencode:parent/prompts", {
      method: "POST", headers: { "content-type": "application/json", "x-uatu-hub-operation-receipt": "opr_forged" }, body: JSON.stringify({ requestId: "shared-client-id", text: "Fixture", delivery: "steer" }),
    }), session, { principal, revision: enabled ? 0 : 1, autoBackgroundOnSteer: enabled })).json();
    try {
      const a = await send("alice"), retry = await send("alice"), b = await send("bob");
      const key = "x-uatu-hub-operation-receipt";
      expect(a.headers[key]).toMatch(/^opr_[A-Za-z0-9_-]{43}$/);
      expect(retry.headers[key]).toBe(a.headers[key]); expect(b.headers[key]).not.toBe(a.headers[key]);
      expect(a.body.requestId).toBe("shared-client-id");
      expect((await send("alice", false)).automaticBackground).toBe("unavailable");
      expect((await send("off-first", false)).automaticBackground).toBeUndefined();
      expect((await send("off-first", true)).automaticBackground).toBeUndefined();
      expect(a.headers["x-uatu-hub-chat-policy"]).toBeUndefined();
      expect(JSON.stringify(a)).not.toMatch(/alice|principal|receiptScope/);
      const replacement = { ...session, instanceId: crypto.randomUUID() };
      const response = await proxyHttp(new Request("http://hub/s/project/api/chat/conversations/opencode:parent/prompts", { method: "POST", body: '{"requestId":"shared-client-id","text":"Fixture","delivery":"steer"}' }), replacement, { principal: "alice", revision: 0, autoBackgroundOnSteer: false });
      expect((await response.json()).headers[key]).not.toBe(a.headers[key]);
    } finally { server.stop(true); }
  });
  test("reserved Hub policy metadata is stripped from ordinary and unrelated requests", async () => {
    const child = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { return Response.json(Object.fromEntries(request.headers)); } });
    const session: RunningSession = {
      workspaceId: "project", instanceId: crypto.randomUUID(), policyTrust: "unavailable",
      basePath: "/s/project/", endpoint: { hostname: "127.0.0.1", port: child.port! }, token: null,
      exited: new Promise(() => undefined), async stop() {},
    };
    try {
      const response = await proxyHttp(new Request("http://hub.example/s/project/api/state", { headers: {
        "x-uatu-hub-chat-policy": "forged-policy", "x-uatu-hub-principal": "foreign-account", "x-uatu-hub-operation-receipt": `opr_${"a".repeat(43)}`, "x-normal": "preserved",
      } }), session);
      const received = await response.json() as Record<string, string>;
      expect(received["x-uatu-hub-chat-policy"]).toBeUndefined();
      expect(received["x-uatu-hub-operation-receipt"]).toBeUndefined();
      expect(received["x-uatu-hub-principal"]).toBeUndefined();
      expect(received["x-normal"]).toBe("preserved");
    } finally { await child.stop(true); }
  });
  test("brokers the child credential and forwards replay frames without buffering or leaking it", async () => {
    let target = "";
    const child = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        target = request.url;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("id: first\nevent: chat\ndata: {}\n\n"));
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no",
          },
        });
      },
    });
    const session: RunningSession = {
      workspaceId: "project",
      instanceId: crypto.randomUUID(), policyTrust: "unavailable",
      basePath: "/s/project/",
      endpoint: { hostname: "127.0.0.1", port: child.port! },
      token: "child-secret",
      exited: new Promise(() => undefined),
      async stop() {},
    };
    try {
      const response = await proxyHttp(new Request(
        "http://hub.example/s/project/api/chat/conversations/local/events?t=browser-value",
      ), session);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("x-accel-buffering")).toBe("no");
      const first = await response.body!.getReader().read();
      expect(new TextDecoder().decode(first.value)).toContain("event: chat");
      expect(target).toContain("t=child-secret");
      expect(target).not.toContain("browser-value");
      expect(JSON.stringify([...response.headers])).not.toContain("child-secret");
    } finally {
      await child.stop(true);
    }
  });
});

describe("proxied stream cancellation", () => {
  test("media and no-transform responses bypass buffering and rewriting regardless of MIME", async () => {
    const session: RunningSession = {
      workspaceId: "project", instanceId: crypto.randomUUID(), policyTrust: "unavailable",
      basePath: "/s/project/", endpoint: { hostname: "127.0.0.1", port: 1 }, token: "private-child-token",
      exited: new Promise(() => {}), async stop() {},
    };
    for (const [route, contentType, cacheControl] of [
      ["api/media", "text/html", "no-store"],
      ["api/media", "application/json", "no-store"],
      ["asset", "text/html", "private, NO-TRANSFORM"],
      ["asset", "application/json", "no-store, no-transform"],
    ]) {
      let reads = 0, cancelled = false;
      let upstreamSignal: AbortSignal | undefined;
      const mocked = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
        expect(new Headers(init?.headers).get("accept-encoding")).toBe("identity");
        upstreamSignal = init?.signal as AbortSignal;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) { reads++; controller.enqueue(new Uint8Array(64 * 1024)); },
          cancel() { cancelled = true; },
        }, { highWaterMark: 0 }), { headers: {
          "content-type": contentType!, "cache-control": cacheControl!,
          "content-length": String(1024 ** 4), "accept-ranges": "bytes", "content-encoding": "identity",
        } });
      }) as typeof fetch);
      try {
        const response = await proxyHttp(new Request(`http://hub/s/project/${route}`, { headers: { "accept-encoding": "gzip" } }), session);
        expect(reads).toBe(0);
        expect(response.headers.get("content-length")).toBe(String(1024 ** 4));
        expect(response.headers.get("content-encoding")).toBeNull();
        expect(response.headers.get("accept-ranges")).toBe("bytes");
        const reader = response.body!.getReader();
        expect((await reader.read()).value!.byteLength).toBe(64 * 1024);
        expect(reads).toBe(1);
        await reader.cancel();
        expect(cancelled).toBe(true);
        expect(upstreamSignal!.aborted).toBe(true);
      } finally { mocked.mockRestore(); }
    }
  });

  test("a downstream body cancel releases the child's stream", async () => {
    const child = streamingChild();
    try {
      const response = await proxyHttp(new Request("http://hub.example/s/project/api/search"), child.session);
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: state");

      await reader.cancel();
      await waitFor(() => child.state.cancelled);
      expect(child.state.cancelled).toBe(true);
    } finally {
      await child.server.stop(true);
    }
  });

  test("a downstream request abort releases the child's stream", async () => {
    const child = streamingChild();
    try {
      const controller = new AbortController();
      const response = await proxyHttp(
        new Request("http://hub.example/s/project/api/search", { signal: controller.signal }),
        child.session,
      );
      const reader = response.body!.getReader();
      await reader.read();

      controller.abort();
      await waitFor(() => child.state.cancelled);
      expect(child.state.cancelled).toBe(true);
    } finally {
      await child.server.stop(true);
    }
  });

  test("a request already aborted before proxying is recorded as a cancellation", async () => {
    const records: ProxyStreamDiagnostic[] = [];
    setProxyStreamDiagnostics(record => records.push(record));
    const child = streamingChild();
    try {
      const controller = new AbortController();
      controller.abort();
      const response = await proxyHttp(
        new Request("http://hub.example/s/project/api/search", { signal: controller.signal }),
        child.session,
      );
      if (response.status === 200) await response.body!.cancel();
      // An abandonment that beat us to the child is still an abandonment, not
      // an unreachable workspace.
      expect(records).toEqual([{ transport: "search", outcome: "cancelled", status: "unreachable" }]);
    } finally {
      setProxyStreamDiagnostics(null);
      await child.server.stop(true);
    }
  });

  test("a request already aborted before proxying never leaves a live child stream", async () => {
    const child = streamingChild();
    try {
      const controller = new AbortController();
      controller.abort();
      const request = new Request("http://hub.example/s/project/api/search", { signal: controller.signal });
      const response = await proxyHttp(request, child.session);
      // Either the fetch never happened (502) or it was aborted immediately;
      // what must not happen is a child subscription outliving the caller.
      if (response.status === 200) await response.body!.cancel();
      await waitFor(() => child.state.requests === 0 || child.state.cancelled);
      expect(child.state.requests === 0 || child.state.cancelled).toBe(true);
    } finally {
      await child.server.stop(true);
    }
  });

  test("normal upstream completion is not treated as a cancellation", async () => {
    const child = streamingChild();
    try {
      const response = await proxyHttp(new Request("http://hub.example/s/project/api/search?finite=1"), child.session);
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: state");
      expect((await reader.read()).done).toBe(true);
      await Bun.sleep(20);
      expect(child.state.completed).toBe(true);
      expect(child.state.cancelled).toBe(false);
    } finally {
      await child.server.stop(true);
    }
  });

  test("an unreachable child answers 502 without leaving the request listener attached", async () => {
    const session: RunningSession = {
      workspaceId: "project",
      instanceId: crypto.randomUUID(), policyTrust: "unavailable",
      basePath: "/s/project/",
      // Nothing is listening here; the fetch fails immediately.
      endpoint: { hostname: "127.0.0.1", port: 1 },
      token: "child-secret",
      exited: new Promise(() => undefined),
      async stop() {},
    };
    const controller = new AbortController();
    const response = await proxyHttp(
      new Request("http://hub.example/s/project/api/search", { signal: controller.signal }),
      session,
    );
    expect(response.status).toBe(502);
    // Cleanup already ran, so a later abort is inert rather than a second
    // teardown of an already-finished stream.
    expect(() => controller.abort()).not.toThrow();
  });

  test("simultaneous cancel and completion settle exactly once", async () => {
    const child = streamingChild();
    try {
      const controller = new AbortController();
      const response = await proxyHttp(
        new Request("http://hub.example/s/project/api/search?finite=1", { signal: controller.signal }),
        child.session,
      );
      const reader = response.body!.getReader();
      await reader.read();
      // Both endings race for the same stream. Cleanup is idempotent, so
      // neither throws and the child is not double-released.
      controller.abort();
      await reader.cancel();
      await Bun.sleep(20);
      expect(child.state.completed).toBe(true);
    } finally {
      await child.server.stop(true);
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
}

describe("proxied stream diagnostics", () => {
  test("classifies stream routes by shape, never by identifier", () => {
    expect(classifyProxyTransport("/s/my-project/api/search")).toBe("search");
    expect(classifyProxyTransport("/s/other-project/api/search")).toBe("search");
    expect(classifyProxyTransport("/s/my-project/assets/chunk-abc.js")).toBe("other");
    // Live SSE routes are no longer proxied at all (the hub refuses them and
    // brokers /api/hub/live instead), so they have no proxied stream class.
    expect(classifyProxyTransport("/s/my-project/api/events")).toBe("other");
    expect(classifyProxyTransport("/s/my-project/api/chat/conversations/events")).toBe("other");
    expect(classifyProxyTransport("/s/my-project/api/chat/conversations/opencode:local/events")).toBe("other");
    // Two different workspaces and two different conversations collapse to
    // the same two class names — the cardinality does not grow with traffic.
    expect(classifyProxyTransport("/s/other/api/chat/conversations/claude:xyz/events"))
      .toBe(classifyProxyTransport("/s/my-project/api/chat/conversations/opencode:local/events"));
  });

  test("maps upstream status to a category, never a code", () => {
    expect(statusCategoryOf(200)).toBe("2xx");
    expect(statusCategoryOf(302)).toBe("3xx");
    expect(statusCategoryOf(404)).toBe("4xx");
    expect(statusCategoryOf(503)).toBe("5xx");
    expect(statusCategoryOf(0)).toBe("unreachable");
  });

  test("records one lifecycle record per stream, drawn only from the fixed vocabulary", async () => {
    const records: ProxyStreamDiagnostic[] = [];
    setProxyStreamDiagnostics(record => records.push(record));
    const child = streamingChild();
    try {
      const response = await proxyHttp(
        new Request("http://hub.example/s/project/api/search?t=browser-value&secret=hunter2", {
          headers: { cookie: "uatu_hub=session-cookie", authorization: "Bearer user-token" },
        }),
        child.session,
      );
      const reader = response.body!.getReader();
      await reader.read();
      expect(records).toHaveLength(0);

      await reader.cancel();
      await waitFor(() => records.length === 1);
      expect(records[0]).toEqual({ transport: "search", outcome: "cancelled", status: "2xx" });

      // Nothing from the request survives into the record: no URL, no query
      // value, no cookie, no authorization header, no brokered child token,
      // and no streamed payload.
      const serialized = JSON.stringify(records);
      for (const forbidden of [
        "browser-value",
        "hunter2",
        "session-cookie",
        "user-token",
        "child-secret",
        "event: state",
        "/s/project/api/search",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
      const permittedKeys = ["transport", "outcome", "status"];
      expect(Object.keys(records[0]!).sort()).toEqual(permittedKeys.sort());
      expect(PROXY_TRANSPORT_CLASSES).toContain(records[0]!.transport);
      expect(PROXY_STATUS_CATEGORIES).toContain(records[0]!.status);
    } finally {
      setProxyStreamDiagnostics(null);
      await child.server.stop(true);
    }
  });

  test("an unreachable child is recorded as a failure with no answer", async () => {
    const records: ProxyStreamDiagnostic[] = [];
    setProxyStreamDiagnostics(record => records.push(record));
    try {
      const session: RunningSession = {
        workspaceId: "project",
        instanceId: crypto.randomUUID(), policyTrust: "unavailable",
        basePath: "/s/project/",
        endpoint: { hostname: "127.0.0.1", port: 1 },
        token: "child-secret",
        exited: new Promise(() => undefined),
        async stop() {},
      };
      const response = await proxyHttp(new Request("http://hub.example/s/project/api/search"), session);
      expect(response.status).toBe(502);
      expect(records).toEqual([{ transport: "search", outcome: "failed", status: "unreachable" }]);
    } finally {
      setProxyStreamDiagnostics(null);
    }
  });

  test("a child that drops mid-stream is recorded as failed and errors without exposing credentials", async () => {
    const records: ProxyStreamDiagnostic[] = [];
    setProxyStreamDiagnostics(record => records.push(record));
    const child = streamingChild();
    try {
      const response = await proxyHttp(new Request("http://hub.example/s/project/api/search"), child.session);
      const reader = response.body!.getReader();
      await reader.read();
      expect(records).toHaveLength(0);

      child.server.stop(true);
      await expect(reader.read()).rejects.toThrow("session response interrupted");
      await waitFor(() => records.length === 1);
      expect(records).toEqual([{ transport: "search", outcome: "failed", status: "2xx" }]);
    } finally {
      setProxyStreamDiagnostics(null);
      child.server.stop(true);
    }
  });

  test("non-stream routes produce no lifecycle records", async () => {
    const records: ProxyStreamDiagnostic[] = [];
    setProxyStreamDiagnostics(record => records.push(record));
    const child = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("body", { headers: { "content-type": "application/octet-stream" } }),
    });
    try {
      const session: RunningSession = {
        workspaceId: "project",
        instanceId: crypto.randomUUID(), policyTrust: "unavailable",
        basePath: "/s/project/",
        endpoint: { hostname: "127.0.0.1", port: child.port! },
        token: "child-secret",
        exited: new Promise(() => undefined),
        async stop() {},
      };
      const response = await proxyHttp(new Request("http://hub.example/s/project/assets/chunk.js"), session);
      await response.arrayBuffer();
      await Bun.sleep(20);
      expect(records).toEqual([]);
    } finally {
      setProxyStreamDiagnostics(null);
      await child.stop(true);
    }
  });

  test("a throwing diagnostic sink cannot break the proxied stream", async () => {
    setProxyStreamDiagnostics(() => { throw new Error("sink exploded"); });
    const child = streamingChild();
    try {
      const response = await proxyHttp(new Request("http://hub.example/s/project/api/search?finite=1"), child.session);
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: state");
      expect((await reader.read()).done).toBe(true);
    } finally {
      setProxyStreamDiagnostics(null);
      await child.server.stop(true);
    }
  });
});

// A child that reports whether its own response stream was cancelled, so
// the test asserts on the child's view rather than on the hub's bookkeeping.
function streamingChild() {
  const state = { cancelled: false, completed: false, requests: 0 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      state.requests += 1;
      const finite = new URL(request.url).searchParams.has("finite");
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: state\ndata: {}\n\n"));
          if (finite) {
            state.completed = true;
            controller.close();
          }
        },
        cancel() {
          state.cancelled = true;
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
    },
  });
  const session: RunningSession = {
    workspaceId: "project",
    instanceId: crypto.randomUUID(), policyTrust: "unavailable",
    basePath: "/s/project/",
    endpoint: { hostname: "127.0.0.1", port: server.port! },
    token: "child-secret",
    exited: new Promise(() => undefined),
    async stop() {},
  };
  return { server, session, state };
}
