## ADDED Requirements

### Requirement: Burst delivery distinguishes reading clients from stalled clients
The hub SHALL let actively draining client streams receive a finite burst of ordered conversation events without disconnecting merely because the upstream delivered that burst in one chunk. This SHALL apply both to shared live delivery and subscriber catch-up. Delivery SHALL retain bounded outbound queues and SHALL end a genuinely stalled client rather than accumulating unbounded pending data. A released or superseded upstream MUST NOT publish additional frames after resuming from a delivery yield.

#### Scenario: A large normalization burst reaches a reading client
- **WHEN** a reading client watches a conversation and the upstream delivers thousands of small ordered events in one chunk exceeding the outbound backlog limit in aggregate
- **THEN** that client receives every event once in cursor order and its live stream remains open

#### Scenario: Catch-up receives a large replay chunk
- **WHEN** a reading client catches up from an older cursor and the child delivers a large replay in one chunk
- **THEN** the replay reaches that client in order before merging into live delivery without dropping the client stream

#### Scenario: A stalled client remains bounded
- **WHEN** a client stops pulling and conversation events exceed its queue limit
- **THEN** the hub ends that stream and releases its subscriptions

#### Scenario: Ownership ends during a delivery yield
- **WHEN** a stream or subscription is released while a child batch is being delivered
- **THEN** no remaining frame in that batch is delivered through the released owner
