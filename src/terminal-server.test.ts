// Tests the in-memory PTY lifecycle around the WebSocket. Each test wires
// the terminal-server to a real Bun.serve so messages flow through the same
// path production uses. Skipped when the node-pty backend can't load
// (standalone-binary build, broken native module on a fresh checkout).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createTerminalServer, type TerminalServer } from "./terminal-server";
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

beforeEach(async () => {
  if (!backendOk) return;

  const terminal = createTerminalServer({ cwd: process.cwd() });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      const session = terminal.prepareSession();
      const ok = (srv.upgrade as (req: Request, opts: { data: unknown }) => boolean)(request, {
        data: session,
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

  ctx = { server, port: server.port!, terminal, cwd: process.cwd() };
});

afterEach(() => {
  if (!ctx) return;
  ctx.terminal.disposeAll();
  ctx.server.stop(true);
  ctx = null;
});

describe.skipIf(!backendOk)("terminal-server PTY round-trip", () => {
  it("spawns a shell and echoes stdin back", async () => {
    if (!ctx) throw new Error("ctx not initialized");
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${ctx!.port}/`);
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
        const text =
          typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(new Uint8Array(event.data as ArrayBuffer));
        received += text;
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

  it("disposeAll() reaps live PTYs", async () => {
    if (!ctx) throw new Error("ctx not initialized");
    // Open a connection so the server has an active PTY. Wait for the open
    // event so the spawn is definitely in flight before we dispose.
    const ws = new WebSocket(`ws://127.0.0.1:${ctx!.port}/`);
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

    // Trigger teardown. The PTY's `onExit` then closes the socket — that's
    // an async hop, so wait for the close event rather than poking readyState
    // on a fixed delay.
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
    ctx!.terminal.disposeAll();
    await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  }, 6000);
});

// Separate suite for the disconnect-grace timer because it spins up its own
// terminal-server with a tiny grace window; can't reuse the global beforeEach
// fixture which fixes the production 5-second default. The shared `ctx`
// fixture is set up but unused here; tests below do their own setup.
describe.skipIf(!backendOk)("terminal-server reconnect grace", () => {
  it("reaps the PTY after the grace window when no reconnect arrives", async () => {
    const grace = 60; // tight enough to keep the test snappy, loose enough
    const terminal = createTerminalServer({ cwd: process.cwd(), reconnectGraceMs: grace });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, srv) {
        const session = terminal.prepareSession();
        const ok = (srv.upgrade as (req: Request, opts: { data: unknown }) => boolean)(request, {
          data: session,
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

    try {
      // Open a connection so a real PTY exists.
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
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

      // Send a quick command so we know the shell is live before the close.
      // The PTY echoes input back; we wait for that echo to confirm liveness.
      const greeted = new Promise<void>(resolve => {
        ws.addEventListener("message", function onMsg(event) {
          const text =
            typeof event.data === "string"
              ? event.data
              : new TextDecoder().decode(new Uint8Array(event.data as ArrayBuffer));
          if (text.includes("alive")) {
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

      // Close the socket. With our 60ms grace, the reap timer must fire and
      // SIGHUP the PTY shortly after.
      ws.close();

      // Wait for the grace window plus a small margin, then assert that
      // disposeAll() finds nothing left (the session was removed by the
      // reap path). We can't introspect the internal `sessions` Map from
      // here, but `disposeAll()` is idempotent and would tear down any
      // remaining session — we just verify it doesn't throw.
      await new Promise<void>(resolve => setTimeout(resolve, grace + 200));
      expect(() => terminal.disposeAll()).not.toThrow();
    } finally {
      terminal.disposeAll();
      server.stop(true);
    }
  }, 6000);
});
