// Tests the in-memory PTY lifecycle around the WebSocket. Each test wires
// the terminal-server to a real Bun.serve so messages flow through the same
// path production uses. Skipped when the node-pty backend can't load
// (standalone-binary build, broken native module on a fresh checkout).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createTerminalServer, isValidSessionId, type TerminalServer } from "./server";
import { resolveTerminalBackend } from "./backend";

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

// The host's ambient `$SHELL`. The non-override test below needs it set and
// distinct from `/bin/sh` to be meaningful (otherwise honoring vs. clobbering
// look identical); it self-skips on a bare CI runner where SHELL is unset.
const hostShell = process.env.SHELL;

// Wire `terminal-server` into a Bun.serve that mirrors the production
// upgrade gate: parse `sessionId` from the URL, call `prepareSession`, map
// results to HTTP statuses, then upgrade.
function startServer(
  options: {
    shell?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Ctx {
  const terminal = createTerminalServer({ cwd: process.cwd(), ...options });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      const url = new URL(request.url);
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const takeover = url.searchParams.get("takeover") === "1";
      const result = terminal.prepareSession(sessionId, { takeover });
      if (result.kind === "invalid") return new Response("invalid sessionId", { status: 400 });
      if (result.kind === "collision") return new Response("sessionId in use", { status: 409 });
      const ok = (srv.upgrade as (req: Request, opts: { data: unknown }) => boolean)(request, {
        data: { sessionId, takeover },
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
      close: (socket, code) => {
        terminal.close(socket as never, code);
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

// Separate suite: spins up its own terminal-server with an explicit `/bin/sh`
// override (present on every POSIX system, so no fish/bash/zsh needed). The
// child still inherits the host's ambient `$SHELL`; because that value differs
// from the spawned `/bin/sh`, echoing it proves uatu runs the configured shell
// WITHOUT clobbering the inherited `$SHELL`. Self-skips when the host has no
// distinct ambient SHELL to observe.
describe.skipIf(!backendOk)("terminal-server shell selection", () => {
  it.skipIf(!hostShell || hostShell === "/bin/sh")(
    "runs the configured shell and leaves the inherited $SHELL untouched",
    async () => {
      const local = startServer({ shell: "/bin/sh" });
      try {
        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${local.port}/?sessionId=${freshSessionId()}`);
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
            // sh expands $SHELL from its inherited env. We expect the host's
            // ambient value, NOT the spawned /bin/sh — proving non-override.
            ws.send(new TextEncoder().encode('echo "SHELLIS:$SHELL:END"\r\n'));
          });
          ws.addEventListener("message", event => {
            received += decode(event.data);
            if (received.includes(`SHELLIS:${hostShell}:END`)) {
              clearTimeout(timeout);
              done();
            }
          });
          ws.addEventListener("error", err => {
            clearTimeout(timeout);
            done(err as unknown as Error);
          });
        });
      } finally {
        local.terminal.disposeAll();
        local.server.stop(true);
      }
    },
    8000,
  );
});

// Fallback path: with `$SHELL` absent from the injected env and no explicit
// override, the terminal starts `/bin/sh` and writes the per-session notice
// into the new session before the prompt. (The operator-facing stdout warning
// is a startup concern owned by cli.ts, not the server — see
// shell-warning.test.ts.) `env: {}` forces the fallback without touching the
// real process environment, so the test is deterministic on any host.
describe.skipIf(!backendOk)("terminal-server shell fallback notice", () => {
  it("writes the fallback notice into the session when $SHELL is unset", async () => {
    const local = startServer({ env: {} });
    try {
      const notice = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${local.port}/?sessionId=${freshSessionId()}`);
        ws.binaryType = "arraybuffer";
        let received = "";
        const timeout = setTimeout(
          () => reject(new Error(`timeout — got: ${received}`)),
          4000,
        );
        ws.addEventListener("message", event => {
          received += decode(event.data);
          if (received.includes("$SHELL is not set")) {
            clearTimeout(timeout);
            try {
              ws.close();
            } catch {
              // already closed
            }
            resolve(received);
          }
        });
        ws.addEventListener("error", err => {
          clearTimeout(timeout);
          reject(err as unknown as Error);
        });
      });
      expect(notice).toContain("/bin/sh instead of your login shell");
    } finally {
      local.terminal.disposeAll();
      local.server.stop(true);
    }
  }, 8000);
});

// Poll `prepareSession` until it reports the expected lifecycle state. The
// server's close callback runs asynchronously relative to the client's close
// event, so a single immediate check would race it. prepareSession doubles as
// external observability: "collision" = attached, "reattach" = detached with
// a live PTY, "fresh" = session gone.
async function waitForSessionKind(
  terminal: TerminalServer,
  sessionId: string,
  expected: "fresh" | "reattach",
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const kind = terminal.prepareSession(sessionId).kind;
    if (kind === expected) return;
    if (Date.now() > deadline) {
      throw new Error(`session '${sessionId}' never became '${expected}' (last: '${kind}')`);
    }
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
}

// Detach/persist lifecycle: a plain disconnect keeps the PTY; only the
// app-defined user-terminate close code (4001) kills it.
describe.skipIf(!backendOk)("terminal-server detached-session persistence", () => {
  it("keeps the PTY alive after a plain disconnect", async () => {
    const local = startServer();
    const id = freshSessionId();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${local.port}/?sessionId=${id}`);
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

      // Plain close (default code 1000/1005) — the session must detach, NOT
      // die. Give it well over the old 5s-grace-era timings scaled down: any
      // reap would land within milliseconds of a timer, so a generous settle
      // window plus a stable "reattach" answer proves there is no timer.
      ws.close();
      await waitForSessionKind(local.terminal, id, "reattach");
      await new Promise<void>(resolve => setTimeout(resolve, 300));
      expect(local.terminal.prepareSession(id)).toEqual({ kind: "reattach" });
    } finally {
      local.terminal.disposeAll();
      local.server.stop(true);
    }
  }, 6000);

  it("kills the PTY when the client closes with the user-terminate code", async () => {
    const local = startServer();
    const id = freshSessionId();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${local.port}/?sessionId=${id}`);
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

      // 4001 = CLOSE_CODE_USER_TERMINATE (confirmed pane close). The session
      // must be removed entirely so the id can be claimed fresh.
      ws.close(4001, "user-close");
      await waitForSessionKind(local.terminal, id, "fresh");
    } finally {
      local.terminal.disposeAll();
      local.server.stop(true);
    }
  }, 6000);

  it("removes the session when the shell exits while detached", async () => {
    const local = startServer();
    const id = freshSessionId();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${local.port}/?sessionId=${id}`);
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

      // Replace the shell with a short-lived process, then detach. The PTY
      // exits ~500ms later with nobody attached; the onExit handler must
      // still free the session slot so the id can be claimed fresh.
      ws.send(new TextEncoder().encode("exec sleep 0.5\r\n"));
      ws.close();
      await waitForSessionKind(local.terminal, id, "reattach");
      await waitForSessionKind(local.terminal, id, "fresh", 4000);
    } finally {
      local.terminal.disposeAll();
      local.server.stop(true);
    }
  }, 8000);

  it("disposeAll kills detached sessions too", async () => {
    const local = startServer();
    const id = freshSessionId();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${local.port}/?sessionId=${id}`);
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

      ws.close();
      await waitForSessionKind(local.terminal, id, "reattach");
      // Server shutdown path: detached sessions must not outlive disposeAll.
      local.terminal.disposeAll();
      expect(local.terminal.prepareSession(id)).toEqual({ kind: "fresh" });
    } finally {
      local.terminal.disposeAll();
      local.server.stop(true);
    }
  }, 6000);

  it("reattaches to the same PTY when an upgrade arrives after a disconnect", async () => {
    const local = startServer();
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
      await waitForSessionKind(local.terminal, id, "reattach");

      // Reattach to the detached session.
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

// Session inventory + takeover semantics (add-terminal-session-manager).
describe.skipIf(!backendOk)("terminal-server session manager", () => {
  function openSocket(port: number, id: string, takeover = false): Promise<WebSocket> {
    const params = takeover ? `sessionId=${id}&takeover=1` : `sessionId=${id}`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?${params}`);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("open timeout")), 1500);
      ws.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve(ws);
      });
      ws.addEventListener("error", err => {
        clearTimeout(timeout);
        reject(err as unknown as Error);
      });
    });
  }

  it("lists sessions with attachment state and kills detached ones", async () => {
    const local = startServer();
    const idA = freshSessionId();
    const idB = freshSessionId();
    try {
      const wsA = await openSocket(local.port, idA);
      const wsB = await openSocket(local.port, idB);
      // Detach B, keep A attached.
      wsB.close();
      await waitForSessionKind(local.terminal, idB, "reattach");

      const listed = await local.terminal.listSessions();
      const a = listed.find(s => s.id === idA);
      const b = listed.find(s => s.id === idB);
      expect(a?.attached).toBe(true);
      expect(b?.attached).toBe(false);
      expect(typeof a?.createdAt).toBe("number");
      expect((a?.label ?? "").length).toBeGreaterThan(0);

      // Kill the detached session; it leaves the inventory and its id frees.
      expect(local.terminal.killSession(idB)).toBe(true);
      expect(local.terminal.killSession(idB)).toBe(false);
      const after = await local.terminal.listSessions();
      expect(after.some(s => s.id === idB)).toBe(false);
      expect(local.terminal.prepareSession(idB)).toEqual({ kind: "fresh" });

      wsA.close();
    } finally {
      local.terminal.disposeAll();
      local.server.stop(true);
    }
  }, 8000);

  it("prepareSession distinguishes takeover from collision", async () => {
    const local = startServer();
    const id = freshSessionId();
    try {
      const ws = await openSocket(local.port, id);
      expect(local.terminal.prepareSession(id).kind).toBe("collision");
      expect(local.terminal.prepareSession(id, { takeover: false }).kind).toBe("collision");
      expect(local.terminal.prepareSession(id, { takeover: true }).kind).toBe("takeover");
      ws.close();
    } finally {
      local.terminal.disposeAll();
      local.server.stop(true);
    }
  }, 6000);

  it("takeover moves the session: loser gets 4410, winner gets the replay and the PTY", async () => {
    const local = startServer();
    const id = freshSessionId();
    try {
      const ws1 = await openSocket(local.port, id);

      // Put a marker into the replay buffer via a real echo round-trip.
      const marked = new Promise<void>(resolve => {
        ws1.addEventListener("message", function onMsg(event) {
          if (decode(event.data).includes("takeover-marker")) {
            ws1.removeEventListener("message", onMsg);
            resolve();
          }
        });
      });
      ws1.send(new TextEncoder().encode("echo takeover-marker\r\n"));
      await Promise.race([
        marked,
        new Promise<void>((_r, reject) =>
          setTimeout(() => reject(new Error("never saw takeover-marker")), 2000),
        ),
      ]);

      const ws1Taken = new Promise<number>(resolve => {
        ws1.addEventListener("close", event => resolve(event.code));
      });

      // Second client claims with takeover.
      const ws2 = await openSocket(local.port, id, true);
      const replayed = new Promise<void>(resolve => {
        ws2.addEventListener("message", function onMsg(event) {
          if (decode(event.data).includes("takeover-marker")) {
            ws2.removeEventListener("message", onMsg);
            resolve();
          }
        });
      });

      // Loser is closed with the app-defined "session taken" code.
      expect(await ws1Taken).toBe(4410);
      // Winner received the replayed buffer (the marker) and owns the PTY.
      await Promise.race([
        replayed,
        new Promise<void>((_r, reject) =>
          setTimeout(() => reject(new Error("replay never reached the new holder")), 2000),
        ),
      ]);
      const listed = await local.terminal.listSessions();
      expect(listed.find(s => s.id === id)?.attached).toBe(true);

      // The session survived the swap: still exactly one registry entry.
      expect(listed.filter(s => s.id === id)).toHaveLength(1);
      ws2.close();
      await waitForSessionKind(local.terminal, id, "reattach");
    } finally {
      local.terminal.disposeAll();
      local.server.stop(true);
    }
  }, 8000);
});
