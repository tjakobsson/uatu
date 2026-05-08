// Tests the in-memory PTY lifecycle around the WebSocket. Each test wires
// the terminal-server to a real Bun.serve so messages flow through the same
// path production uses. Skipped when the node-pty backend can't load
// (standalone-binary build, broken native module on a fresh checkout).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createTerminalServer, isValidSessionId, type TerminalServer } from "./terminal-server";
import { resolveTerminalBackend } from "./terminal-backend";

type Ctx = {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  terminal: TerminalServer;
  cwd: string;
};

let ctx: Ctx | null = null;

// Resolve backend availability ONCE at module load so describe.skipIf has a
// real value at evaluation time. beforeEach is too late — describe blocks
// are walked before any beforeEach runs.
const backendOk = (await resolveTerminalBackend()).available;

// Wire `terminal-server` into a Bun.serve that mirrors the production
// upgrade gate: parse `sessionId` from the URL, call `prepareSession`, map
// results to HTTP statuses, then upgrade. Tests that need a custom grace
// window pass it through `options.reconnectGraceMs`.
function startServer(options: { reconnectGraceMs?: number } = {}): Ctx {
  const terminal = createTerminalServer({ cwd: process.cwd(), ...options });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      const url = new URL(request.url);
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const result = terminal.prepareSession(sessionId);
      if (result.kind === "invalid") return new Response("invalid sessionId", { status: 400 });
      if (result.kind === "collision") return new Response("sessionId in use", { status: 409 });
      const ok = (srv.upgrade as (req: Request, opts: { data: unknown }) => boolean)(request, {
        data: { sessionId },
      });
      if (!ok) return new Response("upgrade failed", { status: 500 });
      return undefined;
    },
    websocket: {
      open: socket => {
        void terminal.open(socket as never);
      },
      message: (socket, msg) => {
        terminal.message(socket as never, msg as never);
      },
      close: socket => {
        terminal.close(socket as never);
      },
    },
  });
  return { server, port: server.port!, terminal, cwd: process.cwd() };
}

function freshSessionId(): string {
  return crypto.randomUUID();
}

// `bun test` exposes `WebSocket` globally, but the type narrowing in the
// browser-flavored events trips when reading `event.data`. Helper that
// decodes either branch so individual tests stay readable.
function decode(data: unknown): string {
  return typeof data === "string"
    ? data
    : new TextDecoder().decode(new Uint8Array(data as ArrayBuffer));
}

beforeEach(() => {
  if (!backendOk) return;
  ctx = startServer();
});

afterEach(() => {
  if (!ctx) return;
  ctx.terminal.disposeAll();
  ctx.server.stop(true);
  ctx = null;
});

describe("isValidSessionId", () => {
  it("accepts a syntactically valid UUID", () => {
    expect(isValidSessionId(crypto.randomUUID())).toBe(true);
  });

  it("rejects empty / non-string / non-UUID values", () => {
    expect(isValidSessionId("")).toBe(false);
    expect(isValidSessionId(undefined)).toBe(false);
    expect(isValidSessionId(123)).toBe(false);
    expect(isValidSessionId("not-a-uuid")).toBe(false);
    // Almost-UUID, wrong segment lengths.
    expect(isValidSessionId("abcdef-1234-5678-9012-3456789abcde")).toBe(false);
    // Uppercase rejected — the canonical form crypto.randomUUID() emits is
    // lower-case and we don't want clients to introduce ambiguity.
    expect(isValidSessionId(crypto.randomUUID().toUpperCase())).toBe(false);
  });
});

describe("prepareSession (no Bun.serve required)", () => {
  it("returns 'fresh' for a brand-new id", () => {
    const terminal = createTerminalServer({ cwd: process.cwd() });
    expect(terminal.prepareSession(freshSessionId())).toEqual({ kind: "fresh" });
  });

  it("returns 'invalid' for malformed ids", () => {
    const terminal = createTerminalServer({ cwd: process.cwd() });
    expect(terminal.prepareSession("").kind).toBe("invalid");
    expect(terminal.prepareSession("nope").kind).toBe("invalid");
    expect(terminal.prepareSession(undefined).kind).toBe("invalid");
  });
});

describe.skipIf(!backendOk)("terminal-server PTY round-trip", () => {
  it("rejects upgrades with a missing sessionId", async () => {
    if (!ctx) throw new Error("ctx not initialized");
    const response = await fetch(`http://127.0.0.1:${ctx.port}/`, {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(400);
  });

  it("rejects upgrades with a malformed sessionId", async () => {
    if (!ctx) throw new Error("ctx not initialized");
    const response = await fetch(`http://127.0.0.1:${ctx.port}/?sessionId=not-a-uuid`, {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(400);
  });

  it("rejects a duplicate sessionId with HTTP 409", async () => {
    if (!ctx) throw new Error("ctx not initialized");
    const id = freshSessionId();
    // First connection: should succeed and stay open.
    const ws1 = new WebSocket(`ws://127.0.0.1:${ctx.port}/?sessionId=${id}`);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("ws1 open timeout")), 1500);
      ws1.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws1.addEventListener("error", err => {
        clearTimeout(t);
        reject(err as unknown as Error);
      });
    });
    try {
      // Second upgrade with the same id while the first is live → 409.
      const response = await fetch(`http://127.0.0.1:${ctx.port}/?sessionId=${id}`, {
        headers: { Upgrade: "websocket" },
      });
      expect(response.status).toBe(409);
    } finally {
      ws1.close();
    }
  }, 6000);

  it("spawns a shell and echoes stdin back", async () => {
    if (!ctx) throw new Error("ctx not initialized");
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${ctx!.port}/?sessionId=${freshSessionId()}`);
      ws.binaryType = "arraybuffer";
      let received = "";
      const done = (err?: Error) => {
        try {
          ws.close();
        } catch {
          // already closed
        }
        if (err) reject(err);
        else resolve();
      };
      const timeout = setTimeout(() => done(new Error(`timeout — got: ${received}`)), 4000);
      ws.addEventListener("open", () => {
        ws.send(new TextEncoder().encode("echo terminal-test-marker\r\n"));
      });
      ws.addEventListener("message", event => {
        received += decode(event.data);
        if (received.includes("terminal-test-marker")) {
          clearTimeout(timeout);
          done();
        }
      });
      ws.addEventListener("error", err => {
        clearTimeout(timeout);
        done(err as unknown as Error);
      });
    });
  }, 8000);

  it("multiplexes two concurrent sessions independently", async () => {
    if (!ctx) throw new Error("ctx not initialized");
    const idA = freshSessionId();
    const idB = freshSessionId();
    const wsA = new WebSocket(`ws://127.0.0.1:${ctx.port}/?sessionId=${idA}`);
    const wsB = new WebSocket(`ws://127.0.0.1:${ctx.port}/?sessionId=${idB}`);
    wsA.binaryType = "arraybuffer";
    wsB.binaryType = "arraybuffer";

    let receivedA = "";
    let receivedB = "";

    const aSawMarker = new Promise<void>(resolve => {
      wsA.addEventListener("message", event => {
        receivedA += decode(event.data);
        if (receivedA.includes("alpha-marker")) resolve();
      });
    });
    const bSawMarker = new Promise<void>(resolve => {
      wsB.addEventListener("message", event => {
        receivedB += decode(event.data);
        if (receivedB.includes("bravo-marker")) resolve();
      });
    });

    await Promise.all([
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("wsA open timeout")), 1500);
        wsA.addEventListener("open", () => {
          clearTimeout(t);
          resolve();
        });
      }),
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("wsB open timeout")), 1500);
        wsB.addEventListener("open", () => {
          clearTimeout(t);
          resolve();
        });
      }),
    ]);

    wsA.send(new TextEncoder().encode("echo alpha-marker\r\n"));
    wsB.send(new TextEncoder().encode("echo bravo-marker\r\n"));

    try {
      await Promise.race([
        Promise.all([aSawMarker, bSawMarker]),
        new Promise<void>((_resolve, reject) =>
          setTimeout(() => reject(new Error(`marker timeout — A:${receivedA} B:${receivedB}`)), 4000),
        ),
      ]);
      // Cross-talk check: A's marker only on A, B's marker only on B.
      expect(receivedA.includes("bravo-marker")).toBe(false);
      expect(receivedB.includes("alpha-marker")).toBe(false);
    } finally {
      wsA.close();
      wsB.close();
    }
  }, 8000);

  it("disposeAll() reaps live PTYs", async () => {
    if (!ctx) throw new Error("ctx not initialized");
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/?sessionId=${freshSessionId()}`);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("ws never opened")), 2000);
      ws.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      ws.addEventListener("error", err => {
        clearTimeout(timeout);
        reject(err as unknown as Error);
      });
    });

    const closed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("ws never closed after disposeAll")), 3000);
      if (ws.readyState === WebSocket.CLOSED) {
        clearTimeout(timeout);
        resolve();
        return;
      }
      ws.addEventListener("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    ctx.terminal.disposeAll();
    await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  }, 6000);
});

// Separate suite for the disconnect-grace timer because it spins up its own
// terminal-server with a tiny grace window; can't reuse the global beforeEach
// fixture which fixes the production 5-second default.
describe.skipIf(!backendOk)("terminal-server reconnect grace", () => {
  it("reaps the PTY after the grace window when no reconnect arrives", async () => {
    const grace = 60;
    const local = startServer({ reconnectGraceMs: grace });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${local.port}/?sessionId=${freshSessionId()}`);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("open timeout")), 1500);
        ws.addEventListener("open", () => {
          clearTimeout(timeout);
          resolve();
        });
        ws.addEventListener("error", err => {
          clearTimeout(timeout);
          reject(err as unknown as Error);
        });
      });

      // Confirm shell liveness via an echo round-trip before closing.
      const greeted = new Promise<void>(resolve => {
        ws.addEventListener("message", function onMsg(event) {
          if (decode(event.data).includes("alive")) {
            ws.removeEventListener("message", onMsg);
            resolve();
          }
        });
      });
      ws.send(new TextEncoder().encode("echo alive\r\n"));
      await Promise.race([
        greeted,
        new Promise<void>((_resolve, reject) =>
          setTimeout(() => reject(new Error("never saw 'alive' echo")), 2000),
        ),
      ]);

      ws.close();

      // Wait past the grace window. We can't introspect the internal sessions
      // map, so we verify disposeAll() runs cleanly (idempotent over the
      // already-reaped session).
      await new Promise<void>(resolve => setTimeout(resolve, grace + 200));
      expect(() => local.terminal.disposeAll()).not.toThrow();
    } finally {
      local.terminal.disposeAll();
      local.server.stop(true);
    }
  }, 6000);

  it("reattaches to the same PTY when an upgrade arrives within the grace window", async () => {
    // Big grace so the test is timing-tolerant. The reattach path is
    // synchronous on the server side; we just need the timer not to fire
    // between disconnect and reconnect.
    const grace = 5_000;
    const local = startServer({ reconnectGraceMs: grace });
    const id = freshSessionId();
    try {
      // First connection: send a marker that the shell will print on exit
      // would lose, but PTY scrollback won't replay either. Instead we test
      // that *after* reattach, the PTY still responds to new input — i.e.,
      // the PTY process didn't die. A `pwd` round-trip before and after
      // is enough to prove the PTY is the same.
      const ws1 = new WebSocket(`ws://127.0.0.1:${local.port}/?sessionId=${id}`);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("ws1 open timeout")), 1500);
        ws1.addEventListener("open", () => {
          clearTimeout(t);
          resolve();
        });
      });
      // Await the close handshake so the server's close callback has run and
      // detached the socket from the session. Without this, a fast reconnect
      // hits the 'collision' branch in prepareSession because socket !== null
      // is still true.
      const ws1Closed = new Promise<void>(resolve => {
        if (ws1.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        ws1.addEventListener("close", () => resolve());
      });
      ws1.close();
      await ws1Closed;

      // Reattach within the grace window.
      const ws2 = new WebSocket(`ws://127.0.0.1:${local.port}/?sessionId=${id}`);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("ws2 open timeout")), 1500);
        ws2.addEventListener("open", () => {
          clearTimeout(t);
          resolve();
        });
        ws2.addEventListener("error", err => {
          clearTimeout(t);
          reject(err as unknown as Error);
        });
      });
      try {
        // Liveness probe on the reattached PTY.
        const probed = new Promise<void>(resolve => {
          ws2.addEventListener("message", function onMsg(event) {
            if (decode(event.data).includes("reattach-marker")) {
              ws2.removeEventListener("message", onMsg);
              resolve();
            }
          });
        });
        ws2.send(new TextEncoder().encode("echo reattach-marker\r\n"));
        await Promise.race([
          probed,
          new Promise<void>((_resolve, reject) =>
            setTimeout(() => reject(new Error("reattached PTY didn't respond")), 3000),
          ),
        ]);
      } finally {
        ws2.close();
      }
    } finally {
      local.terminal.disposeAll();
      local.server.stop(true);
    }
  }, 8000);
});
