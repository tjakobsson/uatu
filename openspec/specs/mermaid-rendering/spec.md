# mermaid-rendering Specification

## Purpose
Lazily render themed Mermaid blocks from Markdown and AsciiDoc with isolated error handling, cached SVG reuse, responsive inline sizing, and an accessible fullscreen pan-and-zoom viewer.
## Requirements
### Requirement: Render Mermaid diagrams from fenced code blocks
The preview pane SHALL detect Markdown fenced code blocks whose info string is `mermaid` and AsciiDoc listings declared with either the `[source,mermaid]` style or the bare `[mermaid]` block style, and SHALL render those blocks as Mermaid diagrams in the browser instead of leaving them as plain code blocks.

#### Scenario: Deferred and bare-style diagrams retain the supported rendering contract
- **WHEN** a supported Mermaid block approaches the viewport
- **THEN** rendering MAY have been deferred per the lazy-rendering requirement, but its result SHALL be identical to eager rendering
- **AND** bare `[mermaid]` SHALL be recognized on `listing` (`----`), `literal` (`....`), and `open` (`--`) contexts, matching the upstream Asciidoctor Diagram extension

#### Scenario: Inline diagrams use the library's intended width rather than uniform slots
- **WHEN** Mermaid emits an SVG with inline `style="max-width: <Wpx>"`
- **THEN** the diagram SHALL render at that diagram-specific intended width capped at available preview content width, without horizontal overflow
- **AND** the SVG SHALL be horizontally centered within the preview column
- **AND** detailed zoom, pan, and full-canvas inspection SHALL be provided by the fullscreen viewer modal rather than imposing uniform inline slot dimensions

#### Scenario: A Markdown Mermaid fenced block renders as a diagram
- **WHEN** a selected Markdown file contains a fenced code block with the info string `mermaid`
- **THEN** the preview renders the block as a Mermaid diagram once it is at or near the viewport
- **AND** the rendered diagram remains within the document flow of the preview

#### Scenario: An AsciiDoc `[source,mermaid]` listing renders as a diagram
- **WHEN** a selected AsciiDoc file contains a `[source,mermaid]` listing
- **THEN** the preview renders the listing as a Mermaid diagram once it is at or near the viewport
- **AND** the rendered diagram remains within the document flow of the preview

#### Scenario: An AsciiDoc bare `[mermaid]` block renders as a diagram
- **WHEN** a selected AsciiDoc file contains a bare `[mermaid]` block (declared with `[mermaid]` above a `----`, `....`, or `--` delimited block)
- **THEN** the preview renders the block as a Mermaid diagram once it is at or near the viewport
- **AND** the rendered output is indistinguishable from the same diagram authored as `[source,mermaid]`
- **AND** the rendered diagram remains within the document flow of the preview

#### Scenario: A diagram renders at Mermaid's library-chosen size, centered in the preview
- **WHEN** a Mermaid diagram of any supported type renders in the preview
- **THEN** the rendered SVG width matches Mermaid's emitted `max-width` (the library's intended display size for that diagram)
- **AND** the SVG is horizontally centered within the preview column

#### Scenario: A wide diagram does not overflow the preview width
- **WHEN** Mermaid's emitted intended width for a diagram is greater than the available preview content width
- **THEN** the rendered SVG shrinks to fit within the preview content width
- **AND** the diagram is not horizontally clipped, and its aspect ratio is preserved

### Requirement: Inspect Mermaid diagrams in a fullscreen viewer
The preview pane SHALL make every rendered Mermaid diagram openable in a fullscreen modal viewer, operable by mouse, keyboard, and touch alone.

#### Scenario: Diagram activation opens a viewport-safe viewer
- **WHEN** a rendered diagram is offered for inspection
- **THEN** the trigger MUST be the diagram itself, presented as a button-like surface with `cursor: zoom-in` and an expand badge visible on hover or keyboard focus
- **AND** the modal SHALL fill the entire browser viewport in width and height, sized against the actually visible viewport so controls remain inside it even when nominal viewport height exceeds the visible area
- **AND** controls SHALL clear device safe areas in every orientation and present targets of at least 44px on coarse-pointer devices

#### Scenario: Viewer navigation supports pointer, touch, toolbar, and keyboard input
- **WHEN** the viewer is open
- **THEN** it SHALL support single-pointer drag-to-pan, cursor-centered wheel-to-zoom, midpoint-anchored two-finger pinch-to-zoom, double-click and double-tap to fit-to-screen, an inline zoom-in / zoom-out / fit-to-screen toolbar, and `+`, `-`, and `0` or `f` (fit-to-screen) shortcuts
- **AND** an in-progress single-pointer pan MUST NOT be disturbed by another pointer arriving or leaving; panning SHALL resume from the surviving pointer's position without displacing the diagram
- **AND** panning SHALL be bounded to retain a portion of the diagram within the viewer in every input mode, and zoom SHALL be clamped to a bounded range

#### Scenario: Viewer dismissal preserves focus and avoids accidental gesture closes
- **WHEN** the user dismisses the viewer or the watched file changes while it is open
- **THEN** the modal MUST be dismissible with Escape and an explicit toolbar close control, but MUST NOT be dismissible by a pan-like gesture
- **AND** closing MUST return focus to the trigger that opened it
- **AND** a watched-file change MUST close the modal automatically because the trigger no longer exists in the new render

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

### Requirement: Apply the active UI theme to Mermaid diagrams
The Mermaid renderer SHALL be initialized with theme inputs that can be supplied by the rest of the application, including a `theme` name (one of Mermaid's supported theme names) and an optional `themeVariables` object.

#### Scenario: Theme defaults and live changes match the surrounding application
- **WHEN** the application supplies initial or changed theme inputs during a watch session
- **THEN** until a non-default theme is supplied the preview MUST continue using Mermaid's existing light visual
- **AND** when the application theme changes, rendered diagrams in the visible preview MUST be re-rendered with the new inputs to match the surrounding UI

#### Scenario: Diagrams render with the default light theme by default
- **WHEN** the application is using its default light theme
- **THEN** Mermaid diagrams render with the existing light visual style

#### Scenario: A theme change re-renders visible diagrams
- **WHEN** the application's active theme changes during a watch session
- **AND** the current preview contains rendered Mermaid diagrams
- **THEN** those diagrams are re-rendered using the new theme inputs
- **AND** the new visuals match the active UI theme

### Requirement: Tolerate invalid Mermaid diagrams without aborting the preview
The preview pane SHALL treat a Mermaid block whose source fails to parse or render as a per-block failure, not a document-level failure. The renderer MUST NOT propagate the failure as an unhandled promise rejection.

#### Scenario: Invalid blocks preserve surrounding document rendering
- **WHEN** a Mermaid block fails to parse or render
- **THEN** it SHALL display Mermaid's built-in inline error indicator where the diagram would have rendered
- **AND** other diagrams both before and after it MUST continue rendering normally
- **AND** non-diagram content (Markdown text, AsciiDoc sections, code blocks) MUST continue rendering normally regardless of any Mermaid failure

#### Scenario: A diagram with invalid syntax does not break the preview
- **WHEN** the watched document contains a Mermaid block with invalid syntax (for example, an unrecognized diagram keyword such as `flowchat` instead of `flowchart`)
- **THEN** the preview render completes without an unhandled promise rejection
- **AND** the failing block displays Mermaid's inline error indicator
- **AND** the rest of the document — surrounding text and other rendered diagrams — appears as it would for a fully valid document

#### Scenario: Other diagrams in the same document still render when one fails
- **WHEN** the watched document contains two Mermaid blocks, one valid and one invalid
- **THEN** the valid block renders as a diagram
- **AND** the invalid block displays Mermaid's inline error indicator
- **AND** the order of the two blocks does not change which one renders successfully


### Requirement: Mermaid diagrams render lazily, one at a time, with rendered-SVG reuse

Mermaid diagram rendering SHALL be deferred until a diagram approaches the viewport (observed with a generous ahead-of-viewport margin) instead of rendering every diagram at document mount. Diagrams that never come near the viewport MUST NOT invoke the mermaid renderer. Rendering SHALL use a yielding FIFO queue and size-bounded SVG reuse while preserving reachability and document ownership.

#### Scenario: Lazy observation follows the effective scroll container in every layout
- **WHEN** a document is mounted or its UI mode changes during the session
- **THEN** deferral MUST be recoverable in every layout: every mounted diagram SHALL render once scrolled to, never remaining permanently un-rendered
- **AND** viewport observation SHALL use the preview's effective scroll container from the single shared resolver, expressed as the container element for element scrolling or the implicit viewport root for page scrolling
- **AND** lazy-rendering machinery MUST NOT derive its own scroll container
- **AND** since observer roots are fixed at observation start, a UI-mode change SHALL re-establish observation only for unrendered diagrams; already-rendered diagrams MUST NOT be reset to source or re-rendered when the theme has not changed

#### Scenario: Eligible diagrams render incrementally without destabilizing reading
- **WHEN** multiple diagrams become eligible together
- **THEN** they SHALL render through one FIFO queue, one diagram per pass, yielding to the browser's paint cycle between passes so the batch never blocks the main thread as one unit

#### Scenario: A single or multiple diagrams remain unrendered
- **WHEN** a mounted diagram has not yet rendered
- **THEN** its slot SHALL reserve a minimum placeholder height to stabilize scroll position and SHALL look like a pending diagram rather than broken content

#### Scenario: Viewport observation is unavailable for any number of diagrams
- **WHEN** the environment does not support viewport observation, including a document with only one diagram
- **THEN** all diagrams SHALL still render through the yielding queue

#### Scenario: Document changes and cache hits avoid stale or redundant rendering
- **WHEN** the previewed document changes or a diagram's source and theme inputs are revisited
- **THEN** the queue SHALL be invalidated on document change, abandoning superseded pending diagrams instead of rendering them into the new preview
- **AND** SVGs SHALL be reused from an in-memory, size-bounded cache keyed by source text and active theme inputs; a cache hit MUST NOT invoke the mermaid renderer
- **AND** failed invalid-source renders MUST NOT be cached, so corrected source re-renders

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
