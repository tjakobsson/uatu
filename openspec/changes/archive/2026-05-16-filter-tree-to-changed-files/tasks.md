## 1. Filter state machinery

- [x] 1.1 Add filter-state types in `src/app.ts`: `type FilesPaneFilter = "all" | "changed"`. Add `filesPaneFilter: FilesPaneFilter` to `appState`, keyed by current Mode. Mirrors the existing per-Mode pattern used for pane state.
- [x] 1.2 Add localStorage helpers `readFilesPaneFilterPreference(mode)` and `writeFilesPaneFilterPreference(mode, value)`. Storage key: `uatu.filesPaneFilter.${mode}`. Defaults when absent: `"changed"` for Review, `"all"` for Author.
- [x] 1.3 Read the persisted/default value on boot and on Mode switch; apply it to `appState.filesPaneFilter` and re-render the sidebar.

## 2. Compute the filtered path set

- [x] 2.1 In `src/app.ts`, compute the change-set membership lookup from each repository's `reviewLoad`: `Set<string>` of repo-root-relative paths from `changedFiles ∪ ignoredFiles`. Exclude `gitIgnoredFiles`. Compute this on every refresh that touches `appState.repositories`.
- [x] 2.2 When the filter is `Changed`, derive the reduced path set: for each watched root, keep only docs whose repo-root-relative path is in the change-set membership lookup, then add all ancestor directories of those leaves. Reuse `ancestorPaths` logic where possible.
- [x] 2.3 Pass the reduced path set into `TreeView.update(...)`. The view will call `resetPaths(paths, { initialExpandedPaths })` with the ancestor dirs auto-expanded.

## 3. Expansion-state preservation across toggle

- [x] 3.1 In `src/tree-view.ts`, add `private fullTreeExpansionSnapshot: string[] | null = null;`. When the filter transitions from `All` to `Changed`, snapshot `readExpandedPaths()` before calling `resetPaths`.
- [x] 3.2 When the filter transitions from `Changed` to `All`, pass `fullTreeExpansionSnapshot` (if non-null) as `initialExpandedPaths` to `resetPaths`, then clear the snapshot.
- [x] 3.3 Add a unit test for `tree-view.ts` covering the snapshot/restore cycle (pure function or controller-level; mock the library where needed).

## 4. Follow-override reveal

- [x] 4.1 In `src/tree-view.ts`, when `update()` is called with filter `Changed` AND a `selectedDocumentId` whose path is NOT in the filtered set, augment the path set passed to `resetPaths` with `selectedPath` plus its ancestors. Track which path is currently the temporary inclusion (`private followOverridePath: string | null`).
- [x] 4.2 When `update()` is next called with a different selection that IS in the filtered set, drop the temporary inclusion automatically (it's no longer needed). When called with a different selection that is also NOT in the filtered set, replace the temporary inclusion.
- [x] 4.3 Apply a `data-uatu-filter-reveal="true"` attribute on the temporarily-included row's host element via the library's `renderRowDecoration` hook (or equivalent). Style it in `src/styles.css` with subtle opacity reduction and italic. Keep the cue distinct from the `ignored` annotation styling.
- [x] 4.4 Verify the filter chip continues to read `Changed` (no spurious toggling) when a follow-override reveal happens.

## 5. Files-pane chip UI

- [x] 5.1 Add the chip's DOM to `src/index.html` (or wherever the Files-pane header is composed). Two segmented buttons `All` / `Changed`, with proper ARIA (`role="radiogroup"` + `role="radio"` + `aria-checked`).
- [x] 5.2 Style the chip in `src/styles.css` so it visually pairs with the file count display in the Files-pane header. Active segment uses the existing accent treatment from the Mode control; inactive segment is muted.
- [x] 5.3 Wire click handlers in `src/app.ts` that update `appState.filesPaneFilter`, persist via `writeFilesPaneFilterPreference`, and re-render the sidebar.
- [x] 5.4 Add a `title` / tooltip on `Changed` describing what it filters against (e.g. `Show only files changed vs <base>`); derive `<base>` from the active repository's `reviewLoad.base`. Fall back to `Show only changed files` when base is unavailable.

## 6. File count display under filter

- [x] 6.1 Update the file count render path in `src/app.ts:renderSidebar` (line ~2000) to produce `N of M files` when filter is `Changed`, where N is `treeView.getVisiblePathCount()` (or equivalent) and M is the unfiltered total. Keep the existing `· M binary` segment when applicable; the binary count under filter is the filtered binary count, not the total binary count.
- [x] 6.2 Add a small helper on `TreeView` to expose `getVisibleLeafCount()` and `getVisibleBinaryLeafCount()` so the count is sourced from the same data the library is rendering.

## 7. Empty state

- [x] 7.1 In `src/app.ts:renderSidebar`, when filter is `Changed` and the computed filtered set is empty, hide the `#tree` element and render the empty-state message into `#tree-empty-message` (or a sibling container). Copy: `No changes vs <base>` when `reviewLoad.status === "available"`; `Changed filter is unavailable — no git repository` otherwise. Disposing the tree-view on empty state is fine (it reuses the existing dispose path when `totalCount === 0`).
- [x] 7.2 When the filter is toggled back to `All` or the change set becomes non-empty (refresh), restore the tree by calling `ensureTreeView()` again.

## 8. Tests

- [x] 8.1 Unit tests in `src/app.ts` or a new file for the filter-membership computation: an untracked file in `changedFiles` IS in the set, an `ignoreAreas`-matched file in `ignoredFiles` IS in the set, a file in `gitIgnoredFiles` is NOT in the set.
- [x] 8.2 E2e test: chip defaults to `Changed` in Review and `All` in Author; persists across reload independently per Mode.
- [x] 8.3 E2e test: when filter is `Changed`, only change-set rows and their ancestors are present in the tree (`data-item-path` queries).
- [x] 8.4 E2e test: when filter is `Changed` and the change set is empty (clean working tree against `HEAD`), the empty state names the review base.
- [x] 8.5 E2e test: follow-mode auto-switch to an unfiltered path under filter `Changed` reveals that one row with `data-uatu-filter-reveal="true"`; the chip stays on `Changed`.
- [x] 8.6 E2e test: toggling filter `All` → `Changed` → `All` restores manually-expanded directories from the first `All` view.
- [x] 8.7 E2e test: `N of M files` count display matches the visible tree under filter; binary subcount reflects only filtered binaries.
- [x] 8.8 E2e test: gitignored file under filter `Changed` is NOT rendered (it's annotated as `ignored` under `All`, but the filter intentionally excludes it).

## 9. Cross-check and ship

- [x] 9.1 Run `bun test` and the Playwright suite end-to-end. No existing tests should depend on the file count format being `N files` when the new chip is on (which it won't be by default in Author tests).
- [x] 9.2 `bunx tsc --noEmit` should not produce any new errors in `src/app.ts` or `src/tree-view.ts`.
- [x] 9.3 Manually verify against this repo with PR #55's branch checked out: under filter `Changed` in Review mode, the tree shows only the touched files; toggling to `All` restores the full tree with the previously-expanded directories intact; toggling back to `Changed` quickly reproduces the filtered view.
- [x] 9.4 Manually verify the follow-override reveal: with filter `Changed` and Follow enabled, edit a file not in the change set (e.g. add a comment to an untouched file) and confirm the row appears with the visual cue and the chip stays on `Changed`.
- [x] 9.5 Update `CHANGELOG.md` with a single line under the unreleased section.
- [x] 9.6 Run `bunx openspec validate filter-tree-to-changed-files` and `bunx openspec validate --strict filter-tree-to-changed-files`; fix any reported issues.
