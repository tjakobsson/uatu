## Context

The watcher coalesces each event burst to one `changedId`. The client currently treats that value both as the Follow candidate and as the only reason to invalidate the active preview. Every state snapshot already contains `DocumentMeta` entries with `mtimeMs` and `kind`, while ordinary rendered/source document loads have no stale-response guard. See `proposal.md` for motivation and the delta spec for required behavior.

## Goals / Non-Goals

**Goals:**

- Separate Follow nomination from active-preview freshness without changing the state API.
- Let ordinary state snapshots repair preview staleness after coalesced events or reconnection.
- Ensure only the newest relevant rendered/source load can update the preview.

**Non-Goals:**

- Replacing the existing watcher debounce or latest-change Follow policy.
- Serializing server scans or adding SSE replay and event IDs.
- Detecting timestamp-preserving content replacement through content hashing.
- Changing Review mode's suppression of automatic document refresh.

## Decisions

### D1: Derive active-document freshness from both event identity and snapshot metadata

Before applying an incoming state snapshot, compare the selected document in the previous roots with the same document in the incoming roots. Treat it as stale when its `mtimeMs` or `kind` differs. Continue treating an exact selected-ID/`changedId` match as stale so a directly observed write still reloads when filesystem timestamp precision does not expose a metadata difference.

This uses state the client already receives and makes initial/reconnection snapshots self-healing. Carrying every dirty path in a new `changedIds` API would solve debounce loss but not connection gaps, while reloading after every state event would add avoidable rendering and repository-facts work.

### D2: Keep `changedId` dedicated to event-driven selection

Continue passing the representative `changedId` to Follow selection and search-result staleness logic. Preview invalidation becomes a separate decision based on D1. This preserves the four Follow rules and avoids a workspace API revision change.

### D3: Guard rendered/source loads with a monotonic client generation

Assign each ordinary document load or cached payload application a generation and capture the requested document, view, and layout. After asynchronous fetch and decoding, update caches and the DOM only if the load is still the newest generation and still matches the active selection, view, and layout. A newer in-place refresh of the same document must supersede an older one as reliably as a selection, view, or layout change does.

A generation guard is preferred over relying only on request cancellation because cancellation can race with an already completed response and is not itself proof that a result is still relevant. Existing Diff request guards remain authoritative for Diff mode.

### D4: Test freshness decisions independently from browser timing

Cover metadata comparison and event-identity fallback in unit tests. Add browser coverage for an active-document write followed immediately by a second watched-path write, replacing the existing reload workaround where practical. Cover out-of-order ordinary document responses with a controlled test rather than relying on network timing.

## Risks / Trade-offs

- [A content write preserves both timestamp and kind and its path is not the representative event] -> The snapshot cannot distinguish it without hashing; retain direct-event fallback and leave content revisions for a future API change if real filesystems expose this case.
- [A server scan completes out of order] -> Fetching the document reads current disk content, and periodic reconciliation remains; server refresh serialization is a separate consistency improvement.
- [A legitimate same-document load is discarded after view or selection changes] -> Compare the captured request context before cache and DOM mutation, and cover navigation plus in-place refresh cases.

## Migration Plan

No data or API migration is required. Ship the client freshness comparison, request-generation guard, and regression coverage together. Rollback restores the prior event-only invalidation behavior without affecting persisted state.
