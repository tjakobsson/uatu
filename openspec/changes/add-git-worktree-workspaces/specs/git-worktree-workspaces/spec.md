## Purpose

Define provider-neutral Git worktrees as independent Hub workspaces, with explicit provenance, safe creation and removal, conservative discovery, and a mock-first UX approval boundary.

## ADDED Requirements

### Requirement: Worktree UX is approved before real integration
The worktree experience SHALL first be presented as a resettable mock-backed prototype inside the actual Uatu workspace frontend, using its existing workspace picker as the primary create, discover and switch entry point. Hub dashboard entry points SHALL remain secondary. A standalone Hub-style demo, alternate pretend workspace frontend or placeholder session destination MUST NOT satisfy this requirement. The prototype SHALL serve independent workspace contexts at `/s/<workspace-id>/` URLs with distinct files, preview, simulated terminal and simulated chat data through mocked APIs. It MUST NOT mutate real repositories or persistent Hub state, perform real Git operations, start PTYs, shells or workspace children, invoke agents/providers, fetch remotes, access real credential stores, or use real authentication secrets. Unhandled mock requests MUST fail closed rather than reach real operations. Real Git/backend, CLI, and provider-skill integration SHALL begin only after explicit user UX approval of this real-frontend prototype; prior standalone-demo evidence, test success and planning completion MUST NOT constitute approval.

#### Scenario: Reviewer explores without mutation
- **WHEN** the reviewer creates, opens, deletes, encounters errors, and resets demo worktrees
- **THEN** the actual workspace frontend remains usable, only simulated state changes, the demo is visibly identified, and no real Git, PTY, workspace child, agent, credential or persistent-state operation runs
- **AND** reset restores every workspace's initial fixture data and selections, clears pending simulated events and navigation state, and prevents prior scenario state from being restored

#### Scenario: Reviewer exercises the actual workspace picker
- **WHEN** the reviewer creates a worktree from a populated workspace's existing picker and explicitly starts and opens the stopped result
- **THEN** its separate stable session URL displays the actual frontend with that workspace's distinct files, preview, simulated terminal and simulated chat
- **AND** desktop, narrow touch, keyboard/focus/error announcements, light/dark and desktop titlebar inset behavior are reviewable in that frontend rather than only in Hub cards

#### Scenario: Unknown mock route cannot reach real operations
- **WHEN** a prototype request has no mocked API handler
- **THEN** it fails visibly without falling through to a real backend or remote service

#### Scenario: Prototype is ready but not approved
- **WHEN** prototype tests pass and evidence is presented without a user approval decision
- **THEN** implementation pauses before real Git/backend, CLI, and provider-skill integration

### Requirement: Creation supports explicit branch modes without force
The Hub SHALL create an ordinary linked worktree from a selected repository using either a new local branch from source HEAD, an existing local branch, or a new local tracking branch from an explicitly selected remote ref. It SHALL validate paths, refs, names, availability and occupancy without replacing content or resetting branches. It MUST NOT force a checked-out branch into another checkout. The branch popup SHALL show cached refs immediately with no automatic network call, and an adjacent icon labeled/titled Fetch remote branches SHALL explicitly refresh them. Loading and auth/network errors SHALL be inline. Fetch SHALL preserve query and a valid selected ref, clearing a disappeared selection without silent substitution or false freshness. No dashboard fetch duplicate SHALL exist.

Each parent fork SHALL open a two-option menu: New branch / worktree and Existing branch. New creation SHALL show title, name and Create/Cancel only. Existing creation SHALL use an accessible editable combobox with fuzzy filtering, local/remote badges, qualified refs, keyboard/touch and empty results. Click/Enter SHALL commit the exact displayed ref into the input and confirm selection; Enter MUST NOT submit. Editing SHALL clear the underlying selection and disable Create until another valid option is picked. Reopening a committed input SHALL offer all refs rather than filter to the selection. Escape SHALL close the list before dismissing the popup; blur/click-away SHALL close the list. Cancel/reopen SHALL not retain a stale choice. Apart from the adjacent explicit fetch icon, necessary list and actionable errors, popups SHALL contain only the field and Create/Cancel, with no predetermined path/configuration/ownership/base readouts.

New checkout destinations SHALL be predetermined siblings `<main-folder>.worktrees/<safe-branch-folder>`. The child workspace name SHALL equal the exact current local branch, not its sanitized folder name. No destination/name form or child branch rename SHALL be offered. Sanitized folder collisions SHALL be handled deterministically without overwrite, including refusal when a disambiguated destination remains occupied. Branch occupancy SHALL be scoped to repository identity, not globally to the displayed branch string.

#### Scenario: Two branches sanitize to the same folder
- **WHEN** `feature/login` and `feature-login` target the same parent
- **THEN** their displayed names remain exact and their destinations are safely disambiguated by a deterministic suffix or refused without overwriting existing content

#### Scenario: Same branch in separate repositories
- **WHEN** two different main repository identities have children on `feature/login`
- **THEN** each displays that exact branch beneath its own main parent and neither conflicts with the other's checkout

#### Scenario: New branch starts from source HEAD
- **WHEN** a user enters a name and confirms Create with an available predetermined destination
- **THEN** the new checkout uses the approved source HEAD and branch and becomes a distinct stopped workspace with its own stable ID, without a base-selection UI

#### Scenario: Existing branch can be selected
- **WHEN** a user selects an existing local branch not checked out elsewhere
- **THEN** creation uses that branch without reset or force

#### Scenario: Remote ref becomes a tracking branch
- **WHEN** a user selects a remote-qualified branch in the combined selector and confirms Create
- **THEN** creation derives its local name by removing the remote prefix and establishes that branch with the selected upstream; the popup closes, lists refresh and a small `Created <branch>` confirmation offers explicit Open while the child remains stopped and the source remains selected
- **AND** an existing local name is refused without reset and cached refs are not described as network-fresh

#### Scenario: Checked-out branch offers opening
- **WHEN** Git reports the requested branch is checked out elsewhere, including a race after validation
- **THEN** creation is refused without force and the existing checkout is offered for explicit open or registration

#### Scenario: Stale refs and failed fetch are recoverable
- **WHEN** the user requests fetch from a stale remote listing and authentication or network access fails
- **THEN** the error and stale state remain visible, no checkout is created, and the user can correct credentials and retry or explicitly use a displayed cached ref

### Requirement: Branch creation origin is a historical snapshot
Nested worktree rows SHALL expose recorded branch creation source separately from
current tracking/upstream and live parent policy. A new branch SHALL snapshot the
selected parent's actual HEAD ref at creation; a newly created tracking branch
SHALL snapshot its selected remote-qualified source. Existing-local and external
branches SHALL remain origin unknown unless explicit trustworthy creation history
exists. Git upstream, merge-base, parent identity and checkout starting revision
MUST NOT be used to guess historical branch origin. The prototype SHALL use only
explicit fixture history and simulated creation records, with no real Git inference.

#### Scenario: Parent ref or configuration changes after creation
- **WHEN** a branch is created from a parent on `release`, then that parent changes ref or configuration
- **THEN** the child's recorded source remains `release`, while shared configuration still inherits live

#### Scenario: Remote tracking and unknown existing history
- **WHEN** a new local tracking branch is created from `origin/foo`
- **THEN** its source remains `origin/foo` even if its upstream later changes
- **WHEN** an existing local branch or external checkout has no recorded branch-creation history
- **THEN** its origin is unknown, even when it has an upstream or known checkout starting revision

### Requirement: Workspace boundaries and credentials remain explicit
Each registered worktree SHALL have independent workspace identity, child/watch root, terminal cwd and provider directory context. Explicit switching through the existing workspace picker SHALL navigate to the selected checkout's separate `/s/<workspace-id>/` context for files, preview, terminal and chat, not replace the current workspace's checkout in place. Returning through the picker or browser history SHALL restore that workspace's own selected document/preview, terminal context and selected conversation. Conversations MUST remain attached to their original checkout and MUST NOT migrate or be copied by creation, discovery or switching. Delayed responses and live events from another workspace MUST NOT overwrite the active workspace's context. These observable boundaries SHALL also hold for simulated data in the prototype, without claiming real runtime isolation has been verified. Registration SHALL atomically retain the explicit parent/repository relationship and exact local branch identity, defaulting to stopped. Credentials and shared workspace configuration SHALL be managed only on the parent and inherited live; parent updates SHALL propagate without child overrides or child credential/settings forms. Parent policy SHALL be disclosed, not implemented by copying secrets or adopting ambient credentials. Checkout runtime and personal/per-device UI state MUST remain separate. Creation MUST NOT copy uncommitted or ignored source files, install dependencies, implicitly execute setup scripts, or claim security isolation; it SHALL explain that Git hooks/filters and later project configuration may execute.

#### Scenario: Source workspace remains unchanged
- **WHEN** a new worktree workspace is created and explicitly started
- **THEN** its terminal and agents use the new checkout and the source workspace's conversations and selection remain unchanged

#### Scenario: Parent policy changes after creation
- **WHEN** a user changes credential assignments or shared workspace configuration on the main parent
- **THEN** its children reflect the updated parent policy without child overrides or copied secrets
- **AND** their files, selected documents/conversations, terminal sessions, running state and personal/device preferences remain independent

#### Scenario: Parent configuration does not require parent runtime
- **WHEN** main Stop is requested while a child is running
- **THEN** only main stops; the child remains running
- **WHEN** a child is started while main is stopped
- **THEN** child start is permitted without starting main; parent remains the live configuration owner, not a runtime prerequisite

#### Scenario: Round trip restores each checkout's context
- **WHEN** a user selects a document and conversation in one workspace, switches through the existing picker to another workspace, and returns using the picker or browser back/forward
- **THEN** each destination restores its own file selection, preview, terminal context and selected conversation
- **AND** neither workspace acquires or replaces the other's conversations

#### Scenario: Late response cannot leak across workspaces
- **WHEN** a response or simulated live event for a previously active workspace arrives after switching to another
- **THEN** the active workspace's files, preview, terminal and chat remain scoped to its own identity

#### Scenario: First start fails
- **WHEN** registration and assignments succeed but an explicitly requested start fails
- **THEN** the configured workspace remains stopped and the user can retry start without creating another checkout

### Requirement: Creation provenance and partial outcomes are recoverable
The Hub SHALL durably distinguish verified Uatu-created checkouts from external or uncertain checkouts independently of registration. Creation SHALL coordinate repository and destination mutations, report bounded operation progress and sanitized errors, and support idempotent recovery after interruption. Registration failure after successful Git creation MUST retain the checkout and branch and offer registration retry without recreating them. A reused path or uncertain identity MUST NOT acquire ownership from an older record.

#### Scenario: Registration fails after checkout creation
- **WHEN** Git creation succeeds but registration or assignment persistence fails
- **THEN** no partial registration/assignments are exposed and a compact originating-flow error explains the retained checkout and branch with a registration retry action, without a path/identity/configuration dump
- **AND** retry verifies and registers that same checkout rather than creating a second one

#### Scenario: Hub restarts during creation
- **WHEN** an interrupted operation is reconciled after restart
- **THEN** the Hub reports the verified completed or partial state without deleting uncertain content or claiming an unrelated path occupant

#### Scenario: Concurrent creation collides
- **WHEN** two operations target the same path hierarchy or race for the same branch
- **THEN** coordination and Git checks allow no overwrite or forced duplicate checkout, and the losing request receives an actionable conflict

### Requirement: External discovery does not imply ownership or navigation
The Hub SHALL reconcile authoritative Git worktree inventory on navigator/workspace open, after relevant observed activity, periodically with bounded refresh, and on manual refresh. The existing in-workspace picker SHALL expose creation, discovery and explicit switching as the primary entry point. Uatu-created results SHALL notify interested clients immediately after commit. Inventory updates, including external discovery and reconnect refresh, MUST NOT change the active workspace, selected document/preview, terminal context or selected conversation. Discovered external trees SHALL remain external when registered, SHALL NOT be automatically cleaned up, and SHALL require explicit user open/registration. Missing or replaced paths SHALL surface unavailable/identity-conflict state without silent recreation, forgetting, fallback or workspace/conversation switching.

External checkout registration SHALL preserve its existing path and provenance, disclose live parent policy, and use its exact local branch as the child name. Neither grouping nor a conventional path SHALL imply creation ownership.

#### Scenario: Native agent creates a checkout
- **WHEN** a refresh observes a new tree created by an agent or external Git tool
- **THEN** the existing workspace picker offers explicit open/registration marked external and leaves the current workspace, document/preview, terminal context and conversation selected

#### Scenario: Registered external checkout disappears
- **WHEN** a registered external path is missing or belongs to a different checkout
- **THEN** the registration remains visible with a missing/identity-conflict explanation and start is refused until resolved

### Requirement: Manual deletion is guarded and distinct from forgetting
Deletion SHALL be limited to verified Uatu-created linked trees and require explicit confirmation identifying parent display name / branch, with Delete for stopped trees or Stop and delete for running trees. The destructive button SHALL authorize the stated Uatu stop/removal operation without another checkbox; internal path/identity checks MUST remain authoritative and MUST NOT require a metadata-heavy dialog. The Hub SHALL fence starts, await in-flight starts, stop Uatu sessions/agents/terminals, respect locks, revalidate identity and inspect tracked/untracked/ignored data before non-force removal. Dirty, untracked, ignored, locked, nested-dependent, externally active/owned or uncertain states SHALL block with short actionable explanations replacing normal dialog consequences. The UI MUST NOT imply it can stop unknown external applications. Branches SHALL always remain; branch-deletion UI and operations are out of scope. Failed stop/removal SHALL retain registration and files. Verified removal SHALL precede unregister/metadata cleanup with recoverable cleanup failure. Success SHALL close the popup and remove the row with safe navigation for an active removed context. Forget SHALL only unregister a stopped workspace and remove Hub personal state; checkout, branch and provenance SHALL remain.

#### Scenario: Known running Uatu workspace can be stopped and deleted
- **WHEN** the user explicitly selects Stop and delete for a known running Uatu workspace
- **THEN** the operation attempts to stop its Uatu activity and performs every safety recheck before removal, without another hidden confirmation requirement
- **AND** unrelated external activity remains a blocker rather than an activity Uatu claims it can stop

#### Scenario: Clean owned tree is deleted
- **WHEN** the user confirms deletion and all activity, identity, lock and data checks pass
- **THEN** Git removes the linked checkout, Hub removes its registration and associated state, and the branch remains

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

#### Scenario: Branch deletion is not offered
- **WHEN** a user reviews or completes checkout deletion
- **THEN** no branch-deletion choice exists and the branch and its recorded creation history remain

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
