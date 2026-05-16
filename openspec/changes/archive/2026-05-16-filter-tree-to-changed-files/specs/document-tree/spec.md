## ADDED Requirements

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

## MODIFIED Requirements

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
