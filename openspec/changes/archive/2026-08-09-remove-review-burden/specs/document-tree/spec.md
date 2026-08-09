# document-tree — delta

## MODIFIED Requirements

### Requirement: Reduce the tree's path set when the Files-pane filter is set to Changed

When the Files-pane filter is in the `Changed` state, the path set fed to `@pierre/trees` MUST be reduced to the changed-files list plus every ancestor directory of each file in that list. Files listed in the git-ignored files list MUST NOT contribute to the reduced set — gitignored entries are ambient git policy, not change content. The reduction MUST be implemented by handing the library a shorter `paths` array via `resetPaths(paths, { initialExpandedPaths })`; uatu MUST NOT mutate, hide, or otherwise modify the library's internal row visibility or DOM. Every ancestor directory included in the reduced set MUST be auto-expanded so the change entries are visible without further clicks. When the filter is `All`, the path set fed to the library MUST be the full set unchanged from current behavior. The same chip controls the filter regardless of how many watched roots are present; one chip toggles all roots together.

#### Scenario: Filter `Changed` reduces the tree to change-set entries plus their ancestors
- **WHEN** the filter is `Changed` and the changed-files list reports two changed paths under `src/auth/` and one under `tests/`
- **THEN** the tree renders exactly those three leaf rows
- **AND** the ancestor directories `src/`, `src/auth/`, and `tests/` are present and auto-expanded
- **AND** no other rows are rendered

#### Scenario: Filter `Changed` excludes gitignored entries
- **WHEN** the filter is `Changed`
- **AND** the git-ignored files list includes `.claude/settings.local.json`
- **AND** that file would otherwise appear in the full tree
- **THEN** the row for `.claude/settings.local.json` is NOT present in the filtered tree

#### Scenario: Filter `All` restores the unmodified path set
- **WHEN** the user toggles the filter from `Changed` to `All`
- **THEN** the tree's path set returns to the full set used before filtering was introduced
- **AND** no path is added or removed compared to the unfiltered baseline

#### Scenario: One chip applies to every watched root in multi-root sessions
- **WHEN** the watch session includes multiple roots
- **THEN** a single filter chip controls the reduction for all roots together

## ADDED Requirements

### Requirement: Annotate tree rows with git status
When the watched repository is git-backed AND the repository change data for that repository is available, the document tree SHALL display the git status of each changed path as a row annotation on the corresponding tree row, using `@pierre/trees`' git-status API. The set of changed paths fed to the annotation pipeline MUST be the changed-files list. The supported statuses MUST include at minimum: added, modified, deleted, untracked, and ignored. The `ignored` annotation MUST be applied to paths surfaced in the git-ignored files list (files visible in the tree that match git's standard ignore rules) so reviewers can distinguish "clean tracked file" from "git is intentionally not following this file" — for example, a per-machine settings file excluded by `core.excludesFile`. Renamed paths MUST display the annotation on the new path. Annotations MUST update whenever the repository's change data changes. The annotations replace the previous All/Changed Files-pane toggle: there is one tree, and changed files are visually distinguished in place.

#### Scenario: Modified file shows a modified annotation
- **WHEN** the watched root is git-backed and a file in the working tree has uncommitted modifications
- **THEN** that file's tree row shows a modified annotation
- **AND** the file remains in its normal hierarchical position in the tree

#### Scenario: Untracked file shows an untracked annotation
- **WHEN** the watched root is git-backed and a new file has been created but not staged
- **THEN** that file's tree row shows an untracked annotation

#### Scenario: Annotations clear when changes are committed
- **WHEN** the working-tree changes that produced an annotation are committed
- **AND** the next repository change data reflects a clean working tree for that path
- **THEN** the corresponding tree row no longer shows a status annotation

#### Scenario: No annotations when git is unavailable
- **WHEN** the watched root is not a git repository OR the repository change data is unavailable
- **THEN** no rows display git-status annotations
- **AND** the tree still renders the full file listing

#### Scenario: Gitignored file visible in the tree shows the ignored annotation
- **WHEN** the watched root is git-backed AND uatu's tree displays a file that matches git's standard ignore rules (e.g. excluded by `core.excludesFile` or by `.gitignore` while gitignore-respect is disabled)
- **THEN** that file's tree row shows the `ignored` annotation
- **AND** the row is visually distinguishable from a clean tracked file (which has no annotation) and from an untracked file (which has the `untracked` annotation)

## REMOVED Requirements

### Requirement: Surface git status as row annotations on tree entries
**Reason**: Restated as "Annotate tree rows with git status" over the single changed-files list; the `ignoreAreas` scenario is dropped because `.uatu.json` `review.ignoreAreas` no longer exists.
**Migration**: None — annotation behavior is unchanged; every changed file annotates directly from the changed-files list.
