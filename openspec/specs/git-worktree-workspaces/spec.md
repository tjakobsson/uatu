# git-worktree-workspaces Specification

## Purpose

Define provider-neutral Git worktrees as independent Hub workspaces, with explicit provenance, safe creation and removal, conservative discovery, one published operation family, and a recorded UX approval.

## Requirements

### Requirement: Approved worktree UX obligations hold on the real surfaces
The existing workspace picker SHALL be the primary worktree create/discover/switch entry point, with dashboard entry points secondary. The approved UX SHALL hold on real surfaces, with independent checkout contexts and checks against real product entry points rather than retired prototypes.

#### Scenario: Approved prototype obligations are verified on actual product surfaces
Historical context, not an acceptance precondition: the resettable mock-backed prototype in the actual workspace frontend received explicit UX approval recorded on 2026-09-17 before real Git/backend integration. That prototype and its harnesses are retired.
- **WHEN** the worktree experience is delivered or tested
- **THEN** its established obligations SHALL hold on real surfaces; each registered checkout SHALL open its own `/s/<workspace-id>/` with its own files, preview, terminal, and chat
- **AND** desktop, narrow touch, keyboard/focus/error announcements, light/dark, and desktop WebView titlebar inset SHALL work in the actual frontend, not only Hub cards
- **AND** surfaces MUST NOT depend on mock hosts, scenario controls, demo pages, or gallery fixtures; every automated check SHALL use product code's real entry points with real Hub state and temporary Git repositories

#### Scenario: User exercises the actual workspace picker
- **WHEN** a user creates a worktree from a populated workspace's existing picker and explicitly starts and opens the stopped result
- **THEN** its separate stable session URL displays the actual frontend with that workspace's own files, preview, terminal and chat
- **AND** desktop, narrow touch, keyboard/focus/error announcements, light/dark and desktop titlebar inset behavior remain correct in that frontend

#### Scenario: Approval is recorded, the prototype is retired
- **WHEN** the worktree surfaces are reviewed or changed after the recorded approval
- **THEN** the approved behavior remains the acceptance standard and no mock host, demo page, gallery or scenario control is required to demonstrate it

### Requirement: Creation supports explicit branch modes without force
The Hub SHALL create ordinary linked worktrees from explicit new-local, existing-local, or remote-tracking branch choices, validating paths, refs, names, availability, and occupancy without replacement, reset, or forced duplicate checkout. Loading/errors SHALL be inline. Compact client dialogs SHALL preserve exact branch intent and predetermined safe destinations.

#### Scenario: Parent forks offer explicit creation and unregistered-checkout choices
- **WHEN** a parent fork is opened
- **THEN** it SHALL offer New branch / worktree, Existing branch, and Register worktree…, the latter listing only Git-listed checkouts of that repository not registered by Uatu
- **AND** new creation SHALL show target title, Name, Create from, and Create/Cancel; Create from and Existing's Branch SHALL share accessible editable fuzzy local/remote semantics, badges, qualified refs, keyboard/touch, and empty results
- **AND** both dialogs SHALL be client-rendered from published worktree JSON with these roles, labels, copy, and keyboard behavior, no destination/settings/details/ownership/extra metadata, and compact viewport-safe expanded lists with safely reachable buttons

#### Scenario: Branch lists default conservatively and exclude occupied targets
- **WHEN** Create from initially opens
- **THEN** it SHALL prefer local main, otherwise sole remote named main; ambiguous/absent mains SHALL require explicit choice, never current HEAD fallback

#### Scenario: Every branch-list opening exposes its full eligible listing
- **WHEN** either branch list opens, before anything is typed
- **THEN** it SHALL open expanded: Create from with full local/remote listing, Existing's Branch only unheld branches, excluding locals checked out by any listed checkout and remotes whose derived local tracking names exist locally
- **AND** when Existing's Branch has no eligible refs, it SHALL show `Every branch is already checked out. Create a new branch instead.` with Create disabled
- **WHEN** an explicit fetch completes
- **THEN** the same filtering SHALL apply, including the no-remaining-branches message and disabled Create

#### Scenario: Checked-out bases remain valid without forcing occupied targets
- **WHEN** creation validates a target or starting branch
- **THEN** checked-out targets MUST NOT be forced into another checkout, but a checked-out starting branch SHALL remain valid for a different new branch

#### Scenario: Fetch and combobox interaction preserve exact creation intent
- **WHEN** branch comboboxes open or adjacent Fetch remote branches is activated
- **THEN** cached refs SHALL display without automatic network calls, with inline loading/errors; fetch SHALL retain name/query/valid choice, invalidate disappeared refs, and MUST NOT reapply defaults or substitute refs silently
- **WHEN** the user clicks, taps, presses Enter, edits, reopens, or dismisses a list
- **THEN** click/tap/Enter SHALL commit the exact ref and confirm choice, Enter MUST NOT submit, and touch SHALL commit options and activate footer actions like pointer clicks
- **AND** edits SHALL clear choice and disable Create; invalid/empty Name or pending operation SHALL disable new Create; reopening SHALL offer all refs
- **AND** Escape SHALL close list before popup, blur/click-away SHALL close list without losing first-click footer actions, and Cancel/reopen SHALL discard drafts and apply initial defaults only

#### Scenario: New Create is disabled for invalid names and pending operations
- **WHEN** Name is invalid or empty, or an operation is pending, regardless of list interaction
- **THEN** new Create SHALL be disabled

#### Scenario: Checkout destinations and branch names remain separate
- **WHEN** a new checkout is created from the selected repository and explicit branch mode
- **THEN** it SHALL use a new local branch from the selected starting branch, an existing local branch, or a new local tracking branch from the selected remote ref
- **AND** destination SHALL be predetermined sibling `<main-folder>.worktrees/<safe-branch-folder>`, while child name SHALL equal the exact current local branch including slashes, not sanitized folder name
- **AND** no destination/name form or child branch rename SHALL be offered
- **AND** sanitized collisions SHALL be deterministic without overwrite, refusing if the disambiguated destination remains occupied; occupancy SHALL be repository-identity-scoped, not globally branch-string-scoped

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
Nested worktree rows SHALL distinguish recorded branch creation source from tracking/upstream and live parent policy. Historical origin SHALL come only from Uatu's durable provenance, never Git inference; absent trustworthy history SHALL remain unknown.

#### Scenario: Creation snapshots exact source refs without inferring existing history
- **WHEN** a new branch or new tracking branch is created
- **THEN** it SHALL snapshot the explicitly selected starting ref or selected remote-qualified source respectively
- **WHEN** an existing-local or external branch lacks explicit trustworthy creation history
- **THEN** origin SHALL remain unknown

#### Scenario: Historical origin is never guessed from live Git relationships
- **WHEN** historical branch origin is determined for any branch
- **THEN** Git upstream, merge-base, parent identity, and checkout starting revision MUST NOT be used to guess it

#### Scenario: Parent ref or configuration changes after creation
- **WHEN** a branch is created with `release` explicitly selected as its base, then that parent changes checkout ref or configuration
- **THEN** the child's recorded source remains `release`, while shared configuration still inherits live

#### Scenario: Remote tracking and unknown existing history
- **WHEN** a new local tracking branch is created from `origin/foo`
- **THEN** its source remains `origin/foo` even if its upstream later changes
- **WHEN** an existing local branch or external checkout has no recorded branch-creation history
- **THEN** its origin is unknown, even when it has an upstream or known checkout starting revision

### Requirement: Workspace boundaries and credentials remain explicit
Registered worktrees SHALL have independent workspace/runtime/UI contexts, with atomic stopped registration retaining parent/repository and exact branch identity. Conversations MUST stay on their original checkout without migration or copying by creation, discovery, or switching. Credentials and shared policy SHALL inherit live only from the parent, without child assignments, copied secrets, or ambient-credential adoption.

#### Scenario: Switching and delayed events preserve checkout-local context
- **WHEN** a registered worktree is opened or revisited through picker/history
- **THEN** its independent workspace identity, child/watch root, terminal cwd, and provider directory context SHALL apply; picker switching SHALL navigate to separate `/s/<workspace-id>/` files/preview/terminal/chat, not replace a checkout in place
- **AND** return SHALL restore its own selected document/preview, terminal context, and conversation
- **AND** boundaries SHALL be verified with real Hub state, real workspace children, and real terminals; checkout runtime and personal/per-device UI state MUST remain separate

#### Scenario: Other-workspace completions cannot overwrite active context
- **WHEN** a delayed response or live event arrives from another workspace
- **THEN** it MUST NOT overwrite the active workspace's context

#### Scenario: Child credential policy is inherited and assignment writes target its owner
- **WHEN** a worktree is registered
- **THEN** registration SHALL atomically retain explicit parent/repository relationship and exact local branch, defaulting to stopped
- **WHEN** credentials or shared workspace configuration are managed
- **THEN** they SHALL be managed only on the parent and inherited live; parent updates SHALL propagate without child overrides or child credential/settings forms
- **AND** policy SHALL be disclosed without secret copying or ambient credentials

#### Scenario: Every child policy report shows its effective parent assignments
- **WHEN** any surface reports a child's credential policy
- **THEN** it SHALL report the parent's effective assignments and name that parent, rather than present the child's own empty assignment record as an absence of credentials
- **WHEN** assignment/unassignment names a linked worktree
- **THEN** it SHALL be refused with a conflict naming the parent before stopping any workspace, leaving no child assignment and no cost to a running child

#### Scenario: Creation discloses execution limits without copying source state
- **WHEN** a checkout is created
- **THEN** it MUST NOT copy uncommitted/ignored source files, install dependencies, implicitly execute setup scripts, or claim security isolation
- **AND** it SHALL explain Git hooks/filters and later project configuration may execute

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

#### Scenario: A child's row discloses the parent's credentials
- **WHEN** the Hub dashboard lists a linked worktree whose parent holds authentication and signing assignments
- **THEN** the child's row summarises the parent's assigned credential names and states that they are inherited, naming the parent
- **AND** a child of a parent that holds no assignments reads as having none, still naming the parent it inherits from
- **AND** a workspace that owns its own policy summarises its own assignments with no inheritance note

#### Scenario: An assignment naming a child is refused
- **WHEN** a request assigns a credential to a linked worktree, replaces that worktree's assignments, or unassigns a credential from it
- **THEN** the Hub refuses the request with a conflict that names the parent workspace holding the policy
- **AND** no assignment is recorded against the child, while the same request naming the parent is accepted
- **AND** a refused removal that asked to stop the workspace leaves the child running, with no session stopped

### Requirement: Creation provenance and partial outcomes are recoverable
The Hub SHALL durably distinguish verified Uatu-created checkouts from external or uncertain checkouts independently of registration. Creation SHALL coordinate repository and destination mutations, report bounded operation progress and sanitized errors, and support idempotent recovery after interruption.

#### Scenario: Partial registration retains checkout without transferring stale ownership
- **WHEN** Git creation succeeds but registration fails
- **THEN** checkout and branch MUST remain with registration retry that does not recreate them

#### Scenario: Reused paths and uncertain identities cannot inherit stale ownership
- **WHEN** a path is reused or a checkout identity is uncertain, regardless of registration outcome
- **THEN** it MUST NOT acquire ownership from an older record

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
The Hub SHALL reconcile authoritative Git inventory through the existing picker without automatic navigation or ownership inference. External registration SHALL preserve path/provenance and require explicit action; missing or replaced checkouts SHALL remain unavailable rather than silently recreated or forgotten.

#### Scenario: Inventory refresh is authoritative and non-navigating
- **WHEN** navigator/workspace opens, relevant activity is observed, a bounded periodic refresh occurs, or manual refresh is requested
- **THEN** the Hub SHALL reconcile authoritative Git worktree inventory
- **AND** inventory updates including external discovery/reconnect MUST NOT change active workspace, selected document/preview, terminal context, or selected conversation
- **AND** missing/replaced paths SHALL expose unavailable/identity-conflict state without silent recreation, forgetting, fallback, or workspace/conversation switching

#### Scenario: Committed Uatu-created results immediately notify interested clients
- **WHEN** Uatu-created results commit
- **THEN** interested clients SHALL be notified immediately

#### Scenario: Picker discovery lists only unregistered Git checkouts
- **WHEN** users access creation, discovery, or switching
- **THEN** the existing picker SHALL be primary, with selector repository-then-branch reading alike for main/child and no separate repository title above it
- **AND** repository headers SHALL have trailing forks, consecutive groups separated, and no row indentation
- **AND** Register worktree… SHALL open one compact list of only Git-listed unregistered checkouts; registered checkouts SHALL remain picker/dashboard rows without a duplicate inventory surface

#### Scenario: External registration preserves ownership and explicit policy disclosure
- **WHEN** an external checkout is discovered or registered
- **THEN** it SHALL remain external, require explicit open/registration, and SHALL NOT be automatically cleaned up
- **AND** registration SHALL preserve existing path/provenance, disclose live parent policy, and name the child by exact local branch

#### Scenario: Every surface labels ownership without guessing branch origin
- **WHEN** any surface presents checkout ownership or origin
- **THEN** grouping and conventional paths SHALL NOT imply creation ownership
- **AND** it SHALL use `External worktree` for registered external checkouts, `Ownership uncertain` for unverifiable ones, and reserve `origin unknown` for Uatu-owned branches without recorded creation history

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
Deletion SHALL be limited to verified Uatu-created linked trees and require explicit confirmation and authoritative safety rechecks. Local data SHALL require exact disclosed acknowledgement without bypassing other blockers. Branches SHALL remain; Forget SHALL only unregister stopped workspaces and remove Hub personal state.

#### Scenario: Delete confirmation authorizes only known Uatu activity and verified checkout removal
- **WHEN** deletion of a linked tree is requested
- **THEN** deletion SHALL be limited to verified Uatu-created trees, with explicit confirmation identifying parent display name / branch and label Delete if stopped or Stop and delete if running
- **AND** clean-checkout destructive action SHALL authorize stated Uatu stop/removal without another checkbox, while internal path/identity checks MUST remain authoritative without metadata-heavy dialogs
- **AND** the Hub SHALL fence starts, await in-flight starts, stop Uatu sessions/agents/terminals, respect locks, revalidate identity, and inspect tracked/untracked/ignored data before removal
- **AND** the UI MUST NOT imply it can stop unknown external applications

#### Scenario: Non-data safety blockers cannot be acknowledged away
- **WHEN** deletion finds locks, nested dependencies, Git operations in progress, external activity/ownership, or uncertain state
- **THEN** short actionable reasons SHALL replace normal consequences and block removal, and data acknowledgement SHALL NOT override them
- **AND** nested dependencies SHALL include nested linked worktrees, initialized submodules, and nested Git repositories including bare repositories anywhere inside the checkout except deeper inside an ignored directory

#### Scenario: Local-data disclosure requires exact permanent-deletion acknowledgement
- **WHEN** staged/unstaged tracked changes, untracked files, or ignored files are present without other blockers
- **THEN** confirmation SHALL retain normal consequences and warn listed files will be permanently deleted with the worktree and cannot be recovered
- **AND** each present category SHALL show entry count and a short sorted checkout-relative, never absolute, path sample plus remaining count when truncated; whole folders SHALL be marked and explained as deleted with all contents
- **AND** a required checkbox SHALL confirm permanent deletion of those files; Delete/Stop and delete labels SHALL remain
- **AND** unchecked submission SHALL delete nothing and say confirmation is required and nothing changed

#### Scenario: Cancelling any deletion leaves the worktree unchanged
- **WHEN** deletion is cancelled, with or without local data
- **THEN** the worktree SHALL remain unchanged

#### Scenario: Rechecks bind removal force to the reviewed data set
- **WHEN** deletion rechecks local data before removal
- **THEN** acknowledgement SHALL cover exactly the reported local-data status entries, and unacknowledged/different data SHALL block with a short actionable local-data explanation retaining checkout and registration
- **AND** local data SHALL NOT be removed without explicit acknowledgement; when no local data remains deletion SHALL proceed with or without acknowledgement
- **AND** removal SHALL be non-force unless the acknowledged, still-matching local data includes tracked changes or untracked files; only then SHALL the Hub pass Git a single force, and never the double force that overrides a Git lock

#### Scenario: Removal completion and Forget retain branches and recoverable state
- **WHEN** stop/removal fails
- **THEN** registration and files SHALL remain
- **WHEN** removal succeeds
- **THEN** verified removal SHALL precede unregister/metadata cleanup with recoverable cleanup failure, close the popup, remove the row, and safely navigate an active removed context
- **AND** branches SHALL always remain, leaving committed work and repository stashes unaffected; branch-deletion UI/operations are out of scope
- **WHEN** Forget is used
- **THEN** it SHALL only unregister a stopped workspace and remove Hub personal state, retaining checkout, branch, and provenance

#### Scenario: Known running Uatu workspace can be stopped and deleted
- **WHEN** the user explicitly selects Stop and delete for a known running Uatu workspace
- **THEN** the operation attempts to stop its Uatu activity and performs every safety recheck before removal, without another hidden confirmation requirement
- **AND** unrelated external activity remains a blocker rather than an activity Uatu claims it can stop

#### Scenario: Clean owned tree is deleted
- **WHEN** the user confirms deletion and all activity, identity, lock and data checks pass and the checkout has no local data
- **THEN** no acknowledgement checkbox is shown, non-force Git removal deletes the linked checkout, Hub removes its registration and associated state, and the branch remains

#### Scenario: Local data is disclosed before deletion
- **WHEN** a verified Uatu-created checkout has tracked changes, untracked files or ignored entries, and nothing else blocks
- **THEN** the confirmation keeps its normal consequences and warns that the listed files will be permanently deleted with the worktree and cannot be recovered
- **AND** for each category present, it states the count and lists a short sample of checkout-relative paths, noting how many more exist when the sample is truncated
- **AND** a folder entry is marked as a folder that will be deleted with everything inside it
- **AND** it shows a required checkbox confirming permanent deletion of those files, the destructive button reads Delete, or Stop and delete when the workspace is running, and Cancel is offered

#### Scenario: Unchecked checkbox cannot delete
- **WHEN** the user submits a confirmation that disclosed local data without ticking the checkbox
- **THEN** nothing is sent to delete the worktree, and the dialog stays open and states that confirmation is required and nothing changed

#### Scenario: Acknowledged local data is deleted with the worktree
- **WHEN** the user ticks the checkbox and confirms, and every recheck finds the same local-data entries the confirmation reported, and no other blocker
- **THEN** Git removes the checkout together with that data, including modified, staged and untracked files and ignored entries, and Hub removes its registration and associated state
- **AND** removal uses a single force only when the data includes tracked changes or untracked files, and non-force removal otherwise
- **AND** the branch and its commits remain

#### Scenario: Local data changes after review
- **WHEN** the set of local-data entries differs at any recheck from the set the user acknowledged, for example because a file was modified, staged, created or deleted, a new top-level ignored entry appeared, or the ignore rules changed
- **THEN** deletion is refused with a short local-data explanation that the worktree changed while deletion was prepared and must be reviewed again
- **AND** the confirmation shows the refusal together with the local data as it is now, with the checkbox unticked, or the blocker it now finds in place of the normal consequences
- **AND** both checkout and registration are retained and nothing is removed

#### Scenario: Local data or lock blocks deletion
- **WHEN** a deletion request that does not acknowledge local data reaches a checkout that contains local data, or the checkout has a Git lock
- **THEN** deletion reports the blocker, naming the local-data category or the lock, and retains both checkout and registration
- **AND** Git removal does not run

#### Scenario: Cancel keeps the worktree unchanged
- **WHEN** the user cancels a confirmation that warned about local data
- **THEN** nothing is stopped or removed, and the checkout, its local data, its registration and its branch remain as they were

#### Scenario: Local data acknowledgement is not a force option
- **WHEN** the checkout has a Git lock, a nested linked worktree, an initialized submodule or nested Git repository (bare or not), a Git operation in progress, external activity or uncertain identity, whether or not it also has acknowledged local data with a matching fingerprint
- **THEN** deletion reports that blocker, offers no acknowledgement in its place, and retains both checkout and registration
- **AND** Git never receives more than one force, so a Git lock is never overridden

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
All worktree operations SHALL use one session-authenticated published JSON family under `/api/hub/worktrees`, with bounded own-response outcomes and service-enforced safety. Creation SHALL reject client destinations; deletion SHALL require confirmation, retain branches, and bind optional data acknowledgement to exact disclosed local data without force overrides.

#### Scenario: Published worktree operations enforce authentication and bounded JSON outcomes
- **WHEN** a client accesses worktree inventory or operations
- **THEN** existing public-contract machinery SHALL publish without exclusions `GET /api/hub/worktrees?source=<workspaceId>` and `POST /api/hub/worktrees/{fetch,create,open,preflight-delete,delete,register,forget}`
- **AND** current authentication/source-workspace authorization SHALL be required, cookie requests SHALL pass Hub same-origin checks, and results SHALL be initiating-user-scoped with secrets redacted
- **AND** refusal SHALL answer 200 with `{ok: false, error}` carrying a short actionable UI reason, not unexplained transport failure
- **AND** each operation SHALL return its own bounded outcome without a separate progress poll; service-level safety SHALL prevent client bypass

#### Scenario: Deletion preflight exposes only bounded acknowledged local-data authority
- **WHEN** tracked changes, untracked files, or ignored entries exist without other blockers
- **THEN** successful preflight SHALL report each category's count and short sorted checkout-relative path sample plus one opaque fingerprint of the complete local-data status-entry set
- **AND** deletion SHALL accept the fingerprint optionally, authorizing only the exact identified data; while data exists a missing/mismatching acknowledgement SHALL be refused
- **AND** acknowledgement SHALL NOT override locks, nested dependencies, initialized submodules/nested repositories, external activity, uncertain identity, or ownership

#### Scenario: Every operation rejects client safety overrides
- **WHEN** any worktree operation is requested, with or without local data
- **THEN** no operation SHALL accept force or other client-supplied overrides
- **AND** exact disclosed acknowledgement SHALL be the only way to discard local data; the Hub MAY pass Git a single force only for acknowledged tracked changes or untracked files
- **AND** deletion SHALL require explicit confirmation and always retain the branch; creation SHALL NOT accept a destination

#### Scenario: Capability discovery uses published state rather than presentation URLs
- **WHEN** Hub state advertises worktrees
- **THEN** it SHALL expose a worktree API field only when served and boolean marker per fork-capable main checkout, not server-rendered page URLs

#### Scenario: Blocked operation is an ordinary answer
- **WHEN** a preflight or safety check refuses a create, delete or register request
- **THEN** the response succeeds at transport level, states `ok: false` with the short actionable reason, and nothing is mutated

#### Scenario: Caller lacks access to the named source
- **WHEN** an unauthenticated, cross-origin cookie or unauthorized request names a source workspace
- **THEN** the Hub refuses before any Git or registry mutation and reveals no inaccessible workspace, path or credential

#### Scenario: Operations answer without a progress poll
- **WHEN** a client creates, deletes or registers a checkout
- **THEN** the operation's own response carries its bounded outcome, including retained-checkout recovery state, and no separate operation-status endpoint is required

#### Scenario: Preflight describes local data it would delete
- **WHEN** a client requests deletion preflight for a checkout with local data and no other blocker
- **THEN** the answer is `ok: true` and carries, for each category present, the entry count and a bounded sample of checkout-relative paths, plus the fingerprint of the complete set
- **AND** a checkout without local data carries no local-data description

#### Scenario: Acknowledgement is not a force option
- **WHEN** a deletion request carries a matching local-data fingerprint but the checkout also has a lock, a nested worktree, an initialized submodule or nested repository, a Git operation in progress, external activity or uncertain identity
- **THEN** the request is refused with that blocker as an ordinary `ok: false` answer, nothing is removed, and Git removal never runs

#### Scenario: Stale or malformed acknowledgement is refused
- **WHEN** a deletion request carries a fingerprint that does not match the checkout's current local data, or a value that is not a well-formed fingerprint
- **THEN** the request is refused without mutation, as a local-data blocker for a stale fingerprint or as invalid input for a malformed value
