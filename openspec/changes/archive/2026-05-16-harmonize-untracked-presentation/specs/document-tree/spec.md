## MODIFIED Requirements

### Requirement: Surface git status as row annotations on tree entries
When the watched repository is git-backed AND the review-load result for that repository has status `available`, the document tree SHALL display the git status of each changed path as a row annotation on the corresponding tree row, using `@pierre/trees`' git-status API. The set of changed paths fed to the annotation pipeline MUST be the union of `reviewLoad.changedFiles` and `reviewLoad.ignoredFiles`: files excluded from the burden score by `.uatu.json review.ignoreAreas` continue to display their git status here, because the tree answers "what is the git state of this file?", not "does this file affect the score?". The supported statuses MUST include at minimum: added, modified, deleted, untracked, and ignored. The `ignored` annotation MUST be applied to paths surfaced in `reviewLoad.gitIgnoredFiles` (files visible in the tree that match git's standard ignore rules) so reviewers can distinguish "clean tracked file" from "git is intentionally not following this file" — for example, a per-machine settings file excluded by `core.excludesFile`. Renamed paths MUST display the annotation on the new path. Annotations MUST update whenever the repository's review-load result changes. The annotations replace the previous All/Changed Files-pane toggle: there is one tree, and changed files are visually distinguished in place.

#### Scenario: Modified file shows a modified annotation
- **WHEN** the watched root is git-backed and a file in the working tree has uncommitted modifications
- **THEN** that file's tree row shows a modified annotation
- **AND** the file remains in its normal hierarchical position in the tree

#### Scenario: Untracked file shows an untracked annotation
- **WHEN** the watched root is git-backed and a new file has been created but not staged
- **THEN** that file's tree row shows an untracked annotation

#### Scenario: Annotations clear when changes are committed
- **WHEN** the working-tree changes that produced an annotation are committed
- **AND** the next review-load result reflects a clean working tree for that path
- **THEN** the corresponding tree row no longer shows a status annotation

#### Scenario: No annotations when git is unavailable
- **WHEN** the watched root is not a git repository OR the review-load result is unavailable
- **THEN** no rows display git-status annotations
- **AND** the tree still renders the full file listing

#### Scenario: Gitignored file visible in the tree shows the ignored annotation
- **WHEN** the watched root is git-backed AND uatu's tree displays a file that matches git's standard ignore rules (e.g. excluded by `core.excludesFile` or by `.gitignore` while `tree.respectGitignore` is false)
- **THEN** that file's tree row shows the `ignored` annotation
- **AND** the row is visually distinguishable from a clean tracked file (which has no annotation) and from an untracked file (which has the `untracked` annotation)

#### Scenario: Files matched by `ignoreAreas` still display their git status
- **WHEN** the watched root has a `.uatu.json` whose `review.ignoreAreas` matches a changed or untracked path
- **THEN** that file's tree row still shows its git-status annotation (added, modified, deleted, renamed, or untracked as appropriate)
- **AND** the file remains excluded from the burden-score calculation as today
- **AND** the user can distinguish "the file is unchanged" from "the file is changed but excluded from the score"
