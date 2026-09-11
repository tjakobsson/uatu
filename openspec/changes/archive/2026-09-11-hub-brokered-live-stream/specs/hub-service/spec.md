## MODIFIED Requirements

### Requirement: All session traffic is reverse-proxied under the workspace prefix
The hub SHALL proxy every request under `/s/<id>/` to that workspace's loopback endpoint, covering plain HTTP and WebSocket upgrades. Live updates for hub-served pages SHALL NOT be proxied one browser stream to one child stream: the hub SHALL deliver them over its brokered live stream, subscribing to each child's topics once and fanning out, so the hub's outbound connections for live delivery are bounded by watched topics rather than by connected clients. The per-stream workspace SSE routes (`/s/<id>/api/events`, `/s/<id>/api/chat/conversations/events`, `/s/<id>/api/chat/conversations/<conversation>/events`) SHALL NOT be proxied: a request for one SHALL receive a non-cached error naming the brokered stream as its replacement, and the child's routes remain the internal source the hub subscribes to. WebSocket proxying SHALL forward messages and close events in both directions, preserving application close codes (including the terminal's 4001, 4409, and 4410). Requests for an unknown or stopped workspace SHALL receive a non-cached error response that links back to the dashboard. Children SHALL bind loopback only and MUST NOT be directly reachable from the network.

#### Scenario: A session round-trips through the hub
- **WHEN** an authenticated browser requests `/s/uatu/api/state`
- **THEN** the hub forwards the request to that session's loopback endpoint and streams the response back

#### Scenario: Live updates are brokered, not proxied per client
- **WHEN** three authenticated tabs view the same running workspace's page
- **THEN** the hub holds one upstream subscription per watched topic of that workspace
- **AND** each tab receives updates over its own single brokered stream

#### Scenario: A per-stream route is refused through the hub
- **WHEN** a client requests `/s/uatu/api/events` through the hub
- **THEN** the hub answers with a non-cached error that names the brokered live stream as the replacement
- **AND** no request reaches the child

#### Scenario: Terminal WebSocket transits the hub
- **WHEN** an authenticated browser upgrades `/s/uatu/api/terminal?sessionId=<uuid>` and later the PTY is killed via the session inventory
- **THEN** bytes flow both directions through the hub during the session
- **AND** the client observes the same close code it would observe connecting directly

#### Scenario: Stopped workspace prefix explains itself
- **WHEN** a browser requests a `/s/<id>/` URL whose session is not running
- **THEN** the hub responds with an error page linking to the dashboard rather than a bare connection failure

#### Scenario: Remote transfers are compressed and bundle assets cached
- **WHEN** a browser that accepts gzip loads a session's bundled script chunk through the hub
- **THEN** the response is gzip-compressed and marked immutable with long-lived caching
- **AND** a revalidation request with the asset's entity tag answers 304 without a body
- **AND** incremental feeds (the NDJSON search feed) are never buffered for compression
