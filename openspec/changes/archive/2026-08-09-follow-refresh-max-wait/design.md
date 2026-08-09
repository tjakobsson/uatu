# follow-refresh-max-wait — design

## Context

`scheduleRefresh` (src/server/watch-session.ts) clears and re-arms a single 150 ms `setTimeout` on every watcher event and keeps only the last nominated `changedId`. Trailing debounce without a max-wait means continuous sub-150 ms event streams defer `refresh()` unboundedly. The refresh is the sole driver of index rescans, SSE payloads, follow jumps, and in-place preview reloads.

## Goals / Non-Goals

**Goals:**
- Bounded staleness: at most ~2 s between the first unprocessed event and the refresh that reflects it, regardless of event cadence.
- No change to quiet-path behavior (single burst still refreshes once, ~150 ms after it ends).

**Non-Goals:**
- Changing the debounce interval, `awaitWriteFinish` tuning, changed-id nomination (last-writer-wins stays), or anything client-side.

## Decisions

1. **Deadline timestamp, not a second competing timer.** On the first event of a batch record `batchStartedAt`; when re-arming the trailing timer, clamp the delay so it never fires later than `batchStartedAt + MAX_WAIT` (2000 ms). One timer, no race between two timeouts. Alternative — a parallel max-wait `setTimeout` — rejected: two timers firing near-simultaneously would need dedup guarding for no benefit.
2. **`MAX_WAIT = 2000 ms` as a module constant.** Large enough that normal bursts (save storms, git checkout) still coalesce into one refresh; small enough that a streaming agent's UI never looks frozen. Not configurable — this is a robustness bound, not a tunable.
3. **Refresh-in-flight behavior unchanged.** If a refresh is already running when the deadline fires, the existing scheduling/refresh interplay applies as today; the cap only bounds timer deferral.

## Risks / Trade-offs

- [More refreshes during heavy churn than before] → That's the point; each is the same debounced full rescan the quiet path runs, at most one per 2 s under sustained load.
- [Timer clamping bug reintroduces starvation or double-fires] → Unit test drives a fake-clock event stream at 100 ms cadence and asserts refresh count and timing bounds.

## Migration Plan

Single small PR. Rollback = revert.

## Open Questions

None.
