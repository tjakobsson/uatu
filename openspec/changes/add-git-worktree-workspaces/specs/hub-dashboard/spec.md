## ADDED Requirements

### Requirement: Worktree-capable dashboard uses selected Active groups layout
Active groups SHALL be the sole worktree-capable dashboard layout, using reusable actual dashboard presentation. The discarded alternative and layout toggle SHALL be absent. Default load, reload and create/delete/start/stop operations SHALL preserve the selected presentation. Original row styling/actions, exact branches, provenance and safety SHALL remain; no-capability product behavior SHALL remain unchanged. The repository heading SHALL own parent Rename and fork, while a separate main checkout row SHALL expose its actual branch and independent lifecycle.

#### Scenario: Main stops while a child runs
- **WHEN** main Stop is activated
- **THEN** only main stops and child runtime remains unchanged; children can also start while main is stopped
- **AND** the repository stays under Active with a clearly stopped main row until the last running checkout stops

#### Scenario: Active and inactive group treatment
- **WHEN** the worktree-capable dashboard loads
- **THEN** groups with any running checkout appear first under Active, stopped children are under expandable `N stopped worktrees`, and entirely stopped repositories are under collapsed Inactive groups with clear expand-to-Start/fork affordance
- **AND** desktop/touch keyboard disclosures and mixed/all-stopped evidence are required

### Requirement: Hub offers explicit worktree lifecycle navigation
The existing workspace picker SHALL focus on switching and parent-only creation forks, with no Details menu or global worktree action. The workspace selector itself SHALL name the current checkout as its repository — a child's parent, a main checkout's own name — followed by its branch, in that one reading for every checkout in a repository family, so a child and its main checkout are labelled alike; it SHALL be the only place the picker names the repository of the current checkout, with no separate title line above it. A workspace with no repository family SHALL keep its display name alone, with no branch. It SHALL group its rows by repository: a non-interactive group header carrying the repository name with its fork control at the header's trailing edge, then that repository's main checkout row, then its children — all sharing one left edge, with no indentation, and consecutive repository groups visually separated from one another. A workspace with no repository family SHALL remain an ungrouped row. The dashboard SHALL preserve its original rows/actions and explicit parent/repository hierarchy, exact branch child names and parent forks, and SHALL place every row of a repository group on one left edge — its repository heading and main checkout row carry the hierarchy, so no child row is indented or given tree-line styling. Grouping MUST NOT be inferred from names. Generic Details navigation SHALL be absent. Parent credentials and shared policy, which children inherit live, SHALL be managed on the Hub's Settings page reached from its own navigation; neither a repository heading nor a child row SHALL carry a Configure control of its own. Open/Start/Stop and Remove from Uatu (unregister) remain distinct from guarded owned-only Delete worktree, using an existing secondary affordance when available. Errors SHALL provide relevant inline retry/actions rather than generic navigation. Inventory, discovery, recovery and missing-path states SHALL be reviewable on the real surfaces. Compact creation omits policy/path/base readouts and defaults to stopped without switching. Explicit Open SHALL use the separate stable `/s/<workspace-id>/` context and restore its own files/preview/terminal/chat without conversation migration. External registration preserves path/ownership; missing/uncertain trees remain unavailable, never silently recreated. Keyboard, touch, themes and titlebar inset SHALL be supported. No-capability dashboard behavior SHALL remain unchanged.

#### Scenario: Fork targets the selected main workspace
- **WHEN** the reviewer activates the fork on either of two main workspace rows in the picker or real dashboard
- **THEN** a small dropdown offers New branch / worktree, Existing branch and Register worktree…, and creation targets that parent only without a source/path readout in the popup
- **AND** Register worktree… opens a compact list of only the checkouts Git lists for that repository that Uatu has not registered — each with its branch, ownership label and path, offering Register workspace for an external tree and Retry registration for a retained Uatu-created checkout — with `Every worktree Git lists is registered.` and Cancel when there are none
- **AND** neither child has a fork action or independent credential/settings form

#### Scenario: Compact creation has an explicit starting branch
- **WHEN** New branch / worktree is selected
- **THEN** the popup contains target title, Name, Create from and Create/Cancel; Create from uses the shared local/remote editable fuzzy combobox plus adjacent Fetch
- **AND** initial choice prefers local main then sole remote main, otherwise stays empty; current checkout does not control defaults and refetch never reapplies them
- **WHEN** Existing branch is selected
- **THEN** an editable fuzzy combobox covers all local/remote branches with badges and qualified names; picking fills the input exactly, edits clear selection and disable Create, reopening permits reviewing all refs, and arrows/Enter/Escape, focus, touch and empty results are supported
- **AND** the adjacent Fetch remote branches icon explicitly refreshes cached refs, preserving query and a valid choice or invalidating a disappeared choice, with loading and inline errors; opening does not fetch
- **AND** neither popup contains extra metadata/destination/configuration/ownership readouts; cancellation and no submission do not mutate
- **AND** clicking an initial local or remote row without typing commits the exact input value and enables successful Create

#### Scenario: Preserve dashboard and existing lifecycle access
- **WHEN** worktree capability data is present
- **THEN** the original dashboard row renderer, paths, status dots, shell/credential summaries, style and applicable Rename/Stop/Start/Remove actions remain, augmented by nesting, branch labels and parent forks
- **AND** children follow their parent while retaining truthful individual status/actions, and child rename remains excluded
- **AND** there is no generic Details navigation, global switcher worktree button or per-repository Configure control; parent policy on the Hub's Settings page, relevant recovery actions and guarded owned-only Delete remain available outside the focused switcher

#### Scenario: Nested rows show unobtrusive truthful provenance
- **WHEN** child workspaces appear in the actual workspace selector or original-style dashboard
- **THEN** their exact branch remains primary and a small muted label states ownership first: `External worktree` for a registered external tree, `Ownership uncertain` for an unverifiable one, and otherwise `from <recorded-source-ref>` or, for a Uatu-owned branch with no recorded history, `origin unknown`
- **AND** new branch sources reflect the exact selected starting ref, remote-created tracking branches show their selected remote ref, and existing-local/external branches without recorded history remain unknown
- **AND** labels do not change with parent checkout/configuration or upstream updates

#### Scenario: Current main checkout is not creation provenance
- **WHEN** the main workspace is checked out on feature/foo
- **THEN** dashboard and selector display feature/foo compactly, distinct from repository identity and child origin labels
- **WHEN** the checkout changes, is detached, or its branch is unknown
- **THEN** refresh reflects the current ref or explicit Detached HEAD / Branch unknown state without guessing main or modifying child sourceRef

#### Scenario: Picker labels every checkout the same way and groups without indentation
- **WHEN** a user opens the workspace picker from a child worktree of a repository
- **THEN** the selector reads that checkout's repository followed by its branch, in the same weight and size as a main checkout's own repository-then-branch reading, keeping its running/stopped indicator and its activity badge
- **WHEN** the picker's menu lists two repositories
- **THEN** each repository's group header carries its name with its single fork control at the header's trailing edge, the header is visually distinct from the rows beneath it, and consecutive groups are separated from one another while the first group needs no separator of its own
- **AND** the main checkout row leads its group with its branch beneath, children follow with their ownership labels beneath, and every row — main checkout and child alike — shares one left edge with no indentation or tree lines
- **AND** the menu fits a 390 px viewport without horizontal overflow in both colour schemes

#### Scenario: Worktree actions are available without leaving the workspace
- **WHEN** a user opens the existing workspace picker while viewing a document or conversation
- **THEN** worktree registration, create and explicit switch actions are available there without first visiting the Hub dashboard
- **AND** opening or refreshing that list does not change the active document, terminal or conversation context

#### Scenario: Created workspace is opened deliberately
- **WHEN** creation succeeds without a start request
- **THEN** the popup closes, the source list/picker/dashboard refreshes, the source remains selected and a small `Created <branch>` confirmation, rendered at the top of the viewport below the titlebar inset and in the app's success colour, offers Open while leaving the child stopped
- **AND** no Worktree ready, Details or registration popup opens automatically on any SPA, dashboard or review creation path
- **AND** only explicit Open starts then navigates to its separate stable session URL displaying its own files, preview, terminal and chat

#### Scenario: Partial creation is not described as total failure
- **WHEN** checkout creation succeeds but registration fails
- **THEN** a compact actionable error in the originating flow explains that the checkout and branch remain and offers same-checkout Retry registration rather than duplicate Create or a metadata dump

#### Scenario: Small screen deletion remains intelligible
- **WHEN** a touch user reviews deletion
- **THEN** the compact `Delete worktree?` dialog identifies `<parent display name> / <branch>` with no full path, internal IDs, ownership, status card, duplicate fields or configuration inside
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
- **THEN** the opening indicator clears, authoritative or explicitly stale checkout state is shown, and the returning workspace restores its own document/preview, terminal context and selected conversation
- **AND** neither workspace's conversations are migrated or replaced by those from the other checkout

### Requirement: Worktree dialogs are client-rendered from the published JSON
One client dialog module SHALL render every worktree view — the register list of unregistered checkouts, create (new branch and existing branch), delete, register, forget and retry-open — from the Hub's published worktree JSON, and SHALL be embedded unchanged in both the in-workspace workspace picker and the Hub dashboard, so both entry points offer the same roles, labels, copy and keyboard behavior. The Hub SHALL NOT serve worktree presentation as server-rendered HTML fragments or answer worktree actions with redirects, and no worktree path SHALL be excluded from the published API contract. Surfaces SHALL discover the capability from published Hub state: a worktree API field present only when the Hub serves worktrees, a boolean marker on each main checkout that can fork, and the existing parent configuration navigation. Successful creation SHALL close its dialog on every entry path, refresh source lists, show a small `Created <branch>` confirmation with explicit Open at the top of the viewport in the app's success colour, and never switch automatically. A refusal SHALL be rendered in the originating flow as a short actionable reason replacing normal consequences, with retry only where meaningful; retained-checkout registration failure SHALL offer retry on that same checkout. Missing or replaced paths SHALL offer inline Retry refresh on the picker and dashboard rows that show them and MUST NOT recreate a checkout. Live `worktrees` invalidation SHALL refresh an open register list without changing the active document, terminal context or conversation. Every branch list SHALL open expanded with its full local and remote listing, and choosing an option SHALL commit it and enable Create by pointer, touch and keyboard alike. Client requests SHALL use the application's URL helper so a session relocated under a base path keeps working.

#### Scenario: Both entry points render the same dialog
- **WHEN** a user opens worktree creation, deletion, registration or forget from the in-workspace picker and from the Hub dashboard
- **THEN** each renders from the published worktree JSON with the same dialog roles, labels and copy, and no navigation to a server-rendered worktree page or redirect occurs

#### Scenario: Refusal is shown where the user is working
- **WHEN** an operation is refused, whether by validation, a safety blocker or a failed stop
- **THEN** the originating dialog shows its short actionable reason in place of the normal consequences, keeps the user's valid draft where one exists, and nothing is mutated

#### Scenario: Unavailable checkout offers refresh, not recreation
- **WHEN** a registered checkout's path is missing or now holds a different checkout
- **THEN** the row stays visible and disabled with an inline Retry that re-reads authoritative inventory, and no create or recreate action is offered

## MODIFIED Requirements

### Requirement: Workspace and filesystem actions use distinct language
Workspace rows and directory rows SHALL distinguish Rename workspace, Rename folder, Remove from Hub, Remove folder, and Delete worktree. Rename workspace SHALL remain available for ordinary/main workspaces while stopped or running and SHALL change only the display name. Linked child workspace names SHALL reflect their exact local branch; independent child renaming and branch rename are out of scope. Rename folder SHALL retain existing coordinated filesystem behavior and stable URL id only when Git dependency safety checks permit the move; it SHALL be refused for linked checkout, main/common-directory or ancestor dependencies that would break worktree links, including dependencies outside the Hub registry. The refusal SHALL explain that stopping does not make this safe and offer display-name editing only where applicable; this refusal is the disclosure, and no separate worktree folder-policy dialog SHALL be presented. Remove from Hub SHALL preserve the folder, while Remove folder SHALL retain its empty-directory restriction. Delete worktree SHALL be a separate guarded operation for verified Uatu-created linked checkouts. A stopped registered directory SHALL offer Start rather than Open; a running workspace SHALL offer Open.

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
