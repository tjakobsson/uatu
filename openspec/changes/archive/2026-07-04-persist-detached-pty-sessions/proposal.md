# Persist detached PTY sessions

## Why

Closing the browser (or a laptop sleep dropping the WebSocket) kills every terminal
session 5 seconds later: the server's reconnect grace window
(`DEFAULT_RECONNECT_GRACE_MS = 5_000` in `src/terminal/server.ts`) was designed to
absorb page reloads, not absences. Pane `sessionId`s already persist in
`localStorage` and the reattach + replay machinery already exists — the only thing
preventing tmux-detach semantics is the reap timer. Long-running work in the
embedded terminal (builds, agent sessions for the ACP explore direction) should
survive the browser going away.

## What Changes

- **BREAKING (behavioral)**: A WebSocket disconnect no longer terminates the PTY.
  Detached sessions live until the shell exits or the uatu server shuts down —
  the 5-second reap timer is removed.
- Reattach by `sessionId` works at any time, not just within a 5-second window;
  the existing replay buffer (128 KiB per session) seeds the reattached client.
- Explicitly closing a pane (the confirmed × action) still terminates the PTY,
  but now via a deliberate client→server signal instead of relying on the grace
  reap. Abrupt disconnects (tab close, sleep, network drop) detach; only the
  confirmed close kills.
- Server shutdown behavior is unchanged: `disposeAll()` still kills every PTY.
- Shell exit while detached still removes the session (already implemented in
  `pty.onExit`); no orphan session records accumulate.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `embedded-terminal`: the "Terminal lifecycle is bounded by the connection"
  requirement is replaced — the PTY lifetime is bounded by the shell process and
  the server session, not the WebSocket. The "Closing the terminal pane confirms
  loss of session" requirement changes its teardown scenario: confirmed close
  terminates the PTY via an explicit signal rather than "reaped within the grace
  window".

## Impact

- `src/terminal/server.ts` — remove reap timer arming in `close()`; add explicit
  kill handling for the user-close signal; `Session.reapTimer` field and
  `reconnectGraceMs` option removed or repurposed.
- `src/terminal/client.ts` — send the user-close signal on confirmed pane close;
  reconnect-after-wake path reattaches with the persisted `sessionId`.
- `src/terminal/panel.ts` — confirmed close routes through the client's explicit
  kill instead of a bare socket close.
- Tests: `server.test.ts` grace-window tests replaced with detach/reattach and
  explicit-kill tests; `integration.test.ts` updated.
- Memory: each detached session holds up to 128 KiB of replay buffer plus the PTY;
  accepted for a local single-user tool. A "detached sessions" indicator is out of
  scope for this change.
