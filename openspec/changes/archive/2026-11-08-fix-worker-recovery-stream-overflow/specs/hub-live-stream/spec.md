# Spec Delta

## ADDED Requirements

### Requirement: Bulk conversation recovery does not simulate an upstream outage
An actively consuming conversation subscriber SHALL receive a bulk recovered change as ordered complete delivery or explicit topic-scoped resynchronization, without overflow-induced unavailability caused solely by the publication burst. Delivery and replay queues SHALL remain byte-bounded. Other topics and the page's one live connection MUST remain independent.

#### Scenario: Clustered ordinary worker results reach a healthy reader
- **WHEN** an actively draining conversation stream receives a recovery containing 318 worker results of about 4 KiB each, with ordinary-sized events and no transport failure
- **THEN** the subscriber receives the ordered changes or an explicit conversation resync followed by a complete fresh snapshot
- **AND** the burst alone does not produce conversation unavailability or a transport-error retry cycle
- **AND** the stream's other topics continue to deliver

#### Scenario: A smaller recovery fits bounded incremental delivery
- **WHEN** the equivalent worker-result recovery fits the incremental publication budget
- **THEN** its changes arrive in order with consistent cursors
- **AND** publication does not require unnecessary resynchronization

#### Scenario: A large batch requires explicit snapshot recovery
- **WHEN** recovered changes cannot be delivered within the bounded incremental budget
- **THEN** the stream explicitly invalidates that conversation after the complete recovery commit
- **AND** no published prefix is presented as the complete batch
- **AND** an older cursor cannot silently skip the withheld changes

#### Scenario: A consumer genuinely stops reading
- **WHEN** a subscriber stops consuming while ordered events continue beyond its existing byte backlog limit
- **THEN** it is terminated within that bound rather than retaining an unbounded queue
- **AND** other subscribers remain usable

#### Scenario: Cancellation or replacement happens around recovery
- **WHEN** a conversation subscription is cancelled or replaced while recovery is prepared
- **THEN** obsolete delivery stops and its resources are released
- **AND** the current subscription receives only events belonging to its own ordered cursor history

#### Scenario: The child actually fails
- **WHEN** the child exits or its transport fails independently of a valid bulk publication
- **THEN** existing topic-scoped unavailability and bounded retry behavior still apply
- **AND** the page's live connection and unrelated topics are not ended
