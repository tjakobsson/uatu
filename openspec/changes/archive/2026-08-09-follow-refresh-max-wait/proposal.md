# follow-refresh-max-wait

## Why

The live-reload engine debounces watcher events with a trailing 150 ms timer that resets on every event, so sustained file churn faster than the debounce postpones the rescan — and with it every follow-mode jump and preview reload — until the first quiet gap. An agent streaming steady writes can starve the UI indefinitely. Found during the follow-mode sanity review in the 0.5.0 debt exploration; deliberately tiny.

## What Changes

- `scheduleRefresh` in the watch session gains a max-wait cap: a refresh is guaranteed to fire no later than a bounded interval (2000 ms) after the first unprocessed event, even while events keep arriving and resetting the trailing debounce.
- Everything else stays: the 150 ms trailing debounce, the `awaitWriteFinish` stability settings, and the last-nominated `changedId` semantics.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `document-watch-index`: the "keep the indexed view and preview current" requirement gains a bounded-staleness guarantee under sustained event streams.

## Impact

- `src/server/watch-session.ts` (`scheduleRefresh`: one extra timestamp/timer), plus a unit test simulating a sustained event stream.
- No API, payload, client, or spec-selection changes; follow-mode rules untouched.
