import { describe, expect, it } from "bun:test";

import {
  applyTerminalInputTransform,
  buildTerminalWebSocketUrl,
  classifyAuthProbeStatus,
  pasteTerminalInput,
  terminalBufferText,
} from "./client";
import { composeStickyCtrl, createStickyCtrl } from "./sticky-ctrl";

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

describe("classifyAuthProbeStatus", () => {
  it("maps 204 to a sessionId collision (credentials and origin both fine)", () => {
    expect(classifyAuthProbeStatus(204)).toBe("collision");
  });

  it("maps 403 to origin-rejected (valid credentials, refused address)", () => {
    expect(classifyAuthProbeStatus(403)).toBe("origin-rejected");
  });

  it("maps 401 to auth-required (paste-token form)", () => {
    expect(classifyAuthProbeStatus(401)).toBe("auth-required");
  });

  it("maps anything unexpected to auth-required, never to a reconnect", () => {
    // The form is the safe default: it can't loop, and its copy tells the
    // user where to find a fresh token.
    expect(classifyAuthProbeStatus(0)).toBe("auth-required");
    expect(classifyAuthProbeStatus(500)).toBe("auth-required");
    expect(classifyAuthProbeStatus(200)).toBe("auth-required");
  });
});

describe("pasteTerminalInput", () => {
  it("uses xterm's semantic paste path when connected", () => {
    const pasted: string[] = [];
    const activeStates: boolean[] = [];
    const term = {
      paste: (text: string) => {
        expect(activeStates.at(-1)).toBe(true);
        pasted.push(text);
      },
    };

    expect(
      pasteTerminalInput(term, true, "one\ntwo", active => activeStates.push(active)),
    ).toBe(true);
    expect(pasted).toEqual(["one\ntwo"]);
    expect(activeStates).toEqual([true, false]);
  });

  it("is inert when disconnected, unmounted, or empty", () => {
    const pasted: string[] = [];
    const term = { paste: (text: string) => pasted.push(text) };

    const setActive = () => {
      throw new Error("must not activate");
    };
    expect(pasteTerminalInput(term, false, "text", setActive)).toBe(false);
    expect(pasteTerminalInput(null, true, "text", setActive)).toBe(false);
    expect(pasteTerminalInput(term, true, "", setActive)).toBe(false);
    expect(pasted).toEqual([]);
  });

  it("restores transform state when xterm paste throws", () => {
    const activeStates: boolean[] = [];
    const term = {
      paste: () => {
        throw new Error("disposed");
      },
    };

    expect(() => pasteTerminalInput(term, true, "c", active => activeStates.push(active))).toThrow();
    expect(activeStates).toEqual([true, false]);
  });
});

describe("applyTerminalInputTransform", () => {
  it("bypasses sticky-Ctrl composition for semantic paste and preserves the latch", () => {
    const stickyCtrl = createStickyCtrl();
    stickyCtrl.toggle();
    const transform = (data: string) => {
      const result = composeStickyCtrl(stickyCtrl.isArmed(), data);
      if (result.composed) stickyCtrl.disarm();
      return result.output;
    };

    expect(applyTerminalInputTransform("c", transform, true)).toBe("c");
    expect(stickyCtrl.isArmed()).toBe(true);
    expect(applyTerminalInputTransform("c", transform, false)).toBe("\x03");
    expect(stickyCtrl.isArmed()).toBe(false);
  });
});

describe("terminalBufferText", () => {
  function buffer(lines: Array<{ text: string; wrapped?: boolean }>) {
    return {
      length: lines.length,
      getLine(index: number) {
        const line = lines[index];
        if (!line) return undefined;
        return {
          isWrapped: line.wrapped ?? false,
          translateToString: () => line.text,
        };
      },
    } as Parameters<typeof terminalBufferText>[0];
  }

  it("preserves hard line breaks and interior blank lines", () => {
    expect(terminalBufferText(buffer([
      { text: "first" },
      { text: "" },
      { text: "third" },
    ]))).toBe("first\n\nthird");
  });

  it("joins wrapped rows into their logical line", () => {
    expect(terminalBufferText(buffer([
      { text: "long " },
      { text: "command", wrapped: true },
      { text: "next" },
    ]))).toBe("long command\nnext");
  });

  it("removes trailing empty screen rows", () => {
    expect(terminalBufferText(buffer([
      { text: "prompt" },
      { text: "" },
      { text: "" },
    ]))).toBe("prompt");
  });
});

describe("persistTerminalToken", () => {
  it("notifies credential-refresh listeners only when the server accepts the token", async () => {
    const { persistTerminalToken, onWorkspaceCredentialRefresh } = await import("./client");
    let refreshes = 0;
    onWorkspaceCredentialRefresh(() => { refreshes += 1; });
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
      expect(await persistTerminalToken("stale")).toBe(false);
      expect(refreshes).toBe(0);
      globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
      expect(await persistTerminalToken("fresh")).toBe(true);
      expect(refreshes).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
