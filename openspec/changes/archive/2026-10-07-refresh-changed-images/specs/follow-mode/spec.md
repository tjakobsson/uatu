## MODIFIED Requirements

### Requirement: Follow defines four authoritative session rules

The system SHALL implement exactly four behavioral rules linking Follow to selection and file events. No other code path SHALL change `appState.followEnabled` or `appState.selectedDocument` in response to a file event, native tree-row interaction, or the Follow chip click.

**Rule A (user explicitly navigates through the tree):** Activating a file SHALL select that document and set `followEnabled` to `false`, including when the file is already selected. Manually collapsing any ancestor of the active file SHALL instead clear the document selection and preview, establish intentional-empty selection, and set `followEnabled` to `false`. Reopening the directory SHALL NOT restore the document. Opening a folder, collapsing an unrelated folder, moving focus without an ancestor collapse, or collapsing with no active document SHALL leave the active document and Follow unchanged. Both Rule A outcomes MUST fire only for genuine user interactions, including pointer, touch, and supported keyboard activation/collapse; programmatic or library-driven callbacks during mount, refresh, reset, or filter reconciliation MUST NOT trigger them (see "Tree-mount user-click guard" below).

**Rule B (user clicks the Follow chip):** `followEnabled` MUST be flipped. When the flip is `false → true`, intentional-empty selection SHALL be cleared and the selection MUST jump to the newest-mtime non-binary document in the current session if that document differs from the current selection. Images are not candidates for this catch-up: their modification times often reflect a checkout rather than an edit, so Follow switches to an image only when it changes (Rule C).

**Rule C (file changes on disk, Follow on):** Selection MUST move to the changed document when the preview can show it: a Markdown, AsciiDoc, or text document, or an image the preview renders inline. The exception is an image embedded in the document the preview currently shows: its change MUST NOT move the selection, and the embedded image refreshes in place instead. A change to any other binary file MUST NOT change the selection.

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

#### Scenario: Rule B — turning Follow on jumps to the newest document
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

#### Scenario: Rule C — an image change with Follow on moves the selection
- **WHEN** Follow is on, the selection is `README.md`, which does not embed `hero.svg`, and a watcher event reports that `hero.svg` changed
- **THEN** the selection moves to `hero.svg`
- **AND** the preview renders the image's current content

#### Scenario: Rule C — a change to an image embedded in the shown document refreshes it in place
- **WHEN** Follow is on, the selection is `README.md`, the preview shows `README.md` embedding `<img src="./hero.svg">`, and a watcher event reports that `hero.svg` changed
- **THEN** the selection remains `README.md` and the browser URL does not change
- **AND** the embedded image shows `hero.svg`'s current content without re-rendering `README.md`

#### Scenario: Rule C — a change to a binary the preview cannot show is ignored
- **WHEN** Follow is on, the selection is `README.md`, and a watcher event reports that `bundle.zip` changed
- **THEN** the selection remains `README.md`

#### Scenario: Rule B — turning Follow on does not jump to a newer image
- **WHEN** Follow is off, the selection is `README.md`, and the newest-mtime file in the session is `hero.svg` while the newest-mtime document is `guides/setup.md`
- **AND** the user clicks the Follow chip
- **THEN** the selection moves to `guides/setup.md`

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
