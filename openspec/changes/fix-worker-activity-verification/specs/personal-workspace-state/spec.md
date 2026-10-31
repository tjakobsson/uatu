# Spec Delta

## ADDED Requirements

### Requirement: Worker dismissals are private durable account state
The Hub SHALL persist worker-summary dismissals for the authenticated account, stable workspace, agent-qualified conversation and exact execution. Marks SHALL survive Hub/workspace restarts, synchronize across that account's devices and never apply to another account or execution. Provider history, task lifecycle, navigation and geometry SHALL remain unchanged.

#### Scenario: Same account uses two devices
- **WHEN** one device successfully dismisses an unavailable execution and another connected device for the same account shows that workspace and conversation
- **THEN** both converge on the dismissed summary without reload or manual status checking
- **AND** reconnecting or reopening on that account retrieves the same durable marks

#### Scenario: Accounts and executions are isolated
- **WHEN** another account views the workspace, or a new execution reuses the same child session
- **THEN** the first account's old dismissal hides neither the other account's row nor the new execution

### Requirement: Personal dismissal mutations use authenticated scope and atomic storage
Dismissal reads/writes SHALL derive the account from Hub authentication, validate workspace/conversation/execution scope, reject caller-selected accounts and protect cookie mutations against cross-origin requests. Concurrent dismissals SHALL merge without losing unrelated marks. Successful responses SHALL reflect durable atomic saves; failure SHALL NOT claim synchronization or silently substitute device-local success.

#### Scenario: Concurrent devices dismiss different executions
- **WHEN** two authorized devices dismiss different executions concurrently
- **THEN** both durable marks remain present and repeated additions are idempotent
- **AND** unrelated personal preferences remain unchanged

#### Scenario: Unauthorized or malformed mutation
- **WHEN** a request selects another account, has invalid or oversized identifiers, targets an unavailable workspace, or violates cookie-origin protection
- **THEN** the Hub refuses it without a provider mutation or disclosure of another account's marks

#### Scenario: Persistence is unavailable
- **WHEN** a dismissal cannot be durably stored
- **THEN** the client reports that it could not save the dismissal and leaves or restores the row
- **AND** it does not claim cross-device success or treat the failure as a worker failure

### Requirement: Personal dismissal invalidations do not disclose other accounts
Connected clients SHALL receive dismissal changes only within their authenticated account and authorized workspace scope, then reconcile authoritative personal state. Personal marks SHALL NOT enter shared workspace activity or conversation payloads. Missed invalidations SHALL recover on reconnect or conversation selection without changing navigation, disclosure choices or focus.

#### Scenario: Workspace is shared by two accounts
- **WHEN** account A changes a dismissal while A and B subscribe to the same workspace
- **THEN** only A's authorized clients receive its personal invalidation and can read its marks
- **AND** B's activity stream, summary visibility and personal-state responses reveal no information about A's dismissal

#### Scenario: Client misses the dismissal update
- **WHEN** an account reconnects after another device dismissed work
- **THEN** its authoritative personal-state read converges without replaying any execution mutation

### Requirement: Dismissal storage preserves execution identity through recovery
Dismissal identity SHALL remain stable through pagination, live/history reconciliation and restart, but SHALL NOT be based on child session ID alone or an ambiguous alias. Marks SHALL be bounded with explicit failure rather than silently dropping committed dismissals. Verified activity SHALL override stale marks; successful retirement SHALL require a later explicit action to dismiss again. Failed retirement SHALL follow the availability policy below. Forgetting a workspace SHALL clear its marks for all accounts.

#### Scenario: Alias folds or result arrives
- **WHEN** another representation of the same positively identified execution is recovered
- **THEN** it retains the same dismissal scope without hiding any unrelated occurrence
- **AND** an ambiguous identity is not persisted as a broad session-level dismissal

#### Scenario: Activity wins a race with dismissal
- **WHEN** verified activity or a linked blocking request is newer than the state the user dismissed
- **THEN** that evidence remains visible despite a delayed dismissal response or stale client write
- **AND** after successful durable retirement, later unavailability does not automatically reactivate the obsolete dismissal

#### Scenario: Retirement storage fails while activity returns
- **WHEN** the Hub cannot confirm persistence of retirement for an old dismissal
- **THEN** verified activity, transcript content and canonical pending requests remain available without waiting for that save
- **AND** the client reports the personal-state storage failure without treating it as a worker failure
- **AND** an old dismissal may reapply only to an unavailable row after restart during that failure; it never hides currently verified activity or pending requests

#### Scenario: Workspace is forgotten or storage is full
- **WHEN** the workspace is forgotten
- **THEN** all accounts' dismissal marks for that stable workspace are removed through the forget lifecycle
- **AND** when the mark budget cannot accept a new dismissal, it refuses that write explicitly instead of silently evicting committed marks
