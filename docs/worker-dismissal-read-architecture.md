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
This observation includes a scoped record arriving while the first visibility
lookup is pending; a late overlapping response cannot overwrite that boundary.
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
A covered Working/Needs-answer replacement for that exact execution also clears
the inferred end and resumes the running clock and background progress. Its
activity authority does not require available Stop controls.
The automatic scheduler uses the same guarded exact-execution replacement rule,
so its upserts cannot restore a revoked report-free completion either.
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
Outcome-free child observations remain watched through prepublication awaits
too. Native idle counterproof is retained for the eventual activity handoff,
without invalidating unrelated output or prepublication Stop reads merely
because a dependency is still being collected.
An older row superseded by a larger compatible retained alias cohort remains
inspectable but unavailable; it cannot borrow that cohort's activity or Stop
authority.
The handoff deadline starts at native source capture, not queue/ownership IO.
Cancellation releases authority without increasing concurrency over an old
transport still draining. Identical pending-notice replays preserve authority;
payload changes and delivery/removal still revoke it.

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
