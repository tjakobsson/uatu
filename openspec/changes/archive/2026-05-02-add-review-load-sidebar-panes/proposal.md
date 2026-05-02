## Why

Authors and reviewers need a fast, factual sense of how heavy a change will be to review before diving into individual files. The existing sidebar is optimized for browsing watched documents, but it does not surface repository context, changed-file shape, or review burden signals for merge-request style work.

## What Changes

- Add a sidebar pane stack so the left side can contain multiple independently collapsible/resizable panes instead of only the file tree.
- Allow the expanded sidebar width to be resized horizontally while keeping whole-sidebar collapse separate.
- Move the existing file tree into a `Files` pane while preserving current browse, follow, pin, and sidebar-collapse behavior.
- Add repository awareness for watched roots, including whether each root is inside a git repository and what branch/commit state is currently active.
- Add a `Change Overview`/review-load pane with a deterministic cognitive-load meter based on measurable git diff and file-shape signals.
- Keep the `Change Overview` pane focused by hiding low-level mechanical statistics there; make the score itself clickable so the main preview can show the full scoring breakdown and explain how to compare the numeric score against thresholds.
- Add an optional project settings file for review scoring rules, including path-based risk areas, support areas, ignored/generated areas, and score thresholds.
- Add a `Git Log` pane that shows recent commits for the detected repository context, lets users choose how much history to show, and opens full commit messages in the main preview when clicked.
- Use thinner, lighter scrollbars for sidebar panes, commit logs, file trees, and preview overflow so scroll affordances are present without visually dominating the pane stack.
- Keep peer-review checklist workflows out of this first change, while leaving the settings shape extensible for later checklist definitions.

## Capabilities

### New Capabilities

- `change-review-load`: Computes and explains deterministic review burden for a git-backed watched workspace, including configurable path-based scoring.

### Modified Capabilities

- `document-watch-browser`: Evolves the sidebar from a single document tree into a configurable pane stack while preserving existing document browsing behavior.

## Impact

- Affected server code: git repository detection, diff/log collection, optional settings-file loading, state/API payloads, and live refresh behavior.
- Affected browser code: sidebar layout, sidebar width resizing, pane visibility/collapse/resize state, bounded pane sizing, lighter scrollbar styling, review-load rendering, score-breakdown preview rendering, git-log rendering, commit-message preview rendering, and file-tree pane migration.
- Affected shared types: state payloads for repository metadata, review-load results, pane configuration, and settings-derived scoring summaries.
- Affected tests: unit coverage for git/config/scoring behavior and Playwright coverage for pane layout, persistence, bounded resizing, git-log controls, commit-message preview rendering, and review-load UI.
- No breaking CLI behavior is intended; existing `uatu watch` usage should continue to work without a settings file or git repository.
