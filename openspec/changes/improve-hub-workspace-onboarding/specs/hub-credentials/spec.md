## MODIFIED Requirements

### Requirement: Hub assigns credentials to workspaces without overstating isolation
New credentials SHALL have no workspace assignments by default. An authenticated user SHALL be able to grant and revoke credentials for selected registered workspaces and SHALL be able to select compatible authentication and signing defaults while creating, cloning, or registering a workspace before its first start. Onboarding assignment selection and workspace registration SHALL commit as one coherent result: invalid, unavailable, incompatible, or conflicting selections MUST NOT leave a partial new registration or assignment. The Hub SHALL configure normal Git, signing, and provider-tool selection from assignments when it starts a clone job or workspace session. Clone authentication and retained workspace authentication SHALL be presented as separate choices, with the selected clone credential offered as the default retained assignment but never retained without explicit user choice.

Assignments SHALL permit at most one default authentication credential per provider host and one default commit-signing credential per workspace so normal tool selection is deterministic. For the local backend, every assignment surface and API SHALL identify the workspace boundary as advisory because all workspaces share the daemon OS UID, and SHALL warn that another local workspace may be able to discover or exercise credentials outside its assignments. The persisted assignment model MUST distinguish individual credentials so a future isolated backend can project and enforce only the selected set.

#### Scenario: Credentials are assigned before first start
- **WHEN** a user adds or creates a workspace with compatible authentication and signing credentials
- **THEN** the Hub records both assignments before the workspace can be started
- **AND** the first start resolves that committed configuration

#### Scenario: Credential is assigned during clone
- **WHEN** a user selects a clone credential and explicitly chooses it as the retained workspace authentication default
- **THEN** the clone uses that credential and successful registration records the assignment before any requested start

#### Scenario: Clone identity is not retained implicitly
- **WHEN** a user selects a credential for cloning but declines workspace retention
- **THEN** the checked-out workspace has no assignment solely because that credential performed the clone

#### Scenario: Invalid onboarding assignment rolls back
- **WHEN** a selected credential becomes unavailable or conflicts before onboarding commits
- **THEN** the new workspace registration and every requested assignment remain absent

#### Scenario: Local workspace grant is displayed honestly
- **WHEN** a user assigns a credential during onboarding or in Settings using the local backend
- **THEN** the UI warns that the shared UID prevents an enforceable per-workspace secret boundary
- **AND** it does not describe the assignment as sandboxing or least-privilege isolation

#### Scenario: Conflicting defaults are rejected
- **WHEN** onboarding or later configuration selects conflicting authentication defaults for one host or multiple signing defaults
- **THEN** the Hub requires an explicit single default rather than persisting an ambiguous selection

#### Scenario: One authentication host is unassigned
- **WHEN** the same credential is assigned to one workspace for multiple authentication hosts and the user removes one host assignment
- **THEN** the Hub preserves that credential's assignments for the other hosts

#### Scenario: Assigned key is locked
- **WHEN** any assigned SSH or OpenPGP key is not usable even though its shared agent is running
- **THEN** workspace startup identifies the locked assignment instead of starting with unusable Git configuration
