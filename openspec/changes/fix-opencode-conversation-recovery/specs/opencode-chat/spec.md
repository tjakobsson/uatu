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

#### Scenario: A concurrent delivery update omits the original client nonce
- **WHEN** a covered history read owns the original native-message-to-request correlation and a newer concurrent native user row without that client nonce wins the live merge, including under projection or cache pressure
- **THEN** history and the following subscription retain the original request identity for that exact native message while preserving the newer content
- **AND** unrelated native messages do not acquire that identity, and correlation retention remains bounded

#### Scenario: An oversized settled result is unchanged across handoff
- **WHEN** a recovered snapshot contains a settled worker result larger than the replay retention window, covers the current accounting/progress updates, and no further updates intervene
- **THEN** subscribing from that snapshot cursor does not request a retention-gap resync merely because the snapshot includes the oversized result
- **AND** genuine later progress that exceeds replay retention can still require authoritative resynchronization

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

#### Scenario: Saturated ownership capacity cannot make optional accounting progress
- **WHEN** retained work is reconciled while cancelled but unsettled ownership lookups still occupy every optional lookup slot
- **THEN** parent history remains readable without repeatedly restarting recovery because its own optional accounting reads confirm an unchanged association
- **AND** genuine concurrent ownership counterproof still invalidates affected reads, and later reads can recover details after capacity becomes available

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

#### Scenario: Undo replacement receives incomplete worker enrichment
- **WHEN** undo hides a later user message while an earlier settled worker's native origin remains visible and child enrichment is temporarily unavailable
- **THEN** reversible projection replacement and the next subscription snapshot retain the worker's appropriate verified presentation, known accounting, and inspection identity rather than deleting them from page absence alone
- **AND** explicit hidden-origin exclusions still remove reverted work, with existing independently live-work overrides
- **AND** retained presentation does not renew Stop authority, bypass current contradictions, or allow cancelled or superseded reconciliation to replace current state

#### Scenario: Another client commits a revert before the staged view is read
- **WHEN** current authoritative native history has already dropped a reverted suffix before Uatu reads any staged boundary or exclusions
- **THEN** replacement does not resurrect discarded settled workers, their reports, accounting presentation, or inspection targets from the retained projection merely because current history has no exclusions
- **AND** separate exact raw-native-origin coverage distinguishes committed-away origins from visible workers omitted by optional enrichment; normalized page absence, shared child identity, and projected ordering alone do not authorize deletion or retention
- **AND** positively recovered inbox work and independently live work retain their existing provenance, uncertainty, and control safeguards

#### Scenario: Foreground metadata survives unavailable child enrichment
- **WHEN** an exact earlier foreground subagent tool remains visible during undo and its previously verified child enrichment is temporarily unavailable
- **THEN** replacement and subscription retain the tool's known child inspection identity, model, and accounting rather than treating stripped optional fields as authoritative deletion
- **AND** hidden origins, changed occurrences, current ownership contradictions, returned-page authority, and newer live metadata keep their existing precedence; retained metadata grants no new Stop authority

#### Scenario: Older foreground accounting remains on the first page
- **WHEN** a previously verified foreground subagent is older than the newest history page and child enrichment is temporarily unavailable during reconnect
- **THEN** the first snapshot includes that exact visible foreground accounting carrier and agrees with the following subscription, while preserving the newest message page and older cursor
- **AND** cold or unrelated retained rows, changed or ambiguous occurrences, hidden origins, and contradicted associations are not admitted; current accounting and newer live metadata retain precedence

#### Scenario: Expired accounting does not price a changed foreground invocation
- **WHEN** completeness expires for a previously priced foreground launcher, its input or occurrence changes, child ownership succeeds, and current optional accounting expires
- **THEN** history and the following subscription do not assign the earlier invocation's cached task usage or model to the changed launcher, including for a single-row cohort
- **AND** exact retained membership and launcher bindings may preserve unchanged task receipts, including siblings and bindings reconstructed before opening the child timeline; last-known worker-session aggregates remain separate
- **AND** a native tool update processed before history begins does not make its changed binding provenance for older retained accounting, while its newer presentation remains visible
- **AND** accounting-transcript eviction does not allow retained projection merging to restore a withdrawn stale task receipt in the following subscription
- **AND** late responses and usage/model restatements do not reauthorize changed task accounting; completed current accounting restores verified task values, including authoritative zero, under the existing source and publication fences

#### Scenario: Concurrent foreground progress preserves complete attribution order
- **WHEN** two foreground calls share a child and one call receives a newer native update while optional child enrichment is unavailable
- **THEN** the complete attribution order includes the current exact association so the other call does not absorb the child's entire known usage or double-count spend after the live merge
- **AND** ordering evidence neither overwrites the newer row nor admits it through fallback carrier restoration; occurrence, visibility, contradiction, cancellation, generation, and control safeguards remain intact
- **AND** if only one call changes occurrence or input and the child's allocation cohort is no longer proven complete, history and live decoration withhold aggregate redistribution rather than charging it to the surviving sibling; exact current values remain available, mismatched values stay unknown, and fresh authoritative accounting retains precedence
- **AND** after degraded history withdraws an association, a subsequent usage/model restatement or successful ownership lookup alone does not restore allocation eligibility; only coherent current cohort evidence can do so, within the existing bounded attribution lifetime
- **AND** recursive ancestor attribution applies the same eligibility checks at each child edge, preserving known own spend and exact current descendant amounts without restoring withdrawn or mismatched attribution
- **AND** deeper descendants retain only proven current parent-task bindings, including occurrence identity; a blocked or unresolved cohort does not provide positional binding authority at any depth

#### Scenario: A pending fallback outlives optional inventory recovery
- **WHEN** a confined result remains pending in the inbox, required transcript and pending-inbox reads succeed, and optional active-worker recovery expires before delivery
- **THEN** history and the following subscription retain the current pending fallback text, including authoritative payload updates
- **AND** enqueue-only materialization does not authorize deletion from stored-history absence; stored/delivered provenance and pending evidence remain distinct
- **AND** pending text grants no inspection, completeness, activity, or Stop authority, while failed required pending reads still reject recovery without erasing known presentation

#### Scenario: Pending delivery changes the fallback presentation clock
- **WHEN** an exact pending fallback is delivered while disconnected and its stored result has a different timestamp
- **THEN** a recovered verified worker supersedes the previously recorded exact fallback relation in history and subscription, including removal for existing subscribers
- **AND** observed stored provenance follows that exact native result so a later committed removal cannot restore the old pending notice
- **AND** changed or unrelated notice content, result/child mismatches, and concurrent newer changes do not acquire removal authority from timestamp tolerance

#### Scenario: A reverted result was previously a fallback notice
- **WHEN** unavailable child ownership caused a delivered result to be retained as a fallback notice, and a later native revert hides that result
- **THEN** authoritative removals include the fallback identity whether ownership remains unavailable or recovers and changes the result's normalized identity
- **AND** neither the history response nor the next subscription snapshot exposes the hidden fallback result
- **AND** visible-prefix origins and independently verified live work retain their existing safeguards

#### Scenario: A visible launcher and its result straddle a revert boundary
- **WHEN** a worker's launch remains visible but its later stored result is authoritatively hidden or committed away
- **THEN** replacement retains only the appropriate visible-launch presentation, not the discarded result's report or result-derived terminal fields, whether optional enrichment succeeds or is unavailable
- **AND** independently current inbox or execution evidence keeps its own visibility and control safeguards

#### Scenario: Fresh ownership evidence contradicts a retained child association
- **WHEN** a fresh child lookup positively reports a different parent or workspace during replacement reconciliation
- **THEN** retained worker and tool presentations do not restore that contradicted child inspection or accounting association
- **AND** parent-owned historical text can remain without the contradicted association, while unavailable optional lookups alone do not establish that contradiction
- **AND** cancelled or superseded reads cannot revoke or restore associations on behalf of a newer view

#### Scenario: A visible result changes presentation during enrichment recovery
- **WHEN** a retained or recovered verified worker and a fallback notice represent the same native result, either after a healthy result degrades during reconnect or after a cold degraded read recovers
- **THEN** history and subscription snapshots contain one presentation of that result rather than both rows
- **AND** the fallback notice is superseded in the retained projection and its removal is delivered to existing subscribers
- **AND** notices without a corresponding verified worker and unrelated notices/results remain visible, while canonical worker aliases, stream fences, ownership/Stop, and native live/revert safeguards remain intact

#### Scenario: Current report text changes during unavailable child enrichment
- **WHEN** a retained completed worker's native pending or stored report changes text while child ownership enrichment is unavailable
- **THEN** current parent-owned report text remains visible in history and subscription; matching result/child identity alone does not let the worker's old summary suppress the fresh fallback
- **AND** unchanged normalized report content can still be superseded across delivery-clock changes, without granting new activity, inspection, accounting, ownership, or control authority

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
