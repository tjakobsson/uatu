## ADDED Requirements

### Requirement: Provide a Files-pane filter chip with per-Mode defaults and persistence

The browser UI SHALL render a segmented binary chip in the `Files` pane header that toggles between `All` and `Changed`. The chip MUST be visually positioned beside the existing file count display so the relationship between filter state and the count is legible. The chip's default state SHALL depend on the active Mode: in **Review** Mode the default state SHALL be `Changed`; in **Author** Mode the default state SHALL be `All`. The chip's selected state SHALL persist across reloads in the same browser for that origin, independently per Mode (so Author and Review remember their own filter state). When Mode is switched, the chip state for the destination Mode MUST be read from persisted storage (or applied default if no persisted value exists) and the tree MUST re-render against the destination Mode's chip state.

When the filter is `Changed` and the union `reviewLoad.changedFiles ∪ reviewLoad.ignoredFiles` does not intersect any path the tree would otherwise render, the `Files` pane body SHALL render an empty-state message in place of the tree. The empty-state copy SHALL name the resolved review base (e.g. `No changes vs origin/main`) when `reviewLoad.status === "available"`. When `reviewLoad.status` is `"non-git"` or `"unavailable"`, the empty-state copy SHALL state that the Changed filter is unavailable because no git repository is present. The empty state MUST disappear and the tree MUST return as soon as the filter is toggled to `All` OR the change set becomes non-empty.

The chip SHALL be operable by mouse and keyboard activation following the existing pane-control conventions in this capability. The chip MUST NOT modify Follow-mode state, Mode state, pane visibility, or any other sibling control; it affects only the rendered path set in the `Files` pane.

#### Scenario: Chip renders in the Files-pane header beside the file count
- **WHEN** the `Files` pane is rendered
- **THEN** a segmented chip with options `All` and `Changed` is visible in the pane header
- **AND** the chip is positioned beside the file count display

#### Scenario: Default state is `Changed` in Review mode
- **WHEN** the user opens uatu in Review mode for the first time (no persisted filter state for Review)
- **THEN** the chip's selected state is `Changed`
- **AND** the tree is filtered to the change set on first paint

#### Scenario: Default state is `All` in Author mode
- **WHEN** the user opens uatu in Author mode for the first time (no persisted filter state for Author)
- **THEN** the chip's selected state is `All`
- **AND** the tree renders the full path set on first paint

#### Scenario: Filter state persists per Mode across reloads
- **WHEN** the user is in Author mode and toggles the chip to `Changed`
- **AND** reloads the page
- **THEN** the chip reads `Changed` and the tree is filtered
- **AND** when the user then switches to Review mode, Review's persisted state (or default `Changed`) applies — Author's `Changed` does NOT leak into Review's persisted state, and vice versa

#### Scenario: Switching Mode re-reads the destination Mode's filter state
- **WHEN** the user has Author filter state `All` and Review filter state `Changed`
- **AND** the user is in Author with the chip reading `All`
- **AND** the user switches to Review
- **THEN** the chip reads `Changed`
- **AND** the tree re-renders against Review's filter state

#### Scenario: Empty state names the review base when the change set is empty
- **WHEN** the filter is `Changed`
- **AND** `reviewLoad.status === "available"`
- **AND** `reviewLoad.changedFiles ∪ reviewLoad.ignoredFiles` is empty (or intersects no tree paths)
- **THEN** the `Files` pane body renders an empty-state message naming the resolved review base (e.g. `No changes vs origin/main`)
- **AND** the tree itself is not rendered

#### Scenario: Empty state explains unavailability in non-git contexts
- **WHEN** the filter is `Changed`
- **AND** `reviewLoad.status` is `"non-git"` or `"unavailable"`
- **THEN** the `Files` pane body renders an empty-state message stating that the Changed filter is unavailable because no git repository is present

#### Scenario: Toggling to `All` clears the empty state
- **WHEN** the empty state is being shown because the change set is empty under filter `Changed`
- **AND** the user toggles the chip to `All`
- **THEN** the empty state is removed
- **AND** the full tree renders

#### Scenario: Chip does NOT alter Follow-mode or Mode
- **WHEN** the user toggles the chip
- **THEN** the active Mode is unchanged
- **AND** the Follow-mode toggle state is unchanged
- **AND** the active document selection is unchanged (unless follow-mode subsequently auto-switches for unrelated reasons)
