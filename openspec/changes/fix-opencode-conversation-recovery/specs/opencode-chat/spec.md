# Spec Delta

## MODIFIED Requirements

### Requirement: OpenCode V2 worker state recovers without relying on provider event replay
Opening or returning to a conversation, reconnecting after missed provider events, or replacing an expired Uatu stream cursor SHALL reconcile its known background work against provider-owned history, pending notifications, and available current execution evidence. The final snapshot and subsequent stream SHALL agree without duplicate workers or state regression. Recovery SHALL include launches and results outside the initially visible history page and work launched from another client. Parent idleness, an absent child from an active-only listing, or a failed read SHALL NOT alone establish a worker's terminal state.

Recovery SHALL be read-only with respect to execution: it MUST NOT prompt, interrupt, relaunch, or background work. After a service/workspace restart, completed provider history SHALL remain inspectable and unresolved work SHALL be revalidated; Uatu MUST NOT promise continued execution solely because a pre-restart launch exists.

#### Scenario: Completion is missed while disconnected
- **WHEN** a worker completes while the V2 event connection is absent and the provider offers no replay
- **THEN** reconnect recovers its terminal result from history or pending notification state
- **AND** the worker does not remain running indefinitely or become falsely cancelled from list absence

#### Scenario: Completion races a stale snapshot
- **WHEN** a worker terminal event arrives while recovery is reading an older running launch
- **THEN** applying recovery and the event stream leaves one terminal worker with its report

#### Scenario: Navigation and pagination preserve the worker
- **WHEN** the user switches sessions or workspaces, then returns to a parent whose launch is on an older page
- **THEN** current worker state and its child inspection link are available without manually loading every older page
- **AND** loading older pages does not duplicate the worker

#### Scenario: Another client launches work
- **WHEN** native background work is launched in a confined parent by another OpenCode client while Uatu is disconnected
- **THEN** Uatu discovers that work when it next reconciles the parent or workspace activity

#### Scenario: Restart has inconclusive execution evidence
- **WHEN** persisted history contains a background launch but current provider evidence cannot establish whether it survived a restart
- **THEN** Uatu reports uncertainty and retains available history without claiming durable execution or fabricating a final result

#### Scenario: Child lookups are unavailable while parent history is readable
- **WHEN** the parent's authoritative session and transcript reads succeed but child ownership or execution-history enrichment is unavailable, including under lookup-capacity pressure
- **THEN** the parent's own transcript remains readable without waiting indefinitely for child enrichment
- **AND** unavailable child checks neither expose unverified child content or controls nor establish completion, cancellation, or complete worker inventory
- **AND** a later successful read can restore verified child details without restarting the agent

#### Scenario: Required parent history is unavailable
- **WHEN** the parent's authoritative transcript or required session read fails, or the caller cancels the read
- **THEN** Uatu reports a failed or cancelled read rather than presenting a successful empty or incomplete parent transcript

#### Scenario: Optional and required readers share a child transcript
- **WHEN** optional enrichment and a required history reader share a pending child transcript read, and the optional reader's deadline expires first
- **THEN** the required reader can still receive the healthy transcript within its own read window without a duplicate transport request
- **AND** each reader's cancellation releases only its own interest; shared transport is retired when no reader remains
- **AND** cancelled or superseded shared reads cannot populate current history reuse or remove a newer pending read

#### Scenario: Partial child enrichment preserves native revert visibility
- **WHEN** child enrichment fails for either the visible prefix or the complete transcript while a native revert boundary is staged
- **THEN** missing child metadata alone does not authorize removal of a worker whose native origin remains visible
- **AND** a previously projected settled worker whose native origin is hidden does not merge back into the transcript merely because its child metadata is unavailable
- **AND** independently verified live detached work retains its existing visibility and control protections

#### Scenario: A reverted result was previously a fallback notice
- **WHEN** unavailable child ownership caused a delivered result to be retained as a fallback notice, and a later native revert hides that result
- **THEN** authoritative removals include the fallback identity whether ownership remains unavailable or recovers and changes the result's normalized identity
- **AND** neither the history response nor the next subscription snapshot exposes the hidden fallback result
- **AND** visible-prefix origins and independently verified live work retain their existing safeguards

#### Scenario: A visible result changes presentation during enrichment recovery
- **WHEN** a retained or recovered verified worker and a fallback notice represent the same native result, either after a healthy result degrades during reconnect or after a cold degraded read recovers
- **THEN** history and subscription snapshots contain one presentation of that result rather than both rows
- **AND** the fallback notice is superseded in the retained projection and its removal is delivered to existing subscribers
- **AND** notices without a corresponding verified worker and unrelated notices/results remain visible, while canonical worker aliases, stream fences, ownership/Stop, and native live/revert safeguards remain intact

#### Scenario: Authoritative history is slower than a worker check
- **WHEN** the parent's authoritative history succeeds within its bounded history-read window but takes longer than the short worker-recovery budget
- **THEN** the conversation loads without treating that short worker budget as a deadline for the entire transcript
- **AND** history timeout or loss of the covering event-stream generation still rejects the read rather than returning an unfenced snapshot

#### Scenario: Child accounting is unavailable after ownership succeeds
- **WHEN** the parent's authoritative history and child ownership reads succeed but reconstructing child accounting or nested accounting does not complete within its bounded optional-read window
- **THEN** the parent history read succeeds with the accounting already available rather than failing or reporting missing amounts as zero or complete
- **AND** late results from a cancelled, expired, or superseded accounting read do not overwrite current accounting or mark an incomplete reconstruction complete
- **AND** a later successful read can restore verified accounting without restarting the agent or replaying a mutation

#### Scenario: Visible descendant enrichment is temporarily incomplete
- **WHEN** child history returns known own accounting but unavailable optional enrichment leaves its visible descendant topology incomplete on any reconstruction page
- **THEN** Uatu retains the known own accounting without marking the descendant reconstruction complete
- **AND** a later parent refresh retries the incomplete reconstruction and can restore verified nested accounting immediately after ownership recovers, without waiting for the completeness cache to expire
- **AND** if a previously complete nested tree becomes incomplete on refresh, its older completeness stamp does not make the current reconstruction or its ancestors complete
- **AND** enrichment failures confined to a reverted hidden suffix do not make the visible accounting tree incomplete
