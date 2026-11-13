# document-watch-index Specification

## Purpose
Securely index, classify, serve, and continuously refresh allowed files under watched roots while supporting live previews, follow mode, binary handling, and configurable ignore rules.

## Requirements

### Requirement: Keep the indexed view and preview current
The system SHALL incrementally detect creations, deletions, renames, and writes under permitted watched roots, updating metadata and views under shared watching/indexing exposure rules. Active-file freshness, image refresh, media exceptions, bounded publication, and safe watcher recovery SHALL follow the scenarios below.

#### Scenario: A changed active file invalidates every affected representation
- **WHEN** an active non-media file changes with Follow on or off
- **THEN** it SHALL refresh and invalidate affected Source, Rendered, Diff, and image representations; freshness SHALL not depend solely on the batch's representative Follow target or modification-time equality

#### Scenario: Writes, renames, and snapshot recovery preserve current revisions
- **WHEN** any indexed path is written or renamed
- **THEN** classification SHALL be reevaluated
- **WHEN** a fresh snapshot is applied after a gap
- **THEN** it SHALL reconcile revisions

#### Scenario: Asynchronous work completes during connected navigation or recovery
- **WHEN** asynchronous work completes with a selection or revision older than the current one
- **THEN** it MUST NOT replace newer selections or revisions, whether or not a connection gap occurred

#### Scenario: Watched image and media revisions retain their refresh boundaries
- **WHEN** a selected or embedded watched image changes revision
- **THEN** it SHALL show the new revision without rerendering the surrounding document or resetting scroll
- **AND** existing exclusions for file-scoped embedded-image refresh, srcset/picture, CSS background images, and interactive SVG objects SHALL remain

#### Scenario: Active media revisions retain explicit reload intent
- **WHEN** an active audio/video revision changes
- **THEN** it SHALL follow media-playback's New render available/Reload contract, without automatically replacing its mounted source

#### Scenario: Normalized events arrive during ignored-folder churn
- **WHEN** the first normalized event outside Git-ignored folders is queued, including during sustained churn inside or outside ignored folders
- **THEN** its publication SHALL be scheduled within two seconds of that event

#### Scenario: Events inside Git-ignored folders use their own publication schedule
- **WHEN** events inside Git-ignored folders are queued
- **THEN** they SHALL follow the batched ignored-folder publication requirement

#### Scenario: Keepalives do not affect presentation
- **WHEN** a keepalive arrives
- **THEN** it SHALL have no presentation effect or expected-idle warnings

#### Scenario: Transient watcher errors do not end watching
- **WHEN** a watcher encounters a transient error
- **THEN** it MUST survive that error

#### Scenario: Watch coverage is established or refreshed
- **WHEN** a watcher establishes or refreshes filesystem observation
- **THEN** it MUST NOT traverse Git internals or excluded symlink trees

#### Scenario: A new file appears in the sidebar
- **WHEN** a permitted file is created under a watched root
- **THEN** it becomes available in the corresponding Files views with its actual write time

#### Scenario: The active document refreshes after a save
- **WHEN** an active non-media document is saved with Follow on or off
- **THEN** current contents replace its preview and old cached representations cannot reappear

#### Scenario: The selected image refreshes after it changes
- **WHEN** the selected image is rewritten
- **THEN** its new revision appears in place without blanking the image or resetting scroll

#### Scenario: An embedded image refreshes when only the image changes
- **WHEN** a watched embedded image changes without a surrounding Markdown/AsciiDoc write
- **THEN** the image refreshes without rerendering the document or changing scroll

#### Scenario: A multi-file burst includes the active document
- **WHEN** a batch includes the active document and other paths
- **THEN** the active document refreshes independently of the representative Follow target

#### Scenario: Reconnection reconciles a missed active-document change
- **WHEN** recovery supplies a newer active-file revision with equal modification time
- **THEN** the non-media preview reloads and an active media session instead gets its explicit update notice

#### Scenario: An older preview load finishes last
- **WHEN** an older asynchronous load completes after a newer load or selection
- **THEN** it cannot replace the preview or populate the newer revision's cache

#### Scenario: Sustained churn cannot starve the refresh
- **WHEN** file events outside ignored folders continue faster than the debounce interval
- **THEN** publication is scheduled within two seconds and remaining paths stay queued

#### Scenario: A running build does not delay a document edit
- **WHEN** a build continuously writes files under an ignored `build/` and the user saves `docs/notes.md`
- **THEN** the save is published within the same two-second bound as when no build runs

#### Scenario: A rename across the binary boundary updates clickability
- **WHEN** a file is renamed across text, image, media, or unsupported-binary classification
- **THEN** routing uses the new classification and retained old destinations use normal unavailable rules

#### Scenario: Idle watch periods do not look like failures
- **WHEN** no file writes occur while the client stays connected
- **THEN** keepalives maintain delivery without warnings or forced UI refreshes

#### Scenario: Excluded paths do not expand watch coverage
- **WHEN** a directory is a built-in or explicit exclusion or an excluded symlink tree
- **THEN** the content watcher neither traverses it nor attaches descendant watchers

#### Scenario: The watcher does not descend into `.git/`
- **WHEN** a content path has a .git directory segment
- **THEN** it is excluded from content watching, including inside ignored folders

#### Scenario: A transient watch-syscall failure does not crash the process
- **WHEN** a disappearing path causes a transient observation error
- **THEN** the process remains available and uncertain coverage is recovered

#### Scenario: A playing export is overwritten
- **WHEN** the active media's revision changes
- **THEN** index and Recent metadata update but the media source is not automatically replaced or restarted

### Requirement: Detect binary files and route them to the right preview
The system SHALL classify permitted files as Markdown, AsciiDoc, viewable text, or binary using known-extension fast paths and at most an initial 8 KB binary sniff for unfamiliar names. Binary entries SHALL remain clickable and use the preview and Follow eligibility rules below.

#### Scenario: A binary is selected or considered for automatic navigation
- **WHEN** a permitted binary is selected
- **THEN** existing previewable image extensions SHALL render through the image path, recognized audio/video candidates SHALL open paused media previews, and other binaries SHALL show preview unavailable
- **AND** codec failure SHALL NOT be misreported as document absence

#### Scenario: Automatic navigation considers binary candidates without selection
- **WHEN** Follow or initial default-document selection considers indexed binary files
- **THEN** images SHALL retain existing Follow eligibility, but audio/video and unsupported binaries SHALL NOT become automatic Follow targets
- **AND** all binaries SHALL remain excluded from initial default-document selection and Follow-enable catch-up

#### Scenario: An image file is rendered inline in the preview pane
- **WHEN** a known previewable image is selected
- **THEN** its image is displayed using file delivery rather than document JSON

#### Scenario: A non-image binary lists as a clickable entry routed to preview-unavailable
- **WHEN** archive.zip is selected
- **THEN** selection updates and preview unavailable is shown without a document-not-found message

#### Scenario: An unknown-extension binary blob is detected via content sniff
- **WHEN** an unfamiliar file's initial sniff contains a NUL byte or excessive non-printable content
- **THEN** it is classified binary and shows unavailable unless it is a recognized preview candidate

#### Scenario: A plain text file with no extension is treated as text
- **WHEN** Makefile contains ordinary text
- **THEN** it is listed and uses the existing source/code preview

#### Scenario: Binary files are excluded from the on-startup default document
- **WHEN** the newest file is an image, audio, video, or other binary
- **THEN** the startup default remains the newest eligible non-binary document

#### Scenario: A fresh sound export does not steal Follow
- **WHEN** Follow is enabled and a sound/video export is written
- **THEN** Recent updates but Follow does not switch the preview to the export or start it playing

### Requirement: Live document state recovers from interrupted client paths
The live document channel SHALL maintain idle transport liveness and recover through client-owned bounded reconnect and authoritative snapshots. A keepalive MUST NOT update application state, change selection, trigger rendering, or advance state generation. Lifecycle wake-ups SHALL converge on one current channel, hidden pages SHALL retain recovery, and each recovery task SHALL be time-bounded.

#### Scenario: Idle transport passes through normal intermediaries
- **WHEN** a live document stream has no application events
- **THEN** transport keepalives SHALL be frequent enough that normal HTTP intermediaries do not treat it as abandoned
- **AND** a keepalive MUST NOT update application state, change selection, trigger rendering, or advance state generation

#### Scenario: An errored channel needs a replacement
- **WHEN** the live document channel reports an error
- **THEN** the client MUST own a continuing reconnect cycle with bounded delay and MUST NOT depend indefinitely on a native connection remaining in connecting state
- **AND** a replacement MUST deliver and apply a fresh authoritative snapshot reconciling changes missed during the gap

#### Scenario: A lifecycle wake-up overlaps another recovery
- **WHEN** a suspended page resumes, a hidden page becomes visible, or the browser reports restored network connectivity
- **THEN** the client SHALL reconcile authoritative state and ensure a current live channel
- **AND** duplicate signals and overlapping attempts MUST converge to one effective current channel without an older attempt replacing a newer connection
- **AND** an unfinished recovery SHALL be abandoned within a bounded period so it cannot indefinitely suppress later signals; the next wake-up SHALL be honoured

#### Scenario: Hiding a page cancels work without ending future recovery
- **WHEN** a page becomes hidden, however the browser announces it
- **THEN** the client MAY release its connection and cancel pending work, but MUST retain subscriptions and cursors and keep listening for resume, visibility, and network-restored signals
- **AND** being shown again SHALL reconnect without manual reload; hiding SHALL NOT permanently end recovery

#### Scenario: Lifecycle events do not prove permanent document termination
- **WHEN** the client receives any single lifecycle event
- **THEN** it MUST NOT treat that event as proof that the document will never run again; a genuinely unloaded document stops its own work

#### Scenario: Idle intermediary path stays active
- **WHEN** a client has an open live document channel and no watched files change for an extended period
- **THEN** transport keepalives cross the Hub and any fronting reverse proxy at a bounded interval
- **AND** the client receives no spurious state update or document refresh from those keepalives

#### Scenario: Connecting state cannot strand recovery
- **WHEN** a live document channel reports an error and its native connection would otherwise remain in a connecting state indefinitely
- **THEN** the client replaces the failed channel after a bounded delay
- **AND** continues bounded reconnect attempts until a connection succeeds or the document stops running

#### Scenario: Reconnect applies authoritative state
- **WHEN** watched files change while a client's live document channel is interrupted
- **THEN** a successful reconnect applies a fresh state snapshot
- **AND** the sidebar and active preview converge on the current workspace state

#### Scenario: Resuming a suspended mobile page reconciles state
- **WHEN** a page resumes after suspension or returns to the foreground with an uncertain live-channel state
- **THEN** the client reconciles authoritative state and ensures that a current live channel is installed
- **AND** recovery does not require a manual page reload

#### Scenario: A backgrounded standalone page recovers when reopened
- **WHEN** a page installed to the home screen is backgrounded, the browser announces the hide in a form that does not promise a later restore, and the user reopens the still-running page
- **THEN** the client reconnects its live channel and reconciles authoritative state
- **AND** recovery does not require navigating away and back or reloading the page

#### Scenario: A hung recovery does not silence later wake-ups
- **WHEN** a recovery's state reconciliation never completes because the request is left unanswered
- **THEN** that recovery is abandoned within a bounded period
- **AND** a later visibility, resume, or network-restored signal starts a new recovery

#### Scenario: Duplicate wake signals converge
- **WHEN** page resume, visibility, and online signals arrive close together
- **THEN** overlapping recovery work converges to one current channel
- **AND** a stale recovery completion cannot replace the newer channel or state

### Requirement: Live stream lifecycles remain isolated and releasable
Each client's document and Chat streaming requests SHALL have an independent lifecycle through the Hub proxy. Disconnecting, suspending, or reconnecting one client MUST NOT close or delay another client's established streams. No child subscription may outlive its last client. Abandoned subscriptions SHALL be released, and lifecycle diagnostics SHALL preserve the privacy boundaries below.

#### Scenario: A downstream client abandons a shared or final topic
- **WHEN** a downstream client abandons a stream
- **THEN** the Hub MUST detach that client from its live broker
- **AND** for each topic losing its final subscriber, the Hub MUST cancel the child request after a short linger and the child MUST release its subscription within a bounded period
- **AND** topics with other subscribers MUST stay open and delivering

#### Scenario: A stream lifecycle outcome is recorded
- **WHEN** a stream opens, successfully recovers, is cancelled downstream, or fails upstream
- **THEN** diagnostics SHALL distinguish these outcomes by transport class without recording event payloads, credentials, or sensitive query values

#### Scenario: One client reconnects while another remains live
- **WHEN** two clients subscribe to the same running workspace and one client's transport is interrupted
- **THEN** the interrupted client can reconnect independently
- **AND** the other client's document and Chat streams continue without interruption

#### Scenario: One client leaving keeps the shared upstream
- **WHEN** two clients subscribe to the same workspace topic through the Hub and one of them closes or abandons its stream
- **THEN** the Hub detaches that client from its broker
- **AND** the child keeps the one shared subscription, and the other client's stream continues without interruption

#### Scenario: The final subscriber's cancellation reaches the child
- **WHEN** the last client subscribed to a workspace topic closes or abandons its stream
- **THEN** after a short linger the Hub cancels the matching child-side request
- **AND** within a bounded period the child no longer counts it as a live subscription

#### Scenario: Diagnostics omit streamed content and secrets
- **WHEN** the system records a stream open, recovery, cancellation, or failure
- **THEN** the diagnostic record identifies the transport class and lifecycle outcome
- **AND** it does not contain streamed payloads, credentials, or sensitive query values

### Requirement: Hub-served pages receive document state over the brokered stream
When a session is served through the hub, the browser SHALL receive workspace state snapshots and change signals as the `document` topic of the hub's brokered live stream rather than opening the workspace's own event route. Every live-update-channel guarantee SHALL hold unchanged for the brokered topic. The workspace's own event route SHALL remain the internal source the hub subscribes to.

#### Scenario: Brokered delivery refreshes or recovers document state
- **WHEN** a hub-served session uses the `document` topic, including idle delivery and overlapping lifecycle signals
- **THEN** all live-update guarantees SHALL hold unchanged: automatic preview refresh, fresh-snapshot reconciliation of missed active-document changes, bounded refresh under sustained churn, keepalives without presentation effect, and one current channel after overlapping lifecycle signals

#### Scenario: A file change reaches a hub-served page over the brokered stream
- **WHEN** a watched file changes while a user views the workspace through the hub
- **THEN** the sidebar and, when Follow or the selected document calls for it, the preview update from a `document` topic event
- **AND** the page opened no connection to the workspace's own event route

#### Scenario: A missed change is reconciled after the one stream reconnects
- **WHEN** the selected document changes while the brokered stream is interrupted
- **AND** the stream reconnects and its `document` topic delivers a fresh snapshot
- **THEN** the preview refreshes to the current document content

### Requirement: Workspace refreshes publish coherent ordered state

The document index SHALL publish coherent snapshots and incremental batches with an explicit ordered revision within a session epoch. Clients SHALL apply a batch only to its declared predecessor; an incompatible epoch or missing predecessor SHALL require a fresh snapshot. HTTP reads and simultaneous independently scoped live subscribers SHALL share the ordering and recovery guarantees below.

#### Scenario: Discovery or update work overlaps newer events
- **WHEN** file events arrive during discovery, classification, or recovery
- **THEN** they SHALL be retained

#### Scenario: Every asynchronous completion respects newer path state
- **WHEN** asynchronous index work completes, with or without overlapping file events
- **THEN** stale completions MUST NOT overwrite newer path state

#### Scenario: Sustained edits continue or an update fails without overlapping events
- **WHEN** edits are sustained
- **THEN** updates SHALL produce progress and converge on the final allowed contents after edits stop
- **WHEN** any update fails
- **THEN** it SHALL preserve the last coherent state and allow subsequent recovery

#### Scenario: Repository completion merges into a newer inventory
- **WHEN** repository work completes, whether or not file state has advanced
- **THEN** it SHALL merge only repository information into current state and MUST NOT restore an older file inventory

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

### Requirement: Discovery publishes explicit incremental progress

The workspace SHALL publish allowed files as background discovery progresses and distinguish indexing, ready, and failed states. Discovery SHALL reuse the filesystem watcher's inventory and available metadata rather than perform a second application-owned recursive traversal. Classification SHALL have bounded concurrency.

#### Scenario: Unknown extensions are sniffed before Follow or search eligibility
- **WHEN** a file with an unknown extension is to be offered as a Follow target or search input
- **THEN** unknown extensions SHALL retain existing binary-sniffing behavior before being offered

#### Scenario: Discovery decides whether its initial inventory is complete
- **WHEN** discovery reports completion
- **THEN** the initial inventory and its classification work SHALL already have been applied

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

After discovery, ordinary file creations, modifications, and deletions SHALL update only affected index entries. Ordinary updates MUST NOT trigger a full index scan, full-corpus reclassification, or full file-list transmission to synchronized clients. Single-file indexing work and message size SHALL depend on affected entries, not unrelated indexed files. Batches SHALL retain all affected paths even when only one is chosen for Follow.

#### Scenario: An ordinary change updates tree membership or contents
- **WHEN** an ordinary file event arrives after discovery
- **THEN** content-only edits SHALL avoid tree path reconciliation, and creates/deletes SHALL use the tree library's incremental mutations, which MAY internally recalculate its complete visible-row projection
- **AND** batches SHALL retain all affected paths even if only one is chosen for Follow

#### Scenario: Directory removal deletes its indexed descendants
- **WHEN** a directory is removed after discovery
- **THEN** its indexed descendants SHALL be removed

#### Scenario: A healthy watcher remains idle between file events
- **WHEN** the watcher is healthy, with or without ordinary file events
- **THEN** no timer SHALL periodically rescan the document tree

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

Repository snapshots SHALL refresh independently of file indexing and delivery. Slow or failed refreshes MUST NOT delay file changes or Source/Rendered previews. Results SHALL carry independent freshness and preserve the last successful result while a replacement is pending or fails. Clients MUST NOT drive repository collection with periodic requests. Git-only changes SHALL remain observable under the subscription, observation, pacing, and no-write rules below.

#### Scenario: Subscribed clients need Git-only changes
- **WHEN** at least one client is subscribed
- **THEN** filesystem events SHALL reveal commits, index changes, branch switches, and fetched remote refs even without document edits
- **AND** observation SHALL cover the Git directory's top level, the shared Git directory's top level for a linked worktree, current-branch and resolved-compare-base ref files, and repository `info/exclude`
- **AND** the Git directory MUST NOT be watched recursively; lock files, object storage, and fsmonitor cookie files SHALL NOT trigger refresh

#### Scenario: Repository changes fall outside content-watcher coverage
- **WHEN** a watched root is narrower than its repository
- **THEN** the system SHALL also observe the repository working tree outside that root, excluding the Git directory and untracked paths excluded by the repository's top-level `.gitignore`, without adding those files to the document index

#### Scenario: Content exclusions do not hide Git-visible changes in any root
- **WHEN** Git-visible changes occur in any watched root, including a repository-root watch
- **THEN** content-watcher exclusions (built-in folders such as `dist/`, configured excludes, or an honoured `.gitignore`) SHALL NOT suppress repository updates for tracked files and untracked files no `.gitignore` excludes

#### Scenario: Repository observation needs polling or loses its last client
- **WHEN** periodic repository polling is considered
- **THEN** it SHALL be used only where native observation is unavailable or failed, or when the session runs in polling mode

#### Scenario: Subscription state controls repository work for every observation mode
- **WHEN** repository work is scheduled or its client subscription count changes
- **THEN** clients MUST NOT drive repository collection with periodic requests
- **AND** no Git metadata observation, polling, or repository collection SHALL run while no client is subscribed

#### Scenario: Repository triggers arrive after quiet or during sustained edits
- **WHEN** the first repository trigger follows a quiet period
- **THEN** collection SHALL start promptly

#### Scenario: Sustained repository triggers are coalesced and paced
- **WHEN** repository triggers are sustained, with or without document edits
- **THEN** successive collections SHALL start no closer than a minimum interval; intervening triggers SHALL coalesce into one follow-up reflecting the latest state

#### Scenario: Every repository read is read-only
- **WHEN** repository information is read, whether after quiet or sustained activity
- **THEN** reads MUST NOT write to the repository, including Git's opportunistic index refresh

#### Scenario: A repository refresh is pending or unchanged
- **WHEN** repository collection is in progress or completes
- **THEN** data SHALL be marked stale only if collection remains in progress after a short grace period of about one second
- **AND** a result matching the published result SHALL publish nothing and keep its generation; wall-clock-only text such as relative commit age SHALL NOT count as a difference
- **AND** repository refreshes MUST NOT initiate document-tree rescans or replay a previous Follow target

#### Scenario: Git stalls while the active document changes
- **WHEN** repository collection is blocked and the active file is saved
- **THEN** the file update reaches the client and its Source or Rendered preview shows the new bytes without waiting for repository collection
- **AND** once the grace period passes, the existing repository data is identified as stale rather than silently represented as fresh

#### Scenario: A commit changes only repository metadata
- **WHEN** an external commit updates HEAD and the index without changing document bytes
- **THEN** repository information updates without requiring a document edit and without waiting for a polling interval
- **AND** the update neither switches Follow selection nor rescans the file index

#### Scenario: A commit in a linked worktree is observed
- **WHEN** the watched root is a linked worktree and a commit is made in it
- **THEN** repository information updates, although the branch ref lives in the shared Git directory outside the watched root

#### Scenario: An edit outside a narrow watched root
- **WHEN** the watch root is a subdirectory of its repository and a tracked file outside that subdirectory is modified
- **THEN** repository information updates without a client request and without waiting for a polling interval
- **AND** the modified file does not appear in the document index

#### Scenario: Ignored output outside a narrow watched root
- **WHEN** the watch root is a subdirectory of its repository and an untracked path that the repository's `.gitignore` excludes changes outside it
- **THEN** no repository collection is triggered by that change

#### Scenario: A tracked file the .gitignore matches
- **WHEN** the watch root is a subdirectory of its repository and a tracked file outside it, which the `.gitignore` matches, is modified
- **THEN** repository information updates

#### Scenario: A tracked file in a folder the content watcher excludes
- **WHEN** a tracked file under `dist/`, which the document index always excludes, is modified
- **THEN** repository information updates

#### Scenario: A tracked file the .gitignore matches in a whole-repository root
- **WHEN** the watch root is its repository's top level and a tracked file that the `.gitignore` matches is modified
- **THEN** repository information updates

#### Scenario: A change while observation starts
- **WHEN** Git metadata changes after the first collection but before the observer's watches are in place
- **THEN** a collection after the observer starts reflects that change

#### Scenario: The first fetch of a remote
- **WHEN** a repository whose remote has never been fetched is fetched for the first time
- **THEN** repository information updates, although the remote's ref directory did not exist when observation started

#### Scenario: A watched root becomes a repository
- **WHEN** a client is subscribed to a watched root that is not in a Git repository, and `git init` and a first commit are run in it
- **THEN** repository information updates without a client request

#### Scenario: A page with Git views open sends no periodic requests
- **WHEN** a page shows the Change Overview, the Git Log or a Diff and nothing changes for several minutes
- **THEN** the page sends no repository refresh requests

#### Scenario: A fetch moves the compare base
- **WHEN** a fetch updates the remote ref that the compare base resolves through
- **THEN** the changed-files context is recollected against the new base

#### Scenario: An idle repository costs nothing
- **WHEN** a client is subscribed and neither files nor Git metadata change
- **THEN** no repository collection runs and no Git process is started

#### Scenario: Reading the repository does not trigger another refresh
- **WHEN** repository collection runs while tracked files have changed metadata but unchanged content
- **THEN** the Git index file is not rewritten
- **AND** no follow-up refresh is triggered by the collection itself

#### Scenario: Sustained edits pace repository collection
- **WHEN** files change continuously for several seconds
- **THEN** successive repository collections start no closer together than the minimum interval
- **AND** after the edits stop, one collection reflects the final state

#### Scenario: A refresh that finds nothing new is invisible
- **WHEN** a repository refresh produces the same result as the one already published, apart from wall-clock-relative text
- **THEN** no repository update is published and the repository generation does not change
- **AND** clients show no refreshing notice

#### Scenario: Native Git observation is unavailable
- **WHEN** the session runs in polling mode or native observation of the Git metadata or working tree fails
- **THEN** Git-only changes are still observed through periodic polling while a client is subscribed
- **AND** each poll collects repository data, so edits outside a narrow root, edits to tracked files the content watcher excludes, and a root becoming a repository still appear

#### Scenario: The last client leaves
- **WHEN** the last subscribed client disconnects
- **THEN** Git metadata observation and polling stop, and no further repository collection is scheduled

### Requirement: Recovery is explicit and repairs watch coverage

The system SHALL reconcile affected roots when ignore policy changes, filesystem observation is known to have failed, or the user requests workspace recovery. Reconciliation SHALL repair watch coverage and the index, including newly allowed directories. The system SHALL retain existing root containment, ignore, secret, symlink, and independent client-scope rules throughout discovery and recovery.

#### Scenario: Recovery requests overlap or a browser reconnects
- **WHEN** concurrent root-recovery requests arrive
- **THEN** they SHALL coalesce, retain intervening file events, and preserve the last coherent inventory until replacement succeeds

#### Scenario: A browser reconnects without lost server watch coverage
- **WHEN** only a browser connection gap needs recovery
- **THEN** it SHALL recover from current server state without requiring a new filesystem crawl

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

### Requirement: Failed document loads are classified as final or transient
The server SHALL classify failed document requests using the status and logging rules below, without exposing underlying error messages or filesystem causes in error bodies. The preview SHALL retry only transient outcomes on a bounded schedule and show cause-specific final notices. Reselecting after a final failure SHALL issue exactly one new request unless that request fails transiently.

#### Scenario: A document is missing, unreadable, or binary
- **WHEN** a requested document is absent from the workspace index or its indexed path cannot resolve to a readable file because it is missing, a component is not a directory, it is a directory, a symbolic-link loop exists, or the path name is too long
- **THEN** the server SHALL answer not found (HTTP 404)

#### Scenario: A document read is denied or its content is binary
- **WHEN** a document request fails with permission denied or operation not permitted
- **THEN** the server SHALL answer forbidden (HTTP 403) with a body identifying the document as not readable
- **WHEN** the requested document is binary
- **THEN** the server SHALL answer not viewable (HTTP 415)

#### Scenario: Expected document failures do not enter the session log
- **WHEN** a document request answers not-found, forbidden, or not-viewable
- **THEN** the answer MUST NOT be logged

#### Scenario: A document request fails for another reason
- **WHEN** a renderer error, resource exhaustion such as too many open files, an I/O error, or any other unrecognized failure prevents delivery
- **THEN** the server SHALL answer server failure (HTTP 500) and record the document and cause in the session log

#### Scenario: Any document error body preserves private failure details
- **WHEN** a document request returns an error body, for any failure class
- **THEN** it MUST NOT include the underlying error message or filesystem cause

#### Scenario: The preview classifies a complete or interrupted response
- **WHEN** a document load fails
- **THEN** it SHALL be transient only for 5xx, 408 (Request Timeout), 429 (Too Many Requests), a failed request with no complete answer, or a successful response whose body stops before completion
- **AND** transient failures SHALL retry on the bounded schedule without reading `Retry-After`
- **AND** every other outcome SHALL be final and MUST NOT retry automatically, including all other 4xx statuses and a successful status with an unparseable document payload
- **AND** a failure answer with a non-server-JSON body (such as proxy HTML) or an incomplete body SHALL be classified by status alone

#### Scenario: A final failure or exhausted retry is displayed
- **WHEN** a document load reaches a final failure
- **THEN** a forbidden notice SHALL read "Uatu doesn't have permission to read this file. Change its permissions, then select it again."
- **AND** a not-found notice SHALL read "File unavailable. It may have been removed or excluded from this workspace."
- **AND** every other final failure SHALL read "This file couldn't be loaded. Select it again to retry."
- **AND** selecting the document again after a final failure SHALL make exactly one new request and MUST NOT restart a retry cycle unless that request fails transiently

#### Scenario: A transient document load is retrying or exhausts its budget
- **WHEN** transient retries remain
- **THEN** the preview SHALL show "This file couldn't be loaded. Retrying…"
- **WHEN** those retries are exhausted
- **THEN** the preview SHALL show "This file couldn't be loaded. Select it again to retry."

#### Scenario: A permission-denied document is final
- **WHEN** the selected document exists in the index but the server process is not permitted to read it
- **THEN** the server answers 403 and writes nothing to the session log for that request
- **AND** the preview shows the permission notice without first showing "Retrying…"
- **AND** the preview makes no further request for that document until the user selects it again or the document changes

#### Scenario: Selecting a permission-denied document again makes one request
- **WHEN** the preview shows the permission notice and the user selects the same document again
- **THEN** the preview makes exactly one request for that document
- **AND** if the file is now readable the preview renders it, otherwise the permission notice remains without retries

#### Scenario: A document path that became a directory is not found
- **WHEN** an indexed document's path is replaced by a directory before the index catches up, and the document is requested
- **THEN** the server answers 404 and the preview shows the not-found notice without retrying

#### Scenario: A renderer failure is still retried
- **WHEN** the document is readable but rendering it fails
- **THEN** the server answers 500 and logs the document and the cause
- **AND** the preview shows "This file couldn't be loaded. Retrying…" and retries on its bounded schedule

#### Scenario: Resource exhaustion is still retried
- **WHEN** reading the document fails because the server has too many open files
- **THEN** the server answers 500 and the preview retries on its bounded schedule

#### Scenario: An unanswered request is retried
- **WHEN** the document request fails without any response, for example because the network dropped or the hub reports the session unreachable with a 5xx
- **THEN** the preview treats the failure as transient and retries on its bounded schedule

#### Scenario: A request timeout or rate limit in the path is retried
- **WHEN** the document request is answered 408 or 429, for example by a proxy in front of the session
- **THEN** the preview shows "This file couldn't be loaded. Retrying…" and retries on its bounded schedule
- **AND** once the schedule is used up it shows "This file couldn't be loaded. Select it again to retry."

#### Scenario: A proxy's error page is classified by its status
- **WHEN** the document request is answered 403 or 404 with a body that is not JSON
- **THEN** the preview does not retry
- **AND** a 403 shows "This file couldn't be loaded. Select it again to retry." and a 404 shows the not-found notice

#### Scenario: A failure answer whose body breaks is classified by its status
- **WHEN** the document request is answered with a failure status but the response body stops arriving before it is complete
- **THEN** a 403, 404 or 415 is final and is not retried, and a 403 shows "This file couldn't be loaded. Select it again to retry."
- **AND** a 408, 429 or 5xx is retried on the bounded schedule

#### Scenario: A successful answer whose body breaks is retried
- **WHEN** the document request is answered with a successful status but the response body stops arriving before it is complete
- **THEN** the preview treats the failure as transient and retries on its bounded schedule

#### Scenario: An unparseable successful answer is final
- **WHEN** the server answers the document request with a successful status but the body is not a valid document payload
- **THEN** the preview shows "This file couldn't be loaded. Select it again to retry." without retrying

### Requirement: Ignored-file observation is shared and never steers Follow
The shared index SHALL retain known permitted Gitignored files and deliver their write metadata and revisions through existing ordered snapshots/patches. Each client's visibility SHALL determine its browsing results without reconstructing the shared watcher or changing another client's corpus. Gitignored files SHALL NOT be Follow candidates in any client.

#### Scenario: Shared ignored-file knowledge is retained
- **WHEN** the shared index learns individually ignored files, contents of listed ignored-folder levels, or live writes retained by the ignored-folder window
- **THEN** it SHALL retain those permitted files

#### Scenario: Unknown ignore classification does not assert a Git state
- **WHEN** a file's ignore classification is unknown
- **THEN** that uncertainty SHALL be represented without falsely asserting a Git state

#### Scenario: Ignore policy changes or indexing and visibility work is requested
- **WHEN** ignore policy is evaluated
- **THEN** evaluation SHALL support standard Git-ignore sources and update when they change
- **WHEN** discovery, recovery, or incremental writes run
- **THEN** discovery/recovery SHALL remain bounded and incremental writes SHALL retain path-bounded index work
- **WHEN** a client toggles its visibility preference
- **THEN** it MUST NOT start a filesystem crawl

#### Scenario: Two clients choose different ignored visibility
- **WHEN** one shows ignored files and another hides them while the same ignored export changes
- **THEN** the showing client's eligible views update, the hiding client's results remain filtered, and neither preference changes the other's state
- **AND** their existing document-topic delivery remains coherent

#### Scenario: An ignored document is not a Follow candidate in any client
- **WHEN** a newly written ignored document is visible in one client and hidden in another
- **THEN** neither client's Follow moves to it

#### Scenario: A visibility toggle is cheap
- **WHEN** a user toggles Show ignored files after discovery
- **THEN** results are projected from known file metadata without restarting watchers or performing a full scan

### Requirement: Browse permitted files from watched roots
The sidebar SHALL offer permitted indexed files under each watched root through All, Recent, and Changed. Markdown, AsciiDoc, and viewable text SHALL use existing document pipelines. Binary files SHALL be clickable and route to image, paused recognized audio/video, or unsupported-binary preview-unavailable views. Exposure and ignored-folder browsing SHALL follow the rules below.

#### Scenario: A file is considered for exposure in a client's browser
- **WHEN** a watched-root file is indexed or requested directly
- **THEN** built-in and explicit Uatu exclusions SHALL neither appear nor be directly readable; no file SHALL be withheld merely because its name looks like a secret
- **AND** Git-ignore status SHALL be indexed separately from each client's visibility choice, and permitted ignored files SHALL be available when that client shows them
- **AND** contents of folders Git ignores as a whole SHALL be offered under the on-demand ignored-folder requirement

#### Scenario: Sidebar lists every non-ignored file under each watched root
- **WHEN** roots contain Markdown, AsciiDoc, source, configuration, image, media, and unsupported binary files
- **THEN** all permitted entries are available under the applicable view and visibility settings
- **AND** each type routes to its corresponding preview or unavailable state

#### Scenario: Secret-like files are listed like other files
- **WHEN** roots contain `.env`, `id_rsa`, or `service-account.json` and no explicit exclusion names them
- **THEN** they are listed, muted when Git ignores them, and can be previewed by an authenticated client

#### Scenario: An explicitly excluded secret is unavailable
- **WHEN** `ignore.exclude` contains `.env*`
- **THEN** `.env.local` is not listed and cannot be previewed or delivered by direct identity

#### Scenario: Selecting a Markdown file renders its preview
- **WHEN** a Markdown filename is selected
- **THEN** it becomes active and renders through the Markdown pipeline

#### Scenario: Selecting an AsciiDoc file renders its preview
- **WHEN** an adoc/asciidoc filename is selected
- **THEN** it becomes active and renders through the AsciiDoc pipeline

#### Scenario: A `.asc` file is not rendered as AsciiDoc
- **WHEN** an ASCII-armored signature file uses the asc extension
- **THEN** it is treated as text rather than AsciiDoc

#### Scenario: Selecting a non-Markdown text file renders its preview
- **WHEN** another viewable text filename is selected
- **THEN** it becomes active and uses the existing source/code pipeline

#### Scenario: Selecting a binary entry routes to the preview-unavailable view
- **WHEN** an unsupported binary filename is selected
- **THEN** selection updates to that file and preview unavailable is displayed without streaming its contents into document rendering

### Requirement: Serve adjacent permitted files as static content
The server SHALL use Accept to distinguish HTML-preferring top-level navigation from subresources. Navigation to any known indexed file, including images/media, SHALL return the SPA shell rather than raw contents, preventing watched SVG execution at the app origin through direct navigation. Other fallback requests SHALL serve only permitted watched-root files under the containment and URL rules below.

#### Scenario: A static fallback resolves a watched-root resource
- **WHEN** any non-navigation fallback request is resolved, whether or not it identifies a permitted file
- **THEN** built-in exclusions, explicit Uatu excludes, and realpath containment SHALL be enforced
- **AND** Git-ignore browsing visibility SHALL NOT deny permitted authenticated static delivery
- **AND** traversal, malformed encoding, and symlink escapes SHALL fail without serving outside contents

#### Scenario: Dedicated media delivery does not depend on static fallback
- **WHEN** the dedicated media route handles a request
- **THEN** it SHALL retain its own indexed-identity/range contract independently of fallback Accept negotiation

#### Scenario: Rendered document references reach static delivery
- **WHEN** server HTML contains authored rendered src/href references
- **THEN** they SHALL remain unchanged and resolve through the per-document base

#### Scenario: Watched image revisions and unrelated image URLs retain their boundaries
- **WHEN** a watched image is mounted or its static path is resolved
- **THEN** mounted images SHALL retain revision query parameters for cache invalidation, while static path resolution SHALL ignore that query string
- **WHEN** an image URL is external or non-watched
- **THEN** it SHALL remain unchanged

#### Scenario: A README's centered hero image loads via the static file fallback
- **WHEN** an allowed adjacent image is referenced by a relative src
- **THEN** server-rendered HTML preserves that src, the per-document base resolves it, and the mounted watched image carries its revision

#### Scenario: A top-level navigation to a document URL returns the SPA shell
- **WHEN** a known document is requested with HTML-preferring Accept
- **THEN** the shell is returned instead of raw document contents

#### Scenario: A top-level navigation to an image URL returns the SPA shell
- **WHEN** a known image is requested with HTML-preferring Accept
- **THEN** the shell is returned instead of raw image/SVG contents

#### Scenario: A sub-resource fetch for a document URL returns raw bytes
- **WHEN** an allowed document is requested with Accept */*
- **THEN** its raw contents are returned instead of the shell

#### Scenario: A top-level navigation to an asset URL returns the asset
- **WHEN** a permitted image is requested as an image subresource
- **THEN** its image bytes are returned instead of the shell

#### Scenario: Unrelated paths are 404
- **WHEN** a non-navigation request resolves to no permitted existing file
- **THEN** it receives 404

#### Scenario: Traversal attempts are rejected
- **WHEN** a request resolves outside every watched root
- **THEN** it receives no outside file contents

#### Scenario: Excluded files are not served directly
- **WHEN** an explicit Uatu exclusion removes a path
- **THEN** direct static delivery refuses it even when ignored files are shown

#### Scenario: Symlink escapes are rejected
- **WHEN** realpath resolution escapes a watched root
- **THEN** the outside file is not served

#### Scenario: A file inside an unexpanded ignored folder is served
- **WHEN** an allowed document references `build/figures/plot.png` and no client has expanded `build/`
- **THEN** authenticated static delivery returns the image

#### Scenario: Malformed URL encoding fails safely
- **WHEN** a fallback URL has malformed percent encoding
- **THEN** it fails without uncaught request-handling errors

#### Scenario: Browsing visibility does not deny a permitted ignored asset
- **WHEN** a client hides ignored rows but an allowed document references an ignored image
- **THEN** authenticated static delivery can still load that image

### Requirement: Git-ignored folders are listed on demand
In a watched root inside a Git working tree, a folder Git ignores as a whole SHALL be indexed as a folder entry without reading its contents during discovery/recovery. Folders containing tracked or non-ignored files SHALL be discovered normally. Clients SHALL be able to list ignored folders one level at a time under the shared-index and exposure rules below. In watched roots outside Git, no folder SHALL be treated as ignored and discovery SHALL be complete.

#### Scenario: A client lists one ignored-folder level
- **WHEN** a client requests a level of a wholly ignored folder
- **THEN** the listing SHALL return that level's permitted files with metadata and its subfolders; subfolders SHALL be folder entries listed on demand in turn
- **AND** the listed level SHALL join the shared index for the rest of the session, with later changes published to every client
- **AND** listing SHALL enforce built-in and explicit exclusions and realpath containment; a nonexistent level SHALL remove its folder entry

#### Scenario: Git ignore sources change without another listing request
- **WHEN** Git ignore sources change
- **THEN** folder entries and listed levels SHALL reconcile without a session restart

#### Scenario: `node_modules/` is not read at startup
- **WHEN** a Git root ignores `node_modules/`, which contains 100,000 files
- **THEN** discovery indexes `node_modules/` as one folder entry and reads none of its contents

#### Scenario: Expanding an ignored folder lists one level
- **WHEN** a client requests the listing of `build/`, which contains `renders/`, `CMakeFiles/`, and `CMakeCache.txt`
- **THEN** `CMakeCache.txt` is indexed with its metadata and `renders/` and `CMakeFiles/` are indexed as folder entries

#### Scenario: A listed level stays current
- **WHEN** `build/renders/` has been listed and a script writes `build/renders/take-4.wav`
- **THEN** every client receives the new file without listing the folder again

#### Scenario: A partially ignored folder is discovered normally
- **WHEN** Git ignores `/references/*` but not `/references/README.md`
- **THEN** `references/` is discovered normally and its ignored files are indexed individually with ignored status

#### Scenario: An ignored folder appears at runtime
- **WHEN** a build creates `build/` while the session runs and Git ignores it
- **THEN** `build/` becomes a folder entry without its contents being read in full

#### Scenario: A non-Git root is discovered completely
- **WHEN** the watched root is not inside a Git working tree
- **THEN** every permitted file is discovered, and only explicit exclusions limit discovery

### Requirement: Writes inside unlisted ignored folders are captured within a bounded window
A file created or written inside an unlisted Git-ignored folder level SHALL be indexed when observed, appearing in Recent and type filters without listing its folder. Per root, the system SHALL retain at most the 2,000 most recently written such files, with the pinning and eviction rules below. Writes inside listed levels SHALL NOT count toward this window.

#### Scenario: The unlisted-folder write window fills or a retained file is removed
- **WHEN** a newer write would exceed the per-root window
- **THEN** the oldest retained file SHALL leave the index unless pinned
- **AND** an evicted file SHALL become available again when its folder level is listed

#### Scenario: A content request pins a file before or after window pressure
- **WHEN** any client requests a file's document, static, or media content
- **THEN** that file SHALL be pinned for the rest of the session

#### Scenario: An unlisted ignored folder loses a retained file
- **WHEN** a file is removed inside an unlisted ignored folder
- **THEN** any retained entry for that file SHALL be removed

#### Scenario: A new render appears without expanding `build/`
- **WHEN** no client has listed `build/` and a script writes `build/renders/take-5.wav`
- **THEN** the file appears in Recent and under the Audio filter, muted, and can be played

#### Scenario: An install cannot flood the index
- **WHEN** an install writes 80,000 files inside an unlisted ignored `node_modules/`
- **THEN** at most 2,000 of them, the most recently written, are retained in the index for that root

#### Scenario: A playing file survives eviction
- **WHEN** a client is playing `build/renders/take-5.wav` and a later build writes 5,000 files inside unlisted ignored folders
- **THEN** the playing file remains indexed and deliverable

#### Scenario: An evicted file returns on expansion
- **WHEN** `build/renders/take-1.wav` left the window and the user expands `build/renders/`
- **THEN** the listing includes `take-1.wav` again

### Requirement: Ignored-folder updates are published in bounded batches
Updates inside Git-ignored folders, whether listed or captured by the live-write window, SHALL publish separately from other updates. Publication SHALL be scheduled one to five seconds after the first queued event, including under sustained churn, with at most 1,024 entries per patch. Coalescing, ignored classification, and refresh SHALL follow the rules below.

#### Scenario: Ignored-folder paths change repeatedly within a batch interval
- **WHEN** creations, writes, or removals queue for an ignored-folder publication
- **THEN** they SHALL coalesce by path into one latest-state entry; a path created and removed before publication SHALL NOT be published
- **AND** entries SHALL carry ignored status and SHALL NOT be followed by a separate classification update
- **AND** these updates SHALL NOT produce Follow-candidate updates
- **AND** entries beyond the 1,024-per-patch limit SHALL follow in subsequent patches without another interval
- **AND** an open ignored file SHALL refresh after its revision is published under existing active-file and media rules

#### Scenario: A large rebuild arrives in a few patches
- **WHEN** a build writes 5,000 files inside a listed ignored `build/` within two seconds
- **THEN** clients receive those files in at most five document patches, each entry already reporting ignored status
- **AND** no separate classification or Follow-candidate patches follow for those files

#### Scenario: Repeated writes to one output file collapse
- **WHEN** a compiler writes `build/main.o` three times within one publication interval
- **THEN** a single entry for `build/main.o` with its final metadata is published

#### Scenario: A short-lived output file is never published
- **WHEN** a file inside an ignored folder is created and removed before the next publication
- **THEN** no client receives an entry for it

#### Scenario: A single render appears promptly
- **WHEN** a script writes one file inside an ignored `build/` and nothing else changes
- **THEN** it appears in Recent within five seconds
