## MODIFIED Requirements

### Requirement: Keep the indexed view and preview current
The system SHALL detect file creation, deletion, rename, and modification events under watched roots, applying the same ignore filter the indexer uses, and update the indexed sidebar view accordingly. When the currently selected file changes on disk in a mode that permits live document refresh, the preview MUST refresh automatically. Active-preview freshness MUST NOT depend solely on one file being selected as the representative change from a debounced multi-file batch. A fresh state snapshot received after a live-update connection gap MUST reconcile the active preview when that snapshot shows that the selected document changed. When multiple preview loads overlap, an older load MUST NOT replace the content produced by a newer refresh or selection. Binary classification SHALL be re-evaluated when a file is renamed or modified so that an extension change (e.g. `data.bin` → `data.json`) reflects in the tree's clickability and render path. Refresh scheduling MAY debounce bursts of events, but sustained event streams MUST NOT starve updates: a refresh SHALL occur no later than a bounded interval (at most 2 seconds) after the first unprocessed event, even while further events continue to arrive and reset the debounce. The live update channel MUST remain available during normal idle periods without requiring user action or emitting spurious server timeout warnings for expected long-lived connections. The watcher MUST NOT attach native filesystem watchers to any path whose location relative to a watched root contains a `.git` directory segment, since that directory is git's working metadata and is never user-authored content the indexer surfaces. The watcher MUST tolerate transient errors from the underlying filesystem watcher implementation (for example, an `EINVAL` from a `watch` syscall against a file that has already been removed) without terminating the host process; such errors MAY be logged but MUST NOT propagate as unhandled errors.

#### Scenario: A new file appears in the sidebar
- **WHEN** a new non-ignored file is created within a watched root
- **THEN** the sidebar updates to include the new file in the correct root and directory grouping

#### Scenario: The active document refreshes after a save
- **WHEN** the currently selected file is modified on disk in a mode that permits live document refresh
- **THEN** the preview refreshes to show the updated rendered content

#### Scenario: A multi-file burst includes the active document
- **WHEN** the selected document and another watched path change within one debounced refresh batch
- **THEN** the preview refreshes to show the selected document's updated content
- **AND** the representative change used for Follow does not determine whether the selected document is considered stale

#### Scenario: Reconnection reconciles a missed active-document change
- **WHEN** the selected document changes while the live update connection is interrupted
- **AND** the client subsequently receives a fresh state snapshot showing that change
- **THEN** the preview refreshes to show the current document content

#### Scenario: An older preview load finishes last
- **WHEN** two document loads overlap and the older load completes after the newer load
- **THEN** the older result does not replace the newer active preview

#### Scenario: Sustained churn cannot starve the refresh
- **WHEN** files under a watched root change continuously at intervals shorter than the debounce interval
- **THEN** a refresh still occurs within the bounded interval after the first unprocessed event
- **AND** the sidebar and any follow-driven selection reflect the changes without waiting for the churn to stop

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
