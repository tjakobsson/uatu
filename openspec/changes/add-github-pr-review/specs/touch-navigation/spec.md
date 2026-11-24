## MODIFIED Requirements

### Requirement: The Files tab hosts the sidebar stack full-screen
The `Files` tab's surface SHALL be the existing sidebar pane stack rendered full-screen, with the same tree DOM and state as every other presentation of the tree, never a second tree instance. In touch mode the stack SHALL be a compact accordion: at most one pane expanded, taking the remaining height, and every header one slim row whose title button toggles its pane. Desktop mode keeps its stack.

#### Scenario: Files pane controls remain usable with touch gestures
- **WHEN** the sidebar stack is used inside Files
- **THEN** the per-pane visibility menu SHALL keep working
- **AND** each pane's actions (refresh, browse, options, hide) SHALL keep working beside its title button
- **AND** on a coarse-pointer device in desktop mode each pane's header SHALL act as its gesture surface: dragging resizes the boundary above, rather than using the thin desktop resizer strip as a finger target, and double-tapping toggles collapse as a reachable version of the small − / + button, while taps on header controls keep working

#### Scenario: Tree state is continuous across tabs
- **WHEN** the user expands a directory in the Files tab, switches to Preview, and returns
- **THEN** the expansion state is exactly as they left it

#### Scenario: Tapping a pane's title expands it and folds the others
- **GIVEN** a 390×844 touch device showing Pull request, Change Overview and Files, with Files expanded
- **WHEN** the user taps the Pull request header anywhere except its actions
- **THEN** Pull request takes all of the stack's remaining height and Change Overview and Files fold to their header rows
- **AND** the Pull request title button's `aria-expanded` reads `true` and the others read `false`
- **AND** tapping the same title again folds Pull request

#### Scenario: Folded headers say what they hold
- **WHEN** panes are folded in touch mode
- **THEN** each header is one row at least 44px and at most 48px tall, the Pull request header reads like `#642 · Review required`, and the Files header keeps its file count
- **AND** the title button's tap area is the whole header row except the header's actions and links, and it carries `aria-expanded`

#### Scenario: The chrome in the expanded pane stays slim
- **WHEN** Files or Pull request is the expanded pane in touch mode
- **THEN** the Files toolbar row and the Pull request pane's pinned top row are each at most 40px tall, their controls keeping 44px tap boxes where they are actions

#### Scenario: The expanded pane is remembered per device
- **WHEN** the user expands Change Overview on a phone and reloads
- **THEN** Change Overview is expanded and the other panes are folded
- **AND** a device with no stored choice expands Files
- **AND** the choice is kept apart from the desktop stack, whose collapsed panes and heights the accordion leaves unchanged

#### Scenario: A revealed pane becomes the expanded one
- **WHEN** a pane is revealed in touch mode (Search by ⇧⌘F, a pane turned on in the panels menu)
- **THEN** that pane is expanded and the others fold

#### Scenario: A pane header is the touch resize handle
- **WHEN** the user drags a pane's header vertically on a coarse-pointer device in desktop mode
- **THEN** the pane above it trades height with the dragged pane
- **AND** the new heights persist like a desktop resizer drag

#### Scenario: Double-tapping a pane header toggles its collapse
- **WHEN** the user double-taps a pane's header on a coarse-pointer device in desktop mode
- **THEN** the pane collapses (or expands, if collapsed), persisted exactly as the − / + button would
- **AND** a single tap changes nothing
