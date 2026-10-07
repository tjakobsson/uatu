## Context

See `proposal.md` for the motivation and delta specs for the behavior contract. This is a cross-cutting performance and state-protocol change, so a design is required.

The current `createWatchSession` waits for Chokidar readiness, calls `scanRoots`, then collects both Git comparison snapshots. `src/cli.ts` starts HTTP afterward. Every refresh repeats the scan and Git work; a five-second timer requests the same refresh while idle. The scheduler remembers one changed path, while clients infer other changes from full snapshots and mtimes. The Hub retains the last document frame because every frame is currently a snapshot.

There is a second Git dependency on the preview path: `renderDocument` awaits `collectFileFacts`, which invokes Git log and status. Removing repository collection from the watcher alone cannot satisfy Git-independent preview rendering.

Constraints include independent client scopes, direct-link routing, strict exposure rules, binary/image previews, newest-mtime default selection, the existing one-stream Hub broker, and content freshness after reconnect. The existing `follow-mode` spec owns selection behavior; the Author/Review rules remaining in `document-watch-index` are obsolete.

References: [Chokidar 5 documentation](https://github.com/paulmillr/chokidar/tree/5.0.0#readme), [v5 event implementation](https://github.com/paulmillr/chokidar/blob/5.0.0/src/index.ts), and the installed v5 handler. Initial `add` events include metadata in the ordinary file path; the public API guarantees metadata with `alwaysStat`. `ignoreInitial` suppresses delivery, not traversal. `awaitWriteFinish` adds file-size polling, while `atomic` independently normalizes save-by-rename.

## Goals / Non-Goals

**Goals:**

- Make normal file work proportional to affected paths through indexing, publication, and client reduction, permitting the existing tree library's internal visible-row recalculation on membership changes.
- Give one owner responsibility for the document index and one independent owner responsibility for repository refreshes.
- Use explicit discovery status and revisions instead of treating incomplete inventories, mtimes, or completed Git work as evidence of document freshness.
- Reuse the existing preview loaders, Follow rules, transport, and recovery machinery where they already provide the required behavior.

**Non-Goals:**

- Upgrading the Chokidar fallback, requiring Node or a separate watcher process, adding a database, persisting an index across launches, or introducing another browser stream.
- Removing binary detection, changing ignore semantics to Git's complete nested-ignore behavior, changing Follow preferences, or changing historical commit previews.
- Eliminating the watcher's initial O(N) filesystem work or guaranteeing notification of changes that the underlying filesystem never reports. Explicit recovery handles uncertain coverage; supported unusual filesystems retain the polling option.
- Making a Diff request independent of Git. Its content is inherently Git-derived; it runs independently of ordinary document delivery.

## Decisions

### 1. One event-fed document index

Add a focused server index owner under `src/server/`. It holds a per-root path map, directory membership, newest-eligible selection metadata, per-path change revisions, discovery state, and a small pending-path map. `watch-session.ts` coordinates this owner and publication rather than doing filesystem discovery itself.

Use a native recursive `fs.watch` subscription for each directory root, shared with nested roots where coverage already exists. Staged recovery opens a fresh subscription before releasing the old observer, so it repairs uncertain native coverage as well as rebuilding the index. Single-file roots observe their parent but accept only that file. Subscribe before starting one bounded directory walk; emit normalized initial events with the metadata collected by that walk. Normalize later native events with a stat of the affected path, and inventory only new or changed directories. Existing unchanged directory children do not need reclassification or repeated stats. Root/ignore policy prunes discovery and filters native events; symlinks are not followed.

When recursive observation is unsupported, or polling is explicitly requested, use Chokidar with `ignoreInitial: false`, `alwaysStat: true`, `followSymlinks: false`, `atomic: true`, and `awaitWriteFinish: false`. This fallback still feeds the same index, so it never runs a second application scan. The native observer also delays confirmed removals for 100 ms to normalize atomic replacement. Keep root validation before startup and do not stat again in the index when observation supplied metadata.

Initial `add` and `addDir` events populate the index. Initial adds are discovery, not edits. A `change` to an already known path during startup remains a real edit. An `add` before `ready` cannot reliably be distinguished from a file created during the crawl, so treat it as discovery; default selection after discovery still considers its mtime. Both observation backends expose this same lifecycle.

Known extensions classify synchronously from their names. Unknown extensions retain the existing 8 KB sniff in a bounded worker queue, with active/requested paths prioritized. Publish fully classified entries, and mark discovery ready only after the observer's `ready` and the initial classification/publication queues drain. This preserves current search and binary contracts instead of adding a public `unknown` kind. No repeated content read occurs for unchanged files.

Use one ignore/exposure decision for watch coverage and index acceptance. Pass directory information correctly for directory-only ignore rules. Preserve root-level `.gitignore`, `.uatu.json`, CLI precedence, hardcoded denials, secret filtering, hidden-count meaning, and the exclusion of symlink entries. Deduplicate filtered-entry accounting rather than counting repeated ignore-callback invocations. Policy files must remain observable even if user patterns hide their tree entries.

Alternative rejected: keep `scanRoots` and parallelize it. That would retain duplicate discovery, repeated classification, and two competing inventories. The existing scanner may remain for unrelated one-shot callers or tests, but it leaves the live-session path.

### 2. Path batches replace whole-workspace refreshes

Retain a short trailing debounce of 150 ms and the existing two-second maximum wait, but collect all affected paths. Each path records its latest event order and desired state. Apply upserts and removals in bounded chunks, emitting progress during sustained activity. Directory removal deletes the indexed subtree without reading the rest of the filesystem. Generation checks discard late classification after replacement or deletion; failures retain the previous coherent entry and schedule bounded path-level retry or recovery.

Choose the Follow candidate from the last eligible create/change in event order after classification and removal resolution. Binary and directory events cannot overwrite it. The full invalidation set remains independent of that candidate. Maintain newest-mtime metadata incrementally for Follow catch-up, rather than sorting the full corpus after each event.

Use atomic-save normalization without size-settling polling. The one application batcher coalesces save bursts and allows progress during continuous agent writes. A preview reads current bytes at request time; it may show intermediate text while a writer is active, then converges after the last event. Transient replacement/read errors use the existing bounded load retry. Validate atomic saves, chunked writes, and delete/recreate under native Bun observation and the Chokidar fallback.

Alternative rejected: size polling followed by a second global debounce. It adds delay and can withhold events throughout continuous writes. Path-specific event normalization plus one bounded batcher is sufficient for a live preview, which does not require waiting for a writer to close the file.

### 3. HTTP readiness and inventory readiness are separate

After preflight and route assembly, start HTTP, print the existing ready URL, and allow the Hub to proxy the session while the index discovers files. State includes `indexing`, `ready`, or `error`, discovered counts, and a session epoch. The browser renders the shell and available tree entries in batches. Terminal and navigation setup do not await inventory or Git completion. TTY status transitions to its banner at HTTP readiness; the browser owns ongoing indexing status. Piped stdout remains URL-only.

Preserve requested and restored destinations during incomplete discovery. Direct document navigation uses a bounded, root-contained path resolver that applies the same ignore and exposure policy, classifies that file, and inserts it through the index owner. It must return the SPA shell for allowed document navigation instead of accidentally falling through to raw static bytes. Requested single-file scopes are not widened merely because the background crawler has not found their target yet.

An untouched initial session selects the newest eligible file after discovery. A user action, deliberate deselection, restored destination, or genuine live Follow selection supersedes this pending default. Discovery batches never impersonate edits. Awaited startup work and all pending callbacks have shutdown guards so an interrupted discovery cannot resurrect a stopped session.

Alternative rejected: return an empty snapshot with no readiness distinction. Existing boot, routing, and scope logic would incorrectly treat undiscovered files as absent.

### 4. Snapshots for joining, patches for normal delivery

Define a shared document update family containing a full snapshot and a patch. Each carries the session epoch and an ordered state revision; patches also name their predecessor. File entries carry a change revision that advances on observed edits even if mtime and size are equal. A snapshot preserves those revisions, discovery state, latest eligible edit information, roots, and repository freshness.

A file patch contains root-qualified upserts, removals, affected-file revisions, and an optional eligible Follow target. Repository patches contain repository changes only. Discovery progress is distinct from file-edit intent. Maintain corpus versions incrementally rather than serializing and hashing every entry on each edit. Existing generated timestamps remain informational, not the ordering authority.

Use one serialized publication sequence for file, progress, and repository commits. Project every committed revision into each active document context, including a lightweight revision advance when the visible scope is unchanged. This keeps predecessor checks valid and conveys an unscoped search-corpus version without leaking out-of-scope file content. Scope-normalization changes explicitly reset the relevant subscription using existing client-context handling.

The Hub folds patches into a keyed, context-specific current state and forwards patches to caught-up clients. Materialize a full snapshot only for initial reads, joining/behind clients, or resync; do not rebuild arrays for every patch. Keep the existing Hub cursor as the transport cursor and the epoch/revision as the payload's consistency check. A behind subscriber receives the materialized snapshot at the head cursor, matching today's document catch-up behavior. No unbounded event history is required. Unknown epochs or predecessor gaps resync only the document topic.

The browser applies patches to its keyed index, invalidates only affected search results and preview representations, and advances the global corpus version for widened search. Content-only edits do not reconcile tree paths. Creates/deletes use the library's incremental add/remove methods rather than resetting all paths. Unrelated progress patches must not rebuild the tree, re-render a document, or reapply a Follow target; Git patches update annotations and filter membership only where needed.

Approved implementation adjustment: `@pierre/trees` internally rebuilds its complete visible-row projection on add/remove. A measured addition visited 1,001 rows for 1,000 root-level files and 10,001 rows for 10,000 files. That library-internal work is permitted for membership changes. Keep the current dependency; avoid application-owned whole-corpus rebuilding and full path resets on ordinary file updates.

Alternative rejected: retain full snapshots for every update. That avoids a protocol change but keeps O(N) serialization, network payloads, and client reconciliation for one-file edits. A snapshot plus a patch reducer is the smallest protocol that removes this cost while preserving current reconnect semantics.

### 5. Revision-bound fresh preview loads

On a file batch, invalidate all affected Source, Rendered, split-view, Diff, and image representations before choosing the next selection. Reload the selected file if its revision changed, including when it is already the Follow target. Use event revisions and snapshot revisions, not only one `changedId` or mtime equality.

Extend the existing load guard to bind work and cache writes to the selected destination, view/layout, session epoch, and file revision. That includes background split-pane fetches and Git enrichment. A stale completion cannot repopulate an invalidated cache. Fetch document content with cache bypass/no-store semantics; retain fresh disk reads on the server. Image URLs must include the file revision or otherwise force revalidation so a same-path replacement cannot reuse stale bytes. Follow off preserves unavailable destinations and intentional emptiness under the existing rules. Historical commit views keep their historical semantics.

Reconnect snapshots compare the active file's revision and recover current bytes. A new session epoch forces active-preview revalidation. When observation itself was uncertain, targeted revalidation of the active file accompanies recovery instead of trusting an old client cache.

### 6. Independent, coalesced Git work

Extract repository refresh ownership from document indexing. Start one initial repository refresh in the background, mark it dirty on relevant file batches, and coalesce subsequent requests without blocking file publication. Share repository discovery, metadata, log, and ignore annotation work across both comparison targets; only target-specific calculations should run twice. Use known indexed paths for batched ignore checks rather than enumerating every ignored file beneath large excluded directories. Bound and reuse unchanged untracked-file line counts.

Detect metadata-only changes with lightweight probes of the resolved Git and common directories, HEAD, index, and relevant refs, including linked worktrees. These are targeted filesystem reads, not native content watchers inside `.git`. A five-second metadata-probe cadence while document subscribers are present provides bounded detection without recurring full file-index scans or Git sweeps when metadata is unchanged. Initial subscription/resume and explicit repository-view access request a coalesced authoritative repository refresh. While a repository-dependent pane is visible, a bounded Git-only refresh also covers repository changes outside narrow watched roots. Release demand-driven timers when no consumer needs them.

Repository state has its own generation and pending/stale/error indication. Publish only its fields against the latest document revision. If another dirty signal arrives during collection, retain one subsequent pass and avoid representing the older result as fully fresh. Repository completion never carries a Follow candidate. Existing comparison targets and non-Git fallbacks remain intact.

Split filesystem facts from Git provenance. `/api/document` returns fresh content and filesystem facts immediately. Add a bounded per-document facts request for provenance, validated against the same allowed index and keyed by file revision and repository generation. The client enriches only matching current chrome; it does not rerender the document. Cache/deduplicate matching requests across Source and Rendered loads, cap cache size, and invalidate on file or repository changes. Pending provenance is not labeled clean or uncommitted until confirmed. Diff requests still perform the Git work necessary for their content.

Alternative rejected: merely run repository collection concurrently with the full scan. That still makes publication wait for Git, repeats common work, and leaves per-file Git facts blocking the render response.

### 7. Recovery replaces periodic reconciliation

Remove the five-second document full-refresh timer. Healthy browser reconnects consume the current server snapshot and active-file revisions, not a new scan per client. Retain transport heartbeat, retry, and lifecycle recovery independently of indexing.

Ignore-policy changes, watcher coverage failures, and explicit workspace recovery request a coalesced affected-root rebuild. Rebuild by replacing that root's watcher and collecting its initial events into a staged index, then commit the coherent replacement and queued subsequent changes. During recovery retain the previous inventory with an explicit recovering/error status. Changes to exposure policy take effect immediately in request validation even while inventory recovery is pending. Close obsolete watchers; do not leave both generations observing indefinitely.

Use bounded retry/backoff for coverage failures and surface failure after exhausted automatic attempts. A manual reconnect invokes server recovery only when coverage is uncertain or the user explicitly requests an index rebuild. Do not treat transport loss as evidence that the server missed filesystem events. Coalesce simultaneous recovery requests from multiple clients. Keep config files observable so exclusions can be reversed.

Alternative rejected: delete the timer without a coverage-repair path. Native watching is efficient but not infallible, and changing an ignore predicate alone cannot rediscover a subtree that was never watched.

### 8. Verify work counts as well as visible behavior

Use controlled event sources and counters to assert one discovery inventory, no duplicate application stat when event metadata exists, bounded classification concurrency, zero full scans on ordinary edits or idle ticks, and bounded patch size for one changed path. Compare 1,000-file and 10,000-file fixtures with equal edited-file contents; unrelated file count must not increase the per-edit filesystem/classification work or patch cardinality. Count application tree operations: content-only edits must not reset/reconcile paths, and creates/deletes must use affected-path mutations. Record library-internal visible-row projection costs separately as the approved exception, alongside explicit snapshot/recovery O(N) work.

Block Git and discovery independently in tests to prove readiness and fresh preview delivery do not await them. Exercise the real filesystem for atomic replace, chunked writes, directory removal, unknown binary/text changes, overlapping roots, ignored directories, single-file roots, and root recovery. Validate Hub joining, cursor gaps, child restarts, scope projections, two-client selection independence, and late render/facts completions. Browser evidence covers indexing and errors, direct links before discovery, Follow bursts, active images, and cache invalidation across view switches. Tag browser budget coverage `@perf`; wall-clock timings are evidence or loose guards, not the only pass criterion.

## Risks / Trade-offs

- Protocol change across child, Hub, and browser -> Update shared contracts, OpenAPI, fixtures, and workspace/build compatibility revisions together. An incompatible peer must trigger the existing freshness behavior rather than misapply a patch.
- Initial crawl still costs O(N) and holds native watch resources -> Serve immediately, exclude unwanted trees before traversal, and remove duplicate work. This design does not promise constant-time discovery.
- Unknown-type sniffing remains initial work -> Bound concurrency and prioritize requested paths; retain current classification semantics rather than expanding the public type model.
- Removing size-settling can show intermediate streamed text -> Use one bounded batcher, atomic-save normalization, fresh reads, and generation-safe retry; verify convergence after the final write.
- Native events can be missed without an error -> Provide explicit rebuild and targeted active-file revalidation during recovery; retain opt-in polling for filesystems that need it.
- Git information becomes eventually consistent -> Label pending/stale information, keep the last successful result, and reject late enrichment for newer file or repository revisions.
- Recovery briefly replaces watch coverage -> Stage the replacement, retain intervening events, and prevent callbacks from an obsolete watcher generation from publishing.

## Migration Plan

1. Implement the shared snapshot/patch and readiness contracts with focused reducers and tests, then wire child, Hub, and browser within the same change. Do not ship a partially upgraded protocol.
2. Replace live-session scans with the event-fed index and independent repository owner. Keep one-shot scanning callers only where they remain necessary.
3. Switch startup readiness and preview facts to the new asynchronous paths, update the route table and API documentation, and run the deterministic and end-to-end checks before release.
4. Update `ARCHITECTURE.md` and relevant code guidance for the new owners and recovery rules. Remove obsolete live-refresh code, fixtures, and metrics assumptions as part of implementation.
5. Roll back by reverting the coordinated release and restarting session children. No persistent index or data migration is introduced; runtime revisions and Hub snapshots are rebuilt on restart.

## Approved observation adjustment

The real 10,000-file acceptance case exposed a separate runtime bottleneck. A minimal Chokidar 5 watcher with the planned options, without any Uatu indexing or publication code, discovered about 1,000 files after 2 seconds and 2,000 after 11 seconds under Bun. Its one-second heartbeat was delayed for several seconds during initialization. Both the installed Bun 1.4.0 and this repository's declared Bun 1.4.2 reproduced it. The identical diagnostic under Node 24 discovered all 10,000 files in about 0.6 seconds, including fixture creation.

The original Chokidar-backed 10,000-file browser case also failed to observe a subsequent README edit, while its 1,000-file case delivered a one-entry, roughly 965-byte update with zero tree path mutations. That implementation did not meet the large-workspace acceptance criteria. Chokidar 5.0.0 was the latest npm release during implementation; the upstream main branch's v6 recursive backend was not a released upgrade available for this change.

The user approved native recursive directory watching under Bun, with Chokidar retained for explicit polling and unsupported platforms. This replaces the original decision to use Chokidar 5 as the sole observer. The native adapter passes the 10,000-file acceptance case.

## Verification evidence

- The native browser fixture created and indexed 1,000 files in about 168 ms and 10,000 files in about 1,389 ms in a representative local run. These figures include fixture setup, not just watcher startup, and are evidence rather than machine-specific pass thresholds.
- Editing one existing file emitted one upsert, 965 bytes in the 1,000-file case and 970 bytes in the 10,000-file case, with zero tree path resets, additions, or removals. Deterministic index tests also verify one classification and no unrelated file reads or duplicate stats for the edit.
- Native and polling integration tests cover atomic replacement, equal-mtime edits, new and removed directories, single-file recreation, live progress during continuous writes, overlapping subscriptions, renewed coverage, and ignore-policy recovery.
- Browser cases cover blocked discovery/Git, failed discovery and retry, deferred Follow catch-up, preserved manual intent, late Source/split/provenance responses, fresh image bytes, and Follow catch-up after a connection gap. Evidence is emitted through `tests/e2e/evidence.ts` into Playwright's results and report.
- The full parallel unit run passed 4,913 tests with 15 existing skips. API validation, the 202-test API suite, TypeScript checking, and Swift OpenAPI generation/compilation passed. Affected browser feature suites were checked, with focused reruns confirming corrections to scope retention, filter expansion, and snapshot-aware test synchronization.
- The final focused browser run passed all 12 startup/freshness/performance cases. An additional 48 observer, index, session, and Git-cancellation tests passed under the declared Bun 1.4.2 runtime.
