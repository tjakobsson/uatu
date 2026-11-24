## MODIFIED Requirements

### Requirement: The Files tab hosts the sidebar stack full-screen
The `Files` tab's surface SHALL be the existing sidebar pane stack rendered full-screen, with the same tree DOM and state as every other presentation of the tree, never a second tree instance. In touch mode the stack SHALL be a compact accordion: at most one pane expanded, taking the remaining height (at most, for a summary such as the Pull request pane), and every header one slim row whose title button toggles its pane. Desktop mode keeps its stack.

#### Scenario: Files pane controls remain usable with touch gestures
- **WHEN** the sidebar stack is used inside Files
- **THEN** the per-pane visibility menu SHALL keep working
- **AND** each pane's actions (refresh, browse, options, hide) SHALL keep working beside its title button
- **AND** on a coarse-pointer device in desktop mode each pane's header SHALL act as its gesture surface: dragging resizes the boundary above, rather than using the thin desktop resizer strip as a finger target, and double-tapping toggles collapse as a reachable version of the small − / + button, while taps on header controls keep working

#### Scenario: Tree state is continuous across tabs
- **WHEN** the user expands a directory in the Files tab, switches to Preview, and returns
- **THEN** the expansion state is exactly as they left it

#### Scenario: A viewed pull request's file opens in Preview
- **WHEN** a pull request is viewed and the user taps a file in the Files tab's pull request scope
- **THEN** the Preview tab comes forward on that file's pull request file view, in the shared view mode, with the Viewing strip above it

#### Scenario: Tapping a pane's title expands it and folds the others
- **GIVEN** a 390×844 touch device showing Pull request, Change Overview and Files, with Files expanded
- **WHEN** the user taps the Pull request header anywhere except its actions
- **THEN** Pull request expands, as tall as its content up to all of the stack's remaining height, and Change Overview and Files fold to their header rows right under it
- **AND** the Pull request title button's `aria-expanded` reads `true` and the others read `false`
- **AND** tapping the same title again folds Pull request

#### Scenario: Folded headers say what they hold
- **WHEN** panes are folded in touch mode
- **THEN** each header is one 44px row, its hairline included (three folded panes take 132px), with a lighter title, the Pull request header reads like `#642 · Review required`, and the Files header keeps its file count
- **AND** the title button's tap area is the whole header row except the header's actions and links, and it carries `aria-expanded`

#### Scenario: The chrome in the expanded pane stays slim
- **WHEN** Files or Pull request is the expanded pane in touch mode
- **THEN** the Files toolbar row and the Pull request pane's pinned top row are each at most 40px tall, their controls keeping 44px tap boxes where they are actions

#### Scenario: A short screen keeps the stack for the panes
- **WHEN** the Files tab is shown on a touch screen 500px tall or less (an 844×390 phone in landscape)
- **THEN** the brand is one row at most 48px tall (a small logo, the name and the status, no build badge; the switcher is the tab bar's button), and the expanded Pull request pane's body keeps at least 140px

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

### Requirement: The sidebar chrome offers the mode switch — never the tab bar
On coarse-pointer devices, in windows 900px wide or less, and in touch mode, the UI SHALL offer a single mode toggle in the sidebar header, inside Files in touch mode; coarse-pointer desktop mode adds a collapsed-sidebar rail variant. It SHALL switch renderings live, remain reachable at every viewport width, and persist the chosen mode per device. The tab bar SHALL contain only the four surface tabs.

#### Scenario: Coarse-pointer desktop mode remains a complete and escapable desktop layout
- **WHEN** a coarse-pointer device uses desktop mode, including after iPad landscape-to-portrait rotation
- **THEN** the UI SHALL render exactly as a desktop browser: sidebar, Preview-and-Chat split work area, docked terminal, and no tab bar
- **AND** the toggle SHALL remain available at every viewport width in both modes so the device cannot be stranded without a way back

#### Scenario: Mode changes normalize the previously active surfaces
- **WHEN** the user switches modes
- **THEN** the terminal SHALL return to its stored dock and display mode
- **AND** entering desktop with Chat active SHALL open the chat panel
- **AND** entering touch SHALL land on Chat only when the user was last working in an open chat panel, otherwise Preview
- **AND** no touch-only surface promotion SHALL remain

#### Scenario: iPad flips to the desktop rendering and back
- **WHEN** a user on a coarse-pointer viewport activates the mode toggle in the Files tab, works in the desktop layout, and then activates the toggle again
- **THEN** each switch re-renders live into the full target layout
- **AND** the last chosen mode is restored after a reload

#### Scenario: The tab bar carries no mode control
- **WHEN** the tab bar renders at any viewport width
- **THEN** it contains exactly the Files, Preview, Chat, and Terminal tabs

#### Scenario: Rotation cannot strand desktop mode
- **WHEN** a coarse-pointer device in desktop mode narrows below the wide breakpoint (e.g. iPad rotating to portrait) or collapses the sidebar
- **THEN** a mode toggle remains reachable and switches the device back to touch mode

#### Scenario: Leaving touch mode on the Chat tab keeps the conversation visible
- **WHEN** a user on the Chat tab switches to desktop mode
- **THEN** the chat panel is open beside Preview in the desktop rendering

#### Scenario: A narrow fine-pointer window can switch to touch mode
- **WHEN** a fine-pointer browser at 390×844 renders the default desktop layout, the sidebar stacked above the preview
- **THEN** the sidebar header shows the mode toggle, and activating it renders touch mode
- **AND** in touch mode the toggle stays in the Files tab's header whatever the width, so the window can return to desktop mode
- **AND** a fine-pointer window wider than 900px in desktop mode still shows no mode toggle

#### Scenario: A desktop window narrowed over a preview offers touch layout
- **WHEN** a desktop-layout window showing a pull request (or any preview) at 1440×900 is resized to 390×844 without switching layout, and no explicit desktop choice is stored
- **THEN** the preview's top stays at the viewport's top instead of below the stacked sidebar, and a small non-blocking bar asks `Narrow window: switch to touch layout?` with Switch and Not now
- **AND** Switch renders touch mode; Not now, or a stored desktop choice, leaves the layout alone for the page

## ADDED Requirements

### Requirement: A short touch screen's tab bar is slim
On a touch screen 500px tall or less (a phone in landscape) the bottom tab bar SHALL be a row of icons about 40px tall; each tab's tap box SHALL still be at least 44px tall, and its label SHALL stay its accessible name.

#### Scenario: A phone in landscape
- **WHEN** an 844×390 touch phone shows any surface
- **THEN** the tab bar is 40px of icons, a tap up to 4px above it still reaches the tab, and each tab is still named Files, Preview, Chat or Terminal
