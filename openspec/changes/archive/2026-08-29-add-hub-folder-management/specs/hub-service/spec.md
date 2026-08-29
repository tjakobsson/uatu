## ADDED Requirements

### Requirement: Hub exposes authenticated folder mutation operations
The Hub SHALL expose public authenticated POST operations to create a folder from an absolute parent path and child name, rename a folder from an absolute source path and new sibling name, and remove an absolute folder path. Cookie-authenticated requests MUST pass the Hub's same-origin check. The Hub MUST reject relative paths, invalid names, non-directory or symbolic-link sources, rename destinations that already exist, and removal of any non-empty folder. A mutation MUST NOT recursively delete content or overwrite an existing filesystem entry.

#### Scenario: Cross-origin folder mutation is rejected
- **WHEN** a cookie-authenticated cross-origin request attempts to create, rename, or remove a folder
- **THEN** the Hub rejects it without changing the filesystem or workspace registry

#### Scenario: Rename never replaces a destination
- **WHEN** a rename's destination path already names any filesystem entry
- **THEN** the Hub reports a conflict and leaves both source and destination unchanged

#### Scenario: Remove delegates emptiness enforcement to the filesystem
- **WHEN** a remove request names a directory containing a file, hidden entry, or child directory
- **THEN** the operation fails without recursively removing any entry

### Requirement: Folder mutations preserve registered workspace identity and consistency
Before renaming a folder, the Hub SHALL identify every registered workspace whose path is the source or a descendant of it. A successful rename MUST update all affected registered paths by replacing the source prefix, MUST preserve every workspace id, backend, personal state, credential assignment, and session URL, and MUST persist the path updates as one registry mutation. Removing an empty folder that is itself a registered workspace MUST remove that registration and its associated personal state and credential assignments. A folder mutation and its registry or metadata changes MUST either complete coherently or be recovered or rolled back so a process interruption does not silently leave a registered path at the pre-mutation location after the folder moved.

#### Scenario: Registered descendant paths move together
- **WHEN** registered workspaces at `/srv/group/a` and `/srv/group/nested/b` are stopped and `/srv/group` is renamed to `/srv/team`
- **THEN** their ids remain unchanged
- **AND** their persisted paths become `/srv/team/a` and `/srv/team/nested/b` in one registry update

#### Scenario: Registered rename survives Hub restart
- **WHEN** a registered workspace is renamed and the Hub restarts
- **THEN** the workspace remains registered under the same id at the renamed path

#### Scenario: Failed registered rename remains coherent
- **WHEN** the filesystem rename or registry persistence fails
- **THEN** the Hub reports failure
- **AND** recovery or rollback leaves every affected registration pointing to the location where its folder exists

#### Scenario: Empty registered removal clears durable metadata
- **WHEN** removal of an empty registered workspace succeeds
- **THEN** the folder, registry entry, all users' personal workspace state, and credential assignments for that workspace are absent after a Hub restart

### Requirement: Folder mutations coordinate with sessions and clone targets
The Hub SHALL serialize a registered folder mutation against lifecycle operations for every affected workspace. Without explicit stop authorization, a request affecting a running or starting workspace MUST return a conflict that identifies every workspace requiring a stop and MUST change nothing. With explicit stop authorization, the Hub MUST await and stop any in-flight or running affected session before performing the mutation, and no concurrent start may observe or use a partially updated path. The Hub MUST also reject create, rename, or removal operations whose source, destination, or affected subtree conflicts with an active clone target; folder mutation and clone reservation checks SHALL be coordinated so neither can enter a path reserved by the other.

#### Scenario: Mutation reports sessions requiring a stop
- **WHEN** a rename affects running workspace `alpha` and starting descendant workspace `beta` without stop authorization
- **THEN** the Hub returns a conflict identifying both `alpha` and `beta`
- **AND** neither session, folder, nor registration changes

#### Scenario: Authorized mutation stops an in-flight start
- **WHEN** the same rename is retried with stop authorization while a workspace start is in flight
- **THEN** the Hub waits for that start, stops the resulting session and shells, and only then renames the folder and updates registrations

#### Scenario: Concurrent start waits for rename
- **WHEN** a start request arrives while its registered workspace path is being renamed
- **THEN** the start observes the fully committed new path or fails without spawning a child
- **AND** it never starts against an intermediate or stale path

#### Scenario: Active clone protects its path hierarchy
- **WHEN** an active clone target lies at, above, or below a proposed folder mutation source or destination
- **THEN** the Hub rejects the mutation without moving or removing the clone target or its containing path
