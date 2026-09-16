## Purpose

Define provider-neutral Git worktrees as independent Hub workspaces, with explicit provenance, safe creation and removal, conservative discovery, and a mock-first UX approval boundary.

## ADDED Requirements

### Requirement: Worktree UX is approved before real integration
The worktree experience SHALL first be presented as a resettable mock-backed prototype using realistic Hub navigation and desktop/touch presentation. It MUST NOT mutate real repositories or Hub state, spawn workspace children, invoke providers, fetch remotes, or use real authentication secrets. Real Git/backend, CLI, and provider-skill integration SHALL begin only after explicit user UX approval; test success and planning completion MUST NOT constitute approval.

#### Scenario: Reviewer explores without mutation
- **WHEN** the reviewer creates, opens, deletes, encounters errors, and resets demo worktrees
- **THEN** only simulated state changes, the demo is visibly identified, and no real workspace child or external operation runs
- **AND** reset restores the initial fixture state

#### Scenario: Prototype is ready but not approved
- **WHEN** prototype tests pass and evidence is presented without a user approval decision
- **THEN** implementation pauses before real Git/backend, CLI, and provider-skill integration

### Requirement: Creation supports explicit branch modes without force
The Hub SHALL create an ordinary linked worktree from a selected repository using either a new local branch and explicit starting revision, an existing local branch, or a new local tracking branch from an explicitly selected remote-tracking ref. It SHALL validate paths, refs, branch names, destination availability and branch occupancy without replacing existing content or resetting branches. It MUST NOT force a checked-out branch into another checkout. Remote listings SHALL disclose freshness and offer explicit credential-aware fetch; fetch failure MUST NOT silently substitute another ref.

#### Scenario: New branch starts from the chosen revision
- **WHEN** a user confirms a new branch, valid unused destination, and explicit base
- **THEN** the new checkout uses that base and branch and becomes a distinct stopped workspace with its own stable ID

#### Scenario: Existing branch can be selected
- **WHEN** a user selects an existing local branch not checked out elsewhere
- **THEN** creation uses that branch without reset or force

#### Scenario: Remote ref becomes a tracking branch
- **WHEN** a user selects a remote ref, an unused local branch name, and confirms the displayed ref freshness
- **THEN** creation establishes that local branch with the selected upstream and reports the resolved starting revision

#### Scenario: Checked-out branch offers opening
- **WHEN** Git reports the requested branch is checked out elsewhere, including a race after validation
- **THEN** creation is refused without force and the existing checkout is offered for explicit open or registration

#### Scenario: Stale refs and failed fetch are recoverable
- **WHEN** the user requests fetch from a stale remote listing and authentication or network access fails
- **THEN** the error and stale state remain visible, no checkout is created, and the user can correct credentials and retry or explicitly use a displayed cached ref

### Requirement: Workspace boundaries and credentials remain explicit
Each registered worktree SHALL have independent workspace identity, child/watch root, terminal cwd and provider directory context. Existing conversations SHALL remain scoped to their checkout. Registration SHALL atomically persist chosen display name and explicit credential assignments, defaulting to no inherited assignments and no start. Creation MUST NOT copy uncommitted or ignored source files, install dependencies, implicitly execute setup scripts, or claim security isolation; it SHALL explain that Git hooks/filters and later project configuration may execute.

#### Scenario: Source workspace remains unchanged
- **WHEN** a new worktree workspace is created and explicitly started
- **THEN** its terminal and agents use the new checkout and the source workspace's conversations and selection remain unchanged

#### Scenario: No credential inheritance
- **WHEN** the source workspace has assigned credentials and a new tree is configured without selecting any
- **THEN** no assignments or secrets are copied and normal no-assignment startup behavior applies

#### Scenario: First start fails
- **WHEN** registration and assignments succeed but an explicitly requested start fails
- **THEN** the configured workspace remains stopped and the user can retry start without creating another checkout

### Requirement: Creation provenance and partial outcomes are recoverable
The Hub SHALL durably distinguish verified Uatu-created checkouts from external or uncertain checkouts independently of registration. Creation SHALL coordinate repository and destination mutations, report bounded operation progress and sanitized errors, and support idempotent recovery after interruption. Registration failure after successful Git creation MUST retain the checkout and branch and offer registration retry without recreating them. A reused path or uncertain identity MUST NOT acquire ownership from an older record.

#### Scenario: Registration fails after checkout creation
- **WHEN** Git creation succeeds but registration or assignment persistence fails
- **THEN** no partial registration/assignments are exposed and the retained checkout path, branch and recovery action are reported
- **AND** retry verifies and registers that same checkout rather than creating a second one

#### Scenario: Hub restarts during creation
- **WHEN** an interrupted operation is reconciled after restart
- **THEN** the Hub reports the verified completed or partial state without deleting uncertain content or claiming an unrelated path occupant

#### Scenario: Concurrent creation collides
- **WHEN** two operations target the same path hierarchy or race for the same branch
- **THEN** coordination and Git checks allow no overwrite or forced duplicate checkout, and the losing request receives an actionable conflict

### Requirement: External discovery does not imply ownership or navigation
The Hub SHALL reconcile authoritative Git worktree inventory on open, after relevant observed activity, periodically with bounded refresh, and on manual refresh. Uatu-created results SHALL notify interested clients immediately after commit. Discovered external trees SHALL remain external when registered, SHALL NOT be automatically cleaned up, and SHALL require explicit user open/registration. Missing or replaced paths SHALL surface unavailable/identity-conflict state without silent recreation, forgetting, fallback or workspace/conversation switching.

#### Scenario: Native agent creates a checkout
- **WHEN** a refresh observes a new tree created by an agent or external Git tool
- **THEN** the navigator offers explicit open/registration marked external and leaves the current workspace and conversation selected

#### Scenario: Registered external checkout disappears
- **WHEN** a registered external path is missing or belongs to a different checkout
- **THEN** the registration remains visible with a missing/identity-conflict explanation and start is refused until resolved

### Requirement: Manual deletion is guarded and distinct from forgetting
Deletion SHALL be limited to verified Uatu-created linked trees and SHALL require explicit confirmation of path, branch and stopping Uatu activity. The Hub SHALL fence new activity, await starts and stop known Uatu sessions/agents/terminals, respect Git locks, revalidate identity and inspect tracked, untracked and ignored data before non-force removal. Dirty, untracked, ignored, locked, nested-dependent or uncertain states SHALL block deletion with actionable explanations. The UI SHALL disclose that external use cannot always be detected. Branches SHALL be preserved by default; a separately confirmed branch deletion SHALL use safe Git checks, never force. Failed stop or removal SHALL retain registration. Successful checkout removal SHALL precede unregistering and metadata cleanup, with recoverable cleanup failure. Forget SHALL only unregister a stopped workspace and remove associated Hub assignment/personal state; checkout, branch and provenance SHALL remain.

#### Scenario: Clean owned tree is deleted
- **WHEN** the user confirms deletion and all activity, identity, lock and data checks pass
- **THEN** Git removes the linked checkout, Hub removes its registration and associated state, and the branch remains by default

#### Scenario: Local data or lock blocks deletion
- **WHEN** the checkout contains tracked changes, untracked or ignored files, or a Git lock
- **THEN** deletion reports the blocker and retains both checkout and registration without force

#### Scenario: Stop fails or new activity races
- **WHEN** stopping required Uatu activity fails or a concurrent start arrives during deletion
- **THEN** failed stop prevents removal and concurrent start cannot use a partially removed checkout

#### Scenario: External checkout is forgotten
- **WHEN** a stopped external workspace is removed from Hub
- **THEN** its registration and associated Hub state are removed while Git metadata, branch and files remain untouched
- **AND** worktree deletion is not offered as an external ownership action

#### Scenario: Safe branch deletion refuses
- **WHEN** separately confirmed branch deletion fails Git's safety checks after checkout removal
- **THEN** the branch remains and its failure is reported independently of successful checkout removal

### Requirement: UI and agent requests share authoritative operations
The UI and an agent-invoked CLI SHALL use the same authenticated Hub operations and safety/recovery rules, with structured results and explicit source/Hub context. Missing or expired context SHALL fail without guessing another Hub or falling back to independent Git mutation. Credentials MUST NOT appear in command arguments, results or skill instructions. Thin Claude/OpenCode skills SHALL guide use only for explicit persistent Uatu workspace requests and MUST NOT replace native hooks, subagent worktree behavior or user configuration, use provider experimental removal/reset as general cleanup, or silently migrate conversations.

#### Scenario: Agent requests a persistent workspace
- **WHEN** an authenticated CLI request asks the Hub to create a worktree
- **THEN** it receives the same validated outcome or recoverable error as the UI and successful creation invalidates the UI inventory without automatically switching it

#### Scenario: Native isolation remains native
- **WHEN** Claude or OpenCode uses its own worktree/subagent behavior alongside the Uatu skill
- **THEN** Uatu leaves that lifecycle configuration intact and any discovered checkout remains external unless Uatu has verified creation provenance

#### Scenario: CLI has no authorized Hub context
- **WHEN** the CLI cannot establish current authenticated context
- **THEN** it reports an actionable context error without invoking Git or exposing a credential
