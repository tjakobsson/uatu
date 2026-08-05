## MODIFIED Requirements

### Requirement: Provide a Files-pane filter chip with single persisted state
The browser UI SHALL render the existing segmented `All`/`Changed` chip beside the Files count. Its default SHALL be `All`; its selected value SHALL persist as personal workspace state and follow the user to another client. Changing it SHALL affect only the current client's rendered Files path set and future resume state, not another open client, Follow, pane visibility, or active selection. Existing empty-state behavior for empty, non-git, and unavailable change sets SHALL remain unchanged.

#### Scenario: Default state is All
- **WHEN** the user has no saved Files filter
- **THEN** the chip selects `All`
- **AND** the full path set renders

#### Scenario: Filter follows the user to another browser
- **WHEN** a user selects `Changed`
- **AND** later opens the workspace root in another browser
- **THEN** the new client restores `Changed`

#### Scenario: Open clients retain independent filters
- **WHEN** two clients are open and one changes its Files filter
- **THEN** the other client's rendered tree does not change

#### Scenario: Empty state names the review base
- **WHEN** the filter is `Changed`, review data is available, and no changed path intersects the tree
- **THEN** the Files pane shows an empty state naming the resolved review base

#### Scenario: Non-git empty state explains unavailability
- **WHEN** the filter is `Changed` and review data is non-git or unavailable
- **THEN** the Files pane explains that the Changed filter is unavailable

#### Scenario: Toggling to All clears the empty state
- **WHEN** a Changed-filter empty state is visible and the user selects `All`
- **THEN** the full tree returns

#### Scenario: Chip does not alter Follow or selection
- **WHEN** the user toggles the Files filter
- **THEN** Follow and active document selection remain unchanged
