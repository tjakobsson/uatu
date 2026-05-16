## Purpose

Define git-backed repository context and deterministic review-burden scoring for watched workspaces.

## Requirements

### Requirement: Detect git repository context for watched roots
The system SHALL determine whether each watched root belongs to a git repository and SHALL expose repository context separately from the build identifier of the running `uatu` process. Repository context MUST include the repository root path, current branch name or detached commit, current commit short SHA, dirty worktree status, and whether the repository metadata is available. If a watched root is not inside a git repository or git metadata cannot be read, the system MUST keep the watch session usable and report an explicit non-git or unavailable state.

#### Scenario: Watched root is inside a git repository
- **WHEN** a user starts `uatu watch .` inside a git repository
- **THEN** the system exposes repository metadata for that watched root
- **AND** the metadata includes the current branch or detached commit and current short SHA

#### Scenario: Watched root is not inside a git repository
- **WHEN** a user starts `uatu watch` for a directory that is not inside a git repository
- **THEN** the watch session still starts normally
- **AND** the repository metadata reports that no git repository is available

#### Scenario: Multiple watched roots map to different repositories
- **WHEN** a watch session includes roots from more than one git repository
- **THEN** the repository metadata is grouped by repository root
- **AND** each watched root can be associated with its repository group or with a non-git state

#### Scenario: Repository metadata changes during a session
- **WHEN** the user changes branch, creates a commit, stages files, or modifies the worktree while the watch session is running
- **THEN** the repository metadata refreshes without requiring a restart
- **AND** the browser UI can render the updated branch, commit, and dirty status

### Requirement: Compute deterministic review burden for git changes
The system SHALL compute a cognitive-load score that estimates review burden from deterministic git and file-shape signals. The score MUST be based on mechanical cost plus configured scoring modifiers and MUST NOT rely on AI or semantic code interpretation. Mechanical cost SHALL include changed-file count, diff hunks, touched lines, directory spread, renames or moves, and dependency/config file changes. Commit-log length or recent repository history MUST NOT contribute to the review-burden score. Unconfigured changed paths MUST remain risk-neutral but MUST still contribute to mechanical review cost.

#### Scenario: Branch-style change has a resolvable base
- **WHEN** the watched repository has a configured or detected review base
- **THEN** the system computes review burden from committed changes between the merge base and `HEAD`
- **AND** staged and unstaged worktree changes are included in the review burden
- **AND** the result identifies the base used for the calculation

#### Scenario: Review base cannot be resolved
- **WHEN** no configured or detected review base is available
- **THEN** the system computes review burden from staged and unstaged changes against `HEAD`
- **AND** the result clearly indicates that it is using dirty-worktree-only mode

#### Scenario: Unconfigured paths are changed
- **WHEN** changed files do not match any configured risk, support, or ignore area
- **THEN** those files add mechanical review cost
- **AND** those files do not add path-based risk or support modifiers

#### Scenario: Review burden has explainable drivers
- **WHEN** the system reports a cognitive-load score
- **THEN** it also reports the facts and modifiers that contributed to the score
- **AND** each reported driver is derived from git data, file-shape data, built-in heuristics, or project configuration

### Requirement: Apply project review scoring configuration
The system SHALL read an optional `.uatu.json` file from the detected repository root and apply its `review` configuration to review-load scoring. The `review` configuration MAY define `baseRef`, score thresholds, risk areas, support areas, and ignore areas. Risk areas SHALL add score when changed files match their configured path patterns. Support areas SHALL subtract score when changed files match their configured path patterns. Ignore areas SHALL exclude matching files from score calculations while still reporting that they were excluded. The system SHALL expose loaded configured risk, support, and ignore areas to the browser UI even when they do not match the current change, so users can distinguish "configuration loaded but not matched" from "no configuration loaded". Configured areas that do not match the current change MUST be shown as zero-impact or unmatched and MUST NOT alter the review-burden score. Invalid or missing configuration MUST NOT prevent the watch session from starting.

#### Scenario: Risk area matches changed files
- **WHEN** `.uatu.json` defines a risk area with paths matching changed files
- **THEN** the review burden includes that risk area's configured score contribution
- **AND** the explanation identifies the risk area label and matched files

#### Scenario: Support area matches changed files
- **WHEN** `.uatu.json` defines a support area with paths matching changed files such as tests or documentation
- **THEN** the review burden includes that support area's configured score reduction
- **AND** the explanation identifies the support area label and matched files

#### Scenario: Ignore area matches generated files
- **WHEN** `.uatu.json` defines an ignore area matching generated or vendor files
- **THEN** matching files are excluded from score calculations
- **AND** the explanation identifies the ignored area label and excluded files

#### Scenario: Configured areas do not match the current change
- **WHEN** `.uatu.json` defines risk, support, or ignore areas
- **AND** the current changed files do not match those configured area patterns
- **THEN** the browser UI shows that the configured areas were loaded
- **AND** each unmatched configured area is shown as not matching the current change
- **AND** those unmatched configured areas do not change the review-burden score

#### Scenario: Configuration is absent
- **WHEN** no `.uatu.json` file exists at the repository root
- **THEN** the system uses built-in score thresholds and mechanical scoring defaults
- **AND** no path-based risk or support modifier is applied except built-in heuristic categories
- **AND** the browser UI does not imply that project-specific review areas were loaded

#### Scenario: Configuration is invalid
- **WHEN** `.uatu.json` cannot be parsed or contains invalid review scoring fields
- **THEN** the watch session remains usable
- **AND** invalid configuration is ignored or partially ignored in favor of defaults
- **AND** the browser UI can display a configuration warning

### Requirement: Classify review burden into visible levels
The system SHALL classify the cognitive-load score into `low`, `medium`, or `high` review burden using configured thresholds when present and built-in thresholds otherwise. The classification MUST be presented as review burden rather than quality, risk of failure, or correctness. The result MUST include the thresholds used for classification so the UI can explain how to compare a raw score against the current scale.

#### Scenario: Score falls below the medium threshold
- **WHEN** the computed score is lower than the medium threshold
- **THEN** the review burden level is `low`

#### Scenario: Score reaches the medium threshold
- **WHEN** the computed score is at least the medium threshold and below the high threshold
- **THEN** the review burden level is `medium`

#### Scenario: Score reaches the high threshold
- **WHEN** the computed score is at least the high threshold
- **THEN** the review burden level is `high`

### Requirement: Provide bounded git commit log context
The system SHALL provide a bounded recent commit log for each detected git repository. Each commit entry MUST include at minimum the short SHA, subject, full commit message, and author or relative time when available. The log MUST be contextual information and MUST NOT contribute to review-load scoring.

#### Scenario: Repository has recent commits
- **WHEN** a watched repository has git commits
- **THEN** the system exposes a bounded list of recent commits
- **AND** each commit entry includes a short SHA, subject, and full commit message

#### Scenario: Commit log cannot be read
- **WHEN** git log data is unavailable or a repository has no commits
- **THEN** the watch session remains usable
- **AND** the system reports an empty or unavailable commit-log state for that repository

### Requirement: Expose changed-file categories through a distinct status letter

The system SHALL emit a `ChangedFileSummary.status` value whose first character identifies the category of change. The supported first-character values MUST be `"?"` for untracked files, `"A"` for files newly added by a tracked commit or staged add, `"M"` for files modified in place, `"D"` for files deleted, and `"R"` for renames (which MAY append rename-similarity digits as in `git diff --name-status -M`). Untracked files (those reported by `git ls-files --others --exclude-standard`) MUST NOT be reported with `"A"`. Tracked-added files MUST NOT be reported with `"M"` or `"?"`. The full set of files contributing to the changed-files list and the burden score MUST NOT change as a result of this requirement; only the category label changes. Downstream consumers that case-match on the first character of the status field MUST be able to use `"?"`, `"A"`, `"M"`, `"D"`, and `"R"` to identify the corresponding category without consulting any other field.

#### Scenario: An untracked file is reported with the untracked status

- **WHEN** the watched repository contains a file that is reported by `git ls-files --others --exclude-standard` and is not staged or committed
- **THEN** the changed-files list includes that file
- **AND** that file's status begins with `"?"`

#### Scenario: A staged new file is reported with the added status

- **WHEN** the watched repository contains a file that has been added with `git add` but not yet committed
- **THEN** the changed-files list includes that file
- **AND** that file's status begins with `"A"`
- **AND** that file's status does NOT begin with `"?"`
- **AND** that file's status does NOT begin with `"M"`

#### Scenario: A modified tracked file is reported with the modified status

- **WHEN** the watched repository contains a tracked file whose contents have been modified relative to `HEAD`
- **THEN** that file's status begins with `"M"`

#### Scenario: A deleted tracked file is reported with the deleted status

- **WHEN** the watched repository contains a tracked file that has been removed relative to `HEAD`
- **THEN** that file's status begins with `"D"`

#### Scenario: A renamed tracked file is reported with the renamed status

- **WHEN** the watched repository contains a tracked file that has been renamed relative to `HEAD` and `git`'s rename-detection threshold applies
- **THEN** that file's status begins with `"R"`
- **AND** the entry's `oldPath` carries the pre-rename path

#### Scenario: Untracked files continue contributing to the burden score

- **WHEN** the watched repository contains one or more untracked files
- **THEN** those files contribute to the review-burden score on the same basis as before this requirement (additions equal to the file's line count, deletions zero, hunks one if non-empty)
- **AND** distinguishing untracked from tracked-added in the status field does not change the numeric score for an otherwise identical change

### Requirement: Expose gitignored files visible in the tree as a distinct category

The system SHALL expose files that exist on disk in a watched root AND are matched by git's standard ignore rules (`.gitignore`, `core.excludesFile`, `.git/info/exclude`) AND appear in uatu's tree path set, as a string array on `ReviewLoadResult.gitIgnoredFiles`. The set MUST be intersected against the tree's known paths server-side so the wire payload does not include large ignored hierarchies (e.g. `node_modules`) that the tree filtered out anyway. Gitignored files MUST NOT appear in `changedFiles` or `ignoredFiles` (those describe git-detected changes; gitignored files are by definition not changes). Gitignored files MUST NOT contribute to the review-burden score under any condition. Consumers MAY display these paths with a distinct annotation; the canonical mapping for browser UIs is `git status "!"` → annotation status `"ignored"`.

#### Scenario: A file matched by `.gitignore` is exposed on `gitIgnoredFiles`

- **WHEN** the watched repository contains a `.gitignore` that excludes a path
- **AND** that path exists on disk and is visible to uatu's tree
- **THEN** `ReviewLoadResult.gitIgnoredFiles` contains that path
- **AND** `changedFiles` does NOT contain that path
- **AND** `ignoredFiles` does NOT contain that path
- **AND** the review-burden score is unchanged compared to a repository where the gitignored file is absent

#### Scenario: Gitignored paths outside the tree's known paths are not exposed

- **WHEN** the watched repository contains many gitignored files (e.g. `node_modules` contents)
- **AND** uatu's tree does not display those files
- **THEN** `ReviewLoadResult.gitIgnoredFiles` does NOT include those off-tree paths
- **AND** the wire payload is not inflated by them
