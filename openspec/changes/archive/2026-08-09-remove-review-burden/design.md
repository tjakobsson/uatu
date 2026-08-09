# remove-review-burden — design

## Context

`src/review/load.ts` does three jobs: (A) a git data sweep (changed files vs a ref, commit log, repository metadata) that feeds Change Overview's file list, tree annotations, the diff view's base, and the git-log pane; (B) the scoring engine (weights, drivers, levels, thresholds, `.uatu.json review` settings); (C) data for the burden UI (meter card, score-explanation preview). Only A has consumers the user actually uses. The compare-target toggle ("Since base" / "Since last commit") is welded to the burden vocabulary but is really the diff-base chooser; it stays. `watch-session.ts` precomputes snapshots for both targets (`Record<ReviewCompareTarget, RepositoryReviewSnapshot[]>`) — that structure stays in this change; only its contents shrink.

Constraints: deletions and renames only — no new features, no behavior change to anything kept. The user base is single-digit; no compatibility shims. Per release-note discipline, the removal is user-visible and gets a truthful visible entry.

## Goals / Non-Goals

**Goals:**
- Delete scoring and its UI completely, including specs and tests that pin them.
- Keep the compare toggle, changed-files context, tree annotations, diff view, git log, and untracked indicator pixel-equivalent (minus the meter card).
- Leave no "review(-burden)" naming pointing at a deleted concept.
- Relocate the surviving git sweep out of `src/review/` so the folder disappears.

**Non-Goals:**
- The commit-picker Compare feature (future change).
- Collapsing the dual per-target precompute or any watch-session performance work beyond what deletion yields for free.
- Touching `.uatu.json` blocks other than `review` (the `tree`/`terminal`/`mono` blocks are the `simplify-repo-config` change).

## Decisions

1. **The git sweep moves to `src/document/git-data.ts` (name flexible), not a new top-level folder.** `document/` already owns per-document git concerns (`git-base-ref.ts`, `diff.ts`, `classify.ts`); the repository-level sweep is the same domain one level up. Deleting `src/review/` entirely (rather than leaving a slimmed file there) keeps the folder map honest — the module-structure spec's folder enumeration is updated at sync time. Alternative: keep `review/` renamed to `git/` — rejected; a second git-named folder next to `document/`'s git files splits one domain across two homes.
2. **`ignoredFiles` collapses into `changedFiles`.** The array existed only because `review.ignoreAreas` excluded files from the score while the tree/indicator still needed them. With no score there is no exclusion; every consumer that unioned `changedFiles + ignoredFiles` now just reads `changedFiles`. `gitIgnoredFiles` (git's own ignore policy) is unrelated and stays.
3. **Renames are mechanical and total.** `ReviewCompareTarget` → `CompareTarget`, `ReviewBase` → `CompareBase`, `RepositoryReviewSnapshot` → `RepositorySnapshot`, `reviewLoad` payload field → flattened fields the consumers actually use (`changedFiles`, `commitLog`, `base`, `warnings`). The compare control's group label becomes "Compare against". Grep for `review`/`burden` at the end must hit only git history, the archived change, and unrelated words.
4. **`.uatu.json` parse warnings keep their channel.** Warnings currently ride the review result into Change Overview. They become `configWarnings` on the repository snapshot with identical display behavior — tree-filtering's spec scenario ("warning surfaced through the existing settings warnings path") stays true, only the path's name changes.
5. **`git-base-ref.ts` loses its configured-ref input.** The resolution order becomes purely automatic (`origin/HEAD` → `origin/main` → `origin/master` → `main` → `master` → dirty-worktree fallback). The anchor display ("vs origin/main") is kept — it is the compare control's truth label, not a score artifact.
6. **Metrics sink moves with the sweep.** `cli.ts`'s `setGitMetricsSink` import follows the relocated module; the debug/metrics counters that only measured scoring are deleted rather than relocated.

## Risks / Trade-offs

- [Hidden consumer of a scoring field (e.g. e2e asserting meter presence) breaks late] → Delete specs/tests in the same commit as the code; run full unit + e2e suites; the module-structure spec's `change-overview.e2e.ts` file keeps existing with non-scoring assertions.
- [Payload shape change breaks the SPA silently for cached clients] → The payload is same-build client/server today; the separate `cache-discipline` change addresses skew generally. Within this change, renamed fields fail loudly in TypeScript.
- [Deleting `review.baseRef` strands a repo whose base genuinely isn't the automatic order] → Accepted: auto-resolution covers all current users; the future commit-picker is the designed replacement for exceptional bases.
- [Docs drift: CLAUDE.md/ARCHITECTURE.md/README still describe the score] → Explicit tasks; the product one-liner changes ("watches a docs tree and previews Markdown/AsciiDoc with a review-load score" loses its last clause).

## Migration Plan

Single PR, single release. `.uatu.json` `review` blocks become inert (parse ignores unknown keys silently — no warning added, since the block is documented as removed in release notes). Rollback = revert.

## Open Questions

- None blocking. Naming of the relocated module (`document/git-data.ts` vs `document/repository.ts`) is implementer's choice at apply time.
