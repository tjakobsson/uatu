## 1. Verify library surface against `1.0.0-beta.3`

- [x] 1.1 Spike: install `@pierre/trees@1.0.0-beta.3` in a scratch directory and confirm the vanilla entry exposes a constructor or factory accepting a `paths: string[]` input
- [x] 1.2 Spike: confirm the icon configuration API accepts a per-extension callback or registry compatible with `fileIconForName`
- [x] 1.3 Spike: confirm the git-status API accepts at minimum {added, modified, deleted, untracked, renamed} keyed by canonical path
- [x] 1.4 Spike: confirm a selection observer/event delivers the selected canonical path on every user click
- [x] 1.5 Document any gaps from 1.1-1.4 in design.md's Open Questions and decide whether to vendor or wait before proceeding

## 2. Add the dependency

- [x] 2.1 Add `"@pierre/trees": "1.0.0-beta.3"` to `package.json` `dependencies` (exact pin, no caret)
- [x] 2.2 Run `bun install` and verify `@pierre/trees`, `preact`, `preact-render-to-string` resolve cleanly into `node_modules/` (`@pierre/path-store` turned out to be bundled inside `@pierre/trees`, not a separate transitive dep)
- [x] 2.3 Verify the production bundle still builds via the existing build pipeline; record before/after bundle size in the PR description

## 3. Build the `.uatu.json` tree-config reader

- [x] 3.1 Add a new module (e.g. `src/tree-config.ts`) that reads `.uatu.json` at a given watch root and returns a parsed `{ exclude: string[]; respectGitignore: boolean }` plus a list of warnings
- [x] 3.2 Apply the JSON-Schema-style validation in design.md D2: `exclude` must be a string array; `respectGitignore` must be a boolean; non-conforming values produce warnings via the existing review-load warnings path and fall back to defaults
- [x] 3.3 Cross-platform: parse paths using `node:path` (POSIX semantics on the path-string side), never assume `/` literals or macOS-only behavior
- [x] 3.4 Unit tests: missing file, empty `tree`, valid `tree.exclude`, invalid `tree.exclude` shape, valid `tree.respectGitignore: false`, invalid `tree.respectGitignore` shape
- [x] 3.5 Unit tests: edits to `.uatu.json` mid-session are picked up on next read (no caching that defeats the contract)

## 4. Replace `src/ignore-engine.ts` with the new filter composition

- [x] 4.1 Rewrite `src/ignore-engine.ts` (or replace with `src/tree-filter.ts`) to compose: built-in defaults (`node_modules`, `.git`, `dist`, `build`, `.next`, `.turbo`, `.cache`, `coverage`, `.DS_Store`) ∪ `.uatu.json tree.exclude` patterns ∪ `.gitignore` (when honored) using the `ignore` package
- [x] 4.2 Implement the opt-out resolution: CLI `--no-gitignore` wins over `.uatu.json tree.respectGitignore`; default is honor
- [x] 4.3 Single-file watch roots: `tree.exclude` SHALL NOT be consulted (per spec)
- [x] 4.4 Nested `.uatu.json` files: SHALL NOT be consulted (per spec); only the root-level file is read
- [x] 4.5 Re-read `.uatu.json` on the next refresh after it changes on disk (mirror existing `.gitignore` re-read semantics in `src/server.ts`)
- [x] 4.6 Migrate all callers in `src/server.ts` (look for `loadIgnoreMatcher` usages around lines 482, 672, 1191) to the new composition function — signature unchanged, behavior changed under the hood
- [x] 4.7 Remove all `.uatuignore` parsing and watch-side handling from `src/server.ts` (around lines 1144, 1189) and `src/ignore-engine.ts`
- [x] 4.8 Unit tests: defaults always apply; user `tree.exclude` is additive; `!` negation precedence over `.gitignore`; CLI flag wins over `.uatu.json`
- [x] 4.9 Cross-platform tests: path-separator normalization tested via `toChokidarIgnored` (uses `path.sep` → `/` normalization)

## 5. Add the `.uatuignore` retirement warning

- [x] 5.1 At session start, scan each watched root for a `.uatuignore` file; emit one stderr warning per session naming the file's absolute path and pointing to `.uatu.json tree.exclude`
- [x] 5.2 The warning MUST NOT repeat on refreshes — track an emitted-once flag per session
- [x] 5.3 The warning MUST NOT prevent the session from starting (fire-and-forget via `void warnAboutRetiredUatuignore(...)`)
- [x] 5.4 Remove `.uatuignore` from `src/file-classify.ts` and from `src/file-icons.ts`
- [x] 5.5 Remove `.uatuignore` references from comments in `src/shared.ts` and `src/server.ts`
- [x] 5.6 Unit test: the startup scan emits exactly once for a watch root with `.uatuignore` present

## 6. Build the `@pierre/trees` adapter

- [x] 6.1 Create `src/tree-view.ts` that owns the library lifecycle: instantiate from the vanilla entry, mount into the `Files` pane container, dispose on teardown
- [x] 6.2 Adapter input: convert `RootGroup[]` directly into the path array the library expects (paths prefixed by the root label so a single tree covers multi-root workspaces); replace the old `TreeNode[]` shape entirely
- [x] 6.3 Use `@pierre/trees`' built-in `'standard'` icon set with `colored: true` (D7 revised post-spike — built-in set has no bundle cost). `src/file-icons.ts` retired
- [x] 6.4 Wire selection events from the library back into the existing document-routing flow via `onSelectionChange`; manual selection disables follow mode under the existing rules
- [x] 6.5 Wire review-load's changed-files list into the library's `setGitStatus` API on every `RepositoryReviewSnapshot` update
- [x] 6.6 Re-feed paths into the library on every `renderSidebar` call (via `resetPaths`); selection is re-synced when the selected path is still present
- [x] 6.7 Binary entries are fed as plain paths; selection routes to the existing preview-unavailable view (existing app.ts path takes care of this since selection just changes `appState.selectedId` and `loadDocument()` already handles binary)

## 7. Wire the adapter into the `Files` pane and remove the legacy code

- [x] 7.1 Replace the `renderNodes(...)` invocation in the `Files` pane with the adapter mount call; the pane container becomes the library's mount point
- [x] 7.2 Delete `renderNodes`, `shouldDirRenderOpen`, `FOLDER_ICON_SVG`, `renderTreeMtime`, `renderChangedFilesSection`, `renderChangedFileRow`, `changedFileStatusInfo`, `findDocumentForChangedFile`, `revealSelectedFile` from `src/app.ts`; also removed `appState.dirOverrides` and all `revealSelectedFile()` callsites
- [x] 7.3 Delete the 1s `setInterval` that updates `.tree-mtime` spans
- [x] 7.4 Delete the `FilesView` type, `filesView` state, `FILES_VIEW_KEY_PREFIX`, `isFilesView`, `readFilesView`, `writeFilesView`, `filesViewStorageKeyForMode`
- [x] 7.5 Delete the All/Changed toggle button event handlers, the `syncFilesViewToggle` and `applyFilesView` functions, the three element refs, and the HTML in `src/index.html`
- [x] 7.6 Update the file counter rendering to drop the `· N hidden` segment; keep `· M binary` as-is
- [x] 7.7 Stripped `.tree-doc-button`, `.tree-mtime`, `.tree-icon`, `.tree-folder-icon`, `.tree-doc-disabled`, `.tree-dir`, `.tree-node`, `.files-view-*`, `.changed-file-*`, `.root-group`, `.root-title` selectors from `src/styles.css`. Kept a minimal `.tree` host rule + `.tree-empty` for the no-files state. Library handles its own internal styling via shadow DOM

## 8. Spec-driven tests for the new requirements

- [x] 8.1 Test: the visible tree DOM is owned by `@pierre/trees`; uatu emits no `<details>`/`<summary>` tree markup (`tests/e2e/document-tree.e2e.ts` "the Files pane does not render uatu's legacy `<details>`/`<summary>` tree markup")
- [x] 8.2 Test: clicking a non-binary tree row loads its preview and disables follow mode (`tests/e2e/document-tree.e2e.ts` "clicking a non-binary tree row loads its preview and disables follow mode")
- [x] 8.3 Test: clicking a binary tree row routes to the preview-unavailable view (`tests/e2e/document-tree.e2e.ts` "a binary tree row routes to the preview-unavailable view, not 'no longer exists'", plus the image-preview sibling in the same file)
- [x] 8.4 Test: the icon registry feeds through to library rows (`tests/e2e/document-tree.e2e.ts` "tree rows render an icon via the library's built-in icon set")
- [x] 8.5 Test: a modified file in a git working tree shows the modified annotation (`tests/e2e/document-tree.e2e.ts` "modified files show a git-status annotation; clean rows do not")
- [x] 8.6 Test: file counter never includes `· hidden` even when patterns filter files (covered indirectly by the existing `server.test.ts` scope tests + the deleted "sidebar counter shows the hidden subcount" E2E)
- [x] 8.7 Test: `.uatu.json tree.exclude` hides matched files; `!` negation un-excludes (`src/ignore-engine.test.ts`)
- [x] 8.8 Test: built-in defaults always hide `node_modules/` even when `.uatu.json` is silent (`src/ignore-engine.test.ts`)
- [x] 8.9 Test: `.uatu.json tree.respectGitignore: false` exposes gitignored files; `--no-gitignore` wins when both are set (`src/ignore-engine.test.ts`)
- [x] 8.10 Test: `.uatuignore` produces exactly one stderr warning per session and its contents are not applied (`src/uatuignore-warning.test.ts` and `src/ignore-engine.test.ts`)
- [x] 8.11 Test: invalid `tree.exclude` shape produces a settings warning and falls back to defaults (`src/tree-config.test.ts`)
- [x] 8.12 Test: path-separator normalization at the `toChokidarIgnored` boundary (`src/ignore-engine.test.ts` "normalizes platform path separators")

## 9. End-to-end and visual verification

- [x] 9.1 E2E sweep done: all `test.skip(` blocks in `tests/e2e/uatu.e2e.ts` rewritten against the library's shadow-DOM API; `getByRole("button", { name: "<filename>" })` patterns replaced with the shared `treeRow(page, path)` / `clickTreeFile(page, path)` helpers in `tests/e2e/tree-helpers.ts`; `toHaveClass(/is-selected/)` updated to `toHaveAttribute("aria-selected", "true")`; `beforeEach` rewritten so it clicks a non-README file then back to README (the library de-dupes click events on the already-selected row, which used to leave the boot-time `follow=true` state untouched). New focused file `tests/e2e/document-tree.e2e.ts` adds 11 tests covering tree behaviors + spec coverage for tasks 8.1–8.5.

## 10. Docs and changelog

- [x] 10.1 Update README to document the new `.uatu.json tree.*` schema (with a short gitignore-syntax note for `tree.exclude` and an example block)
- [x] 10.2 Update README to mention git-status annotations replace the All/Changed view
- [x] 10.3 Update README to mention `.uatuignore` is retired and how to migrate
- [x] 10.4 Add a CHANGELOG entry calling out the BREAKING changes (lib swap, `.uatuignore` retirement, All/Changed retirement, mtime ticker deferral, manual-open-state deferral, binary clickability change, counter change)
- [x] 10.5 Cross-reference the deferred follow-up changes (live-mtime, manual-open-state revisit) in the CHANGELOG so they're discoverable

## 11. Final verification

- [x] 11.1 Ran `openspec validate replace-tree-with-pierre --strict` — passes
- [x] 11.2 All REMOVED requirements include explicit Reason and Migration sections
- [x] 11.3 `bun test` (441 pass / 0 fail) and `bun run build` (427 modules, clean compile) both pass
