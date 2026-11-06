# Internal media HTTP contract

Recognition, indexed authorization, revision checks, range selection, and bounded
delivery use the shared product media route. A narrow `node:http` response-writing
boundary at both child and Hub listeners preserves the strict contract on Bun
1.4.4, whose generic Bun.serve stream sink otherwise drops large-response lengths.

The boundary consumes the same authenticated dispatch and awaits write/drain
backpressure. It destroys and cancels interrupted responses rather than leaving
readers pending. Other HTTP traffic and upgrades retain the private Bun listener,
including its literal HTMLBundle route assembly. Browser URLs/origins, base paths,
TLS, Host/Origin checks, cookies, token brokering, and client-IP context remain
unchanged. Peer provenance is correlated through private upstream connections,
not caller-supplied forwarding headers. Child and internal listeners remain
loopback-only; listener readiness and graceful/forced shutdown cover both layers.

Source, E2E, and compiled paths use `src/server/media-http-boundary.ts`. Tests
cover exact large response lengths, slow consumers, cancellation, SSE flushing,
WebSocket routing, authentication, TLS, and lifecycle behavior. The compiled Hub
smoke includes a 1 MiB ignored output admitted beneath `build/renders`, with full,
range, and HEAD byte/header checks.

This is the same-build protocol between the bundled web client, Hub proxy, and
workspace child. It is not a public Hub API. GET and HEAD are classified by
`workspace-media` and `direct-child-media` in `api/exclusions.yaml`; no media
operation is published in OpenAPI. Public personal-state and live-payload schemas
retain their existing publication and revision rules.

## Identity and authorization

The client builds `/api/media` URLs through `appUrl()`, under the workspace base
path. Each request carries four query parameters:

| Parameter | Meaning |
| --- | --- |
| `rootId` | Exact watched-root identity from the indexed document |
| `path` | Normalized root-relative path, URL-encoded as a query value |
| `epoch` | Current session epoch from the document snapshot |
| `revision` | Selected file's numeric revision, not the aggregate snapshot revision |

Hub requests require the authenticated workspace session. The Hub brokers the
child credential without exposing it to the browser. The child independently
validates credentials, exact indexed membership, current exposure policy, and
realpath containment. Duplicate relative paths never fall back to another root.
Hiding ignored rows does not revoke access to a permitted indexed file.

## Representation and ranges

Successful responses advertise the recognized container's MIME type and
`Accept-Ranges: bytes`. Extension recognition is not a codec-support guarantee.
Media is never compressed or transformed, and responses are not cacheable.

| Request | Status and body |
| --- | --- |
| Full GET | `200`, exact representation bytes and `Content-Length` |
| One satisfiable explicit/open-ended/suffix range | `206`, exact selected bytes, `Content-Range` and selected `Content-Length` |
| Unsatisfiable range | `416`, `Content-Range: bytes */size`, no media body |
| Malformed or multiple ranges | Range ignored; normal full `200` representation |
| HEAD, with or without Range | Full `200` representation metadata, no body |
| Known stale epoch/revision or opened-file metadata | `409`, `no-store`, no media bytes |

Invalid identities, unavailable files, exposure exclusions, and unauthorized
requests are refused before media delivery. Empty files retain the same full,
HEAD, and unsatisfiable-range rules. No stat-derived strong content hash or
immutable historical representation is promised.

## Streaming and freshness

Only the active media source is requested. Listing and filtering metadata do not
read clips. Delivery uses bounded file-backed reads with backpressure; the Hub
preserves status, range/length headers, and downstream cancellation. Media bytes
never enter document JSON, personal state, or SSE.

Every new request revalidates epoch/revision and opened-file metadata against
the index. Detected writes, replacement, deletion, policy removal, and session
shutdown invalidate outstanding old-revision delivery. This is detection-based
freshness: an in-place writer cannot provide a filesystem snapshot guarantee.
The UI surfaces an explicit new-render notice and Reload rather than silently
selecting newer bytes under an old URL.
