import { describe, expect, test } from "bun:test";

import { isCompressibleType, proxyHttp, sendableCloseCode } from "./proxy";
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
