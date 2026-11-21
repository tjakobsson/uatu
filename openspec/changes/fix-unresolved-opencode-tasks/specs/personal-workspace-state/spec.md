## ADDED Requirements

### Requirement: Dismissal evidence fetch permits the covered-history budget

The Hub SHALL allow 30 seconds for child worker-evidence fetching, accommodating the default 25-second covered-history budget plus transport margin. This fetch deadline SHALL NOT be represented as an end-to-end response guarantee including lifecycle queues, runtime initialization and persistence. Evidence failure SHALL retain existing fail-closed behavior, authenticated private scope, revision checks and no-store semantics.

#### Scenario: Any valid response within the fetch deadline follows normal checks
- **WHEN** a valid evidence response arrives after the former 10-second deadline but within the fetch deadline
- **THEN** it SHALL proceed through normal validation and reconciliation

#### Scenario: Valid evidence takes more than ten seconds
- **WHEN** valid authoritative evidence arrives after 10.2 seconds with other read prerequisites satisfied
- **THEN** the authenticated personal-dismissal read succeeds instead of failing at the former deadline
- **AND** no provider mutation or evidence-validation bypass occurs

#### Scenario: Evidence remains unavailable
- **WHEN** complete authoritative evidence cannot be obtained within its bounded fetch
- **THEN** dismissal fails without treating browser-cached marks as authoritative or replaying dismissal writes
