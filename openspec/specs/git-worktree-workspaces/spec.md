# git-worktree-workspaces Specification

## Purpose

Define provider-neutral Git worktrees as independent Hub workspaces, with explicit provenance, safe creation and removal, conservative discovery, one published operation family, and a recorded UX approval.

## Requirements

### Requirement: Approved worktree UX obligations hold on the real surfaces
The worktree experience SHALL be delivered through the existing in-workspace workspace picker as the primary create, discover and switch entry point, with Hub dashboard entry points secondary. It was first presented as a resettable mock-backed prototype inside the actual Uatu workspace frontend, and real Git/backend integration began only after the user's explicit UX approval of that prototype, recorded on 2026-09-17. That prototype and its harnesses are retired; the obligations it established SHALL hold for the real surfaces. Each registered checkout SHALL open its own `/s/<workspace-id>/` context with its own files, preview, terminal and chat. Desktop, narrow touch, keyboard/focus/error announcements, light/dark themes and desktop WebView titlebar inset SHALL be supported in the actual workspace frontend rather than only in Hub cards. Worktree surfaces MUST NOT depend on mock hosts, scenario controls, demo pages or gallery fixtures; every automated check SHALL exercise product code through its real entry points, against real Hub state and temporary Git repositories.

#### Scenario: User exercises the actual workspace picker
- **WHEN** a user creates a worktree from a populated workspace's existing picker and explicitly starts and opens the stopped result
- **THEN** its separate stable session URL displays the actual frontend with that workspace's own files, preview, terminal and chat
- **AND** desktop, narrow touch, keyboard/focus/error announcements, light/dark and desktop titlebar inset behavior remain correct in that frontend

#### Scenario: Approval is recorded, the prototype is retired
- **WHEN** the worktree surfaces are reviewed or changed after the recorded approval
- **THEN** the approved behavior remains the acceptance standard and no mock host, demo page, gallery or scenario control is required to demonstrate it

### Requirement: Creation supports explicit branch modes without force
The Hub SHALL create an ordinary linked worktree from a selected repository using either a new local branch from an explicitly selected starting branch, an existing local branch, or a new local tracking branch from an explicitly selected remote ref. It SHALL validate paths, refs, names, availability and occupancy without replacing content or resetting branches. It MUST NOT force a checked-out target branch into another checkout; a checked-out starting branch SHALL remain a valid base for a different new branch. Both branch comboboxes SHALL show cached refs with no automatic network call and adjacent Fetch remote branches. Loading/errors SHALL be inline. Fetch SHALL preserve name/query/valid selection, invalidate disappeared refs, and MUST NOT reapply initial defaults or silently substitute refs.

Each parent fork SHALL open a three-option menu: New branch / worktree, Existing branch and Register worktree…, the last listing only the checkouts Git lists for that repository that Uatu has not registered. New creation SHALL show target title, Name, Create from and Create/Cancel. Create from and Existing's Branch SHALL share the accessible editable fuzzy local/remote combobox semantics, badges, qualified refs, keyboard/touch and empty results. Initial Create from SHALL prefer local main, otherwise select the sole remote named main; ambiguous or absent mains SHALL require explicit choice, never fallback to current HEAD. Both lists SHALL open expanded before anything is typed: Create from with the full local and remote listing, and Existing's Branch with only the branches no checkout holds — excluding every local branch a listed checkout has checked out and every remote ref whose derived local tracking name already exists locally — re-filtered the same way after an explicit fetch, showing `Every branch is already checked out. Create a new branch instead.` with Create disabled when none remain. Click, tap and Enter SHALL commit the exact ref and confirm selection; Enter MUST NOT submit. A touch tap SHALL commit an option and activate a footer action exactly as a pointer click does. Editing SHALL clear selection and disable Create; invalid/empty Name or pending operation SHALL also disable new Create. Reopening SHALL offer all refs. Escape SHALL close list before popup; blur/click-away SHALL close list without losing first-click footer actions. Cancel/reopen SHALL discard old drafts and apply initial defaults only. No destination/settings/details/ownership or extra metadata SHALL appear. Expanded lists SHALL remain within compact viewport-safe dialogs with safe reachable buttons. Both dialogs SHALL be rendered by the client from the published worktree JSON, preserving these roles, labels, copy and keyboard behavior.

New checkout destinations SHALL be predetermined siblings `<main-folder>.worktrees/<safe-branch-folder>`. The child workspace name SHALL equal the exact current local branch, including slashes, not its sanitized folder name. No destination/name form or child branch rename SHALL be offered. Sanitized folder collisions SHALL be handled deterministically without overwrite, including refusal when a disambiguated destination remains occupied. Branch occupancy SHALL be scoped to repository identity, not globally to the displayed branch string.

#### Scenario: Two branches sanitize to the same folder
- **WHEN** `feature/login` and `feature-login` target the same parent
- **THEN** their displayed names remain exact and their destinations are safely disambiguated by a deterministic suffix or refused without overwriting existing content

#### Scenario: Same branch in separate repositories
- **WHEN** two different main repository identities have children on `feature/login`
- **THEN** each displays that exact branch beneath its own main parent and neither conflicts with the other's checkout

#### Scenario: New branch defaults independently of current checkout
- **WHEN** the parent checkout is on feature/current and local main exists
- **THEN** initial Create from selects main, and creation uses that chosen base, not feature/current
- **WHEN** local main is absent
- **THEN** only a sole remote main is selected automatically; multiple remote mains or none leave the choice empty and Create disabled

#### Scenario: Explicit base and refetch retain intent
- **WHEN** a user selects another local or remote starting branch and explicitly fetches
- **THEN** name/query/valid selection remain exact, including after auth/network errors; a disappeared choice is cleared without redefaulting
- **WHEN** creation succeeds
- **THEN** the stopped child records the exact selected sourceRef, independently of subsequent parent checkout changes

#### Scenario: Existing branch can be selected
- **WHEN** a user selects an existing local branch not checked out elsewhere
- **THEN** creation uses that branch without reset or force

#### Scenario: Remote ref becomes a tracking branch
- **WHEN** a user selects a remote-qualified branch in the combined selector and confirms Create
- **THEN** creation derives its local name by removing the remote prefix and establishes that branch with the selected upstream; the popup closes, lists refresh and a small `Created <branch>` confirmation at the top of the viewport offers explicit Open while the child remains stopped and the source remains selected
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
explicitly selected starting ref at creation; a newly created tracking branch
SHALL snapshot its selected remote-qualified source. Existing-local and external
branches SHALL remain origin unknown unless explicit trustworthy creation history
exists. Git upstream, merge-base, parent identity and checkout starting revision
MUST NOT be used to guess historical branch origin. Recorded creation history SHALL come only from Uatu's durable
provenance record, never from Git inference.

#### Scenario: Parent ref or configuration changes after creation
- **WHEN** a branch is created with `release` explicitly selected as its base, then that parent changes checkout ref or configuration
- **THEN** the child's recorded source remains `release`, while shared configuration still inherits live

#### Scenario: Remote tracking and unknown existing history
- **WHEN** a new local tracking branch is created from `origin/foo`
- **THEN** its source remains `origin/foo` even if its upstream later changes
- **WHEN** an existing local branch or external checkout has no recorded branch-creation history
- **THEN** its origin is unknown, even when it has an upstream or known checkout starting revision

### Requirement: Workspace boundaries and credentials remain explicit
Each registered worktree SHALL have independent workspace identity, child/watch root, terminal cwd and provider directory context. Explicit switching through the existing workspace picker SHALL navigate to the selected checkout's separate `/s/<workspace-id>/` context for files, preview, terminal and chat, not replace the current workspace's checkout in place. Returning through the picker or browser history SHALL restore that workspace's own selected document/preview, terminal context and selected conversation. Conversations MUST remain attached to their original checkout and MUST NOT migrate or be copied by creation, discovery or switching. Delayed responses and live events from another workspace MUST NOT overwrite the active workspace's context. These observable boundaries SHALL be verified against real Hub state, real workspace children and real terminals. Registration SHALL atomically retain the explicit parent/repository relationship and exact local branch identity, defaulting to stopped. Credentials and shared workspace configuration SHALL be managed only on the parent and inherited live; parent updates SHALL propagate without child overrides or child credential/settings forms. Parent policy SHALL be disclosed, not implemented by copying secrets or adopting ambient credentials. Checkout runtime and personal/per-device UI state MUST remain separate. Creation MUST NOT copy uncommitted or ignored source files, install dependencies, implicitly execute setup scripts, or claim security isolation; it SHALL explain that Git hooks/filters and later project configuration may execute.

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
- **WHEN** a response or live event for a previously active workspace arrives after switching to another
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
The Hub SHALL reconcile authoritative Git worktree inventory on navigator/workspace open, after relevant observed activity, periodically with bounded refresh, and on manual refresh. The existing in-workspace picker SHALL expose creation, discovery and explicit switching as the primary entry point, labelling its selector with the current checkout's repository followed by that checkout's branch, with no separate repository title line above it — one reading for a child and its main checkout alike — and grouping its rows under repository headers whose fork control sits at the header's trailing edge, with consecutive groups separated and no row indented beneath another. Discovery SHALL be presented as one compact list of the checkouts Git lists that Uatu has not registered, reached from the fork menu's Register worktree… item; registered checkouts SHALL be presented and acted on as the picker's and the dashboard's own rows rather than duplicated in a second inventory surface. Uatu-created results SHALL notify interested clients immediately after commit. Inventory updates, including external discovery and reconnect refresh, MUST NOT change the active workspace, selected document/preview, terminal context or selected conversation. Discovered external trees SHALL remain external when registered, SHALL NOT be automatically cleaned up, and SHALL require explicit user open/registration. Missing or replaced paths SHALL surface unavailable/identity-conflict state without silent recreation, forgetting, fallback or workspace/conversation switching.

External checkout registration SHALL preserve its existing path and provenance, disclose live parent policy, and use its exact local branch as the child name. Neither grouping nor a conventional path SHALL imply creation ownership. Every surface SHALL label ownership rather than guess an origin: a registered external checkout reads `External worktree`, an unverifiable one `Ownership uncertain`, and `origin unknown` is reserved for a Uatu-owned branch with no recorded creation history.

#### Scenario: Native agent creates a checkout
- **WHEN** a refresh observes a new tree created by an agent or external Git tool
- **THEN** the picker's Register worktree… list offers explicit registration of that checkout, marked `External worktree` with its branch and path, and leaves the current workspace, document/preview, terminal context and conversation selected
- **AND** a Uatu-created checkout whose registration did not complete appears in that same list with Retry registration on that same checkout

#### Scenario: Native provider worktrees remain native
- **WHEN** Claude or OpenCode uses its own worktree or subagent behavior beside Uatu
- **THEN** Uatu leaves that lifecycle configuration intact and any discovered checkout remains external unless Uatu has verified creation provenance

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

### Requirement: Worktree operations are published as one authenticated JSON family
The Hub SHALL serve every worktree operation from one session-authenticated JSON family under `/api/hub/worktrees`, published through the existing public-contract machinery with no contract exclusion: `GET /api/hub/worktrees?source=<workspaceId>` for inventory and `POST /api/hub/worktrees/{fetch,create,open,preflight-delete,delete,register,forget}` for bounded operations. Requests SHALL require current authentication and authorization for the named source workspace, cookie-authenticated requests SHALL pass the Hub's same-origin check, and results SHALL be scoped to the initiating user with secrets redacted. A refused operation SHALL answer 200 with `{ok: false, error}` carrying the short actionable reason the UI displays, so a safety blocker is never an unexplained transport failure. Creation SHALL NOT accept a destination; deletion SHALL require an explicit confirmation flag and SHALL always keep the branch; no operation SHALL accept a force option. Each operation SHALL answer with its own bounded outcome rather than requiring a separate progress poll. The published Hub state SHALL expose the capability itself — a worktree API field present only when the Hub serves worktrees, and a boolean marker on each main checkout that can fork — rather than URLs of server-rendered pages. Safety SHALL live in the service behind this family so no client can bypass it.

#### Scenario: Blocked operation is an ordinary answer
- **WHEN** a preflight or safety check refuses a create, delete or register request
- **THEN** the response succeeds at transport level, states `ok: false` with the short actionable reason, and nothing is mutated

#### Scenario: Caller lacks access to the named source
- **WHEN** an unauthenticated, cross-origin cookie or unauthorized request names a source workspace
- **THEN** the Hub refuses before any Git or registry mutation and reveals no inaccessible workspace, path or credential

#### Scenario: Operations answer without a progress poll
- **WHEN** a client creates, deletes or registers a checkout
- **THEN** the operation's own response carries its bounded outcome, including retained-checkout recovery state, and no separate operation-status endpoint is required
