# Spec Delta

## ADDED Requirements

### Requirement: Recovered conversation publication preserves authority
Recovered conversation state SHALL be admitted as a coherent commit under current source and mutation ownership. A stale or superseded read MUST NOT overwrite newer native facts or advance delivery state. Controlling publication size MUST NOT weaken activity evidence, worker execution identity, or dismissal conflict checks.

#### Scenario: New native evidence arrives during a recovery read
- **WHEN** a recovery read overlaps a newer worker update or removal
- **THEN** recovery preserves the newer owned fact
- **AND** delivery cannot restore a removed execution or its mutation authority from stale source data

#### Scenario: Recovery loses ownership before commit
- **WHEN** a read's stream generation, projection, source coverage or mutation ownership is superseded before admission
- **THEN** that result cannot change conversation state or its stream cursor
- **AND** it cannot issue a resync on behalf of the superseded result

#### Scenario: Equivalent presentation has different private evidence
- **WHEN** a valid read refreshes private worker proof without changing effective displayed values
- **THEN** the proof is handled under existing authority rules
- **AND** avoiding redundant publication does not grant dismissal or activity authority absent from that proof

### Requirement: Bulk snapshot recovery converges on current conversation state
When bulk recovery requires a fresh snapshot, that snapshot SHALL represent the complete admitted state and its cursor. Reattaching from it SHALL resume later updates without regenerating invalidation solely because the same source is read again. Read recovery MUST NOT repeat mutations or discard retained drafts and reading position.

#### Scenario: Oversized recovery is followed by unchanged reads
- **WHEN** a client obtains the post-commit snapshot, reattaches, and three further reads return equivalent effective state
- **THEN** those unchanged reads cause no additional resync or unavailability
- **AND** a later native update is delivered and applied once in order

#### Scenario: A snapshot is requested during a bulk commit
- **WHEN** a snapshot or subscription is observed at a bulk publication boundary
- **THEN** it names either the complete prior state or the complete admitted state with the matching cursor
- **AND** it cannot expose a partially admitted batch as current

#### Scenario: A bulk commit cannot complete
- **WHEN** recovery preparation or admission fails
- **THEN** no partial recovery batch is announced as committed
- **AND** a subsequent valid recovery can proceed without stranded publication state

#### Scenario: Activity and private dismissals coexist with recovery
- **WHEN** a conversation with working tasks, terminal tasks, fresh activity and existing account-private dismissal marks recovers
- **THEN** their existing activity and dismissal eligibility rules remain unchanged
- **AND** recovery neither replays a dismissal mutation nor accepts a conflict merely because execution generation changed
