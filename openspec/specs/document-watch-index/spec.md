# document-watch-index Specification

## Purpose
Securely index, classify, serve, and continuously refresh allowed files under watched roots while supporting live previews, follow mode, binary handling, and configurable ignore rules.
## Requirements

### Requirement: Browse supported documents from watched roots
The browser UI SHALL display a sidebar tree grouped by watched root. The tree SHALL list every file accepted by the ignore and exposure filters under each root, recursively. Files classified as Markdown, AsciiDoc, or as viewable text SHALL render as clickable entries that can become the active preview. Files classified as binary SHALL render as clickable entries: clicking a binary entry MUST route the preview to the existing "preview unavailable" view rather than rendering binary contents. Files matching the hardcoded directory denylist, default-denied secret patterns, hardcoded ignored names, `.uatu.json ignore.exclude` patterns, or active `.gitignore` rules MUST NOT appear in the sidebar. The preview pane SHALL render the currently selected non-binary file: Markdown files through the Markdown pipeline, AsciiDoc files through the AsciiDoc pipeline, other text files through the syntax-highlighted code render path.

#### Scenario: Sidebar lists every non-ignored file under each watched root
- **WHEN** watched roots contain a mix of Markdown, AsciiDoc, source code, configuration, and binary files
- **THEN** the sidebar displays all of those files within the hierarchy of their corresponding watched root
- **AND** Markdown, AsciiDoc, and other text files appear as clickable entries
- **AND** binary files appear as clickable entries that route to the preview-unavailable view when selected

#### Scenario: Secret-like files are excluded by default
- **WHEN** a watched root contains common secret-bearing files such as `.env`, `.env.local`, `.npmrc`, credential JSON, or private-key files
- **THEN** those files do not appear as sidebar entries
- **AND** they cannot become the active preview document by direct document ID request

#### Scenario: Selecting a Markdown file renders its preview
- **WHEN** a user selects a Markdown file from the sidebar
- **THEN** the preview pane renders that file through the Markdown pipeline
- **AND** the active selection updates to the chosen file

#### Scenario: Selecting an AsciiDoc file renders its preview
- **WHEN** a user selects an AsciiDoc file (`.adoc` or `.asciidoc`) from the sidebar
- **THEN** the preview pane renders that file through the AsciiDoc pipeline
- **AND** the active selection updates to the chosen file

#### Scenario: A `.asc` file is not rendered as AsciiDoc
- **WHEN** the watch root contains a `release-1.0.tar.gz.asc` PGP signature file
- **THEN** the sidebar lists it as a regular text entry rather than as an AsciiDoc document
- **AND** selecting it renders its contents through the syntax-highlighted code path, not the AsciiDoc pipeline

#### Scenario: Selecting a non-Markdown text file renders its preview
- **WHEN** a user selects a non-Markdown, non-AsciiDoc text file (e.g. `.yaml`, `.py`, `.json`) from the sidebar
- **THEN** the preview pane renders that file as syntax-highlighted code
- **AND** the active selection updates to the chosen file

#### Scenario: Selecting a binary entry routes to the preview-unavailable view
- **WHEN** a user selects a binary tree entry
- **THEN** the active selection updates to that file
- **AND** the preview shows the existing preview-unavailable view for binary content
- **AND** no binary bytes are streamed into the preview

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

### Requirement: Serve adjacent files from watched roots as static content
For any request path that does not match a known API or built-in asset route, the server SHALL inspect the request's `Accept` header to distinguish top-level navigation requests from sub-resource fetches. When the `Accept` header prefers `text/html` AND the request path resolves to a known non-binary document under a watched root, the server MUST return the SPA shell (the same response served at `/`) so the SPA can render the document with its full UI. For all other requests — including requests whose `Accept` does not prefer `text/html`, requests that resolve to a binary file, and requests that do not resolve to any document — the server SHALL attempt to resolve the path against the union of watched roots and, if the path maps to an existing allowed file inside a watched root, serve that file statically. Static fallback serving MUST apply the same hardcoded ignore, default secret-file denylist, `.uatu.json ignore.exclude` patterns, and active `.gitignore` exposure rules as the browser tree. Static fallback serving MUST verify containment after resolving real filesystem paths and MUST NOT serve files reached through symlink escapes outside the watched root. The rendered preview HTML MUST preserve the author's original `src` and `href` URLs verbatim (no URL rewriting); the browser SHALL resolve those references using a per-document base so that relative references such as `<img src="./hero.svg">` in a README just work. Any requested path that resolves outside every watched root, is ignored, is secret-like, is malformed, or cannot be safely resolved MUST receive a non-success response and MUST NOT read or stream the file.

#### Scenario: A README's centered hero image loads via the static file fallback
- **WHEN** a previewed Markdown file contains `<img src="./hero.svg">` whose target exists next to the document and is not ignored or secret-like
- **THEN** the rendered image's `src` attribute is preserved as `./hero.svg`
- **AND** the browser resolves it through the per-document base and receives the image from the static file fallback

#### Scenario: A top-level navigation to a document URL returns the SPA shell
- **WHEN** the server receives `GET /guides/setup.md` with `Accept: text/html,application/xhtml+xml,...`
- **AND** `guides/setup.md` is a known non-binary document under a watched root
- **THEN** the server responds with the SPA shell (same body served at `/`)
- **AND** the response is NOT the raw markdown source bytes

#### Scenario: A sub-resource fetch for a document URL returns raw bytes
- **WHEN** the server receives `GET /README.md` with `Accept: */*` (e.g. from `curl`)
- **THEN** the server responds with the raw markdown source via the static fallback
- **AND** the response is NOT the SPA shell

#### Scenario: A top-level navigation to an asset URL returns the asset
- **WHEN** the server receives `GET /hero.svg` with an `Accept` header that does not prefer `text/html` (e.g. `image/avif,image/webp,*/*`)
- **THEN** the server responds with the SVG bytes via the static fallback
- **AND** the response is NOT the SPA shell

#### Scenario: Unrelated paths are 404
- **WHEN** the server receives a request for a path that does not map to any file inside a watched root
- **THEN** the server responds with 404

#### Scenario: Traversal attempts are rejected
- **WHEN** a request path resolves (via `..`) outside every watched root
- **THEN** the server responds with 404 and does not read the file

#### Scenario: Excluded files are not served directly
- **WHEN** a watched root contains a file hidden by `.uatu.json ignore.exclude` or an active `.gitignore` rule
- **THEN** a direct static fallback request for that file receives a non-success response
- **AND** the server does not stream the excluded file contents

#### Scenario: Symlink escapes are rejected
- **WHEN** a request path maps through a symlink inside the watched root to a file outside the watched root
- **THEN** the server responds with 404 and does not stream the outside file contents

#### Scenario: Secret-like files are not served directly
- **WHEN** a watched root contains a default-denied secret-like file
- **THEN** a direct static fallback request for that file receives a non-success response
- **AND** the server does not stream the secret-like file contents

#### Scenario: Malformed URL encoding fails safely
- **WHEN** the server receives a fallback request path with malformed percent-encoding
- **THEN** the server responds with a non-success response
- **AND** request handling continues without an uncaught exception

### Requirement: Respect `.gitignore` by default with an opt-out
The system SHALL read `.gitignore` at each watch root by default and apply its patterns to filter the indexed file set. The system SHALL provide two ways to opt out of this behavior: a per-session CLI flag `--no-gitignore` on the session child's `serve` command, and a per-project setting `ignore.respectGitignore: false` in the watch root's `.uatu.json`. When both are present, the CLI flag wins for the duration of that session. The hardcoded directory denylist (`node_modules`, `.git`, `dist`, `build`, etc.) MUST continue to apply regardless of either opt-out. Files filtered by `.gitignore` MUST NOT appear in the sidebar tree and MUST NOT be eligible for follow mode. When the session is honoring `.gitignore`, filtering SHALL reflect the current on-disk contents of `.gitignore`: edits made mid-session MUST take effect on the next refresh without requiring the session to be restarted.

#### Scenario: `.gitignore` patterns hide files by default
- **WHEN** the watch root's `.gitignore` excludes `*.log`
- **AND** the watch root contains `debug.log`
- **THEN** the sidebar tree does not list `debug.log`

#### Scenario: `--no-gitignore` exposes gitignored files
- **WHEN** a session child is started with `. --no-gitignore`
- **AND** the watch root's `.gitignore` excludes `*.log`
- **AND** the watch root contains `debug.log`
- **THEN** the sidebar tree lists `debug.log`
- **AND** the hardcoded directory denylist still applies (e.g. `node_modules/` remains hidden)

#### Scenario: `.uatu.json ignore.respectGitignore: false` exposes gitignored files
- **WHEN** the watch root's `.uatu.json` sets `ignore.respectGitignore: false`
- **AND** the watch root's `.gitignore` excludes `*.log`
- **AND** the watch root contains `debug.log`
- **THEN** the sidebar tree lists `debug.log`
- **AND** the hardcoded directory denylist still applies

#### Scenario: CLI flag wins over the .uatu.json setting
- **WHEN** the watch root's `.uatu.json` sets `ignore.respectGitignore: true`
- **AND** the session child is started with `. --no-gitignore`
- **THEN** `.gitignore` is NOT honored for the duration of the session

#### Scenario: Editing `.gitignore` at runtime reapplies the new patterns
- **WHEN** a watch session is running and honoring `.gitignore` and the sidebar tree lists `notes.tmp`
- **AND** the user appends `*.tmp` to the watch root's `.gitignore`
- **THEN** the next refresh MUST drop `notes.tmp` from the sidebar tree
- **AND** when the user removes that pattern from `.gitignore` again
- **THEN** the next refresh MUST list `notes.tmp` once more
- **AND** the session is not restarted at any point

### Requirement: Detect binary files and route them to the right preview
The system SHALL classify every file accepted by the ignore filter as either a Markdown document, an AsciiDoc document, a viewable text file, or a binary file. Binary files SHALL appear in the sidebar tree as clickable entries. Selecting a binary entry SHALL change the active document to that file and route the preview based on the file's extension: binaries with a viewable image extension (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.ico`, `.avif`, `.bmp`) SHALL render inline in the preview pane via `<img>`, served by uatu's static-file fallback; all other binaries SHALL render the existing preview-unavailable notice. Binary classification SHALL use a fast path of known-binary file extensions, and a content sniff (NUL bytes or excessive non-printable byte ratio in the first 8 KB) for files whose extensions are not in the known-text or known-binary lists. Binary entries (including images) MUST remain ineligible to change the active document under follow-mode auto-switch — the auto-switch only targets non-binary files.

#### Scenario: An image file is rendered inline in the preview pane
- **WHEN** the watch root contains `logo.png` and the user selects it from the tree
- **THEN** the active selection updates to that file
- **AND** the preview renders an `<img>` tag for the file rather than the preview-unavailable view
- **AND** the image bytes are served by the static-file fallback (not the document-render API)

#### Scenario: A non-image binary lists as a clickable entry routed to preview-unavailable
- **WHEN** the watch root contains `archive.zip`
- **THEN** the sidebar tree lists `archive.zip` as a clickable entry
- **AND** clicking it updates the active selection to that file
- **AND** the preview displays a "this file type isn't viewable" notice rather than streaming binary bytes
- **AND** the preview does NOT display a "document not found" or "no longer exists" message

#### Scenario: An unknown-extension binary blob is detected via content sniff
- **WHEN** the watch root contains a file with an unfamiliar extension whose first 8 KB contain a NUL byte
- **THEN** the sidebar tree lists that file as a clickable entry
- **AND** selecting it routes the preview to the preview-unavailable notice (no image extension matched)

#### Scenario: A plain text file with no extension is treated as text
- **WHEN** the watch root contains a file named `Makefile` whose contents are plain ASCII
- **THEN** the sidebar tree lists `Makefile` as a clickable entry
- **AND** selecting `Makefile` renders its contents in the preview as syntax-highlighted code

#### Scenario: Binary files are excluded from the on-startup default document
- **WHEN** the most recently modified file under the watched roots is a binary file (image or otherwise)
- **THEN** the on-startup default document is the most recently modified non-binary file instead

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

While at least one client is subscribed, the system SHALL learn about Git-only changes from filesystem events on the repository's Git metadata. That covers the top level of the Git directory and, for a linked worktree, of the shared Git directory, plus the ref files of the current branch and the resolved compare base. The Git directory MUST NOT be watched recursively. Lock files, object storage and fsmonitor cookie files SHALL NOT trigger a refresh. When a watch root is narrower than its repository, the system SHALL also observe the repository's working tree outside that root, so that edits there update repository data. That observation excludes the Git directory and untracked paths the repository's top-level `.gitignore` excludes, and it never adds those files to the document index. In any watched root, changes to paths the content watcher excludes (built-in folders such as `dist/`, configured excludes, or a `.gitignore` it honours) still count when Git can see them: tracked files, and untracked files no `.gitignore` excludes. Clients MUST NOT drive repository collection with periodic requests. Periodic polling SHALL be used only where native observation is unavailable or failed, or when the session runs in polling mode. No Git metadata observation, polling or repository collection SHALL run while no client is subscribed.

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
