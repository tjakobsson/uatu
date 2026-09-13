## Context

See `proposal.md` — Why. The relevant current shape:

- `createLifecycleRecovery` (`src/shell/recovery.ts`) owns the four browser
  signals and coalesces them behind one `inFlight` flag. Its `discard`
  callback is `disposeLiveChannel`.
- `LiveChannel` already distinguishes `suspend()` from `dispose()`
  (`src/shell/live-channel.ts`). `suspend` cancels timers, closes the socket,
  bumps the generation, and keeps `entries` — every subscription and cursor.
  `dispose` sets a terminal `disposed` flag that makes `connect()` a no-op
  forever. The reversible primitive the fix needs already exists and is
  already used for the hidden-page release (`releaseInBackground`).
- `registerRecoveryWork` consumers are awaited with `Promise.allSettled`,
  which never rejects and never resolves early, so the slowest task sets the
  recovery's duration.
- The Chat surface's hidden-page path (`handleChatSurfaceState`) cancels
  read timers and render frames and keeps its streams; the channel-level
  suspend covers the socket. Its `pagehide` block is a separate, permanent
  teardown that assumed the document was dying.
- The connection indicator is a `<span>` in the sidebar header with no
  handler; `applyChannelStatus` is the only writer of its state. Chat's
  interruption status line is rendered by `interruptionsFor` with no action.

## Goals / Non-Goals

**Goals:**

- A page that is hidden and shown again reconnects on its own, whatever
  `pagehide.persisted` said.
- No single task can permanently suppress wake-up signals.
- A stalled connection always has a user-reachable way out, including in
  standalone display mode and on a surface that hides the sidebar.

**Non-Goals:**

- Reporting an expired hub session or a stopped workspace child. Both strand
  a client today (the live route answers `401`/an unavailable topic and the
  client retries forever with no explanation). The reload fallback rescues a
  user from both, so they are deferred rather than blocking this change.
- A client keepalive watchdog ("no bytes for N seconds while visible →
  reconnect"), which would catch a dead socket that never errors without
  depending on any lifecycle event. Blocked today: hub keepalives are SSE
  comment frames, which `EventSource` never surfaces to script. Making them a
  named event is a small server and protocol change and belongs to its own
  change.
- A stall notice on surfaces that have no status line (Preview, Terminal).
  Once the two causes above are removed the stall it would guard against
  mostly stops occurring; revisit if it proves needed.
- Re-presenting a subscription that the protocol refused. Separate defect,
  separate change.
- Any server, protocol, or API change. This is entirely client-side, so no
  workspace revision bump applies.

## Decisions

**Suspend on hide; never dispose from a lifecycle event.** `onPageHide`
stops calling `discard` and instead releases the connection the same way the
hidden-page path already does, leaving the listeners armed. The rejected
alternative was to keep `dispose` and re-arm the listeners on the next
`pageshow` — that does not work, because `lifecycle.dispose()` removes the
very listeners that would observe the return, and iOS does not reliably fire
`pageshow` for a standalone app resuming from the background.

`disposeLiveChannel` is kept as an explicit teardown for tests and for hub
navigation; it is simply no longer wired to a lifecycle event. The original
rationale for discarding — a retry cycle outliving the page — is already
satisfied by `suspend`, which cancels the pending reconnect and closes the
socket. A document that truly unloads stops its own timers regardless.

**Bound the work, not just the flag.** Two independent guards, because they
fail differently. The state fetch gets an `AbortSignal` with a timeout, so a
hung request produces a real rejection that the reconciler's existing
`settledSequence` bookkeeping already handles. Separately, `request()` races
the recovery against a ceiling and clears `inFlight` when the ceiling wins,
so a future unbounded task added by another consumer cannot reintroduce the
same wedge. The ceiling only releases the flag; it does not cancel the work,
which stays owned by whoever registered it.

**Recover in place, then reload.** The control calls the same
`recoverLiveChannel` a wake-up does, then waits for the channel to report
confirmed-live within a bounded window before falling back to
`location.reload()`. Reloading immediately was rejected because it discards
scroll position and view state for what is usually a recoverable stall.
Never reloading was rejected because the control's whole purpose is to
rescue a page whose recovery machinery is gone — in which case an in-place
attempt cannot work by construction.

**Delete the Chat teardown rather than soften it.** Chat's hidden path
already retains streams, and the channel retains subscriptions across a
suspend, so the `pagehide` block has nothing left to do beyond `flushSave()`.
Rewriting it into a release-and-resubscribe path was rejected: it would be a
third copy of behaviour the hidden path and the channel already own.

**One recovery, two callers.** A single `requestManualRecovery()` in
`shell/live.ts` is called from the Reconnect action on Chat's interruption
line and from the indicator, which becomes a `<button>` where the
`sidebar-shell` spec already puts it. Chat's line is the surface where this
was reported and the one a phone user is looking at; the indicator covers the
Files tab. A separate stall notice for surfaces with no status line was
considered and deferred (see Non-Goals).

## Risks / Trade-offs

- **A reload discards unsaved view state.** → Only reached after an in-place
  attempt fails. Chat drafts are already flushed independently; the loss is
  scroll position and transient view state, which is what the dashboard
  round-trip costs today anyway.
- **Keeping listeners armed on a page that really is unloading.** → The
  listeners are passive and the channel is suspended, so nothing is scheduled;
  an unloading document discards them with itself.
- **The in-flight ceiling could release the flag while work is still
  running**, allowing a second overlapping recovery. → The reconciler's
  freshness and sequence guards already make overlapping applications safe;
  that ordering is what `createStateReconciler` exists for.
- **Preview and Terminal offer no reconnect control.** → Fixes 1 and 2
  remove the causes; a stalled page there still recovers on the next wake-up
  signal, and the Files tab is one tap away. Deferred, not forgotten.
- **`persisted` semantics vary by browser and version.** → The fix removes the
  dependence on that flag for teardown entirely rather than special-casing iOS.

## Migration Plan

None. Client-side behavior change with no stored state, no protocol change,
and no compatibility surface. It ships with the next release; an older client
against a newer hub, or the reverse, is unaffected.
