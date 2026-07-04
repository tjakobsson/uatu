# embedded-terminal delta — fix-pane-fit-padding-clip

## ADDED Requirements

### Requirement: Terminal grid fits within the visible pane
The terminal character grid SHALL always fit entirely within its pane host's content box: `rows × cellHeight` SHALL NOT exceed the vertical space available inside the pane's padding, and `cols × cellWidth` (plus the scrollbar allowance) SHALL NOT exceed the horizontal space. Grid-size measurements SHALL account for any padding applied around the terminal element so that no character row or column is ever clipped by the pane's overflow bounds. This SHALL hold at any pane size, including sizes produced by dragging the panel or inter-pane resizers to arbitrary pixel positions, in both docks, for single panes and splits.

#### Scenario: Bottom row is fully visible at arbitrary pane heights
- **WHEN** the terminal panel or an inter-pane resizer is dragged so a pane lands on an arbitrary pixel height
- **THEN** the rendered grid's height (`rows × cellHeight`) is less than or equal to the pane host's content-box height
- **AND** the last character row is fully visible, not partially clipped

#### Scenario: Content at a split boundary is not swallowed
- **WHEN** two panes are split and a shell prompt or TUI status line renders on the last row of the upper/left pane
- **THEN** that row renders completely inside its own pane
- **AND** no pixels of it are clipped by or bleed toward the neighboring pane

#### Scenario: Padding is accounted for in fit measurement
- **WHEN** visual padding is applied around the terminal rendering area
- **THEN** the fit measurement subtracts that padding before computing rows and columns
- **AND** the proposed grid changes accordingly rather than overflowing the clip bounds
