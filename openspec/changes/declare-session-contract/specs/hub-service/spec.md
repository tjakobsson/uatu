## MODIFIED Requirements

### Requirement: Sessions are started and stopped through a session backend interface
The hub SHALL manage sessions exclusively through a backend interface: given a workspace descriptor, base path, and resolved credential assignments, start a workspace session and return a session link to it; or stop a previously started session. Proxy, dashboard, and auth MUST NOT depend on how the endpoint, token or credential context is produced.

Normal local-session tool configuration MUST NOT select unassigned stored credentials.

#### Scenario: The local backend starts and stops a workspace session
- **WHEN** the shipped `local` backend starts a session
- **THEN** it SHALL spawn `uatu serve <folder> --no-open --exit-on-stdin-close --hub-policy-bootstrap --port 0 --base-path /s/<id>/ --manifest-scope origin` with an explicitly passed environment carrying Git, signing, SSH-client, and provider-tool selection derived from workspace assignments
- **AND** the child's standard input, output and error SHALL be pipes and descriptor 3 SHALL be a private socket for the policy bootstrap
- **AND** it SHALL read the ready line from the first complete stdout line that contains an `http://` URL, hold stdin open for the child's lifetime, and stop the session via SIGTERM, escalating to SIGKILL after a grace period
- **AND** it MUST NOT forward ambient agent sockets, and normal tool configuration MUST NOT select unassigned stored credentials
- **AND** because sessions share the daemon UID and may share Hub-managed runtime resources, these advisory selections MUST NOT be represented as OS-enforced isolation

#### Scenario: The local backend's credential selection is described
- **WHEN** local-session credential selection is presented or documented, whether or not a session is being started
- **THEN** it MUST NOT be represented as OS-enforced isolation: sessions share the daemon UID and may share Hub-managed runtime resources, so the selections are advisory

#### Scenario: Local backend spawns the session-child contract
- **WHEN** the hub starts a session for a registered workspace with credential assignments
- **THEN** a `uatu serve` child starts with `--no-open --exit-on-stdin-close --hub-policy-bootstrap --port 0`, the workspace's base path, `--manifest-scope origin`, and explicit integrations for its assignments
- **AND** the hub records the loopback endpoint and session token parsed from the ready line `http://127.0.0.1:<port>/s/<id>/?t=<token>`

#### Scenario: A silent or failed child does not become a session
- **WHEN** a spawned child prints nothing on stdout for 30 seconds, closes stdout, or exits before printing a ready line
- **THEN** the start fails with an error that includes the tail of the child's stderr
- **AND** the child is terminated and no session link is published
- **AND** any stdout output before the ready line re-arms the 30-second inactivity window, so a slow start that keeps reporting progress is not killed

#### Scenario: Policy trust requires a verified readiness proof
- **WHEN** the child consumes the private bootstrap on descriptor 3 and then answers the Hub's challenge at `POST /s/<id>/api/internal/hub-policy-proof` with a valid proof within two seconds
- **THEN** the session link's policy trust is ready and the Hub signs eligible chat actions for that session
- **AND** when the child does not send the readiness marker, rejects the bootstrap, or fails or times out the proof, the session still starts with policy trust unavailable and the Hub never falls back to the session token as policy authority

#### Scenario: Local backend does not inherit ambient agents
- **WHEN** the Hub daemon has an unrelated ambient agent and starts a workspace with no credential assignments
- **THEN** the child receives no Hub or ambient credential integration from session startup

#### Scenario: Hub death cannot orphan children
- **WHEN** the hub process dies without running termination handlers
- **THEN** each child server exits on its own because its standard input reached EOF

### Requirement: All session traffic is reverse-proxied under the workspace prefix
The hub SHALL proxy workspace traffic under `/s/<id>/` to its loopback endpoint for HTTP and WebSocket upgrades, except the per-stream SSE routes and the internal session routes below. Hub-served live updates SHALL use brokered fanout with one subscription per child topic, bounding outbound live connections by watched topics rather than clients. Children SHALL bind loopback only and MUST NOT be directly network-reachable.

#### Scenario: A browser requests a per-stream SSE route through the hub
- **WHEN** a request targets `/s/<id>/api/events`, `/s/<id>/api/activity`, `/s/<id>/api/chat/notifications/events`, `/s/<id>/api/chat/conversations/events`, or `/s/<id>/api/chat/conversations/<conversation>/events`
- **THEN** it SHALL NOT be proxied and SHALL receive a non-cached 410 error naming the brokered live stream as replacement
- **AND** child event routes SHALL remain the internal source for hub subscriptions, not one child stream per browser stream

#### Scenario: A browser requests an internal session route through the hub
- **WHEN** a request targets `/s/<id>/api/internal/hub-policy-proof` or `/s/<id>/api/chat/accounts-changed` through the hub, with any method
- **THEN** it SHALL NOT be proxied and SHALL receive a non-cached 404 error
- **AND** no request reaches the child
- **AND** the Hub's own readiness proof and account-change notification still reach the child directly over its loopback endpoint

#### Scenario: A proxied WebSocket closes or a workspace is unavailable
- **WHEN** WebSocket messages or close events traverse a workspace proxy
- **THEN** they SHALL be forwarded both ways, preserving application close codes including terminal 4001, 4409, and 4410

#### Scenario: Any proxied request targets an unknown or stopped workspace
- **WHEN** a request targets an unknown or stopped workspace, whether HTTP or WebSocket
- **THEN** it SHALL receive a non-cached error response linking to the dashboard

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

### Requirement: The hub forwards loopback-shaped requests so children keep their localhost model
When proxying to a child, the hub SHALL rewrite the forwarded `Host` header to the child's loopback endpoint and SHALL always set `Origin` to the child's loopback origin, whether or not the browser sent one, after the hub has itself validated the browser's origin against the hub's host. Children's existing loopback origin gates and token checks SHALL hold without modification.

#### Scenario: Child accepts a proxied terminal upgrade
- **WHEN** a browser at the hub's HTTPS origin performs a terminal WebSocket upgrade through the hub
- **THEN** the child receives loopback-shaped `Host` and `Origin` headers and its origin gate accepts the upgrade

#### Scenario: An Origin-less request still reaches the child with a loopback Origin
- **WHEN** an authenticated native client sends a request without an `Origin` header through the hub
- **THEN** the child receives its own loopback origin in `Origin`

#### Scenario: Caller-supplied Hub headers and tokens do not cross the hop
- **WHEN** a browser request through the hub carries an `x-uatu-hub-chat-policy` or other `x-uatu-hub-*` header, or a `t` query parameter
- **THEN** the child receives none of the caller's `x-uatu-hub-*` headers
- **AND** when the session has a token, the child receives the Hub-held session token as `t`, never the caller's value
- **AND** when the session has no token, the Hub adds none and the caller's `t` reaches the child as sent

## ADDED Requirements

### Requirement: Hub code reaches a workspace session only through its session link
Each running workspace session SHALL have one session link, produced by the session backend. Hub code SHALL address and trust the session only through it: the link carries the loopback endpoint and session token, builds tokened session URLs, and signs chat policy when policy trust is ready. Which session paths the Hub refuses or intercepts SHALL be decided by the session contract's path classification, which depends only on the request method and path, not on any particular session.

#### Scenario: Hub-originated calls use the link
- **WHEN** the Hub proxies a browser request, opens a live upstream, reads worker evidence, reads the terminal-session inventory for the dashboard, or notifies a session of an account change
- **THEN** the session URL, its token and any policy signature come from that session's link
- **AND** the request reaches the same path with the same headers as before the link existed

#### Scenario: A stopped session's link stops signing
- **WHEN** a session stops or exits
- **THEN** its link reports policy trust unavailable and signs nothing further

### Requirement: The session contract is verified against a real workspace session
The repository SHALL include an automated test that starts a real workspace session process once and checks each expectation the Hub has of it: the ready-line format, the fd-3 bootstrap and readiness proof, that every internal session path the Hub calls exists, and that every session path the Hub refuses is refused and stays excluded from the public contract. The test SHALL wait for events, never for fixed delays.

#### Scenario: A real session meets the Hub's expectations
- **WHEN** the contract test starts a real workspace session with the Hub's spawn shape
- **THEN** the session prints a ready line the contract parser accepts, completes the fd-3 bootstrap, and returns a proof the Hub verifies
- **AND** each internal path the Hub calls answers from the session rather than 404

#### Scenario: Refused paths are refused and stay internal
- **WHEN** the contract test requests each refused session path through a Hub in front of that session
- **THEN** each per-stream path, including `/api/chat/notifications/events`, answers 410 and each internal route answers 404
- **AND** each refused path is covered by an explicit exclusion in `api/exclusions.yaml`, not a public operation
