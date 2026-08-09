# remove-review-burden

## Why

The review-burden score — the meter, levels, drivers, thresholds, and its score-explanation preview — is unused in practice, yet it is one of the heaviest concepts in the codebase: an 833-line scoring engine, dedicated sidebar UI, a `.uatu.json` configuration surface, and "review" naming threaded through the shared types and the watch pipeline. It is being removed as part of the 0.5.0 debt-paydown (deletions only, no new features), keeping the parts that earn their keep: the compare-target toggle and the git change data that feed the changed-files view, diff view, tree annotations, and git log.

## What Changes

- **BREAKING (removal):** the review-burden score is removed end to end — scoring engine (weights, drivers, levels, thresholds) in `src/review/load.ts`, the burden-meter card in Change Overview, the score-explanation preview (`sidebar/score-explanation.ts`, `sidebar/review-score-mount.ts`), the files-filter burden hint, and all specs/tests/e2e pinning scoring behavior.
- **BREAKING (config):** the `review` block of `.uatu.json` is removed entirely — `thresholds`, `riskAreas`, `supportAreas`, `ignoreAreas`, and `baseRef`. Base resolution relies solely on the existing automatic order (`origin/HEAD` → `origin/main` → `origin/master` → `main` → `master`, with the dirty-worktree fallback). With `ignoreAreas` gone, the changed-files/ignored-files split collapses to a single changed-files list.
- The git data layer survives and relocates: changed-files-vs-ref, commit log, and repository metadata move out of `src/review/` (which is deleted) into `src/document/`-adjacent git territory, including the `setGitMetricsSink` hook that `cli.ts` currently imports from `review/load`. `.uatu.json` parse warnings keep their surfacing path in Change Overview under a scoring-free name.
- Orphaned "review" naming is renamed to "compare": `ReviewCompareTarget` → `CompareTarget`, `ReviewBase` → `CompareBase`, the compare control's accessible name drops "review burden", and payload fields shed the `reviewLoad` wrapper. Pure renames — behavior is unchanged.
- **Kept as-is:** the "Since base" / "Since last commit" toggle with its per-client, personally-persisted semantics; the resolved-ref anchor display; the changed-files list, untracked indicator, tree git-status annotations, Changed filter, diff view, and git-log pane. The future commit-picker Compare is explicitly out of scope, as is collapsing the dual per-target sweep in `watch-session.ts`.

## Capabilities

### New Capabilities

_None — this change only removes and renames._

### Modified Capabilities

- `change-review-load`: scoring requirements removed (deterministic burden computation, scoring configuration, level classification, meter-width anchor rendering); compare-target selection and anchor reporting are restated without burden/score references and without `review.baseRef`.
- `sidebar-shell`: the Change Overview requirement is restated as repository/change context (branch, dirty state, resolved base anchor, changed files, untracked indicator, config warnings) with the score, level, drivers, and score-explanation preview removed.
- `document-diff-view`: base-ref resolution priority no longer includes a configured `review.baseRef`.
- `document-tree`: the Changed-filter reduction and git-status annotation requirements are restated over the single changed-files list (the `ignoredFiles`/`ignoreAreas` distinction no longer exists).

## Impact

- Deleted: `src/review/` (load.ts + tests), `src/sidebar/score-explanation.ts`, `src/sidebar/review-score-mount.ts`, burden markup/CSS in `src/sidebar/change-overview.ts`, scoring e2e coverage.
- Edited: `src/shared/types.ts` (types/renames), `src/server/watch-session.ts` (snapshot assembly keeps dual targets, loses scoring), `src/document/git-base-ref.ts` (drops configured-ref input), `src/cli.ts` (metrics sink import path), `src/sidebar/files-filter.ts`, docs (`CLAUDE.md`, `ARCHITECTURE.md`, README positioning — the "review-load score" is no longer part of the product description).
- `.uatu.json` files containing a `review` block: the block is ignored after this change; release notes call it out (user base is single-digit, no migration shim).
- The `change-review-load` capability keeps its historical folder name in `openspec/specs/`; its purpose statement is rewritten at sync time to describe compare/change-data only.
- Release-note framing: a visible `feat`-scoped removal entry (behavior users can see), not a chore.
