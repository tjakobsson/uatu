## MODIFIED Requirements

### Requirement: Provide a Files-pane filter chip with single persisted state
The browser UI SHALL render a compact All/Recent/Changed view control in Files. All and Changed SHALL present the hierarchical file view; Recent SHALL present the flat disk-write-ordered view defined by the recent-files capability. Its default SHALL be All; its selected value SHALL persist as personal workspace state and follow the user to another client. Changing it SHALL affect only the current client's Files presentation and future resume state, not another open client, Follow, pane visibility, active preview selection, or active playback. Existing Changed empty-state behavior for empty, non-git, and unavailable change sets SHALL remain unchanged. Files options SHALL expose Show ignored files and, when media browsing is available, the media-type filter without crowding the main view control.

#### Scenario: Default state is All
- **WHEN** the user has no saved Files view
- **THEN** the control selects All and the full eligible hierarchical view renders

#### Scenario: Filter follows the user to another browser
- **WHEN** a user selects Changed or Recent and later opens the workspace root in another browser
- **THEN** the new client restores that saved Files view

#### Scenario: Open clients retain independent filters
- **WHEN** two clients are open and one changes its Files view
- **THEN** the other client's rendered Files presentation does not change

#### Scenario: Empty state names the review base
- **WHEN** the view is Changed, review data is available, and no changed path intersects the eligible set
- **THEN** Files shows an empty state naming the resolved review base

#### Scenario: Non-git empty state explains unavailability
- **WHEN** the view is Changed and review data is non-git or unavailable
- **THEN** Files explains that Changed is unavailable

#### Scenario: Toggling to All clears the empty state
- **WHEN** a Changed empty state is visible and the user selects All
- **THEN** the full eligible tree returns

#### Scenario: Chip does not alter Follow or selection
- **WHEN** the user changes the Files view
- **THEN** Follow, active preview selection, and active playback remain unchanged

#### Scenario: Recent does not reset the tree arrangement
- **WHEN** the user leaves All for Recent and returns to All
- **THEN** the tree retains its manual directory expansion and selection state

### Requirement: Pane headers render title and metadata without visual overlap
Every sidebar pane header SHALL render its title and metadata without visual overlap at supported widths. Files SHALL show one quiet count of eligible file results in the selected view and query, with an accessible file-count label, without a binary breakdown, hidden segment, or filtered-versus-total wording. Indexing/error/retry status SHALL remain independently visible. Controls SHALL remain reachable at minimum sidebar width and on touch devices; the Files view control SHALL wrap to its own row when necessary rather than forcing important controls offscreen. Other pane headers SHALL retain nonoverlapping title/metadata behavior, with ellipsis for a title that cannot fit beside its metadata.

#### Scenario: Files-pane header is legible at default sidebar width
- **WHEN** Files displays a large result count at the default sidebar width
- **THEN** the title, count, All/Recent/Changed control, and pane actions do not overlap
- **AND** no binary subcount is displayed

#### Scenario: Files-pane header is legible at minimum sidebar width
- **WHEN** Files is at its minimum supported sidebar width of 320px
- **THEN** view controls, count, and pane actions remain reachable without horizontal overflow
- **AND** the control uses another row if needed

#### Scenario: Other pane headers benefit from the same rule
- **WHEN** another sidebar pane header contains visible metadata
- **THEN** its title and metadata do not overlap

#### Scenario: Discovery is incomplete
- **WHEN** only part of the inventory is known
- **THEN** the current known-result count is accompanied by the indexing indication
- **AND** it does not imply discovery is complete
