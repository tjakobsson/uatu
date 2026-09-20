## Context

See proposal.md — Why. The mechanics on a hub-served page today:

- The hub's live broker learns a session stopped through `onSessionChange` and fails every upstream for that workspace as `unreachable`; each subscriber gets a topic-scoped `unavailable`. The document consumer (`shell/events.ts`) answers `unavailable` with `liveChannel().invalidate()`, and `shell/connection.ts` renders that as `Reconnecting`. The broker retries the upstream on backoff, and every attempt fails at once while `isRunning` is false, so the page stays there until the session is started somewhere.
- The same stream's `activity` topic delivers `{ running: false }` for the current workspace. `shell/hub-nav.ts` already folds that into its list and darkens the switcher chip's dot (`chipDotClass`). Nothing else consumes it.
- The activity topic reports `running: false` for an unreachable child of a running session as well (spec: "A workspace whose child is unreachable SHALL be reported as not running rather than withheld"). `GET /api/hub/state`, which `hub-nav` already reads on hub-ness probe, replacement streams, menu open, and page-cache restore, reports `running` from the hub's session table — the authoritative answer.
- The indicator is already an action: `requestManualRecovery()` in `shell/live.ts` tries in-place recovery and reloads after `MANUAL_RECOVERY_WINDOW_MS`. On a stopped session that reload lands on the hub's 503 session-unavailable page, which is the only Start offer today.
- The switcher menu's entries for *other* stopped workspaces already Start on click (POST `/api/hub/sessions/<id>/start`, then navigate; a locked-credential refusal redirects to the dashboard). The current workspace's row is inert.
- The start endpoint is idempotent for a running session (`sessions.start` on a running workspace answers `{ running: true }`).

## Goals / Non-Goals

**Goals:**
- Name the state truthfully: `Stopped` when the hub says the session is not running, `Reconnecting` otherwise.
- Offer the start in place, on the control the user already reaches for, and return to `Connected` without navigation.
- Derive the stopped fact from what the page already receives; add no hub API, no new stream topic, no polling.
- Keep the indicator's contract testable without the DOM: the state translation stays a pure function.

**Non-Goals:**
- Changing what `Reconnecting` means for a running session whose child is momentarily unreachable, or the broker's retry policy.
- A stopped-state notice bar, overlay, or page swap (alternatives the user declined; the in-place control is the whole point).
- Auto-starting a stopped session. A stop is a deliberate act; the page reports it and offers the reversal.
- Direct `uatu serve` pages, chat and terminal surfaces' own interruption handling, and UatuCode Desktop.

## Decisions

**The stopped fact is owned by hub-nav and published to the shell as one boolean.**
`hub-nav.ts` is the only shell module that knows the current workspace id, the hub list, and the activity map, and it already reconciles them. It gains a derived `currentSessionRunning: boolean | null` (null until the hub-ness probe answers, and always null on a non-hub page) and a tiny subscription (`onCurrentSessionRunning(listener)`), recomputed wherever `updateChip()` runs today. `connection.ts` subscribes and folds it into its display. Alternative: have `events.ts` inspect the activity topic directly — that duplicates the activity/list reconciliation hub-nav already does, and `events.ts` has no notion of the current workspace.

**Stopped is asserted from the hub's list, not from activity alone — re-read on a bounded schedule while the two disagree.** Activity `running: false` for the current workspace triggers `refreshHubState()` (the existing routine); the published fact is what the list says about the current workspace, kept apart from the folded list. This makes the page distinguish a stopped session (list says not running → `Stopped`) from an unreachable child of a running one (list says running → stays `Reconnecting`). Activity `running: true` clears the fact immediately without a read: the feed only reports running for a session in the hub's table, and the document topic's `ready`/`data` confirms the channel right after.

Found while implementing: **the list lags a stop.** The hub stops a session by terminating the child and only then removing it from its session table. The child's activity upstream fails first, so the feed reports `running: false` (spec: an unreachable child reads as not running) while `/api/hub/state` still says running; when the table is updated the feed's value is unchanged and nothing more is sent. One read in that window keeps the page on `Reconnecting` forever. So while the stream says not running and the list says running, the list is re-read on a short backoff (`STOP_RECONCILE_DELAYS_MS`: immediately, then 0.5 s, 1 s, 2 s, 4 s, 8 s) until it says stopped, the stream says running again, or the schedule runs out — which is the unreachable-child case, where `Reconnecting` is right and the next reconnect, menu open, or page-cache restore reads again. An answer already on its way counts as a read. During that window the chip keeps the stream's word (dot off) rather than blinking live from a stale list. Alternatives considered: have the broker re-emit the activity value on a session-table transition (a hub change, and the client would still need to handle a read that was already in flight); reorder the hub's stop so the table is updated before the child is terminated (changes what a failed backend stop leaves behind); trust activity alone (wrong on the unreachable-child case, and would offer Start on a running session).

**Display precedence: `stopped` overrides `reconnecting` and `connecting`, never `live`.** `connection.ts` keeps `connectionRawState` for the channel's status and adds a `sessionStopped` flag; `syncConnectionDisplay()` shows `Stopped` when the flag is set and the channel is not confirmed live. A confirmed-live channel with the flag set cannot last (the child is the thing that confirms it), but if it happens `Connected` wins, because it is backed by applied state. The translation function grows a second input and stays a pure export, so the existing `connection.test.ts` pattern covers it.

**Activation while stopped starts; it does not reconnect.** The click handler branches: `Stopped` → `startCurrentSession()`; otherwise `requestManualRecovery()` as today. `startCurrentSession` lives in hub-nav (it owns the hub API calls and the unlock hand-off) and is shared by the current menu row. The control shows an attempt under way (`is-attempting`, `aria-busy`) for the start too, and refuses to start twice. On a 200, nothing else is done on the client: the hub's `onSessionChange(running: true)` reopens the upstreams, the document topic delivers state, `confirm` makes it `Connected`, and activity `running: true` clears the flag. If no `live` arrives within the manual-recovery window after a 200, the indicator falls back to `Reconnecting` with the normal reconnect control — the child did start, so the usual recovery applies. On a non-200 the error message renders in a small line beneath the indicator (new `#connection-error`, `role="alert"`, hidden by default) and the control re-enables. A locked-credential message (`startFailureNeedsHubUnlock`) navigates to the dashboard, as the switcher already does. Alternative: route the start through `requestManualRecovery` with a pluggable strategy — more indirection than two call sites justify.

**The manual-recovery reload is suppressed while stopped.** `requestManualRecovery`'s timeout path checks the published fact before calling `deps.reload()`: a reload on a stopped session only reaches the hub's Start page, which the page now offers itself. This covers an attempt that was in flight when the stop happened. The existing test seam gains the fact as an injected reader.

**Current row in the switcher menu.** `renderMenu()` drops the `workspace.id !== currentId` guard on the Start behaviour; for the current workspace the success branch does not navigate (the page is already there), it just leaves the stream to recover. The row's state text follows the same `starting…` / `unlock in Hub…` words.

**No hub or wire change.** The fact rides the existing activity topic and state endpoint; the start uses the existing endpoint. No API revision bump, no contract change.

## Risks / Trade-offs

- [The hub list read after activity `running: false` fails or is slow] → The indicator stays `Reconnecting` until a read answers; the reconcile schedule re-reads while the stream and the list disagree, and the next replacement stream, menu open, or page-cache restore reads again after that. Never a wrong `Stopped`, at worst a late one.
- [A stop that takes longer than the reconcile schedule (about 15 s) to reach the session table] → The page stays `Reconnecting` until something else reads the list. Stops of the local-process backend settle within its termination grace, well inside the schedule.
- [Activity `running: false` from an unreachable child of a running session] → The list says running, so the page stays `Reconnecting`; no Start is offered. Covered by a unit test on the derivation.
- [Start answers 200 but the child fails to come up] → After the recovery window the indicator returns to `Reconnecting`; the hub's own session error is visible on the dashboard. The page does not loop on start.
- [Two devices press Start at once] → The endpoint serialises on the workspace's lifecycle queue; the second answers `running: true`. Both pages recover from the stream.
- [A stop and a start within one broker linger window] → The upstream may still be `failed` when `running: true` arrives; the broker's `onSessionChange` already reopens failed upstreams. No client change.
- [Indicator hidden with a collapsed sidebar] → Existing trade-off of the indicator's placement; the switcher row offers the same start, and touch mode shows the sidebar as the Files tab.
