# Tasks — persist-detached-pty-sessions

## 1. Server: persistent detached sessions

- [x] 1.1 Remove the reap timer from `close()` in `src/terminal/server.ts`: on
      socket close (non-4001), detach the socket and keep the session; delete
      the `reapTimer` field and the `reconnectGraceMs` option.
- [x] 1.2 Handle close code 4001 in `close(socket, code)`: SIGHUP the PTY,
      remove the session, bump `pty.reaped_total`, update
      `pty.sessions_active`.
- [x] 1.3 Confirm `prepareSession()` reattach path and comments no longer
      reference the grace window; update doc comments describing session
      lifetime (shell exit / explicit terminate / server shutdown).
- [x] 1.4 Update `server.test.ts`: replace grace-window reap tests with
      (a) detach persists the PTY indefinitely, (b) reattach after detach
      replays buffered output, (c) close code 4001 kills the PTY and frees the
      sessionId, (d) shell exit while detached removes the session,
      (e) `disposeAll()` kills detached sessions too.

## 2. Client: explicit terminate on confirmed close

- [x] 2.1 Add a terminate path in `src/terminal/client.ts` that closes the
      WebSocket with code 4001 ("user-close"); keep all other teardown paths
      on default close codes.
- [x] 2.2 Route the confirmed close (× → confirm modal accept) in
      `src/terminal/panel.ts` through the 4001 terminate path; the
      exited-shell close path stays a plain pane removal.
- [x] 2.3 Update `client.test.ts` / panel tests for the confirmed-close signal
      and for reattach with a persisted sessionId outside any grace window.

## 3. Integration and E2E

- [x] 3.1 Update `src/terminal/integration.test.ts` for the new lifecycle
      (no grace-window timing; detach → reattach round-trip; explicit kill).
- [x] 3.2 Add/adjust E2E coverage in `tests/e2e/` for: reload reattaches to the
      same shell, confirmed close spawns a fresh shell on next open, and the
      duplicate-sessionId (second tab) path with a long-lived session.
- [x] 3.3 Run `bun test` and `bun test:e2e`; fix regressions.

## 4. Docs and spec sync

- [x] 4.1 Update any ARCHITECTURE.md / doc comments describing the 5-second
      grace window and "terminal lifecycle is bounded by the connection".
- [x] 4.2 Validate the change (`openspec validate persist-detached-pty-sessions`).
- [x] 4.3 Archive the change once it has landed (tested + merged).
