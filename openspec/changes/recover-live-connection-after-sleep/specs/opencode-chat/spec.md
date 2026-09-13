## MODIFIED Requirements

### Requirement: Chat transport recovery is observable and self-correcting
The conversation and inventory event streams SHALL maintain transport liveness during normal idle periods and SHALL reconnect with bounded backoff after interruption. Opening a replacement stream MUST count as successful transport recovery even when no application event is immediately available: it SHALL reset consecutive-failure accounting and clear only the connection-interruption status owned by that stream. Keepalives MUST NOT appear as conversation or inventory events and MUST NOT alter projections, unread state, or timeline content.

The Chat surface MUST NOT continue to claim that it is reconnecting after its replacement stream has opened successfully. A later independent interruption MAY be reported normally. Resuming a suspended page or restoring network connectivity SHALL trigger authoritative inventory reconciliation and ensure the selected conversation's stream is current without discarding drafts, timeline position, or already received content.

A hidden page SHALL NOT permanently close the Chat surface. Chat MAY release its streams whenever the page is hidden, however the browser announces it, and MUST continue to save drafts on that signal, but it MUST remain able to resubscribe so that returning to a still-running page restores conversation and inventory delivery. Chat MUST NOT stay closed for the life of a document that is still running.

While Chat reports a connection interruption, it SHALL offer the user an action that attempts recovery, so a stalled surface is never a dead end on a device with no browser reload control. That action MUST NOT discard drafts, timeline position, or content already received when recovery succeeds in place.

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

#### Scenario: A backgrounded standalone Chat resubscribes when reopened
- **WHEN** a page installed to the home screen is backgrounded, the browser announces the hide in a form that does not promise a later restore, and the user reopens the still-running page
- **THEN** Chat resubscribes its inventory and selected conversation streams
- **AND** the composer draft written before the page was backgrounded is still present

#### Scenario: An interrupted Chat offers a way back
- **WHEN** Chat reports a connection interruption to the user
- **THEN** an action that attempts recovery is available from that report
- **AND** recovering in place leaves the draft, timeline position, and received content intact

#### Scenario: Client recoveries are independent
- **WHEN** one of multiple clients viewing the same conversation loses and restores its transport
- **THEN** that client resumes from its retained cursor or reconciles from a fresh snapshot as required
- **AND** the other clients' streams continue without interruption
