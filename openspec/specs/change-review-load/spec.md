## Purpose

Define git-backed repository context for watched workspaces: repository metadata, the changed-files context measured against a resolved compare base, the bounded commit log, and gitignored-file exposure.
## Requirements
### Requirement: Detect git repository context for watched roots
The system SHALL determine Git membership for each watched root and expose repository context separately from the running `uatu` build identifier. Context MUST include repository root path, branch name or detached commit, current short SHA, dirty status, and metadata availability. Unavailable context MUST preserve usability as below.

#### Scenario: A root has no readable repository metadata
- **WHEN** a root is outside Git or its metadata cannot be read
- **THEN** the system MUST keep the watch session usable and report explicit non-git or unavailable state

#### Scenario: Watched root is inside a git repository
- **WHEN** a session child is started with `.` inside a git repository
- **THEN** the system exposes repository metadata for that watched root
- **AND** the metadata includes the current branch or detached commit and current short SHA

#### Scenario: Watched root is not inside a git repository
- **WHEN** a session child is started with `--force` for a directory that is not inside a git repository
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
The system SHALL provide a bounded recent commit log per detected Git repository. Entries MUST include at least short SHA, subject, full message, commit time, and author when available. Commit time SHALL be absolute so clients can keep age current. The log MUST remain contextual and MUST NOT alter changed-files context; age compatibility SHALL follow the rule below.

#### Scenario: Current and older clients consume a commit entry
- **WHEN** a commit entry is delivered
- **THEN** it SHALL retain relative-time text for older-client compatibility, while current clients SHALL derive displayed ages from absolute commit time

#### Scenario: Repository has recent commits
- **WHEN** a watched repository has git commits
- **THEN** the system exposes a bounded list of recent commits
- **AND** each commit entry includes a short SHA, subject, full commit message and absolute commit time

#### Scenario: Elapsed time alone does not change the commit log
- **WHEN** the same commits are collected again later and only wall-clock time has passed
- **THEN** each entry's commit time is unchanged
- **AND** the commit log is not treated as changed repository data

#### Scenario: Commit log cannot be read
- **WHEN** git log data is unavailable or a repository has no commits
- **THEN** the watch session remains usable
- **AND** the system reports an empty or unavailable commit-log state for that repository

### Requirement: Expose changed-file categories through a distinct status letter

`ChangedFileSummary.status` SHALL identify change category by its first character: `"?"` untracked, `"A"` tracked-commit or staged additions, `"M"` in-place modifications, `"D"` deletions, and `"R"` renames. Renames MAY append similarity digits as in `git diff --name-status -M`. Status assignment and downstream interpretation MUST preserve the rules below.

#### Scenario: Changed-file categories are assigned and consumed
- **WHEN** a changed-files list is emitted
- **THEN** files from `git ls-files --others --exclude-standard` MUST NOT use `"A"`, and tracked-added files MUST NOT use `"M"` or `"?"`
- **AND** the contributing file set MUST NOT change because of this requirement; only category labels change
- **AND** downstream consumers MUST be able to identify all five categories by case-matching the first character alone without consulting another field

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

`RepositorySnapshot.gitIgnoredFiles` SHALL be a string array of on-disk watched-root files matched by standard Git ignore rules (`.gitignore`, `core.excludesFile`, `.git/info/exclude`) and present in uatu's tree path set. The server MUST intersect with known tree paths, excluding filtered large hierarchies such as `node_modules`. Changed-file separation and annotation SHALL follow the rules below.

#### Scenario: An ignored known path reaches repository consumers
- **WHEN** a path qualifies for `RepositorySnapshot.gitIgnoredFiles`
- **THEN** it MUST NOT appear in `changedFiles`, which describes Git-detected changes rather than ignored files
- **AND** consumers MAY annotate it distinctly; browser UIs' canonical mapping SHALL be `git status "!"` to annotation status `"ignored"`

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

Change Overview SHALL expose a user-selectable compare target: `base` or `last-commit` with existing diff meanings. It SHALL apply uniformly to all repositories in that client's view, persist as personal workspace state, and default to `base` without a saved value. The control's accessible name SHALL describe comparison ("Compare against"), not review burden. Changes SHALL follow the isolation rules below.

#### Scenario: A client changes its compare target
- **WHEN** a user chooses a target
- **THEN** only that client's changed-files context and diff requests MUST recompute/refresh without restarting the watch session, changing `.uatu.json`, altering resolved base ref, or forcing another client's target
- **AND** the watch child SHALL accept target as request/subscription context rather than a mutable session-global selection

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

Changed-files context SHALL include a precise comparison anchor naming the actually resolved/computed ref, not the selected control's literal label. For `base` it SHALL name the resolved base (for example `origin/main` or `origin/master`); for `last-commit` it SHALL be `HEAD`, keeping context unambiguous away from the control. Control labels MUST follow the stable-intent rule below.

#### Scenario: Repository configuration changes the resolved comparison ref
- **WHEN** the compare-target control is displayed
- **THEN** it MUST use stable plain-language intent ("Since base" / "Since last commit") and MUST NOT display raw refs or shift labels with repository configuration

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
