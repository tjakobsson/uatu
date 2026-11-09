# document-tree Specification

## Purpose
Provide a library-backed document tree with selection and reveal behavior, filtered path sets, file counts and icons, and repository-status annotations.

## Requirements

### Requirement: Preserve manual directory open/closed state in the document tree
Directories in the sidebar tree SHALL render collapsed (closed) by default, matching the conventions of common file trees (VS Code, Finder, GitHub). When a user expands or collapses a directory, that explicit choice SHALL persist across document selections and across sidebar re-renders triggered by file changes — including filesystem-driven `resetPaths` calls into the library — except for ancestors required to reveal a newly active document. When a document becomes active (initial default, follow-mode auto-switch, or explicit document navigation), the system SHALL reveal its path by expanding every ancestor directory between the watched root and the document, then marking that document's row as selected. Reveal MUST be purely additive — it opens ancestors but never closes any directory the user has opened. In the All view, background refreshes that leave the document selection unchanged, including an intentionally empty selection, MUST preserve surviving directories' open/closed state; refreshing content or rebuilding the file list MUST NOT itself request a new reveal or choose a document. A manual collapse of an ancestor of the active document SHALL instead clear the active document as specified by the manual-collapse requirement below. The separate Changed-filter expansion and filter-transition policies remain unchanged and MUST NOT be mistaken for manual deselection. Folder expansion need not persist across page reloads; intentional document deselection SHALL persist as specified below.

A new selection that cannot yet be represented in the tree SHALL receive its pending reveal when it first becomes available; this completes the selection change rather than treating it as an unchanged-selection background refresh. A previously represented selection returning at the same path after temporary absence SHALL synchronize selection without a new reveal only when the application has continuously retained that document as its requested selection. Navigating to another document, even an unavailable one, and then returning SHALL count as a new selection. Explicitly clearing selection and subsequently selecting the same document SHALL count as a new selection.

#### Scenario: Directories start collapsed
- **WHEN** the document tree is first rendered and the default document is at a watched root with no ancestor directories
- **THEN** nested directories render collapsed and only top-level documents are visible until the user expands a directory

#### Scenario: Initial selection inside a nested directory is revealed on first paint
- **WHEN** the SPA boots with an initial selected document inside a nested directory (e.g. follow-mode was on and the latest file is in `guides/`)
- **THEN** the tree renders with every ancestor directory of that document expanded
- **AND** the row for that document is rendered as selected

#### Scenario: Follow-mode auto-switch reveals the path to the newly active document
- **WHEN** follow mode is enabled and a different file inside a nested directory changes on disk
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

#### Scenario: Updating a document does not reveal it after manual deselection
- **GIVEN** the Files-pane filter is All
- **AND** manually collapsing `guides/` cleared the formerly active `guides/setup.md`
- **WHEN** `guides/setup.md` is modified and the refresh is applied
- **THEN** `guides/` remains collapsed
- **AND** the document selection and preview remain empty and Follow remains off

#### Scenario: Adding an unrelated file preserves both open and closed directories
- **GIVEN** the Files-pane filter is All and Follow is off
- **AND** the user selected `guides/setup.md`, collapsed `guides/`, and expanded `metadata/`
- **WHEN** an unrelated file is added and appears in the refreshed file list
- **THEN** `guides/` remains collapsed and `metadata/` remains expanded
- **AND** the selection and preview remain empty after the ancestor collapse

#### Scenario: Removing or renaming an unrelated file preserves surviving directories
- **GIVEN** the Files-pane filter is All and Follow is off
- **AND** the user has manually expanded some directories and collapsed an ancestor of the formerly active document, clearing selection
- **WHEN** an unrelated file is removed or renamed and the refreshed file list reflects that change
- **THEN** every surviving directory retains its previous open/closed state
- **AND** no document is selected and the preview remains empty

#### Scenario: A temporarily unavailable selection returns without a new reveal
- **GIVEN** the Files-pane filter is All and Follow is off
- **AND** the active document was represented in the tree before it became unavailable
- **AND** the application continuously retains that requested document without manual ancestor collapse or other explicit deselection
- **WHEN** the same active document becomes available again at the same path
- **THEN** surviving directory expansion state is preserved without a new reveal
- **AND** that document remains selected rather than choosing a fallback document

#### Scenario: Expanded descendants survive beneath a collapsed ancestor
- **GIVEN** the Files-pane filter is All and `guides/deep/` is expanded beneath manually collapsed `guides/`
- **WHEN** an unrelated file is added, removed, or renamed without new document navigation
- **THEN** `guides/` remains collapsed
- **AND** reopening `guides/` shows `guides/deep/` still expanded
- **AND** reopening does not select a document that was cleared by the earlier collapse

#### Scenario: A new selection is revealed when it first becomes available
- **GIVEN** the Files-pane filter is All
- **AND** the application selected a different document while that document was unavailable
- **WHEN** that selected document first becomes available in the tree
- **THEN** its ancestors expand and its row is selected, completing the pending selection reveal
- **AND** other manually expanded directories stay expanded

#### Scenario: Reselecting a document after clearing selection requests a reveal
- **GIVEN** manually collapsing an ancestor cleared the active document selection
- **WHEN** an explicit document-navigation action selects that same document again
- **THEN** its ancestors expand and its row is selected as a new selection
- **AND** the preview displays the selected document

#### Scenario: Returning after navigating to an unavailable document requests reveal
- **GIVEN** document A was represented and the application subsequently selected unavailable document B
- **AND** A's folder was collapsed while it was unrelated to the requested document B
- **WHEN** the application explicitly selects A again
- **THEN** A's ancestors expand and its row is selected as a new selection
- **AND** unrelated expanded directories remain expanded

#### Scenario: Follow does not reveal again when the active document stays the same
- **GIVEN** the Files-pane filter is All and Follow is on
- **AND** the user has arranged unrelated folders while leaving the active document's ancestors open
- **WHEN** that document is updated and remains the active document after refresh
- **THEN** its preview refreshes without changing the existing folder arrangement
- **AND** Follow remains on

### Requirement: Manual ancestor collapse closes the active document
When the user manually collapses any ancestor directory of the active file, the system SHALL clear the application's active document selection, clear the preview, and turn Follow off. This SHALL apply in both All and Changed views, for pointer, touch, and supported keyboard collapse operations. The preview SHALL no longer present the closed file's title, path, or content. The tree SHALL have no selected row after this action; focus SHALL remain on the operated directory so native keyboard navigation can continue, whenever that directory is still present in the displayed tree. When closing the document removes the operated directory from the displayed tree (the Changed view was showing it only because the active file was open), focus SHALL move to a remaining visible row; the filter SHALL NOT retain an otherwise-excluded row to hold focus. The action SHALL NOT automatically switch a touch device from Files to Preview.

The resulting intentional empty selection SHALL survive reopening the folder, content/index refreshes, additions/removals/renames, filter transitions, reconnect/resume reconciliation, and page reloads. None of these operations SHALL restore the closed file, choose a default document, or enable Follow. The current session location and remembered document selection SHALL represent the deselected state rather than automatically restoring the closed file. Existing first-visit/default selection behavior SHALL remain unchanged for users who have not deliberately deselected a document. Explicit document navigation or enabling Follow SHALL resume the existing selection behavior and end intentional emptiness.

Only the intentional-deselection indication SHALL be persisted in this browser, scoped to the workspace. Existing document-path, Follow, and other personal preferences SHALL retain their existing Hub-backed persistence. The browser indication SHALL NOT be sent as a new personal-state API field, propagate to another browser, or force already-open clients to navigate. Background reconciliation in another tab SHALL NOT erase the indication for future reloads.

Clicking or tapping a directory row SHALL only expand or collapse it. A directory row SHALL never be presented as selected, and pointer or touch interaction SHALL NOT leave a focus ring on the row; the focus ring SHALL be shown only for keyboard navigation. On devices without hover support, a tapped row SHALL NOT keep a hover tint that resembles selection. Clicking a directory that is not a collapsing ancestor of the active file SHALL keep the active file selected.

Collapsing an unrelated directory, opening a directory, moving keyboard focus without collapsing, or collapsing when no document is active SHALL NOT close a document or change Follow. Programmatic directory changes, including rebuilds, filter reconciliation, and restoration of expansion, SHALL NOT count as manual collapse. A previously initiated preview load SHALL NOT repopulate the preview after explicit deselection.

#### Scenario: Pointer collapse closes a nested active document
- **GIVEN** `guides/setup.md` is active and `guides/` is expanded
- **WHEN** the user clicks to collapse `guides/`
- **THEN** there is no active or selected file and the preview is empty
- **AND** Follow is off and keyboard focus remains on `guides/`

#### Scenario: Changed-view collapse that removes the operated directory moves focus
- **GIVEN** the Changed view shows unchanged `guides/setup.md` only because it is the active document, and `other/changed.md` is changed
- **WHEN** the user collapses `guides/`
- **THEN** the document selection and preview clear and Follow turns off
- **AND** `guides/` leaves the Changed view and keyboard focus moves to a remaining visible row

#### Scenario: Collapsing any ancestor closes the active document
- **GIVEN** `guides/deep/nested.md` is active
- **WHEN** the user collapses either `guides/` or `guides/deep/`
- **THEN** the document selection and preview clear and Follow turns off
- **AND** unrelated expanded directories remain expanded

#### Scenario: Keyboard collapse is equivalent to pointer collapse
- **GIVEN** an expanded ancestor of the active document has keyboard focus
- **WHEN** a supported keyboard interaction actually collapses that directory
- **THEN** the document selection and preview clear and Follow turns off
- **AND** subsequent keyboard navigation continues from the directory

#### Scenario: Keyboard focus movement is not deselection
- **GIVEN** a document is active
- **WHEN** a keyboard action moves focus without collapsing an ancestor of that document
- **THEN** the active document, preview, and Follow state remain unchanged

#### Scenario: Touch collapse stays in Files and clears Preview
- **GIVEN** the active document is nested under an expanded directory and the touch Files tab is displayed
- **WHEN** the user taps to collapse its ancestor
- **THEN** Files remains the displayed tab and Follow is off
- **AND** opening the Preview tab shows an empty preview

#### Scenario: Directory clicks only toggle expansion
- **GIVEN** `guides/setup.md` is active
- **WHEN** the user clicks `metadata/` to open it and clicks it again to close it
- **THEN** `metadata/` is never presented as selected and shows no focus ring
- **AND** `guides/setup.md` remains the selected file
- **AND** moving focus with the keyboard afterwards shows the focus ring on the focused row

#### Scenario: A tapped folder is not tinted on touch devices
- **GIVEN** a touch device without hover support, such as iOS Safari, which keeps `:hover` on the last tapped element
- **WHEN** the user taps `metadata/`
- **THEN** `metadata/` has the same background as other unselected rows
- **AND** a selected file still shows its selection background

#### Scenario: Reopening does not reselect or reopen the document
- **GIVEN** a manual ancestor collapse cleared the active document
- **WHEN** the user expands that directory again
- **THEN** no row, including that directory, is selected and the preview remains empty
- **AND** Follow remains off until explicitly enabled

#### Scenario: Unrelated collapse leaves the active document alone
- **GIVEN** `guides/setup.md` is active and `metadata/` is expanded
- **WHEN** the user collapses `metadata/`
- **THEN** `guides/setup.md` remains active and its preview stays displayed
- **AND** Follow retains its prior state

#### Scenario: Collapse without an active document does not change Follow
- **GIVEN** there is no active document
- **WHEN** the user collapses a directory
- **THEN** no document is selected and the preview remains empty
- **AND** Follow retains its prior state

#### Scenario: A background update cannot undo deliberate deselection
- **GIVEN** a manual ancestor collapse cleared selection and turned Follow off
- **WHEN** the former document or another file changes and the refresh is applied
- **THEN** the selection and preview remain empty and Follow stays off
- **AND** surviving folder state is preserved under the active filter's existing expansion policy

#### Scenario: Filter transitions do not restore an intentionally closed document
- **GIVEN** a manual ancestor collapse cleared selection
- **WHEN** the user switches between All and Changed
- **THEN** selection and preview remain empty and Follow stays off
- **AND** the filter retains its existing directory-expansion policy

#### Scenario: Manual ancestor collapse also closes the document under Changed
- **GIVEN** Changed is active and a document is selected under an expanded directory
- **WHEN** the user manually collapses that ancestor
- **THEN** selection and preview clear and Follow turns off
- **AND** subsequent filter reconciliation does not recreate a document selection

#### Scenario: Programmatic folder changes are not user deselection
- **GIVEN** a document is active
- **WHEN** a path rebuild, filter transition, or expansion restoration changes directory visibility without a manual collapse action
- **THEN** that programmatic directory change does not clear the active document or turn Follow off

#### Scenario: Reload remembers deliberate deselection
- **GIVEN** a manual ancestor collapse cleared selection and turned Follow off
- **WHEN** the page reloads
- **THEN** no document is selected or previewed and Follow remains off
- **AND** the former stored document path does not restore the closed document
- **AND** folder expansion may return to its normal startup defaults

#### Scenario: Reconnect retains intentional emptiness
- **GIVEN** the selection was deliberately cleared by a manual ancestor collapse
- **WHEN** the live connection reconnects or the page resumes and reconciles fresh state
- **THEN** the document selection and preview remain empty and Follow remains off

#### Scenario: Deliberate emptiness is browser-local and workspace-scoped
- **GIVEN** a manual ancestor collapse established intentional emptiness in workspace A
- **WHEN** another workspace opens in this browser or workspace A opens in another browser
- **THEN** the intentional-deselection indication does not affect that other workspace or browser
- **AND** their existing saved document and Follow preferences retain their normal behavior

#### Scenario: Another tab's background reconciliation does not erase deliberate emptiness
- **GIVEN** one tab deliberately cleared its document and another tab remains on a document in the same workspace
- **WHEN** a background update reconciles the other tab and the empty tab subsequently reloads
- **THEN** the reloaded tab remains empty with Follow off
- **AND** the other already-open tab is not forced to clear its document

#### Scenario: First visit still uses normal startup selection
- **GIVEN** the user has not deliberately cleared document selection in this workspace
- **WHEN** the page boots without a selected document
- **THEN** the existing startup/default-document selection rules still apply

#### Scenario: Explicit navigation resumes document viewing
- **GIVEN** selection and preview are intentionally empty after an ancestor collapse
- **WHEN** the user explicitly navigates to a document
- **THEN** that document is selected, revealed, and displayed through the normal navigation flow
- **AND** its selection replaces the remembered intentional-empty state

#### Scenario: Enabling Follow resumes its normal selection behavior
- **GIVEN** selection and preview are intentionally empty and at least one eligible document exists
- **WHEN** the user enables Follow
- **THEN** the normal Follow rule selects and reveals the appropriate document and displays its preview
- **AND** the intentional-empty state is cleared

#### Scenario: A late preview response cannot reopen a closed document
- **GIVEN** a preview request for the active document is in flight
- **WHEN** the user collapses an ancestor and then that request completes
- **THEN** selection and preview remain empty and Follow stays off
- **AND** no title, path, rendered content, source, or diff from that old request replaces the empty preview

### Requirement: Display sidebar file count breakdown
The sidebar SHALL display one quiet count of eligible file entries in the selected All, Recent, or Changed view after visibility, filename/path, and media-type filtering. The count SHALL include eligible entries outside the current viewport and SHALL exclude directory rows; All SHALL count files regardless of collapsed folders. Changed SHALL include any existing temporary active-file inclusion. The count MUST NOT display binary subcounts, hidden counts, or N-of-M wording. Its accessible name SHALL identify it as a file/result count.

#### Scenario: Counter shows only the total when the tree is uniform
- **WHEN** All contains three eligible text files
- **THEN** the quiet count is 3 and its accessible label identifies three files

#### Scenario: Counter surfaces the binary subcount
- **WHEN** All contains a mix of text and binary files
- **THEN** the count includes all eligible files without a binary subcount

#### Scenario: Counter never includes a hidden segment
- **WHEN** exposure or visibility rules omit files
- **THEN** the count reflects the eligible set and has no hidden segment

#### Scenario: Counter shows `N of M` form under the Changed filter
- **WHEN** Changed contains 12 eligible entries in a workspace with 1,840 indexed entries
- **THEN** the quiet count is 12 rather than 12 of 1,840

#### Scenario: Binary subcount under filter reflects the visible binary count
- **WHEN** two of Changed's 12 eligible files are binary
- **THEN** the quiet count remains 12 with no separate binary statistic

#### Scenario: Collapsed folders do not shrink the count
- **WHEN** All contains 128 eligible files and most containing directories are collapsed
- **THEN** the count remains 128 rather than counting mounted rows

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
The sidebar document tree SHALL be rendered by the [`@pierre/trees`](https://github.com/pierrecomputer/pierre/tree/main/packages/trees) library (vanilla entry). uatu MUST use the library's path-array input (`paths`) and selection API (`getSelectedPaths` / equivalent observer hook) as the public surface for the tree. uatu MUST NOT re-implement, replace, or mutate the library's row DOM, expansion handling, or keyboard navigation. Selection events from the library MUST drive the existing document-routing flow exactly as a sidebar tree click does today; manual file selection MUST disable follow mode under the existing rules. The library SHALL remain the source of truth for current directory expansion state. Application-directed default expansion, state preservation across path rebuilds and filter transitions, and additive reveal SHALL use the library's public APIs; uatu MUST NOT maintain a competing continuously tracked open/closed-state model. Observing native user actions to route document activation or explicit ancestor-collapse deselection SHALL leave the library's own expansion and keyboard behavior intact, and programmatic updates MUST NOT be interpreted as user navigation.

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

#### Scenario: Activating an already-selected file still performs manual navigation
- **GIVEN** Follow is on and the active file is already selected and visible in the tree
- **WHEN** the user clicks or keyboard-activates that same file
- **THEN** the existing manual-navigation flow runs exactly once and disables Follow
- **AND** touch mode brings the Preview surface forward
- **AND** directory interactions and programmatic selection do not trigger file activation

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

### Requirement: Annotate tree rows with git status
When repository change data is available, the document tree SHALL annotate changed paths from the changed-files list using its existing Git-status presentation. Supported statuses SHALL include added, modified, deleted, renamed, untracked, and ignored; renamed annotations SHALL apply at the new path. Change annotations SHALL update when repository change data changes and SHALL coexist with All/Recent/Changed presentation controls. Independently supplied known Git-ignore classification SHALL permit ignored styling without waiting for repository change collection. Ignored files SHALL use a muted filename and faded file icon without a visible ignored-status label or badge. Selection, focus, recency cues, and playback actions SHALL remain legible and usable. Unknown ignore status MUST NOT be presented as confirmed ignored or confirmed clean. Recent SHALL use the same muted ignored treatment.

#### Scenario: Modified file shows a modified annotation
- **WHEN** repository change data reports an uncommitted modification
- **THEN** the tree annotates that file in its normal hierarchical position

#### Scenario: Untracked file shows an untracked annotation
- **WHEN** repository change data reports an unstaged new file
- **THEN** the corresponding row shows an untracked annotation

#### Scenario: Annotations clear when changes are committed
- **WHEN** a commit removes the changes and updated repository data confirms it
- **THEN** those change annotations clear

#### Scenario: No annotations when git is unavailable
- **WHEN** repository change data and ignore classification are unavailable
- **THEN** the tree still lists eligible files without inventing Git-status annotations

#### Scenario: Gitignored file visible in the tree shows the ignored annotation
- **WHEN** a visible file is known to be Gitignored
- **THEN** its filename is muted and file icon faded without repeated visible status text
- **AND** it remains selectable and distinguishable from clean tracked or untracked entries

#### Scenario: An ignored file is selected or playing
- **WHEN** a muted ignored row is selected or its clip is auditioned
- **THEN** selection and playback controls remain clearly distinguishable and actionable

### Requirement: Ignored folders load their contents when expanded
The tree SHALL show each Git-ignored folder entry as a folder row with the muted ignored treatment, following Show ignored files like ignored files do. A folder whose level has not been listed SHALL be expandable even though its contents are unknown. Expanding it by pointer, touch, or keyboard SHALL request that level's listing and show its files and subfolders in alphabetical tree order when the listing arrives, merged with any of its files already known from live writes. While the listing is pending, the row SHALL indicate loading without moving focus or selection. A failed listing SHALL leave the folder expandable and show a retry affordance on the row. Collapsing and expanding a listed folder again SHALL NOT request it again. Programmatic expansion during mount, reveal of a selected file, or filter reconciliation SHALL NOT request listings, except for the ancestors needed to reveal an explicitly selected file. The file count SHALL include known files only; files inside levels nobody has listed are not counted.

#### Scenario: Expanding `build/` lists its first level
- **WHEN** the user expands the muted `build/` row that has not been listed
- **THEN** a loading indication appears on that row and is replaced by `build/`'s files and subfolders
- **AND** focus stays on the `build/` row

#### Scenario: A live render is visible before expansion completes
- **WHEN** `build/renders/take-5.wav` was captured from a live write and the user expands `build/` and then `build/renders/`
- **THEN** `take-5.wav` is shown together with the rest of the listed files, once each

#### Scenario: A listing fails
- **WHEN** the listing request for `node_modules/` fails
- **THEN** the folder stays expandable and offers a retry, and the rest of the tree is unchanged

#### Scenario: Show ignored files off hides ignored folders
- **WHEN** Show ignored files is off
- **THEN** ignored folder rows and their known contents are hidden, except paths revealed by an `ignore.exclude` negation

#### Scenario: The count reflects known files
- **WHEN** `node_modules/` has not been listed
- **THEN** the file count does not include its contents, and listing a level adds that level's eligible files to the count
