## MODIFIED Requirements

### Requirement: Follow defines four authoritative session rules

The system SHALL implement exactly four behavioral rules linking Follow to selection and file events. No other code path SHALL change `appState.followEnabled` or `appState.selectedDocument` in response to a file event, native tree-row interaction, or the Follow chip click.

**Rule A (user explicitly navigates through the tree):** Activating a file SHALL select that document and set `followEnabled` to `false`, including when the file is already selected. Manually collapsing any ancestor of the active file SHALL instead clear the document selection and preview, establish intentional-empty selection, and set `followEnabled` to `false`. Reopening the directory SHALL NOT restore the document. Opening a folder, collapsing an unrelated folder, moving focus without an ancestor collapse, or collapsing with no active document SHALL leave the active document and Follow unchanged. Both Rule A outcomes MUST fire only for genuine user interactions, including pointer, touch, and supported keyboard activation/collapse; programmatic or library-driven callbacks during mount, refresh, reset, or filter reconciliation MUST NOT trigger them (see "Tree-mount user-click guard" below).

**Rule B (user clicks the Follow chip):** `followEnabled` MUST be flipped. When the flip is `false → true`, intentional-empty selection SHALL be cleared and the selection MUST jump to the newest-mtime non-binary document in the current session if that document differs from the current selection.

**Rule C (file changes on disk, Follow on):** Selection MUST move to the changed document.

**Rule D (file changes on disk, Follow off):** Selection MUST NOT change. If the changed document equals the current selection, the preview MUST reload its content in place. If the changed document differs from the current selection, no preview reload occurs but the tree MUST still refresh its row set. Intentional-empty selection SHALL remain empty: a file event MUST NOT choose a default document or restore a previously closed document.

#### Scenario: Rule A — clicking a row turns Follow off
- **WHEN** Follow is on and the user clicks `guides/setup.md` in the tree
- **THEN** the selection becomes `guides/setup.md`
- **AND** `followEnabled` becomes `false`
- **AND** the Follow chip's `aria-pressed` attribute reads `"false"`

#### Scenario: Rule A — activating the selected file still turns Follow off
- **GIVEN** Follow is on and `guides/setup.md` is already selected and visible
- **WHEN** the user activates that file by pointer, touch, or keyboard
- **THEN** manual document navigation occurs exactly once and `followEnabled` becomes `false`
- **AND** the file remains selected and its preview is displayed

#### Scenario: Rule A — collapsing an ancestor closes the document
- **GIVEN** `guides/setup.md` is active and Follow is on
- **WHEN** the user manually collapses `guides/`
- **THEN** the active document selection and preview are empty
- **AND** `followEnabled` becomes `false` and the Follow toggle reflects it
- **AND** reopening `guides/` does not restore selection or enable Follow

#### Scenario: Rule A — unrelated folder collapse does not change Follow
- **GIVEN** `guides/setup.md` is active and `metadata/` is expanded
- **WHEN** the user collapses `metadata/`
- **THEN** the active document, preview, and Follow state remain unchanged

#### Scenario: Rule B — turning Follow on jumps to the newest changed file
- **WHEN** Follow is off, the selection is `README.md`, and the newest-mtime document in the session is `guides/setup.md`
- **AND** the user clicks the Follow chip
- **THEN** `followEnabled` becomes `true`
- **AND** the selection moves to `guides/setup.md`

#### Scenario: Rule B — turning Follow on with selection already on the newest file
- **WHEN** Follow is off, the selection is `README.md`, and the newest-mtime document is also `README.md`
- **AND** the user clicks the Follow chip
- **THEN** `followEnabled` becomes `true`
- **AND** the selection remains `README.md`
- **AND** the preview does not reload

#### Scenario: Rule B — turning Follow on ends intentional emptiness
- **GIVEN** a manual ancestor collapse left the document selection and preview empty and Follow off
- **AND** an eligible document exists in the session
- **WHEN** the user clicks the Follow chip
- **THEN** `followEnabled` becomes `true` and the newest-mtime eligible document is selected, revealed, and previewed
- **AND** intentional-empty selection no longer suppresses normal Follow behavior

#### Scenario: Rule C — file change with Follow on moves the selection
- **WHEN** Follow is on, the selection is `README.md`, and a watcher event reports that `guides/setup.md` changed
- **THEN** the selection moves to `guides/setup.md`
- **AND** the preview renders `guides/setup.md`

#### Scenario: Rule D — file change with Follow off reloads the current document in place
- **WHEN** Follow is off, the selection is `README.md`, and a watcher event reports that `README.md` changed
- **THEN** the selection remains `README.md`
- **AND** the preview reloads `README.md` so the updated content is visible

#### Scenario: Rule D — file change with Follow off for a non-selected document does not switch selection
- **WHEN** Follow is off, the selection is `README.md`, and a watcher event reports that `guides/setup.md` changed
- **THEN** the selection remains `README.md`
- **AND** the preview is NOT reloaded
- **AND** the tree's row set is updated so `guides/setup.md`'s row reflects the change

#### Scenario: Rule D — file events preserve deliberate deselection
- **GIVEN** manually collapsing the active document's ancestor cleared selection and turned Follow off
- **WHEN** a watcher update changes the formerly active document or another file
- **THEN** the document selection and preview remain empty and Follow remains off
- **AND** the tree still receives the refreshed file list

### Requirement: Tree-mount user-click guard

The `TreeView` wrapper around `@pierre/trees` SHALL distinguish genuine user-initiated file activation and ancestor collapse from library-driven or programmatic selection and expansion changes. Rule A's document-selection and deselection outcomes MUST execute only for the corresponding real user action. Every code path that programmatically reconciles tree selection or expansion — including initial mount with a pre-selected document, file-event refresh, route-driven re-selection, change-overview navigation, path resets, filter transitions, and expansion restoration — MUST suppress Rule A's selection-clearing and Follow-off effects for that programmatic operation. This guard MUST NOT swallow subsequent genuine user input or prevent the library's keyboard navigation.

#### Scenario: Initial mount does not flip Follow off
- **WHEN** the SPA boots with `followEnabled = true` (server default) and a pre-selected document
- **AND** the `@pierre/trees` library fires its `onSelectDocument` callback for the pre-selected row during mount
- **THEN** `followEnabled` remains `true`
- **AND** the Follow chip's `aria-pressed` attribute reads `"true"`

#### Scenario: File-event-driven re-selection does not flip Follow off
- **WHEN** Follow is on, a file changes on disk, and the system applies the new selection by calling into `TreeView` programmatically
- **AND** the `@pierre/trees` library fires its `onSelectDocument` callback as a side effect of the programmatic re-selection
- **THEN** `followEnabled` remains `true`

#### Scenario: User click after programmatic re-selection still flips Follow off
- **WHEN** the system has just performed a programmatic re-selection
- **AND** the user immediately clicks a different tree row
- **THEN** Rule A fires
- **AND** `followEnabled` becomes `false`

#### Scenario: Programmatic collapse does not close the active document
- **GIVEN** a document is active
- **WHEN** a path reset, filter transition, or expansion restoration programmatically collapses a directory
- **THEN** that programmatic collapse does not clear the document selection or preview
- **AND** it does not turn Follow off

#### Scenario: Manual collapse after reconciliation still closes the document
- **GIVEN** programmatic tree reconciliation has completed with an active document
- **WHEN** the user manually collapses an expanded ancestor of that document
- **THEN** Rule A's deselection outcome clears the document selection and preview and turns Follow off
- **AND** keyboard focus remains available on the operated directory while it is still displayed, otherwise on a remaining visible row
