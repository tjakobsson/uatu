## Why

uatu's promise is to show review burden the way a *reviewer* sees it: the whole change measured against the base branch (merge-base of the review base and `HEAD`). But while authoring, people also think in plain git terms — "what have I touched since my last commit?" Today that second question is unanswerable in the Change Overview: the base is auto-resolved and only falls back to `HEAD` when no base exists. Authors should be able to deliberately switch the lens between the reviewer's view and their working view, without losing the burden framing that makes uatu distinct.

## What Changes

- Add a **compare-mode** control to the Change Overview panel with two presets: **Since base** (default — the resolved review base, the current behavior and the product's hero) and **Since last commit** (diff against `HEAD`).
- The control is a 2-item segmented toggle. It expresses *intent* in plain language and never shows raw refs, so its labels stay stable regardless of repository configuration.
- **The review-burden score recomputes for the selected mode.** The score always means "burden of the diff currently shown." There is one rule, not two.
- Make the compare mode a **single global concept** that flows into both the burden snapshot *and* the per-document Diff view, so a file's diff matches the mode the overview is in. Switching the overview to "Since last commit" makes file diffs compare against `HEAD` too.
- Anchor the burden readout with a **precise, portable** ref tag — e.g. `Review burden 72 high · vs origin/main` or `· vs HEAD` — so the number carries its own meaning when screenshotted into a PR or read away from the toggle. The tag reflects the *actually resolved* ref (`origin/develop` if configured, `HEAD` in last-commit/fallback mode).
- Keep three distinct vocabulary layers: **control** (plain intent: "Since base"), **evidence** subtitle (precise git truth: `origin/main · merge-base abc1234`), **readout** (precise portable anchor: `· vs origin/main`). `merge-base` appears only in the evidence subtitle.
- Default to **Since base** for a fresh session so first-time visitors land on the differentiator; persist the user's choice per session.
- When the review base resolves to dirty-worktree-only (no base available), the two modes are identical; the control reflects this rather than implying a meaningless choice.

## Capabilities

### New Capabilities
<!-- none — the toggle is a new requirement on the existing change-review-load capability -->

### Modified Capabilities
- `change-review-load`: review burden gains a user-selectable compare target (base vs last commit) that recomputes the score and is reported with a precise resolved-ref anchor; the previous behavior becomes the default "Since base" mode.
- `document-diff-view`: the per-file Diff view resolves its base from the active compare mode rather than always using the auto-resolved review base, keeping file diffs coherent with the overview.

## Impact

- **Server**: `src/review/load.ts` (`snapshotGroup`/`collectChangedFiles`/`scoreReviewLoad`), `src/document/git-base-ref.ts` (`resolveReviewBase` gains a "compare target" notion), `src/document/diff.ts` (`getDocumentDiff` honors the mode), `src/server/routes.ts` (`/api/state` and `/api/document/diff` accept/communicate the mode), `src/server/session.ts` (snapshot assembly).
- **Client**: `src/sidebar/change-overview.ts` (toggle UI + readout anchor), `src/sidebar/git-log.ts` (base labeling), `src/shell/state.ts` (mode in appState), `src/shell/storage.ts` (persistence), `src/preview/` diff fetch wiring.
- **Shared types**: `src/shared/types.ts` (`ReviewBase`, `ReviewLoadResult`, `StatePayload`, `DocumentDiffResponse`, plus a compare-mode enum).
- **Existing fallback de-risks this**: the `HEAD`-comparison path already exists in `diff.ts`/`load.ts` as the dirty-worktree-only fallback; this change lets users deliberately opt into it.
- No new third-party dependencies. No CLI flag changes.
