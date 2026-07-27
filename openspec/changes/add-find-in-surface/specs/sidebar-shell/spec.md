## ADDED Requirements

### Requirement: Sidebar interaction never moves keyboard focus out of the sidebar

Selecting a document in the tree, or interacting with any sidebar pane control,
SHALL leave keyboard focus where the user put it. The sidebar SHALL NOT move
focus into the preview as a side effect of selection, so that the tree library's
own keyboard navigation continues to work: after clicking a file, arrow keys
SHALL keep walking the tree.

#### Scenario: Arrow keys still browse after a click

- **WHEN** the user clicks a file in the tree and then presses the down arrow
- **THEN** tree selection advances to the next entry and its document loads

#### Scenario: Pane controls do not steal focus

- **WHEN** the user collapses or resizes a sidebar pane
- **THEN** keyboard focus is not moved into the preview

### Requirement: Sidebar interaction resolves the active surface to the preview

Interacting with the sidebar SHALL set the app's active surface to `preview`,
because directing the sidebar is an act about the document being previewed. The
sidebar SHALL NOT be addressable as a find surface of its own.

#### Scenario: Find after a tree selection targets the document

- **WHEN** the user was working in the terminal, clicks a file in the tree, and presses `⌘F`
- **THEN** find opens over the preview rather than the terminal or the sidebar
