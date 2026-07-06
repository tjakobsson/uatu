# Delta: embedded-terminal — fix-terminal-auth-port-mapping

## MODIFIED Requirements

### Requirement: Server exposes a token-gated terminal WebSocket
The server SHALL expose a single WebSocket upgrade endpoint that proxies bytes between the browser and a real PTY shell process. The upgrade SHALL be rejected unless the request carries a valid per-server-session token, a syntactically valid `sessionId` query parameter (UUID), AND its `Origin` header passes the origin gate. The origin gate SHALL accept an Origin whose hostname is `localhost` or `127.0.0.1` AND whose port equals the port of the request's `Host` header; ports SHALL be compared after default-port normalization (an absent port means 80 for `http` and 443 for `https`). The server's listen port SHALL NOT participate in the comparison, so the gate holds unchanged when the browser reaches the server through a mapped port. A given `sessionId` already in use SHALL be rejected so concurrent PTYs cannot be cross-wired.

#### Scenario: Valid token, sessionId, and origin succeed
- **WHEN** the browser sends a WebSocket upgrade to `/api/terminal?t=<valid-token>&sessionId=<fresh-uuid>` with `Origin: http://127.0.0.1:<port>` and `Host: 127.0.0.1:<port>`
- **THEN** the server upgrades the connection and spawns a PTY associated with that `sessionId`

#### Scenario: Port-mapped access succeeds without configuration
- **WHEN** the server listens on port 4711 inside a container published to host port 4712
- **AND** the browser sends a WebSocket upgrade with a valid token and fresh `sessionId`, `Origin: http://localhost:4712`, and `Host: localhost:4712`
- **THEN** the server upgrades the connection and spawns a PTY

#### Scenario: Page on another localhost port is rejected
- **WHEN** a page served from `localhost:9999` sends a WebSocket upgrade with a valid token to the server reached at `Host: localhost:4712`, carrying `Origin: http://localhost:9999`
- **THEN** the server responds with HTTP 403 and does not spawn a PTY

#### Scenario: Missing sessionId is rejected
- **WHEN** the browser sends a WebSocket upgrade to `/api/terminal?t=<valid-token>` with no `sessionId` parameter
- **THEN** the server responds with HTTP 400 and does not spawn a PTY

#### Scenario: Malformed sessionId is rejected
- **WHEN** the browser sends a WebSocket upgrade with `sessionId=not-a-uuid`
- **THEN** the server responds with HTTP 400 and does not spawn a PTY

#### Scenario: Duplicate sessionId is rejected
- **WHEN** a `sessionId` is already attached to an active PTY
- **AND** another upgrade arrives with the same `sessionId` and a valid token
- **THEN** the server responds with HTTP 409 and does not spawn a second PTY

#### Scenario: Missing token is rejected
- **WHEN** the browser sends a WebSocket upgrade to `/api/terminal?sessionId=<fresh-uuid>` with no `t` query parameter
- **THEN** the server responds with HTTP 401 and does not spawn a PTY

#### Scenario: Foreign origin is rejected
- **WHEN** a client sends a WebSocket upgrade to `/api/terminal?t=<valid-token>&sessionId=<fresh-uuid>` with `Origin: http://attacker.example`
- **THEN** the server responds with HTTP 403 and does not spawn a PTY
- **AND** this holds even when the Origin's port equals the Host header's port (a DNS-rebinding origin such as `http://evil.example:4712` against `Host: evil.example:4712` fails the hostname pin)

#### Scenario: Token is unique per server start
- **WHEN** the server is restarted
- **THEN** the previous token no longer authenticates terminal upgrades

### Requirement: A sessionId collision resolves to a fresh session, not an auth prompt
When a terminal WebSocket closes before opening, the client SHALL NOT assume an authentication failure. The client SHALL probe `GET /api/auth`. The server SHALL answer the probe with one of three verdicts: 204 when the request carries valid terminal credentials (auth cookie or `t` query token) AND the requester's effective origin passes the same origin gate as the WebSocket upgrade; 403 when credentials are valid but the effective origin is rejected; 401 when credentials are invalid. The effective origin SHALL be the request's `Origin` header when present, and otherwise SHALL be synthesized from the request's scheme and `Host` header (exact for the client's same-origin fetch). The probe and the upgrade gate SHALL share one origin predicate so their verdicts cannot diverge for the same request shape.

The client SHALL map the verdicts to distinct outcomes: on 204 it SHALL treat the failed upgrade as a `sessionId` collision, mint a fresh `sessionId` for the pane, and reconnect; on 403 it SHALL show an origin-rejected notice that names the address mismatch as the cause and SHALL NOT show the paste-token form or claim the server restarted; on 401 it SHALL show the paste-token form. The paste-token form SHALL be shown only for the 401 verdict.

#### Scenario: Second window gets its own shell without a token prompt
- **WHEN** a second browser window of the same uatu instance opens the terminal while the first window holds the persisted `sessionId`
- **THEN** the second window's pane connects with a freshly minted `sessionId` and reaches a working shell
- **AND** no paste-token form is shown

#### Scenario: First window is unaffected by the collision
- **WHEN** the second window resolves its collision with a fresh session
- **THEN** the first window's attached session continues uninterrupted

#### Scenario: Genuine auth failure still shows the paste-token form
- **WHEN** a terminal WebSocket closes before opening
- **AND** `GET /api/auth` returns 401 (stale cookie after a uatu restart, or a fresh PWA window with no credentials)
- **THEN** the paste-token form is shown

#### Scenario: Origin rejection produces an honest error, not the paste-token form
- **WHEN** a terminal WebSocket closes before opening
- **AND** `GET /api/auth` returns 403 (valid credentials, origin rejected)
- **THEN** the pane shows an origin-rejected notice explaining that the address the browser is using does not pass the terminal's origin gate
- **AND** the paste-token form is not shown
- **AND** the client does not enter a reconnect loop for that pane

#### Scenario: Probe endpoint gates on credentials and origin
- **WHEN** `GET /api/auth` is requested with a valid auth cookie or a valid `t` query token from a page whose origin passes the origin gate
- **THEN** the server responds 204
- **WHEN** it is requested with valid credentials but an effective origin the upgrade gate would reject
- **THEN** the server responds 403
- **WHEN** it is requested with no or invalid credentials
- **THEN** the server responds 401

## ADDED Requirements

### Requirement: Terminal auth cookie is scoped to the request's Host port
The terminal auth cookie name SHALL be derived from the port of the request's `Host` header (default-port normalized), e.g. `uatu_term_4712` for a request reaching the server at `localhost:4712`. The server SHALL use this derivation consistently at set time (the `Set-Cookie` issued when a token is promoted to a cookie) and at read time (the WebSocket upgrade gate, the auth probe, and the terminal sessions REST endpoints). The legacy fixed-name `uatu_term` cookie SHALL NOT be read; a client holding only the legacy cookie re-authenticates via the paste-token flow once.

#### Scenario: Instances on different host ports keep independent credentials
- **WHEN** two uatu instances are reached at `localhost:4712` and `localhost:4713` and the user authenticates the terminal in both
- **THEN** each instance sets and reads its own port-suffixed cookie
- **AND** authenticating the second instance does not invalidate the first instance's terminal

#### Scenario: Cookie set through a mapped port authenticates through that port
- **WHEN** the server listens on 4711 but is reached at `Host: localhost:4712` and the token is promoted to a cookie
- **THEN** the cookie is named for port 4712
- **AND** a subsequent WebSocket upgrade arriving with `Host: localhost:4712` reads that cookie and authenticates

#### Scenario: Legacy cookie is ignored
- **WHEN** a request carries only a legacy `uatu_term` cookie with a valid token value
- **AND** no `t` query token is supplied
- **THEN** the request is treated as unauthenticated (401)
