# desktop-zoom Specification

## Purpose

Define the zoom behavior of UatuCode Desktop's web surfaces: one shared, persisted page-zoom level applied to the uatu SPA pane and every split-browser tab in every window, keyboard/View-menu commands that step it through the Safari zoom ladder, and transient per-view pinch and smart-zoom magnification.

## Requirements

### Requirement: One shared, persisted page-zoom level
UatuCode Desktop SHALL maintain a single page-zoom level for the whole app,
persisted across relaunches. The level SHALL apply to the uatu SPA pane and
to every split-browser tab in every window, and a newly created browser tab
MUST render at the current level. Page zoom SHALL be layout zoom (content
reflows), not visual scaling.

#### Scenario: Zooming affects both panes

- **WHEN** the split browser is open and the user invokes Zoom In
- **THEN** the uatu pane and every browser tab render at the same increased
  level

#### Scenario: New tab inherits the level

- **WHEN** the zoom level is above 100% and the user opens a new browser tab
- **THEN** the new tab renders at the current level from its first load

#### Scenario: Level survives relaunch

- **WHEN** the user sets the zoom level to 125% and relaunches the app
- **THEN** windows render their web content at 125%

#### Scenario: All windows follow

- **WHEN** two windows are open and the user zooms in one of them
- **THEN** the other window renders at the new level as well

### Requirement: View-menu zoom commands
The app SHALL provide View-menu commands Zoom In (`⌘+`, also answering
`⌘=`), Zoom Out (`⌘−`), and Actual Size (`⌘0`). Zoom In and Zoom Out SHALL
step the shared level through the Safari zoom ladder (0.5 – 3.0) and MUST
clamp at its ends. Actual Size SHALL set the shared level to 100% and MUST
also reset any pinch magnification on the focused window's web views.

#### Scenario: Keyboard zoom in

- **WHEN** the level is 100% and the user presses `⌘+`
- **THEN** the shared level moves to the next ladder step and all web
  surfaces reflow at the new level

#### Scenario: Clamped at the maximum

- **WHEN** the level is at the top of the ladder and the user presses `⌘+`
- **THEN** the level stays unchanged

#### Scenario: Actual Size resets everything

- **WHEN** the level is 150% and a pane has transient pinch magnification
- **AND** the user presses `⌘0`
- **THEN** the shared level returns to 100% and the pane's magnification
  resets to 1×

### Requirement: Pinch and smart zoom on every web surface
Every web view the app hosts — the SPA pane and each browser tab — SHALL
accept trackpad pinch-to-zoom and smart zoom (two-finger double-tap).
Magnification SHALL be visual (no reflow), scoped to the gestured web view,
and transient: it MUST NOT be persisted and MUST NOT alter the shared
page-zoom level.

#### Scenario: Pinch zooms one pane only

- **WHEN** the user pinches out over a browser tab
- **THEN** that tab magnifies while the uatu pane and the shared page-zoom
  level are unchanged

#### Scenario: Smart zoom

- **WHEN** the user double-taps the trackpad with two fingers over the uatu
  pane
- **THEN** the pane toggles a magnified view of the tapped region

#### Scenario: Magnification is not persisted

- **WHEN** a pane is pinch-magnified and the app is relaunched
- **THEN** the pane renders unmagnified at the shared page-zoom level
