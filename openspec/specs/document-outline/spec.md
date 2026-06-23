## Purpose

Define the docked document outline: a non-modal floating panel over the preview pane that enumerates the rendered document's headings (Markdown and AsciiDoc alike), supports click-to-navigate, scroll-spy active-heading tracking, substring filtering, docked reflow beside the content, and an adjustable, persisted width.

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

### Requirement: Outline is a non-modal panel

The outline SHALL be presented as a non-modal panel that does not trap focus, so
the user can continue reading and interacting with the document while it is open.

#### Scenario: Opening the outline
- **WHEN** the user activates the outline toggle
- **THEN** the outline panel appears
- **AND** the document content remains scrollable and clickable

#### Scenario: Closing the outline
- **WHEN** the user activates the close control or presses Escape while the
  outline is open
- **THEN** the outline panel is dismissed

#### Scenario: Closed by default
- **WHEN** a document is first loaded
- **THEN** the outline panel is closed and does not cover the content

### Requirement: Outline navigation jumps to the heading

The system SHALL scroll the corresponding heading into view when the user
selects an outline entry, working even when heading IDs are missing or
duplicated by falling back to the captured element reference.

#### Scenario: Jump to a section
- **WHEN** the user selects an outline entry
- **THEN** the corresponding heading is scrolled into view in the preview

#### Scenario: Heading without a usable ID
- **WHEN** the user selects an entry whose heading has a missing or duplicated
  ID
- **THEN** navigation still scrolls to the correct heading element

### Requirement: Outline highlights the active heading on scroll

The system SHALL highlight the outline entry for the heading currently scrolled
into view, updating as the user scrolls. The active-heading tracking SHALL
observe the scroll container that is active for the current layout and SHALL be
rebuilt when the document remounts or the layout changes.

#### Scenario: Active heading updates while scrolling (single layout)
- **WHEN** the user scrolls the preview in single layout
- **THEN** the outline entry for the heading currently in view is highlighted
  and updates as scrolling continues

#### Scenario: Active heading tracking survives a layout change
- **WHEN** the user switches between single and split layout with the outline
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
rail, and the document SHALL reflow to reserve space beside it so its content is
not covered by the panel. Closing the outline SHALL release that reserved space
so the document is never left narrowed while the outline is hidden.

#### Scenario: Docking reflows the document
- **WHEN** the outline is open
- **THEN** the document reflows so its content is not covered by the panel

#### Scenario: Closing releases reserved space
- **WHEN** the user closes the outline
- **THEN** the document returns to full width

### Requirement: Outline width is adjustable and remembered

The outline width SHALL be adjustable by dragging a handle on its left edge
(its docked right edge staying fixed), bounded to a minimum width and to keeping
a minimum amount of document visible. The chosen width SHALL persist across
reloads using browser-local UI state.

#### Scenario: Resizing by dragging the left edge
- **WHEN** the user drags the outline's left-edge handle
- **THEN** the panel's width changes accordingly while its docked right edge stays
  fixed, bounded to a minimum width and to keeping the document visible

#### Scenario: Width persists across reloads
- **WHEN** the user has resized the outline and reloads the application
- **THEN** the outline reopens at the previously chosen width
