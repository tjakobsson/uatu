## MODIFIED Requirements

### Requirement: Hub accounts have personal synchronized chat preferences
The authenticated Hub Settings page SHALL provide a Personal chat preferences section with a compact switch labelled **Keep workers running when I steer**, default ON when the account has no saved value, a one-line helper **Applies to your account on this Hub.**, and compact explicit **Save** rather than autosave. The switch and Save SHALL retain at least 44px targets. The setting SHALL apply to the initiating account on that Hub across its devices and workspaces, persist across Hub restart, and never change another account's saved preference. Collapsed **Learn more** SHALL distinguish this scope from machine-wide agent logins and workspace defaults, explain that automatic backgrounding follows accepted steer actions rather than job starts, disclose all eligible blocking jobs including shells and shared-workspace effects, and retain the non-atomic/native-resume caveats. Existing pending, conflict and unavailable-state handling SHALL remain unchanged.

Settings SHALL load the current value on entry, visibility/focus return and reconnect, and show confirmed saved state only after persistence succeeds. Each eligible action SHALL resolve policy from authoritative Hub state, not a device's cached display. A completed setting change affects subsequent actions; it SHALL NOT retroactively cancel or add a follow-up to an action already accepted under a prior policy snapshot. Concurrent stale updates SHALL be reported as conflicts with current own-account state rather than silently overwriting a newer save.

#### Scenario: New and existing accounts have the requested default
- **WHEN** an account with no personal chat preference opens Settings, including after upgrading an existing Hub
- **THEN** automatic backgrounding on accepted steers is ON for that account
- **AND** no operator configuration or other user's preference is rewritten

#### Scenario: Saved OFF is shared by the account's devices
- **WHEN** one device saves OFF and another device for the same account re-enters or refreshes Settings, even in another workspace after a Hub restart
- **THEN** it reads OFF
- **AND** subsequent steer actions from either device use OFF even if an earlier page had displayed ON

#### Scenario: Other accounts remain independent in a shared workspace
- **WHEN** A saves ON and B saves OFF while both use the same workspace
- **THEN** A's qualifying actions use ON and B's actions use OFF
- **AND** shared worker effects do not change either account's setting or cause one device to display the other's preference

#### Scenario: Concurrent settings updates do not overwrite silently
- **WHEN** two devices save changes based on the same saved revision and one has already committed
- **THEN** the stale save reports a conflict and the account's current value
- **AND** the first committed value remains until another explicitly resolved update succeeds

#### Scenario: Settings navigation is available from the workspace
- **WHEN** an authenticated user opens the workspace Hub menu with touch, pointer or keyboard
- **THEN** a labelled Settings link reaches the personal chat preference without adding permanent chat toolbar controls
- **AND** menu refresh and dismissal retain existing focus and outside-tap safety

### Requirement: Personal chat preference persistence and access preserve account boundaries
The personal chat-preference API SHALL select identity exclusively from the authenticated cookie or bearer session, return only that account's preference with no-store semantics, validate a closed versioned request contract and protect cookie mutations against cross-origin requests. A client SHALL NOT select another account by body, query, header or workspace path. Hub chat dispatch SHALL use authenticated, workspace-bound request context and SHALL NOT trust caller-supplied policy metadata or store an initiating user's policy as shared conversation/adapter state. Account policy metadata SHALL NOT be exposed through shared conversation replay, diagnostics or another viewer's responses.

Hub policy authority SHALL be independent of workspace/terminal credentials, established privately for each spawned child and bound to a required fresh child-instance identity. A valid workspace credential SHALL NOT authorize a caller to assert a Hub principal or sign policy. Child replacement SHALL invalidate prior policy authority and envelopes even when workspace identity, endpoint or workspace credential is reused. Nullable/absent terminal credentials SHALL NOT select a fallback policy key: private bootstrap can establish policy trust independently, subject to unchanged primary access gates. When private trust/instance proof cannot be established, automatic backgrounding SHALL be explicitly unavailable without unsigned/default-ON fallback; ordinary steering and the existing background API SHALL remain subject to their existing access checks. Policy secrets SHALL NOT be exposed through public credentials, URLs, configuration, diagnostics or tool subprocess inheritance.

Preference persistence SHALL use owner-only state storage, atomic serialized updates and rollback on an uncommitted failure, preserve other users' records and explicit OFF values, and reject unsupported wire versions. A missing initial file/record SHALL resolve to ON; corrupt, unreadable or unsupported-version persisted state SHALL report unavailable rather than silently overwrite data or reset OFF to ON. When preference resolution is unavailable, steering SHALL remain usable with automatic backgrounding skipped and explanatory feedback. Standalone without a Hub account SHALL have no personal Hub toggle or automatic Hub policy; the existing background API SHALL remain available without a manual Continue UI.

Unavailable private policy trust SHALL NOT merge authenticated accounts' mutation receipts or disable unknown-outcome retention. Degraded operation identifiers SHALL preserve original client correlation without asserting an unsigned principal or authorizing automatic backgrounding. First feedback decisions SHALL remain scoped to the authenticated initiating account while their bounded in-memory receipt/snapshot protection is retained.

#### Scenario: Client tries to choose another account
- **WHEN** a client supplies a foreign identity, unknown field or unsupported version to the personal preference API
- **THEN** the request is rejected without reading or changing another account's state

#### Scenario: Unauthorized or cross-origin preference mutation
- **WHEN** a missing/revoked session or cross-origin cookie request attempts to change the preference
- **THEN** it is refused without a preference write or background operation

#### Scenario: Spoofed dispatch context cannot activate policy elsewhere
- **WHEN** a caller supplies forged policy metadata or reuses context for a different workspace, child instance, principal or action
- **THEN** it cannot authorize automatic backgrounding for that action
- **AND** a direct standalone request cannot acquire another Hub user's policy

#### Scenario: Failed save preserves explicit OFF and other users
- **WHEN** saving a preference fails before its atomic commit
- **THEN** Settings reports failure without claiming the new value was saved
- **AND** the prior saved value and other accounts' records remain intact

#### Scenario: Workspace credential cannot forge an initiating principal
- **WHEN** a caller holding a valid workspace credential attempts to sign policy asserting another Hub principal using that credential
- **THEN** policy verification fails and no automatic follow-up is authorized
- **AND** supplying the same credential through a legitimate workspace route does not elevate it to Hub policy authority

#### Scenario: Null terminal token has independent policy trust
- **WHEN** a child has no terminal token but completes verified private policy bootstrap with its fresh instance identity
- **THEN** policy trust is established independently of terminal availability
- **AND** existing primary-route authentication/origin checks are not bypassed or relaxed

#### Scenario: Bootstrap unavailable fails explicitly
- **WHEN** private bootstrap or instance proof is missing, unsupported, malformed or times out, including with a null terminal token
- **THEN** automatic backgrounding is reported unavailable and no policy authority is inferred from workspace credentials or account defaults
- **AND** otherwise permitted steering/background API requests retain their existing behavior without unsigned principal propagation

#### Scenario: Restart invalidates old policy authority
- **WHEN** a child restarts in the same workspace with the same endpoint or workspace credential
- **THEN** it establishes a fresh private policy secret and instance identity
- **AND** old-instance signed policy or readiness proofs cannot authorize new actions, and uncertain mutations are not replayed on rotation

#### Scenario: Persisted preference data cannot be safely read
- **WHEN** persisted personal chat preferences are corrupt, unreadable or from an unsupported format version
- **THEN** Settings reports unavailable without overwriting them
- **AND** an otherwise accepted steer is preserved while its automatic background follow-up is skipped with an explanation

#### Scenario: Standalone keeps explicit behavior
- **WHEN** chat runs outside a Hub account context
- **THEN** the personal automatic-background toggle is absent and steer actions do not automatically background work
- **AND** the capability-gated background API retains its existing semantics without a manual Continue control or replacement menu

#### Scenario: Degraded trust preserves account receipt isolation without authority
- **WHEN** two authenticated Hub accounts submit different inputs with the same conversation and client request identifier while private policy trust is unavailable
- **THEN** both inputs have distinct operation receipts and neither account receives the other's result
- **AND** neither operation acquires an unsigned principal or automatic-background authority
- **AND** same-account retries preserve the first retained result/feedback even after a preference change
