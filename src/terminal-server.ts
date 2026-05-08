// Server-side companion to the browser terminal pane. Owns the PTY processes
// spawned for connected clients, plus the short reconnect-grace window that
// absorbs page reloads. The Bun WebSocket handler is split across two surfaces
// (`upgrade` data + `websocket` callbacks) and we want all PTY state in one
// place — hence this module rather than inline glue in `cli.ts`.

import type { ServerWebSocket } from "bun";

import { resolveTerminalBackend } from "./terminal-backend";
import type { PtyProcess } from "./terminal-pty";

type SocketData = { sessionId: string };

const DEFAULT_RECONNECT_GRACE_MS = 5_000;
// WebSocket.OPEN. Not exposed as a named constant on Bun's ServerWebSocket type.
const WS_OPEN = 1;

// Lower-cased UUID v1-v5 + the special nil UUID. Permissive enough to accept
// whatever `crypto.randomUUID()` emits across browsers, strict enough that
// anything caller-attacker-supplied in the URL gets rejected at the boundary.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidSessionId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

type Session = {
  id: string;
  pty: PtyProcess;
  socket: ServerWebSocket<SocketData> | null;
  // Grace timer: when fired, the PTY is killed and the session is removed.
  reapTimer: ReturnType<typeof setTimeout> | null;
  cols: number;
  rows: number;
};

export type TerminalServerOptions = {
  // Working directory for newly-spawned PTYs. Typically the first watch root.
  cwd: string;
  // Shell to run. Defaults to `process.env.SHELL` falling back to `/bin/sh`.
  shell?: string;
  // Initial dimensions used when the client has not yet sent a resize frame.
  // The fit addon will send one within a frame or two so these are placeholders.
  initialCols?: number;
  initialRows?: number;
  // Override the disconnect grace window in milliseconds. Production keeps
  // the 5s default; tests pass a small value (e.g. 50) so the SIGHUP path
  // can be exercised without a real-time pause.
  reconnectGraceMs?: number;
};

export type PrepareSessionResult =
  // The id is well-formed and free; the upgrade should proceed and `open()`
  // will spawn a fresh PTY.
  | { kind: "fresh" }
  // The id is well-formed and matches a session whose socket has detached but
  // whose PTY is still in the reconnect-grace window. The upgrade should
  // proceed and `open()` will reattach to the existing PTY.
  | { kind: "reattach" }
  // Caller passed a malformed / missing id. cli.ts maps this to HTTP 400.
  | { kind: "invalid" }
  // Caller's id matches an active session (socket still attached). cli.ts
  // maps this to HTTP 409.
  | { kind: "collision" };

export type TerminalServer = {
  // Returns true if a PTY backend is loadable in this process. The CLI uses
  // this to decide whether to expose `terminal: "enabled"` in /api/state.
  isAvailable(): Promise<boolean>;
  // Pre-upgrade gate: validates the client-supplied `sessionId` and reports
  // whether the upgrade should produce a fresh PTY, reattach to an existing
  // one, or be rejected. cli.ts uses the result to choose the HTTP status
  // code and to populate `socket.data` for the websocket handler.
  prepareSession(sessionId: unknown): PrepareSessionResult;
  // Wired into Bun.serve's `websocket` config.
  open(socket: ServerWebSocket<SocketData>): Promise<void>;
  message(socket: ServerWebSocket<SocketData>, data: string | Buffer): void;
  close(socket: ServerWebSocket<SocketData>): void;
  // Kill every PTY. Called on server shutdown.
  disposeAll(): void;
};

export function createTerminalServer(options: TerminalServerOptions): TerminalServer {
  const sessions = new Map<string, Session>();
  const graceMs = options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;

  return {
    async isAvailable() {
      return (await resolveTerminalBackend()).available;
    },

    prepareSession(sessionId) {
      if (!isValidSessionId(sessionId)) return { kind: "invalid" };
      const existing = sessions.get(sessionId);
      if (!existing) return { kind: "fresh" };
      // A live socket means the same id is still in use — reject so concurrent
      // PTYs from one tab don't get cross-wired.
      if (existing.socket !== null) return { kind: "collision" };
      // Detached but in the grace window — the next upgrade reattaches.
      return { kind: "reattach" };
    },

    async open(socket) {
      const id = socket.data.sessionId;
      const existing = sessions.get(id);
      if (existing && existing.socket !== null) {
        // Lost a race against another upgrade for the same id (the pre-upgrade
        // gate is best-effort). Refuse the new socket so the older session
        // keeps its PTY.
        socket.close(1008, "sessionId in use");
        return;
      }

      if (existing) {
        // Reattach path: cancel the reaper, swap in the new socket, re-emit
        // the last known dimensions so the client's xterm matches the PTY.
        if (existing.reapTimer) clearTimeout(existing.reapTimer);
        existing.reapTimer = null;
        existing.socket = socket;
        return;
      }

      const backend = await resolveTerminalBackend();
      if (!backend.available) {
        // Available was checked pre-upgrade; if it's gone now something is
        // very wrong. Close with policy-violation.
        socket.close(1008, "terminal backend unavailable");
        return;
      }

      const cols = options.initialCols ?? 80;
      const rows = options.initialRows ?? 24;
      const shell = options.shell ?? process.env.SHELL ?? "/bin/sh";

      // Advertise truecolor to TUIs. Without this, nvim/btop/lazygit detect
      // 256-color (from $TERM) and quantize their gruvbox/dracula/etc. themes
      // to the nearest palette entry, which looks wrong (washed-out yellow
      // backgrounds, banding). xterm.js itself accepts 24-bit ANSI escapes;
      // we just have to tell the consumer it's safe to send them.
      const ptyEnv: Record<string, string> = {
        ...(process.env as Record<string, string>),
        COLORTERM: "truecolor",
        TERM: "xterm-256color",
      };

      const pty = backend.spawn(shell, [], {
        cols,
        rows,
        cwd: options.cwd,
        env: ptyEnv,
      });

      const session: Session = {
        id,
        pty,
        socket,
        reapTimer: null,
        cols,
        rows,
      };
      sessions.set(id, session);

      pty.onData(chunk => {
        const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : (chunk as unknown as Uint8Array);
        if (session.socket && session.socket.readyState === WS_OPEN) {
          try {
            session.socket.send(bytes);
          } catch {
            // Socket is closing/closed; the close handler will reap the PTY.
          }
        }
        // Output produced while the socket is detached (between disconnect and
        // either reattach or reap) is dropped on the floor. Shell-side
        // scrollback can recover anything important on reattach.
      });

      pty.onExit(({ exitCode, signal }) => {
        if (session.socket && session.socket.readyState === WS_OPEN) {
          try {
            session.socket.send(JSON.stringify({ type: "exit", exitCode, signal }));
          } catch {
            // Socket may already be closing.
          }
          try {
            session.socket.close(1000, "shell exited");
          } catch {
            // No-op: just cleanup below.
          }
        }
        if (session.reapTimer) clearTimeout(session.reapTimer);
        sessions.delete(id);
      });
    },

    message(socket, data) {
      const session = sessions.get(socket.data.sessionId);
      if (!session) return;

      if (typeof data === "string") {
        // Control frame (resize, ping, ...)
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          return;
        }
        if (parsed && typeof parsed === "object" && (parsed as { type?: unknown }).type === "resize") {
          const cols = Math.max(1, Math.floor(Number((parsed as { cols?: unknown }).cols)));
          const rows = Math.max(1, Math.floor(Number((parsed as { rows?: unknown }).rows)));
          if (Number.isFinite(cols) && Number.isFinite(rows)) {
            session.cols = cols;
            session.rows = rows;
            try {
              session.pty.resize(cols, rows);
            } catch {
              // Resize can fail if the PTY just exited; benign.
            }
          }
        }
        return;
      }

      // Binary input from the browser → write straight to the shell.
      const buf = data instanceof Uint8Array ? data : Buffer.from(data);
      try {
        session.pty.write(buf.toString("utf8"));
      } catch {
        // PTY may have just exited; the close path will tear down the socket.
      }
    },

    close(socket) {
      const session = sessions.get(socket.data.sessionId);
      if (!session) return;
      // Detach the socket and start the reap timer. A subsequent upgrade
      // reusing the same sessionId within the grace window will land in the
      // reattach path in `open()`.
      session.socket = null;
      if (session.reapTimer) clearTimeout(session.reapTimer);
      session.reapTimer = setTimeout(() => {
        try {
          session.pty.kill("SIGHUP");
        } catch {
          // Already dead.
        }
        sessions.delete(session.id);
      }, graceMs);
      session.reapTimer.unref?.();
    },

    disposeAll() {
      for (const session of sessions.values()) {
        if (session.reapTimer) clearTimeout(session.reapTimer);
        try {
          session.pty.kill("SIGHUP");
        } catch {
          // Already dead.
        }
      }
      sessions.clear();
    },
  };
}
