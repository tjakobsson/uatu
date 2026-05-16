## ADDED Requirements

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
