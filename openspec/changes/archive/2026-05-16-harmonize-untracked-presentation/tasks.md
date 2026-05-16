## 1. Confirm contract callers

- [x] 1.1 Grep the repo for consumers of `ChangedFileSummary.status` (besides `app.ts:mapChangedFileStatus`) and confirm none rely on untracked files being reported as `"A"`. Record findings in the PR description so reviewers can verify the sweep was exhaustive.
- [x] 1.2 Confirm `app.ts:mapChangedFileStatus` already routes `"?"`/`"U"` → `"untracked"` (it does, today, as dead code). No edit needed here yet — the existing branch becomes live in step 2.1.

## 2. Emit correct status letters from review-load

- [x] 2.1 In `src/review-load.ts`, change `collectUntrackedFiles` to set `status: "?"` on each `ChangedFileSummary` it produces. Keep `additions = file line count`, `deletions = 0`, `hunks = additions > 0 ? 1 : 0` unchanged so the burden score for an otherwise identical change does not move.
- [x] 2.1a Augment `collectDiffFiles` with a parallel `git diff --name-status -M ...` probe (`collectNameStatus` helper) and pass the resulting `Map<path, status-letter>` into `parseNumstatLine`. Use the name-status letter as the source of truth; fall back to the rename-vs-modify heuristic only when name-status has no entry for that path. This makes staged-added files emit `"A"` (not `"M"`) and ensures deletions emit `"D"`. (Discovered necessary during 2.3.)
- [x] 2.2 Add a unit test in `src/review-load.test.ts` that creates an untracked file in a temp repo, runs review-load, and asserts the entry's `status` begins with `"?"`. Asserts both the inclusion in `changedFiles` and the distinct category label.
- [x] 2.3 Add (or extend) a test that creates a staged-but-uncommitted file (`git add` without commit) and asserts its `status` begins with `"A"` and does NOT begin with `"?"` or `"M"`. This pins the boundary between the two categories.
- [x] 2.3a Add tests for the remaining tracked categories: a modified tracked file emits `"M"`, a deleted tracked file emits `"D"`, and a renamed tracked file emits `"R"` with `oldPath` populated.
- [x] 2.4 Add a regression test that two otherwise-identical repository states — one where the new file is untracked, one where it has been `git add`ed — produce the same numeric burden `score` and `level`. Demonstrates that the category change is presentation-only.

## 3. Verify tree annotation lands

- [x] 3.1 Add a DOM- or e2e-level test that confirms an untracked file in the watched root produces a tree row whose git-status annotation reflects the library's `untracked` status (distinct from `added`). One test is sufficient; the mapping in `mapChangedFileStatus` is exhaustively unit-tested elsewhere.
- [x] 3.2 Manually verify in the running app that a freshly created untracked file in the uatu repo itself renders with the distinct annotation (different glyph/color from an `Added` row).

## 4. Categorical indicator in Change Overview pane

- [x] 4.1 In `src/app.ts:renderChangeOverview`, compute per-repository `hasUntracked = repository.reviewLoad.changedFiles.some(file => file.status.startsWith("?"))`. Render a single small categorical badge or inline note inside the existing `<section class="review-repo">` block when `hasUntracked` is true. No count.
- [x] 4.2 Style the indicator (CSS in `src/styles.css`) so it visually reads as a status flag analogous to the existing dirty indicator — not as a button, not as a stat. Verify it remains legible at narrow sidebar widths down to `SIDEBAR_MIN_WIDTH`.
- [x] 4.3 Add a test that mounts the Change Overview pane with a `reviewLoad` containing one untracked file and asserts the indicator renders.
- [x] 4.4 Add a test that mounts the Change Overview pane with a `reviewLoad` containing only tracked changes and asserts the indicator does NOT render (no empty placeholder).
- [x] 4.5 Add a test that toggles Mode between Author and Review with at least one untracked file present and asserts the indicator continues to render with the same text in both Modes.

## 5. Untracked subcount in score-explanation preview

- [x] 5.1 Identify the score-explanation preview rendering path. Add an "Untracked files" factual change-shape input alongside the existing mechanical drivers (Changed files, Touched lines, Diff hunks, Directory spread). It MUST appear only when at least one entry has status starting with `"?"`.
- [x] 5.2 Confirm via test that adding the row does not change the numeric review-burden score for an identical change. Burden score is computed from `changedFiles`; the new row is presentation-only. (Coverage: `src/review-load.test.ts` "untracked and staged-added states produce the same review-burden score"; e2e test "Score-explanation preview breaks out the untracked subcount" additionally asserts the row's score contribution renders as `0`.)
- [x] 5.3 Add a test asserting the row is absent when `changedFiles` has no untracked entries.

## 6. Cross-check and ship

- [x] 6.1 Re-run the full test suite (`bun test` and the Playwright e2e suite) and confirm no other test depended on untracked files being reported as `"A"`. If any test did, update it explicitly with a comment naming this change so the dependency is visible. (535 unit tests pass; 150 Playwright tests pass; no existing tests required updates.)
- [x] 6.2 Run the app against a workspace with mixed tracked-added and untracked files and visually confirm: tree shows two distinct annotations; Change Overview shows the categorical indicator; score-explanation preview shows the new row; numeric burden score is unchanged versus a snapshot taken before the change with the same files staged.
- [x] 6.3 Update `CHANGELOG.md` with a single line under the unreleased section noting that untracked files now have a distinct category in the tree, Change Overview, and score explanation. Do not document anything from the project's existing feedback memories that should stay quiet.
- [x] 6.4 Run `bunx openspec validate harmonize-untracked-presentation` and `bunx openspec validate --strict harmonize-untracked-presentation` and resolve any reported issues before merging.

## 7. Decouple annotation pipeline from score-policy filtering

Discovered during manual verification: when `.uatu.json review.ignoreAreas` matches an untracked path (e.g. `openspec/**/tasks.md`, `openspec/**/spec.md`), the tree silently drops the git annotation for that file because `collectGitStatusEntries` iterates only `reviewLoad.changedFiles` and ignored entries are routed into `reviewLoad.ignoredFiles`. `ignoreAreas` is a score policy, not a visibility policy.

- [x] 7.1 In `src/app.ts:collectGitStatusEntries`, iterate `[...repo.reviewLoad.changedFiles, ...repo.reviewLoad.ignoredFiles]` rather than `changedFiles` alone. The downstream tree mapping handles each entry the same way.
- [x] 7.2 In `src/app.ts:renderChangeOverview`, broaden the `hasUntracked` predicate to consider both `changedFiles` and `ignoredFiles`. The score-explanation preview's untracked sub-driver stays sourced from `changedFiles` only (it describes the score).
- [x] 7.3 Add an e2e test creating an untracked file whose path matches a configured `ignoreAreas` pattern and assert the tree row carries `data-item-git-status="untracked"`.
- [x] 7.4 Add an e2e test where every untracked file is matched by `ignoreAreas`: the Change Overview untracked indicator renders, the score-explanation preview's untracked subcount row does NOT render.
- [x] 7.5 Manually verify against the `openspec/changes/<name>/` scaffold in this repo: all of the untracked files now show the untracked annotation in the tree.

## 8. Surface gitignored files as a distinct annotation

Discovered during manual verification: `.claude/settings.local.json` (excluded by the user's global `core.excludesFile`) appears in the tree with no annotation, indistinguishable from a clean tracked file. The library already supports an `ignored` status; we need to feed it.

- [x] 8.1 Add `gitIgnoredFiles: string[]` to `ReviewLoadResult` in `src/shared.ts`. Initialize empty in `unavailableReviewLoad` and in the `scoreReviewLoad` return.
- [x] 8.2 In `src/review-load.ts`, add `collectKnownTreePaths` (realpath-resolves repo root + each watched root, emits repo-root-relative paths normalized to forward slashes) and `collectGitIgnoredFiles` (runs `git ls-files --others --ignored --exclude-standard`, intersects with `knownTreePaths`).
- [x] 8.3 Thread `RootGroup[]` into `snapshotGroup` (via a per-group filter inside `collectRepositorySnapshots`) and invoke the new helpers alongside the existing `Promise.all` block.
- [x] 8.4 In `src/app.ts:mapChangedFileStatus`, add a `"!"` → `"ignored"` branch.
- [x] 8.5 In `src/app.ts:collectGitStatusEntries`, after the changedFiles + ignoredFiles loop, iterate `repo.reviewLoad.gitIgnoredFiles` and emit one annotation entry per watched root with `status: "ignored"`.
- [x] 8.6 Unit tests in `src/review-load.test.ts`: (a) a `.gitignore`-matched file visible in the tree is exposed on `gitIgnoredFiles` and absent from `changedFiles` / `ignoredFiles`; (b) gitignored paths outside the tree's known paths are NOT exposed; (c) the burden score is unaffected by the presence of gitignored files.
- [x] 8.7 E2e test in `tests/e2e/uatu.e2e.ts`: a file matched by `.gitignore` (with uatu's `respectGitignore` opted out so the file remains in the tree) carries `data-item-git-status="ignored"`.
- [x] 8.8 Manually verify in the running app: `.claude/settings.local.json` now shows the `ignored` annotation (dimmed row, per `@pierre/trees` default treatment) and is visually distinguishable from both clean tracked files and untracked files.
