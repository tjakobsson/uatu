# Streaming protocols

The public API streams over Server-Sent Events. [streaming.yaml](../streaming.yaml) is authoritative for channel names, event and payload schemas, and lifecycle rules.

## The live stream

Open one `GET /api/hub/live` per client, not one per topic. The response starts with an `: open` comment, and the first event is `hello`, which carries the stream id. Every later event is named `live` and holds an envelope with the workspace, topic, optional key, cursor, and event. The topics are `document`, `inventory`, `conversation`, `activity`, `worktrees`, and `personal`.

Keep the last cursor you applied for each cursor-bearing subscription, and advance it only on `data` events. A `resync` signal means that subscription's cursor can no longer be replayed. Take a fresh snapshot and add the subscription again with the snapshot's cursor, while other subscriptions carry on. For upstream-backed subscriptions, `unavailable` means the upstream failed or the workspace child stopped; the Hub retries and sends `ready` once it recovers. Neither signal ends the stream.

`worktrees` and `personal` have no replay cursor: read their authoritative state on every data invalidation, including attachment and reconnect. `personal` is account-private and has no upstream. Its `unavailable` signal means dismissal persistence failed or remains unconfirmed, not that the workspace stopped. Keep chat and canonical requests available and show private storage guidance. Confirmed storage recovery emits `ready` followed by a fresh data invalidation; initial personal attachment emits data without requiring `ready`.

Workspace revision 33 adds optional `WorkerActivity.launchRef` to conversation payloads. It links a provider-proven partial launch observation to that same launch's later qualified execution identity. Preserve the reference, but never use it as a dismissal key, alias or Stop permission. Automatic dismissal recovery also needs authoritative retirement confirmation; a matching reference alone is insufficient. Continuity is guaranteed only within the retained native stream generation. References may be absent or change after a gap, restart, contradictory evidence, reuse or saturation; never infer continuity across that boundary.

Change subscriptions with `POST /api/hub/live/{streamId}/subscriptions`. To reconnect after a transport error, open a new stream and present every retained cursor in `subs`. The stream ignores SSE event ids and `Last-Event-ID`. Comment frames are keepalives and carry no data.

## Clone job events

Each clone job has its own SSE stream. Retain the most recent event id and reconnect with `Last-Event-ID` to replay what you missed. The `result` event is the last one and closes the stream.

Unknown event names, topics, or signal kinds mean your copy of the contract is out of date. Do not reinterpret them as known payloads.
