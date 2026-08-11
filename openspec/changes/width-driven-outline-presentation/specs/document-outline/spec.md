## ADDED Requirements

### Requirement: Outline presentation follows the available width

The outline SHALL choose its presentation from the width available to the
preview area rather than from the UI mode: when that area cannot host both the
docked rail and a readable text column it SHALL render as a fullscreen sheet,
and otherwise SHALL render as the docked rail. The resolution SHALL be
re-evaluated whenever the available width can change — window resize, device
rotation, UI-mode switch, terminal dock or resize, and sidebar collapse — so a
panel that is open across such a change adopts the presentation its new width
calls for.

#### Scenario: Phone-width preview renders the sheet
- **WHEN** the user opens the outline on a viewport whose preview area is too
  narrow to host the rail beside a readable text column
- **THEN** the outline renders as a fullscreen sheet
- **AND** the document's text column keeps its full width

#### Scenario: Tablet-width preview keeps the rail
- **WHEN** the user opens the outline on a viewport whose preview area can host
  the rail beside a readable text column
- **THEN** the outline renders as the docked rail with its reserved gutter

#### Scenario: Rotation crosses the threshold with the outline open
- **WHEN** the outline is open and the device is rotated such that the preview
  area crosses the threshold
- **THEN** the outline re-renders in the presentation matching the new width
- **AND** it remains open

#### Scenario: Resolution is independent of UI mode
- **WHEN** the same preview width is reached in touch mode and in desktop mode
- **THEN** the outline resolves to the same presentation in both

### Requirement: Outline is positioned against the visible preview area

The outline SHALL derive its position and size from the preview's visible
scrollport in viewport coordinates, in both presentations, and SHALL NOT derive
them from a container whose height is the length of the document. The panel
SHALL therefore remain within the visible viewport at every scroll position, and
SHALL NOT extend beyond the surface it belongs to.

#### Scenario: The panel is no taller than the viewport
- **WHEN** the outline is open over a document many screens long
- **THEN** the panel's height does not exceed the viewport height
- **AND** the panel is fully within the viewport

#### Scenario: The panel stays put while the document scrolls
- **WHEN** the user scrolls the document with the outline open, in any layout
  or UI mode
- **THEN** the panel remains in the same position on screen rather than
  scrolling away with the content

#### Scenario: A dismissal control is never covered by the panel
- **WHEN** the user has scrolled the document with the outline open
- **THEN** the outline toggle is not obscured by the panel
- **AND** activating it closes the outline

#### Scenario: The sheet covers its own surface, not the whole window
- **WHEN** the sheet presentation is showing while another region of the app
  (such as a docked terminal) sits beside the preview
- **THEN** the sheet spans the preview area only
- **AND** the neighbouring region remains visible and usable

### Requirement: Sheet presentation dismisses on selection and on document change

The sheet presentation SHALL dismiss itself when the user selects a heading and
when the previewed document changes, because it covers the document it
navigates. The rail presentation SHALL retain its existing behaviour of staying
open across both.

#### Scenario: Selecting a heading closes the sheet
- **WHEN** the user selects a heading entry while the sheet is showing
- **THEN** the document scrolls to that heading
- **AND** the sheet is dismissed so the heading is visible

#### Scenario: Opening another document closes the sheet
- **WHEN** the previewed document changes while the sheet is showing
- **THEN** the sheet is dismissed rather than left covering the new document

#### Scenario: The rail stays open across a document change
- **WHEN** the previewed document changes while the rail is showing
- **THEN** the rail stays open and is rebuilt for the new document

### Requirement: Outline controls meet touch target sizes on coarse pointers

The outline's heading entries and its close control SHALL present activation
targets of at least 44px in the smaller dimension on coarse-pointer devices,
matching the target size already required of the preview toolbar.

#### Scenario: Heading entries are tappable
- **WHEN** the outline is shown on a coarse-pointer device
- **THEN** each heading entry's activation target is at least 44px tall

#### Scenario: The close control is tappable
- **WHEN** the outline is shown on a coarse-pointer device
- **THEN** the close control's activation target is at least 44px in both
  dimensions

### Requirement: Opening the outline does not summon the software keyboard

The outline SHALL NOT move focus into its filter input on coarse-pointer
devices, so that opening it does not raise the software keyboard over the
heading list. The filter SHALL remain reachable by direct activation, and
focus-on-open SHALL be retained for fine-pointer devices.

#### Scenario: Opening on a touch device leaves the filter unfocused
- **WHEN** the user opens the outline on a coarse-pointer device
- **THEN** the filter input is not focused
- **AND** the full heading list is visible

#### Scenario: Tapping the filter still focuses it
- **WHEN** the user activates the filter input on a coarse-pointer device
- **THEN** the input takes focus and filtering behaves as specified

#### Scenario: Fine-pointer devices keep focus-on-open
- **WHEN** the user opens the outline on a fine-pointer device
- **THEN** the filter input takes focus as it does today

### Requirement: Opening the outline reveals the active heading

The outline SHALL scroll its own list so the entry for the currently active
heading is visible when the panel opens, so that a panel opened partway through
a long document does not start at the top of an unrelated list.

#### Scenario: Opening partway through a document
- **WHEN** the user has scrolled into a document and opens the outline
- **THEN** the entry for the currently active heading is visible within the
  outline's list without further scrolling

#### Scenario: Opening at the top of a document
- **WHEN** the user opens the outline with the document scrolled to the top
- **THEN** the list is shown from its first entry

## MODIFIED Requirements

### Requirement: Outline is a non-modal panel

The outline SHALL NOT trap focus in either presentation, and in the rail
presentation SHALL additionally be non-modal so the user can continue reading
and interacting with the document while it is open. The sheet presentation
covers the preview by design and is therefore modal over the document, but SHALL
always offer a reachable dismissal.

#### Scenario: Opening the outline
- **WHEN** the user activates the outline toggle
- **THEN** the outline panel appears in whichever presentation the available
  width resolves to
- **AND** focus is not trapped inside it

#### Scenario: Opening the rail
- **WHEN** the user activates the outline toggle and the rail presentation is
  resolved
- **THEN** the outline rail appears
- **AND** the document content remains scrollable and clickable

#### Scenario: Opening the sheet
- **WHEN** the user activates the outline toggle and the sheet presentation is
  resolved
- **THEN** the outline sheet appears over the preview
- **AND** focus is not trapped inside it

#### Scenario: Closing the outline
- **WHEN** the user activates the close control or presses Escape while the
  outline is open
- **THEN** the outline panel is dismissed

#### Scenario: A dismissal is always reachable
- **WHEN** the outline is open in either presentation and the user has scrolled
  the document to any position
- **THEN** a dismissal control is visible and activatable without first
  scrolling the document

#### Scenario: Closed by default
- **WHEN** a document is first loaded
- **THEN** the outline panel is closed and does not cover the content

### Requirement: Outline is docked beside the content

The outline SHALL be docked on the right of the preview area as a full-height
rail in the rail presentation, and the document SHALL reflow to reserve space
beside it so its content is not covered by the panel. Closing the outline SHALL
release that reserved space so the document is never left narrowed while the
outline is hidden. The sheet presentation SHALL reserve no space and SHALL NOT
reflow the document, since it covers the preview rather than sitting beside it.

#### Scenario: Docking reflows the document
- **WHEN** the outline is open in the rail presentation
- **THEN** the document reflows so its content is not covered by the panel

#### Scenario: Closing releases reserved space
- **WHEN** the user closes the outline in the rail presentation
- **THEN** the document returns to full width

#### Scenario: The sheet reserves no space
- **WHEN** the outline is open in the sheet presentation
- **THEN** the document reserves no gutter and its text column is unchanged
  from when the outline was closed

#### Scenario: Crossing the threshold releases the gutter
- **WHEN** an open rail becomes a sheet because the available width shrank
- **THEN** the reserved gutter is released and the document returns to full
  width

### Requirement: Outline width is adjustable and remembered

The outline width SHALL be adjustable in the rail presentation by dragging a
handle on its left edge (its docked right edge staying fixed), bounded to a
minimum width and to keeping a minimum amount of document visible. The chosen
width SHALL persist across reloads using browser-local UI state. The sheet
presentation SHALL NOT render a resize handle, since it is sized to the
available surface rather than to a stored width.

#### Scenario: Resizing by dragging the left edge
- **WHEN** the user drags the outline's left-edge handle in the rail
  presentation
- **THEN** the panel's width changes accordingly while its docked right edge
  stays fixed, bounded to a minimum width and to keeping the document visible

#### Scenario: Width persists across reloads
- **WHEN** the user has resized the outline and reloads the application
- **THEN** the outline reopens at the previously chosen width

#### Scenario: The sheet has no resize handle
- **WHEN** the outline is open in the sheet presentation
- **THEN** no resize handle is present

#### Scenario: A stored width survives a spell in the sheet presentation
- **WHEN** the user has resized the rail, then uses the outline at a width that
  resolves to the sheet, then returns to a width that resolves to the rail
- **THEN** the rail reopens at the previously chosen width
