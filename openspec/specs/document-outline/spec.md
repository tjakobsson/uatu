## Purpose

Define the document outline: a panel over the preview pane that enumerates the rendered document's headings (Markdown and AsciiDoc alike), supports click-to-navigate, scroll-spy active-heading tracking, and substring filtering. It takes one of two presentations, chosen from the width available to the preview area rather than from the UI mode — a non-modal docked rail with a reserved gutter and an adjustable, persisted width where there is room for a readable text column beside it, and a fullscreen sheet over the preview surface where there is not.

## Requirements

### Requirement: Outline enumerates rendered document headings

The system SHALL build the outline by enumerating the heading elements
(`h1` through `h6`) in the rendered preview DOM, capturing each heading's level,
text, and element reference. This SHALL work identically for Markdown and
AsciiDoc documents without renderer-specific logic.

#### Scenario: Markdown document with headings
- **WHEN** a Markdown document containing multiple heading levels is rendered
- **THEN** the outline lists one entry per heading in document order
- **AND** each entry is indented according to its heading level

#### Scenario: AsciiDoc document with headings
- **WHEN** an AsciiDoc document containing multiple heading levels is rendered
- **THEN** the outline lists one entry per heading in document order using the
  same enumeration path as Markdown

#### Scenario: Document with no headings
- **WHEN** a rendered document contains no heading elements
- **THEN** the outline is not available and its toggle is not shown

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

### Requirement: Outline navigation jumps to the heading

The system SHALL scroll the corresponding heading into view when the user
selects an outline entry, working even when heading IDs are missing or
duplicated by falling back to the captured element reference. The jump SHALL act
on the effective scroll container for the current layout and UI mode, and the
heading SHALL land clear of the sticky preview header in every layout and UI
mode — including touch mode and the stacked layout, where the page scrolls
rather than the preview shell.

#### Scenario: Jump to a section
- **WHEN** the user selects an outline entry
- **THEN** the corresponding heading is scrolled into view in the preview

#### Scenario: Heading without a usable ID
- **WHEN** the user selects an entry whose heading has a missing or duplicated
  ID
- **THEN** navigation still scrolls to the correct heading element

#### Scenario: Jump lands below the sticky header in touch mode
- **WHEN** the user taps an outline entry in touch mode
- **THEN** the heading is scrolled into view and is fully visible below the
  sticky preview header rather than hidden underneath it

### Requirement: Outline highlights the active heading on scroll

The system SHALL highlight the outline entry for the heading currently scrolled
into view, updating as the user scrolls. The active-heading tracking SHALL
observe the scroll container that is active for the current layout and UI mode,
subscribing to the event target that actually emits scroll events for it — which
is the document, not an element, when the viewport scroller is the active
container — and SHALL be rebuilt when the document remounts, the layout changes,
or the UI mode changes.

#### Scenario: Active heading updates while scrolling (single layout)
- **WHEN** the user scrolls the preview in single layout
- **THEN** the outline entry for the heading currently in view is highlighted
  and updates as scrolling continues

#### Scenario: Active heading updates while scrolling in touch mode
- **WHEN** the user scrolls a document in touch mode with the outline open
- **THEN** the outline entry for the heading currently in view is highlighted
  and updates as scrolling continues

#### Scenario: Active heading tracking survives a layout change
- **WHEN** the user switches between single and split layout with the outline
  open
- **THEN** active-heading highlighting continues to work against the newly
  active scroll container

#### Scenario: Active heading tracking survives a UI-mode switch
- **WHEN** the user switches between touch and desktop mode with the outline
  open
- **THEN** active-heading highlighting continues to work against the newly
  active scroll container

#### Scenario: Active heading tracking survives a document remount
- **WHEN** the rendered document is replaced (e.g. a watched file changes)
- **THEN** the outline is rebuilt from the new content and active-heading
  highlighting continues to work

### Requirement: Outline supports filtering headings

The outline SHALL provide a text input that filters the visible heading entries
by substring match. Filtering SHALL affect only which entries are visible and
SHALL NOT change which heading is tracked as active.

#### Scenario: Filtering the outline
- **WHEN** the user types text into the outline filter
- **THEN** only entries whose text matches are shown

#### Scenario: Filter does not disturb active tracking
- **WHEN** a filter hides the currently active heading's entry
- **THEN** active-heading tracking continues against the real document position

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
handle on its left edge (its docked right edge staying fixed), bounded below by
a minimum width and above by the width that still leaves a readable text column
beside it. The chosen width SHALL persist across reloads using browser-local UI
state, and SHALL be capped to that same bound when reapplied in a preview area
too narrow to honour it, so a width chosen on a large display cannot squeeze the
document on a smaller one. The sheet presentation SHALL NOT render a resize
handle, since it is sized to the available surface rather than to a stored
width.

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

#### Scenario: A stored width too wide for the current preview is capped
- **WHEN** a width stored on a larger display is reapplied in a preview area
  where honouring it would leave less than a readable text column
- **THEN** the rail is drawn at the widest width that still leaves a readable
  column
- **AND** the stored preference itself is left unchanged
