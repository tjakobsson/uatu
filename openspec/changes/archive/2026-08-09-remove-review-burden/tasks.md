# remove-review-burden — tasks

## 1. Relocate the surviving git data layer

- [x] 1.1 Move the git sweep (changed-files-vs-ref, commit log, repository metadata collection) and `setGitMetricsSink` from `src/review/load.ts` into `src/document/` (e.g. `document/git-data.ts`), updating `cli.ts` and `watch-session.ts` imports; keep behavior identical.
- [x] 1.2 Move the surviving tests (data sweep, commit log, base anchor) alongside the new module; leave scoring tests behind for deletion.
- [x] 1.3 Re-home `.uatu.json` parse warnings as `configWarnings` on the repository snapshot with unchanged Change Overview display.

## 2. Delete scoring and its UI

- [x] 2.1 Delete the scoring engine from the relocated module's origin: `scoreReviewLoad`, drivers, levels, thresholds, `review` settings parsing (`thresholds`, `riskAreas`, `supportAreas`, `ignoreAreas`, `baseRef`) and their tests; then delete `src/review/` entirely.
- [x] 2.2 Delete `src/sidebar/score-explanation.ts`, `src/sidebar/review-score-mount.ts`, the burden-meter markup/CSS and score-explanation routing in `src/sidebar/change-overview.ts`, and the files-filter burden hint in `src/sidebar/files-filter.ts`.
- [x] 2.3 Collapse `ignoredFiles` into `changedFiles` everywhere (`shared/types.ts`, watch-session snapshot assembly, tree annotations, Changed filter, untracked indicator) — `gitIgnoredFiles` stays untouched.
- [x] 2.4 Drop the configured-ref input from `src/document/git-base-ref.ts`; resolution is automatic only. Keep the anchor (`comparedAgainstRef`) and the targets-collapsed behavior.
- [x] 2.5 Delete scoring-only debug/metrics counters; keep git-sweep timing metrics.

## 3. Rename review → compare

- [x] 3.1 Rename types and fields: `ReviewCompareTarget` → `CompareTarget`, `ReviewBase` → `CompareBase`, `RepositoryReviewSnapshot` → `RepositorySnapshot`, payload `reviewLoad` → flattened change-data fields; update all importers.
- [x] 3.2 Rename the compare control's accessible name to "Compare against"; keep the visible "Since base" / "Since last commit" labels and all toggle semantics unchanged.
- [x] 3.3 Final grep gate: `grep -ri "burden"` and review-burden-flavored `review` identifiers return no product-code hits.

## 4. Tests, specs, docs

- [x] 4.1 Update unit suites for renamed types and the collapsed changed-files list; delete scoring test files.
- [x] 4.2 Update e2e: remove meter/score-explanation coverage from `change-overview.e2e.ts` (file remains with pane assertions); verify tree annotations, Changed filter, diff view, and compare-toggle e2e still pass unchanged.
- [x] 4.3 Update `CLAUDE.md` (folder map: `review/` gone, `document/` gains the git data layer; product one-liner loses "review-load score"), `ARCHITECTURE.md`, and README positioning.
- [x] 4.4 Remove `review` block documentation from any `.uatu.json` docs/examples in the repo (`testdata/` included).

## 5. Verification

- [x] 5.1 Full `bun test` and `bun test:e2e` green.
- [x] 5.2 Manual pass on `bun run dev`: Change Overview shows branch/dirty/anchor/warnings/untracked, both compare targets recompute the changed-files view and diff, git-log pane intact, no burden UI anywhere.
- [x] 5.3 Release-note prep: visible removal entry describing the user-facing delta (score/meter/explanation gone; `.uatu.json review` block retired), honoring the release-note discipline in CLAUDE.md.
