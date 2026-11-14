## MODIFIED Requirements

### Requirement: Worker recovery retains consumed child-history authority through publication

For OpenCode outcomes without a parent report, recovery SHALL record each parent/child session's change counter before its first request and publish the outcome only if those counters are unchanged at publication. Any differing native observation SHALL advance that session's counter regardless of request order. A mismatch SHALL drop only that outcome and leave its row Unresolved, without retrying or failing the parent read. Explicit parent reports and activity recovery SHALL remain unaffected.

#### Scenario: A session changes before inferred-outcome publication
- **WHEN** an outcome without a parent report is ready to publish and a recorded parent or child counter has changed
- **THEN** only that outcome SHALL be omitted and its worker row SHALL remain Unresolved
- **AND** the change SHALL neither retry the outcome nor fail or restart the parent history read
- **AND** the fallback SHALL NOT inherit dismissal permission from the discarded inference
- **AND** its public worker row SHALL retain `outcomeWithheld: true` as deny-only evidence until fresh authoritative terminal evidence replaces it

#### Scenario: Child terminal outcome is reverted during parent recovery
- **WHEN** parent recovery has consumed a child idle outcome and an observed native child revert removes it before publication
- **THEN** the changed child counter SHALL withhold that inferred outcome and leave its row Unresolved
- **AND** the mismatch SHALL NOT retry or fail the parent history read
- **AND** a subsequent independent fresh read SHALL reflect the child's current history

#### Scenario: A different observation arrives from an older or overlapping request
- **WHEN** any native history, session-record, inbox, active-inventory or SSE observation differs from its session's last known native state
- **THEN** that session's counter SHALL advance regardless of request ownership, start time or completion order
- **AND** an identical replay of already-known native state SHALL NOT advance the counter

#### Scenario: Child evidence changes while another conversation is read
- **WHEN** a child transcript changes during a recovery that does not depend on that child
- **THEN** the unrelated recovery retains its own source authority

#### Scenario: Explicit reports and activity remain independent
- **WHEN** a session counter changes while recovery has an explicit parent report or independently verified activity
- **THEN** the inferred-outcome counter rule SHALL NOT change that report's authority or activity recovery
- **AND** existing Stop, ownership and replay safeguards SHALL remain in effect

#### Scenario: A withheld outcome reaches an automatic recovery deadline
- **WHEN** a recovery publishes only counter-withheld outcomes with no independent inconclusive activity and no new external trigger
- **THEN** expiry of a recovery retry deadline SHALL NOT start another native read because those outcomes were withheld
- **AND** independently needed activity recovery and later external triggers SHALL retain their existing behavior

#### Scenario: An older inbox response follows newer cold activity
- **WHEN** an older inbox request returns different or overflowing evidence after a newer source has captured independently verified Working activity
- **THEN** the differing observation SHALL still advance the inferred-outcome session counter
- **AND** it SHALL NOT replace the newer activity baseline or revoke that source solely by arriving later
- **AND** genuinely newer activity counterproof SHALL retain its existing authority

## ADDED Requirements

### Requirement: Recovery verification preserves observed negative execution evidence

Seeded verification SHALL compare results, native report fields and activity with cold recovery of final native state, or require Unresolved. It MAY allow extra conservative warnings but SHALL NOT lose warnings required by final evidence. Separate checks SHALL reject unsupported Stop or dismissal and retain observed revocations. Witnesses SHALL derive from consumed native inputs or events, not published certainty or private ledgers. Parent reads SHALL meet a fixed attempt bound while streaming.

#### Scenario: Revert removes an already observed execution end
- **WHEN** consumed native execution evidence revoked Stop and a later revert removes that evidence from final history
- **THEN** an independent authority check SHALL retain that observed negative context separately from cold final-state recovery
- **AND** valid Working activity SHALL NOT restore Stop or be suppressed merely to equal an empty provider's certainty flag
- **AND** a control without the negative observation SHALL NOT inherit the revocation

#### Scenario: A publication is more cautious than cold recovery
- **WHEN** its result, native report fields and current activity match final recovery but its uncertainty warning is more conservative
- **THEN** verification MAY accept the extra warning without replaying prior reads or provider cache invalidations
- **AND** it SHALL still reject unsupported Stop, unsafe dismissal, lost required warnings or a noncanonical withholding-marker wire shape

#### Scenario: A history read shares or reuses a native load
- **WHEN** concurrent readers share native history or one reader reuses a cached array
- **THEN** its oracle witness SHALL identify the history actually consumed by that reader
- **AND** another request's ownership or a globally last-seen path SHALL NOT substitute different history into that witness

#### Scenario: Event normalization awaits native metadata
- **WHEN** an event operation waits for a metadata response
- **THEN** the ordering model SHALL allow independent native mutations, public observations and unrelated jobs to progress before that response completes
- **AND** preserving a synchronous prefix SHALL NOT serialize the entire asynchronous operation

#### Scenario: A failing ordering is reduced
- **WHEN** optional actions are deleted to produce a smaller representative
- **THEN** that final representative SHALL undergo its own strict replay before being labelled a replay match
- **AND** verification of the unreduced trace SHALL NOT be reported as verification of the reduced trace
