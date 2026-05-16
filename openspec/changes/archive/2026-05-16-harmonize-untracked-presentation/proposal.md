## Why

Untracked files participate in review-burden scoring and appear in the document tree, but they're invisible as a *category*: `review-load` collapses them into status `"A"` (added) before they reach the UI, so the tree renders them with an "added" annotation and the Change Overview pane never names them at all. Reviewers therefore can't tell that an untracked file is *not yet in git*, which matters because untracked entries are commonly stray artifacts (`debug.log`, scratch files) that belong in `.uatu.json tree.exclude` or `.gitignore` rather than in the review. Fixing this is also a prerequisite for a future "show only changed files" tree filter: that filter must inherit a coherent definition of "change" from Change Overview, and right now the two surfaces disagree on categories.

## What Changes

- `change-review-load`: `ChangedFileSummary.status` MUST distinguish untracked, added, modified, deleted, and renamed entries by their first character (`"?"`, `"A"`, `"M"`, `"D"`, `"R"` respectively). Today the pipeline derives `status` from `git diff --numstat`, which cannot tell additions from modifications and so reports staged-added files as `"M"`; `collectUntrackedFiles` also collapses untracked files into `"A"`. Both gaps are closed by augmenting the diff pipeline with `git diff --name-status` data and by emitting `"?"` for untracked files. The set of files included in `changedFiles` is unchanged. The review-burden score for an otherwise identical change is unchanged (score depends on counts, not status labels).
- `sidebar-shell`: the `Change Overview` pane MUST surface a categorical indicator when the current change includes untracked files (a status flag, not a count). The score-explanation preview MUST break out the untracked subcount within its existing "factual change-shape inputs" drivers.
- `document-tree`: the row annotation pipeline MUST source from the **union** of `reviewLoad.changedFiles` and `reviewLoad.ignoredFiles`. Today it iterates only `changedFiles`, which means any file matched by an `ignoreAreas` pattern in `.uatu.json` loses its git-status annotation in the tree even though the file is, factually, untracked or modified. `ignoreAreas` is a *score policy*, not a *visibility policy*; the tree's annotation must reflect git truth.
- `sidebar-shell` (companion): the `Change Overview` "includes untracked files" indicator MUST likewise count untracked entries from both `changedFiles` and `ignoredFiles` (it describes a workspace fact, not a score input). The score-explanation untracked subcount continues to use `changedFiles` only (it describes the score).
- `change-review-load` + `document-tree`: surface gitignored files visible in the tree as a distinct annotation category. Currently a file like `.claude/settings.local.json` (excluded by `core.excludesFile`) appears in uatu's tree with no annotation, visually identical to a clean tracked file even though git refuses to track it at all. A new `ReviewLoadResult.gitIgnoredFiles` field (string array, server-side intersected with the tree's known paths to avoid shipping huge ignore hierarchies) feeds an `ignored` annotation through the existing `@pierre/trees` API. Burden score is unaffected.
- Implementation: the tree's already-spec-mandated annotations (from `document-tree`'s "added, modified, deleted, and untracked" requirement) start working correctly across all categories because review-load now emits the correct status for each. No `document-tree` spec change.
- Dead code in `app.ts:mapChangedFileStatus` covering `"?"`/`"U"` becomes live — no longer dead. The `"A"` branch becomes meaningful for staged-added files that previously routed through the `"M"` branch.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
- `change-review-load`: tighten the status contract on `ChangedFileSummary` so untracked files are distinguishable from tracked-added files; add a new `gitIgnoredFiles` field that exposes files visible in the tree which git considers ignored.
- `sidebar-shell`: extend the Change Overview pane and score-explanation preview to surface the untracked category alongside the existing dirty/score indicators.
- `document-tree`: clarify that git-status row annotations are sourced from the union of `changedFiles` and `ignoredFiles` — i.e. files excluded from score by `ignoreAreas` still display their git status in the tree. Add `ignored` as a supported annotation status for files exposed via `gitIgnoredFiles`.

## Impact

- **Code**: `src/review-load.ts` (`collectUntrackedFiles` emits `"?"`; `collectDiffFiles` augments `--numstat` output with `--name-status` data so `parseNumstatLine` can stamp the correct `A`/`M`/`D`/`R` letter), `src/app.ts` (`renderChangeOverview` untracked indicator; score-explanation preview untracked driver; `collectGitStatusEntries` now iterates `changedFiles` and `ignoredFiles`; `hasUntracked` likewise considers both). `mapChangedFileStatus` in `src/app.ts` already maps `"?"`/`"U"` → `"untracked"`, `"A"` → `"added"`, `"M"` → `"modified"`, `"D"` → `"deleted"`, `"R"` → `"renamed"` and becomes live without modification.
- **Tests**: `src/review-load.test.ts` (assert untracked emits `"?"`), browser/e2e coverage for the Change Overview untracked indicator and the tree's distinct annotation.
- **APIs**: `ChangedFileSummary` shape stays the same; the *values* its `status` field can take now meaningfully include `"?"`. Downstream consumers that case-match on the first character of `status` keep working (none currently in repo besides `mapChangedFileStatus`).
- **Specs**: deltas to `change-review-load` and `sidebar-shell`. No new top-level capabilities.
- **Out of scope**: tree filtering ("changed-only" view) is a follow-up change. Adjusting how `.uatuignore`/`.gitignore` interact with untracked is out of scope.
