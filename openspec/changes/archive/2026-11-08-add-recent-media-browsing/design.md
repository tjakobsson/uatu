## Context

See `proposal.md` for motivation and the four delivery phases. This is a cross-cutting change, so a design artifact is required.

- `DocumentMeta` already carries `mtimeMs`, root/path identity, classification, and a change revision. The event-fed index supplies updates without rescanning for ordinary writes.
- `src/sidebar/tree-view.ts` mounts one Pierre tree with colored standard icons. Git-status annotations already reach `setGitStatus`. The installed library also supports filename search, sticky folders, and text/icon row decorations. Decorations do not provide arbitrary interactive buttons.
- The Files header currently renders All/Changed and a total/binary breakdown. `filesFilter` is Hub-backed personal workspace state.
- Ignore rules currently control discovery, watcher coverage, and serving together. Gitignored files and built-in build/dist folders can disappear before a client has any opportunity to display them.
- Images bypass `/api/document` and use file HTTP responses. The Hub proxies binary bodies with backpressure and downstream cancellation. Its compressible-body path buffers eligible content, so media must be explicitly excluded.
- Read-only probes on the installed Bun 1.4.0 showed single and suffix ranges working through the existing static handler and Hub proxy, plus 416 for unsatisfiable ranges. Some automatically generated length/HEAD headers varied in those probes. The package declares Bun 1.4.4, so the implementation must establish and test a contract on the supported runtime instead of relying on this observation alone.
- Bun 1.4.4 verification confirmed that larger custom streams lose supplied Content-Length at Bun.serve's response boundary and errored bodies can leave HTTP readers pending. Small responses can infer a length and are not sufficient proof. The user approved a narrow node:http response-writing boundary at the child and Hub listeners; the byte/range/revision/cancellation contract remains unchanged.

## Goals / Non-Goals

**Goals**

- Deliver the first phase using existing file metadata and client presentation, with no media-server dependency.
- Keep one authoritative file inventory, one Pierre tree instance, and one page-local playback owner.
- Separate preview selection, Files presentation, and the actively auditioned clip so they can change independently.
- Preserve workspace/base-path identity and bounded work throughout discovery, live updates, rendering, and delivery.

**Non-goals**

- No waveform analysis, eager thumbnail pipeline, codec conversion, editing timeline, synchronized multi-track playback, or automatic playlist advancement.
- No media bytes in live events, document JSON, or personal-state records.
- No guarantee of uninterrupted playback while the OS suspends the PWA, across full-page/workspace navigation, or after the underlying file is rewritten in place.
- No general filesystem mutation UI, wholesale tree replacement, or standalone media service.
- Sticky folders, compact folders, and general context-menu expansion are separate optional work, not additional tasks in this change.

## Decisions

### 1. Add Recent to the existing Files view control

Extend `filesFilter` to `all | recent | changed`, preserving existing saved values and defaulting an absent value to All. Recent is a flat list over the same allowed, scoped inventory. It is not a second tree instance. Keep the existing tree mounted while switching presentation, with its expansion state intact; pause its hidden presentation work where possible.

Order Recent by descending `mtimeMs`, then normalized root-relative path and root identity for deterministic ties. Equal-mtime file revisions still invalidate content, but do not invent a newer disk-write timestamp. Future timestamps display as `now`, with the exact stored time available in details. A file's commit time or time opened never affects this ordering.

Recent has no arbitrary time cutoff: all matching known files remain browsable using a windowed list. Build the ordered projection from the snapshot once and update affected entries from file patches. Reuse existing metadata without Git calls or content reads. A low-frequency visible-row age update refreshes labels only.

While a pointer/touch activation is in progress, retain the presented row-to-file mapping. Queue structural changes until that activation ends, then reconcile with a scroll anchor and file-keyed focus. Preserve the anchor when the reader is below the top; do not jump them to the newest row. At the top, settled updates can appear immediately. Never interpret reordering as selection or playback.

Alternative: sorting the hierarchy newest-first still leaves exports inside closed folders and makes tree targets move. Keep the tree's alphabetical layout, with quiet recent-write ages for files written within the last 24 hours and a latest-write icon for the most recent matching entry. Use Pierre's public decoration API, without a competing row DOM.

### 2. Simplify counts and add a lightweight name filter

The Files header shows a single muted number with an accessible label such as `128 files`. It counts the current view's eligible file entries, including entries outside the rendered viewport, not expanded folders or mounted DOM nodes. Changed includes its existing temporary active-file inclusion. Drop the binary breakdown, hidden counts, and N-of-M wording. Index progress/error/retry remains independently visible.

A filename/path query filters metadata, not file contents. Use Pierre's built-in search for the hierarchical views and equivalent name/path matching in Recent; use shared matching rules so switching views retains the query. Do not bind this to the project-content-search shortcut. In phase 4 add an orthogonal All types/Audio/Video filter, tucked into Files options when narrow. Its initial value is All types and it is runtime client state, not another persisted preference.

### 3. Separate Git visibility from permitted file exposure

Index and observe the otherwise permitted Gitignored superset once. Carry a per-file ignored indication in snapshots and patches, independent of delayed repository facts. Resolve Git's standard ignore semantics, including nested rules, repository-local excludes, global excludes, and tracked files that match ignore patterns. Batch/cache that work; Git failures produce unknown status rather than a false clean/ignored claim. Ordinary content delivery must not wait for a repository-wide refresh.

`showIgnored` filters the current client's tree, Recent, metadata search, and Follow candidates. It does not alter the shared watcher or prevent an authenticated direct request for an otherwise permitted file. This is an intentional compatibility change. Explicit `.uatu.json ignore.exclude`, mandatory denied names/secret rules, and root containment remain exposure rules.

Default resolution is: saved personal `showIgnored`, then explicit `--no-gitignore` as show, otherwise hide if any currently watched directory root explicitly configures `ignore.respectGitignore: true`, otherwise show. The aggregate is independent of root order; explicit false, omitted, and invalid values do not override another root's explicit true. Recompute it after root/policy recovery without rejecting conflicting legacy defaults. Once selected, a user's saved preference wins on future boots. Document the legacy settings as initial-visibility defaults, not exposure controls. Existing negations used to reveal individual ignored files while hiding others continue as visibility exceptions; an explicit positive Uatu exclusion still prevents exposure.

Follow nomination cannot rely on one shared candidate if clients differ in visibility. Select or recover the newest eligible document/image within each client's context, through the existing brokered document topic. Toggling visibility does not itself turn Follow on, navigate, stop playback, or clear a preview; an explicitly open hidden entry stays open without being reinserted into filtered results. Audio/video do not become automatic Follow targets.

Carry `showIgnored` as explicit request/subscription context where Follow nomination needs it, and include it in the Hub broker's document-context identity. Supply the allowed inventory superset to each client so local visibility changes remain cheap; context-specific nomination can change without a filesystem crawl or a new browser live connection. Metadata-only Git-ignore updates must not be reinterpreted as fresh disk writes or Follow events. Keep project content-search behavior aligned with that client's ignored visibility without adding it to the filename-search transport.

Alternative: client-specific watcher reconstruction or reindexing on every toggle is slower and changes other clients. Treat visibility as presentation, and make true exposure exclusions explicit.

### 4. Permit narrow output folders below build/dist

Add `ignore.include` to the root `.uatu.json` as an array of literal root-relative directory paths, for example `build/renders` or `dist/previews`. Each path opens only the named output subtree, plus traversal of its ancestors. It overrides the soft built-in build/dist exclusion on that route, but not explicit positive Uatu excludes or any other mandatory denied directory/file rule. Reject absolute, parent-traversing, malformed, or non-directory include values with the existing config-warning mechanism. Missing directories are valid future output locations.

Apply the same resolved policy to discovery, observation, index membership, direct/static access, and media delivery. A policy edit uses existing explicit recovery to discover newly included output and repair watch coverage. Ordinary renders remain incremental. This bounded escape is preferable to traversing every dependency/cache/build directory by default.

### 5. Introduce a dedicated indexed-media HTTP route

Declare `GET` and `HEAD` for `/api/media` in the shared route table. Identify the file using root identity plus an encoded root-relative path, and bind the request to the current session epoch/file revision. Construct browser URLs through `appUrl()`. Resolve only indexed, permitted media, recheck realpath containment/current policy, and retain Hub authentication and child credential brokering. This avoids ambiguous duplicate relative paths across watched roots and the navigation fallback's Accept negotiation.

Return exact MIME and byte-length information. Support one explicit, open-ended, or suffix byte range with 206 and Content-Range, 416 with `bytes */size` for unsatisfiable ranges, and a bodyless HEAD. Ignore malformed or multiple ranges and return the normal full 200 representation. Do not implement multipart ranges in this change. Do not compress or transform media. Validators must describe the selected representation; do not advertise a stat-derived value as a strong content hash.

Use file-backed bodies or bounded slices rather than reading a whole file into memory. The Hub must preserve range/status/length headers and cancellation, with bounded buffering independent of file size. Document and test this internal HTTP contract and explicitly classify GET/HEAD in machine-checkable route exclusions. Do not publish the child media operations in OpenAPI or expand the public Hub API; only public personal-state/live-payload changes update their existing published schemas/revisions. Keep the legacy static path for authored images/files; do not add audio/video HTML embedding to document sanitization in this change.

At both listeners, adapt media responses through a shared narrow node:http response-writing boundary. It must invoke the same product route and authenticated Hub dispatch, forward status/HEAD/body headers exactly, await write/drain backpressure, and destroy/cancel obsolete transfers on abort or stream failure. Preserve the existing browser origin/port, base paths, cookie/Origin validation and child-token brokering. Child listeners and any internal Bun listener remain loopback-only. Normal HTTP, early-flushed SSE, WebSocket/terminal upgrades, TLS configuration, client-IP/rate-limit context, readiness, and graceful/forced shutdown must retain their existing behavior; caller-supplied headers must not become trusted forwarding metadata. Keep the literal Bun HTMLBundle assembly needed for source and compiled asset serving. Source, E2E, and compiled paths share this actual product boundary rather than a test-only transport implementation.

On every new range request, reject a stale epoch/revision with 409 and `no-store`, rather than serving the latest bytes under an old revision URL. Also compare the opened file's metadata with the indexed revision before delivering. An already streaming response cannot promise immutable bytes if another process writes the same inode; on an observed replacement, abort outstanding delivery for that media revision. This is detection-based freshness, not a filesystem snapshot guarantee. The UI must not promise seamless old-revision playback.

Alternative: browser fetch-to-Blob needs the whole clip and defeats range seeking. A separate origin/port adds deployment and credential work while still sharing network bandwidth. Independent same-origin media responses are enough; HTTP/2 may share a physical connection.

### 6. Keep one playback owner outside preview mounts

Create `src/media/` as a coherent feature. A page-local controller owns the active file/revision, media element, playback position, loop choice, request generation, and audition ordering. Preview and the mini-player are presentations of that owner. Reparent the same video element when enlarging it rather than mounting two decoders that can both play.

Use browser-native audio/video decoding and controls where available. Initial recognized audio extensions are mp3, wav, ogg/oga, flac, aac, m4a, and opus; video candidates are mp4/m4v, webm, mov, ogv, avi, mkv, and flv. Extension recognition is not a codec-support promise. Unsupported/decode/load states retain the filename and an allowed download action. Selecting a media filename opens a paused preview; direct links, history, restore, discovery, and file events never autoplay.

Quick Play in Recent is a separate action from selecting the filename. It retains the current preview/URL and Files tab, disables Follow as an explicit audition action, and starts the clip in the same user gesture. For hierarchical views, use the tree's public action-menu mechanism for Play/Open preview; do not inject interactive buttons into its text/icon decoration lane.

Capture the ordered eligible media IDs from the current view/query/type filter when audition starts. Previous/Next traverse that session order without wrapping, skipping entries removed or no longer permitted. New renders and later view/filter changes do not silently change the session order; pressing another row's Play captures a new order. Each new clip starts at zero and stops/releases the previous one. Loop affects only the current clip. End-of-clip does not advance automatically. User/browser playback refusal is reported without retrying autoplay.

Only the active media source is mounted or fetched; listing rows does not preload media. Load its metadata lazily, show duration when available, and avoid server-side waveform or thumbnail generation. Full Preview, Files browsing, Chat, and Terminal use the same player session. Close releases the source and aborts pending requests. Reload/page/workspace navigation ends the session and never restores active playback automatically.

If another clip is auditioning, opening a different media filename shows that preview's identity and a paused Play affordance without mounting another source. Pressing its Play explicitly replaces the audition. Returning to a preview for the already active clip presents the existing session without resetting or pausing it; the no-autoplay rule means navigation cannot initiate playback, not that it must interrupt playback already requested by the user.

### 7. Make new revisions explicit

An unrelated file/chat update leaves the player element and time unchanged. When the active media's revision changes, mark New render available, stop pending old-revision delivery, and keep the current surface stable. Already buffered playback can continue only while the browser can do so without further old-revision requests; otherwise pause with the update notice. Disable Loop into a stale revision. Reload switches to the newest indexed revision at zero and leaves it paused until Play. In-flight callbacks are generation/file/revision checked.

A recent write is not proof a renderer finished. Partially written or undecodable files remain listed with their true disk time and a retry/reload affordance. Do not infer completion from mtime, auto-play on a settling timer, or indefinitely retry decoding while a producer writes. Atomic producer replacement works through normal revision invalidation.

### 8. Accommodate the mini-player in existing viewport ownership

In touch mode the mini-player sits above the four existing surface tabs, with safe-area padding applied once. Its measured height participates in the existing viewport/terminal/chat sizing so it does not cover the last file row, composer, or terminal controls. Video can expand in place or request fullscreen. No fifth tab is added. Desktop uses a compact dock with the same controls and ownership. Mode switches preserve the session and position.

## Risks / Trade-offs

- Indexing permitted ignored files increases discovery volume. Mitigate with the existing bounded observer/index, retained dependency/cache exclusions, and no corpus-sized live messages for ordinary edits.
- File writes can arrive during touches and keyboard use. Key rows by file identity, defer structural reconciliation during activation, preserve anchors, and test the actual activated file rather than only screenshots.
- Ignored-status computation can be slower than file metadata. Keep unknown distinct, batch/cache policy work, and update annotations independently without delaying ordinary previews.
- In-place writers can invalidate active media. Abort detected stale delivery and offer explicit Reload; do not cache whole exports to simulate immutable history.
- Mobile codec/fullscreen/autoplay behavior varies. Test browser-supported fixture codecs in Chromium/WebKit and record physical iOS/PWA acceptance separately.
- A persistent video dock consumes scarce height. Measure it through existing layout owners and support explicit Close and expansion.
- Native row decorations are inexpensive, but interactive tree actions require the public action-menu integration. Keep direct one-tap audition in the application-owned flat list.

## Migration Plan

1. Deliver Recent, name filtering, recency labels, and the quiet count first. Extend the validated Files enum and API contract while continuing to read `all`/`changed` records.
2. Deliver the ignored-file superset and `showIgnored`, document the changed default and legacy-setting semantics, then add narrow output includes. Do not rewrite a project's `.gitignore` or `.uatu.json` automatically.
3. Deliver and contract-test internal media HTTP delivery, including explicit route exclusions and the compiled server and Hub path, before the UI relies on it.
4. Deliver native previews, audition controls, and mobile layout, then verify the complete workflow using ignored audio/video fixtures.
5. Keep phase boundaries independently reviewable. Rolling back client UI requires readers to tolerate absent/unknown new personal fields with defaults; a full server rollback restores old Git-ignore exposure semantics and removes the new media endpoint. Do not rely on new include paths remaining accessible on older servers.
