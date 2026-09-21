## ADDED Requirements

### Requirement: Terminal bridges release abandoned connections and preserve recovery
For proxied terminal WebSockets, the Hub SHALL propagate browser departure to the corresponding child connection and release both sides when bridge establishment fails or is cancelled. A late upstream connection completion MUST NOT retain an abandoned terminal holder or deliver queued input after the browser has departed. A child attachment refusal SHALL leave the browser able to reconcile the terminal through authenticated inventory without treating transport establishment as successful terminal attachment. Bridge failure SHALL NOT create or terminate a PTY or transfer ownership. Established terminal connections SHALL retain existing bidirectional message forwarding and application close-code semantics.

#### Scenario: Navigation releases the old holder
- **WHEN** a browser leaves a workspace and closes its terminal connection
- **THEN** the Hub closes the corresponding child connection and the PTY becomes detached once that close is processed
- **AND** the running shell remains available for ordinary reattachment

#### Scenario: Browser departs while the upstream connection is opening
- **WHEN** the browser disconnects before the child WebSocket finishes opening
- **THEN** the Hub cancels or closes the upstream connection
- **AND** any late completion cannot attach an abandoned holder or forward queued input

#### Scenario: Browser upgrade fails after upstream creation
- **WHEN** the Hub has begun opening a child connection but cannot complete the browser upgrade
- **THEN** the Hub releases the child connection and pending bridge data
- **AND** no terminal holder remains for the failed browser connection

#### Scenario: Child rejects a terminal already held elsewhere
- **WHEN** the child refuses an ordinary attach because the requested PTY already has a holder
- **THEN** the rejected bridge releases its resources without affecting the holder
- **AND** the browser can determine the occupied state through authenticated inventory and offer explicit takeover

#### Scenario: Application close semantics survive bridge cleanup
- **WHEN** an established terminal connection sends explicit termination or receives a takeover notification
- **THEN** the Hub preserves the terminal's application close code and direction
- **AND** ordinary navigation cleanup does not emit the explicit-termination code
