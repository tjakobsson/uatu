# desktop-macos-shell Delta Specification

## ADDED Requirements

### Requirement: Windows use a transparent full-height content layout
Content windows SHALL use a full-size content layout: the hosted web view
SHALL span the full window frame including the titlebar region, the titlebar
SHALL be transparent with the window title hidden, and the toolbar controls
(back/forward navigation, split-browser toggle) SHALL float over the content
as system glass material so the page is visible beneath them. Window dragging
via the titlebar region and toolbar interaction MUST keep working; page
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

### Requirement: Non-running states render correctly under the transparent titlebar
The launcher, starting, and failure states SHALL render correctly with the
transparent titlebar: no control or text in those layouts may be obscured by
the traffic lights or floating toolbar.

#### Scenario: Launcher under the transparent titlebar
- **WHEN** a window shows the launcher (no folder open)
- **THEN** the logo, folder chooser, and recent-folder list are fully visible
  and clickable

### Requirement: Native tabbing remains correct with full-height content
Native window tabs SHALL continue to work with the full-size content layout:
opening a second tab shows the native tab bar, tab switching works, and the
wrapper reflects the resulting change in covered chrome height to the hosted
page (per the desktop-titlebar-inset capability).

#### Scenario: Opening a second native tab
- **WHEN** the user opens a new tab in a content window
- **THEN** the native tab bar appears and both tabs remain fully usable
- **AND** each tab's hosted page receives the updated titlebar inset
