## 1. Shared update contracts

- [x] 1.1 Define snapshot/patch DTOs with session epoch, predecessor/state revisions, per-file revisions, discovery status, repository freshness, and root-qualified mutations; verify serialization and invalid-predecessor cases in shared contract tests.
- [x] 1.2 Implement the shared keyed state reducer and on-demand snapshot materialization; verify ordered upserts/removals, duplicate and stale input rejection, independent repository merges, and equivalence between a materialized snapshot and applying the same batches.
- [x] 1.3 Define context projection and corpus-version behavior, including empty revision advances and invalid file-scope normalization; verify two scopes and both comparison targets cannot diverge or expose out-of-scope file entries.

## 2. Event-fed indexing and watch coverage

- [x] 2.1 Consolidate watcher/index acceptance; implement the approved native recursive observer with bounded discovery and Chokidar polling/unsupported-platform fallback, supplied stats, atomic-save normalization, and no symlink following; verify directory-only excludes, hard denials, hidden counts, root policy-file observation, single-file roots, and overlapping roots with focused tests.
- [x] 2.2 Add the index owner with path maps, directory membership, initial discovery status, bounded unknown-type classification, requested-path priority, and newest-eligible metadata; verify initial events build the inventory without an application rescan or duplicate stats and preserve text/binary classification.
- [x] 2.3 Replace the one-path debounce with all-path batching, latest eligible Follow selection, per-path generation guards, and bounded retries; verify multi-file bursts, trailing binary/directory events, late classification after deletion, and the two-second scheduling bound under continuous input.
- [x] 2.4 Wire incremental file publication into the watch session and remove routine full scans, corpus hashing, and the five-second document reconciliation timer; verify ordinary edits and idle clock advances perform no full index traversal or unrelated file classification.
- [x] 2.5 Add coalesced affected-root recovery for policy edits, uncertain watch coverage, and explicit rebuild, including staged replacement and shutdown guards; verify unignored subtrees receive future events, failed recovery preserves coherent state, and obsolete watchers cannot publish.

## 3. Independent repository and file-facts work

- [x] 3.1 Extract repository refresh scheduling with independent freshness/generation state and one pending follow-up pass; verify blocked or failing Git does not block file publication and late repository completion cannot restore old roots or replay Follow.
- [x] 3.2 Share repository metadata, history, and ignore checks across comparison targets, target ignore queries to indexed paths, and bound/reuse untracked-file line counts; verify both comparison results remain equivalent while counters show common work is performed once.
- [x] 3.3 Add demand-aware Git metadata probes and explicit repository-view refresh triggers, including linked-worktree Git/common directories and visible-pane refresh for changes outside watched roots; verify metadata-only commits/staging update without document rescans and idle consumers release timers.
- [x] 3.4 Split filesystem facts from Git provenance, add the allowed-document provenance route through `buildRoutes`, and deduplicate revision-bound enrichment requests; verify `/api/document` completes while Git is held and non-Git, uncommitted, error, and stale-revision responses follow the facts contract.

## 4. Hub delivery and browser state

- [x] 4.1 Update the child event source and Hub document broker to fold patches, fan out bounded updates, and materialize current snapshots for joiners/behind subscribers; verify late join, reconnect, at-head cursor, predecessor gap, and child-epoch restart in broker tests.
- [x] 4.2 Update browser state adoption and document-topic reduction to use revisions and apply file/repository/progress updates independently; verify HTTP snapshot/live-frame races, resync isolation, and independent selection in two clients.
- [x] 4.3 Update sidebar/index access to avoid path reconciliation on content-only edits and use incremental add/remove on membership changes, permitting the tree library's internal visible-row recalculation; verify application mutation counts, no full path resets, programmatic-selection guards, filters, corpus versions, and path-specific search invalidation.

## 5. Progressive workspace opening

- [x] 5.1 Start HTTP and emit the existing readiness URL before background discovery or repository completion, retaining all preflight checks; verify the shell, state endpoint, and live stream respond while discovery/Git are held and piped stdout remains URL-only.
- [x] 5.2 Add indexing, recovery, and failure presentation and expose explicit index recovery through existing workspace recovery UI; verify discovered entries are usable, incomplete inventory is not shown as an empty workspace, and terminal/navigation controls remain responsive.
- [x] 5.3 Support policy-checked targeted document resolution during discovery and retain requested/restored scopes and destinations; verify direct links return the SPA shell, hidden/escaping paths remain denied, and later discovery cannot duplicate or replace manual selection.
- [x] 5.4 Apply the newest eligible startup default once discovery completes only if no newer selection intent exists; verify no per-file preview churn, Follow catch-up during discovery, a real startup edit, deliberate emptiness, and saved selection restoration.
- [x] 5.5 Coordinate cancellation of HTTP startup, discovery/classification, watch replacement, and timers; verify stopping a child during each phase releases resources and late callbacks cannot publish.

## 6. Fresh preview behavior

- [x] 6.1 Invalidate all affected preview representations before applying batch selection and reload a changed current destination regardless of Follow; verify A-then-B bursts with A open, already-selected Follow targets, directory/deletion events, unavailable destinations, and classification changes.
- [x] 6.2 Bind preview/cache writes, split-pane fetches, and image loads to the current file revision and selection guard, with fresh document requests and revision-aware image URLs; verify late responses and switching Source/Rendered/Diff/split cannot restore old bytes after a save.
- [x] 6.3 Enrich the facts strip asynchronously with matching Git facts and honest pending/stale/unavailable states; verify a stalled lookup leaves fresh content visible, obsolete results cannot overwrite newer facts, and the existing update signal and reduced-motion behavior remain correct.
- [x] 6.4 Revalidate the active preview from reconnect snapshots and new epochs while keeping historical commit views historical; verify missed active-file changes, unchanged mtimes, image replacement, preserved URL/focus/active surface, and no reload for unrelated repository updates.

## 7. Integration and resource verification

- [x] 7.1 Add real Bun native-observer and Chokidar-fallback integration coverage for atomic saves, continuous chunked writes, delete/recreate, directory removal, and ignore-rule reversal; verify progress during writes and convergence to final content without fixed-delay assertions.
- [x] 7.2 Add deterministic 1,000-file and 10,000-file work-count cases for discovery, idle periods, and one-file edits; verify no duplicate application crawl/stat, bounded classification concurrency, no normal full scans, bounded update size, and no application full path reset; report the permitted library-internal projection cost for creates/deletes separately.
- [x] 7.3 Add focused browser startup/follow/freshness coverage and an `@perf` case with blocked discovery/Git and operation counters; verify large-workspace usability, stale-cache rejection, late join/resume, and two-client isolation, saving evidence through the existing E2E evidence helper.
- [x] 7.4 Update shared API/build revisions, OpenAPI, route coverage, fixtures, and affected generated-client contracts for document updates and provenance; verify `bun run api:validate`, `bun run test:api`, and any required Swift contract generation check for changed models.
- [x] 7.5 Run `bun run typecheck`, `bun run test:ci`, the affected non-perf Playwright feature files, and the new targeted `@perf` coverage; verify all checks pass and record startup/work-count evidence without requiring machine-specific tight timing thresholds.

## 8. Documentation and cleanup

- [x] 8.1 Update `ARCHITECTURE.md` and relevant agent guidance for event-fed indexing, readiness, repository ownership, and explicit recovery; verify documented module ownership and lifecycle match the implemented paths.
- [x] 8.2 Remove obsolete live-scan refresh paths and adjust diagnostic counters/tests for the new owners while retaining useful watchdog data; verify no healthy-session timer reaches a full document scan and diagnostics still identify watcher, index, repository, and recovery activity.
- [x] 8.3 Reconcile the change checklist and validate the completed delta artifacts with `openspec validate simplify-file-watch-updates --strict`; verify every requirement has implementation or test evidence before the later archive workflow.
