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

### Requirement: Narrow viewports stack the preview toolbar below the heading
Below a narrow-width breakpoint (chosen so a portrait phone stacks and a landscape phone does not, independent of pointer type), the preview header SHALL lay out as a column — document heading first, then the toolbar (view segments, wrap control, action icons) on its own row — instead of a single flex row. The toolbar SHALL be allowed to wrap. Every control MUST remain visible and tappable, the document title MUST NOT be crushed or clipped by the toolbar, and the header MUST NOT overflow the viewport horizontally. Sticky-header positioning and the existing header backdrop treatment SHALL be unchanged.

#### Scenario: Portrait phone shows title and controls on separate rows
- **WHEN** the preview header renders at a portrait-phone width with a document active
- **THEN** the heading occupies its own full-width row and the toolbar renders below it
- **AND** all applicable controls (view segments, wrap, copy-source, outline) are visible and tappable
- **AND** no horizontal page scroll is introduced

#### Scenario: Landscape phone and desktop keep the single-row header
- **WHEN** the preview header renders wider than the breakpoint
- **THEN** heading and toolbar share one row exactly as today

### Requirement: Touch devices can adjust the preview text size
On coarse-pointer devices the preview action bar SHALL provide decrease/increase text-size controls that scale the preview document content only — application chrome is unaffected — by stepping a bounded scale (roughly 85% to 150%) with layout reflow (a text-size change, not a zoom). The chosen step SHALL persist per device across reloads and documents. The controls SHALL NOT appear on fine-pointer devices.

#### Scenario: Larger reading text on a phone
- **WHEN** a user on a coarse-pointer device taps the increase-text-size control twice
- **THEN** the document body text renders two steps larger with lines re-wrapped to the viewport
- **AND** the preview header and sidebar chrome are unchanged

#### Scenario: Step persists across documents and reloads
- **WHEN** the user picks another document and later reloads the page
- **THEN** the preview renders at the previously chosen text-size step

#### Scenario: Bounds are enforced
- **WHEN** the user reaches the maximum step and taps increase again
- **THEN** the size does not change and the control communicates it is at its limit

#### Scenario: Desktop action bar is unchanged
- **WHEN** the action bar renders on a fine-pointer device
- **THEN** no text-size controls are shown
