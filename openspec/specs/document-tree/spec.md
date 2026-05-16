# document-tree Specification

## Purpose
TBD - created by archiving change split-document-watch-browser. Update Purpose after archive.
## Requirements
### Requirement: Preserve manual directory open/closed state in the document tree
Directories in the sidebar tree SHALL render collapsed (closed) by default, matching the conventions of common file trees (VS Code, Finder, GitHub). When a user expands or collapses a directory, that explicit choice SHALL persist across document selections and across sidebar re-renders triggered by file changes — including filesystem-driven `resetPaths` calls into the library. When the active document changes (initial default, follow-mode auto-switch, or user click), the system SHALL reveal the path to that document by expanding every ancestor directory between the watched root and the document, then marking that document's row as selected. The reveal MUST be purely additive — it opens ancestors but never closes any directory the user has opened. The session-level expansion state MAY reset on page reload.

#### Scenario: Directories start collapsed
- **WHEN** the document tree is first rendered and the default document is at a watched root with no ancestor directories
- **THEN** nested directories render collapsed and only top-level documents are visible until the user expands a directory

#### Scenario: Initial selection inside a nested directory is revealed on first paint
- **WHEN** the SPA boots with an initial selected document inside a nested directory (e.g. follow-mode was on and the latest file is in `guides/`)
- **THEN** the tree renders with every ancestor directory of that document expanded
- **AND** the row for that document is rendered as selected

#### Scenario: Follow-mode auto-switch reveals the path to the newly active document
- **WHEN** follow mode is enabled and a file inside a nested directory changes on disk
- **THEN** the preview switches to that file
- **AND** every ancestor directory from the watched root down to the file renders as expanded
- **AND** the row for the previously-selected document is no longer rendered as selected
- **AND** the row for the newly-selected document is rendered as selected

#### Scenario: Reveal is purely additive — it never closes anything
- **WHEN** the active document changes (initial default, follow-mode auto-switch, or user click)
- **THEN** directories the user has expanded remain expanded
- **AND** only the new document's ancestor directories are added to the expanded set

#### Scenario: A manually expanded directory stays expanded across file selections
- **WHEN** a user expands a directory by clicking its row
- **AND** then selects a different file in the tree
- **THEN** the directory remains expanded

#### Scenario: Manual expansion state survives sidebar re-renders driven by file changes
- **WHEN** a user expands a directory and an unrelated file is modified on disk, triggering a sidebar re-render
- **THEN** the directory remains expanded
- **AND** any directories that are newly required by reveal (because the selection changed) are added to the expanded set on top of the user's choices

### Requirement: Display sidebar file count breakdown
The sidebar SHALL display a file count for the current scope. When the Files-pane filter is `All`, the count SHALL show the total number of files visible in the tree; when the filter is `Changed`, the count SHALL show `N of M files` where N is the number of files visible under the filter (including any temporarily-revealed follow-override row) and M is the total tree size. When the visible set contains binary files, the count SHALL additionally show how many are binary; under filter `Changed`, the binary subcount reflects the visible (filtered) binary count, not the total binary count. The hardcoded directory denylist (e.g. `node_modules/`, `.git/`) MUST NOT contribute to a hidden count and the counter MUST NOT expose a `hidden` segment, since filtering is now configured through a single source of truth (`.uatu.json tree.exclude` plus `.gitignore` honoring) rather than the previous dual-source `.uatuignore` + `.gitignore` model.

#### Scenario: Counter shows only the total when the tree is uniform
- **WHEN** the watched roots contain only viewable text and Markdown files
- **AND** the Files-pane filter is `All`
- **THEN** the sidebar counter reads `N files` (e.g. `3 files`)

#### Scenario: Counter surfaces the binary subcount
- **WHEN** the watched roots contain a mix of viewable and binary files
- **AND** the Files-pane filter is `All`
- **THEN** the sidebar counter reads `N files · M binary` where M is the number of binary entries in the tree

#### Scenario: Counter never includes a hidden segment
- **WHEN** the watch root has files filtered by `.uatu.json tree.exclude` or `.gitignore`
- **THEN** the sidebar counter does NOT include a `· hidden` segment
- **AND** the counter reflects only the visible total and the binary subcount

#### Scenario: Counter shows `N of M` form under the Changed filter
- **WHEN** the Files-pane filter is `Changed`
- **AND** there are 12 files in the change set and 1,840 total files in the tree
- **THEN** the sidebar counter reads `12 of 1,840 files`

#### Scenario: Binary subcount under filter reflects the visible binary count
- **WHEN** the Files-pane filter is `Changed`
- **AND** of the 12 filtered entries, 2 are binary
- **AND** the total tree contains more binary entries that are outside the change set
- **THEN** the sidebar counter reads `12 of 1,840 files · 2 binary`
- **AND** the binary subcount does NOT include binaries that are filtered out

### Requirement: Reduce the tree's path set when the Files-pane filter is set to Changed

When the Files-pane filter is in the `Changed` state, the path set fed to `@pierre/trees` MUST be reduced to the union of `reviewLoad.changedFiles` and `reviewLoad.ignoredFiles`, plus every ancestor directory of each file in that union. Files listed in `reviewLoad.gitIgnoredFiles` MUST NOT contribute to the reduced set — gitignored entries are ambient git policy, not change content. The reduction MUST be implemented by handing the library a shorter `paths` array via `resetPaths(paths, { initialExpandedPaths })`; uatu MUST NOT mutate, hide, or otherwise modify the library's internal row visibility or DOM. Every ancestor directory included in the reduced set MUST be auto-expanded so the change entries are visible without further clicks. When the filter is `All`, the path set fed to the library MUST be the full set unchanged from current behavior. The same chip controls the filter regardless of how many watched roots are present; one chip toggles all roots together.

#### Scenario: Filter `Changed` reduces the tree to change-set entries plus their ancestors
- **WHEN** the filter is `Changed` and `reviewLoad` reports two changed paths under `src/auth/` and one under `tests/`
- **THEN** the tree renders exactly those three leaf rows
- **AND** the ancestor directories `src/`, `src/auth/`, and `tests/` are present and auto-expanded
- **AND** no other rows are rendered

#### Scenario: Filter `Changed` excludes gitignored entries
- **WHEN** the filter is `Changed`
- **AND** `reviewLoad.gitIgnoredFiles` includes `.claude/settings.local.json`
- **AND** that file would otherwise appear in the full tree
- **THEN** the row for `.claude/settings.local.json` is NOT present in the filtered tree

#### Scenario: Filter `All` restores the unmodified path set
- **WHEN** the user toggles the filter from `Changed` to `All`
- **THEN** the tree's path set returns to the full set used before filtering was introduced
- **AND** no path is added or removed compared to the unfiltered baseline

#### Scenario: One chip applies to every watched root in multi-root sessions
- **WHEN** the watch session includes multiple roots
- **AND** the user toggles the filter
- **THEN** every root's contribution to the tree is filtered (or unfiltered) under the same toggle
- **AND** there is exactly one chip controlling all roots, not one per root

### Requirement: Preserve the full-tree expansion state across filter toggles

When the user toggles the filter from `All` to `Changed`, the system MUST snapshot the user's current set of manually-expanded directories. When the user toggles back to `All`, the snapshot MUST be restored as the expansion state — every directory the user had opened in the full-tree view is open again. Directories that were auto-expanded as ancestors of change-set entries in `Changed` mode MUST NOT carry over into `All` (they were not user choices). When the user expands or collapses a directory while in `Changed` mode, that interaction is recorded as a user choice for the duration of `Changed`, but does NOT modify the stored full-tree snapshot — a subsequent toggle back to `All` SHALL still restore the original snapshot.

#### Scenario: Full-tree expansions survive a filter on/off cycle
- **WHEN** the user has manually expanded `src/`, `src/auth/`, and `tests/` in the `All` view
- **AND** the user toggles the filter to `Changed`
- **AND** the user toggles back to `All`
- **THEN** `src/`, `src/auth/`, and `tests/` are still expanded
- **AND** no additional directories are expanded that the user did not open

#### Scenario: Filter auto-expansions do not leak into the unfiltered view
- **WHEN** the user toggles the filter to `Changed`
- **AND** the change set's ancestors auto-expand `docs/guides/` and `vendor/legacy/`
- **AND** the user toggles back to `All`
- **THEN** `docs/guides/` and `vendor/legacy/` are NOT expanded in the `All` view (unless the user had already expanded them before turning the filter on)

### Requirement: Reveal the active document via temporary inclusion when follow crosses the filter boundary

When the filter is `Changed` and follow-mode auto-switches the active document to a path that is not in the filtered set, the path set fed to the library MUST be expanded to include exactly that path plus its ancestor directories, so the row is rendered and selected. The temporarily-included row MUST be marked with a distinguishing visual cue (subtle dimming or italicization) so users can distinguish "this row is here because Follow asked" from "this row is in the change set". When the active document subsequently changes — to another path in the change set, or to another path outside it (in which case the previous temporary inclusion is dropped and the new one added) — the temporary inclusion MUST be recomputed and the previous temporary row removed. The user's filter setting MUST NOT be toggled by this reveal — `Changed` remains active throughout.

#### Scenario: Follow auto-switch to an unfiltered path reveals only that one row
- **WHEN** the filter is `Changed`
- **AND** follow-mode auto-switches the active document to `docs/glossary.md` which is not in the change set
- **THEN** the tree includes `docs/glossary.md` and its ancestor directories
- **AND** every other row in the tree continues to be a change-set entry or its ancestor
- **AND** the filter chip continues to read `Changed`

#### Scenario: The temporarily-revealed row carries a visual cue
- **WHEN** a row was added to the tree solely because it is the follow-revealed active path
- **THEN** that row renders with a visual cue (dimmed or italicized) distinct from the unfiltered rows around it

#### Scenario: Switching the active document to another unfiltered path replaces the temporary inclusion
- **WHEN** the filter is `Changed`
- **AND** a temporary reveal is showing path P1
- **AND** follow-mode auto-switches the active document to a different unfiltered path P2
- **THEN** P1 is no longer included in the tree
- **AND** P2 (and its ancestors) is now included with the same visual cue

### Requirement: Render the document tree through `@pierre/trees`
The sidebar document tree SHALL be rendered by the [`@pierre/trees`](https://github.com/pierrecomputer/pierre/tree/main/packages/trees) library (vanilla entry). uatu MUST use the library's path-array input (`paths`) and selection API (`getSelectedPaths` / equivalent observer hook) as the public surface for the tree. uatu MUST NOT re-implement, replace, or mutate the library's row DOM, expansion handling, or keyboard navigation. Selection events from the library MUST drive the existing document-routing flow exactly as a sidebar tree click does today; manual selection MUST disable follow mode under the existing rules. Directory expansion semantics, including default open/closed state and reveal behavior on selection changes, MUST defer to whatever the library provides; uatu MUST NOT layer custom open-set tracking on top.

#### Scenario: Files pane renders the library's tree
- **WHEN** the `Files` pane renders for a folder-scoped session
- **THEN** the visible tree DOM is owned by `@pierre/trees`
- **AND** uatu does not emit its own `<ul>`/`<details>`/`<summary>` tree markup

#### Scenario: Selecting a clickable document loads its preview
- **WHEN** a user selects a non-binary document row in the tree
- **THEN** the library reports that path through its selection API
- **AND** the preview switches to that document
- **AND** follow mode is disabled in the same way as before the swap

#### Scenario: Tree state is fed by paths, not by hand-built nodes
- **WHEN** the watched-roots index changes and the tree must re-render
- **THEN** uatu feeds an updated `paths` array into the library
- **AND** uatu does not construct or pass internal node objects to the library

### Requirement: Display file-type icons via the library's built-in `'standard'` icon set
The document tree SHALL display a small icon next to each tree leaf — both clickable and non-clickable — that reflects its file type. uatu SHALL configure `@pierre/trees` with `icons: { set: 'standard', colored: true }` so the library renders its built-in ~50-icon set inline (markdown, typescript, json, css, image, etc.). A generic fallback icon MUST be used for any extension the built-in set does not cover. Binary entries MUST also display an icon. uatu MAY override or extend the built-in icons via the library's `byFileName` and `byFileExtension` configuration hooks; baseline behavior MUST work without any overrides.

#### Scenario: Markdown documents show a markdown icon in the tree
- **WHEN** the sidebar lists a `.md` or `.markdown` file
- **THEN** the tree row shows the library's markdown icon to the left of the file name

#### Scenario: Unknown extensions fall back to a generic file icon
- **WHEN** a file extension is not covered by the built-in `'standard'` set
- **THEN** the tree row still shows an icon (the library's default/generic glyph) rather than an empty gap

#### Scenario: Binary entries also show an icon
- **WHEN** the sidebar lists a binary file (e.g. `logo.png`)
- **THEN** the tree row shows the library's icon for that extension (or the default icon if not mapped)

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

