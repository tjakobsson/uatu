## MODIFIED Requirements

### Requirement: Mermaid diagrams render lazily, one at a time, with rendered-SVG reuse

Mermaid diagram rendering SHALL be deferred until a diagram approaches the viewport (observed with a generous ahead-of-viewport margin) instead of rendering every diagram at document mount. Diagrams that never come near the viewport MUST NOT invoke the mermaid renderer. Deferral MUST be recoverable in every layout: any diagram in the mounted document SHALL render once the user scrolls to it, so no diagram is left permanently un-rendered. Viewport observation SHALL be performed against the preview's effective scroll container as resolved by the single shared resolver, expressed in the form the observation API requires — the container element when the preview scrolls inside an element, and the implicit viewport root when the page is what scrolls. The lazy-rendering machinery MUST NOT derive its own scroll container. Because an observer's root is fixed when observation begins, observation SHALL be re-established when the UI mode changes during a session, and re-establishing it MUST affect only diagrams that have not yet rendered — already-rendered diagrams MUST NOT be reset to their source or re-rendered, since the theme has not changed. When multiple diagrams become eligible together, they SHALL render through a single FIFO queue that processes one diagram per pass and yields to the browser's paint cycle between passes, so a batch of diagrams never blocks the main thread as one unit. Un-rendered diagram slots SHALL act as placeholders that reserve a minimum height so lazy rendering does not destabilize scroll position, and SHALL be visually identifiable as pending diagrams rather than broken content. The queue SHALL be invalidated when the previewed document changes, so a superseded document's pending diagrams are abandoned rather than rendered into the new preview. Rendered diagram SVGs SHALL be reused from an in-memory, size-bounded cache keyed by the diagram's source text and the active theme inputs — a cache hit MUST NOT invoke the mermaid renderer. Failed (invalid-source) renders MUST NOT be cached, so a corrected source re-renders. In environments without viewport observation, all diagrams SHALL still render through the yielding queue.

#### Scenario: Off-screen diagrams do not render at mount
- **WHEN** a document containing many Mermaid diagrams is mounted and most diagrams are far below the viewport
- **THEN** only diagrams at or near the viewport render initially
- **AND** the far-off-screen diagrams have not invoked the mermaid renderer

#### Scenario: Off-screen diagrams stay deferred in touch mode
- **WHEN** a document containing many Mermaid diagrams is mounted with `data-ui-mode="touch"` on the document element, where the preview shell does not scroll and the page does
- **THEN** diagrams far below the visible screen remain pending placeholders
- **AND** the deferral matches what the same document produces in the desktop layout

#### Scenario: Scrolling reveals and renders pending diagrams
- **WHEN** the user scrolls toward un-rendered diagram placeholders
- **THEN** those diagrams render as they approach the viewport
- **AND** rendering proceeds one diagram at a time with paint yields between diagrams

#### Scenario: Every diagram in a page-scrolling layout is reachable by scrolling
- **WHEN** a document with many Mermaid diagrams spread far down the page is mounted in a layout where the page scrolls rather than an element — touch mode, or the ≤900px stacked layout
- **AND** the user scrolls through the whole document
- **THEN** every diagram in the document renders
- **AND** none is left a pending placeholder at any distance below the initial screen

#### Scenario: A live UI-mode switch re-establishes observation
- **WHEN** the user switches between touch and desktop mode with a document open and diagrams still pending
- **THEN** subsequent scrolling renders those pending diagrams as they approach the viewport of the newly effective scroll container
- **AND** diagrams that had already rendered are neither reset to their source nor re-rendered

#### Scenario: Placeholders reserve space
- **WHEN** a diagram has not yet rendered
- **THEN** its slot occupies a non-zero reserved height in the document flow
- **AND** the slot is visually identifiable as a pending diagram

#### Scenario: Revisiting a document reuses rendered SVGs
- **WHEN** a diagram with unchanged source and theme was rendered earlier in the session
- **AND** the same diagram is mounted again (revisit, view toggle, or duplicate diagram in another document)
- **THEN** the cached SVG is reused and the mermaid renderer is not invoked for it

#### Scenario: A theme change does not serve stale SVGs
- **WHEN** the active Mermaid theme inputs change
- **AND** a previously rendered diagram is mounted again
- **THEN** the diagram re-renders under the new theme instead of reusing the old SVG

#### Scenario: A corrected invalid diagram re-renders
- **WHEN** a diagram fails to render due to invalid source
- **AND** a live reload delivers corrected source for that diagram
- **THEN** the corrected diagram renders (the failed render was not cached)

#### Scenario: Switching documents abandons the pending queue
- **WHEN** the user switches to another document while diagrams from the previous document are still queued
- **THEN** the superseded queue entries are abandoned
- **AND** no stale diagram renders into the new document's preview

### Requirement: Inspect Mermaid diagrams in a fullscreen viewer

The preview pane SHALL make every rendered Mermaid diagram openable in a fullscreen modal viewer, operable by mouse, keyboard, and touch alone. The trigger MUST be the rendered diagram itself, presented as a button-like surface with a `cursor: zoom-in` affordance and a visible expand badge that appears on hover or keyboard focus. The viewer modal SHALL fill the entire browser viewport (full width and height), sized against the viewport that is actually visible so that no control is placed outside it on engines whose nominal viewport height exceeds the visible area. The viewer's controls SHALL remain clear of device safe areas in every orientation, and SHALL present touch targets of at least 44px on coarse-pointer devices. The viewer modal SHALL support: drag-to-pan with a single pointer, wheel-to-zoom centered on the cursor, two-finger pinch-to-zoom anchored on the midpoint between the pointers, double-click and double-tap to fit-to-screen, an inline toolbar for zoom-in / zoom-out / fit-to-screen, and keyboard shortcuts `+`, `-`, and `0` or `f` (fit-to-screen). An in-progress single-pointer pan MUST NOT be disturbed by an additional pointer arriving or leaving; the viewer SHALL resume panning from the surviving pointer's position without displacing the diagram. Panning SHALL be bounded so that a portion of the diagram always remains within the viewer, in every input mode. Zoom SHALL be clamped to a bounded range. The modal MUST be dismissible with the Escape key and by an explicit close control in the toolbar, and MUST NOT be dismissible by a pan-like gesture. When the modal closes, focus MUST return to the trigger element that opened it. When the watched file changes while the modal is open, the modal MUST close automatically because the trigger element no longer exists in the new render.

#### Scenario: A rendered diagram is keyboard-focusable and announced as a button
- **WHEN** a user tabs through the preview
- **THEN** the rendered Mermaid diagram receives focus as a single interactive element
- **AND** activating it with Enter or Space opens the fullscreen viewer

#### Scenario: Clicking a rendered diagram opens the fullscreen viewer
- **WHEN** a user clicks anywhere on a rendered Mermaid diagram in the preview
- **THEN** a fullscreen modal opens containing the same diagram
- **AND** the rest of the page is visually backgrounded behind the modal

#### Scenario: Wheel-zoom centers on the cursor position
- **WHEN** the modal is open and the user scrolls the wheel over the diagram
- **THEN** the diagram zooms in or out
- **AND** the point under the cursor remains anchored to the cursor position after zooming

#### Scenario: Pinch-zoom anchors on the midpoint between two fingers
- **WHEN** the modal is open and the user places two fingers on the diagram and moves them apart or together
- **THEN** the diagram zooms in or out with the change in finger separation
- **AND** the diagram point beneath the midpoint of the two fingers remains under that midpoint
- **AND** the surrounding page is not zoomed by the gesture

#### Scenario: Drag pans the diagram
- **WHEN** the modal is open and the user presses a pointer button on the diagram and drags
- **THEN** the diagram moves with the pointer
- **AND** releasing the pointer ends the pan

#### Scenario: A second finger does not disturb an in-progress pan
- **WHEN** the user is panning with one finger and a second finger touches the surface, or lifts again afterwards
- **THEN** the diagram does not jump at either transition
- **AND** panning resumes from the position of the finger that remains

#### Scenario: Panning cannot move the diagram entirely off-screen
- **WHEN** the user pans repeatedly in one direction, at any zoom level
- **THEN** part of the diagram remains visible within the viewer
- **AND** no recovery control is required to bring it back into view

#### Scenario: Double-click fits the diagram to the screen
- **WHEN** the modal is open and the user double-clicks anywhere on the diagram
- **THEN** the diagram returns to its initial fit-to-screen view (scaled and centered)

#### Scenario: Double-tap fits the diagram to the screen
- **WHEN** the modal is open and the user taps twice in quick succession on the diagram with a touch pointer
- **THEN** the diagram returns to its initial fit-to-screen view (scaled and centered)

#### Scenario: Toolbar controls operate the viewer
- **WHEN** the modal is open
- **THEN** a toolbar provides zoom in, zoom out, and fit-to-screen actions
- **AND** activating any toolbar action updates the diagram's transform accordingly

#### Scenario: Keyboard shortcuts operate the viewer
- **WHEN** the modal is open and has keyboard focus
- **AND** the user presses `+`, `-`, `0`, or `f`
- **THEN** the corresponding zoom-in, zoom-out, or fit-to-screen action is applied

#### Scenario: Escape closes the viewer and returns focus
- **WHEN** the modal is open and the user presses Escape
- **THEN** the modal closes
- **AND** keyboard focus returns to the diagram element that opened it

#### Scenario: The close control is reachable without a keyboard
- **WHEN** the modal is open on a touch device, in either orientation, in a browser tab or an installed PWA
- **THEN** the close control is within the visible viewport and clear of browser chrome and device safe areas
- **AND** activating it by touch closes the modal

#### Scenario: A pan gesture never dismisses the viewer
- **WHEN** the user drags downward across the viewer with one finger, at any speed
- **THEN** the diagram pans and the modal remains open

#### Scenario: The viewer modal fills the entire browser viewport
- **WHEN** the modal opens
- **THEN** the modal element occupies the full window width and full window height

#### Scenario: A file change while the viewer is open closes the viewer
- **WHEN** the modal is open showing a diagram from the active file
- **AND** the active file is modified on disk and the preview re-renders
- **THEN** the modal closes automatically
- **AND** the inline diagrams reflect the new file contents
