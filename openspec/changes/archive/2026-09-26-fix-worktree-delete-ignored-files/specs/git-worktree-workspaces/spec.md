## MODIFIED Requirements

### Requirement: Manual deletion is guarded and distinct from forgetting
Deletion SHALL be limited to verified Uatu-created linked trees and require explicit confirmation identifying parent display name / branch, with Delete for stopped trees or Stop and delete for running trees. For a checkout without local data, the destructive button SHALL authorize the stated Uatu stop/removal operation without another checkbox; internal path/identity checks MUST remain authoritative and MUST NOT require a metadata-heavy dialog. The Hub SHALL fence starts, await in-flight starts, stop Uatu sessions/agents/terminals, respect locks, revalidate identity and inspect tracked/untracked/ignored data before removal. Locked, nested-dependent (a nested linked worktree, an initialized submodule or a nested Git repository inside the checkout, including a bare repository, anywhere except deeper inside an ignored directory), Git-operation-in-progress, externally active/owned or uncertain states SHALL block with short actionable explanations replacing normal dialog consequences. Tracked changes (staged or unstaged), untracked files and ignored files are acknowledgeable local data. Local data SHALL NOT be removed without the user's explicit acknowledgement. When local data is present and nothing else blocks, the confirmation SHALL keep the normal consequences and add a warning that the listed files will be permanently deleted with the worktree and cannot be recovered. For each category present, the warning SHALL state how many entries it has and list a short sorted sample of their checkout-relative paths, never absolute paths, and SHALL say how many more exist when the sample is truncated. An entry that is a whole folder SHALL be marked as a folder, and the warning SHALL make clear that a listed folder is deleted with everything inside it. It SHALL add a required checkbox confirming permanent deletion of those files with the worktree. The destructive button SHALL keep its Delete or Stop and delete label, and it SHALL NOT delete anything while that checkbox is unchecked; submitting unchecked SHALL say that confirmation is required and that nothing changed. Cancel SHALL leave the worktree unchanged. The acknowledgement SHALL cover exactly the set of local-data status entries the confirmation reported. At every safety recheck before removal, local data that was not acknowledged, or that differs from the acknowledged set, SHALL block with a short actionable local-data explanation, and checkout and registration SHALL be retained. When no local data remains, deletion SHALL proceed whether or not an acknowledgement was given. Removal SHALL be non-force unless the acknowledged, still-matching local data includes tracked changes or untracked files; only then SHALL the Hub pass Git a single force, and never the double force that overrides a Git lock. The acknowledgement SHALL NOT override any other blocker. The UI MUST NOT imply it can stop unknown external applications. Branches SHALL always remain, so committed work and the repository's stashes are unaffected; branch-deletion UI and operations are out of scope. Failed stop/removal SHALL retain registration and files. Verified removal SHALL precede unregister/metadata cleanup with recoverable cleanup failure. Success SHALL close the popup and remove the row with safe navigation for an active removed context. Forget SHALL only unregister a stopped workspace and remove Hub personal state; checkout, branch and provenance SHALL remain.

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
The Hub SHALL serve every worktree operation from one session-authenticated JSON family under `/api/hub/worktrees`, published through the existing public-contract machinery with no contract exclusion: `GET /api/hub/worktrees?source=<workspaceId>` for inventory and `POST /api/hub/worktrees/{fetch,create,open,preflight-delete,delete,register,forget}` for bounded operations. Requests SHALL require current authentication and authorization for the named source workspace, cookie-authenticated requests SHALL pass the Hub's same-origin check, and results SHALL be scoped to the initiating user with secrets redacted. A refused operation SHALL answer 200 with `{ok: false, error}` carrying the short actionable reason the UI displays, so a safety blocker is never an unexplained transport failure. Creation SHALL NOT accept a destination. Deletion SHALL require an explicit confirmation flag and SHALL always keep the branch. When a checkout has local data (tracked changes, untracked files or ignored entries) and nothing else blocks, a successful deletion preflight SHALL describe it: for each category present, its count and a short sorted sample of checkout-relative paths, plus one opaque fingerprint of the complete set of local-data status entries. A deletion request SHALL accept that fingerprint as an optional acknowledgement. The acknowledgement authorizes discarding only the local data it identifies. It SHALL NOT override a lock, a nested dependency, an initialized submodule or nested repository, external activity, uncertain identity or ownership. While local data exists, a deletion request without a matching acknowledgement SHALL be refused. No operation SHALL accept a force option or any other client-supplied override. The acknowledgement of exactly the disclosed data SHALL be the only way to discard local data. The Hub MAY pass Git a single force only to remove acknowledged tracked changes or untracked files. Each operation SHALL answer with its own bounded outcome rather than requiring a separate progress poll. The published Hub state SHALL expose the capability itself — a worktree API field present only when the Hub serves worktrees, and a boolean marker on each main checkout that can fork — rather than URLs of server-rendered pages. Safety SHALL live in the service behind this family so no client can bypass it.

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
