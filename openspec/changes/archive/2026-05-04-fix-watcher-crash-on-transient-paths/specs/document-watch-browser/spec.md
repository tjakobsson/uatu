## MODIFIED Requirements

### Requirement: Keep the indexed view and preview current
The system SHALL detect file creation, deletion, rename, and modification events under watched roots, applying the same ignore filter the indexer uses, and update the indexed sidebar view accordingly. When the currently selected file changes on disk, the preview MUST refresh automatically. Binary classification SHALL be re-evaluated when a file is renamed or modified so that an extension change (e.g. `data.bin` → `data.json`) reflects in the tree's clickability and render path. The live update channel MUST remain available during normal idle periods without requiring user action or emitting spurious server timeout warnings for expected long-lived connections. The watcher MUST NOT attach native filesystem watchers to any path whose location relative to a watched root contains a `.git` directory segment, since that directory is git's working metadata and is never user-authored content the indexer surfaces. The watcher MUST tolerate transient errors from the underlying filesystem watcher implementation (for example, an `EINVAL` from a `watch` syscall against a file that has already been removed) without terminating the host process; such errors MAY be logged but MUST NOT propagate as unhandled errors.

#### Scenario: A new file appears in the sidebar
- **WHEN** a new non-ignored file is created within a watched root
- **THEN** the sidebar updates to include the new file in the correct root and directory grouping

#### Scenario: The active document refreshes after a save
- **WHEN** the currently selected file is modified on disk
- **THEN** the preview refreshes to show the updated rendered content

#### Scenario: A rename across the binary boundary updates clickability
- **WHEN** a binary file is renamed to an extension classified as text (or vice versa)
- **THEN** the sidebar entry's clickability and icon update to reflect the new classification

#### Scenario: Idle watch periods do not look like failures
- **WHEN** the browser remains connected to the live update channel during a normal idle period with no file changes
- **THEN** the watch session remains available without requiring the user to reconnect
- **AND** the server does not emit a timeout warning for that expected idle connection

#### Scenario: The watcher does not descend into `.git/`
- **WHEN** a path under a watched root has any path segment equal to `.git` between the watched root and the path itself
- **THEN** the watcher's ignore predicate returns true for that path
- **AND** no native filesystem watcher is attached to it

#### Scenario: A transient watch-syscall failure does not crash the process
- **WHEN** the underlying filesystem watcher emits an error event for a single watch target (for example, an `EINVAL` from a `watch` syscall against a file that has already been unlinked)
- **THEN** the host process does not terminate
- **AND** the watch session remains available for subsequent events
