# personal-workspace-state Specification

## Purpose
Persist validated semantic workspace state per user while keeping open clients independently navigable, request scope explicit, and physical presentation local to each client.

## Requirements

### Requirement: Hub persists personal semantic state per user and workspace
The Hub SHALL persist a versioned personal workspace-state record keyed by authenticated user identity and stable workspace id. The record SHALL support the last document path, Follow preference, preview mode, compare target, Files filter, and last-active PTY id. It SHALL survive Hub and child-session restarts until the workspace is forgotten or the state is explicitly cleared. Records are keyed by the authenticated username.

#### Scenario: State follows a user to another browser
- **WHEN** an authenticated user changes semantic workspace state in one browser
- **AND** later opens the same workspace in another browser using the same Hub account
- **THEN** the second browser receives that user's persisted workspace state
- **AND** another configured user's state is unaffected

#### Scenario: State survives process restarts
- **WHEN** the Hub and workspace child stop after personal state has been saved
- **AND** the Hub restarts and the workspace is opened again
- **THEN** the saved personal state remains available

### Requirement: Hub exposes a validated personal-state API
The Hub SHALL expose authenticated read and partial-update operations for the current user's state under a workspace prefix. Updates MUST accept only known fields with valid enum, boolean, relative-path, or PTY-id values, MUST be same-origin/CSRF protected, and MUST persist serialized mutations atomically. A request MUST NOT select another username. Missing records SHALL return an empty versioned state rather than an error.

#### Scenario: Partial update preserves unrelated fields
- **WHEN** a client PATCHes only `follow=false`
- **THEN** the stored Follow preference changes
- **AND** the saved document, preview mode, compare target, Files filter, and PTY reference remain unchanged

#### Scenario: Invalid state is rejected
- **WHEN** a client submits an unsupported preview mode, absolute document path, malformed PTY id, unknown field, or cross-origin update
- **THEN** the Hub rejects the update without changing persisted state

#### Scenario: Child tokens remain hidden
- **WHEN** a client reads or updates personal workspace state through a proxied workspace prefix
- **THEN** the response exposes no child session token or host filesystem path

### Requirement: Boot resolves explicit navigation before personal state
The client SHALL resolve initial state in this order: an explicit document or preview URL, valid personal workspace state, then current session defaults. Each stored field SHALL fall back independently when missing, invalid, or stale. Personal state loading MUST NOT override an explicit URL, and restoring state MUST produce one coherent initial render rather than visibly navigating from a default document afterward.

#### Scenario: Root arrival restores personal state
- **WHEN** a user opens a workspace root with a valid saved document and preferences
- **THEN** the initial preview and controls reflect the saved semantic state

#### Scenario: Explicit URL wins
- **WHEN** a user opens an explicit document, commit-preview, or review-score URL
- **THEN** that URL determines the initial preview
- **AND** a different saved document does not replace it

#### Scenario: Stale document falls back safely
- **WHEN** the saved document path no longer resolves in the workspace corpus
- **THEN** the client uses the session's current default document
- **AND** valid saved preferences in other fields still apply

### Requirement: Open clients remain independently navigable
Personal workspace-state updates SHALL affect future boot/resume decisions and SHALL NOT be broadcast as commands to already-open clients. Concurrent clients MAY persist changes using field-level last-write-wins semantics, but one client's navigation, Follow choice, preview mode, compare target, Files filter, or geometry MUST NOT force another open client to adopt it.

#### Scenario: Navigation is persisted without moving another client
- **WHEN** the same user has the workspace open on a Mac and in another browser
- **AND** the Mac selects a different document
- **THEN** the browser remains on its current document
- **AND** a later root arrival restores the most recently persisted document

#### Scenario: Partial concurrent writes do not clobber fields
- **WHEN** one client updates the document while another updates the Files filter
- **THEN** both fields retain their latest independently written values

### Requirement: Browsing scope is per client request context
The watch child SHALL retain the launched watched roots as shared session configuration but MUST NOT retain a mutable browsing scope selected by one client as global session state. Pinning, unpinning, widened search, compare target, state snapshots, SSE subscriptions, diff requests, and search requests SHALL use explicit caller context sufficient to produce that client's view. Browsing scope itself SHALL remain runtime client state and SHALL NOT be included in the initial durable personal-state schema. A CLI single-file launch constraint remains shared and cannot be widened by a client.

#### Scenario: Pinning one client does not narrow another
- **WHEN** two clients view a folder-scoped workspace
- **AND** one client narrows its browsing scope to a document
- **THEN** the other client continues to receive its own folder-scoped corpus

#### Scenario: Clients receive compare-specific snapshots
- **WHEN** two clients subscribe using different compare targets
- **THEN** each receives state, review snapshots, search results, and diffs for its own request context

#### Scenario: Single-file launch remains constrained
- **WHEN** the child session was launched against one file
- **THEN** no client request context can widen the corpus beyond that launch constraint

### Requirement: Physical presentation remains client-local
Viewport- and shell-dependent presentation state MUST NOT be authoritative personal Hub state. Sidebar and outline dimensions, terminal width/height/dock, preview split ratios, pane arrangement, zoom, native window state, and native split-browser state SHALL be stored or derived by the current client. Browser presentation keys SHALL be namespaced by workspace/base path so workspaces sharing one Hub origin do not affect one another. macOS-native presentation SHALL remain in native preferences where applicable.

#### Scenario: Different clients retain different geometry
- **WHEN** one user opens the same workspace in a wide macOS Desktop window and a narrow browser
- **THEN** each client uses its own dimensions and responsive layout
- **AND** resizing either client does not modify the other's current or future geometry

#### Scenario: Hub workspaces do not share browser presentation
- **WHEN** one browser changes sidebar or terminal geometry in `/s/alpha/`
- **THEN** opening `/s/beta/` does not inherit alpha's workspace-local geometry

### Requirement: New persistence starts without legacy storage migration
The client SHALL ignore legacy Uatu semantic preference and terminal reattach-hint keys when the new state model is enabled. It SHALL start from Hub state or current defaults and SHALL NOT retain a fallback that can reintroduce origin-wide workspace leakage.

#### Scenario: Upgrade performs a clean reset
- **WHEN** a browser upgrades with only legacy Uatu localStorage keys present
- **THEN** those keys do not determine semantic state or PTY attachment
- **AND** the client uses Hub state or current defaults

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
