# Tasks — add-terminal-session-manager

## 1. Server: inventory, kill, takeover

- [x] 1.1 Extend `Session` in `src/terminal/server.ts` with `createdAt` and
      shell-name label; add `listSessions()` and `killSession(id)` to the
      `TerminalServer` type (list returns id, attached, createdAt, cols/rows,
      label).
- [x] 1.2 Add the foreground-process label adapter (POSIX `ps` behind a small
      module returning `string | null`, short timeout, null on Windows or
      any failure); enrich `listSessions()` labels best-effort.
- [x] 1.3 Add takeover: `prepareSession(sessionId, { takeover })` returns
      `"takeover"` for attached sessions; `open()` closes the previous
      socket with 4410 "session taken", swaps the socket, replays the
      buffer. Non-takeover collision behavior unchanged.
- [x] 1.4 Server unit tests: inventory contents across attach/detach/kill,
      DELETE kill of a detached session, 404/401 paths, takeover swaps the
      holder and the loser gets 4410, replay reaches the new holder,
      simultaneous-claim race leaves consistent state.

## 2. HTTP routes

- [x] 2.1 Wire `GET /api/terminal/sessions` and
      `DELETE /api/terminal/sessions/<id>` (credential gate shared with
      `GET /api/auth`) plus the `takeover` upgrade parameter in `src/cli.ts`
      and `tests/e2e/server.ts`.
- [x] 2.2 Route-level tests (extend `src/terminal/integration.test.ts`):
      auth gate, list shape, delete, upgrade with takeover.

## 3. Client: 4410 handling and take-back

- [x] 3.1 In `src/terminal/client.ts`: on close code 4410, render the
      "attached in another window" notice with a "Take back" action; no
      automatic reconnect; expose a takeover connect option used by
      take-back and by picker attach.
- [x] 3.2 Parked-pane close follows the exited-shell path (no confirm modal,
      no terminate signal — the session belongs to another window).

## 4. Panel: session picker

- [x] 4.1 Fetch + filter the inventory in the pane-spawn flow (first open
      with nothing to restore, split); render the in-pane chooser (attach /
      kill / new shell) when non-empty, skip when empty.
- [x] 4.2 Attach binds the pane to the chosen sessionId (takeover when
      attached elsewhere) and persists through the normal record path; kill
      calls the DELETE endpoint and refreshes the list.
- [x] 4.3 Unit-test the picker's filtering/decision logic (pure helpers).

## 5. E2E

- [x] 5.1 Orphan recovery: window 1 starts a marker process and closes
      abruptly; window 2's picker lists the session; attaching resumes the
      marker session.
- [x] 5.2 Takeover round-trip: window 2 takes window 1's attached session
      (window 1 shows the notice); window 1 takes it back.
- [x] 5.3 Kill from picker removes the session; empty inventory spawns a
      fresh shell with no picker.
- [x] 5.4 Run `bun test` and the full `bun test:e2e`; fix regressions.

## 6. Docs and spec sync

- [x] 6.1 Update ARCHITECTURE.md's terminal subsystem section (inventory,
      takeover, close-code table: 1000/4001/4409/4410).
- [x] 6.2 Validate (`openspec validate add-terminal-session-manager`).
- [x] 6.3 Archive the change once it has landed (tested + merged).
