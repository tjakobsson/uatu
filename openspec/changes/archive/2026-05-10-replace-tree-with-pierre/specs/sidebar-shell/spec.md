## MODIFIED Requirements

### Requirement: Organize sidebar content into resizable panes
The browser UI SHALL organize the expanded sidebar as a stack of panes. The initial panes SHALL include `Change Overview`, `Files`, and `Git Log`. The document tree SHALL render inside the `Files` pane and MUST preserve existing document selection, follow-mode interaction, and pin interaction. Tree-internal behaviors that are now owned by the `@pierre/trees` library — directory expansion handling, binary-entry presentation, and any future row-annotation behavior such as relative-time labels — are governed by the `document-tree` capability rather than this requirement, and this requirement no longer asserts that they survive the library swap. Pane visibility, collapsed state, and vertical sizing SHALL persist across reloads in the same browser for that origin. The pane stack SHALL fill the available expanded-sidebar height and MUST NOT force the whole sidebar body to scroll. Scrollbars used inside panes and preview overflow regions SHOULD be thin and visually light while remaining discoverable. The existing whole-sidebar collapse and expand controls MUST remain separate from per-pane visibility and collapse controls.

#### Scenario: Sidebar opens with default panes
- **WHEN** a user opens the browser UI with no pane preferences stored
- **THEN** the expanded sidebar shows `Change Overview`, `Files`, and `Git Log` panes
- **AND** the `Files` pane contains the document tree for watched roots

#### Scenario: Selecting a document from the Files pane
- **WHEN** a user selects a non-binary document from the `Files` pane tree
- **THEN** the preview loads that document
- **AND** follow mode is disabled in the same way as selecting from the previous sidebar tree

#### Scenario: Pane visibility can be changed and restored
- **WHEN** a user hides a sidebar pane
- **THEN** that pane is removed from the expanded sidebar stack
- **AND** a sidebar panels control allows the user to show that pane again

#### Scenario: Pane size can be adjusted
- **WHEN** a user resizes one sidebar pane relative to another
- **THEN** the pane stack updates the affected pane heights
- **AND** the pane stack remains within the current expanded-sidebar height
- **AND** the updated pane sizes persist across reloads in the same browser for that origin

#### Scenario: Pane content scrolls inside its allocated pane
- **WHEN** pane content exceeds that pane's allocated height
- **THEN** that pane body scrolls internally
- **AND** the whole sidebar body does not gain a scrollbar
- **AND** the scrollbar is thinner and lighter than the default heavy pane treatment where platform styling allows it

#### Scenario: Spare height is assigned to the Files pane
- **WHEN** the expanded pane stack has more vertical space than fixed contextual panes require
- **THEN** the `Files` pane receives the spare space
- **AND** the `Git Log` pane does not show excessive empty space beneath its content

#### Scenario: Whole-sidebar collapse remains separate
- **WHEN** a user collapses the whole sidebar
- **THEN** the sidebar shrinks to the existing narrow rail
- **AND** per-pane visibility and sizing preferences are preserved for when the sidebar is expanded again

## REMOVED Requirements

### Requirement: Provide an All/Changed view toggle in the Files pane
**Reason**: Replaced by ambient git-status annotations on a single tree (see the `document-tree` capability's "Surface git status as row annotations on tree entries" requirement). One tree, with changed files visually distinguished in place, replaces the dual-mode All/Changed split. This is consistent with VS Code's file-tree UX and removes the need for per-Mode persistence of a Files-view choice.
**Migration**: Any persisted Files-view preferences (`localStorage` keys) MAY be left in place; they will be ignored by the new code. Users who previously selected "Changed" will now see the full tree with status annotations on the same files; deleted entries — previously listed in the Changed view — are not in the tree (since they have no on-disk content) and remain accessible through the Git Log pane and direct URLs.
