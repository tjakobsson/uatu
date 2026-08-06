# preview-action-bar — delta for mobile-experience

## ADDED Requirements

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
