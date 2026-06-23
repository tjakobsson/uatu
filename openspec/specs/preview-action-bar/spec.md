## Purpose

Define the preview-header action-icon bar: a group of inline-SVG icon buttons alongside the existing view and wrap controls that hosts the outline toggle and a copy-source action, gated to Rendered view and to applicable documents.

## Requirements

### Requirement: Preview header hosts an action-icon bar

The preview header SHALL present a group of icon buttons alongside the existing
view and wrap controls. The group SHALL host the outline toggle and a
copy-source action, using inline SVG icons (no external image assets) styled
consistently with the existing preview controls.

#### Scenario: Action bar visible in rendered view
- **WHEN** a renderable document is displayed in Rendered view
- **THEN** the action-icon bar is shown in the preview header

### Requirement: Action bar is gated to applicable views and documents

The action-icon bar buttons SHALL be hidden when they do not apply. Both the
outline toggle and copy-source SHALL be hidden outside Rendered view. The
outline toggle SHALL additionally be hidden when the document has no headings.

#### Scenario: Hidden in source view
- **WHEN** the user switches to Source view
- **THEN** the outline toggle and copy-source buttons are hidden

#### Scenario: Hidden in diff view
- **WHEN** the user switches to Diff view
- **THEN** the outline toggle and copy-source buttons are hidden

#### Scenario: Outline toggle hidden without headings
- **WHEN** a rendered document has no headings
- **THEN** the outline toggle is hidden while copy-source remains available

### Requirement: Outline toggle controls the outline overlay

The outline toggle button SHALL open and close the outline overlay and SHALL
reflect the overlay's current open state.

#### Scenario: Toggling the outline
- **WHEN** the user activates the outline toggle while the overlay is closed
- **THEN** the overlay opens and the toggle indicates the active state
- **WHEN** the user activates the outline toggle while the overlay is open
- **THEN** the overlay closes and the toggle indicates the inactive state

### Requirement: Copy-source copies the raw document text

The copy-source button SHALL copy the raw source text of the current document
to the clipboard and give visible feedback on success or failure, reusing the
existing clipboard helper.

#### Scenario: Copying the source
- **WHEN** the user activates the copy-source button
- **THEN** the raw document text is written to the clipboard
- **AND** the button shows brief confirmation feedback

#### Scenario: Clipboard failure feedback
- **WHEN** copying to the clipboard fails
- **THEN** the button shows brief failure feedback
