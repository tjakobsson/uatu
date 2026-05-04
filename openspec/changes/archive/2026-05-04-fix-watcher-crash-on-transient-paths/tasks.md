## 1. Failing regression tests (RED)

- [x] 1.1 In `src/server.test.ts`, add a `describe("createWatchSession ignore predicate", ...)` test group that exercises the chokidar `ignored` predicate built inside `createWatchSession`. Two strategies for getting at the predicate:
  - Preferred: extract the predicate construction into a small exported helper (e.g. `buildWatcherIgnorePredicate(dirRoots, matcherCache)`) and unit-test it directly. Keeps the test surface tight and avoids spinning up a watcher.
  - Fallback if extraction is undesirable: drive `createWatchSession.start()` over a temp dir and reach in for the predicate via the watcher's options.
- [x] 1.2 Add a test asserting the predicate returns `true` for `<root>/.git/index.lock` and for a deeper path like `<root>/.git/refs/heads/main`. RED today — predicate currently returns `false` because `isPathIgnored` only consults `matcherCache`.
- [x] 1.3 Add a sanity test asserting the predicate returns `false` for a regular file under the root that is NOT inside `.git/` (e.g. `<root>/README.md`). Should be GREEN today and stay GREEN after the fix. This is the guard-rail that catches an over-broad fix.
- [x] 1.4 In a separate `describe("createWatchSession watcher resilience", ...)` block, add a test that:
  - calls `createWatchSession.start()` against a temp directory containing one markdown file
  - awaits the session to be ready
  - synthesizes an error by calling `watcher.emit("error", err)` with `err.code = "EINVAL"` (requires either exposing the watcher on the session for tests OR adding a small test-only handle)
  - asserts the host process is still alive and the session can still be queried (e.g. `getRoots()` succeeds and returns a sensible value)
  - asserts no unhandled-rejection / uncaught-error fired during the test (capture via `process.on("uncaughtException", ...)` for the test duration, then restore the original listeners)
  - The cleanest path is to expose the watcher (or a `simulateError(err)` method) only via a non-public exported handle. Pick the lowest-friction option that keeps production surface unchanged.
- [x] 1.5 Run the suite and confirm 1.2 fails and 1.4 fails (today, the synthesized error becomes an unhandled error). Capture the failure output for the PR description so reviewers can see the bug exists before the fix.

## 2. Fix the chokidar ignore predicate (GREEN, layer 1)

- [x] 2.1 In `src/server.ts:854`, extend `isPathIgnored` so that — in addition to the existing `matcherCache` consultation — it returns `true` if any path segment of the candidate path relative to its watched root equals the literal string `.git`. Use `path.relative(rootPath, testPath).split(path.sep)` and check segment-equality (NOT substring matching, NOT basename-only). Apply this check for every registered watched root that contains the candidate path; if no root contains it, the existing fall-through (return `false`) is preserved.
- [x] 2.2 Do NOT mirror any other names from `ignoredNames` (e.g. `node_modules`, `.next`) into the watcher predicate. Decision 1 in `design.md` documents why; a comment in the code at the new check site should briefly note "only `.git/` — see openspec/changes/fix-watcher-crash-on-transient-paths/design.md Decision 1" so a future contributor doesn't widen this drive-by.
- [x] 2.3 If extraction was done in 1.1, ensure the new exported helper is the implementation `createWatchSession` uses internally, not a parallel copy. One source of truth.
- [x] 2.4 Re-run tests 1.2 and 1.3; both should now pass.

## 3. Add the watcher error listener (GREEN, layer 2)

- [x] 3.1 In `src/server.ts:1014` (immediately after `watcher.on("all", handleWatcherEvent)` or co-located with it), attach `watcher.on("error", err => { ... })` with a handler that:
  - logs the error at `console.error` with a clear prefix (e.g. `uatu: watcher error: ${err instanceof Error ? err.message : String(err)}`)
  - does NOT rethrow, does NOT call `watcher.close()`, does NOT terminate the process
  - is intentionally minimal — its job is crash resistance, not policy
- [x] 3.2 Re-run test 1.4; it should now pass.

## 4. Verify and finalize

- [x] 4.1 Run `bun test` and confirm green across the whole suite. No existing test should regress.
- [x] 4.2 Run `openspec validate fix-watcher-crash-on-transient-paths` and resolve any reported issues.
- [x] 4.3 ~~Manual git-commit-loop smoke test~~ — dropped as redundant. The `buildWatcherIgnorePredicate` tests already prove `.git/*` paths are excluded; chokidar respecting its own `ignored` option is chokidar's contract, not ours to re-verify with a hand-driven loop.
- [x] 4.4 ~~Manual synthetic-error injection against `bun run dev`~~ — dropped as redundant. The `createWatchSession watcher resilience` test already emits a synthetic EINVAL on the real underlying chokidar `FSWatcher` and asserts the host survives; running the same exercise by hand adds no signal.
