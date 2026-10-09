## Context

`createRepositoryRefresh` (`src/server/repository-refresh.ts`) owns a session's repository data. #497 gave it three inputs:

- `request()` calls from file batches and index recovery;
- an immediate refresh when the first client subscribes (`demand(true)`);
- a 5-second probe that stats about a dozen Git files located with `git rev-parse --git-path` and refreshes when their fingerprint changes.

The probe runs only while a client is subscribed. #501 (merge before applying this change) added three things:

- `GIT_OPTIONAL_LOCKS=0` on every `safeGit` call;
- deep comparison of results, so an unchanged refresh publishes nothing and keeps its generation;
- a one-second grace before `stale` is announced.

The comparison skips `relativeTime`, which is why Git Log ages now freeze.

The content observer (`src/server/file-observer.ts`) keeps one native recursive `fs.watch` per root and falls back to Chokidar polling. The ignore engine always excludes `.git`, and the `document-watch-index` spec forbids the content watcher from attaching native watchers inside `.git`. The Git metadata observer described here is a separate component; the content watcher keeps that ban.

On the client, `diffRevisionKey` (`src/preview/diff.ts`) folds in `repositoryFreshness.generation`, and `src/shell/events.ts` clears `documentDiffCache` on any new generation. As a result, every real repository change re-fetches the active diff with its loading signal.

## Goals / Non-Goals

**Goals:**
- No timer while native observation works. A Git-only change becomes visible within the debounce, not within a polling interval.
- Bounded Git work under sustained edits.
- Commit ages that stay correct without server traffic.
- A Diff refresh only when the active file's diff inputs changed.

**Non-Goals:**
- Changing which Git commands collection runs, or making collection incremental per file.
- Watching `.git` from the content watcher, or indexing anything inside it.
- Window-focus gating like VS Code's `whenIdleAndFocused`. Our equivalent already exists: hidden tabs release the live stream (#357), which drops demand.

## Decisions

### 1. A dedicated Git metadata observer, not the content observer

A new `src/server/git-observer.ts` resolves the paths to watch for each watch entry. It opens **non-recursive** `fs.watch` handles on directories, not files. Git updates refs and the index by writing a lock file and renaming it, which replaces the inode, so a file watch goes deaf after the first update. A directory watch sees the rename.

The watched directories are:
- the worktree Git directory (`rev-parse --absolute-git-dir`), which covers `HEAD`, `index`, `ORIG_HEAD`, `FETCH_HEAD`, `COMMIT_EDITMSG` and `logs/`;
- the shared Git directory (`rev-parse --git-common-dir`) when it differs, which covers `packed-refs` and `config`;
- the directory holding the current branch's ref file, under the shared directory's `refs/heads/`;
- the directory holding the compare base's remote ref (for example `refs/remotes/origin/`), plus `refs/remotes/origin/` itself for the `origin/HEAD` symref;
- `reftable/`, only when the repository uses the reftable backend, and `refs/remotes/origin/` only when an `origin` remote is configured (a `config` change re-resolves). An optional directory that never exists would otherwise keep the path set "missing" and make every event re-resolve.

A watched root outside any repository is itself watched, non-recursively, for a `.git` entry appearing. `git init` there re-resolves into the normal set.

Events for lock and temp files (`*.lock`, `*.new`), `objects`, `FETCH_HEAD`, `gc.pid`/`gc.log` and watchman cookies are dropped. `FETCH_HEAD` changes on every fetch, even one that moves no ref; a fetch that moves a ref also renames that ref or `packed-refs`. Every other event calls `request()`.

The observer re-resolves its path set itself. It does so when it sees a `HEAD` entry change in a watched directory (a branch switch moves the worktree's `HEAD`, and a new remote default moves `refs/remotes/origin/HEAD`). It also does so on any event while a candidate directory is missing, for example before the first fetch creates `refs/remotes/origin`. Re-resolution is coalesced, closes handles that are no longer wanted, and opens new ones. While any candidate directory is missing, every event except lock and temp names re-resolves, `FETCH_HEAD` included. On Linux the first fetch reports only `FETCH_HEAD` at the Git directory, while it creates `refs/remotes/origin` below it. A directory that gains a handle on re-resolution reports a change, since its entries were written before the watch existed. Directories are compared by real path, so `/tmp` and `/private/tmp` spellings of one directory share a handle. Handles are opened while demanded and closed when demand drops.

*Alternatives considered:*
- **Reuse `file-observer.ts` with a recursive watch on `.git`.** Rejected. `objects/` churns on every fetch and gc, a recursive watch over `.git` is exactly what the spec forbids for content watching, and FSEvents coalescing gains nothing.
- **Keep the probe and shorten its interval.** Rejected. It is still a timer, and still spawns `rev-parse` whenever the path set is recomputed.

### 2. The probe becomes the fallback

The existing stat-fingerprint probe, unchanged apart from its trigger, runs only in three cases: when `usePolling` is set, when `fs.watch` throws while opening a handle, or when a handle later emits `error`. On a watcher error the observer closes its handles, starts the probe, and logs one diagnostic. It does not retry native watching for the life of that demand period, because flapping between the two modes is worse than steady polling. The next `demand(true)` tries native watching again.

### 3. Pacing: a prompt start, then a minimum gap between starts

`createRefreshScheduler` keeps its 150 ms debounce for the first trigger after a quiet period. `repository-refresh` adds `MIN_COLLECTION_GAP_MS = 2000`, measured from one collection's start to the next. A trigger that arrives sooner sets `dirty` and schedules the follow-up for `lastStart + gap`. Coalescing (one in flight, one queued) is unchanged.

VS Code uses a 1 s debounce and a 5 s cooldown. Ours is tighter because uatu is a live preview and file edits also trigger collection; 2 s keeps a large repository's `git status` from running back-to-back. Because the stale notice comes from #501's grace timer, a follow-up held back by the gap during sustained edits does show "Refreshing…" after a second. That is accurate, since files changed after the last collection.

### 4. Commit time on the wire; ages rendered in the browser

`collectCommitLog` adds `%ct` to its format, and `CommitLogEntry` gains `committedAtMs: number | null`. The unit matches `mtimeMs`. `relativeTime` stays on the wire for compatibility, and the change comparison keeps ignoring it.

The client formats ages with one shared helper. The facts strip's `formatRelativeTime` moves to `src/shared/relative-time.ts`, gains a long form for the Git Log ("3 hours ago", matching today's `%cr` look), and keeps the short form for the facts strip.

A single client ticker re-renders the age text nodes of visible Git Log rows and the commit preview: every 30 s while any age is under an hour old, every 5 minutes otherwise. It pauses while `document.hidden`. It updates text only, so rows are not rebuilt and scroll and focus are kept.

*Alternative considered:* recollect on a slow timer to refresh `%cr`. Rejected, because it spends Git work and server traffic on presentation.

### 5. A per-file key for Diff relevance instead of the global generation

`diffRevisionKey` becomes `documentRevisionKey(id)` plus a **diff-input key** built from three parts of the snapshot that contains the file:
- `metadata.commitShort` (`HEAD`);
- `base.mergeBase ?? base.ref` with `base.compareTarget` (the compare base);
- the file's `changedFiles` entry (`path`, `status`, `oldPath`), or none.

The owning repository is found through its `watchedRootIds`, which share the document ids' spelling. Git's top level is a real path (`/private/tmp/…` on macOS) and may not. When the top level is spelled differently from the root, the entry is the longest changed path that ends with the root-relative path.

`diff.ts` records the key each cached diff was fetched under. On a repository update, `events.ts` drops only the entries whose key moved, and re-fetches the active diff only if its own entry was dropped. It no longer clears `documentDiffCache` wholesale, except on a new epoch or compare target, where every recorded diff counts as dropped. The facts-strip enrichment keeps using the repository generation. With #501 the generation advances only on real changes, and facts are per document and cheap.

Line counts (`additions`, `deletions`, `hunks`) stay out of the key. They change only when the file's content changes, and a content change already re-fetches through the document revision. With them in the key, every save would fetch the diff twice: once for the file patch, then again for the repository update that follows it.

### 6. Narrow roots: watch the working tree; the browser stops polling

#497 added a browser timer (`src/shell/events.ts`) that POSTs `/api/repositories/refresh` every 5 s while the Change Overview or Git Log is visible or Diff mode is on. Each request runs a full collection. It exists for watch roots narrower than their repository: an edit elsewhere in the repository never reaches the content watcher, yet it changes the Change Overview.

The timer is removed. The `/api/repositories/refresh` route stays as an explicit trigger; it was never part of the published API.

For each watch entry, the observer compares the entry with `git rev-parse --show-toplevel` (by real path). When the entry is narrower, or is a single file, the observer adds one **recursive** watch on the repository top level. Events from it are dropped when they fall:
- under a `.git` path segment (the metadata watches cover Git state);
- inside the watched root itself (the content watcher already requests a collection for those);
- under a path matched by the repository's top-level `.gitignore`, unless Git tracks that file anyway (`git ls-files --cached --ignored --exclude-standard`, refreshed when `.gitignore` or the index changes). This uses the `ignore` package the ignore engine already uses; nested `.gitignore` files are not consulted.

A missed nested `.gitignore` only costs a paced collection whose unchanged result publishes nothing. A filter that wrongly dropped a tracked path would leave data stale, so the filter errs towards triggering. Several narrow entries in one repository share one tree watch. Whole-repository roots open no tree watch.

In the fallback (polling mode, or a failed watch), a narrow root has nothing equivalent to observe by stat. Each poll tick therefore requests a collection, which is the old browser timer's behavior moved to the server and confined to the fallback.

*Alternatives considered:*
- **Keep the browser timer for narrow roots only.** Rejected, because it is still a timer, it runs per open page rather than once per session, and it contradicts the idle-repository requirement.
- **Drop the timer with no replacement.** Rejected, because the Change Overview would stay stale for narrow roots until some unrelated trigger.

## Risks / Trade-offs

- **[Risk] A recursive tree watch on Linux costs one inotify watch per directory, including ignored ones such as `node_modules`.** → Only narrow roots open one, and Hub workspaces are usually whole repositories. An `ENOSPC` or other watch error takes the polling fallback above, with one diagnostic.

- **[Risk] Native directory watches on macOS can miss events or report them late under load.** → The observer is reconciled by the next file-triggered collection anyway, and the fallback probe takes over on any watcher error. A unit test drives real `git commit`, `git checkout -b`, `git fetch` against a local remote, and `git pack-refs`, and asserts that each one is observed.
- **[Risk] A missed watched path, for example a ref namespace we didn't enumerate, means a missed Git-only change.** → Any file edit still triggers a full collection. Unenumerated refs don't feed the published snapshot, which is built only from `HEAD`, the branch, the compare base and the index.
- **[Risk] Ages could disagree with Git's `%cr` wording.** → One shared formatter, with thresholds that follow Git's (seconds, minutes, hours, days, weeks, then the date), covered by unit tests.
- **[Trade-off] The 2 s gap delays the second of two quick commits by up to 2 s.** → This is acceptable for preview data, and the first change after a quiet period is still prompt.
- **[Risk] Open handles per repository.** → At most five non-recursive handles per repository (plus one recursive tree watch for narrow roots), released with demand, and shared across watch entries in the same repository.

## Migration Plan

This is server and client in one binary, with no stored state. The new field is additive on an open schema. Older clients ignore it and keep showing `relativeTime`, which still freezes for them, exactly as after #501. To roll back, revert the change. The probe code stays in the tree as the fallback, so it can't be lost.

## Open Questions

- Whether the Git Log should switch to the facts strip's short age form ("3h ago") for consistency. This is a presentation choice only; the shared formatter supports both.
