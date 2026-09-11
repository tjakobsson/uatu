## ADDED Requirements

### Requirement: Live document state recovers from interrupted client paths
The live document channel SHALL transmit transport keepalives often enough to prevent normal HTTP intermediaries from treating an otherwise idle stream as abandoned. A keepalive MUST NOT produce an application state update, change the current selection, trigger rendering, or advance state generation. After a channel error, the client MUST own a continuing reconnect cycle with bounded delay and MUST NOT depend indefinitely on a native connection object remaining in a connecting state. A replacement channel MUST deliver and apply a fresh authoritative state snapshot so file changes missed during the gap are reconciled.

When a suspended page resumes, a hidden page becomes visible, or the browser reports restored network connectivity, the client SHALL reconcile authoritative state and ensure that its live channel is current. Duplicate lifecycle signals and overlapping recovery attempts MUST converge to one effective current channel without allowing an older attempt to replace a newer connection.

#### Scenario: Idle intermediary path stays active
- **WHEN** a client has an open live document channel and no watched files change for an extended period
- **THEN** transport keepalives cross the Hub and any fronting reverse proxy at a bounded interval
- **AND** the client receives no spurious state update or document refresh from those keepalives

#### Scenario: Connecting state cannot strand recovery
- **WHEN** a live document channel reports an error and its native connection would otherwise remain in a connecting state indefinitely
- **THEN** the client replaces the failed channel after a bounded delay
- **AND** continues bounded reconnect attempts until a connection succeeds or the page is discarded

#### Scenario: Reconnect applies authoritative state
- **WHEN** watched files change while a client's live document channel is interrupted
- **THEN** a successful reconnect applies a fresh state snapshot
- **AND** the sidebar and active preview converge on the current workspace state

#### Scenario: Resuming a suspended mobile page reconciles state
- **WHEN** a page resumes after suspension or returns to the foreground with an uncertain live-channel state
- **THEN** the client reconciles authoritative state and ensures that a current live channel is installed
- **AND** recovery does not require a manual page reload

#### Scenario: Duplicate wake signals converge
- **WHEN** page resume, visibility, and online signals arrive close together
- **THEN** overlapping recovery work converges to one current channel
- **AND** a stale recovery completion cannot replace the newer channel or state

### Requirement: Live stream lifecycles remain isolated and releasable
Each client's document and Chat streaming requests SHALL have an independent lifecycle through the Hub proxy. Disconnecting, suspending, or reconnecting one client MUST NOT close or delay another client's established streams. When a downstream client abandons a proxied stream, the Hub MUST cancel the corresponding child request and the child MUST release its subscription within a bounded period. Stream lifecycle diagnostics SHALL distinguish opens, successful recovery, downstream cancellation, and upstream failure by transport class without recording event payloads, credentials, or sensitive query values.

#### Scenario: One client reconnects while another remains live
- **WHEN** two clients subscribe to the same running workspace and one client's transport is interrupted
- **THEN** the interrupted client can reconnect independently
- **AND** the other client's document and Chat streams continue without interruption

#### Scenario: Downstream cancellation reaches the child
- **WHEN** a client closes or abandons a stream proxied through the Hub
- **THEN** the matching child-side request is canceled within a bounded period
- **AND** the child no longer counts it as a live subscription

#### Scenario: Diagnostics omit streamed content and secrets
- **WHEN** the system records a stream open, recovery, cancellation, or failure
- **THEN** the diagnostic record identifies the transport class and lifecycle outcome
- **AND** it does not contain streamed payloads, credentials, or sensitive query values
