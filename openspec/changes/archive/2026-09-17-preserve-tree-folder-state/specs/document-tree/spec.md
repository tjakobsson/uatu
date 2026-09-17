## MODIFIED Requirements

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

## ADDED Requirements

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
