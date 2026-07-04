# Design — add-terminal-session-manager

## Context

`createTerminalServer` already holds the complete session registry
(`Map<sessionId, Session>` with PTY, socket, replay buffer, dims). The
reattach path exists and is exercised by reloads and browser restarts. What's
missing is (a) any way to *see* the registry, (b) attach semantics for a
session someone else holds, (c) a kill that doesn't require attaching. The
hint/collision machinery (`fix-second-window-session-collision`) arbitrates
the zero-UI path but by design leaves collision losers' sessions unhinted —
orphaned once their window closes.

uatu's PTY layer is Bun's native `Bun.spawn({ terminal })` (`src/terminal/pty.ts`),
NOT node-pty — there is no built-in foreground-process getter.

## Goals / Non-Goals

**Goals:**
- Every live session visible, attachable, and killable from any window.
- tmux-style takeover: attaching to a held session detaches the holder,
  visibly and reversibly.
- Orphan recovery: a session whose window is gone is one click from a pane.
- Keep the one-socket-per-session invariant — takeover moves the socket, it
  never duplicates output streams.

**Non-Goals:**
- No mirroring (two clients viewing one PTY simultaneously).
- No session naming/renaming or persistence across uatu restarts.
- No change to auth: both new endpoints sit behind the existing
  cookie-or-token gate; Origin policy follows the existing REST routes.
- No automatic garbage collection of idle sessions (kill is manual).

## Decisions

### D1: REST inventory (`GET`/`DELETE /api/terminal/sessions`) beside the WS route
The registry lives in the terminal server; expose `listSessions()` and
`killSession(id)` on the `TerminalServer` type and wire thin handlers in the
fetch fallback of both servers (like `GET /api/auth`). REST rather than a WS
control channel because the picker needs the list *before* any socket exists.
`Session` gains `createdAt` and a `label` (see D2). Reuse
`authProbeResponse`-style credential checking.

### D2: Labels are best-effort, behind an adapter
Baseline label: shell basename (already known at spawn). Enhancement: the
PTY's foreground process name via a POSIX `ps`-based lookup keyed on the
shell pid, isolated in a small adapter module so the OS-specific bit is
swappable and simply returns `null` on platforms without `ps` (Windows has
no PTY backend anyway). The inventory must never block on the lookup — cache
per request with a short timeout, fall back to the shell name.

### D3: Takeover is an upgrade parameter, not a new endpoint
`prepareSession(sessionId, { takeover })`: for an attached session with
takeover, return a new `"takeover"` kind; `open()` then closes the previous
socket with **4410 "session taken"** (distinct from 4409 "sessionId in use"
and 4001 "user-close"), swaps in the new socket, and replays the buffer —
identical to reattach from the PTY's perspective. Server `close()` ignores
the 4410-closed socket via the existing ownership guard (the session's
socket reference already points at the new holder). Without takeover, the
409/4409 refusal is unchanged, so nothing about the collision-recovery path
regresses.

### D4: Taken-over pane parks, never ping-pongs
On close code 4410 the client keeps the pane and its record, renders a
dim notice ("attached in another window") with a "Take back" button, and
makes no automatic reconnect for that sessionId. Take-back reconnects with
`takeover=1`. Two windows can knowingly wrestle a session back and forth;
neither does it silently. This also naturally expresses the collision case:
a user who *wants* window 1's session in window 2 now has a supported path
instead of relying on hint arbitration.

### D5: Picker lives in the pane-spawn flow
When `setVisible(true)` or split is about to mint a fresh record AND the
inventory (filtered of this window's own live sessionIds) is non-empty, the
pane host renders a lightweight in-pane chooser (DOM, same styling family as
the paste-token form): rows of `label · state · age` with Attach / Kill,
plus a prominent "New shell". Choosing attach binds the pane to that
sessionId (records update via the normal persist path; attaching makes this
window the session's holder). No modal, no new panel chrome. The picker is
skipped entirely when the filtered inventory is empty, keeping today's
zero-friction default.

### D6: Interplay with hints stays additive
Adoption/hint logic is untouched. Attaching via the picker to a session that
the hints also reference is fine: hints are only read at boot, and the
takeover path supersedes the 409 dance when the user acts explicitly.

## Risks / Trade-offs

- [Takeover races: two windows claim simultaneously] → The registry is
  single-threaded per event loop; last `open()` wins and the loser holds a
  4410 socket — consistent state, both panes render truthfully.
- [`ps`-based labels are approximate (pipelines, subshells)] → Label is
  advisory UI; the id/age/state are authoritative. Adapter returns null on
  any doubt.
- [Picker adds a step to the first-open flow when stray sessions exist] →
  That is the point — silently spawning is how orphans became invisible.
  "New shell" stays one click.
- [4410 pane parked forever if the user ignores it] → It holds only DOM and
  a record; the PTY belongs to the other window. Closing the parked pane
  follows the exited-shell path (no confirm — the session is not "lost", the
  other window has it; killing it there would be wrong).
