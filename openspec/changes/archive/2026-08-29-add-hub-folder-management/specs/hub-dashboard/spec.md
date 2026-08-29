## ADDED Requirements

### Requirement: Directory browser manages folders
The authenticated Hub directory browser SHALL let users create an empty child folder in the currently browsed directory, rename a listed child folder, and remove a listed child folder only when it is empty. These actions SHALL be available for both unregistered folders and registered workspaces. Folder names MUST be non-empty visible single path segments; path separators, dot segments, NUL, and names beginning with `.` MUST be rejected. The browser SHALL refresh the affected listing after a successful mutation and SHALL show an actionable error without navigating away when a mutation fails.

#### Scenario: Create an empty folder
- **WHEN** a user enters a valid unused name while browsing a writable directory
- **THEN** the Hub creates that directory as an immediate child
- **AND** the refreshed browser lists the new folder

#### Scenario: Invalid or colliding name is rejected
- **WHEN** a user attempts to create or rename a folder with an invalid name or a name already used in the destination directory
- **THEN** the Hub rejects the mutation without replacing or changing any existing folder
- **AND** the browser explains the conflict

#### Scenario: Rename an unregistered folder
- **WHEN** a user renames an unregistered folder to a valid unused sibling name
- **THEN** the folder and all of its contents move to the new path
- **AND** the browser remains in the containing directory and shows the new name

#### Scenario: Remove an empty folder
- **WHEN** a user confirms removal of an empty folder
- **THEN** the folder is removed and disappears from the refreshed listing

#### Scenario: Non-empty removal is rejected
- **WHEN** a user attempts to remove a folder containing any entry, including a hidden entry
- **THEN** the Hub leaves the folder and its contents unchanged
- **AND** the browser reports that only empty folders can be removed

### Requirement: Registered folder mutations offer coordinated session stopping
When rename or removal affects one or more registered workspaces, the browser SHALL preserve workspace registration semantics rather than treating the folders as unrelated filesystem entries. If every affected workspace is stopped, the action SHALL proceed without an additional session-stop prompt. If any affected workspace is running or starting, the browser SHALL identify the affected workspaces and offer to stop them and continue. Confirming MUST stop all affected sessions, including any start already in flight, before mutating the folder; declining MUST leave sessions, folders, and registrations unchanged. The control SHALL remain disabled with an in-progress label while stopping and mutation are underway.

#### Scenario: Rename a stopped registered workspace
- **WHEN** a user renames a registered workspace whose session is stopped
- **THEN** the folder is renamed while its stable workspace id and `/s/<id>/` URL remain unchanged
- **AND** the dashboard reports the new path for that workspace

#### Scenario: User confirms stop and rename
- **WHEN** a rename affects a running registered workspace and the user confirms the offered stop-and-continue action
- **THEN** the Hub terminates the workspace session and its shells before renaming the folder
- **AND** the workspace remains registered under its existing id at the new path

#### Scenario: User declines session stopping
- **WHEN** a folder mutation would affect a running or starting workspace and the user declines the offered stop
- **THEN** no affected session is stopped
- **AND** no folder or registration is changed

#### Scenario: Rename affects nested registered workspaces
- **WHEN** a renamed folder contains multiple registered workspace descendants
- **THEN** the stop offer names every running or starting affected workspace
- **AND** after all affected workspaces are stopped, every registration keeps its id and points to the corresponding path beneath the renamed folder

#### Scenario: Remove an empty registered workspace
- **WHEN** a user removes an empty registered workspace folder after any active session has been stopped
- **THEN** the folder and its workspace registration are removed
- **AND** associated personal workspace state and credential assignments are removed
