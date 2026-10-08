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
- `reftable/`, when the repository uses the reftable backend.

Events whose file name ends in `.lock`, contains `.watchman-cookie-`, or lies under `objects/` are dropped. Every other event calls `request()`.

The path set is re-resolved after a collection reports a different branch, `HEAD` symref or compare-base ref, the same trigger the probe uses today for `probeFiles = null`. Handles are opened while demanded and closed when demand drops.

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
- the file's `changedFiles` entry (`status`, `oldPath`, `additions`, `deletions`, `hunks`), or none.

`events.ts` re-fetches the active diff only when that key changed, and stops clearing `documentDiffCache` wholesale: entries are keyed by the diff-input key, so stale entries simply stop matching. The facts-strip enrichment keeps using the repository generation. With #501 the generation advances only on real changes, and facts are per document and cheap.

`additions`/`deletions` also change when the file itself is edited. That path already re-fetches through the document revision, and the key change then hits the same request rather than adding one.

## Risks / Trade-offs

- **[Risk] Native directory watches on macOS can miss events or report them late under load.** → The observer is reconciled by the next file-triggered collection anyway, and the fallback probe takes over on any watcher error. A unit test drives real `git commit`, `git checkout -b`, `git fetch` against a local remote, and `git pack-refs`, and asserts that each one is observed.
- **[Risk] A missed watched path, for example a ref namespace we didn't enumerate, means a missed Git-only change.** → Any file edit still triggers a full collection. Unenumerated refs don't feed the published snapshot, which is built only from `HEAD`, the branch, the compare base and the index.
- **[Risk] Ages could disagree with Git's `%cr` wording.** → One shared formatter, with thresholds that follow Git's (seconds, minutes, hours, days, weeks, then the date), covered by unit tests.
- **[Trade-off] The 2 s gap delays the second of two quick commits by up to 2 s.** → This is acceptable for preview data, and the first change after a quiet period is still prompt.
- **[Risk] Open handles per repository.** → At most five non-recursive handles per repository, released with demand, and shared across watch entries in the same repository.

## Migration Plan

This is server and client in one binary, with no stored state. The new field is additive on an open schema. Older clients ignore it and keep showing `relativeTime`, which still freezes for them, exactly as after #501. To roll back, revert the change. The probe code stays in the tree as the fallback, so it can't be lost.

## Open Questions

- Whether the Git Log should switch to the facts strip's short age form ("3h ago") for consistency. This is a presentation choice only; the shared formatter supports both.
