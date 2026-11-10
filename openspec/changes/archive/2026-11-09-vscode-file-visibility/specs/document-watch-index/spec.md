## MODIFIED Requirements

### Requirement: Keep the indexed view and preview current
The system SHALL detect creations, deletions, renames, and writes under permitted watched roots and update file metadata and views incrementally. Watching and indexing SHALL share exposure rules. A changed active non-media file SHALL refresh regardless of Follow, invalidating affected Source, Rendered, Diff, and image representations; freshness SHALL not depend solely on a batch's representative Follow target or modification-time equality. Selected and embedded watched images SHALL show the new revision without rerendering the surrounding document or resetting scroll. Existing exclusions for file-scoped embedded-image refresh, srcset/picture, CSS background images, and interactive SVG objects SHALL remain. Active audio/video is the explicit-refresh exception: revision changes SHALL follow media-playback's New render available/Reload contract rather than replacing a mounted source automatically. Fresh snapshots SHALL reconcile revisions after gaps, and stale asynchronous work MUST NOT replace newer selections or revisions. Classification SHALL be reevaluated for writes/renames. Publication of events outside Git-ignored folders SHALL be scheduled within two seconds of the first queued normalized event even under sustained churn, including churn inside ignored folders. Events inside Git-ignored folders SHALL follow the batched ignored-folder publication requirement. Keepalives SHALL have no presentation effect or expected-idle warnings. Watchers MUST NOT traverse Git internals or excluded symlink trees and MUST survive transient watcher errors.

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

## REMOVED Requirements

### Requirement: Ignored-file observation is independent of browsing visibility
**Reason**: Replaced by "Ignored-file observation is shared and never steers Follow": Gitignored files are no longer Follow candidates in any client, and the shared index holds only the ignored files it knows (individually ignored files, listed ignored-folder levels, and the live-write window).
**Migration**: None for projects. Users who relied on Follow jumping to a shown ignored file open it explicitly; it still refreshes in place.

### Requirement: Browse supported documents from watched roots
**Reason**: Replaced by "Browse permitted files from watched roots", which no longer withholds files whose names look like secrets and offers ignored-folder contents on demand.
**Migration**: Projects that relied on the built-in secret denial add patterns such as `.env*`, `*.pem`, and `id_*` to `.uatu.json ignore.exclude`.

### Requirement: Serve adjacent files from watched roots as static content
**Reason**: Replaced by "Serve adjacent permitted files as static content", which drops the secret-name denial and the retired output-include rule.
**Migration**: Use explicit `ignore.exclude` patterns for files that must never be served.

## ADDED Requirements

### Requirement: Ignored-file observation is shared and never steers Follow
The shared index SHALL retain the permitted Gitignored files it knows (individually ignored files, the contents of listed ignored-folder levels, and live writes retained by the ignored-folder window) and deliver their write metadata and revisions through existing ordered snapshots/patches. Each client's visibility SHALL determine its browsing results without reconstructing the shared watcher or changing another client's corpus. Gitignored files SHALL NOT be Follow candidates in any client. Unknown ignore classification SHALL be represented without falsely asserting a Git state. Policy evaluation SHALL support standard Git-ignore sources and shall update when they change. Discovery/recovery SHALL remain bounded and incremental file writes SHALL retain path-bounded index work; toggling a client preference MUST NOT start a filesystem crawl.

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
The sidebar SHALL offer the permitted indexed files under each watched root through All, Recent, and Changed. Markdown, AsciiDoc, and viewable text SHALL render through their existing document pipelines. Binary files SHALL be clickable; previewable images SHALL render as images, recognized audio/video SHALL open paused media previews, and unsupported binaries SHALL show preview unavailable. Built-in exclusions and explicit Uatu exclusions SHALL not appear or be directly readable; no file SHALL be withheld because its name looks like a secret. Git-ignore status SHALL be indexed separately from each client's visibility choice, and permitted ignored files SHALL be available when that client shows them. Contents of folders Git ignores as a whole SHALL be offered as specified by the on-demand ignored-folder requirement.

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
The server SHALL distinguish HTML-preferring top-level navigation from subresource requests using Accept. Navigation to any known indexed file SHALL return the SPA shell rather than raw file contents, including images/media, so a watched SVG cannot execute at the app origin through direct navigation. Other fallback requests SHALL resolve against permitted files under watched roots, enforcing built-in exclusions, explicit Uatu excludes, and realpath containment. Git-ignore browsing visibility SHALL not deny permitted authenticated static delivery. Authored rendered src/href references SHALL remain unchanged in server HTML and resolve through the per-document base. Mounted watched images SHALL retain revision query parameters for cache invalidation; static path resolution SHALL ignore that query string. External or non-watched image URLs SHALL remain unchanged. Traversal, malformed encoding, and symlink escapes SHALL fail without serving outside contents. The dedicated media route SHALL retain its own indexed-identity/range contract and SHALL not depend on this fallback's Accept negotiation.

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
In a watched root inside a Git working tree, a folder that Git ignores as a whole SHALL be indexed as a folder entry without reading its contents during discovery or recovery. A folder that contains tracked files, or files that Git does not ignore, is not ignored as a whole and SHALL be discovered normally. A client SHALL be able to request the listing of one level of such a folder. The listing SHALL return that level's permitted files with their metadata and its subfolders. Subfolders inside an ignored folder SHALL be folder entries listed on demand in turn. A listed level SHALL become part of the shared index for the rest of the session, and later changes in that level SHALL be published to every client. Listing SHALL apply built-in and explicit exclusions and realpath containment. Listing a level that no longer exists SHALL remove the folder entry. Changes to Git ignore sources SHALL reconcile folder entries and listed levels without a session restart. In a watched root outside any Git working tree, no folder SHALL be treated as ignored and discovery SHALL be complete.

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
A file created or written inside a Git-ignored folder level that has not been listed SHALL be indexed when the write is observed, so it appears in Recent and type filters without its folder being listed. Per watched root, the system SHALL retain at most the 2,000 most recently written such files. When a newer write would exceed that bound, the oldest retained file SHALL leave the index unless it is pinned. A file SHALL become pinned for the rest of the session once any client has requested its document, static, or media content. A file that leaves the index this way SHALL become available again when its folder level is listed. Removals inside unlisted ignored folders SHALL remove any retained entry. Writes inside listed levels SHALL NOT count toward the window.

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
Updates for files inside Git-ignored folders, whether listed or captured by the live-write window, SHALL be published separately from other updates. Creations, writes, and removals SHALL be coalesced by path, so a path that changes several times before publication is published once in its latest state, and a path created and removed before publication is not published. These entries SHALL be published with ignored status and SHALL NOT be followed by a separate classification update. Publication SHALL be scheduled no sooner than one second after the first queued event and no later than five seconds after it, including under sustained churn. Each publication SHALL carry at most 1,024 entries per patch, with remaining entries following in subsequent patches without waiting for another interval. These updates SHALL NOT produce Follow-candidate updates. An open ignored file SHALL still refresh after its revision is published, under the existing active-file and media rules.

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
