## MODIFIED Requirements

### Requirement: The stream opens at once and recovers on one channel
The stream SHALL send its first bytes immediately on open so the browser's connection reports open before any application event exists, and SHALL emit transport keepalives at a bounded interval while idle. After an error the client SHALL own a bounded-backoff reconnect of the one stream, presenting every retained topic cursor, and lifecycle wake-ups (a suspended page resuming, a hidden page becoming visible, restored network connectivity) SHALL reconcile authoritative state and re-establish the one stream — overlapping signals converging to one current connection. Recovery MUST NOT discard drafts, timeline position, content already received, or the previewed document.

Releasing the stream because the page is hidden SHALL be reversible. The page MAY drop the connection and cancel its pending reconnect whenever it is hidden, but it MUST keep every subscription and topic cursor and MUST remain able to reconnect, so the next wake-up resumes each topic from where it stopped. Only a document that has actually stopped running ends the cycle; no lifecycle event SHALL be read as a promise that the document will never run again.

#### Scenario: An idle stream is open immediately
- **WHEN** a client opens the stream for a workspace where nothing is happening
- **THEN** the connection reports open within a bounded period well under the keepalive interval

#### Scenario: One reconnect resumes every topic
- **WHEN** the stream drops while a conversation is selected and files are changing
- **THEN** a single replacement connection resumes the document and conversation topics from their retained cursors
- **AND** the conversation timeline, its draft, and its reading position are preserved

#### Scenario: A released stream resumes after the page returns
- **WHEN** a page releases its stream because it was hidden, and is later shown again
- **THEN** one replacement connection resumes every topic the page still subscribes from its retained cursor
- **AND** no subscription is lost because of how the browser announced the hide
