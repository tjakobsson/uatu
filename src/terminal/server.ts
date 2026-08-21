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
import { TerminalModel } from "./model";

type SocketData = { sessionId: string; takeover?: boolean; ready?: boolean; attaching?: boolean };

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
  model: TerminalModel;
  socket: ServerWebSocket<SocketData> | null;
  pendingClaim: ServerWebSocket<SocketData> | null;
  pendingOutput: Uint8Array[];
  deferredHolderResize: { cols: number; rows: number } | null;
  // Wall-clock millis at spawn; surfaces as age in the session inventory.
  createdAt: number;
  // Basename of the spawned shell — the inventory label fallback when no
  // foreground process can be resolved.
  shellName: string;
  cols: number;
  rows: number;
  closing: boolean;
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
  | { kind: "unknown" }
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
  createSession(dimensions?: { cols?: number; rows?: number }): Promise<TerminalSessionInfo>;
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

  const createSession = async (
    dimensions: { cols?: number; rows?: number } = {},
  ): Promise<TerminalSessionInfo> => {
    const backend = await resolveTerminalBackend();
    if (!backend.available) throw new Error("terminal backend unavailable");
    const cols = Math.max(1, Math.floor(dimensions.cols ?? options.initialCols ?? 80));
    const rows = Math.max(1, Math.floor(dimensions.rows ?? options.initialRows ?? 24));
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols > 1000 || rows > 1000) {
      throw new Error("invalid terminal dimensions");
    }
    const env = options.env ?? process.env;
    const shell = options.shell ?? (shellIsUnset(env) ? DEFAULT_SHELL : env.SHELL!);
    const shellFellBack = !options.shell && shellIsUnset(env);
    const ptyEnv: Record<string, string> = {
      ...(env as Record<string, string>),
      COLORTERM: "truecolor",
      TERM: "xterm-256color",
    };
    const pty = backend.spawn(shell, [], { cols, rows, cwd: options.cwd, env: ptyEnv });
    const id = crypto.randomUUID();
    const session: Session = {
      id,
      pty,
      model: new TerminalModel(cols, rows),
      socket: null,
      pendingClaim: null,
      pendingOutput: [],
      deferredHolderResize: null,
      createdAt: Date.now(),
      shellName: shell.split("/").at(-1) ?? shell,
      cols,
      rows,
      closing: false,
    };
    sessions.set(id, session);
    metrics?.inc("pty.spawned_total");
    updateActive();

    if (shellFellBack) {
      session.model.write(new TextEncoder().encode(SHELL_FALLBACK_NOTICE));
    }
    pty.onData(bytes => {
      if (session.closing) return;
      session.model.write(bytes);
      if (session.pendingClaim) session.pendingOutput.push(new Uint8Array(bytes));
      if (session.socket && session.socket.readyState === WS_OPEN) {
        try {
          session.socket.send(bytes);
        } catch {
          // Socket closing; close() will detach it.
        }
      }
    });
    pty.onExit(({ exitCode, signal }) => {
      session.closing = true;
      const pendingClaim = session.pendingClaim;
      session.pendingClaim = null;
      session.pendingOutput = [];
      session.deferredHolderResize = null;
      const attachedSockets = new Set([session.socket, pendingClaim]);
      for (const socket of attachedSockets) {
        if (!socket || socket.readyState !== WS_OPEN) continue;
        try {
          socket.send(JSON.stringify({ type: "exit", exitCode, signal }));
          socket.close(1000, "shell exited");
        } catch {
          // Socket may already be closing.
        }
      }
      if (sessions.get(id) === session) {
        sessions.delete(id);
        updateActive();
      }
      session.model.dispose();
      metrics?.inc("pty.reaped_total");
    });
    return {
      id,
      attached: false,
      createdAt: session.createdAt,
      cols,
      rows,
      label: session.shellName,
    };
  };

  const applyResize = (session: Session, cols: number, rows: number): void => {
    session.cols = cols;
    session.rows = rows;
    const modelResize = session.model.resize(cols, rows);
    try {
      session.pty.resize(cols, rows);
    } catch {
      // Resize can fail if the PTY just exited; model cleanup follows exit.
    }
    void modelResize.catch(() => undefined);
  };

  const restoreDeferredHolderResize = (session: Session): void => {
    const deferred = session.deferredHolderResize;
    session.deferredHolderResize = null;
    if (!deferred || session.pendingClaim || !session.socket) return;
    applyResize(session, deferred.cols, deferred.rows);
  };

  const completeAttach = async (session: Session, socket: ServerWebSocket<SocketData>, cols: number, rows: number) => {
    if (session.socket && session.socket !== socket && !socket.data.takeover) {
      socket.close(4409, "sessionId in use");
      return;
    }
    if (session.pendingClaim && session.pendingClaim !== socket) {
      socket.close(4409, "session claim in progress");
      return;
    }
    if (socket.data.attaching) return;
    socket.data.attaching = true;
    session.pendingClaim = socket;
    session.pendingOutput = [];
    try {
      await session.model.resize(cols, rows);
      // The claimant may disconnect while queued model writes drain. Its
      // close handler releases the claim, and another socket can claim the
      // session before this coroutine resumes. Do not mutate that newer
      // claim's dimensions or output buffer.
      if (session.pendingClaim !== socket || socket.readyState !== WS_OPEN) return;
      // resize() drains all output queued before this point. Start the live
      // buffer at the serialization boundary so bytes already represented in
      // the snapshot are not sent twice.
      session.pendingOutput = [];
      session.cols = cols;
      session.rows = rows;
      session.pty.resize(cols, rows);
      // resize() may synchronously emit a redraw. The model includes it in
      // the snapshot, so begin buffering live output after that boundary.
      session.pendingOutput = [];
      const snapshot = await session.model.serialize();
      if (session.pendingClaim !== socket || socket.readyState !== WS_OPEN) return;
      const previous = session.socket;
      const send = (bytes: Uint8Array): void => {
        if (socket.send(bytes) < 0) throw new Error("terminal attach delivery failed");
      };
      send(snapshot);
      for (const bytes of session.pendingOutput) send(bytes);
      // Commit ownership only after reconstruction delivery succeeds. A
      // failed claimant must leave the current holder usable.
      session.deferredHolderResize = null;
      session.socket = socket;
      session.pendingOutput = [];
      session.pendingClaim = null;
      socket.data.attaching = false;
      socket.data.ready = true;
      if (previous && previous !== socket) {
        try {
          previous.close(CLOSE_CODE_SESSION_TAKEN, "session taken");
        } catch {
          // Previous holder may already be closing.
        }
      }
    } catch {
      if (session.pendingClaim === socket) {
        session.pendingClaim = null;
        session.pendingOutput = [];
        restoreDeferredHolderResize(session);
      }
      socket.data.attaching = false;
      try {
        socket.close(1011, "terminal attach failed");
      } catch {
        // Already closed.
      }
    }
  };

  return {
    async isAvailable() {
      return (await resolveTerminalBackend()).available;
    },

    createSession,

    prepareSession(sessionId, options) {
      if (!isValidSessionId(sessionId)) return { kind: "invalid" };
      const existing = sessions.get(sessionId);
      if (!existing) return { kind: "unknown" };
      if (existing.pendingClaim !== null) return { kind: "collision" };
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
        attached: s.socket !== null || s.pendingClaim !== null,
        createdAt: s.createdAt,
        cols: s.cols,
        rows: s.rows,
        label: labels.get(s.pty.pid) ?? s.shellName,
      }));
    },

    killSession(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return false;
      session.closing = true;
      // An attached holder learns its shell died the normal way: SIGHUP →
      // pty.onExit → exit frame + close(1000) on its socket.
      try {
        session.pty.kill("SIGHUP");
      } catch {
        // Already dead.
        session.model.dispose();
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
      if (!existing) socket.close(4404, "unknown session");
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
        if (parsed && typeof parsed === "object" && (parsed as { type?: unknown }).type === "attach-ready") {
          const cols = Math.floor(Number((parsed as { cols?: unknown }).cols));
          const rows = Math.floor(Number((parsed as { rows?: unknown }).rows));
          if (!socket.data.ready && !socket.data.attaching && Number.isFinite(cols) && Number.isFinite(rows)
            && cols > 0 && rows > 0 && cols <= 1000 && rows <= 1000) {
            void completeAttach(session, socket, cols, rows);
          }
          return;
        }
        if (!socket.data.ready || session.socket !== socket) return;
        if (parsed && typeof parsed === "object" && (parsed as { type?: unknown }).type === "resize") {
          const cols = Math.max(1, Math.floor(Number((parsed as { cols?: unknown }).cols)));
          const rows = Math.max(1, Math.floor(Number((parsed as { rows?: unknown }).rows)));
          if (Number.isFinite(cols) && Number.isFinite(rows) && cols <= 1000 && rows <= 1000) {
            if (session.pendingClaim && session.pendingClaim !== socket) {
              // The current holder remains interactive until takeover commits,
              // but changing the shared model mid-snapshot would reconstruct
              // the claimant at the wrong dimensions. Keep only the latest
              // resize and restore it if the claim aborts.
              session.deferredHolderResize = { cols, rows };
            } else {
              applyResize(session, cols, rows);
            }
          }
        }
        return;
      }

      if (!socket.data.ready || session.socket !== socket) return;

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
      if (session.pendingClaim === socket) {
        session.pendingClaim = null;
        session.pendingOutput = [];
        restoreDeferredHolderResize(session);
      }
      // Guard against the hijack-refusal path: `open()` closes a LOSING
      // socket with 4409 while the session's winning socket stays attached.
      // Only the socket that owns the session may detach or terminate it.
      if (session.socket !== null && session.socket !== socket) return;

      if (code === CLOSE_CODE_USER_TERMINATE) {
        // The confirmed pane-close path: the user explicitly accepted losing
        // the session, so kill the PTY and free the sessionId eagerly.
        // Metrics accounting stays with pty.onExit (which fires on the
        // SIGHUP) so reaped_total counts each PTY exactly once.
        session.closing = true;
        try {
          session.pty.kill("SIGHUP");
        } catch {
          // Already dead.
        }
        sessions.delete(session.id);
        session.model.dispose();
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
        session.closing = true;
        try {
          session.pty.kill("SIGHUP");
        } catch {
          // Already dead.
        } finally {
          session.model.dispose();
        }
      }
      sessions.clear();
      updateActive();
    },
  };
}
