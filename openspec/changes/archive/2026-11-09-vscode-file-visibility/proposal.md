## Why

Uatu decides what Files may show with a hard-coded list of about 30 names: `build`, `dist`, `node_modules`, `.venv`, `__pycache__`, `coverage`, `.cache`, `.next`, secret-like names, editor temp suffixes, and more. Generated audio in a CMake project's `build/` folder therefore stays invisible even after #607 made Gitignored exports browsable and playable. The list is Uatu's own invention, so users can't predict it. VS Code, the reference most users already have, hides almost nothing: Explorer always shows the project, greys out what Git ignores, and stays fast on huge folders by reading a folder only when it is expanded.

## What Changes

- **BREAKING** (relative to v0.8.0): the built-in exclusions shrink to VS Code's `files.exclude` defaults: VCS metadata (`.git`, `.svn`, `.hg`, `.jj`) and OS litter (`.DS_Store`, `Thumbs.db`). Every other hard-coded name, suffix, and secret pattern is removed, including `build`, `dist`, `node_modules`, `.venv`, `.env`, `*.pem`, and `*.swp`. A project hides more with `.uatu.json ignore.exclude`, which plays the role of VS Code's `files.exclude`.
- **BREAKING**: secret-like files (`.env`, private keys, credential files) are listed, previewed, and served like other files. VS Code works the same way. In Uatu the protection is Hub authentication, and an authenticated user already has the same access through the embedded terminal. A project that wants them out of Uatu excludes them explicitly.
- Git decides what is ignored. Ignored files keep the muted display and the Show ignored files preference added by #607.
- Folders that Git ignores as a whole (for example `node_modules/`, `build/`, `.venv/`, `target/`) are listed but not read during discovery. Expanding one lists that level on demand, as VS Code's Explorer does. A level that has been listed stays known for the session.
- Files written inside an ignored folder while the session runs are indexed as they arrive, so a new render appears in Recent and under the Audio filter without the folder being opened. To bound the cost of something like `npm install`, Uatu keeps only the newest 2,000 such writes per watched root that sit in levels nobody has listed. Older ones leave Recent but come back once their folder is expanded. A file a client has opened stays available.
- Updates from ignored folders travel through a separate batched lane: coalesced by path, published on a slower cadence, and in large patches. Ordinary edits keep their current latency during a build or install.
- Follow never jumps to a Gitignored file, whether or not ignored files are shown. A rebuild or render cannot take over the preview, and an opened ignored file still refreshes in place. This replaces #607's rule that shown ignored files are Follow candidates.
- `ignore.include` is retired before it ships in a stable release. A leftover key produces one configuration warning saying it has no effect.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tree-filtering`: built-in exclusions reduced to VCS metadata and OS litter; secret denials removed; the generated-output include requirement removed; `ignore.include` warns.
- `document-watch-index`: ignored folders are discovered lazily and listed on demand; writes inside them are indexed within a bounded window and published through a batched lane; secret denials are removed from listing and static serving.
- `document-tree`: ignored folders appear as expandable muted rows whose contents load when expanded; the count covers known files.
- `recent-files`: Recent includes files written inside unexpanded ignored folders, within the bounded window.
- `follow-mode`: Gitignored files are never Follow targets, including catch-up and the initial default.
- `media-delivery`: secret-like files are no longer refused by name; files listed on demand or captured from live writes are deliverable.

## Impact

- **Server:** `src/ignore/` (the denylist shrinks to the VS Code defaults; soft `build`/`dist` handling and `include` removed), `src/server/file-index.ts`, `watch-session.ts`, `file-observer.ts`, `watch-policy.ts` (ignored-folder discovery from Git, the on-demand listing, the live-write window with pinning, and the batched lane), `newest-document.ts`, `media-delivery.ts`, and `static-files.ts`. A new internal child route lists one folder level.
- **Client:** `src/sidebar/tree-view.ts` (unloaded-folder rows, expand-to-load, merge), `src/shell/follow.ts`, and the Recent and count models.
- **Wire and API:** snapshots and patches carry ignored-folder entries and their loaded state. This changes the published live-payload schema, so the workspace API revision is bumped. The listing route stays an internal child operation with an explicit non-public exclusion. The Hub broker's document index carries folder entries.
- **Docs:** README.md and docs/FILES.md describe the VS Code-aligned rules, the security stance on secret-like files, and `ignore.exclude` as the way to hide things.
- **Sequencing:** the deltas are written against the requirements introduced by `add-recent-media-browsing`, which were archived into the main specs in #620.
- **Cost:** non-Git roots have no ignore information, so they are discovered eagerly in full; a large `node_modules` there is bounded only by `ignore.exclude`. In the Chokidar polling fallback, unlisted ignored folders are not watched.
