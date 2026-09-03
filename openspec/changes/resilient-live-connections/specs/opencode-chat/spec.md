## ADDED Requirements

### Requirement: Chat transport recovery is observable and self-correcting
The conversation and inventory event streams SHALL maintain transport liveness during normal idle periods and SHALL reconnect with bounded backoff after interruption. Opening a replacement stream MUST count as successful transport recovery even when no application event is immediately available: it SHALL reset consecutive-failure accounting and clear only the connection-interruption status owned by that stream. Keepalives MUST NOT appear as conversation or inventory events and MUST NOT alter projections, unread state, or timeline content.

The Chat surface MUST NOT continue to claim that it is reconnecting after its replacement stream has opened successfully. A later independent interruption MAY be reported normally. Resuming a suspended page or restoring network connectivity SHALL trigger authoritative inventory reconciliation and ensure the selected conversation's stream is current without discarding drafts, timeline position, or already received content.

#### Scenario: Idle reconnect clears stale interruption status
- **WHEN** a Chat stream is interrupted, reports a reconnecting status, and then opens successfully while no conversation event is emitted
- **THEN** the reconnecting status is cleared promptly
- **AND** the client does not wait for later assistant output to recognize recovery

#### Scenario: Successful open resets failure accounting
- **WHEN** a replacement Chat stream opens after one or more failed attempts
- **THEN** consecutive-failure accounting resets for that stream
- **AND** a later interruption begins a new recovery sequence rather than inheriting the old failure count

#### Scenario: Keepalive has no presentation effect
- **WHEN** an idle conversation or inventory stream emits a transport keepalive
- **THEN** no timeline item, inventory change, unread marker, or user-facing activity is produced

#### Scenario: Suspended Chat resumes from authoritative state
- **WHEN** a suspended page resumes after missing inventory or conversation events
- **THEN** Chat reconciles the authoritative inventory and ensures the selected conversation stream is current
- **AND** preserves drafts, timeline position, and content already received

#### Scenario: Client recoveries are independent
- **WHEN** one of multiple clients viewing the same conversation loses and restores its transport
- **THEN** that client resumes from its retained cursor or reconciles from a fresh snapshot as required
- **AND** the other clients' streams continue without interruption
