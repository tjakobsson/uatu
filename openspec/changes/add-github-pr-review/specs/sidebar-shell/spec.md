## ADDED Requirements

### Requirement: Expanded panes keep usable content height
Every expanded pane SHALL keep its fixed chrome (header and any toolbar) plus a minimum content height of a few rows, or of its essential content where a pane marks one, in the stack allocation, in both resize gestures, and whenever the stack height changes. The Files pane chrome SHALL be one header row and one toolbar row (All / Recent / Changed and the filename filter). A collapsed pane SHALL show its header row only.

#### Scenario: The phone Files tab gives the tree the stack
- **GIVEN** a 390×844 touch viewport with Pull request, Change Overview, and Files shown and Files expanded
- **WHEN** the user opens the Files tab
- **THEN** Pull request and Change Overview are header rows and the Files tree fills the rest of the stack

#### Scenario: Requests that do not fit shrink toward the minimums
- **WHEN** the expanded panes' stored heights exceed the stack
- **THEN** each pane keeps at least its minimum and the space above the minimums is shared in proportion to the stored heights
- **AND** when even the minimums do not fit, the panes split the stack in proportion to their minimums, after a pane with essential content has its own

#### Scenario: A pane's essential content is its minimum
- **WHEN** the Pull request pane shows a picked pull request with a pending review at 1440×900, or is the expanded pane on a 390×844 touch device's Files tab
- **THEN** the pane is at least as tall as its summary and actions, so `Finish review (n)` and `Merge on GitHub ↗` are whole without scrolling
- **AND** when the stack is too short for every minimum, the other panes share what is left, none below the stack's 72px floor

#### Scenario: A collapsed Files pane is its header only
- **WHEN** the Files pane is collapsed, in either mode
- **THEN** neither its toolbar nor its tree shows

#### Scenario: A resize stops at the minimum
- **WHEN** the user drags a pane boundary toward a pane's minimum
- **THEN** that pane stops at its minimum; collapsing the pane remains the way to reclaim its space
