# Fix second-window session collision

## Why

Opening the terminal in a second browser window of the same uatu instance
locks the user out with a misleading "Reconnect to uatu / paste token" form.
Both windows share `localStorage`, so the second window tries to claim the
same persisted `sessionId`; the server correctly rejects the duplicate with
HTTP 409 pre-upgrade, but the browser exposes no status on a failed WebSocket
upgrade, and the client treats every close-before-open as an auth failure.
Pasting a valid token fixes nothing because auth was never the problem. This
was a documented-but-rare edge (`client.ts` comment) that
`persist-detached-pty-sessions` promoted to near-certain: persisted ids now
almost always point at a live, claimable-by-one session.

## What Changes

- **Auth probe endpoint**: add `GET /api/auth` returning 204 when the request
  carries valid terminal credentials (cookie or `?t=`), 401 otherwise.
  (POST /api/auth is unchanged.)
- **Collision disambiguation in the client**: on WebSocket close-before-open,
  probe `GET /api/auth`. Authenticated → treat as a sessionId collision: mint
  a fresh `sessionId` for the pane and reconnect, giving the second window its
  own shell. Only an actual 401 shows the paste-token form.
- **Pane-record ownership**: pane records (the `sessionId` list) move to
  per-window `sessionStorage`; `localStorage` keeps a copy as *restart
  reattach hints*. A window with its own records always uses them (reload
  path); a window without records (fresh window / browser restart) attempts
  to adopt the hints, and the server's 409 arbitrates — first claimant adopts,
  later windows fall back to fresh sessions without overwriting the hints.
  Layout preferences (dock, sizes, display mode) stay in `localStorage`
  shared across windows, as today.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `embedded-terminal`: adds a requirement that a sessionId collision is
  resolved with a fresh session rather than an auth prompt (with the
  `GET /api/auth` probe as the disambiguation mechanism), and a requirement
  that pane reattach hints are single-claimant so concurrent windows do not
  clobber each other's ability to reattach.

## Impact

- `src/cli.ts` and `tests/e2e/server.ts` — handle `GET /api/auth` (the
  route lives in the shared fetch fallback, mirrored in both servers).
- `src/terminal/client.ts` — close-before-open handler: probe, then either
  collision-retry with a fresh id or show the paste-token form.
- `src/terminal/panel.ts` / `src/terminal/pane-state.ts` — pane records to
  `sessionStorage` with `localStorage` hint adoption; persistence helpers and
  their unit tests.
- `tests/e2e/` — two-window (two browser contexts sharing storage state)
  scenario: second window gets a fresh shell with no token prompt; first
  window unaffected; reload of each window reattaches its own sessions.
- Accepted residue: a second window's unhinted sessions become unreachable
  detached PTYs if that window closes for good (same accepted class as
  forgotten detached shells from `persist-detached-pty-sessions`).
