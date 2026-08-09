# sidebar-shell — delta

## ADDED Requirements

### Requirement: Render repository change context in the Change Overview pane
The browser UI SHALL render repository and change-context data in the `Change Overview` pane when that data is available. The pane MUST show whether the watched root is inside a git repository, the current branch or detached commit, dirty status, and the resolved compare anchor (base ref or fallback mode). The pane MUST NOT list raw mechanical statistics such as changed-file count, touched-line count, diff-hunk count, or directory spread directly in the sidebar. When the workspace contains at least one untracked entry, the pane MUST additionally render a categorical indicator that surfaces the presence of untracked files; the indicator answers a workspace-state question ("are there untracked files at all?") over the changed-files list. That indicator MUST NOT include a count and MUST NOT render when no untracked entries are present. When `.uatu.json` parsing produces configuration warnings, the pane MUST display them. The pane MUST NOT render a review-burden score, level, meter, or score explanation — no such concepts exist. If repository data is unavailable, the pane SHALL show a clear unavailable or non-git message instead of failing to render.

#### Scenario: Git-backed change has repository data
- **WHEN** the browser receives repository metadata and a computed changed-files context
- **THEN** the `Change Overview` pane shows the branch or detached commit, dirty status, and compare anchor
- **AND** the pane does not show raw mechanical statistics such as `Changed files`, `Touched lines`, `Diff hunks`, or `Directory spread`
- **AND** the pane renders no score, level pill, or meter

#### Scenario: Watch root has no git repository
- **WHEN** the browser receives a non-git repository state for the watched root
- **THEN** the `Change Overview` pane states that no git repository is available
- **AND** the document preview and `Files` pane remain usable

#### Scenario: Configuration warnings are surfaced
- **WHEN** `.uatu.json` parsing produces a warning such as an invalid value
- **THEN** the `Change Overview` pane displays that warning
- **AND** the pane still renders the available repository data

#### Scenario: Untracked categorical indicator appears when untracked files are present
- **WHEN** the changed-files list received by the browser contains at least one entry with the untracked status
- **THEN** the `Change Overview` pane renders a categorical indicator that the change includes untracked files
- **AND** the indicator does not display a count
- **AND** the rest of the pane (branch, commit, dirty status, anchor) renders unchanged

#### Scenario: Untracked categorical indicator is absent when no untracked files are present
- **WHEN** the changed-files list received by the browser contains no entries with the untracked status
- **THEN** the `Change Overview` pane does NOT render the untracked categorical indicator
- **AND** the pane shows no placeholder, empty row, or "0 untracked" affordance for that category

## REMOVED Requirements

### Requirement: Render review-load summary in the Change Overview pane
**Reason**: Restated as "Render repository change context in the Change Overview pane". The review-burden score, level pill, meter, score drivers, and score-explanation preview no longer exist; the surviving facts (branch, dirty state, compare anchor, changed-files context, untracked indicator, config warnings) carry over.
**Migration**: None — the pane keeps rendering the repository/change context without any score UI.
