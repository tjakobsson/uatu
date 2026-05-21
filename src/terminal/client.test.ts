import { describe, expect, it } from "bun:test";

import { buildTerminalWebSocketUrl } from "./client";

describe("buildTerminalWebSocketUrl", () => {
  it("strips a fragment identifier from the page URL", () => {
    const url = buildTerminalWebSocketUrl(
      "http://127.0.0.1:4711/docs/foo.md#user-content-section-id",
      "11111111-1111-1111-1111-111111111111",
      "tok",
    );
    expect(url).not.toContain("#");
  });

  it("upgrades http to ws", () => {
    const url = buildTerminalWebSocketUrl(
      "http://127.0.0.1:4711/",
      "11111111-1111-1111-1111-111111111111",
      null,
    );
    expect(url.startsWith("ws://")).toBe(true);
  });

  it("upgrades https to wss", () => {
    const url = buildTerminalWebSocketUrl(
      "https://example.com/",
      "11111111-1111-1111-1111-111111111111",
      null,
    );
    expect(url.startsWith("wss://")).toBe(true);
  });

  it("sets the pathname to /api/terminal", () => {
    const url = buildTerminalWebSocketUrl(
      "http://127.0.0.1:4711/some/deep/path.md",
      "11111111-1111-1111-1111-111111111111",
      null,
    );
    expect(new URL(url).pathname).toBe("/api/terminal");
  });

  it("includes the sessionId parameter", () => {
    const url = buildTerminalWebSocketUrl(
      "http://127.0.0.1:4711/",
      "abc-session",
      null,
    );
    expect(new URL(url).searchParams.get("sessionId")).toBe("abc-session");
  });

  it("includes the token when provided", () => {
    const url = buildTerminalWebSocketUrl(
      "http://127.0.0.1:4711/",
      "sid",
      "mytoken",
    );
    expect(new URL(url).searchParams.get("t")).toBe("mytoken");
  });

  it("omits the token when null", () => {
    const url = buildTerminalWebSocketUrl(
      "http://127.0.0.1:4711/",
      "sid",
      null,
    );
    expect(new URL(url).searchParams.has("t")).toBe(false);
  });

  it("produces a URL the WebSocket constructor accepts", () => {
    const url = buildTerminalWebSocketUrl(
      "http://127.0.0.1:4711/docs/foo.md#user-content-section",
      "sid",
      "tok",
    );
    // The WebSocket constructor synchronously throws SyntaxError for URLs
    // with fragments. We can't easily open a real socket from a unit test,
    // but the URL-validation portion of the constructor runs before any
    // network I/O, so this is a sufficient guard against the regression.
    expect(() => new WebSocket(url)).not.toThrow();
  });
});
