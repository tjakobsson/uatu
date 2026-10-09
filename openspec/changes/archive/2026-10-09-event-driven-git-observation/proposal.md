## Why

A session learns about Git-only changes (commits, staging, branch switches, fetches) through a timer. While a page is open, it checks the timestamps of about a dozen Git files every 5 seconds. #501 stopped that timer from re-triggering itself and made refreshes that find nothing invisible. Three problems remain:

- The timer contradicts the rule that document updates come from observer events, not idle timers.
- A commit that changes no files can take up to 5 s to appear.
- Every file edit runs a full repository collection, so steady agent edits keep Git running back-to-back.

#501 also left two smaller problems:

- **Git Log ages freeze.** Ages like "2 minutes ago" are Git's wall-clock text. A refresh with no real change no longer republishes them, so they stay frozen until the next real change.
- **Diff mode still pulses.** It re-fetches the active file's diff, with its loading bar, on every repository change, even when another file changed.

VS Code's Git extension shows the established approach. It watches the top level of the Git directory and a few ref files, ignores lock files, debounces, and keeps a cooldown between status runs. Its `git status` also runs without optional locks.

## What Changes

- **Git observation is event-driven.** While a page is subscribed, a narrow, non-recursive watcher replaces the 5-second probe. It watches the Git directory's top level, the shared Git directory for linked worktrees, and the current branch's and compare base's ref files. It ignores lock files, `objects/` and fsmonitor cookies. Polling stays only as the fallback where native observation is unavailable or the session runs in polling mode.
- **The browser stops polling.** #497 also added a browser timer that asks the server for a full Git collection every 5 seconds while the Change Overview or Git Log is visible or Diff mode is on. Its purpose is to catch edits outside a watched root that is narrower than its repository. The timer goes away. For such narrow roots, the server watches the repository's working tree instead, as VS Code does, skipping `.git` and paths the repository's `.gitignore` excludes. Whole-repository roots, the usual Hub case, need nothing extra because the content watcher already sees every edit.
- **Repository collection is paced.** A change after a quiet period is collected promptly, as now. Under sustained triggers, collections start no closer together than a minimum gap. One follow-up still captures the latest state.
- **Quiet refreshes are specified, not just implemented.** These are the rules #501 added: a refresh with an identical result publishes nothing and keeps its generation. Repository data is marked stale only after a short grace, if collection is still running.
- **Commit ages stay current.** Each commit-log entry carries its commit time. The Git Log pane and commit preview render the age in the browser and update it over time, as the facts strip does for modification time. The existing `relativeTime` text remains on the wire for compatibility.
- **Diff mode refreshes only when the active file's diff can have changed.** A repository update re-fetches the active diff only when that file's change entry, the resolved compare base, or `HEAD` changed. An unrelated update leaves the diff and its loading indicator alone.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `document-watch-index`: *Repository work is independent of file delivery* changes. Git-only changes, and edits outside a narrow root, are observed through events, with polling only as a fallback. Clients no longer drive collection on a timer. Collection is paced. Unchanged results are silent, and the stale notice has a grace period. The rule against watchers inside `.git` already applies only to the content watcher, so it needs no change.
- `change-review-load`: commit-log entries carry a commit timestamp that clients can turn into a current age.
- `sidebar-shell`: Git Log rows show a commit age that stays current while the page is open.
- `document-diff-view`: an active Diff refreshes on repository updates only when that file's diff inputs changed. Unrelated repository updates leave it untouched.

## Impact

- **Server:** `src/server/repository-refresh.ts` (probe replaced by an observer and pacing), `src/server/file-observer.ts` (reused for the narrow Git-metadata watch, including the polling fallback), `src/server/watch-session.ts` (metrics: `reconcile.ticks_total` is replaced by Git-observer event counters), `src/document/git-data.ts` (commit time in `collectCommitLog`).
- **Client:** `src/shell/events.ts` (the 5-second repository refresh timer is removed), `src/sidebar/git-log.ts` and `src/preview/commit-message.ts` (client-side ages and a periodic re-render of visible ages), `src/shell/events.ts` and `src/preview/diff.ts` (diff refresh limited to relevant repository changes).
- **API:** commit-log items are open objects (`additionalProperties: true`), so the new commit-time field is additive. The OpenAPI description, examples and changelog gain the field. A workspace API revision bump happens only if the compatibility check requires one.
- **Docs:** `ARCHITECTURE.md` (repository refresh section) and the `CLAUDE.md` folder-map line for `repository-refresh`.
- **Out of scope:** no change to the content watcher, file indexing, the Hub broker, or which Git commands run during collection.
