// Server-side companion to the browser terminal pane. Owns the PTY processes
// spawned for connected clients. PTY lifetime follows tmux-detach semantics:
// a socket disconnect (tab close, browser quit, system sleep, network drop)
// detaches the session and the PTY keeps running until its shell exits, the
// client explicitly terminates it (close code 4001), or the server shuts
// down. The Bun WebSocket handler is split across two surfaces (`upgrade`
// data + `websocket` callbacks) and we want all PTY state in one place —
// hence this module rather than inline glue in `cli.ts`.

import type { ServerWebSocket } from "bun";

import { resolveTerminalBackend } from "./backend";
import { resolveForegroundLabels } from "./process-label";
import { SHELL_FALLBACK_NOTICE, shellIsUnset } from "./shell-warning";
import type { PtyProcess } from "./pty";

type SocketData = { sessionId: string; takeover?: boolean };

// App-defined close code the client sends from the confirmed pane-close path.
// It is the ONLY close code that kills the PTY; everything else — 1001
// (navigation), 1006 (abrupt drop, sleep) — detaches and persists, so the
// failure mode of any dropped connection is always "session survives". 4001
// avoids colliding with the other app codes below.
export const CLOSE_CODE_USER_TERMINATE = 4001;
// Server→client: this socket lost its session to a takeover claim from
// another client. The receiving pane parks (notice + explicit take-back)
// rather than tearing down — the session is alive, just elsewhere.
const CLOSE_CODE_SESSION_TAKEN = 4410;
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

// Final safe fallback when `$SHELL` is unset/empty. Present on every POSIX
// system, so the terminal always starts even in a stripped sandbox. The
// matching stdout warning is emitted once at startup from cli.ts; here we only
// own the per-session in-terminal notice (see SHELL_FALLBACK_NOTICE).
const DEFAULT_SHELL = "/bin/sh";

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
  // Wall-clock millis at spawn; surfaces as age in the session inventory.
  createdAt: number;
  // Basename of the spawned shell — the inventory label fallback when no
  // foreground process can be resolved.
  shellName: string;
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
  // Explicit shell override (highest priority). When unset, the PTY uses
  // `$SHELL`; if that is unset/empty it falls back to `/bin/sh` and uatu warns
  // on both stdout and inside the terminal (see the fallback handling in
  // `open()`). uatu deliberately does NOT reconstruct the login shell from the
  // user database — an interactive emulator trusts `$SHELL`, like xterm/tmux.
  shell?: string;
  // Environment `$SHELL` is read from. Defaults to `process.env`. Injected by
  // tests so the fallback path can be exercised without mutating the real env.
  env?: NodeJS.ProcessEnv;
  // Initial dimensions used when the client has not yet sent a resize frame.
  // The fit addon will send one within a frame or two so these are placeholders.
  initialCols?: number;
  initialRows?: number;
  // Optional metrics sink — wired by cli.ts so the diagnostics layer can
  // see PTY lifecycle without every caller threading the registry through.
  metrics?: { inc(name: string): void; set(name: string, value: number): void; get(name: string): number };
};

export type PrepareSessionResult =
  // The id is well-formed and free; the upgrade should proceed and `open()`
  // will spawn a fresh PTY.
  | { kind: "fresh" }
  // The id is well-formed and matches a detached session whose PTY is still
  // running. The upgrade should proceed and `open()` will reattach to the
  // existing PTY, however long ago the previous socket went away.
  | { kind: "reattach" }
  // The id matches an ATTACHED session and the caller requested takeover:
  // the upgrade should proceed and `open()` will detach the current holder
  // (close code 4410) before attaching the new socket.
  | { kind: "takeover" }
  // Caller passed a malformed / missing id. cli.ts maps this to HTTP 400.
  | { kind: "invalid" }
  // Caller's id matches an active session (socket still attached) and no
  // takeover was requested. cli.ts maps this to HTTP 409.
  | { kind: "collision" };

// One row of the session inventory returned by `GET /api/terminal/sessions`.
export type TerminalSessionInfo = {
  id: string;
  attached: boolean;
  createdAt: number;
  cols: number;
  rows: number;
  // Foreground process name when resolvable, else the shell basename.
  label: string;
};

export type TerminalServer = {
  // Returns true if a PTY backend is loadable in this process. The CLI uses
  // this to decide whether to expose `terminal: "enabled"` in /api/state.
  isAvailable(): Promise<boolean>;
  // Pre-upgrade gate: validates the client-supplied `sessionId` and reports
  // whether the upgrade should produce a fresh PTY, reattach to an existing
  // one, take over an attached one, or be rejected. cli.ts uses the result
  // to choose the HTTP status code and to populate `socket.data` for the
  // websocket handler.
  prepareSession(sessionId: unknown, options?: { takeover?: boolean }): PrepareSessionResult;
  // Session inventory for GET /api/terminal/sessions. Async because labels
  // are resolved from one best-effort `ps` snapshot.
  listSessions(): Promise<TerminalSessionInfo[]>;
  // Kill one session without attaching (DELETE /api/terminal/sessions/<id>).
  // Returns false for an unknown id.
  killSession(sessionId: string): boolean;
  // Wired into Bun.serve's `websocket` config.
  open(socket: ServerWebSocket<SocketData>): Promise<void>;
  message(socket: ServerWebSocket<SocketData>, data: string | Buffer): void;
  // `code` is the WebSocket close code Bun hands the close callback. The
  // explicit user-terminate code kills the PTY; any other close detaches the
  // session and keeps the PTY running.
  close(socket: ServerWebSocket<SocketData>, code?: number): void;
  // Kill every PTY, attached or detached. Called on server shutdown.
  disposeAll(): void;
};

export function createTerminalServer(options: TerminalServerOptions): TerminalServer {
  const sessions = new Map<string, Session>();
  const metrics = options.metrics;
  const updateActive = (): void => {
    metrics?.set("pty.sessions_active", sessions.size);
  };

  return {
    async isAvailable() {
      return (await resolveTerminalBackend()).available;
    },

    prepareSession(sessionId, options) {
      if (!isValidSessionId(sessionId)) return { kind: "invalid" };
      const existing = sessions.get(sessionId);
      if (!existing) return { kind: "fresh" };
      if (existing.socket !== null) {
        // Attached elsewhere. An explicit takeover claim moves the session;
        // without it, reject so concurrent PTYs from one tab don't get
        // cross-wired (and the collision-recovery path stays intact).
        return options?.takeover ? { kind: "takeover" } : { kind: "collision" };
      }
      // Detached with a live PTY — the next upgrade reattaches.
      return { kind: "reattach" };
    },

    async listSessions() {
      const entries = Array.from(sessions.values());
      const labels = await resolveForegroundLabels(entries.map(s => s.pty.pid)).catch(
        () => new Map<number, string>(),
      );
      return entries.map(s => ({
        id: s.id,
        attached: s.socket !== null,
        createdAt: s.createdAt,
        cols: s.cols,
        rows: s.rows,
        label: labels.get(s.pty.pid) ?? s.shellName,
      }));
    },

    killSession(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return false;
      // An attached holder learns its shell died the normal way: SIGHUP →
      // pty.onExit → exit frame + close(1000) on its socket.
      try {
        session.pty.kill("SIGHUP");
      } catch {
        // Already dead.
      }
      // Remove immediately so the inventory reflects the kill on the next
      // request; pty.onExit's own delete is an idempotent no-op. Metrics
      // accounting stays with onExit to keep reaped_total single-counted.
      sessions.delete(sessionId);
      updateActive();
      return true;
    },

    async open(socket) {
      const id = socket.data.sessionId;
      const existing = sessions.get(id);
      if (existing && existing.socket !== null) {
        if (socket.data.takeover) {
          // Explicit takeover claim: detach the current holder with the
          // "session taken" code so its pane parks (notice + take-back)
          // instead of dying, then fall through to the reattach path with
          // the new socket. Swap the reference BEFORE closing so the old
          // socket's close callback fails the ownership guard in `close()`
          // and cannot detach the new holder.
          const previous = existing.socket;
          existing.socket = null;
          try {
            previous.close(CLOSE_CODE_SESSION_TAKEN, "session taken");
          } catch {
            // Already closing.
          }
        } else {
          // Lost a race against another upgrade for the same id (the
          // pre-upgrade gate is best-effort). Refuse the new socket so the
          // older session keeps its PTY. Using a 4xxx app-defined close code
          // so the client can distinguish "your session was hijacked" from a
          // generic disconnect; 1008 (policy violation) is too generic.
          socket.close(4409, "sessionId in use");
          return;
        }
      }

      if (existing) {
        // Reattach path: swap in the new socket. The PTY keeps running. The
        // reattaching client will send its own `{ type: "resize", cols, rows }`
        // from its WebSocket open handler, so the PTY's pty-side dimensions
        // get re-synced to whatever the new tab's xterm reports.
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
        //
        // Edge case: rows === 1 means we can't shrink further (Math.max
        // clamps both calls to the same value, so no kernel signal). A
        // single-row terminal can't usefully run a TUI anyway, and the
        // replay buffer alone is sufficient for whatever a shell would
        // be doing at rows=1, so this is acceptable.
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
      // Trust `$SHELL` like any interactive terminal emulator, falling back to
      // `/bin/sh` only when it is unset/empty. We do not reconstruct the login
      // shell from the user database; instead the fallback is made visible (see
      // below) so a sandbox that omits SHELL is diagnosable and fixable.
      const env = options.env ?? process.env;
      const shell = options.shell ?? (shellIsUnset(env) ? DEFAULT_SHELL : env.SHELL!);
      const shellFellBack = !options.shell && shellIsUnset(env);

      // Advertise truecolor to TUIs. Without this, nvim/btop/lazygit detect
      // 256-color (from $TERM) and quantize their gruvbox/dracula/etc. themes
      // to the nearest palette entry, which looks wrong (washed-out yellow
      // backgrounds, banding). xterm.js itself accepts 24-bit ANSI escapes;
      // we just have to tell the consumer it's safe to send them.
      //
      // SHELL is deliberately left exactly as inherited — we never synthesize
      // it. If it is unset, that is the user's environment to own (they may
      // have a reason); uatu warns about the consequence above but does not
      // decide a shell on their behalf or hide the gap from child programs.
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
        createdAt: Date.now(),
        shellName: shell.split("/").at(-1) ?? shell,
        cols,
        rows,
        replayChunks: [],
        replayBytes: 0,
      };
      sessions.set(id, session);
      metrics?.inc("pty.spawned_total");
      updateActive();

      if (shellFellBack && socket.readyState === WS_OPEN) {
        // Browser-user-facing: a dim line in the fresh session's scrollback,
        // sent before the shell's first prompt. Per-open by design — each new
        // terminal is its own context that hasn't seen the previous notice. The
        // operator-facing stdout warning is emitted once at startup (cli.ts).
        try {
          socket.send(new TextEncoder().encode(SHELL_FALLBACK_NOTICE));
        } catch {
          // Socket closing/closed; the close handler detaches the session.
        }
      }

      pty.onData(bytes => {
        // Capture before forwarding so the replay buffer also records output
        // produced while the socket is detached — a TUI like htop refreshes
        // every ~1.5s and we want the reattaching client to see the freshest
        // frame, not a stale pre-disconnect one.
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
            // Socket is closing/closed; the close handler detaches the session.
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
        // Runs for attached AND detached sessions alike — a shell exiting
        // while nobody is connected still frees its session slot, so a later
        // upgrade with the same sessionId spawns fresh. Identity-guarded:
        // killSession() and the user-terminate close remove the entry
        // eagerly, and the id may have been REUSED for a fresh PTY by the
        // time this exit fires — deleting by id alone would drop that new
        // session from routing and the inventory.
        if (sessions.get(id) === session) {
          sessions.delete(id);
          updateActive();
        }
        metrics?.inc("pty.reaped_total");
      });
    },

    message(socket, data) {
      const session = sessions.get(socket.data.sessionId);
      if (!session) return;
      // Ownership guard: after a takeover the previous holder's close
      // handshake is asynchronous, and its already-queued input/resize
      // frames still arrive here. Only the session's current socket may
      // write to or resize the PTY.
      if (session.socket !== socket) return;

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

    close(socket, code) {
      const session = sessions.get(socket.data.sessionId);
      if (!session) return;
      // Guard against the hijack-refusal path: `open()` closes a LOSING
      // socket with 4409 while the session's winning socket stays attached.
      // Only the socket that owns the session may detach or terminate it.
      if (session.socket !== null && session.socket !== socket) return;

      if (code === CLOSE_CODE_USER_TERMINATE) {
        // The confirmed pane-close path: the user explicitly accepted losing
        // the session, so kill the PTY and free the sessionId eagerly.
        // Metrics accounting stays with pty.onExit (which fires on the
        // SIGHUP) so reaped_total counts each PTY exactly once.
        try {
          session.pty.kill("SIGHUP");
        } catch {
          // Already dead.
        }
        sessions.delete(session.id);
        updateActive();
        return;
      }

      // Every other close — navigation, tab/browser close, system sleep,
      // network drop — detaches the socket and keeps the PTY running. A later
      // upgrade with the same sessionId lands in the reattach path in
      // `open()`; the session otherwise lives until its shell exits or the
      // server shuts down.
      session.socket = null;
    },

    disposeAll() {
      for (const session of sessions.values()) {
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
