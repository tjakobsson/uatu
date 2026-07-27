## ADDED Requirements

### Requirement: The sidebar hosts a Search pane in the pane stack

The sidebar SHALL include a Search pane participating in the existing pane-stack
behavior: it can be collapsed, hidden, resized, and restored from the panels
menu, and its visibility and height SHALL persist across reloads like the other
panes. The pane SHALL be present but may default to hidden, since it is opened
on demand by its shortcut.

#### Scenario: Search pane behaves like its siblings

- **WHEN** the user collapses, hides, and then restores the Search pane from the panels menu
- **THEN** it behaves identically to the Files and Git Log panes and its state persists across a reload

#### Scenario: Shortcut reveals a hidden pane

- **WHEN** the Search pane is hidden and the user opens project search by its shortcut
- **THEN** the pane becomes visible and expanded without disturbing the other panes' persisted state
