## ADDED Requirements

### Requirement: Explicit worker dismissal batches are conditional and atomic

The Hub SHALL accept a bounded explicit set of exact execution identities and their independent expected revisions for one account, workspace and conversation. A successful batch SHALL persist all selected dismissals atomically before reporting success and SHALL publish one presentation outcome rather than a per-worker countdown. Duplicate targets, stale revisions, unverified identities or positive active evidence SHALL NOT produce a partially dismissed batch. Trusted positive activity SHALL continue retiring old marks even when the requested dismissal is refused. Storage failure SHALL retain prior durable dismissals and report uncertainty without claiming success. Selection changes and activity received during a save SHALL retain their existing visibility fences.

#### Scenario: Large finished group beside unresolved work
- **WHEN** a user dismisses 285 finished workers beside five unresolved workers
- **THEN** one bulk save dismisses the eligible exact occurrences together
- **AND** the unresolved workers, active requests and underlying history remain unchanged
- **AND** reopening the conversation preserves successful dismissals

#### Scenario: Concurrent activity or stale revision
- **WHEN** any selected occurrence becomes active or its expected revision becomes stale before the batch's conditional validation
- **THEN** none of the selected dismissal changes is partially applied
- **AND** verified activity continues overriding old marks for every affected account

#### Scenario: Activity during persistence
- **WHEN** positive activity arrives after conditional validation while an atomic save is in flight
- **THEN** the existing observation authority retires the affected saved marks durably
- **AND** the observing client keeps those active occurrences visible

#### Scenario: Request abandonment during first persistence
- **WHEN** a first batch save is in flight and its request is abandoned
- **AND** positive activity arrives before or after abandonment while persistence continues
- **THEN** the disk operation retains independent observation ownership until it drains
- **AND** any committed affected marks are durably retired rather than remaining hidden after reload

#### Scenario: Durable write failure
- **WHEN** the batch cannot be durably saved
- **THEN** the client reports failure, retains or restores all affected rows and does not claim cross-device success

### Requirement: Dismissal evidence is compact and completely authoritative

Dismissal SHALL use a complete current authoritative worker projection without transporting ordinary transcript text, prompts or tool output. Compact evidence SHALL preserve exact occurrence identities, aliases, launcher reconciliation and positive-activity semantics across all source pages. Incomplete, contradictory, changed, malformed or over-capacity evidence SHALL fail closed rather than authorize dismissal. Existing evidence-count, identifier and storage safety bounds SHALL NOT be relaxed to accommodate transcript volume.

#### Scenario: Long transcript and large output
- **WHEN** a complete authoritative source contains the selected finished workers alongside more than twenty display-history pages or a tool output larger than four MiB
- **THEN** dismissal reads one compact worker-evidence outcome without serializing the transcript pages or output
- **AND** evidence coverage is proven before any dismissal is authorized

#### Scenario: Incomplete source
- **WHEN** authoritative source completeness or currentness cannot be established within its bounded read
- **THEN** dismissal fails visibly and no selected dismissal is applied

### Requirement: Personal worker dismissal resource supports bounded bulk writes

The versioned personal worker dismissal resource SHALL support a closed bulk-dismissal request selecting one conversation and a nonempty bounded list of unique exact execution identities with expected revisions. The account and workspace SHALL continue coming only from existing authenticated routing. Existing singleton dismiss and retirement requests SHALL remain supported. Bulk writes SHALL have documented count and byte bounds and reject malformed, oversized, stale, foreign, unavailable or over-capacity requests without partial dismissal. Responses and private invalidations SHALL retain existing account isolation and no-store semantics.

#### Scenario: One bulk response
- **WHEN** an authorized caller submits a valid eligible group
- **THEN** one response confirms the durable state for the whole group after a single atomic save
- **AND** another account's state is not disclosed or altered by the dismissal

#### Scenario: Invalid bulk request
- **WHEN** a request contains duplicate targets, mixed unsupported fields, no targets, excess targets or an oversized body
- **THEN** the resource returns its documented validation or size failure before reading authoritative evidence or mutating dismissal state
