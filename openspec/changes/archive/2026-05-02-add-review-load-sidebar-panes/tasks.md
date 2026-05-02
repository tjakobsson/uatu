## 1. Shared Types and Git Data Collection

- [x] 1.1 Add shared types for repository metadata, review-load results, score drivers, commit-log entries, and `.uatu.json` review settings.
- [x] 1.2 Add safe git command helpers that run git in a target directory with bounded output, failure handling, and no watch-session crashes.
- [x] 1.3 Implement watched-root to git-repository detection, including non-git roots and multiple repository groups.
- [x] 1.4 Implement review base resolution using configured `review.baseRef`, remote default branch, common main/master fallbacks, and dirty-worktree-only fallback.
- [x] 1.5 Implement bounded git diff collection for committed branch changes plus staged and unstaged worktree changes.
- [x] 1.6 Implement bounded git commit-log collection with short SHA and subject for each detected repository.

## 2. Review Configuration and Scoring

- [x] 2.1 Add `.uatu.json` loading from detected repository roots with parse/validation warnings and defaults for missing or invalid sections.
- [x] 2.2 Implement path matching for configured risk areas, support areas, and ignore areas without adding a YAML dependency.
- [x] 2.3 Implement mechanical review-cost scoring from changed files, touched lines, hunks, directory spread, renames, and dependency/config changes.
- [x] 2.7 Remove recent commit count from review-burden scoring so Git Log history remains contextual only.
- [x] 2.4 Implement configured risk/support/ignore modifiers with per-area caps and explicit matched-file explanations.
- [x] 2.5 Implement low/medium/high review-burden classification from configured or built-in thresholds.
- [x] 2.6 Add unit tests for non-git roots, base resolution fallback, invalid config, risk/support/ignore matching, unconfigured neutral paths, and score classification.

## 3. Watch Session Integration

- [x] 3.1 Extend the watch session to refresh repository and review-load snapshots on startup, after watched-file refreshes, and during periodic reconciliation.
- [x] 3.2 Extend `/api/state` and SSE state payloads with repository metadata, review-load summaries, settings warnings, and commit-log data.
- [x] 3.3 Ensure git/review refresh failures degrade to unavailable metadata without breaking document scanning, preview rendering, or SSE delivery.
- [x] 3.4 Add tests covering state payloads for git-backed roots, non-git roots, multiple repositories, and repository metadata changes during a session.

## 4. Sidebar Pane UI

- [x] 4.1 Update the sidebar markup to introduce `Change Overview`, `Files`, and `Git Log` pane containers plus a panels control for restoring hidden panes.
- [x] 4.2 Move the existing document count and file tree rendering into the `Files` pane while preserving selection, follow, pin, binary display, relative-time labels, and directory open/closed behavior.
- [x] 4.3 Implement pane visibility, per-pane collapse, and vertical resize state with localStorage persistence.
- [x] 4.4 Keep whole-sidebar collapse/expand behavior separate from per-pane state and preserve current sidebar collapse persistence.
- [x] 4.5 Render repository metadata, review base/fallback mode, cognitive-load level, score, score drivers, ignored-file summaries, and settings warnings in the `Change Overview` pane.
- [x] 4.6 Render bounded commit history and unavailable/empty states in the `Git Log` pane, including clear grouping or labels for multiple repositories.
- [x] 4.7 Add persisted horizontal resizing for the expanded sidebar while preserving whole-sidebar collapse behavior.
- [x] 4.8 Normalize pane heights to the available sidebar height, keep spare height in the `Files` pane, and prevent whole-sidebar pane-stack scrolling.
- [x] 4.9 Make overflowing pane content scroll within its pane body, including long Git Log histories.
- [x] 4.10 Add a Git Log history-length selector with persisted selection.
- [x] 4.11 Render full commit messages in the main preview when a commit row is clicked and disable Follow.
- [x] 4.12 Remove raw mechanical score statistics from the compact `Change Overview` pane while preserving configured warnings and matched-area explanations.
- [x] 4.13 Make the review-burden score clickable and render a linkable main-preview explanation with thresholds, score comparison, mechanical statistics, configured drivers, and warnings.
- [x] 4.15 Keep the score explanation active across reloads and file-change refreshes until the user navigates elsewhere.
- [x] 4.16 Remove the separate `Changed Files` section from the score explanation because file browsing belongs in the `Files` pane.
- [x] 4.17 Apply matching low/medium/high background colors to the score total and threshold cards in the score explanation.
- [x] 4.14 Add hover/focus tooltip explanations for mechanical score terms such as changed files, touched lines, diff hunks, and directory spread.

## 5. Styling, Accessibility, and Responsive Behavior

- [x] 5.1 Add sidebar pane, pane header, resizer, cognitive meter, score-driver, config-warning, and commit-log styles matching the existing UI language.
- [x] 5.2 Ensure pane controls are keyboard-accessible and expose clear labels for hide, restore, collapse, and resize behavior where applicable.
- [x] 5.3 Define mobile behavior for the pane stack so the page remains usable on narrow screens.
- [x] 5.4 Ensure low/medium/high review-burden states are communicated with text in addition to color.
- [x] 5.5 Use thinner, lighter scrollbar styling for pane and preview overflow regions where platform styling allows it.

## 6. End-to-End Coverage and Documentation

- [x] 6.1 Extend the E2E test workspace or test harness to support git-backed fixtures with commits, dirty changes, and optional `.uatu.json` settings.
- [x] 6.2 Add Playwright coverage for default panes, file selection from the `Files` pane, pane hide/restore, pane resize persistence, and whole-sidebar collapse interaction.
- [x] 6.3 Add Playwright coverage for git-backed `Change Overview`, non-git fallback, settings warnings, configured risk/support/ignore explanations, `Git Log` rendering, Git Log history selection, pane scrolling, sidebar width resizing, commit-message preview rendering, score-explanation preview rendering, score URL/reload behavior, hidden mechanical sidebar statistics, and mechanical-stat hover help text.
- [x] 6.4 Update README or user-facing documentation to describe the review-load pane and optional `.uatu.json` review scoring configuration.
- [x] 6.5 Run `bun test`, `bun run build`, and relevant Playwright tests, then fix any failures.
