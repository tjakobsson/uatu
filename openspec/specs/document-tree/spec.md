# document-tree Specification

## Purpose
Provide a library-backed document tree with selection and reveal behavior, filtered path sets, file counts and icons, and repository-status annotations.

## Requirements

### Requirement: Preserve manual directory open/closed state in the document tree
Directories in the sidebar tree SHALL render collapsed (closed) by default, matching common file trees (VS Code, Finder, GitHub). Manual open/closed choices SHALL survive selections and file-driven rebuilds except for additive reveal of a newly active document. Manual ancestor collapse SHALL clear the document under the requirement below; Changed-filter policies SHALL remain unchanged and separate from manual deselection.

#### Scenario: New active documents add required ancestors to manual expansion choices
- **WHEN** a document becomes active by initial default, Follow auto-switch, or explicit navigation
- **THEN** the system SHALL expand every ancestor between watched root and document, then mark its row selected
- **AND** reveal MUST be purely additive, never closing user-opened directories
- **AND** explicit expansion/collapse choices SHALL persist across document selections and file-driven sidebar re-renders, including filesystem-driven library `resetPaths`, except ancestors required by a newly active document

#### Scenario: Unchanged-selection refresh preserves surviving directory state
- **GIVEN** the All view's document selection is unchanged, including intentionally empty selection
- **WHEN** content refreshes or the file list rebuilds
- **THEN** surviving directories' open/closed state MUST be preserved; refresh/rebuild MUST NOT itself request reveal or choose a document

#### Scenario: Changed policies are not manual deselection
- **WHEN** Changed-filter expansion or filter-transition policies apply
- **THEN** those policies remain unchanged and MUST NOT be mistaken for manual deselection

#### Scenario: Reload persistence differs for expansion and intentional deselection
- **WHEN** the page reloads
- **THEN** folder expansion need not persist, but intentional document deselection SHALL persist as specified below

#### Scenario: Pending and returning selections distinguish new navigation from continuous retention
- **WHEN** a selected path first becomes representable or returns after temporary absence
- **THEN** a new selection SHALL receive its pending reveal on first availability, completing the selection change rather than counting as unchanged-selection refresh
- **AND** a previously represented same-path selection SHALL synchronize without new reveal only if continuously retained as the requested selection

#### Scenario: Navigation away or explicit clearing makes reselection new
- **WHEN** navigation goes to another document, even an unavailable one, and returns, or selection is explicitly cleared and the same document is selected again
- **THEN** it SHALL count as a new selection, even if that path was already representable in the tree

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
When the user manually collapses any ancestor directory of the active file, the system SHALL clear the application's active document selection, clear the preview, and turn Follow off. This SHALL apply in both All and Changed views, for pointer, touch, and supported keyboard collapse operations. The resulting intentional emptiness SHALL persist locally for the workspace until explicit navigation or enabling Follow ends it.

#### Scenario: Ancestor collapse clears all selected-document presentation and preserves usable focus
- **WHEN** the user manually collapses an active-file ancestor
- **THEN** the preview SHALL no longer present the closed file's title, path, or content, and the tree SHALL have no selected row
- **AND** focus SHALL remain on the operated directory while it remains displayed so native keyboard navigation can continue
- **AND** if closing removes that directory (Changed showed it only for the open active file), focus SHALL move to a remaining visible row; the filter SHALL NOT retain an otherwise-excluded row merely to hold focus
- **AND** the action SHALL NOT automatically switch touch devices from Files to Preview
- **AND** a previously initiated preview load SHALL NOT repopulate the preview after explicit deselection

#### Scenario: Intentional emptiness survives reconciliation without changing first-visit defaults
- **GIVEN** manual ancestor collapse intentionally cleared selection
- **WHEN** the folder reopens, content/index refreshes, files are added/removed/renamed, filters transition, reconnect/resume reconciliation runs, or the page reloads
- **THEN** intentional empty selection SHALL survive; none of these operations SHALL restore the closed file, choose a default document, or enable Follow
- **AND** current session location and remembered selection SHALL represent deselection rather than restoring the closed file

#### Scenario: Deliberate deselection does not change first-visit defaults
- **WHEN** a client has not deliberately deselected a document
- **THEN** existing first-visit/default selection behavior SHALL remain unchanged

#### Scenario: Explicit navigation or Follow enable ends intentional emptiness
- **WHEN** the user explicitly navigates to a document or enables Follow after intentional deselection
- **THEN** existing selection behavior SHALL resume and intentional emptiness SHALL end

#### Scenario: Browser-local deselection does not replace Hub-backed preferences
- **WHEN** intentional deselection is persisted or another tab reconciles in the background
- **THEN** only the intentional-deselection indication SHALL be persisted in this browser, scoped to the workspace; existing document-path, Follow, and other personal preferences SHALL retain Hub-backed persistence
- **AND** the indication SHALL NOT become a new personal-state API field, propagate to another browser, or force already-open clients to navigate
- **AND** another tab's background reconciliation SHALL NOT erase it for future reloads

#### Scenario: Ordinary directory interaction conveys expansion rather than file selection
- **WHEN** a user clicks, taps, or keyboard-navigates a directory row
- **THEN** clicking/tapping SHALL only expand or collapse it
- **AND** pointer/touch interaction SHALL NOT leave a focus ring; only keyboard navigation SHALL show it
- **AND** on devices without hover support a tapped row SHALL NOT retain a hover tint resembling selection
- **AND** clicking a directory that is not a collapsing active-file ancestor SHALL keep the active file selected
- **AND** unrelated collapse, opening, focus movement without collapse, or collapse without an active document SHALL NOT close a document or change Follow

#### Scenario: Directory rows never show a selected-file state
- **WHEN** a directory row is displayed, including after programmatic changes
- **THEN** it SHALL never be presented as selected

#### Scenario: Programmatic directory changes are not manual collapse
- **WHEN** directory changes are programmatic, including rebuilds, filter reconciliation, and restoration of expansion
- **THEN** they SHALL NOT count as manual collapse

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
The sidebar SHALL display one quiet count of eligible file entries in the selected All, Recent, or Changed view after visibility, filename/path, and media-type filtering. Its accessible name SHALL identify it as a file/result count.

#### Scenario: File count measures eligible entries rather than visible rows or subcounts
- **WHEN** the sidebar count is computed
- **THEN** it SHALL include eligible entries outside the viewport and exclude directories; All SHALL count files regardless of collapsed folders
- **AND** Changed SHALL include any existing temporary active-file inclusion
- **AND** the count MUST NOT display binary subcounts, hidden counts, or N-of-M wording

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

When the Files-pane filter is in the `Changed` state, the path set fed to `@pierre/trees` MUST be reduced to the changed-files list plus every ancestor directory of each file in that list. Files in the git-ignored files list MUST NOT contribute: gitignored entries are ambient git policy, not change content.

#### Scenario: Changed filtering uses public path reset and expanded ancestors
- **WHEN** Changed reduces the tree's path set
- **THEN** reduction MUST hand the library a shorter `paths` array via `resetPaths(paths, { initialExpandedPaths })`; uatu MUST NOT mutate, hide, or otherwise modify internal row visibility or DOM
- **AND** every included ancestor MUST auto-expand so change entries are visible without further clicks

#### Scenario: All and multi-root filtering retain the existing path contract
- **WHEN** the filter is All
- **THEN** All MUST supply the full path set unchanged from current behavior

#### Scenario: The same filter chip controls every root together
- **WHEN** the Files filter control is displayed in either All or Changed, with any number of watched roots
- **THEN** the same chip controls the filter and toggles all roots together regardless of root count

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

When the user toggles the filter from `All` to `Changed`, the system MUST snapshot the user's current set of manually-expanded directories. Toggling back to `All` MUST restore that snapshot so every directory opened in the full-tree view is open again.

#### Scenario: Changed expansion choices do not alter the saved All snapshot
- **WHEN** ancestors auto-expand or the user expands/collapses directories in Changed
- **THEN** auto-expanded change-set ancestors MUST NOT carry into All because they were not user choices
- **AND** manual Changed interactions SHALL be recorded for the duration of Changed but MUST NOT modify the stored full-tree snapshot
- **AND** returning to All SHALL still restore the original snapshot

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

When the filter is `Changed` and follow-mode auto-switches the active document to a path that is not in the filtered set, the path set fed to the library MUST be expanded to include exactly that path plus its ancestor directories, so the row is rendered and selected. Reveal MUST NOT toggle the user's filter setting: `Changed` remains active throughout.

#### Scenario: Temporary active-path inclusion is distinguishable and replaced on selection change
- **WHEN** a Follow-revealed temporary row is shown or the active document subsequently changes
- **THEN** the row MUST have a distinguishing cue (subtle dimming or italicization) separating "here because Follow asked" from change-set membership
- **AND** every subsequent active-document change, to an in-set or out-of-set path, MUST recompute temporary inclusion and remove the previous temporary row, adding the new one only when outside the set

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
The sidebar document tree SHALL be rendered by the [`@pierre/trees`](https://github.com/pierrecomputer/pierre/tree/main/packages/trees) library (vanilla entry). uatu MUST use its path-array input (`paths`) and selection API (`getSelectedPaths` / equivalent observer hook) as the public surface. The library SHALL remain the source of truth for current directory expansion state.

#### Scenario: Library integration preserves DOM, expansion, and keyboard ownership
- **WHEN** the app integrates the document tree, including rendering, path rebuilds, filter transitions, and additive reveal
- **THEN** uatu MUST NOT re-implement, replace, or mutate the library's row DOM, expansion handling, or keyboard navigation
- **AND** default expansion, path-rebuild/filter-transition state preservation, and additive reveal SHALL use public library APIs
- **AND** uatu MUST NOT maintain a competing continuously tracked open/closed-state model

#### Scenario: Native file and ancestor actions route intent without confusing programmatic updates
- **WHEN** the library reports selection or native user actions are observed
- **THEN** selection events MUST drive the existing document-routing flow exactly as sidebar clicks do today, with manual file selection disabling Follow under existing rules
- **AND** observing native activation or explicit ancestor-collapse deselection SHALL leave library expansion and keyboard behavior intact

#### Scenario: All programmatic tree updates remain distinct from user navigation
- **WHEN** the tree is updated programmatically, whether or not a selection callback fires
- **THEN** the update MUST NOT be interpreted as user navigation

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
The document tree SHALL display a small file-type icon next to every leaf, clickable or not. uatu SHALL configure `@pierre/trees` with `icons: { set: 'standard', colored: true }` to render its built-in ~50-icon set inline (markdown, typescript, json, css, image, etc.).

#### Scenario: File icons cover unknown and binary entries without overrides
- **WHEN** a leaf has an unmapped extension or is binary
- **THEN** an unmapped extension MUST use a generic fallback icon, and binary entries MUST also show an icon

#### Scenario: Icon customization is optional for all file types
- **WHEN** icons are configured for the tree
- **THEN** uatu MAY override or extend icons through `byFileName` and `byFileExtension`, but baseline behavior MUST work without overrides

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
When repository change data is available, the document tree SHALL annotate changed paths from the changed-files list using its existing Git-status presentation. Supported statuses SHALL include added, modified, deleted, renamed, untracked, and ignored; renamed annotations SHALL apply at the new path.

#### Scenario: Git status and independently known ignore classification update the shared presentation
- **WHEN** repository change data or known Git-ignore classification arrives
- **THEN** change annotations SHALL update with repository data and coexist with All/Recent/Changed controls
- **AND** independent known ignore classification SHALL permit ignored styling without waiting for repository change collection
- **AND** ignored files SHALL use muted filenames and faded icons without visible ignored-status labels or badges; Recent SHALL use the same treatment
- **AND** selection, focus, recency cues, and playback actions SHALL remain legible and usable

#### Scenario: Unknown ignore status remains uncertain without a classification update
- **WHEN** ignore status is unknown
- **THEN** it MUST NOT be presented as confirmed ignored or confirmed clean

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
The tree SHALL show each Git-ignored folder entry as a folder row with muted ignored treatment, following Show ignored files like ignored files do. A folder whose level has not been listed SHALL be expandable even though its contents are unknown. Unlisted-level user expansion, already-listed levels, and programmatic expansion SHALL follow their respective listing rules below.

#### Scenario: User expansion loads and merges one ignored-folder level
- **WHEN** an unlisted folder is expanded by pointer, touch, or keyboard
- **THEN** it SHALL request that level's listing and show its files/subfolders in alphabetical tree order on arrival, merged with files already known from live writes
- **AND** while pending the row SHALL indicate loading without moving focus or selection
- **AND** failed listing SHALL leave the folder expandable with a row retry affordance

#### Scenario: An already-listed ignored folder is expanded again
- **WHEN** a user collapses and expands an already-listed folder
- **THEN** it SHALL NOT request that folder's listing again

#### Scenario: Programmatic expansion avoids discovery and counts remain knowledge-based
- **WHEN** mount, selected-file reveal, or filter reconciliation expands folders programmatically
- **THEN** it SHALL NOT request listings except ancestors needed to reveal an explicitly selected file

#### Scenario: File counts include only known ignored-folder contents
- **WHEN** the file count is computed, regardless of how folders were expanded
- **THEN** it SHALL include only known files; files inside levels nobody has listed SHALL NOT be counted

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
