# Design

## Context

See proposal.md for motivation and scope. The child route is pull-driven; `ReplaySubscription` terminates and drops queued events above 1,048,576 bytes. `LiveBroker` interprets the resulting EOF as unavailability. Its retry cannot replay a missed tail larger than the child's default 256 KiB ring. The Hub's separate 64 KiB fairness correction is already present and must remain.

The demonstrated producer is `ChatAdapter`'s synchronous `safeTasks` publication (`src/chat/adapter.ts:5701`). The analogous validated history publication is around line 1800. Recovery checks stream generation, projection identity, read revision, per-item/worker alias fences and mutation ownership before publishing. These checks must still cover the entire commit. `ConversationProjection.upsert` performs sparse merges and provenance/interaction hooks, then publishes even equivalent effective rows; unlike the history caller, this background loop does not first compare public values. Therefore merely replacing every large publication with resync risks resyncing unchanged recovery forever.

### Evidence and limits

- Offline base `655f404b`: 318 workers with 4,096-byte results, real V2 provider/adapter, real loopback child HTTP SSE route and broker, actively draining. Native stream remains connected. Five of five runs failed: queue `1,044,225 + 4,725 = 1,048,950`, maximum event 4,938 bytes, followed by `unavailable` then `retention-gap`. The lead independently reproduced the same threshold.
- Ordinary live metadata reports passed three of three runs; the same settlement with 2 KiB results passed. The original harness command was `STREAM_SETTLE_LIVE=1 STREAM_HTTP=1 bun test tests/postmerge-stream.test.ts`. The diagnostic harness and logs are retained outside the shipped patch in the task-owned scratch directory `uatu-worker-recovery-verification-20261107/diagnostics/`; durable coverage now lives in `src/chat/adapter.test.ts`.
- Live metadata supplied by the lead: 61 upserts/157,619 bytes, maximum envelope 9,942 bytes; ready at 1,366 ms, unavailable at 8,378 ms, retention-gap at 10,465 ms, zero EventSource errors. A 4,671,009-byte snapshot included 310 background rows totaling 2,164,041 bytes and 394 tool rows totaling 1,963,287 bytes. Repeated topic cycles were observed; current activity generations were 1.
- The live producer, queued byte count, and publication stack were not captured. Compatible signals and aggregate sizes support investigating this seam, not attributing every live cycle to it. No failed phone dismissal request was captured; that issue remains separate.

## Goals / Non-Goals

**Goals:** Confine bulk-publication complexity to a small internal projection/replay interface; preserve a validated synchronous commit and convergence while bounding transport work. Establish durable tests at the actual producer/transport seam.

**Non-Goals:** General event coalescing, new providers, larger buffers, weaker worker/dismissal authority, or changing Hub failure classification to conceal genuine EOF. No new wire event/reason is assumed.

## Decisions

### 1. Prefer atomic bounded bulk publication, with an explicit feasibility gate

Introduce an internal operation for a validated recovery commit, shared by background recovery and applicable history publication. Its interface must hide effective-change detection, bounded publication budgeting and replay invalidation from callers. Ordinary single updates keep their existing path.

Prepare and validate the recovery plan before any subscriber-visible publication. Compute effective changes using existing merge semantics, not raw source equality. Preserve provenance refresh, alias/read bookkeeping, interaction accounting and authority hooks even when public values are equivalent. A publicly unchanged commit emits neither data nor resync.

Commit synchronously under the existing admission/ownership checks; no await is inserted between final validation and completion. No snapshot/subscription callback or subscriber sees a half-committed projection or a prefix of a batch later replaced by resync. Preparation/commit failure must not expose a partially admitted batch or strand publication suppression. Stale results cannot alter the projection, cursor or transport state.

Before adopting the operation, prove these properties in bounded colocated tests, particularly hook/reentrancy and failure behavior. If this cannot be achieved without broad authority changes, stop and revise this design before further production implementation; do not silently switch to asynchronous pacing.

#### Implemented internal interface and feasibility evidence

`ConversationProjection` remains in `src/chat/adapter.ts` (the similarly named `projection.ts` is the browser reducer). Its synchronous `recover(updates, admit?, invalidate?) -> boolean` accepts recovered upserts/removals. It stages a map of row references using the existing sparse merge and permission normalization, invokes provenance hooks while reads still observe the complete old projection, then rechecks admission, mutation revision and replay cursor. Failure/reentrancy leaves the candidate unpublished; a newer native mutation is preserved. The complete map is swapped before publication. Text/fence/fallback bookkeeping retains existing semantics; interaction notifications run after the map and replay boundary are complete. No await or whole-payload clone is introduced. Equal displayed rows still refresh their private references/hooks without a replay event, except for deliberate authority-reset operations.

History stages its exclusion, fallback, superseded-worker and resolved-request removals until the same validated publication as its upserts. Earlier decisions retain the expected row reference so a later native replacement is not retired by an obsolete decision; request-retirement effects run only after a committed removal. The legacy snapshot-seed path retains its no-upsert-fan-out behavior and completes seeding before publishing staged retirements. For native history, mandatory visibility invalidation is part of the prepared batch through `invalidate`: a fitting batch retains the existing ordered row changes followed by its terminal marker, while an oversized batch collapses the entire plan, including that marker, to one resync. There is no subsequent second invalidation publication.

The native complete-replacement branch uses `replace(items, removals?, admit?)`, rather than bypassing the staged source removals. This operation prepares the replacement map with existing seed semantics (not sparse merges with the old map), a fresh text reconciler and fallback-pruning decisions while callbacks still observe the old complete view. Final admission precedes a single swap of the map/text state, origin/fallback pruning and replacement/read-fence revision updates. Required explicit removals and the terminal marker then use the same bounded replay preparation: fitting replacement batches preserve removal-before-marker delivery, while oversized removal batches publish one marker without a prefix. Interaction clearing and reseeding notifications observe the complete committed state. Native coalescer discard occurs only after a successful synchronous replacement, still before a queued flush can run; rejected preparation must not discard buffered native updates. This is an internal extension, not a provider mutation or new wire contract.

A deliberate remove followed by an upsert of the same existing row is an authority reset, even if its final public value is equal or only omits fields. Fitting batches preserve that ordered reset pair instead of folding it into a sparse upsert, because browser merges could otherwise retain revoked child/usage/control fields. Final-row upserts and the first required removals retain their plan order; oversized reset plans use the same single-resync path. Ordinary unchanged reads without a reset remain silent. Existing provider authority assertions requiring the explicit fitting removal are preserved, not weakened to accept an upsert-only result.

`ConversationReplay.prepareBatch(payloads) -> publish` consumes an iterable without advancing replay. Candidate events are limited to the 1 MiB cap minus a 64 KiB reserve, counting 256 bytes of additional framing allowance per event. Once oversized, candidate references are discarded. The returned one-shot synchronous publication refuses a superseded cursor and emits either ordered events or one existing-format resync; it returns the final emitted event (undefined for an empty batch), preserving `replace`'s existing return contract. A fitting batch is also checked against each subscriber's preexisting backlog: a behind subscriber gets an explicit resync rather than a batch prefix. Ring retention and ordinary stalled-consumer termination are unchanged. Snapshot handoff queues owed replay before invoking its callback, so callback-time live publication cannot precede replay; failed callbacks release their subscriptions.

The colocated regression failed twice before product edits. Focused replay contracts now pass for failure cleanup, revoked admission, hook-time snapshots, reentrant mutation, private proof refresh, no-op cursor stability, no partial oversized batch, preexisting subscriber backlog and post-snapshot convergence. The real HTTP regression also checks three unchanged rereads and an exactly-once final native worker report; the 2 KiB and ordinary-report controls require no resync, while 4 KiB settlement requires the intentional conversation-rewritten resync. This evidence establishes the narrow interface's feasibility, not a claim that independent implementation review is complete.

Independent review additionally exposed early history removals/double invalidation and lost remove/reinsert authority resets. New actual `adapter.history` regressions first failed on mixed preparation/admission rejection and oversized history exclusion, then passed after staging these changes together; an additional visibility-boundary case verifies a single cursor advance and three unchanged rereads. The direct reset regression first reproduced upsert-only publication; fitting reset pairs now pass it and all 19 existing projected-source-authority eviction cases. These checks do not establish the live incident's exact producer path.

A subsequent full-suite check found that complete native replacement also had to carry its fitting fallback-removal events, not just the terminal marker. The original provider assertion remains unchanged. A new actual native undo/history regression reproduced the missing removal and now checks removal-before-marker plus three convergent rereads. Replacement preparation/admission failures, fresh text reset, replacement-fence invalidation and oversized removal plans are covered at the projection/replay interface. The complete native reversible replacement group and all 19 projected-source-authority cases pass together after this correction.

### 2. Choose ordered data or one explicit resync before fan-out

For a nonempty effective batch that fits a conservative byte budget within existing replay/subscriber limits, publish its ordered contiguous events after commit. Include frame/control overhead in budgeting and cover subscribers with preexisting backlog. Existing stalled consumers may still terminate at the unchanged cap.

For an oversized batch, publish one existing-format `conversation-rewritten` resync after the complete state commit, rather than publishing a prefix, overflowing, and discovering EOF. This denotes replacement of the client's incremental view by an authoritative snapshot, not a provider history mutation. Existing event validation accepts this reason and the client routes resyncs to read recovery; do not invoke provider rewrite operations or use destructive projection replacement merely to obtain the signal. Compatibility tests must confirm this read-only interpretation end to end. If they fail, stop and revise the plan rather than introducing an unreviewed reason or revision bump.

Keep only a byte-bounded candidate event buffer; once oversized, discard candidate payload copies and retain only what is needed for the committed projection and one resync. Do not relocate an unbounded backlog to another queue. Cursors crossing the withheld batch must encounter explicit resync, never a silent sequence gap or falsely successful replay. A snapshot taken after commit names the new boundary; reattachment from it receives subsequent native updates normally. At most one invalidation belongs to one effective bulk commit, and three consecutive unchanged rereads after reattachment must emit none.

### 3. Retain transport fairness and safety semantics

Do not change the child 1 MiB stalled-consumer limit, retained-ring bounds, Hub 64 KiB yields, subscriber refcounting, cancellation or per-topic isolation. Preserve ordered normal terminal/working updates and new native updates before/after the bulk commit. Snapshot recovery is read-only: no prompt resend, automatic worker action, dismissal retry or generation-only dismissal acceptance. Shared activity and account-private dismissal invalidation remain distinct.

### Alternatives considered

- **Yield inside recovery's current loop:** rejected as a small patch. New native events, source revocation, disposal and projection replacement could interleave after admission and before the batch finishes. A serialized paced-commit architecture would need a separately reviewed ownership model.
- **Raise/remove caps or enqueue the full batch elsewhere:** rejected; moves the threshold or makes stalled memory unbounded.
- **Coalesce arbitrary conversation events or suppress EOF warnings:** rejected; loses ordered predecessors or hides genuine upstream failures.
- **Always resync recovery:** rejected; equivalent recovery currently reaches upsert, so this can produce the same user-visible recovery loop. Effective no-op detection and post-snapshot convergence are required, not optional optimizations.

## Risks / Trade-offs

- [Bulk resync requires an extra snapshot read] → Reserve it for effective oversized commits, preserve retained UI content and test convergence with repeated reads; source-read latency is not fixed by this change.
- [Public equality hides changed private proof] → Retain bookkeeping/hooks and test stronger/newer worker evidence, source revocation and dismissal guards independently of emitted bytes.
- [Publication budgeting misses buffered backlog or replay handoff] → Exercise real HTTP and replay cursors, retain the cap, and explicitly invalidate an unreplayable batch rather than promise complete replay.
- [A resync reason carries additional UI behavior] → Verify existing client validation, projection handling and UI recovery before adopting it; no assumed compatibility exemption.
- [Synthetic clustering differs from production timing] → Report the proven defect separately from live attribution; manual verification remains a later, separately authorized step.

The independent code/design-risk review favored an atomic validated batch over await-based pacing. Fresh, separate Sol Medium implementation reviews covered Standards and Spec. Spec review identified the early history publication and authority-reset defects described above; both were corrected and re-reviewed clean. Standards review, including the final architecture clarification, is also clean. These inspection results do not substitute for the remaining full-suite checks.

## Migration Plan

Compatibility checks confirm the existing `ChatResyncEvent` schema and validator already accept `conversation-rewritten`. The child writes it as a terminal SSE resync; the Hub forwards it and detaches only that topic without an outage retry. The client retains its projection, fetches a snapshot and reattaches from the snapshot cursor. The resync envelope's cursor is not acknowledged as applied data. No provider mutation, route, persisted format or wire shape changes; Hub API revision 14 and workspace revision 35 remain unchanged. Focused client, lifecycle, route and broker checks passed, as did the real-Hub browser regression preserving content, draft, reading position and one EventSource.

No deployment or restart is part of this change's current authorization. After implementation and review, verify route/event/reason and API revision compatibility; update affected architecture documentation. No stored-state migration is intended. A later approved deployment can use the normal update/rollback process without changing personal state or credentials. Only after explicit deployment approval, verify phone and desktop topic convergence and preservation of drafts/scroll position; record dismissal failures separately instead of expanding this fix.
