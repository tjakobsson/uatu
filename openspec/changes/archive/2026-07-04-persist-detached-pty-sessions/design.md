# Design — persist-detached-pty-sessions

## Context

`src/terminal/server.ts` keeps a `Map<sessionId, Session>` where each `Session`
owns a PTY, an optional attached WebSocket, and a replay buffer (128 KiB cap).
On WebSocket `close()`, the server detaches the socket and arms a
`reapTimer` (`DEFAULT_RECONNECT_GRACE_MS = 5_000`) that SIGHUPs the PTY and
deletes the session. `prepareSession()` already distinguishes `"fresh"` /
`"reattach"` / `"collision"`; pane `sessionId`s persist in `localStorage`
(`pane-state.ts`), so clients already try to reclaim their sessions across
browser restarts — they just always miss the 5-second window.

The confirmed pane-close path today does nothing special server-side: the
client closes the WebSocket and the grace reap performs the actual kill. That
coupling is the one piece that breaks when the reap is removed.

## Goals / Non-Goals

**Goals:**
- PTYs survive any disconnect that is not an explicit user close: tab close,
  browser quit, system sleep, network drop.
- Reattach at any later time via the existing `sessionId` + replay-buffer path.
- Confirmed pane close still reliably terminates the PTY.
- No change to server-shutdown semantics (`disposeAll()` kills everything).

**Non-Goals:**
- No UI listing/killing detached sessions ("2 detached shells" indicator) —
  future work.
- No cross-restart PTY persistence (uatu restart still starts clean).
- No change to auth: token, sessionId validation, and Origin checks stay as-is.
- The watchdog sleep fix is a separate change (`fix-watchdog-sleep-false-positive`).

## Decisions

### D1: No reap timer at all (vs. a long configurable grace)
Remove `reapTimer` and the `reconnectGraceMs` option instead of extending the
window. An idle detached shell costs ~nothing on a local single-user tool, and
any finite timer reintroduces the exact failure being fixed (a timer killing a
running build because nobody was watching). Tick-based or config-based grace
windows were considered and rejected as arbitrary cutoffs. Session end
conditions become exactly: shell exit, explicit terminate, server shutdown.

### D2: Explicit terminate via app-defined WebSocket close code (4001)
The confirmed pane close sends `ws.close(4001, "user-close")`. The server's
`close(socket, code)` handler treats code 4001 as "kill the PTY now"
(SIGHUP + session delete) and every other code — including 1001 (navigation),
1006 (abrupt drop, sleep) — as "detach and persist".

Alternative considered: a JSON control frame (`{type: "dispose"}`) sent before
closing. Rejected because it adds a message type plus an ordering concern
(frame must flush before close), whereas the close code travels in the close
handshake itself and Bun's `close(ws, code, reason)` handler already receives
it. Abrupt disconnects can never accidentally produce 4001, so the failure
mode of a dropped connection is always "session persists" — the safe default.
4001 is chosen to avoid colliding with the existing 4409 ("sessionId in use")
convention.

### D3: Keep the replay buffer semantics unchanged
128 KiB per session bounds memory for arbitrarily long detachments; a client
reattaching after hours gets the most recent 128 KiB of output, same as a
reload today. Growing or persisting the buffer is out of scope.

### D4: Reattach UX stays opt-in via the existing visibility flag
The per-tab `sessionStorage` visibility flag still means a reopened browser
does not auto-open the panel. When the user opens it, panes restore from
`localStorage` and reattach to live PTYs. No auto-spawn behavior changes.

### D5: Metrics
`pty.reaped_total` now counts shell exits and explicit terminates (the reap
path is gone); `pty.sessions_active` continues to track the registry size,
which now includes detached sessions. No new metric names.

## Risks / Trade-offs

- [Forgotten shells accumulate until server exit] → Acceptable for a local
  tool; each costs one idle shell process + ≤128 KiB. A detached-sessions
  indicator is deliberately deferred.
- [Two tabs restoring the same localStorage panes collide more often once
  sessions are long-lived] → Existing 409/4409 handling already assigns the
  loser a fresh sessionId; add a test covering the persistent-session case.
- [A client bug that closes with 4001 unintentionally kills a session] →
  Confine `close(4001)` to the single confirmed-close call site in
  `panel.ts`/`client.ts`; all other teardown paths use default codes.
- [Tests relying on the grace window] → `server.test.ts` uses
  `reconnectGraceMs` to exercise reap timing; those tests are replaced by
  detach-persistence and explicit-terminate tests (no wall-clock waits needed).
