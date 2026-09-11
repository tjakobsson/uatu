# Streaming protocols

The public API streams over Server-Sent Events. [streaming.yaml](../streaming.yaml) is authoritative for channel names, event and payload schemas, and lifecycle rules.

## The live stream

Open one `GET /api/hub/live` per client, not one per topic. The response starts with an `: open` comment, and the first event is `hello`, which carries the stream id. Every later event is named `live` and holds an envelope with the workspace, topic, optional key, cursor, and event. The topics are `document`, `inventory`, `conversation`, and `activity`.

Keep the last cursor you applied for each subscription, and advance it only on `data` events. A `resync` signal means that subscription's cursor can no longer be replayed. Take a fresh snapshot and add the subscription again with the snapshot's cursor, while other subscriptions carry on. An `unavailable` signal means the workspace behind that subscription failed or stopped. The Hub retries and sends `ready` once it recovers. Neither signal ends the stream.

Change subscriptions with `POST /api/hub/live/{streamId}/subscriptions`. To reconnect after a transport error, open a new stream and present every retained cursor in `subs`. The stream ignores SSE event ids and `Last-Event-ID`. Comment frames are keepalives and carry no data.

## Clone job events

Each clone job has its own SSE stream. Retain the most recent event id and reconnect with `Last-Event-ID` to replay what you missed. The `result` event is the last one and closes the stream.

Unknown event names, topics, or signal kinds mean your copy of the contract is out of date. Do not reinterpret them as known payloads.
