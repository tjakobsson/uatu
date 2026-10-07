## ADDED Requirements

### Requirement: Discovery publishes explicit incremental progress

The workspace SHALL publish allowed files as background discovery progresses and SHALL distinguish indexing, ready, and failed discovery states. Discovery SHALL reuse the filesystem watcher's inventory and available metadata rather than perform a second application-owned recursive traversal. Classification work SHALL have bounded concurrency. Discovery completion SHALL mean that the initial inventory and its classification work have been applied. Files with unknown extensions SHALL retain the existing binary-sniffing behavior before being offered as Follow targets or search inputs.

#### Scenario: A large tree is still being discovered
- **WHEN** the initial inventory is incomplete
- **THEN** clients can display discovered files and an indexing indication
- **AND** an empty partial inventory is not presented as proof that the workspace contains no files
- **AND** no second application-owned full-tree traversal is started to build the same initial index

#### Scenario: Initial metadata can be reused
- **WHEN** discovery supplies metadata for an allowed file
- **THEN** indexing uses that metadata without issuing a duplicate stat solely to build the index
- **AND** unknown file types are classified with bounded work before publication as eligible text

#### Scenario: Discovery fails after some progress
- **WHEN** discovery cannot complete
- **THEN** the workspace reports the failure and offers recovery
- **AND** the partial inventory is not marked complete or used to declare an undiscovered destination deleted

### Requirement: Ordinary file updates have path-bounded work

After discovery, an ordinary file creation, modification, or deletion SHALL update only the affected index entries. Content-only edits SHALL avoid tree path reconciliation; creates and deletes SHALL use the tree library's incremental mutations, which are permitted to recalculate its complete visible-row projection internally. A directory removal SHALL remove its indexed descendants. Ordinary updates MUST NOT trigger a full index scan, full-corpus reclassification, or a full file-list transmission to already synchronized clients. No timer SHALL periodically rescan the document tree while the watcher is healthy. Batches SHALL retain all affected paths even when only one is chosen for Follow. Filesystem indexing work and message size for a single-file edit SHALL depend on the affected entries rather than the number of unrelated indexed files.

#### Scenario: One file changes in a large workspace
- **WHEN** one already indexed file changes and the watcher's observation remains healthy
- **THEN** its index entry and preview invalidation are published without reading or classifying unrelated files
- **AND** synchronized clients receive a bounded update instead of the full inventory

#### Scenario: Membership changes use incremental tree mutations
- **WHEN** a file is created or deleted
- **THEN** the application updates the affected tree paths through incremental mutations rather than resetting the full path list
- **AND** the tree library's internal visible-row recalculation is permitted

#### Scenario: Several files change together
- **WHEN** a save burst changes files A and B and removes C
- **THEN** the published batch includes the effects on A, B, and C
- **AND** selecting B as the Follow target does not discard A's invalidation or C's removal

#### Scenario: The workspace is idle
- **WHEN** discovery has completed and no files or ignore policies change
- **THEN** document indexing performs no periodic full-tree scans or classifications
- **AND** transport keepalives do not trigger index work

### Requirement: Repository work is independent of file delivery

Repository snapshots SHALL refresh independently of file indexing and file-update delivery. A slow or failed repository refresh MUST NOT delay publication of file changes or Source and Rendered previews. Repository results SHALL carry their own freshness state and SHALL preserve the last successful result while a replacement is pending or fails. Git-only changes, including commits and index changes with no document edit, SHALL remain observable. Repository refreshes MUST NOT initiate document-tree rescans or replay a previous Follow target.

#### Scenario: Git stalls while the active document changes
- **WHEN** repository collection is blocked and the active file is saved
- **THEN** the file update reaches the client and its Source or Rendered preview shows the new bytes without waiting for repository collection
- **AND** existing repository data is identified as pending or stale rather than silently represented as fresh

#### Scenario: A commit changes only repository metadata
- **WHEN** an external commit updates HEAD and the index without changing document bytes
- **THEN** repository information eventually updates without requiring a document edit
- **AND** the update neither switches Follow selection nor rescans the file index

### Requirement: Recovery is explicit and repairs watch coverage

The system SHALL reconcile the affected roots when ignore policy changes, filesystem observation is known to have failed, or the user requests workspace recovery. Reconciliation SHALL repair watch coverage as well as the index, including previously excluded directories that become allowed. Concurrent requests SHALL coalesce, retain intervening file events, and preserve the last coherent inventory until replacement succeeds. A browser connection gap alone SHALL recover from current server state without requiring a new filesystem crawl. The system SHALL retain existing root containment, ignore, secret, symlink, and independent client-scope rules throughout discovery and recovery.

#### Scenario: An excluded directory becomes allowed
- **WHEN** a root's active ignore policy stops excluding a directory
- **THEN** its allowed contents are discovered and watched
- **AND** later edits inside it reach clients without restarting the session

#### Scenario: Watch coverage was interrupted
- **WHEN** an observation failure is reported and filesystem contents change during recovery
- **THEN** bounded automatic recovery reestablishes observation and reconciles those changes
- **AND** failed attempts remain visible and can be retried through workspace recovery

#### Scenario: Several clients reconnect
- **WHEN** clients reconnect while the server's watcher and index are healthy
- **THEN** they receive coherent current server state
- **AND** their reconnections do not each start a filesystem scan

## MODIFIED Requirements

### Requirement: Keep the indexed view and preview current

The system SHALL detect file creation, deletion, rename, and modification events under watched roots, applying the same ignore and exposure filters to watching and indexing, and update the sidebar accordingly. A changed active file SHALL refresh automatically regardless of Follow. A refresh SHALL fetch current bytes and invalidate the affected cached Source, Rendered, Diff, and image representations before they can be reused. Active-preview freshness MUST NOT depend solely on the representative Follow target of a multi-file batch or on modification-time equality. A fresh snapshot after a live-update gap SHALL reconcile the active file using its change revision. Older asynchronous loads MUST NOT replace a newer refresh or selection. Classification SHALL be reevaluated for modified or renamed files. Event batching SHALL preserve bounded progress, with publication scheduled no later than two seconds after the first unprocessed normalized file event even under sustained churn. Transport keepalives SHALL preserve idle connections without presentation effects or expected-idle timeout warnings. The content watcher MUST NOT attach native filesystem watchers to `.git` descendants, follow excluded symlink trees, or terminate the host process on transient watcher errors.

#### Scenario: A new file appears in the sidebar
- **WHEN** a new non-ignored file is created within a watched root
- **THEN** the sidebar includes it in the correct root and directory grouping

#### Scenario: The active document refreshes after a save
- **WHEN** the selected file is modified on disk with Follow either on or off
- **THEN** the preview shows the updated content fetched from disk
- **AND** switching preview representation does not restore the previous cached contents

#### Scenario: A multi-file burst includes the active document
- **WHEN** the selected document and another watched path change in one batch
- **THEN** the selected document is invalidated independently of the representative Follow target
- **AND** with Follow off its preview reloads in place

#### Scenario: Reconnection reconciles a missed active-document change
- **WHEN** the selected document changes while the live connection is interrupted
- **AND** a subsequent snapshot carries its newer revision
- **THEN** the preview reloads current content even if the file's modification time is unchanged

#### Scenario: An older preview load finishes last
- **WHEN** two document loads overlap and the older load completes after the newer load
- **THEN** the older result neither replaces the preview nor repopulates a cache for the newer revision

#### Scenario: Sustained churn cannot starve the refresh
- **WHEN** normalized file events arrive continuously faster than the debounce interval
- **THEN** publication is scheduled within two seconds of the first unprocessed event
- **AND** later events remain queued until applied rather than being discarded

#### Scenario: A rename across the binary boundary updates clickability
- **WHEN** a file is renamed between extensions classified as binary and text
- **THEN** the index and preview routing reflect the new classification
- **AND** a manually retained old destination follows the existing unavailable-selection rules

#### Scenario: Idle watch periods do not look like failures
- **WHEN** the browser remains connected during a normal idle period
- **THEN** the watch session remains available without manual reconnection
- **AND** the server emits no timeout warning for that expected idle connection

#### Scenario: Excluded paths do not expand watch coverage
- **WHEN** a directory is denied, lies inside `.git`, or is reached through a symlink excluded from the index
- **THEN** the content watcher does not traverse or attach native watchers inside it

#### Scenario: The watcher does not descend into `.git/`
- **WHEN** a path contains a `.git` directory segment between the watched root and the path itself
- **THEN** the content watcher's ignore predicate excludes that path
- **AND** no native filesystem watcher is attached to it

#### Scenario: A transient watch-syscall failure does not crash the process
- **WHEN** the watcher reports a transient error for a disappearing path
- **THEN** the host process remains available
- **AND** affected observation is recovered when coverage is uncertain

### Requirement: Workspace refreshes publish coherent ordered state

The document index SHALL publish coherent snapshots and incremental batches with an explicit ordered revision within a session epoch. Clients SHALL apply a batch only to its declared predecessor; an incompatible epoch or missing predecessor SHALL require a fresh snapshot. File events received during discovery, classification, or recovery SHALL be retained, and stale asynchronous completions MUST NOT overwrite newer path state. Sustained edits SHALL produce progress and converge on the final allowed contents after edits stop. A failed update SHALL preserve the last coherent state and allow subsequent recovery. Repository completion SHALL merge only repository information into the current state and MUST NOT restore an older file inventory. These guarantees SHALL hold for HTTP reads and simultaneous live subscribers with independent scopes.

#### Scenario: Edits arrive during slow classification
- **WHEN** a file changes again while an earlier classification is pending
- **THEN** the final entry describes the latest observed file state
- **AND** the stale classification cannot overwrite a later deletion or replacement

#### Scenario: Edits arrive during a slow scan
- **WHEN** an explicit recovery is still discovering files and more file events arrive
- **THEN** those events are retained and reconciled with the replacement inventory
- **AND** completion order cannot publish older path state over newer updates

#### Scenario: Sustained changes eventually settle
- **WHEN** an agent repeatedly creates, replaces, and edits files and then stops
- **THEN** clients receive progress during the activity
- **AND** the final published index contains the final allowed files and metadata

#### Scenario: Scan failure does not corrupt the index
- **WHEN** recovery fails and a later attempt succeeds
- **THEN** the last coherent inventory remains available with an explicit recovery state during the failure
- **AND** the successful replacement is published to the applicable clients

#### Scenario: Repository work completes after newer file events
- **WHEN** repository collection started against an older inventory and finishes after new file updates
- **THEN** publishing its result does not restore that older inventory or replay a previous file event

## REMOVED Requirements

### Requirement: Follow the latest changed non-binary file

**Reason**: This duplicated requirement still describes removed Author/Review modes and contradicts the current single-toggle Follow capability.

**Migration**: Use `follow-mode` as the authoritative selection contract, including latest-non-binary catch-up, URL replacement, manual-selection preservation, and active-file refresh regardless of Follow. Binary auto-selection remains excluded by the binary-classification requirement.
