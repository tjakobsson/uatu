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
Fresh parent-history reads provide the same scoped counterproof before SSE:
nonoverlapping reads can revoke an older launch inventory, while conflicting
overlapping responses cannot supersede later consumed evidence. Native read
order survives transport reuse.
The shared native-history boundary also observes idle counterproof from direct
child history, accounting and inspection reads; it is not limited to a parent
worker fold.
A previously cached child-history completion cannot override a current covered
unresolved row for that exact execution. The adapter replaces that report-free
inference rather than merging its terminal fields back; explicit parent reports
and concurrent terminal updates keep their existing precedence.
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
