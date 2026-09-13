## Why

A session page opened from the iOS home screen stops recovering its live
connection after the app is backgrounded. The indicator sits on
`Reconnecting` forever, Chat reports an interruption it never clears, and the
only way out is to navigate to the hub dashboard and back — a full document
load. In `display: standalone` there is no reload button and no
pull-to-refresh, so a user who does not know that trick has no recovery at
all short of force-quitting.

Two defects produce this, and the page holds no affordance that could rescue
it from either. The reconnect cycle itself is uncapped and correct; every
observed stall is a cycle that was killed or a wake-up signal that was
dropped.

- An unpersisted `pagehide` is treated as proof the document is being
  discarded, so the shell disposes the live channel and removes every wake-up
  listener, and the Chat surface closes its streams for good. iOS fires that
  event when a standalone page is backgrounded and then keeps the document
  alive. Nothing re-arms either one; `watchPageLifecycle()` runs once, at boot.
- The lifecycle recovery drops overlapping signals while one recovery is in
  flight, and a recovery is only in flight until its work settles. The shell's
  registered work is an unbounded `fetch` of `/api/state`. A request that never
  answers — routine on a phone changing networks — leaves the in-flight flag
  set permanently, and every later wake-up signal is discarded.

## What Changes

- An unpersisted `pagehide` suspends the live channel instead of disposing it.
  Subscriptions and cursors are retained, pending timers are cancelled, the
  socket is closed, and the wake-up listeners stay armed so a return to the
  foreground reconnects. A document that really is unloading takes its timers
  with it, so nothing is left running.
- The Chat surface stops tearing itself down on an unpersisted `pagehide`.
  Its hidden-page path already keeps every stream — the channel suspends the
  socket at page level and retains the subscriptions — so the `pagehide`
  teardown is a redundant second teardown, not a tidier variant. Only the
  draft flush on that signal is kept.
- Every recovery task is bounded. The shell's state reconciliation fetch
  carries a timeout and an abort signal, as the Chat client's reads already do,
  and the lifecycle recovery clears its in-flight flag on a bounded schedule so
  no single hung task can silence later wake-ups.
- One manual recovery, two ways to reach it. Activating it requests a
  recovery in place; if the connection has not been confirmed within a short
  window, it reloads the page. Chat's connection-interruption status line
  gains a Reconnect action — the surface where the stall was reported — and
  the shell's connection indicator becomes a button. This is the escape hatch
  for any stall, including causes outside this change's scope, and it is
  reachable in standalone display mode where the browser offers nothing.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `document-watch-index`: lifecycle recovery survives a page hidden without
  being unloaded, and no unbounded reconciliation task may suppress later wake-ups
- `hub-live-stream`: the one brokered stream is suspended rather than disposed
  when the page is hidden, and resumes on the next wake-up
- `opencode-chat`: the Chat surface resubscribes after a backgrounded page
  returns rather than remaining closed for the life of the document
- `sidebar-shell`: the connection indicator is an actionable reconnect control,
  not a passive label

## Impact

- `src/shell/recovery.ts` — the `pagehide` branch and the in-flight guard
- `src/shell/live.ts` — `discard` wiring; a suspend path that survives re-arming
- `src/shell/events.ts` — a bounded `fetchState`
- `src/shell/connection.ts`, `src/index.html`, `src/styles.css` — the indicator
  becomes a button with an accessible name, hit target, and touch-mode styling
- `src/chat/ui.ts` — the `pagehide` teardown, and the Reconnect action on the
  interruption status line
- `src/shell/recovery.test.ts` — the existing case asserting that an unpersisted
  `pagehide` tears the channel down encodes the defect and is replaced
- No server, protocol, or API change; no workspace revision bump
