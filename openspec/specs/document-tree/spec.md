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
The sidebar SHALL display a file count for the current scope. The count SHALL always show the total number of files visible in the tree. When the visible set contains binary files, the count SHALL additionally show how many are binary. The hardcoded directory denylist (e.g. `node_modules/`, `.git/`) MUST NOT contribute to a hidden count and the counter MUST NOT expose a `hidden` segment, since filtering is now configured through a single source of truth (`.uatu.json tree.exclude` plus `.gitignore` honoring) rather than the previous dual-source `.uatuignore` + `.gitignore` model.

#### Scenario: Counter shows only the total when the tree is uniform
- **WHEN** the watched roots contain only viewable text and Markdown files
- **THEN** the sidebar counter reads `N files` (e.g. `3 files`)

#### Scenario: Counter surfaces the binary subcount
- **WHEN** the watched roots contain a mix of viewable and binary files
- **THEN** the sidebar counter reads `N files · M binary` where M is the number of binary entries in the tree

#### Scenario: Counter never includes a hidden segment
- **WHEN** the watch root has files filtered by `.uatu.json tree.exclude` or `.gitignore`
- **THEN** the sidebar counter does NOT include a `· hidden` segment
- **AND** the counter reflects only the visible total and the binary subcount

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
When the watched repository is git-backed AND the review-load result for that repository has status `available`, the document tree SHALL display the git status of each changed path as a row annotation on the corresponding tree row, using `@pierre/trees`' git-status API. The supported statuses MUST include at minimum: added, modified, deleted, and untracked. Renamed paths MUST display the annotation on the new path. Annotations MUST update whenever the repository's review-load result changes. The annotations replace the previous All/Changed Files-pane toggle: there is one tree, and changed files are visually distinguished in place.

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

