# API source conventions

- `openapi.yaml` is authoritative for HTTP methods, paths, parameters, bodies, responses, and JSON schemas.
- `streaming.yaml` is authoritative for SSE events, NDJSON items, WebSocket frames, lifecycle rules, and application close codes.
- `operations.yaml` classifies every public operation and records its current runtime source. `exclusions.yaml` classifies non-public route families.
- The public contract is the Hub API, at origin-rooted paths. Everything under `/s/{workspaceId}/`, and every root-relative workspace child path, is internal and appears only in `exclusions.yaml`.
- Operation IDs are stable, lower camel case, and begin with `hub`. The `workspace` prefix belonged to the workspace API, which left the public contract at workspace revision 16.
- A multiplexed channel lists its topics under `topics`. Each topic names its payload `dataSchema`, an optional `resyncDataSchema`, and the `domain` that owns the payload. The compatibility check charges a payload change to that domain, so a `ChatEvent` break on the Hub's live stream still increments the workspace revision.
- JSON examples live in `examples/<protocol>/` and use `<variant>.json`. SSE examples are whole frames with `event` and `data`. `scripts/validate-api.ts` validates every example and fails on one it has no schema for. A `live` frame validates twice, as an envelope and against its topic's payload schema.
- JSON objects are closed with `additionalProperties: false` unless the runtime intentionally permits extensible keys.
- Timestamps are either ISO 8601 strings when emitted as strings or Unix epoch milliseconds when emitted as numbers. Field descriptions identify which form applies.
- Public API revisions are monotonically increasing integers. A breaking change increments only the affected domain and adds a changelog migration section. `workspaceApiRevision` versions the workspace payloads the live stream forwards.
- `openapi.yaml`'s `info.version` encodes the pair as `<hub>.<workspace>.0-experimental`; `x-uatu-revisions` and `contract.json` are authoritative, and a published snapshot's `contract.json` additionally records the product version it shipped with.

Validation fixtures must represent actual wire values. They must not normalize away optional fields or convert binary WebSocket data to JSON.
