## 1. Git metadata observer

- [x] 1.1 Add `src/server/git-observer.ts`. It resolves the watched directories for a watch entry: the worktree Git directory, the shared Git directory, the current branch's ref directory, the compare base's remote ref directory, and `reftable/` when that backend is in use. It opens one non-recursive `fs.watch` per directory and drops `.lock`, watchman-cookie and `objects/` events. Verify with unit tests on real temporary repositories that a commit, a new branch checkout, `git fetch` from a local remote, `git pack-refs --all` and `git add` each emit a trigger, and that `git status` and a lock-file create and delete emit none.
- [x] 1.2 Share handles between watch entries in the same repository, release them when the last consumer leaves, and re-resolve the path set when a `HEAD` symref moves (branch switch or a new `origin/HEAD`) or a candidate directory was missing. Verify that two entries in one repository open each directory once, that a branch switch moves the branch-ref watch, and that no handle remains after release.
- [x] 1.3 Cover linked worktrees. Verify that a commit made in a linked worktree, whose branch ref lives in the shared Git directory, triggers the session watching that worktree.

- [x] 1.4 For a watch entry narrower than its repository (or a single file), add one recursive watch on the repository top level, shared by narrow entries in that repository. Drop events under `.git`, inside the watched root, or matched by the top-level `.gitignore`. Verify with real repositories that an edit to a tracked file outside a narrow root triggers, that an ignored path and an edit inside the root do not, and that a whole-repository root opens no tree watch.

## 2. Repository refresh wiring and pacing

- [x] 2.1 Make `createRepositoryRefresh` take its Git-only triggers from the observer while demanded, and keep the stat-fingerprint probe only as the fallback for polling mode, a watch-open failure, or a later watcher error. Fall back once per demand period, with one diagnostic. Verify that no interval timer exists while native observation is healthy, that `usePolling` and an injected watcher error both start the probe, and that `demand(false)` releases both paths.
- [x] 2.2 Add `MIN_COLLECTION_GAP_MS` (2000), measured between collection starts, on top of the existing debounce and the one-in-flight-plus-one-follow-up coalescing. Verify with a controllable clock that the first trigger after a quiet period collects within the debounce, that sustained triggers start collections no closer than the gap, and that a final collection follows the last trigger.
- [x] 2.3 Replace the `reconcile.ticks_total` metric with Git-observer counters (`git_observer.events_total`, `git_observer.fallback_total`) in `watch-session.ts`. Verify in a watch-session test that a subscribed session on a real repository counts observer events, no fallback and no `reconcile.ticks_total`.

- [x] 2.4 Remove the browser's 5-second `/api/repositories/refresh` timer from `src/shell/events.ts`, keeping the route. In the polling fallback, make each tick request a collection when any entry is narrow. Verify in a unit test that a narrow root's fallback tick collects while a whole-repository root's tick only stats, and through 4.3's e2e test that a page with the Git Log open sends no repository refresh requests.

## 3. Commit time on the wire

- [x] 3.1 Add `%ct` to `collectCommitLog` and `committedAtMs: number | null` to `CommitLogEntry`, keeping `relativeTime`. Verify in `git-data.test.ts` that entries carry the commit's epoch milliseconds, and in `repository-refresh.test.ts` that two collections differing only in `relativeTime` stay the same generation.
- [x] 3.2 Document the field in `api/openapi.yaml`, the SSE and state examples, and `api/CHANGELOG.md`, then run the API validation and compatibility check (`scripts/validate-api.ts` and the contract tests). Verify that they pass, and bump the workspace API revision only if the compatibility check reports the change as breaking.

## 4. Client-side commit ages

- [x] 4.1 Move `formatRelativeTime` from `src/preview/file-facts-strip.ts` to `src/shared/relative-time.ts`, with a short form (the facts strip, unchanged output) and a long form (Git Log and commit preview, matching Git's `%cr` wording and thresholds). Verify with unit tests at each threshold boundary and through the unchanged facts-strip tests.
- [x] 4.2 Render Git Log rows and the commit preview from `committedAtMs`, falling back to `relativeTime` when it is absent, and mark each age's text node for in-place updates. Verify in an e2e test that a commit row and the commit preview show the formatted age.
- [x] 4.3 Add one client ticker that rewrites the marked age text nodes: every 30 s while any visible age is under an hour old, otherwise every 5 minutes, paused while the document is hidden. Verify in an e2e test with Playwright's clock that a row's age advances without any request to the server and without rebuilding the row (the same element stays focused).

## 5. Diff refresh only on relevant repository changes

- [x] 5.1 Build the diff-input key (`HEAD`, compare base and target, and the active file's `changedFiles` path, status and rename source) and use it in place of the repository generation in `diffRevisionKey` and the diff cache key. Remove the wholesale `documentDiffCache.clear()` on repository changes in `src/shell/events.ts`. Verify with unit tests that the key changes for a `HEAD` move, a base move, and a change to the file's own entry, and stays the same for another file's change.
- [x] 5.2 Re-fetch the active diff after a repository update only when its key changed. Verify in an e2e test that, with Diff active for file A, an edit to file B causes no diff request and no loading indicator, and that a commit causes exactly one re-fetch.

## 6. Documentation

- [x] 6.1 Update the repository-refresh section of `ARCHITECTURE.md` (event-driven Git observation, fallback probe, pacing, quiet refreshes, client-side ages, diff relevance) and the `CLAUDE.md` folder-map entry for `repository-refresh`. Verify that both name the observer and no longer describe a 5-second probe as the primary path.
