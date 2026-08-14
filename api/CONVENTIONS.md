# API source conventions

- `openapi.yaml` is authoritative for HTTP methods, paths, parameters, bodies, responses, and JSON schemas.
- `streaming.yaml` is authoritative for SSE events, NDJSON items, WebSocket frames, lifecycle rules, and application close codes.
- `operations.yaml` classifies every public operation and records its current runtime source. `exclusions.yaml` classifies non-public route families.
- Hub paths are origin-rooted. Workspace paths use the externally visible Hub proxy prefix `/s/{workspaceId}`; root-relative child paths are implementation details.
- Operation IDs are stable, lower camel case, and begin with `hub` or `workspace`.
- JSON examples live in `examples/<protocol>/` and use `<variant>.json`. Every example has a matching schema name in its contract.
- JSON objects are closed with `additionalProperties: false` unless the runtime intentionally permits extensible keys.
- Timestamps are either ISO 8601 strings when emitted as strings or Unix epoch milliseconds when emitted as numbers. Field descriptions identify which form applies.
- Public API revisions are monotonically increasing integers. A breaking change increments only the affected domain and adds a changelog migration section.
- `openapi.yaml`'s `info.version` encodes the pair as `<hub>.<workspace>.0-experimental`; `x-uatu-revisions` and `contract.json` are authoritative, and a published snapshot's `contract.json` additionally records the product version it shipped with.

Validation fixtures must represent actual wire values. They must not normalize away optional fields or convert binary WebSocket data to JSON.
