## MODIFIED Requirements

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
