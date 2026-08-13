# Streaming protocols

UatuCode uses three streaming forms. [streaming.yaml](../streaming.yaml) is authoritative for channel names, payload variants, lifecycle behavior, and terminal WebSocket close codes.

## Server-sent events

Workspace state and clone jobs use SSE. Parse named events, retain the most recent event ID, and reconnect with the documented replay behavior. Unknown event variants indicate a contract mismatch; do not silently reinterpret them as known payloads.

## NDJSON search

Search emits one JSON value per line. Process complete lines incrementally and distinguish result, completion, and error variants by their documented discriminator. HTTP success alone does not imply the stream completed successfully. Cancelling the request cancels the search; a partial result set is not a completion.

## Terminal WebSocket

Terminal output may be binary PTY data while control and lifecycle messages are JSON text frames. Preserve the frame type. Never decode binary output as JSON, and validate text control frames against the published variants. Handle documented application close codes separately from network loss.
