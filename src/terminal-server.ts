// Server-side companion to the browser terminal pane. Owns the PTY processes
// spawned for connected clients, plus the short reconnect-grace window that
// absorbs page reloads. The Bun WebSocket handler is split across two surfaces
// (`upgrade` data + `websocket` callbacks) and we want all PTY state in one
// place — hence this module rather than inline glue in `cli.ts`.

import type { ServerWebSocket } from "bun";

import { resolveTerminalBackend } from "./terminal-backend";
import type { PtyProcess } from "./terminal-pty";

type SocketData = { sessionId: string };

// Output captured during a disconnect-with-no-reconnect-yet window. Bounded so
// a long disconnect with a chatty shell doesn't grow without limit.
const RECONNECT_BUFFER_MAX = 8 * 1024; // 8 KiB
const DEFAULT_RECONNECT_GRACE_MS = 5_000;

type Session = {
  id: string;
  pty: PtyProcess;
  socket: ServerWebSocket<SocketData> | null;
  // Output that arrived while no socket was attached. Replayed on reattach.
  buffer: Uint8Array[];
  bufferBytes: number;
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

export type TerminalServer = {
  // Returns true if a PTY backend is loadable in this process. The CLI uses
  // this to decide whether to expose `terminal: "enabled"` in /api/state.
  isAvailable(): Promise<boolean>;
  // Called from the route's pre-upgrade check. Generates the per-socket session
  // id that will be passed through `server.upgrade(req, { data: { sessionId } })`
  // and looked up again in the websocket handler.
  prepareSession(): { sessionId: string };
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
  let counter = 0;

  return {
    async isAvailable() {
      return (await resolveTerminalBackend()).available;
    },

    prepareSession() {
      // Predictable monotonically-increasing id is fine — this isn't a secret;
      // the auth boundary is the URL token checked before upgrade(). The id
      // only routes a particular socket to its session and is per-process.
      counter += 1;
      return { sessionId: `s${counter}` };
    },

    async open(socket) {
      const id = socket.data.sessionId;
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
        buffer: [],
        bufferBytes: 0,
        reapTimer: null,
        cols,
        rows,
      };
      sessions.set(id, session);

      pty.onData(chunk => {
        const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : (chunk as unknown as Uint8Array);
        if (session.socket && session.socket.readyState === 1) {
          try {
            session.socket.send(bytes);
            return;
          } catch {
            // Fall through and buffer for a possible reconnect.
          }
        }
        // Buffer for reconnect, dropping oldest if we exceed the cap.
        session.buffer.push(bytes);
        session.bufferBytes += bytes.byteLength;
        while (session.bufferBytes > RECONNECT_BUFFER_MAX && session.buffer.length > 0) {
          const dropped = session.buffer.shift()!;
          session.bufferBytes -= dropped.byteLength;
        }
      });

      pty.onExit(({ exitCode, signal }) => {
        if (session.socket && session.socket.readyState === 1) {
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
      // Detach the socket but keep the PTY alive briefly. If a reattach with
      // the same session id arrives we can flush buffered output. With v1's
      // "spawn-on-attach" model, no client currently calls back with the same
      // session id — but the buffer + grace timer are still valuable as a
      // safety net against hangs and as the foundation for richer reconnect
      // semantics in a follow-up change.
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
