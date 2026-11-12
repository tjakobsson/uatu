# Worker dismissal reads

The Hub owns saved dismissals, not OpenCode or the browser. Its private store
persists marks by authenticated account, workspace, conversation and execution.
The workspace-shaped `/s/{workspace}/api/personal-worker-dismissals` route is
handled by the Hub under the existing session authentication and lifecycle lock.

## A GET is reconciliation, not just a disk read

Before returning personal state, the Hub requests complete worker evidence from
the workspace child's authenticated `/api/chat/conversations/{id}/worker-evidence`
route. The child validates current identities and activity; incomplete or
contradictory evidence cannot authorize dismissal. The Hub reconciles that
evidence with stored revisions, durably retiring marks when positive activity
requires it. A GET can therefore fail because evidence is unavailable, persistence
fails, or capacity is exhausted—even when the saved file itself is readable.

The child's covered-history read has a default 25-second budget. The Hub allows
30 seconds for evidence delivery, including a five-second transport/publication
margin. The former ten-second Hub deadline incorrectly rejected otherwise valid
reads before the child's budget expired. This alignment does not bypass evidence
validation or retry conditional mutations.

Covered reads do not require a quiet child: later assistant output leaves an
unchanged historical idle outcome usable. Changes to consumed idle records,
execution boundaries, removals and reverts still fence publication. A fresh
scoped child record that reveals a changed revert boundary revokes the earlier
outcome source even before the corresponding native event arrives.
Warmed parent history has its own scoped native-inbox cutoff even before a
worker consumer exists. A relevant report not present in that transcript denies
reuse; actual native report content on the requested reread supplies the result.
Observation starts no IO, cannot retire newer loads, and grants no Stop proof.
For an entry still loading, a later parent-scoped positive report retires its
installation before stale raw history can warm the cache. Existing waiters are
not cancelled; replacement entries and older-request ordering remain independent.
Unknown launcher scope is denial only, never a report/result grant.
Earlier terminal proofs remain exact-replay identities after later terminals,
within the existing serialized execution-ledger budget. Retirement preserves
only their negative continuity, not occurrence/ownership/Stop bindings. The
128-terminal per-child ceiling fails closed with sticky recovery-only state;
changed proof identity, clock or payload still supplies genuine counterproof.
This observation includes a scoped record arriving while the first visibility
lookup is pending; a late overlapping response cannot overwrite that boundary.
An intermediate stage requested after the child's consumed owned visibility can also
veto a captured outcome after a newer clear reply. Bounded consumed suffix IDs
preserve retained-prefix precision without cache authority, extra IO or Stop
grants. Later dependencies and the newer native baseline remain separate.
The first pending child transcript also registers a provisional cutoff. Reversed
ownerless stage/clear observations retain only a deny boundary, checked against
the returned transcript before positive outcomes are folded. Prefixes remain
usable; unknown/conflicting positions abstain without replacing an owned view.
Provisional denial is rechecked after the owned visibility lookup and before its
slot is replaced; a stage arriving during that await still fences the old idle.
Retained start identities, not only the greatest start clock, preserve an
intervening-execution veto without a qualifying prior end. A later start cannot
authorize an unchanged earlier idle; qualified new intervals and a single delayed
first start retain their existing progress rules.
After capture, overlap ordering uses the actual owned lookup request start,
carried with its native observation. Sampling the later global clock would lose
stages requested during that await but delivered only after capture.
The consumed transcript's actual load cutoff is retained separately: a stage
requested during that load can still deny publication after lookup and capture.
Older-than-load requests and compatible initially staged records do not become
new transitions merely because their responses arrive late.
The compatible initial-stage exemption includes native request provenance, not
just a matching boundary ID. Re-staging that ID after a restore is a distinct
observation when its request is newer than the consumed raw load; it still fences
captured stale outcomes, without granting authority or initiating IO.
Initial verification stages qualify the consumed raw transcript too. When an
initial stage hid an idle and later owned visibility clears/changes, the requested
fold revalidates raw child history and then owned visibility, unless a prior clear
already preceded that actual raw load. Only actual current raw content can
discharge commit-versus-restore uncertainty; a new record alone cannot do so.
A consumed immutable raw array keeps its existing load-owned
visibility observation in weak metadata, so a parentage-cache hit and subsequent
cache invalidation cannot erase a warmed stage's outcome qualification.
Positive inbox facts requested after an owned request's start can veto the
consumed empty view despite overlap. Relevant new digests and ordered overflow
are denial only; empty/older/replayed facts do not replace the owned baseline.
Known retained prefixes need no reread. This uses the same deadline and adds no
IO on observation, owned baseline, result clock or Stop authority.
Session-record reads carry only their explicit consuming fold as an overlapping
owner. Ordinary getSession/list/create reads cannot claim all collecting folds
and revoke a page that consumed a newer boundary. Genuine later nonoverlapping
boundary changes still revoke every dependent source; first-visibility lookup
counterproof remains covered.
Later nonoverlapping history reads also fence changed or missing idle evidence;
an unchanged null revert boundary does not preserve a removed outcome. A
conflicting overlapping response cannot revoke the later consumed source or
authorize its own stale evidence. Outcome-free history used to recover activity
still retains a terminal-event fence when no native occurrence was retained.
Staging a parent revert hides rows without removing their native occurrence
evidence from child-outcome attribution. A hidden overlapping launch therefore
still prevents an ambiguous outcome from authorizing dismissal of a visible row.
Overlapping foreground invocations of the same owned child also withhold outcome
attribution without adding worker rows.
Pending/running calls requesting an already independently verified child also
act only as vetoes; they cause no requested-child ownership checks or reads, and
a reported accepted child overrides requested intent. Changes to the consumed parent
launch inventory revoke dependent outcome sources; ordinary parent output and
unchanged launcher replays do not require a quiet window.
Requested-child veto facts remain in that baseline with reported-child
precedence, so repeating the same pending snapshot does not restart a covered
history/evidence read. Changed facts still fence the old source.
Parent-launch baselines are registered before the first ownership lookup.
The baseline belongs to the consuming read, not every collecting read for that
parent. Shared transports and visible/full folds preserve that owner; older
overlapping responses cannot overwrite a newer inventory. While the initial
parent response is pending, the read buffers launcher counterproof and compares
it with its own eventual inventory. Exact replays coalesce; the buffer is capped
at 256 facts / 64 KiB of serialized UTF-16 evidence. Saturation withholds dependent
history authority, without granting ownership or invalidating unrelated controls.
Changes observed during that await remain deny-only counterproof until outcome
or activity authority is used; unverified intent grants no ownership, child
read or Stop authority, and does not itself invalidate unrelated controls.
Fresh parent-history reads provide the same scoped counterproof before SSE:
nonoverlapping reads can revoke an older launch inventory, while conflicting
overlapping responses cannot supersede later consumed evidence. Native read
order survives transport reuse.
The shared native-history boundary also observes idle counterproof from direct
child history, accounting and inspection reads; it is not limited to a parent
worker fold.
If a parent's first child response is still pending, an ownerless reversible
history read can fill that registered dependency's existing observation slot
with deny-only idle evidence. Native request order, not arrival order, controls
replacement and vetoes; a stale ownerless response cannot poison newer owned
evidence or shared transport reuse. The slot keeps the enclosing read's lifetime
and introduces neither a global cache nor new child associations.
Ownerless native parent reads likewise fill the pending source's existing parent
observation slot before its first consumed baseline. The provisional launcher
snapshot is deny-only and bounded to 256 facts / 64 KiB of serialized UTF-16
evidence, sharing the SSE counterproof limits. Native request order prevents an
older arrival from overwriting newer evidence or vetoing a later owned response;
joining the same native transport is not a contradiction. Snapshot replacement
does not accumulate facts. Saturation denies only the older pending consumer,
not fresh inventory, child ownership, or independent Stop authority.
Relevant native parent results are counterproof too: a newly observed explicit
report fences a previously inferred completion through scheduler interaction
reads and final admission. Results provably predating the child's native execution start
and reports for unrelated children do not fence that outcome. Retention is one
digest per native launch child, not report text or a result log; provisional
digests share the existing count/byte budget. Native ordering protects newer
observations from stale arrivals. Public prefix recovery, not the fingerprint,
decides which explicit reports remain visible after a parent revert.
The outcome source also retains a native pending-inbox observation, even when
the inbox is empty and no text lease is transferred. Later relevant pending
reports therefore fence inferred outcomes before scheduler admission. One
read-owned snapshot stores at most 256 compact digests / 64 KiB serialized
UTF-16, not inbox text or an observation log. Native request ordering protects
newer owned reads from older arrivals and carries provisional counterproof for
first pending consumers. Unchanged/ordinary-text, earlier-execution and
other-child reports leave independent outcomes current. Aborted observations
cannot revoke evidence; released leases retire the snapshot. Saturation is
deny-only and cannot grant ownership, result text or Stop authority.
Raw child-history contradictions use the consumed array's native request start
for denial, including later-started overlapping ownerless reads. Their response
arrival and replacement cache entry do not redate the consumed array. Existing
completion fences still prevent overlapping replies from replacing baselines.
Streamed subagent enqueues feed the same bounded slot before ownership awaits,
without a native inbox reread. They add facts rather than replacing the inbox
baseline, and exact replays coalesce. Their shared read-order clock fences older
in-flight empty responses; an identical pending baseline remains current.
Transcript-only outcome sources are fenced too when inventory recovery fails.
They compare actual newer positive reports with their native parent-read order,
declared child/admission scope and consumed report digests; no empty inbox
baseline is assigned. Empty/text, unrelated, pre-launch and unchanged consumed
reports leave them current. Source denial and cache retirement have separate
baselines: only the current cache load's cutoff and actual raw reports qualify
its retirement, so an older vetoed source cannot evict an already updated value.
Covered same-execution Ended activity without a report withdraws an unsupported
inferred outcome, while retaining its native end clock and valid dismissibility;
it grants no result or Stop authority. Positive pending facts share the existing bounded
slot and source lifetime. Before baseline installation, native snapshots and
streamed deltas both merge positive facts, preserving each fact's observation
order. Later delivery/absence cannot erase a veto. Sticky overflow retains the
latest lost-fact order; a later owned baseline filters genuinely older facts.
Covered history owns one `retainPendingCounterproof` watch across all retries,
bounded by the existing 256-fact / 64 KiB slot, original source deadline and
enclosing signal. Seed/merge filtering prevents old facts from being renewed by
a new attempt or unrelated newer batch. Unknown/wrapped source identity, a
different parent cohort, cancellation, reconnect or expiration fail closed.
The watch grants no report content, empty baseline, global cache or Stop proof.
Positive observations invalidate only transport reuse, without starting IO;
requested retries can read actually delivered native reports. Qualified current
explicit rows and their native clocks can discharge matching facts, while genuine
pending-only disagreement remains bounded-unavailable instead of cached Completed.
Permission to read replacement inventory is separate from publication authority;
strict source and current-inventory guards remain required at admission.
Successful covered inventory can replace an exact inferred worker outcome while
the transcript keeps text authority. The provider's optional
`withoutInferredOutcomes` guard view requires actual explicit report content,
native report ID/clock, the same row/task/type/child and proven execution-alias
overlap. Every inferred execution for an exempted child must be covered. The
adapter retains the successful inventory's current guards alongside that view.
The old full guard is not revived; ownership/revert, unrelated outcomes,
generation, cancellation and the original deadline remain fenced. Qualification
metadata is bounded to 256 entries / 64 KiB serialized evidence and fails closed
on overflow. Digests supply no report content or Stop authority. Canonical Failed
therefore publishes after the failed-inventory fallback once successful inventory
covers it; genuine uncovered disagreement still ends in bounded rejection.
An independent page-level source-current veto remains required alongside any
continuity or qualified-inventory guard view. Replacement may substitute a direct
old-guard delegate, not erase a separate provider veto.
Covered Running/session-active evidence may withdraw a report-free inferred
completion only with the same row/task/type/child and proven execution aliases.
The resulting row is nonterminal and nondismissible, with no running clock or
Stop authority. Explicit reports and changed executions remain protected.

Native parent visibility is also a consuming-source publication dependency,
including root sessions. One ordered boundary slot fences inferred outcomes
when a later native record hides their launchers. Retained-prefix visibility is
checked against the existing qualified complete-history cache; unknown visibility
abstains. Explicit owners install baselines, and stale ownerless responses cannot
poison newer owned reads. No additional IO, global cache or retained snapshot is
introduced; raw complete parent-history reuse remains separate from authority.
For parents, a late intermediate stage is deny-only through collection and
captured publication if its request began after registration, even after a newer
cleared reply. It cannot replace that baseline or revoke a later source. A
captured inferred outcome uses the stage's known launcher boundary: hidden rows
lose lease authority, while a qualified retained prefix stays valid. Old pending
folds revalidate current history; no extra IO or Stop revocation is introduced.
A previously cached child-history completion cannot override a current covered
unresolved row for that exact execution. The adapter replaces that report-free
inference rather than merging its terminal fields back; explicit parent reports
and concurrent terminal updates keep their existing precedence.
Cold activity recovery checks already processed child execution boundaries even
without a retained launcher. Active-session membership cannot revive an older
admission after an observed end or later distinct execution. Reverting the stored
idle does not erase that scoped counterproof. Native end proofs arriving before
the first ownership lookup remain negative-only facts under the existing ledger
entry/byte limits; saturation stays fail-closed without creating ownership.
Outcome inference uses these retained ends as veto-only interval boundaries too:
a reverted earlier idle cannot make a later execution's outcome belong to the
old admission. Matching event/transcript clocks are counted once, but duplicate
transcript idles remain ambiguous. An undated observed end retains one sticky
unknown-clock flag under the same ledger budget. Only valid visible transcript
outcomes can infer terminal status; explicit parent reports still take precedence.
Retained terminal proofs deduplicate exact event replay even without a live
worker occurrence. Proof identity, clock and semantic payload still distinguish
new boundaries. Replaying an old proof cannot settle a newer occurrence or grant
ownership/Stop authority. Saturation without the proof stays conservative.
The retained-end overlay and its retention gaps constrain outcome inference
only. They do not reclassify the shared control/admission fold or suppress
compatible ended activity and independently covered controls after saturation.
The old row remains outcome-unknown
and activity-unavailable, with its clock stopped and no new Stop authority or
fabricated end timestamp. An otherwise qualified unavailable row can supply
dismissal evidence rather than being held active by another execution. Prior
boundaries outside the new admission and unrelated/foreign events do not veto it;
a first start and its exact replay are not a second execution. No new retention
structure or budget is introduced.
The ledger retains distinct-start counterproof as one greatest observed clock
(or unknown-clock veto), independent of the latest arrival. Replaying an older
start cannot revive the previous execution or create a positive timestamp.
For outcomes/activity, the same byte-budgeted record keeps up to 128 distinct
start-proof digests and their clocks, coalescing even nonconsecutive exact replays.
Different native proof identities at the same clock remain distinct starts.
A later start cannot erase an intervening start
before an older outcome. Per-child overflow leaves a sticky attribution-only unknown;
the earliest start alone remains compatible with a first late admission.
Multiple distinct starts in the candidate interval veto unique activity/outcome
attribution even inside admission, before launcher acceptance returns. Prior
interval starts are excluded using the existing scoped boundary/admission rules.
These digests add no ownership, result clock or Stop authority and remain
deny-only through subscription retirement under the same aggregate budget.

Newer inactive inventory also fences already returned cold activity through
publication. After native parent history declares the bounded child scope, the
existing active-inventory read retains one ordered membership bit per child on
its source lease, not a workspace-wide snapshot. Inactive evidence downgrades
dependent cold activity to unavailable and stops its execution clock without
inventing an outcome or end timestamp. Older overlapping arrivals cannot revoke
newer evidence, cancellation cannot publish counterproof, and unchanged/other-child
membership or independently live controls do not lose authority. Leases retire
the slot. No additional native IO or Stop authority is introduced.
A covered Working/Needs-answer replacement for that exact execution also clears
the inferred end and resumes the running clock and background progress. Its
activity authority does not require available Stop controls.
The automatic scheduler uses the same guarded exact-execution replacement rule,
so its upserts cannot restore a revoked report-free completion either.
Exact execution matching uses the intersection of proven execution alias sets,
including each primary ID. A newly learned alias may sort before the old primary
without changing the execution. Same-row/task/type/child ownership checks and
explicit-report precedence still apply; alias overlap grants no Stop basis.
Automatic inventory recovery also holds and validates source leases through
its pending permission/question reads and final publication. Its bounded cycle
owner releases them on completion, failure, cancellation or supersession;
unavailable evidence cannot publish a stale terminal worker.
Returned history-only activity remains covered through that handoff too: later
terminal events, ordered child-history reads and relevant parent-launch
counterproof (native read or SSE) revoke its source rather
than merely changing an activity value already projected before return.
A distinct child execution start can provide the same counterproof without an
end event. Each existing read-owned activity-child slot keeps its exact cold
occurrence and reuses fresh recovery's admission predicate. A contradicting start
downgrades pending activity to unavailable, or revokes an already returned
Working lease before scheduler publication. First late starts, exact replays,
ordinary text and unrelated/foreign events leave that lease intact. The old
execution clock stays stopped and qualified unavailable evidence remains
dismissible, without an invented result/end time or new Stop proof. The slot's
existing child scope and deadline bound retention; it stores no event history.
Start counterproof is scoped to the candidate admission's execution interval,
using the greatest preceding scoped observed/transcript end. A delayed first
start after that boundary is not reuse; later distinct starts still veto the
old admission. Transcript context supplies only a read-owned lower-bound scalar,
not execution timestamps, outcomes, ownership or Stop proof. Unknown clocks,
retention caps and intervals without a known prior boundary remain conservative.
Missing admission clocks alone are not negative activity evidence. Without a
scoped observed start/end to compare, fresh owned history plus active inventory
can establish cold Working independently of Stop readiness. Once counterproof
exists, missing clocks cannot discharge it; unknown starts and retention gaps
remain fail-closed. This also avoids manufacturing unresolved/checking updates
for unchanged cold workers before a failed inventory retry.
Reading a prior typed idle alone does not revoke a returned new-interval Working
lease on its first start. Pending inference and actual inferred outcomes retain
their execution fence; transcript/revert/message counterproof remains required.
Exact retained unbound start replays preserve source leases just as exact
terminal replays do. Changed proofs still fence; replay adds no control authority.
Unclassified same-child subagent invocations also compete with cold Working,
even without another worker occurrence. Complete parent scope includes hidden
calls; reported child wins over requested child. Requested identity supplies
only a veto, not another row, child read, ownership or Stop capability. Calls
bounded before the preceding child end and exact launcher replays do not compete.
Outcome-free child observations remain watched through prepublication awaits
too. Native idle counterproof is retained for the eventual activity handoff
without invalidating unrelated output or prepublication Stop reads merely
because a dependency is still being collected.
This includes Working already captured before the final parent lookup.
Registering its native-read dependency at capture prevents a newer inactive
inventory downgrade from masking a changed child transcript during that await.
Capture is not publication: a pending stream boundary may withdraw Working and
retire that capture while the final visibility read obtains an actual outcome
under its own source. It does not blanket-revoke a pending control read.
Relevant boundaries still revoke already-published cold activity leases.
An older row superseded by a larger compatible retained alias cohort remains
inspectable but unavailable; it cannot borrow that cohort's activity or Stop
authority.
The handoff deadline starts at native source capture, not queue/ownership IO.
Cancellation releases authority without increasing concurrency over an old
transport still draining. Identical pending-notice replays preserve authority;
payload changes and delivery/removal still revoke it.
Coalesced pending outcome facts retain the newest native request-start order per
digest. Seeing the same report in a genuinely newer request can cross the
original parent-read boundary; stale arrival or an unrelated newer batch cannot
renew an old fact. Copies preserve each fact's order, and duplicate replacement
is charged against the existing byte cap with sticky deny-only overflow.
An older snapshot envelope cannot discard newer merged facts: parent/retry
boundary filtering checks per-fact observation and `overflowObserved` separately.
This also applies while the first parent transcript and its baseline are pending.
An inventory consumer's provisional baseline merges older-arriving positive
observations as well: older than a newer unrelated request does not mean older
than the owned empty inbox baseline. Per-fact ordering still discards genuinely
stale facts/overflow, and exact digest coalescing plus the existing caps bound it.
An envelope predating the owned request cannot discard individual newer facts
or overflow. Conversely, provisional positives never invent an empty baseline
or veto actual owned report content for unrelated children; matching report
content, ID and native clock retain authority under existing source guards.
Relevant native inbox vetoes also invalidate only the affected parent's history
reuse, without starting IO. The scheduler's requested retry then reads actual
delivered report content, not cached settlement plus an empty inbox. No global
report cache, digest-derived result or extra ownership/Stop authority is added.
Unchanged/unrelated/prelaunch observations preserve normal progress.

Registered pending child-history dependencies retain native staged/cleared
boundary changes before an idle is classified as a positive outcome. Existing
scoped counterproof fences that later outcome without granting ownership or
Stop authority or invalidating outcome-free/control reads solely for collection.
A genuinely newer boundary transition invalidates obsolete child-history reuse;
ordered native reads, not stale ownerless response arrival, govern that decision.
Warm child transcripts need no parent dependency to observe native visibility.
Each qualified cache entry carries a constant-size boundary observation from
pending-load registration through retention. Native request-start order retains
the newest baseline. A late staged reply after a newer cleared reply can veto
only a load registered before that intermediate stage. It cannot replace the
newer baseline or invalidate a load begun after the stage/clear pair.
Invalidation retires the
pending entry before a late value can install over a replacement; eviction and
disposal release the same metadata. No independent visibility keys are retained.
Entering a staged boundary filters the same
complete raw transcript without reloading it; native cost and visible state
still refresh. Leaving/changing an existing boundary can remove stored content
and invalidates reuse. Unchanged, unrelated and stale-overlapping records do not discard a newer valid
entry. No additional retained session map, child read or ownership/Stop proof is
introduced. Existing cache eviction, generation and disposal limits still apply.

Reconnect does not erase processed execution counterproof. Subscription cleanup
strips the existing accounted worker ledger to scoped ends, start vetoes,
unknown/overflow state and replay-only execution proof identity. It removes all
ownership, births, projected tasks, requests, invocations and occurrence/pending
bindings. No old proof becomes new-generation activity, a timestamp, outcome or
Stop witness. Unrelated/compatible cold history can still progress; a vetoed old
row stays unavailable and dismissible instead of restarting its execution clock.
The provider's same aggregate entry/byte budget bounds continuity, including
retained controls. Saturation stays fail-closed through further gaps. The stripped
ledger also fences reads between subscriptions and is released on disposal;
there is no workspace-global cache or added history-read phase.

## Browser consistency and recovery

Requests and responses use `no-store`; the browser keeps only an in-memory
projection. Failed reads discard saved marks locally so workers remain visible.
Selection and connection generations fence late responses. Conditional revisions
protect mutations; a conflict refreshes state without resubmitting a dismissal.
Account/workspace-private live invalidations trigger coalesced reads, not shared
dismissal payloads. Confirmed saves, disk reload and cross-device convergence
remain owned by the Hub.

There is no autonomous read-retry loop. Reconnect, selection changes, private
invalidations and qualifying identity recovery can request another read. The
current browser warning does not distinguish worker-evidence failures from saved
state failures. The timeout fix changes neither that wording nor retry policy;
it also does not prove that every reported dismissal error has the same cause.

See [the dismissal protocol guide](../api/guides/worker-dismissals.md) for
evidence bounds, source-consistency rules and batch mutation semantics.
