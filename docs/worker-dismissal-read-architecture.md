# Worker dismissal reads

The Hub owns saved dismissals, not OpenCode or the browser. Its private store
persists marks by authenticated account, workspace, conversation and execution.
Both GET and POST on `/s/{workspace}/api/personal-worker-dismissals` reconcile
fresh authoritative worker evidence before returning personal state.

## Evidence and persistence

The Hub requests complete worker-only evidence from the workspace child's
authenticated `/api/chat/conversations/{id}/worker-evidence` route. The child
validates execution identities, source coverage, activity and dismissibility;
incomplete or contradictory evidence cannot authorize dismissal. The compact
response contains no transcript text, tool output or personal marks.

The Hub serializes admission, evidence reconciliation, revision checks and atomic
store writes under its lifecycle/store coordination. Positive activity retires
saved marks, including activity observed during an admitted disk write. A GET
can therefore fail because evidence is unavailable, persistence fails or capacity
is exhausted—even when the saved file is readable. A batch is all-or-nothing;
a conflict requires a fresh read and user review, not an automatic mutation retry.

This is not a cross-process transaction over OpenCode and the dismissal file.
The Hub's locks do not freeze native state from the child's evidence capture
through persistence. Source guards and activity observations protect their own
bounded lifetimes; they do not establish a native lock spanning the save.

The child's covered-history read defaults to a 25-second budget. The Hub allows
30 seconds for evidence delivery, including a transport/publication margin.
These are scoped budgets, not an end-to-end latency guarantee or permission to
retry conditional mutations.

## Report-free outcomes require unchanged observations

Explicit parent reports and historical child-outcome inference are different
authorities. A report names a result; a bare child idle does not. Complete,
owned child history may infer a terminal outcome only when a typed idle and
execution boundaries uniquely identify the launch. Hidden and foreground
same-child invocations still compete; requested child identity is veto-only,
never permission to read that child or Stop it.

`opencode/v2/session-changes.ts` owns the conservative publication rule:

1. A source captures the parent's session-change counter before its first native
   parent request, and each child's counter before that child's first ownership
   or history request.
2. Complete native history, session-record, inbox and active-membership
   observations initialize their facet without advancing the counter. A later
   differing observation advances it. Native stream deltas advance it when new
   or changed; identical already-known observations do not.
3. Observation order controls this counter, not request order. A differing reply
   from an older or ownerless request can advance it. This is a conservative
   denial, not permission for that reply to replace a newer cache entry.
4. At final synchronous publication, `projectInferredOutcome` compares both
   captured counters for each report-free inferred worker. A mismatch withholds
   only that outcome: the row becomes Unresolved (`status: "running"`,
   `stateUncertain: true`, `outcomeWithheld: true`) and is nondismissible.

Counter mismatch does not fail the whole parent read or start an automatic
retry. Parent history can finish while a child streams; historical outcome
inference needs an unchanged observation window. Ordinary new output can
therefore withhold inference even when it does not change the old idle itself.
This trades selective inference availability for a small, auditable rule.
The unchanged window includes the parent as well as the child. A later quiet
read needs an independent trigger; withholding alone does not schedule it.

Explicit parent reports, independently verified activity and Stop authorization
retain their own contracts. The projection supplies no result, ownership or
Stop proof. The source guard's `isCurrent`/`retain` still fence ownership,
activity, generation, cancellation and lifetime; outcome projection is a
separate per-item operation, also applied by the adapter at final publication.

The counter store retains digests, not native bodies or an observation log:
four complete facets and at most 256 delta facets per session. Its normal
capacity is 8192 sessions; live read references pin their sessions until release,
so eviction cannot reset a counter beneath a consumer. Delta eviction is
conservative: observing an evicted identity again can advance the counter.
Exact native execution-proof replay is recognized through the bounded negative
execution ledger, including after subscription retirement; replay grants no
new occurrence, ownership, activity or Stop authority.

## Identity, activity and cache authority remain separate

A shared child session, aggregate session outcome or matching description cannot
settle an arbitrary worker. Explicit report assignment still needs an attributable occurrence.
Stored report timestamps are delivery clocks, not execution-end clocks. Even
two earlier idle boundaries cannot identify a delayed report's run. Correlating
an otherwise ambiguous reused-child report requires a unique exact match to a
terminal child response inside a proven owned execution interval. Missing or
duplicate response matches stay uncorrelated; names and delivery order cannot
supply that proof. Missing clocks, ties, straddling windows and hidden or
overlapping candidates remain conservative.

Cold Working requires fresh owned history, active inventory and an unambiguous
execution, independently of Stop readiness. Scoped observed starts and ends
remain veto-only continuity after reconnect; reverts cannot erase them. A newer
inactive inventory or relevant execution/history/launcher counterproof can
withdraw cold activity through publication without inventing an outcome or end
timestamp. Independent live controls keep their separate authority.

Native request ordering still matters for these activity guards and reusable
history. Warm transcript entries retain bounded native visibility metadata from
load registration through eviction. Entering a staged boundary filters complete
raw history; leaving or changing it invalidates reuse because content may have
been removed. Relevant native inbox reports can retire stale parent-history
reuse before SSE. Pending entries cannot install over their replacements.
Invalidation starts no IO and grants no ownership, result or Stop proof.

`outcomeWithheld: true` is also a dismissal barrier for Unavailable and Ended
activity. Sparse updates cannot erase it. A fresh authoritative terminal result
can replace or clear it; weaker cached rows cannot turn it into permission to
dismiss. Withdrawal of cached report-free outcomes requires the same
row/task/type/child and intersecting proven execution aliases, not just a shared
child. Explicit reports keep precedence.

## Browser consistency and recovery

Requests and responses use `no-store`; the browser keeps only an in-memory
projection. Failed reads discard saved marks locally so workers remain visible.
Selection and connection generations fence late responses. Conditional revisions
protect mutations; a conflict refreshes state without resubmitting a dismissal.
Account/workspace-private live invalidations trigger coalesced reads, not shared
dismissal payloads. Confirmed saves, disk reload and cross-device convergence
remain owned by the Hub.

There is no autonomous dismissal-read retry loop. Reconnect, selection changes,
private invalidations and qualifying identity recovery can request another read.
The browser warning does not distinguish worker-evidence failures from saved
state failures; the counter rule does not diagnose every reported save error.

Property verification compares results, report fields and activity with cold
final-state recovery or requires Unresolved. It allows extra cautious warnings,
but never unsupported Stop or dismissal. Separate native-evidence checks retain
observed revocations even when a revert removes their cause from final history.
The reference does not replay earlier reads or cache invalidations, copy published
certainty flags, restore Stop or suppress valid activity. Quiet recovery controls,
randomized concurrency, the attempt bound, 10,000 seeds and full CI remain required.

See [the dismissal protocol guide](../api/guides/worker-dismissals.md) for
evidence bounds, source-consistency rules and batch mutation semantics.
