# desktop-macos-shell delta

## MODIFIED Requirements

### Requirement: Windows use a transparent full-height content layout
Content windows SHALL use a full-size content layout: the hosted web view
SHALL span the full window frame including the titlebar region, the titlebar
SHALL be transparent with the window title hidden, and the toolbar controls
(back/forward navigation, split-browser toggle) SHALL float over the content
as system glass material so the page is visible beneath them. Window dragging
via the titlebar region and toolbar interaction MUST keep working at every
horizontal position across the window — over the SPA web view (including a
right-docked terminal column) and over the split-browser pane alike; page
content in the covered strip is visible but not interactive, matching
system-browser behavior.

#### Scenario: Page content reaches the top window edge
- **WHEN** a folder is being served and the SPA is loaded in a window
- **THEN** the page's rendered content extends to the top edge of the window
- **AND** the toolbar renders as glass over the page rather than on an opaque
  bar

#### Scenario: Window remains draggable by the top region
- **WHEN** the user drags in the titlebar region above the content
- **THEN** the window moves, and clicks on toolbar controls activate those
  controls, not the page beneath

#### Scenario: Dragging works over the SPA side, not only the split pane
- **WHEN** the user drags in the titlebar strip above the SPA web view —
  including above the sidebar, the preview, and a right-docked terminal —
  with or without the split browser open
- **THEN** the window moves, exactly as it does when dragging above the
  split-browser pane
