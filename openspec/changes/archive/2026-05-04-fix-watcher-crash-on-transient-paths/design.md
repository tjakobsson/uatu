## Context

`createWatchSession.start()` (src/server.ts:997) constructs the chokidar watcher with two relevant hooks:

- `ignored: isPathIgnored` (server.ts:854–867): a predicate that consults `matcherCache` (a per-watched-root `IgnoreMatcher` built from `.uatuignore` and `.gitignore`). If no matcher is registered for the root, or if the path falls outside any registered root, the predicate returns `false` — i.e. the path is watched.
- `watcher.on("all", handleWatcherEvent)` (server.ts:1014): the only event listener attached. Crucially, no `error` listener.

The in-the-wild crash: `EINVAL` (errno -22) on syscall `watch` against `.git/index.lock`. Routine `git commit` creates and removes the lock file faster than chokidar can attach a native watcher to it; the watch syscall fails; chokidar emits `error`; nothing is listening; the host process terminates.

The watcher has been silently descending into `.git/` because `.git` is not in the `IgnoreMatcher` (git itself doesn't gitignore its own metadata directory) and `isPathIgnored` knows about nothing else.

The indexer (`shouldIgnoreEntry`, server.ts:1168–1174) has a much larger hardcoded denylist (`ignoredNames` at server.ts:44–85) including `node_modules`, `.next`, `__pycache__`, and many others. **That list is intentionally NOT being mirrored into the watcher** — see Decision 1.

## Goals / Non-Goals

**Goals:**
- `uatu watch` survives arbitrary git operations (commits, rebases, branch switches) against a watched git repo without process termination.
- The watcher does not attach native filesystem watchers inside `.git/`.
- The watcher tolerates surprise `error` events from chokidar without crashing — defense in depth against future race shapes (different errnos, different filesystems, Bun version drift).

**Non-Goals:**
- Mirroring the indexer's broader hardcoded denylist (`node_modules`, build dirs, etc.) into the watcher. Considered and rejected — see Decision 1.
- Fixing the latent walk-side ENOENT race in `walkAllFiles` (server.ts:1153). Real but separate; tracked as a follow-up change.
- Surfacing watcher errors to the browser UI. Errors stay server-side.
- Changing the chokidar configuration (`usePolling`, `awaitWriteFinish`, etc.). The bug is in the predicate and the missing error listener, not the polling strategy.

## Decisions

### Decision 1: Exclude only `.git/`, not the full indexer denylist

The watcher predicate gets one new rule: any path with a `.git` segment between it and its watched root is ignored. Nothing else from `ignoredNames` is mirrored.

**Why `.git/` specifically?**
`.git/` is *structurally* special — it is git's working metadata directory, not user-authored content. It exists in every git worktree, is created and managed entirely by git, and is never something a `uatu watch` user wants to observe. Excluding it is closer to "skipping a system directory" than "applying a heuristic." Critically, `.git/` is the one directory that cannot be relied on to appear in `.gitignore` — git doesn't gitignore itself.

**Why NOT the rest of the list (`node_modules`, `.next`, `__pycache__`, ...)?**
Those entries on `ignoredNames` are a starter-pack the *indexer* uses for sidebar UX when a user has no `.gitignore`. They are heuristics about "what's probably uninteresting to read." Three reasons not to spread them into the watcher:

1. **Already filtered.** In the typical case (a project with a `.gitignore` and `respectGitignore` on by default), `node_modules` and friends are already in the user's `.gitignore` and the existing `IgnoreMatcher` excludes them. The watcher inherits that filter via the matcher cache the predicate already consults. Adding a second copy of the rule in the watcher would be redundant.
2. **Not the bug.** The crash is `.git/index.lock`, not `node_modules/.cache/something`. Chasing the broader list would expand scope without fixing anything we have evidence for.
3. **The hack we should not spread.** The indexer's `ignoredNames` is already a magic list of strings that has to be maintained as new frameworks emerge. Funneling the watcher through it would deepen the dependency on that list rather than minimize it. If the list itself is the wrong abstraction, that is a larger refactor — out of scope for a crash fix.

**What about the niche case: `uatu watch ~/non-git-dir --force` with a giant un-gitignored `node_modules`?**
The watcher would attach native handles to all of those files. Two responses: (1) the error handler from Decision 2 prevents that scenario from crashing; (2) if the user actually does this, fd exhaustion is the worst outcome and surfaces as a clear OS error rather than a silent failure. We deliberately do not solve this problem here.

**Implementation: per-segment check, not basename or substring**
Chokidar invokes the predicate with full absolute paths. We need to check every path component between the watched root and the candidate. Reject if any component equals `.git`. Substring matching would false-positive on legitimate names like `something.git/`; basename-only would miss the intermediate segment.

### Decision 2: Attach an `"error"` listener on the watcher

```
watcher.on("error", (err) => {
  console.error(`uatu: watcher error: ${err.message}`);
  // do NOT rethrow, do NOT call watcher.close(), do NOT terminate
});
```

**Why both this AND the predicate fix?**
The predicate fix removes the *known* race surface — `.git/index.lock`. The error listener handles the *unknown* — Bun version drift, new fs APIs, mounted-volume quirks, polling-mode races, atomic-write surprises in user directories. Without the listener, any future surprise becomes a process crash. With it, the worst case is a log line.

**Why log instead of silent?**
Silence would mask genuine misconfiguration (permission errors on the watched root, disk errors, etc.). The contract this design pins is "process does not crash" — silence is not part of it. Logging gives operators a signal when something unusual is happening without taking the host down.

**Why not categorize errors and only swallow specific errnos?**
Considered. Rejected because the user's report (EINVAL, errno -22) demonstrates that the set of "race-shaped" errnos is not knowable in advance — different filesystems, different OSes, different Bun versions surface different codes for the same logical event. Categorizing now would create a future "the new race errno is leaking through" bug. The crash-resistance contract is the right level to pin; finer categorization can be added later if we ever see a case where silence is genuinely wrong.

### Decision 3: Test the contracts, not the race

The watcher race itself is non-deterministic and lives inside chokidar's native code. Two small, deterministic unit tests pin the contracts:

1. `isPathIgnored("…/.git/index.lock")` returns `true` after the fix. Pure function call, no chokidar startup.
2. A chokidar instance whose `error` event we synthesize with `code: "EINVAL"` does not crash and does not propagate.

**Why not reproduce the race?**
A loop of `git commit --allow-empty` against a watched repo would reproduce the original crash on a developer's machine, but it's flaky on CI (timing-dependent, fs-dependent), slow, and doesn't actually pin a *contract* — it pins a single observed instance of a much broader class. The two contract tests above cover the class.

## Risks / Trade-offs

- **Risk:** A user has a directory inside their watched root that is literally named `.git` but is NOT a git metadata directory (e.g. some unrelated tool's data). **Mitigation:** None applied — this is an extreme edge case, the indexer already hides such a directory from the sidebar (it's in `ignoredNames`), and the user can rename or use a different watch root. The cost of preserving this edge case (special-casing the watcher to detect "real" vs "fake" `.git/`) far exceeds any plausible benefit.

- **Risk:** Adding the error listener silences a real misconfiguration that should fail loudly. **Mitigation:** the listener logs at error level. Operators see the issue in stderr; only an automated parent-process watching exit codes would miss it, and that's a less common deployment for `uatu watch`.

- **Trade-off:** We accept that a `--force` user with a huge un-gitignored `node_modules` may exhaust file descriptors. We do not pre-solve this because (a) it is not the reported bug, (b) the error handler ensures it surfaces as an OS error rather than a silent failure, and (c) the right fix if it ever materializes is probably a perf-oriented watcher option, not more hardcoded ignores.

- **Trade-off:** The error listener masks all errors at the watcher level. If chokidar were ever to emit a fatal recoverable error that *should* trigger a session restart, our listener would swallow it. We accept this because chokidar's `error` event today does not carry a "you must restart" signal — it carries individual watch-attempt failures, exactly what we want to swallow.

## Migration Plan

No migration required. Pure server-side fix. No persisted state, no client-visible changes. Rolling forward and back is a no-op for any session that doesn't hit the race; rolling forward eliminates the crash for sessions that do.
