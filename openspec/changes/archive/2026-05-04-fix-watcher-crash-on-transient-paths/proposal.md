## Why

When `uatu watch` runs over a directory containing a `.git/` subdirectory, chokidar attaches native filesystem watchers inside `.git/`. Short-lived files such as `.git/index.lock` (created and removed during routine git operations) are reported by fsevents as "added," chokidar then issues a `watch` syscall against them, and the kernel returns EINVAL (errno -22) because the file already vanished. Chokidar emits the failure on its `error` event, but the watcher set up in `createWatchSession.start()` only attaches an `"all"` listener — there is no `"error"` listener. The unhandled error tears down the process. We have an in-the-wild reproduction: EINVAL on syscall `watch` against `.git/index.lock`. Two distinct gaps cause this: (1) the watcher's `ignored` predicate doesn't exclude `.git/`, even though `.git/` is git's own working metadata and never contains user-authored content the indexer would surface; (2) the watcher has no `"error"` handler, so any surprise from chokidar's native bindings becomes an unhandled error.

## What Changes

- Teach the chokidar `ignored` predicate to always exclude `.git/` (any path containing a `.git` segment relative to a watched root). This is the only addition to the predicate — we deliberately do NOT mirror the broader hardcoded indexer denylist (`node_modules`, `.next`, `__pycache__`, etc.) into the watcher, because those are already filtered by user-controlled `.gitignore` / `.uatuignore` matchers in the typical case. `.git/` is the only directory that is *structurally* special (git's working metadata, present in every git worktree, never user-authored) and cannot be relied on to appear in `.gitignore`.
- Attach an `"error"` listener to the chokidar watcher that swallows transient errors without crashing the process. The listener logs at error level so genuine misconfiguration is still visible, but never propagates as an unhandled error.
- Add focused regression tests:
  - The chokidar ignore predicate returns `true` for a path under `.git/`.
  - A watcher whose chokidar surface emits a synthetic `"error"` event with `code: "EINVAL"` does not crash the host process and does not propagate the error.
- No CLI changes. No new flags. No change to which files appear in the sidebar.

## Capabilities

### New Capabilities
<!-- None — this is a behavior tightening on an existing capability. -->

### Modified Capabilities
- `document-watch-browser`: Tightens the existing **"Keep the indexed view and preview current"** requirement so the watcher (a) does not attach native filesystem watchers to paths inside `.git/`, and (b) tolerates transient errors from the underlying watcher implementation without terminating the host process.

## Impact

- Code: `src/server.ts` — `isPathIgnored` (line 854) gets a `.git/`-segment check; the chokidar setup in `createWatchSession.start()` (line 997+) gets an `"error"` listener. No public API or wire-format changes.
- Tests: `src/server.test.ts` — adds two small unit tests; neither requires reproducing a real filesystem race.
- Out of scope: the latent ENOENT race in `walkAllFiles` (server.ts:1153) where `fs.stat` after `fs.readdir` is unguarded. That is a real bug but masked today by the outer `.catch` in `scheduleRefresh`, surfaces only as transient stale state, and has a different test shape. It will be filed as a separate change.
- Out of scope: mirroring the indexer's full hardcoded denylist into the watcher. Considered and rejected — the hardcoded list is a UX-default for the *indexer's sidebar* on directories without `.gitignore`; for the *watcher* it would just spread an existing heuristic into a second code path. The error handler covers any surprise from those paths; a niche `--force` user with a huge un-gitignored `node_modules` is addressed separately if it ever materializes.
- Behavior delta: previously, a single `git commit` against the watched repo could crash `uatu watch` if the timing aligned; afterwards, the watcher remains stable across arbitrary git operations. Idle CPU during git-heavy activity should also drop because chokidar is no longer maintaining native watchers under `.git/`.
- No dependency, schema, or wire-format changes.
