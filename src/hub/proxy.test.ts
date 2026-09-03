import { describe, expect, test } from "bun:test";

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
  test("a downstream body cancel releases the child's stream", async () => {
    const child = streamingChild();
    try {
      const response = await proxyHttp(new Request("http://hub.example/s/project/api/events"), child.session);
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
        new Request("http://hub.example/s/project/api/events", { signal: controller.signal }),
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

  test("a request already aborted before proxying never leaves a live child stream", async () => {
    const child = streamingChild();
    try {
      const controller = new AbortController();
      controller.abort();
      const request = new Request("http://hub.example/s/project/api/events", { signal: controller.signal });
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
      const response = await proxyHttp(new Request("http://hub.example/s/project/api/events?finite=1"), child.session);
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
      basePath: "/s/project/",
      // Nothing is listening here; the fetch fails immediately.
      endpoint: { hostname: "127.0.0.1", port: 1 },
      token: "child-secret",
      exited: new Promise(() => undefined),
      async stop() {},
    };
    const controller = new AbortController();
    const response = await proxyHttp(
      new Request("http://hub.example/s/project/api/events", { signal: controller.signal }),
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
        new Request("http://hub.example/s/project/api/events?finite=1", { signal: controller.signal }),
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
    expect(classifyProxyTransport("/s/my-project/api/events")).toBe("document");
    expect(classifyProxyTransport("/s/my-project/api/chat/conversations/events")).toBe("chat-inventory");
    expect(classifyProxyTransport("/s/my-project/api/chat/conversations/opencode:local/events")).toBe("chat-conversation");
    expect(classifyProxyTransport("/s/my-project/api/search")).toBe("search");
    expect(classifyProxyTransport("/s/my-project/assets/chunk-abc.js")).toBe("other");
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
        new Request("http://hub.example/s/project/api/events?t=browser-value&secret=hunter2", {
          headers: { cookie: "uatu_hub=session-cookie", authorization: "Bearer user-token" },
        }),
        child.session,
      );
      const reader = response.body!.getReader();
      await reader.read();
      expect(records).toHaveLength(0);

      await reader.cancel();
      await waitFor(() => records.length === 1);
      expect(records[0]).toEqual({ transport: "document", outcome: "cancelled", status: "2xx" });

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
        "/s/project/api/events",
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
        basePath: "/s/project/",
        endpoint: { hostname: "127.0.0.1", port: 1 },
        token: "child-secret",
        exited: new Promise(() => undefined),
        async stop() {},
      };
      const response = await proxyHttp(new Request("http://hub.example/s/project/api/events"), session);
      expect(response.status).toBe(502);
      expect(records).toEqual([{ transport: "document", outcome: "failed", status: "unreachable" }]);
    } finally {
      setProxyStreamDiagnostics(null);
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
      const response = await proxyHttp(new Request("http://hub.example/s/project/api/events?finite=1"), child.session);
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
    basePath: "/s/project/",
    endpoint: { hostname: "127.0.0.1", port: server.port! },
    token: "child-secret",
    exited: new Promise(() => undefined),
    async stop() {},
  };
  return { server, session, state };
}
