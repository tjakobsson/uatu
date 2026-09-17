## ADDED Requirements

### Requirement: Worktree-capable dashboard uses selected Active groups layout
Active groups SHALL be the sole worktree-capable dashboard layout, using reusable actual dashboard presentation. The discarded alternative and layout toggle SHALL be absent; old layout links SHALL safely resolve to Active groups without mutating fixtures. Test-only scenario controls SHALL remain. Default load, reload and create/delete/start/stop operations SHALL preserve the selected presentation. Original row styling/actions, exact branches, provenance and safety SHALL remain; no-capability product behavior SHALL remain unchanged. The repository heading SHALL own parent Configure/Rename/fork, while a separate main checkout row SHALL expose its actual branch and independent lifecycle. User selection of this layout SHALL NOT satisfy final UX gate 2.2 or authorize real integration.

#### Scenario: Main stops while a child runs
- **WHEN** main Stop is activated
- **THEN** only main stops and child runtime remains unchanged; children can also start while main is stopped
- **AND** the repository stays under Active with a clearly stopped main row until the last running checkout stops

#### Scenario: Active and inactive group treatment
- **WHEN** the worktree-capable dashboard loads
- **THEN** groups with any running checkout appear first under Active, stopped children are under expandable `N stopped worktrees`, and entirely stopped repositories are under collapsed Inactive groups with clear expand-to-Start/fork affordance
- **AND** desktop/touch keyboard disclosures and mixed/all-stopped evidence are required, without final UX approval

### Requirement: Hub offers explicit worktree lifecycle navigation
The existing workspace picker SHALL focus on switching and parent-only creation forks, with no Details menu or global worktree action. The dashboard SHALL preserve its original rows/actions and explicit parent/repository hierarchy, exact branch child names and parent forks. Grouping MUST NOT be inferred from names. Generic Details navigation SHALL be absent. Parent Configure manages live inherited credentials/shared policy; children SHALL have no Configure. Open/Start/Stop and Remove from Uatu (unregister) remain distinct from guarded owned-only Delete worktree, using an existing secondary affordance when available. Errors SHALL provide relevant inline retry/actions rather than generic navigation. Visible mock controls SHALL preserve inventory/discovery, recovery and missing-path review without hidden data edits. Compact creation omits policy/path/base readouts and defaults to stopped without switching. Explicit Open SHALL use the separate stable `/s/<workspace-id>/` context and restore its own files/preview/terminal/chat without conversation migration. External registration preserves path/ownership; missing/uncertain trees remain unavailable, never silently recreated. Keyboard, touch, themes and titlebar inset SHALL be supported. No-capability dashboard behavior SHALL remain unchanged.

#### Scenario: Fork targets the selected main workspace
- **WHEN** the reviewer activates the fork on either of two main workspace rows in the picker or real dashboard
- **THEN** a small two-option dropdown offers New branch / worktree and Existing branch, and creation targets that parent only without a source/path readout in the popup
- **AND** neither child has a fork action or independent credential/settings form

#### Scenario: Compact creation supersedes the previous information-heavy form
- **WHEN** New branch / worktree is selected
- **THEN** the popup contains only its title, one name field, Create/Cancel and any necessary error; the approved source HEAD is predetermined with no base-choice UI
- **WHEN** Existing branch is selected
- **THEN** an editable fuzzy combobox covers all local/remote branches with badges and qualified names; picking fills the input exactly, edits clear selection and disable Create, reopening permits reviewing all refs, and arrows/Enter/Escape, focus, touch and empty results are supported
- **AND** the adjacent Fetch remote branches icon explicitly refreshes cached refs, preserving query and a valid choice or invalidating a disappeared choice, with loading and inline errors; opening does not fetch
- **AND** neither popup contains source/base/destination/configuration/ownership readouts; cancellation and no submission do not mutate
- **AND** clicking an initial local or remote row without typing commits the exact input value and enables successful Create

#### Scenario: Preserve dashboard and existing lifecycle access
- **WHEN** worktree capability data is present
- **THEN** the original dashboard row renderer, paths, status dots, shell/credential summaries, style and applicable Rename/Stop/Start/Remove actions remain, augmented by nesting, branch labels and parent forks
- **AND** children follow their parent while retaining truthful individual status/actions, and child rename remains excluded
- **AND** there is no generic Details navigation or global switcher worktree button; parent Configure, relevant recovery actions and guarded owned-only Delete remain available outside the focused switcher

#### Scenario: Nested rows show unobtrusive truthful provenance
- **WHEN** child workspaces appear in the actual workspace selector or original-style dashboard
- **THEN** their exact branch remains primary and a small muted label shows `from <recorded-source-ref>` or `origin unknown`
- **AND** new branch sources reflect the actual simulated parent HEAD, remote-created tracking branches show their selected remote ref, and existing-local/external branches without recorded history remain unknown
- **AND** labels do not change with parent ref/configuration or upstream updates, and compact menus/popups gain no fields or instructions

#### Scenario: Worktree actions are available without leaving the workspace
- **WHEN** a user opens the existing workspace picker while viewing a document or conversation
- **THEN** worktree inventory, create and explicit switch actions are available there without first visiting the Hub dashboard
- **AND** opening or refreshing that inventory does not change the active document, terminal or conversation context

#### Scenario: Created workspace is opened deliberately
- **WHEN** creation succeeds without a start request
- **THEN** the popup closes, the source list/picker/dashboard refreshes, the source remains selected and a small `Created <branch>` confirmation offers Open while leaving the child stopped
- **AND** no Worktree ready, Details or inventory popup opens automatically on any SPA, dashboard or review creation path
- **AND** only explicit Open starts then navigates to its separate stable session URL displaying its own files, preview, terminal and chat

#### Scenario: Partial creation is not described as total failure
- **WHEN** checkout creation succeeds but registration fails
- **THEN** a compact actionable error in the originating flow explains that the checkout and branch remain and offers same-checkout Retry registration rather than duplicate Create or a metadata dump

#### Scenario: Small screen deletion remains intelligible
- **WHEN** a touch user reviews deletion
- **THEN** the compact `Delete worktree?` dialog identifies `<parent display name> / <branch>` with no full path, internal IDs, ownership, status card, duplicate fields, configuration or simulation banner inside
- **AND** stopped copy is “The worktree’s files will be removed. The Git branch will be kept.” with Cancel and destructive Delete
- **AND** running copy is “Its Uatu terminal and agent sessions will stop, then the worktree’s files will be removed. The Git branch will be kept.” with Cancel and destructive Stop and delete, with no extra checkbox
- **AND** normal cases fit the phone viewport without dialog overflow or scrolling

#### Scenario: Safety blocker stays compact and cannot be bypassed
- **WHEN** preflight or recheck identifies dirty/untracked/ignored data, a lock, external ownership/activity, nested dependency or stop failure
- **THEN** a short actionable reason replaces normal deletion consequences and prevents proceeding, with Cancel/Close and retry only where meaningful
- **AND** files and registration remain; no force action or promise to stop unknown external applications is shown
- **WHEN** explicitly authorized known Uatu activity stops successfully and all checks pass
- **THEN** deletion closes the dialog and removes the row, preserves the branch, and uses existing safe navigation if the removed workspace was active

#### Scenario: Back restores usable navigation
- **WHEN** the user opens a worktree and returns via the existing workspace picker or browser history
- **THEN** the opening indicator clears, authoritative or explicitly stale inventory is shown, and the returning workspace restores its own document/preview, terminal context and selected conversation
- **AND** neither workspace's conversations are migrated or replaced by those from the other checkout

## MODIFIED Requirements

### Requirement: Workspace and filesystem actions use distinct language
Workspace rows and directory rows SHALL distinguish Rename workspace, Rename folder, Remove from Hub, Remove folder, and Delete worktree. Rename workspace SHALL remain available for ordinary/main workspaces while stopped or running and SHALL change only the display name. Linked child workspace names SHALL reflect their exact local branch; independent child renaming and branch rename are out of scope. Rename folder SHALL retain existing coordinated filesystem behavior and stable URL id only when Git dependency safety checks permit the move; it SHALL be refused for linked checkout, main/common-directory or ancestor dependencies that would break worktree links, including dependencies outside the Hub registry. The refusal SHALL explain that stopping does not make this safe and offer display-name editing only where applicable. Remove from Hub SHALL preserve the folder, while Remove folder SHALL retain its empty-directory restriction. Delete worktree SHALL be a separate guarded operation for verified Uatu-created linked checkouts. A stopped registered directory SHALL offer Start rather than Open; a running workspace SHALL offer Open.

#### Scenario: Running workspace display name is changed
- **WHEN** a user renames a running workspace from `API` to `Payments API`
- **THEN** Hub-owned workspace lists and navigation show `Payments API`
- **AND** its session, folder path, stable id, and URL remain unchanged

#### Scenario: Stopped registered folder is selected
- **WHEN** the directory browser lists a registered workspace with no running session
- **THEN** its primary action is Start
- **AND** activating it uses the normal credential-aware start flow rather than navigating to an unavailable session

#### Scenario: Unsafe folder move is explained
- **WHEN** a proposed folder rename would invalidate worktree links
- **THEN** the browser reports the refusal without stop as a bypass; ordinary/main display-name editing remains available, while a child's name continues to follow its branch
