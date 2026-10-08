## 1. Git metadata observer

- [ ] 1.1 Add `src/server/git-observer.ts`. It resolves the watched directories for a watch entry: the worktree Git directory, the shared Git directory, the current branch's ref directory, the compare base's remote ref directory, and `reftable/` when that backend is in use. It opens one non-recursive `fs.watch` per directory and drops `.lock`, watchman-cookie and `objects/` events. Verify with unit tests on real temporary repositories that a commit, a new branch checkout, `git fetch` from a local remote, `git pack-refs --all` and `git add` each emit a trigger, and that `git status` and a lock-file create and delete emit none.
- [ ] 1.2 Share handles between watch entries in the same repository, release them when the last consumer leaves, and re-resolve the path set when a collection reports a different branch, `HEAD` symref or compare-base ref. Verify that two entries in one repository open each directory once, that a branch switch moves the branch-ref watch, and that no handle remains after release.
- [ ] 1.3 Cover linked worktrees. Verify that a commit made in a linked worktree, whose branch ref lives in the shared Git directory, triggers the session watching that worktree.

## 2. Repository refresh wiring and pacing

- [ ] 2.1 Make `createRepositoryRefresh` take its Git-only triggers from the observer while demanded, and keep the stat-fingerprint probe only as the fallback for polling mode, a watch-open failure, or a later watcher error. Fall back once per demand period, with one diagnostic. Verify that no interval timer exists while native observation is healthy, that `usePolling` and an injected watcher error both start the probe, and that `demand(false)` releases both paths.
- [ ] 2.2 Add `MIN_COLLECTION_GAP_MS` (2000), measured between collection starts, on top of the existing debounce and the one-in-flight-plus-one-follow-up coalescing. Verify with a controllable clock that the first trigger after a quiet period collects within the debounce, that sustained triggers start collections no closer than the gap, and that a final collection follows the last trigger.
- [ ] 2.3 Replace the `reconcile.ticks_total` metric with Git-observer counters (`git_observer.events_total`, `git_observer.fallback_total`) in `watch-session.ts`. Verify by asserting the counters in an existing watch-session test.

## 3. Commit time on the wire

- [ ] 3.1 Add `%ct` to `collectCommitLog` and `committedAtMs: number | null` to `CommitLogEntry`, keeping `relativeTime`. Verify in `git-data.test.ts` that entries carry the commit's epoch milliseconds, and in `repository-refresh.test.ts` that two collections differing only in `relativeTime` stay the same generation.
- [ ] 3.2 Document the field in `api/openapi.yaml`, the SSE and state examples, and `api/CHANGELOG.md`, then run the API validation and compatibility check (`scripts/validate-api.ts` and the contract tests). Verify that they pass, and bump the workspace API revision only if the compatibility check reports the change as breaking.

## 4. Client-side commit ages

- [ ] 4.1 Move `formatRelativeTime` from `src/preview/file-facts-strip.ts` to `src/shared/relative-time.ts`, with a short form (the facts strip, unchanged output) and a long form (Git Log and commit preview, matching Git's `%cr` wording and thresholds). Verify with unit tests at each threshold boundary and through the unchanged facts-strip tests.
- [ ] 4.2 Render Git Log rows and the commit preview from `committedAtMs`, falling back to `relativeTime` when it is absent, and mark each age's text node for in-place updates. Verify in an e2e test that a commit row and the commit preview show the formatted age.
- [ ] 4.3 Add one client ticker that rewrites the marked age text nodes: every 30 s while any visible age is under an hour old, otherwise every 5 minutes, paused while the document is hidden. Verify in an e2e test with Playwright's clock that a row's age advances without any request to the server and without rebuilding the row (the same element stays focused).

## 5. Diff refresh only on relevant repository changes

- [ ] 5.1 Build the diff-input key (`HEAD`, compare base and target, and the active file's `changedFiles` entry) and use it in place of the repository generation in `diffRevisionKey` and the diff cache key. Remove the wholesale `documentDiffCache.clear()` on repository changes in `src/shell/events.ts`. Verify with unit tests that the key changes for a `HEAD` move, a base move, and a change to the file's own entry, and stays the same for another file's change.
- [ ] 5.2 Re-fetch the active diff after a repository update only when its key changed. Verify in an e2e test that, with Diff active for file A, an edit to file B causes no diff request and no loading indicator, and that a commit causes exactly one re-fetch.

## 6. Documentation

- [ ] 6.1 Update the repository-refresh section of `ARCHITECTURE.md` (event-driven Git observation, fallback probe, pacing, quiet refreshes, client-side ages, diff relevance) and the `CLAUDE.md` folder-map entry for `repository-refresh`. Verify that both name the observer and no longer describe a 5-second probe as the primary path.
