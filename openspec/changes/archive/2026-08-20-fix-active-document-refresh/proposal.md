## Why

The active preview can remain stale when its file changes in the same watcher debounce batch as another path because one last-writer-wins `changedId` is used as the only preview invalidation signal. The same event-only signal cannot reconcile content changed while the live event stream was disconnected.

## What Changes

- Detect active-document staleness from the previous and incoming document snapshots instead of relying only on the batch's Follow candidate.
- Reload the active preview after multi-file save bursts and after a fresh state snapshot reveals a missed active-file change.
- Prevent an older document request from replacing a newer selection or refresh.
- Preserve the existing Follow selection rules and bounded watcher debounce behavior.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `document-watch-index`: Strengthen active-preview freshness across coalesced watcher events, connection gaps, and overlapping document loads.

## Impact

- Affects watcher state handling, active-document refresh decisions, preview request ordering, and focused unit/E2E coverage.
- Does not change the workspace API schema, watcher debounce timing, or Follow's selection policy.
