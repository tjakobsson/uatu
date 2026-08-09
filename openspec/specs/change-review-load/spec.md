## Purpose

Define git-backed repository context for watched workspaces: repository metadata, the changed-files context measured against a resolved compare base, the bounded commit log, and gitignored-file exposure.
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

### Requirement: Provide bounded git commit log context
The system SHALL provide a bounded recent commit log for each detected git repository. Each commit entry MUST include at minimum the short SHA, subject, full commit message, and author or relative time when available. The log MUST be contextual information only and MUST NOT alter the changed-files context.

#### Scenario: Repository has recent commits
- **WHEN** a watched repository has git commits
- **THEN** the system exposes a bounded list of recent commits
- **AND** each commit entry includes a short SHA, subject, and full commit message

#### Scenario: Commit log cannot be read
- **WHEN** git log data is unavailable or a repository has no commits
- **THEN** the watch session remains usable
- **AND** the system reports an empty or unavailable commit-log state for that repository

### Requirement: Expose changed-file categories through a distinct status letter

The system SHALL emit a `ChangedFileSummary.status` value whose first character identifies the category of change. The supported first-character values MUST be `"?"` for untracked files, `"A"` for files newly added by a tracked commit or staged add, `"M"` for files modified in place, `"D"` for files deleted, and `"R"` for renames (which MAY append rename-similarity digits as in `git diff --name-status -M`). Untracked files (those reported by `git ls-files --others --exclude-standard`) MUST NOT be reported with `"A"`. Tracked-added files MUST NOT be reported with `"M"` or `"?"`. The full set of files contributing to the changed-files list MUST NOT change as a result of this requirement; only the category label changes. Downstream consumers that case-match on the first character of the status field MUST be able to use `"?"`, `"A"`, `"M"`, `"D"`, and `"R"` to identify the corresponding category without consulting any other field.

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

#### Scenario: Untracked files continue contributing to the changed-files context

- **WHEN** the watched repository contains one or more untracked files
- **THEN** those files appear in the changed-files list on the same basis as before this requirement (additions equal to the file's line count, deletions zero, hunks one if non-empty)
- **AND** distinguishing untracked from tracked-added in the status field does not change which files the list contains

### Requirement: Expose gitignored files visible in the tree as a distinct category

The system SHALL expose files that exist on disk in a watched root AND are matched by git's standard ignore rules (`.gitignore`, `core.excludesFile`, `.git/info/exclude`) AND appear in uatu's tree path set, as a string array on `RepositorySnapshot.gitIgnoredFiles`. The set MUST be intersected against the tree's known paths server-side so the wire payload does not include large ignored hierarchies (e.g. `node_modules`) that the tree filtered out anyway. Gitignored files MUST NOT appear in `changedFiles` (that list describes git-detected changes; gitignored files are by definition not changes). Consumers MAY display these paths with a distinct annotation; the canonical mapping for browser UIs is `git status "!"` → annotation status `"ignored"`.

#### Scenario: A file matched by `.gitignore` is exposed on `gitIgnoredFiles`

- **WHEN** the watched repository contains a `.gitignore` that excludes a path
- **AND** that path exists on disk and is visible to uatu's tree
- **THEN** `RepositorySnapshot.gitIgnoredFiles` contains that path
- **AND** `changedFiles` does NOT contain that path

#### Scenario: Gitignored paths outside the tree's known paths are not exposed

- **WHEN** the watched repository contains many gitignored files (e.g. `node_modules` contents)
- **AND** uatu's tree does not display those files
- **THEN** `RepositorySnapshot.gitIgnoredFiles` does NOT include those off-tree paths
- **AND** the wire payload is not inflated by them

### Requirement: Select the compare target

The system SHALL expose a user-selectable compare target for the Change Overview. Supported targets MUST be `base` and `last-commit` with their existing diff meanings. The selected target SHALL apply uniformly to every watched repository in that client's view, SHALL persist as personal workspace state, and SHALL default to `base` when no saved value exists. Changing it MUST recompute and refresh only that client's changed-files context and diff requests without restarting the watch session, changing `.uatu.json`, altering the resolved base ref, or forcing another client to adopt the target. The watch child SHALL accept compare target as request/subscription context rather than retaining one mutable session-global selection. The control's accessible name SHALL describe comparison ("Compare against"), not review burden.

#### Scenario: Default compare target is the resolved base
- **WHEN** a user has no saved compare target
- **THEN** the client uses `base`
- **AND** the changed-files context reflects changes between the resolved base and the worktree

#### Scenario: Switching to last commit recomputes against HEAD
- **WHEN** a user selects `last-commit`
- **THEN** that client's changed-files view recomputes against `HEAD`
- **AND** no watch-session restart is required

#### Scenario: Selection follows the user to another client
- **WHEN** a user saves `last-commit` and later opens the workspace root in another browser
- **THEN** the new client uses `last-commit`

#### Scenario: Open clients may use different targets
- **WHEN** two clients view the same workspace with different compare targets
- **THEN** each receives repository snapshots and diffs for its own target
- **AND** neither toggle changes because of the other's selection

#### Scenario: Compare target is uniform across repositories within one client
- **WHEN** a workspace includes multiple repositories
- **THEN** one client's selected target applies to all repositories in that client's view

#### Scenario: Targets collapse when no base is resolvable
- **WHEN** the resolved base is dirty-worktree-only
- **THEN** `base` and `last-commit` describe the same diff
- **AND** the UI reflects that the choice is not meaningful

### Requirement: Anchor the changed-files context to a precise portable ref

The system SHALL report, alongside the changed-files context, a precise anchor identifying the ref the comparison was actually computed against, so the displayed change set is unambiguous when read away from the compare-target control. For the `base` target the anchor SHALL name the actually resolved base ref (for example `origin/main` or `origin/master`). For the `last-commit` target the anchor SHALL be `HEAD`. The anchor MUST reflect what was actually resolved and computed, not the literal label of the selected control. The compare-target control itself MUST express intent in stable plain language ("Since base" / "Since last commit") and MUST NOT display raw refs, so its labels do not shift with repository configuration.

#### Scenario: Base anchor names the resolved ref
- **WHEN** the compare target is `base` and the resolved base ref is `origin/main`
- **THEN** the changed-files context is anchored with the ref `origin/main`

#### Scenario: Last-commit anchor names HEAD
- **WHEN** the compare target is `last-commit`
- **THEN** the changed-files context is anchored with `HEAD`

#### Scenario: The control shows intent, not refs
- **WHEN** the compare-target control is rendered for any repository configuration
- **THEN** its options read as plain intent ("Since base" / "Since last commit")
- **AND** the options do not display raw ref names

