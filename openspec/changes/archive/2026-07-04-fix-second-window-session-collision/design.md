# Design — fix-second-window-session-collision

## Context

The pre-upgrade gate (`handleTerminalUpgrade` in `cli.ts`, mirrored in
`tests/e2e/server.ts`) returns 401/403/400/409 before the WebSocket opens.
Browsers expose none of these on the resulting close event, so
`client.ts`'s close-before-open branch conflates them and always shows the
paste-token form (`showPasteTokenUI`). The form's copy sends users hunting
for a token that will not help when the real cause is a 409.

Pane records live in `localStorage` (`pane-state.ts`), shared by every window
of the browser. `persist-detached-pty-sessions` made persisted ids point at
live sessions ~always, so a second window now collides ~always.

## Goals / Non-Goals

**Goals:**
- A second window reaches a working shell with zero prompts.
- The paste-token form appears only for genuine auth failures.
- Concurrent windows cannot destroy each other's ability to reattach.
- Keep the server's duplicate-sessionId rejection as the single arbiter —
  no new locking or window-coordination protocol.

**Non-Goals:**
- No enumeration/GC of detached sessions (a collision loser that closes for
  good orphans its PTYs — same accepted class as forgotten detached shells).
- No change to POST /api/auth, token minting, or cookie semantics.
- No cross-window live sharing of one PTY (multiple sockets per session
  stays rejected).

## Decisions

### D1: Disambiguate with a `GET /api/auth` probe
On close-before-open, the client fetches `GET /api/auth` (same-origin,
cookie rides along automatically; falls back to appending `?t=` when it holds
a token). 204 → credentials are fine → the failure was the upgrade gate's
409 (or a transient) → mint a fresh `sessionId` and reconnect; cap at one
retry per attach so a genuinely broken server cannot cause a reconnect loop.
401 → real auth failure → paste-token form as today.

Alternatives rejected:
- Encoding the rejection reason in a cookie or a page-visible side channel:
  more moving parts for the same answer.
- Pre-flight HTTP check of session availability before upgrading: adds a
  TOCTOU race the 409 path already handles authoritatively.

### D2: Per-window pane records, shared hints, server-arbitrated adoption
`pane-state.ts` splits the state:
- **Pane records (`sessionId` + `createdAt`)** → `sessionStorage`
  (per-window, survives that window's reloads).
- **Restart hints** → `localStorage`: a copy of the records, written by the
  window that owns the attached sessions (the claimant), used only by
  windows that have no records of their own.
- **Layout prefs (dock, sizes, display mode, legacy keys)** → `localStorage`
  unchanged.

Boot order: own `sessionStorage` records → else adopt `localStorage` hints →
else fresh pane. Adoption is optimistic: the window tries the hinted ids and
the server's 409 says no; a loser mints fresh ids into its own
`sessionStorage` and leaves the hints untouched. No new coordination — the
server's existing collision rejection is the only arbiter.

Alternative rejected: keep one shared record list and let the loser rewrite
it. Last-writer-wins turns window 1's long-running shells into unreachable
orphans on its next reload — the worst outcome for exactly the user the
persistence change serves.

### D3: Probe route placement
`GET /api/auth` joins POST in the fetch fallback of both servers (`cli.ts`
and `tests/e2e/server.ts`), implemented once as a shared handler beside the
existing auth helpers (`src/terminal/auth.ts` owns cookie parsing and
constant-time compare already). Validation logic identical to the upgrade
gate's credential check, minus sessionId/origin concerns — it answers only
"do you hold valid credentials", deliberately cache-hostile
(`cache-control: no-store`).

## Risks / Trade-offs

- [Probe adds a round-trip before the paste-token form appears] → Only on
  the already-failed path; imperceptible against a human-speed flow.
- [Collision loser's sessions orphan if its window never returns] →
  Accepted and documented; a detached-sessions indicator/GC is future work.
- [Browser session-restore can resurrect `sessionStorage` in two restored
  windows... with distinct copies] → Each window restores its own records;
  at most one wins each id, the other resolves via the collision path — the
  exact flow this change makes graceful.
- [Migration: existing users have records only in `localStorage`] → That is
  precisely the "no own records → adopt hints" path; no migration code
  needed beyond treating the legacy key as the hint store.
