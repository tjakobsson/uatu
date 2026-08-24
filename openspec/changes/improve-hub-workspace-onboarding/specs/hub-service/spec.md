## ADDED Requirements

### Requirement: Hub stores mutable workspace display names
Every workspace registration SHALL include a non-empty user-facing display name separate from its immutable stable id and filesystem path. Display names MAY contain spaces, punctuation, and duplicate another workspace's display name within a bounded length. Renaming a workspace SHALL atomically persist only the display name and SHALL NOT change its id, `/s/<id>/` URL, source path, backend, personal state, credential assignments, or running session. Existing registry entries without a display name SHALL load with a deterministic default derived from their folder basename without changing their id.

#### Scenario: Existing registry entry receives a default name
- **WHEN** the Hub loads a registry entry written before display names existed
- **THEN** it exposes and persists a display name derived from the source folder basename
- **AND** its stable id and URL remain unchanged

#### Scenario: Duplicate display names are accepted
- **WHEN** two workspaces are named `API`
- **THEN** both names are stored unchanged
- **AND** their distinct ids and paths continue to identify them unambiguously

#### Scenario: Running workspace is renamed
- **WHEN** a workspace display-name update succeeds while its session is running
- **THEN** subsequent Hub state and navigation use the new display name
- **AND** the child process is neither stopped nor restarted

### Requirement: Hub atomically configures new workspace registrations
The Hub SHALL provide authenticated operations that register an existing folder or create a new child repository with a display name, optional authentication and signing assignments, and an explicit start choice. The default start choice SHALL be false. Before reporting success, the Hub MUST persist the registration and all requested assignments as one coherent onboarding result; a validation, initialization, registry, or assignment failure MUST leave no partial registration or assignment. If an explicitly requested first start fails after configuration commits, the Hub SHALL preserve the stopped configured workspace and report the startup failure rather than deleting the user's completed registration.

Creating a workspace SHALL derive the destination from an absolute parent plus one visible child segment, reserve the path hierarchy, create without replacement, initialize Git, and register only that newly created folder. A failure after folder creation SHALL perform bounded cleanup only when the Hub can prove the created repository contains no user-added content; otherwise it SHALL retain the folder and report the recovery action required.

#### Scenario: Existing folder is configured stopped
- **WHEN** a valid Git repository, display name, and assignments are submitted without start authorization
- **THEN** the Hub atomically records them and returns a stopped workspace

#### Scenario: Assignment validation fails
- **WHEN** a requested credential is missing, disabled, incompatible, or conflicts with another selected default
- **THEN** the operation fails without retaining the new registration or any requested assignment

#### Scenario: Explicit first start fails
- **WHEN** registration and assignments commit but an explicitly requested session start fails
- **THEN** the Hub reports the start failure and preserves the configured stopped workspace for correction and retry

#### Scenario: Newly created repository is initialized
- **WHEN** a valid parent, unused folder name, display name, and assignments are submitted to Create workspace
- **THEN** the Hub creates the child, runs Git initialization, and records one stopped workspace for its canonical path

### Requirement: Hub stores a default workspace parent preference
The Hub SHALL persist an optional absolute default workspace parent directory in Hub-owned state. Updating it SHALL require an existing direct non-symbolic-link directory and SHALL use authenticated same-origin mutation protection. The value SHALL guide initial create, clone, and browse locations but MUST NOT constrain registration, folder operations, or shell access to that subtree. If the saved path later becomes missing or unreadable, the Hub SHALL retain the preference for diagnosis while returning the daemon user's home as the effective onboarding default.

#### Scenario: Preference survives restart
- **WHEN** an authenticated user saves `/srv/workspaces` and the Hub restarts
- **THEN** Hub state reports `/srv/workspaces` as the configured and effective onboarding parent while it remains usable

#### Scenario: Preference is not a workspace root
- **WHEN** `/srv/workspaces` is configured and a user registers `/opt/project`
- **THEN** the Hub accepts `/opt/project` under the existing host-access rules

#### Scenario: Saved preference is unavailable
- **WHEN** the configured directory disappears after it was saved
- **THEN** Hub state identifies it as unavailable and provides the daemon user's home as the effective default

## MODIFIED Requirements

### Requirement: Workspaces are registered with stable identifiers and a backend field
The hub SHALL maintain a persistent workspace registry where each entry records a stable workspace id, mutable user-facing display name, workspace source as an absolute canonical folder path, and session backend identifier. Registration SHALL validate that the path is absolute and refers to an existing directory. The id SHALL be a slug derived from the workspace folder name, suffixed on collision, and SHALL never change once assigned, so session URLs (`/s/<id>/…`) survive Hub and session restarts, folder renames, and display-name changes. Display names SHALL default from the folder basename but SHALL NOT determine identity or uniqueness. In this change the only valid backend identifier SHALL be `local`; the field SHALL remain in the registry schema so additional backends are additive.

Registry persistence SHALL be serialized and atomic. Concurrent mutations may neither interleave writes nor let an older snapshot finish last, and a crash mid-write MUST NOT corrupt the file. The Hub MUST NOT prune registry entries at startup based on their location; an entry whose folder no longer exists SHALL remain registered and surface as failing to start, never as silently forgotten.

#### Scenario: Workspace id is stable across restarts
- **WHEN** a workspace display name and source folder are renamed and the Hub restarts
- **THEN** the workspace retains its original id and `/s/<id>/` prefix
- **AND** it exposes the new display name and source path

#### Scenario: Slug collision is suffixed
- **WHEN** two workspaces with the same folder name are registered
- **THEN** the second receives a distinct suffixed id and the first keeps its id

#### Scenario: Arbitrary absolute paths are registrable
- **WHEN** workspaces at `~/src/uatu` and `~/Documents/notes` are registered while another default parent is configured
- **THEN** both appear in the registry with stable ids and user-facing display names and both sessions are servable

#### Scenario: A relative or missing path is rejected
- **WHEN** a registration request names a relative path or a path that is not an existing directory
- **THEN** the Hub rejects it and the registry is unchanged
