## ADDED Requirements

### Requirement: Focusing a terminal pane makes the terminal the active surface

Clicking or otherwise focusing a terminal pane SHALL set the app's active
surface to `terminal`, and the surface SHALL remain `terminal` until the user
interacts with another surface. Terminal output arriving while the user is
elsewhere SHALL NOT change the active surface.

#### Scenario: Clicking into the terminal

- **WHEN** the user clicks a terminal pane
- **THEN** the active surface becomes `terminal`

#### Scenario: Background output does not claim the surface

- **WHEN** a detached command writes output while the user is reading the preview
- **THEN** the active surface remains `preview`

### Requirement: Terminal panes are searchable

Each terminal pane SHALL support searching its scrollback buffer, scoped to the
focused pane. Search SHALL reveal matches that are scrolled out of view, mark
the current match, and support forward and backward navigation. Searching SHALL
NOT write to the PTY or disturb the running program.

#### Scenario: Search does not reach the shell

- **WHEN** the user searches the terminal while a program is running
- **THEN** no input is sent to the PTY and the program is unaffected

#### Scenario: Search is scoped to the focused pane

- **WHEN** the panel is split and the user searches from one pane
- **THEN** matches in the other pane are neither counted nor highlighted
