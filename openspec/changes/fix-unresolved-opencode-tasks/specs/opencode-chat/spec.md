## ADDED Requirements

### Requirement: Complete native worker history repairs recoverable unresolved state

Fresh complete owned OpenCode V2 agent history and current execution evidence SHALL recover Working for a uniquely attributable active occurrence after an event-stream reconnect. Finished occurrences SHALL NOT compete with the current run; ambiguous running occurrences SHALL compete. Recovery SHALL preserve native notification ordering, revoked Stop authorization, post-gap observation verification and shell identity restrictions.

#### Scenario: Every recovery preserves ordering and authorization
- **WHEN** native worker recovery is evaluated
- **THEN** an older dated pending notification SHALL NOT invalidate a launch that begins after that notification
- **AND** recovered activity SHALL NOT restore revoked Stop authorization
- **AND** inventory-only last-seen observations SHALL NOT survive an observation gap without fresh verification
- **AND** shell recovery SHALL retain its existing native identity restrictions

#### Scenario: Same active execution after reconnect
- **WHEN** fresh complete owned history and active inventory uniquely identify the same agent execution after reconnect
- **THEN** its row becomes Working without duplicating the worker or restoring revoked Stop authority

#### Scenario: Resumed child with an older finished occurrence
- **WHEN** a child resumes after a completed occurrence and its older dated notification remains pending
- **THEN** the new unambiguous execution can remain Working beside the finished occurrence
- **AND** tied, straddling or clock-incomplete competing executions remain conservative

#### Scenario: Inventory observation becomes unavailable after disconnect
- **WHEN** the stream closes and fresh evidence cannot verify current activity
- **THEN** a cached inventory-only last-seen timestamp is not presented as continuing evidence

### Requirement: Explicit child outcomes settle only their uniquely attributed occurrence

Complete owned child history with an explicit native idle outcome SHALL recover Completed for `succeeded`, Failed for `failed`, and Stopped for `interrupted` only when exactly one unambiguous agent occurrence belongs to that execution interval. Recovery SHALL fabricate neither a parent result ID nor summary nor report timestamp, and SHALL NOT override an explicit parent report.

#### Scenario: Every outcome attribution enforces execution boundaries
- **WHEN** a child outcome is evaluated for attribution
- **THEN** its complete admission window MUST lie strictly after the preceding idle boundary, if any, and before the first enclosing idle boundary
- **AND** potentially overlapping occurrences, including already-terminal occurrences and unknown admission windows, MUST block attribution
- **AND** a later invocation positively separated by its native start and an intervening boundary SHALL NOT block an earlier proven outcome merely because its acceptance clock is missing
- **AND** bare idle, unknown outcomes and aggregate session activity SHALL NOT prove a task result

#### Scenario: Parent notification is missing
- **WHEN** complete owned child history uniquely attributes an explicit succeeded, failed or interrupted outcome to a launcher with no parent notification
- **THEN** reload and reconnect recover its corresponding terminal status without an extra unresolved row or invented report content

#### Scenario: Attribution is ambiguous
- **WHEN** clocks are missing, tied, malformed or straddling, ownership is unverified, or another occurrence could share the interval
- **THEN** the outcome does not settle that occurrence

#### Scenario: Child has separate executions
- **WHEN** native admission windows and idle boundaries uniquely separate multiple executions of one child
- **THEN** each explicit outcome settles only its matching occurrence
- **AND** a later clock-incomplete invocation with a proven later native start remains unresolved without blocking the earlier outcome
