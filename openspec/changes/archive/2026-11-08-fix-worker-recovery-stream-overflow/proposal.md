# Proposal

## Why

An actively consumed child conversation stream can overflow when validated background recovery publishes hundreds of ordinary-sized worker updates synchronously. The offline reproduction reliably produces the observed `unavailable` followed by `retention-gap`; the exact producer responsible for the live incident remains unproven.

## What Changes

- Make validated bulk recovery publication bounded without treating its own synchronous burst as a stalled consumer. Preserve ordered incremental delivery for small changes; permit explicit conversation-scoped snapshot recovery for oversized batches.
- Require oversized recovery to converge: a fresh post-commit snapshot and unchanged rereads must not generate a resync loop.
- Preserve source/admission fences, atomic projection visibility, normal native update ordering, the 1 MiB child subscriber cap, and existing genuinely stalled-consumer termination.
- Add durable colocated regression coverage through the real provider, adapter, child HTTP SSE route, and broker; retain the 2 KiB control and ordering/lifecycle controls.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-agents`: validated recovered conversation state is published atomically and converges after bounded snapshot recovery without weakening activity or mutation authority.
- `hub-live-stream`: healthy conversation subscribers survive clustered bulk recovery through ordered data or explicit topic resync, without overflow-induced unavailability or interruption of other topics.

## Impact

The intended seam is `ConversationProjection`/`ConversationReplay` bulk publication and its validated `ChatAdapter` recovery callers, especially the `safeTasks` loop. Child route and broker behavior are exercised end-to-end; the already-corrected Hub 64 KiB delivery pacing is not the target. No new dependencies, routes, persisted formats, authentication changes, or automatic API revision bump are proposed; implementation must verify compatibility against the existing contracts.

### Non-goals and authorization

No dismissal revision/generation adjustment, activity-evidence relaxation, worker-status reinterpretation, personal-state repair, or phone dismissal fix. No deployment, live instrumentation, restart, commit, push, or PR publication is authorized by this plan. This proposal is planning only; implementation requires a subsequent apply request.
