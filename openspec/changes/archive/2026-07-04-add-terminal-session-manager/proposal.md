# Add terminal session manager

## Why

Persistent PTY sessions (`persist-detached-pty-sessions`) plus single-claimant
reattach hints (`fix-second-window-session-collision`) create sessions that
are alive but unreachable: a collision-loser window's sessions are deliberately
unhinted, so closing that window orphans its shells — the user can see htop in
`ps aux` but has no way to reattach or kill it from uatu. Both prior changes
deferred a "detached sessions" facility; real usage hit the gap within a day.
Sessions need to be visible, attachable from any window (tmux-style, including
taking over an attached session), and killable.

## What Changes

- **Session inventory endpoint**: `GET /api/terminal/sessions` (same
  credential gate as the terminal upgrade) returns every live session:
  id, attached/detached, created-at, dimensions, and a best-effort label
  (shell name; foreground process where cheaply obtainable).
- **Kill endpoint**: `DELETE /api/terminal/sessions/<id>` terminates a
  session without needing to attach first.
- **Attach with takeover**: the WebSocket upgrade accepts a `takeover=1`
  parameter. For an attached session it detaches the current holder — closed
  with a new app close code 4410 ("session taken") — and hands the PTY plus
  replay buffer to the claimant. Without the flag, the existing 409 refusal
  stands.
- **Taken-over pane UX**: a pane whose session is taken shows an
  "[attached in another window]" notice with an explicit "take back" action;
  it is NOT auto-torn-down and never re-steals automatically.
- **Session picker UI**: when a new pane is about to spawn (panel open with
  no panes, or split) and other live sessions exist, the pane area offers the
  inventory — attach (with takeover where needed), kill, or start a fresh
  shell — instead of always silently minting a new one.
- The hint/collision machinery from `fix-second-window-session-collision`
  remains as the no-interaction fallback; the manager is the user-visible
  path.

## Capabilities

### New Capabilities

<!-- none — this extends the embedded terminal -->

### Modified Capabilities

- `embedded-terminal`: adds requirements for (1) an authenticated session
  inventory with list and kill, (2) attach-with-takeover semantics and the
  taken-over pane's behavior, (3) the new-pane session picker.

## Impact

- `src/terminal/server.ts` — session metadata (createdAt, label), `listSessions()`,
  `killSession(id)`, takeover path in `open()`/`prepareSession()`, close code 4410.
- `src/terminal/pty.ts` / new adapter — best-effort foreground-process label
  (POSIX `ps`, isolated behind an adapter; omitted where unavailable).
- `src/cli.ts` + `tests/e2e/server.ts` — the two REST routes and the
  `takeover` upgrade parameter.
- `src/terminal/client.ts` — handle close code 4410 (notice + take-back
  affordance), takeover connect option.
- `src/terminal/panel.ts` — session picker in the new-pane flow; record
  updates when attaching to an adopted session.
- Tests: server unit tests (list/kill/takeover), client/panel behavior, E2E
  two-window takeover round-trip and orphan-recovery scenario.
