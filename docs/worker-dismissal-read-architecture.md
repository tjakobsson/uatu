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
