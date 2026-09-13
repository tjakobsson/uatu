## MODIFIED Requirements

### Requirement: Live document state recovers from interrupted client paths
The live document channel SHALL transmit transport keepalives often enough to prevent normal HTTP intermediaries from treating an otherwise idle stream as abandoned. A keepalive MUST NOT produce an application state update, change the current selection, trigger rendering, or advance state generation. After a channel error, the client MUST own a continuing reconnect cycle with bounded delay and MUST NOT depend indefinitely on a native connection object remaining in a connecting state. A replacement channel MUST deliver and apply a fresh authoritative state snapshot so file changes missed during the gap are reconciled.

When a suspended page resumes, a hidden page becomes visible, or the browser reports restored network connectivity, the client SHALL reconcile authoritative state and ensure that its live channel is current. Duplicate lifecycle signals and overlapping recovery attempts MUST converge to one effective current channel without allowing an older attempt to replace a newer connection.

A page being hidden SHALL NOT permanently end the client's ability to recover. The client MAY release its connection and cancel its pending work whenever the page is hidden, however the browser announces it, but MUST retain its subscriptions and cursors and MUST keep listening for the wake-up signals above, so that a page which is hidden and later shown again reconnects without a manual reload. The client MUST NOT treat any single lifecycle event as proof that the document will never run again; a document that is genuinely unloaded stops its own work.

Recovery work SHALL be individually bounded in time. Coalescing overlapping wake-up signals into one recovery MUST NOT let an unfinished recovery suppress later signals indefinitely: a recovery task that does not complete within a bounded period SHALL be abandoned, and the next wake-up signal SHALL be honoured.

#### Scenario: Idle intermediary path stays active
- **WHEN** a client has an open live document channel and no watched files change for an extended period
- **THEN** transport keepalives cross the Hub and any fronting reverse proxy at a bounded interval
- **AND** the client receives no spurious state update or document refresh from those keepalives

#### Scenario: Connecting state cannot strand recovery
- **WHEN** a live document channel reports an error and its native connection would otherwise remain in a connecting state indefinitely
- **THEN** the client replaces the failed channel after a bounded delay
- **AND** continues bounded reconnect attempts until a connection succeeds or the document stops running

#### Scenario: Reconnect applies authoritative state
- **WHEN** watched files change while a client's live document channel is interrupted
- **THEN** a successful reconnect applies a fresh state snapshot
- **AND** the sidebar and active preview converge on the current workspace state

#### Scenario: Resuming a suspended mobile page reconciles state
- **WHEN** a page resumes after suspension or returns to the foreground with an uncertain live-channel state
- **THEN** the client reconciles authoritative state and ensures that a current live channel is installed
- **AND** recovery does not require a manual page reload

#### Scenario: A backgrounded standalone page recovers when reopened
- **WHEN** a page installed to the home screen is backgrounded, the browser announces the hide in a form that does not promise a later restore, and the user reopens the still-running page
- **THEN** the client reconnects its live channel and reconciles authoritative state
- **AND** recovery does not require navigating away and back or reloading the page

#### Scenario: A hung recovery does not silence later wake-ups
- **WHEN** a recovery's state reconciliation never completes because the request is left unanswered
- **THEN** that recovery is abandoned within a bounded period
- **AND** a later visibility, resume, or network-restored signal starts a new recovery

#### Scenario: Duplicate wake signals converge
- **WHEN** page resume, visibility, and online signals arrive close together
- **THEN** overlapping recovery work converges to one current channel
- **AND** a stale recovery completion cannot replace the newer channel or state
