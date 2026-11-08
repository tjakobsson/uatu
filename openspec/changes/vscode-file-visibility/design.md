## Context

See proposal.md for the motivation. Current state:

- **Exposure.** `src/ignore/exposure.ts` holds about 30 mandatory denied names, suffixes, and secret patterns. `src/ignore/engine.ts` adds `build`/`dist` as soft exclusions that `ignore.include` can open. Watch policy, index membership, static files, and media delivery all go through `matcher.shouldIgnore`.
- **Discovery.** Discovery is eager: every permitted file is stat'd and indexed, and clients receive the whole index as a snapshot, then patches. Recent, the media filters, Follow, project search (`src/server/search.ts` reads the index, not the disk), and the file count are all projections of that index.
- **Ignore status.** Status comes from `git check-ignore` per file (`src/server/git-ignore.ts`) after indexing. It starts as `unknown`, and clients treat `unknown` as visible.
- **Observation.** The native observer is one recursive `fs.watch` per root and already receives events from excluded folders, dropping them after a raw callback. The Chokidar fallback never traverses excluded folders.
- **Publication.** `FileIndex` debounces 150 ms with a 2 s maximum wait and flushes in patches of at most 256 entries. Classification and Follow candidates follow as separate patches. The Hub never coalesces document patches and ends a client whose unread backlog exceeds 1 MiB.
- **Measured on this repository.** `git ls-files --others --ignored --exclude-standard --directory` returns 18 entries in 34 ms; `node_modules/` (40,046 files) is collapsed to a single entry.

VS Code's model, which this change adopts:
- `files.exclude` defaults hide only VCS metadata and OS litter.
- Explorer shows gitignored items greyed (`explorer.excludeGitIgnore: false`).
- Explorer reads a folder's children only when the folder is expanded.

## Goals / Non-Goals

**Goals:**
- No name-based rule beyond VS Code's defaults. What Git ignores is muted; what a project excludes is gone.
- A 100,000-file ignored folder costs one folder entry until someone opens it.
- Fresh renders inside ignored folders reach Recent and the Audio filter without being expanded.
- Rebuilds and installs cannot steer Follow or delay ordinary updates, with deterministic patch counts that tests can assert.

**Non-Goals:**
- Reading `.vscode/settings.json` (`files.exclude`, `search.exclude`). This can be added later without changing the model.
- Lazy listing for folders that Git does not ignore. Those stay eager, because Recent, Follow, and search depend on them.
- Completeness of Recent for writes made before the session inside unlisted ignored folders.
- Ignore detection in non-Git roots.

## Decisions

### 1. Built-in exclusions are VS Code's `files.exclude` defaults

The remaining built-ins are `.git`, `.svn`, `.hg`, `.jj`, `.DS_Store`, and `Thumbs.db`. Every other denial is deleted: dependency names, cache names, virtual environments, editor temp suffixes, and secret patterns. The VCS directories stay mandatory, because the watcher must not traverse Git internals and `.git/config` can hold credentials. The implementation verifies this list against VS Code's current `files.exclude` default and records the version it checked.

*Alternative:* keep the secret denylist as a security floor. The user rejected it. Rationale recorded for the docs: Hub authentication is the boundary, and an authenticated user already has the same file access through the embedded terminal and agents. Explicit `ignore.exclude` remains available.

### 2. Git decides what is lazy

At discovery and recovery, each Git root runs `git ls-files --others --ignored --exclude-standard --directory -z` once. Entries ending in `/` are candidates for ignored folders. Each candidate is confirmed with `git check-ignore` on the directory itself, because Git also lists untracked directories that only contain ignored files (seen with `.opencode/` here). Confirmed folders become folder entries in the index, and the walker does not descend into them. Individually listed ignored files are indexed eagerly with `ignored` status already known, so no `unknown → ignored` patch follows. Directories created at runtime are classified the same way with one `check-ignore` call before the walker descends. Edits to ignore sources (`.gitignore`, `.git/info/exclude`, `core.excludesFile`) already trigger reclassification; they now trigger `recover()`, which recomputes folder entries. Listed levels survive recovery only if their folder is still ignored.

*Alternatives:*
- A file-count budget per folder: rejected as a heuristic users cannot predict.
- Lazy listing for every folder: rejected because Recent and Follow need eager knowledge of non-ignored files.
- Parsing `.gitignore` in non-Git roots: deferred, since the README documents `ignore.exclude` for those roots.

### 3. Wire shape: folder entries in the document payload

Snapshots and patches gain folder entries, each with a root id, a root-relative path ending in `/`, and a `listed` flag. Upserts and removals use the existing ordered patch mechanism, so the Hub broker's document index and replay carry them without a new topic. This is a new field on a closed published object, so the live-payload schema, API revision declarations, and changelog are bumped as for other closed-object additions. The listing request is a new internal child route, `GET` on the workspace base path, carrying root id and folder path. It is classified as an explicit non-public operation like media delivery. It answers with the listing's revision once the listed entries have been published as an ordinary patch, so every client converges through one path and the requesting client waits on a revision it already knows how to apply.

### 4. Live writes inside unlisted levels: a bounded, pinnable window

Native recursive watch events inside an unlisted ignored folder are no longer dropped. They are stat'd and indexed as ordinary entries flagged `windowed`. Per root, a recency-ordered set holds at most 2,000 windowed entries. Overflow evicts the oldest unpinned entry as a normal removal. A document, static, or media request for a windowed path pins it for the session; the server already sees those requests. Listing a level converts its windowed entries into listed entries outside the window. In the Chokidar fallback, unlisted ignored folders are not watched, so their live writes appear only once listed. This limit is documented.

*Why 2,000:* it keeps a full `npm install` to about 0.5 MB of index and fits a long render session. It is a performance budget, not a visibility rule.

*Alternative:* index every live write without a bound. Rejected because one install would add tens of thousands of entries to every client's tree.

### 5. Ignored-folder lane

`FileIndex` routes paths inside ignored folders (listed or windowed) into a second pending map keyed by path, so the latest state wins. Its scheduler waits 1 s after the last event and at most 5 s after the first. Lane entries carry `ignored` status from their folder and need no `check-ignore`. They publish in patches of at most 1,024 entries, back to back, and never produce Follow-candidate patches. The ordinary lane keeps its 150 ms / 2 s timing and 256-entry patches.

*Why 1,024:* about 280 KB per patch. Five patches carry a 5,000-file burst within the Hub's stall bound for a reading client, and `fix-live-burst-recovery`'s fair yielding lets the client drain between them.

*Alternative:* a full snapshot on large bursts. Rejected because a snapshot scales with the whole index and would repeat every interval during a long build.

### 6. Follow never targets Git-ignored files

The server's `latestChanges`, per-subscriber `changedId`, reconnect `latestChange`, and `newest()` all exclude `gitIgnoreStatus === "ignored"`, as does the client's chip catch-up in `src/shell/follow.ts`. They already wait on classification for unknown files. A failed classification resolves as not ignored, matching the visible-when-unknown display. This replaces #607's per-visibility Follow candidacy, so the separate `latestChanges` maps for `showIgnored` true and false collapse to one.

### 7. Client: unlisted folder rows in Pierre Trees

Pierre Trees accepts explicit directory paths (trailing `/`) as possibly empty folders, and supports incremental `add`/`batch`. An unlisted folder is rendered as an explicit directory with the ignored git status. The tree view already tells genuine user expansion apart from programmatic expansion (Rule A guard). A genuine expansion of an unlisted folder sends the listing request and marks the row as loading. The listing arrives as a normal patch, and the merge runs under `withProgrammaticUpdate`. Reveal of an explicitly selected file inside unlisted levels requests each ancestor level in order. Show ignored files off hides folder rows through the same `isDocumentVisible` predicate, extended to folders.

### 8. `ignore.include` retired with a warning

The key never reached a stable release. Parsing and the soft-exclusion branch are deleted. A leftover key produces one warning through the existing `.uatu.json` warning channel.

## Risks / Trade-offs

- [Secret-like files become visible to every authenticated Hub user] → This was the user's explicit decision, matching VS Code. README and docs/FILES.md state it and show the `ignore.exclude` patterns to opt out. Release notes call it out as breaking.
- [Non-Git roots lose all protection against huge dependency folders] → Documented. `ignore.exclude` bounds them. Startup still serves the shell first and fills the tree incrementally.
- [Recent misses older renders inside unlisted ignored folders] → Specified behavior. Expanding the folder brings them in, and fresh renders are captured live.
- [Editor temp files (`.swp`, `~`, atomic-save temps) now appear] → Most are created and removed within one debounce window and never publish. The rest are muted when Git ignores them, and binaries are never followed.
- [Eviction removes a file from one client's tree that another client is about to open] → Opening it pins it. If an evicted row was already gone, the existing unavailable-destination rules apply, and expanding the folder restores it.
- [A wire change touches the Hub broker, replay, and both clients] → Covered by contract tests, the API revision bump, and an e2e test through the Hub.
- [The Chokidar fallback cannot see live writes in unlisted ignored folders] → Documented. The native watcher is the default on supported platforms.

## Migration Plan

1. Ship as one PR with the API revision bump. Release notes, relative to v0.8.0:
   - only VCS metadata and OS litter are hidden by default
   - ignored folders are listed on demand
   - secret-like files are visible
   - Gitignored files are never followed
   - how to exclude paths with `ignore.exclude`
2. Rollback: reverting restores eager discovery with the old denylist. Personal state is unchanged. The reverted API revision follows the project's existing revision-compatibility rules; no persisted data needs migrating.
