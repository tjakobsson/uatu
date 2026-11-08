# document-watch-index Specification

## Purpose
Securely index, classify, serve, and continuously refresh allowed files under watched roots while supporting live previews, follow mode, binary handling, and configurable ignore rules.

## Requirements

### Requirement: Browse supported documents from watched roots
The sidebar SHALL offer the permitted indexed files under each watched root through All, Recent, and Changed. Markdown, AsciiDoc, and viewable text SHALL render through their existing document pipelines. Binary files SHALL be clickable; previewable images SHALL render as images, recognized audio/video SHALL open paused media previews, and unsupported binaries SHALL show preview unavailable. Mandatory denied paths, secrets, and explicit Uatu exclusions SHALL not appear or be directly readable. Git-ignore status SHALL be indexed separately from each client's visibility choice, and permitted ignored files SHALL be available when that client shows them. Narrow configured build/dist output includes SHALL follow the tree-filtering capability.

#### Scenario: Sidebar lists every non-ignored file under each watched root
- **WHEN** roots contain Markdown, AsciiDoc, source, configuration, image, media, and unsupported binary files
- **THEN** all permitted entries are available under the applicable view and visibility settings
- **AND** each type routes to its corresponding preview or unavailable state

#### Scenario: Secret-like files are excluded by default
- **WHEN** roots contain default-denied secret-bearing files such as environment files, credentials, or private keys
- **THEN** they are not listed and cannot be previewed or delivered by direct identity

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

### Requirement: Keep the indexed view and preview current
The system SHALL detect creations, deletions, renames, and writes under permitted watched roots and update file metadata and views incrementally. Watching and indexing SHALL share exposure rules. A changed active non-media file SHALL refresh regardless of Follow, invalidating affected Source, Rendered, Diff, and image representations; freshness SHALL not depend solely on a batch's representative Follow target or modification-time equality. Selected and embedded watched images SHALL show the new revision without rerendering the surrounding document or resetting scroll. Existing exclusions for file-scoped embedded-image refresh, srcset/picture, CSS background images, and interactive SVG objects SHALL remain. Active audio/video is the explicit-refresh exception: revision changes SHALL follow media-playback's New render available/Reload contract rather than replacing a mounted source automatically. Fresh snapshots SHALL reconcile revisions after gaps, and stale asynchronous work MUST NOT replace newer selections or revisions. Classification SHALL be reevaluated for writes/renames. Event publication SHALL be scheduled within two seconds of the first queued normalized event even under sustained churn. Keepalives SHALL have no presentation effect or expected-idle warnings. Watchers MUST NOT traverse Git internals or excluded symlink trees and MUST survive transient watcher errors.

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
- **WHEN** file events continue faster than the debounce interval
- **THEN** publication is scheduled within two seconds and remaining paths stay queued

#### Scenario: A rename across the binary boundary updates clickability
- **WHEN** a file is renamed across text, image, media, or unsupported-binary classification
- **THEN** routing uses the new classification and retained old destinations use normal unavailable rules

#### Scenario: Idle watch periods do not look like failures
- **WHEN** no file writes occur while the client stays connected
- **THEN** keepalives maintain delivery without warnings or forced UI refreshes

#### Scenario: Excluded paths do not expand watch coverage
- **WHEN** a directory is mandatory-denied or an excluded symlink tree
- **THEN** the content watcher neither traverses it nor attaches descendant watchers

#### Scenario: The watcher does not descend into `.git/`
- **WHEN** a content path has a .git directory segment
- **THEN** it is excluded from content watching, including with generated-output includes

#### Scenario: A transient watch-syscall failure does not crash the process
- **WHEN** a disappearing path causes a transient observation error
- **THEN** the process remains available and uncertain coverage is recovered

#### Scenario: A playing export is overwritten
- **WHEN** the active media's revision changes
- **THEN** index and Recent metadata update but the media source is not automatically replaced or restarted

### Requirement: Serve adjacent files from watched roots as static content
The server SHALL distinguish HTML-preferring top-level navigation from subresource requests using Accept. Navigation to any known indexed file SHALL return the SPA shell rather than raw file contents, including images/media, so a watched SVG cannot execute at the app origin through direct navigation. Other fallback requests SHALL resolve against permitted files under watched roots, enforcing mandatory denied paths, secrets, explicit Uatu excludes, configured output includes, and realpath containment. Git-ignore browsing visibility SHALL not deny permitted authenticated static delivery. Authored rendered src/href references SHALL remain unchanged in server HTML and resolve through the per-document base. Mounted watched images SHALL retain revision query parameters for cache invalidation; static path resolution SHALL ignore that query string. External or non-watched image URLs SHALL remain unchanged. Traversal, malformed encoding, and symlink escapes SHALL fail without serving outside contents. The dedicated media route SHALL retain its own indexed-identity/range contract and SHALL not depend on this fallback's Accept negotiation.

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

#### Scenario: Secret-like files are not served directly
- **WHEN** a static request names a default-denied secret-like file
- **THEN** no file contents are streamed

#### Scenario: Malformed URL encoding fails safely
- **WHEN** a fallback URL has malformed percent encoding
- **THEN** it fails without uncaught request-handling errors

#### Scenario: Browsing visibility does not deny a permitted ignored asset
- **WHEN** a client hides ignored rows but an allowed document references an ignored image
- **THEN** authenticated static delivery can still load that image

### Requirement: Detect binary files and route them to the right preview
The system SHALL classify permitted files as Markdown, AsciiDoc, viewable text, or binary using known-extension fast paths and at most an initial 8 KB binary sniff for unfamiliar names. Binary entries SHALL remain clickable. Existing previewable image extensions SHALL render through the image path; recognized audio/video candidates SHALL open paused media previews; other binaries SHALL show preview unavailable. Codec failure SHALL not be misreported as document absence. Images SHALL retain existing Follow eligibility, while audio/video and unsupported binaries SHALL not become automatic Follow targets. All binaries SHALL remain excluded from initial default-document selection and Follow-enable catch-up.

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
The live document channel SHALL transmit transport keepalives often enough to prevent normal HTTP intermediaries from treating an otherwise idle stream as abandoned. A keepalive MUST NOT produce an application state update, change the current selection, trigger rendering, or advance state generation. After a channel error, the client MUST own a continuing reconnect cycle with bounded delay and MUST NOT depend indefinitely on a native connection object remaining in a connecting state. A replacement channel MUST deliver and apply a fresh authoritative state snapshot so file changes missed during the gap are reconciled.

When a suspended page resumes, a hidden page becomes visible, or the browser reports restored network connectivity, the client SHALL reconcile authoritative state and ensure that its live channel is current. Duplicate lifecycle signals and overlapping recovery attempts MUST converge to one effective current channel without allowing an older attempt to replace a newer connection.

A page being hidden SHALL NOT permanently end the client's ability to recover. The client MAY release its connection and cancel its pending work whenever the page is hidden, however the browser announces it, but MUST retain its subscriptions and cursors and MUST keep listening for the wake-up signals above, so that a page which is hidden and later shown again reconnects without a manual reload. The client MUST NOT treat any single lifecycle event as proof that the document will never run again; a document that is genuinely unloaded stops its own work.

Recovery work SHALL be individually bounded in time. Coalescing overlapping wake-up signals into one recovery MUST NOT let an unfinished recovery suppress later signals indefinitely: a recovery task that does not complete within a bounded period SHALL be abandoned, and the next wake-up signal SHALL be honoured.

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
Each client's document and Chat streaming requests SHALL have an independent lifecycle through the Hub proxy. Disconnecting, suspending, or reconnecting one client MUST NOT close or delay another client's established streams. When a downstream client abandons a stream, the Hub MUST detach that client from its live broker. For each upstream topic whose final subscriber was that client, the Hub MUST cancel the child request after a short linger, and the child MUST release its subscription within a bounded period. Upstream topics that other clients still subscribe to MUST stay open and keep delivering to those clients. No child subscription may outlive its last client. Stream lifecycle diagnostics SHALL distinguish opens, successful recovery, downstream cancellation, and upstream failure by transport class without recording event payloads, credentials, or sensitive query values.

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
When a session is served through the hub, the browser SHALL receive workspace state snapshots and change signals as the `document` topic of the hub's brokered live stream rather than by opening the workspace's own event route. Every guarantee stated for the live update channel — automatic preview refresh, reconciliation of a missed active-document change from a fresh snapshot, bounded refresh under sustained churn, keepalives with no presentation effect, and one current channel after overlapping lifecycle signals — SHALL hold unchanged for the brokered topic. The workspace's own event route SHALL remain the internal source the hub subscribes to.

#### Scenario: A file change reaches a hub-served page over the brokered stream
- **WHEN** a watched file changes while a user views the workspace through the hub
- **THEN** the sidebar and, when Follow or the selected document calls for it, the preview update from a `document` topic event
- **AND** the page opened no connection to the workspace's own event route

#### Scenario: A missed change is reconciled after the one stream reconnects
- **WHEN** the selected document changes while the brokered stream is interrupted
- **AND** the stream reconnects and its `document` topic delivers a fresh snapshot
- **THEN** the preview refreshes to the current document content

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

Repository snapshots SHALL refresh independently of file indexing and file-update delivery. A slow or failed repository refresh MUST NOT delay publication of file changes or Source and Rendered previews. Repository results SHALL carry their own freshness state and SHALL preserve the last successful result while a replacement is pending or fails. Git-only changes SHALL remain observable, including commits, index changes, branch switches and fetched remote refs with no document edit.

While at least one client is subscribed, the system SHALL learn about Git-only changes from filesystem events on the repository's Git metadata. That covers the top level of the Git directory and, for a linked worktree, of the shared Git directory, plus the ref files of the current branch and the resolved compare base, and the repository's `info/exclude`. The Git directory MUST NOT be watched recursively. Lock files, object storage and fsmonitor cookie files SHALL NOT trigger a refresh. When a watch root is narrower than its repository, the system SHALL also observe the repository's working tree outside that root, so that edits there update repository data. That observation excludes the Git directory and untracked paths the repository's top-level `.gitignore` excludes, and it never adds those files to the document index. In any watched root, changes to paths the content watcher excludes (built-in folders such as `dist/`, configured excludes, or a `.gitignore` it honours) still count when Git can see them: tracked files, and untracked files no `.gitignore` excludes. Clients MUST NOT drive repository collection with periodic requests. Periodic polling SHALL be used only where native observation is unavailable or failed, or when the session runs in polling mode. No Git metadata observation, polling or repository collection SHALL run while no client is subscribed.

A repository collection SHALL start promptly after the first trigger that follows a quiet period. Under sustained triggers, successive collections SHALL start no closer together than a minimum interval. Triggers that arrive in the meantime SHALL coalesce into one follow-up collection that reflects the latest state. Repository reads MUST NOT write to the repository, including Git's opportunistic index refresh.

A refresh whose result matches the published result SHALL publish nothing and keep its generation. Text that varies only with wall-clock time, such as a relative commit age, does not count as a difference. Repository data SHALL be marked stale only if collection is still in progress after a short grace period of about one second. Repository refreshes MUST NOT initiate document-tree rescans or replay a previous Follow target.

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

### Requirement: Failed document loads are classified as final or transient
When the server cannot answer a document request with the document, it SHALL classify the failure by whether it can recover on its own. A document the workspace index does not hold, or whose indexed path no longer resolves to a readable file (the file is missing, a path component is not a directory, the path is a directory, the path is a symbolic-link loop, or the path name is too long), SHALL be answered as not found (HTTP 404). A document the server process is not permitted to read (permission denied or operation not permitted) SHALL be answered as forbidden (HTTP 403) with an error body that identifies the document as not readable. A binary document SHALL be answered as not viewable (HTTP 415). Any other failure, including a renderer error, resource exhaustion such as too many open files, an I/O error, or an unrecognized error, SHALL be answered as a server failure (HTTP 500). The server SHALL record a server failure, with the document and its cause, in the session log. It MUST NOT log a not-found, forbidden, or not-viewable answer. Error bodies MUST NOT include the underlying error message or the filesystem cause.

The preview SHALL treat a load as transient only when the answer's status was a 5xx, 408 (Request Timeout) or 429 (Too Many Requests), or when the request received no complete answer: the request failed, or the body of a successful response stopped arriving before it was complete. It SHALL retry a transient failure on its bounded schedule, and it does not read a `Retry-After` header. Every other outcome SHALL be final and MUST NOT be retried automatically. This includes every other 4xx status and a successful status whose body cannot be parsed as a document payload. A failure answer whose body is not the server's JSON error body (for example a proxy's HTML error page), or whose body stopped arriving before it was complete, SHALL be classified by its status alone. A final failure SHALL show a notice that states its cause:
- forbidden: "Uatu doesn't have permission to read this file. Change its permissions, then select it again."
- not found: "File unavailable. It may have been removed or excluded from this workspace."
- any other final failure: "This file couldn't be loaded. Select it again to retry."

While a transient failure is still being retried, the preview SHALL show "This file couldn't be loaded. Retrying…". Once the schedule is used up, it SHALL show "This file couldn't be loaded. Select it again to retry." When the user selects the document again after a final failure, the preview SHALL make exactly one new request. It MUST NOT restart a retry cycle unless that request fails transiently.

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

### Requirement: Ignored-file observation is independent of browsing visibility
The shared index SHALL retain permitted Gitignored files and deliver their write metadata and revisions through existing ordered snapshots/patches. Each client's visibility SHALL determine its browsing results and document/image Follow candidates without reconstructing the shared watcher or changing another client's corpus. Unknown ignore classification SHALL be represented without falsely asserting a Git state. Policy evaluation SHALL support standard Git-ignore sources and shall update when they change. Discovery/recovery SHALL remain bounded and incremental file writes SHALL retain path-bounded index work; toggling a client preference MUST NOT start a filesystem crawl.

#### Scenario: Two clients choose different ignored visibility
- **WHEN** one shows ignored files and another hides them while the same ignored export changes
- **THEN** the showing client's eligible views update, the hiding client's results remain filtered, and neither preference changes the other's state
- **AND** their existing document-topic delivery remains coherent

#### Scenario: Follow candidates differ between clients
- **WHEN** a newly written ignored document/image is eligible only in one client's visibility context
- **THEN** it can become that client's Follow target without steering the other client to a hidden file

#### Scenario: A visibility toggle is cheap
- **WHEN** a user toggles Show ignored files after discovery
- **THEN** results are projected from known file metadata without restarting watchers or performing a full scan
