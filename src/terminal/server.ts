// Server-side companion to the browser terminal pane. Owns the PTY processes
// spawned for connected clients, plus the short reconnect-grace window that
// absorbs page reloads. The Bun WebSocket handler is split across two surfaces
// (`upgrade` data + `websocket` callbacks) and we want all PTY state in one
// place — hence this module rather than inline glue in `cli.ts`.

import type { ServerWebSocket } from "bun";

import { resolveTerminalBackend } from "./backend";
import type { PtyProcess } from "./pty";

type SocketData = { sessionId: string };

const DEFAULT_RECONNECT_GRACE_MS = 5_000;
// WebSocket.OPEN. Not exposed as a named constant on Bun's ServerWebSocket type.
const WS_OPEN = 1;
// Cap the per-session replay buffer. On reattach we resend recent PTY output
// to the new socket so the new xterm canvas reconstructs the screen (the
// previous canvas is gone — fresh `Terminal` instance after browser refresh).
// TUIs (htop, vim, btop) use absolute cursor positioning, so replaying the
// last few frames' worth of bytes lets xterm rebuild the visible screen.
// 128KB ≈ several frames of a busy htop at full terminal width; comfortably
// enough for the worst case while keeping per-session memory bounded.
const REPLAY_BUFFER_CAP_BYTES = 128 * 1024;

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
  // Replay buffer: recent PTY output captured in chunk-sized pieces. Used on
  // reattach to seed the new client's xterm canvas with the bytes the
  // previous client received. See REPLAY_BUFFER_CAP_BYTES comment.
  replayChunks: Uint8Array[];
  replayBytes: number;
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
  // Optional metrics sink — wired by cli.ts so the diagnostics layer can
  // see PTY lifecycle without every caller threading the registry through.
  metrics?: { inc(name: string): void; set(name: string, value: number): void; get(name: string): number };
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
  const metrics = options.metrics;
  const updateActive = (): void => {
    metrics?.set("pty.sessions_active", sessions.size);
  };

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
        // keeps its PTY. Using a 4xxx app-defined close code so the client
        // can distinguish "your session was hijacked" from a generic
        // disconnect; 1008 (policy violation) is too generic.
        socket.close(4409, "sessionId in use");
        return;
      }

      if (existing) {
        // Reattach path: cancel the reaper and swap in the new socket. The
        // PTY keeps running. The reattaching client will send its own
        // `{ type: "resize", cols, rows }` from its WebSocket open handler,
        // so the PTY's pty-side dimensions get re-synced to whatever the
        // new tab's xterm reports.
        if (existing.reapTimer) clearTimeout(existing.reapTimer);
        existing.reapTimer = null;
        existing.socket = socket;

        // Replay the recent PTY output to the new client's blank xterm
        // canvas. TUIs (htop, vim, btop) use absolute cursor positioning,
        // so even though earlier frames in the buffer are now obsolete,
        // each subsequent frame overwrites them and the final terminal
        // state matches what the previous client was showing. Without
        // this, the new canvas stays blank until the running program
        // happens to emit new output — and for a SIGWINCH-driven redraw
        // (see the resize toggle below) that can be over a second on a
        // typical htop refresh cadence.
        for (const chunk of existing.replayChunks) {
          try {
            socket.send(chunk);
          } catch {
            // Socket already closing; nothing useful to do.
            break;
          }
        }

        // Belt-and-suspenders: force a SIGWINCH so any running TUI also
        // does a fresh redraw at its current dimensions. `ioctl(TIOCSWINSZ)`
        // only signals when the dimensions actually CHANGE — and on a page
        // refresh the new panel is typically the same size as before, so
        // the client's own resize message arrives as a no-op. We
        // momentarily shrink by one row to force the kernel to signal,
        // then restore. The replay above handles the common case; the
        // SIGWINCH covers TUIs that were mid-frame at disconnect.
        try {
          existing.pty.resize(existing.cols, Math.max(1, existing.rows - 1));
          existing.pty.resize(existing.cols, existing.rows);
        } catch {
          // PTY may have just exited; benign.
        }
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
        replayChunks: [],
        replayBytes: 0,
      };
      sessions.set(id, session);
      metrics?.inc("pty.spawned_total");
      updateActive();

      pty.onData(bytes => {
        // Capture before forwarding so the replay buffer also records output
        // produced while the socket is detached (during the grace window) —
        // a TUI like htop refreshes every ~1.5s and we want the reattaching
        // client to see the freshest frame, not a stale pre-disconnect one.
        // Bun reuses the same backing storage for the PTY callback's
        // Uint8Array, so we MUST copy before stashing into the replay
        // ring. socket.send() handles its own copy; the buffer doesn't.
        const copy = new Uint8Array(bytes);
        session.replayChunks.push(copy);
        session.replayBytes += copy.byteLength;
        while (
          session.replayBytes > REPLAY_BUFFER_CAP_BYTES
          && session.replayChunks.length > 1
        ) {
          const dropped = session.replayChunks.shift();
          if (dropped) session.replayBytes -= dropped.byteLength;
        }

        if (session.socket && session.socket.readyState === WS_OPEN) {
          try {
            session.socket.send(bytes);
          } catch {
            // Socket is closing/closed; the close handler will reap the PTY.
          }
        }
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
        metrics?.inc("pty.reaped_total");
        updateActive();
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
        metrics?.inc("pty.reaped_total");
        updateActive();
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
      updateActive();
    },
  };
}
