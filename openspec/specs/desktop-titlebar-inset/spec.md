# desktop-titlebar-inset Specification

## Purpose
TBD - created by archiving change add-desktop-glass-titlebar. Update Purpose after archive.
## Requirements
### Requirement: The wrapper announces a titlebar inset to the SPA
The desktop wrapper SHALL announce to the hosted page that native chrome
covers the top of the content area, by setting a marker class and a CSS
custom property carrying the covered height in CSS pixels on the document
root. The announcement MUST be installed as a document-start user script so
it applies before first paint and survives page reloads (including the SPA's
live-reload). When the native chrome height changes while the page is open —
such as the native tab bar appearing or disappearing — the wrapper SHALL
update the announced inset in place.

#### Scenario: Inset present in the desktop wrapper
- **WHEN** the SPA loads inside UatuCode Desktop
- **THEN** the document root carries the desktop marker and an inset variable
  matching the height of the floating native chrome

#### Scenario: Inset survives live-reload
- **WHEN** the SPA live-reloads after a watched file changes
- **THEN** the marker and inset variable are present again without user action

#### Scenario: Native tab bar changes the inset
- **WHEN** a second native tab opens (or the last extra tab closes) so the
  native chrome height changes
- **THEN** the announced inset updates to the new height without a reload

### Requirement: The SPA lays out its chrome below the inset
When the inset marker is present, the SPA SHALL offset its top-level chrome —
the sidebar header and the preview pane's sticky header zone — down by the
announced inset so no interactive control sits under the native chrome, while
scrolled document content still flows beneath the floating toolbar. When the
marker is absent (plain browser or PWA), layout MUST be unchanged.

#### Scenario: Chrome clears the floating toolbar
- **WHEN** the SPA renders in the desktop wrapper with a non-zero inset
- **THEN** the sidebar header and preview header render fully below the
  native toolbar
- **AND** scrolling the document moves content beneath the toolbar, where the
  native glass samples it

#### Scenario: No inset outside the desktop
- **WHEN** the SPA loads in a plain browser or as a PWA
- **THEN** no top padding is added and layout matches pre-change behavior

### Requirement: The page frosts the covered strip
When the inset marker is present, the SPA SHALL render a non-interactive
progressive frost over the covered strip — blur-forward with a light tint,
dissolving over an eased ramp below the inset — so content beneath the
native chrome reads as blurred glass rather than raw content (the web view
cannot render the system scroll-edge effect for chrome it does not know
about). The frost SHALL NOT cover the sidebar column: the sidebar is
inset-padded solid surface that never scrolls under the chrome, and
frosting it only washes the brand mark.

#### Scenario: Scrolled content under the titlebar reads as glass
- **WHEN** dark or saturated document content scrolls into the covered strip
- **THEN** it appears as recognizable blurred content, not a flat wash,
  fading smoothly into sharp content below the inset

#### Scenario: The sidebar stays crisp
- **WHEN** the frost strip is active
- **THEN** the sidebar column, including the brand logo, renders without any
  frost overlay

### Requirement: The split-browser pane honors the inset
The in-app split browser pane SHALL position its tab strip below the covered
titlebar region so its tabs and controls remain visible and clickable.

#### Scenario: Split pane tabs stay reachable
- **WHEN** the split browser is open in a window with a transparent titlebar
- **THEN** the split pane's tab strip renders below the native chrome and its
  controls are clickable

