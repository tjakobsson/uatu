## ADDED Requirements

### Requirement: Hub offers explicit worktree lifecycle navigation
The Hub SHALL provide worktree creation and repository inventory entry points in its existing dashboard/onboarding navigation. The worktree flow SHALL show source, branch mode/base or remote ref, destination, independent display name and explicit credentials; distinguish registered Uatu-created, external, unregistered, missing and uncertain checkouts; and separate Create, Start, Open, Remove from Hub and Delete worktree. Create SHALL default to stopped, Open SHALL navigate to a running workspace's stable session URL, and unregistered external Open SHALL require configuration before start. Discovery SHALL NOT change active workspace or conversation. Loading, empty, conflict, stale-ref/fetch, retained-checkout registration failure and retry states SHALL remain actionable and avoid duplicate submissions. The flow SHALL support keyboard and narrow touch layouts, both color schemes and desktop titlebar inset.

#### Scenario: Created workspace is opened deliberately
- **WHEN** creation succeeds without a start request
- **THEN** the result offers Start and return to inventory while leaving the workspace stopped
- **AND** a successful later Start/Open shows opening progress and navigates to its stable session URL

#### Scenario: Partial creation is not described as total failure
- **WHEN** checkout creation succeeds but registration fails
- **THEN** the page names the retained path and branch, explains that files remain, and offers retry registration rather than a duplicate Create

#### Scenario: Small screen deletion remains intelligible
- **WHEN** a touch user reviews a dirty, ignored-data, locked or in-use deletion state
- **THEN** the path, preserved-branch default, blocker, stop consequences and non-destructive return action remain reachable without clipped controls

#### Scenario: Back restores usable navigation
- **WHEN** the user opens a worktree and returns via browser history
- **THEN** the opening indicator clears and authoritative or explicitly stale inventory is shown without changing another conversation

## MODIFIED Requirements

### Requirement: Workspace and filesystem actions use distinct language
Workspace rows and directory rows SHALL distinguish Rename workspace, Rename folder, Remove from Hub, Remove folder, and Delete worktree. Rename workspace SHALL be available while stopped or running and SHALL change only the workspace display name. Rename folder SHALL retain the existing coordinated filesystem behavior and stable URL id only when Git dependency safety checks permit the move; it SHALL be refused for linked checkout, main/common-directory or ancestor dependencies that would break worktree links, including dependencies outside the Hub registry. The refusal SHALL explain that stopping does not make this move safe and offer display-name editing instead. Remove from Hub SHALL preserve the folder, while Remove folder SHALL retain its empty-directory restriction. Delete worktree SHALL be a separate guarded operation for verified Uatu-created linked checkouts. A stopped registered directory SHALL offer Start rather than Open; a running workspace SHALL offer Open.

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
- **THEN** the browser reports the server's refusal, does not offer stop as a bypass, and keeps Rename workspace available
