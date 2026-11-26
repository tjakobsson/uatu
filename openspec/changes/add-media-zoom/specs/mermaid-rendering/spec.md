# Spec Delta

## MODIFIED Requirements

### Requirement: Render Mermaid diagrams from fenced code blocks
The preview pane SHALL detect Markdown fenced code blocks whose info string is `mermaid` and AsciiDoc listings declared with either the `[source,mermaid]` style or the bare `[mermaid]` block style, and SHALL render those blocks as Mermaid diagrams in the browser instead of leaving them as plain code blocks.

#### Scenario: Supported Mermaid blocks may defer rendering
- **WHEN** a supported Mermaid block is available for rendering
- **THEN** rendering MAY be deferred until it approaches the viewport, per the lazy-rendering requirement

#### Scenario: Every rendered diagram retains eager-rendered results
- **WHEN** a supported Mermaid block is rendered
- **THEN** its result SHALL be identical to an eagerly rendered diagram

#### Scenario: AsciiDoc parsing recognizes bare Mermaid styles before viewport eligibility
- **WHEN** AsciiDoc is parsed
- **THEN** bare `[mermaid]` SHALL be recognized on `listing` (`----`), `literal` (`....`), and `open` (`--`) contexts, matching the upstream Asciidoctor Diagram extension

#### Scenario: Inline diagrams use the library's intended width rather than uniform slots
- **WHEN** Mermaid emits an SVG with inline `style="max-width: <Wpx>"`
- **THEN** the diagram SHALL render at that diagram-specific intended width capped at available preview content width, without horizontal overflow
- **AND** the SVG SHALL be horizontally centered within the preview column
- **AND** at fit, inline preview honors Mermaid's library-chosen sizing rather than imposing uniform slot dimensions; detailed zoom, pan, and full-canvas inspection are provided by the media-zoom capability's inline zoom and fullscreen viewer, and inline zoom never changes the diagram's box

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

### Requirement: Mermaid diagrams render lazily, one at a time, with rendered-SVG reuse

Mermaid diagram rendering SHALL be deferred until a diagram approaches the viewport (observed with a generous ahead-of-viewport margin) instead of rendering every diagram at document mount. Diagrams that never come near the viewport MUST NOT invoke the mermaid renderer, except the diagram an open fullscreen viewer shows, which SHALL render without waiting to approach the viewport. Queueing, SVG reuse, reachability, and document ownership SHALL follow the scoped rules below.

#### Scenario: Lazy observation follows the effective scroll container in every layout
- **WHEN** a document is mounted or its UI mode changes during the session
- **THEN** deferral MUST be recoverable in every layout: every mounted diagram SHALL render once scrolled to, never remaining permanently un-rendered
- **AND** viewport observation SHALL use the preview's effective scroll container from the single shared resolver, expressed as the container element for element scrolling or the implicit viewport root for page scrolling
- **AND** lazy-rendering machinery MUST NOT derive its own scroll container
- **AND** since observer roots are fixed at observation start, a UI-mode change SHALL re-establish observation only for unrendered diagrams; already-rendered diagrams MUST NOT be reset to source or re-rendered, since the theme has not changed

#### Scenario: Eligible diagrams render incrementally without destabilizing reading
- **WHEN** multiple diagrams become eligible together
- **THEN** they SHALL render through one FIFO queue, one diagram per pass, yielding to the browser's paint cycle between passes so the batch never blocks the main thread as one unit

#### Scenario: Unrendered diagram slots reserve pending placeholders
- **WHEN** a mounted diagram has not yet rendered
- **THEN** its slot SHALL reserve a minimum placeholder height to stabilize scroll position and SHALL look like a pending diagram rather than broken content

#### Scenario: Viewport observation is unavailable
- **WHEN** the environment does not support viewport observation
- **THEN** all diagrams SHALL still render through the yielding queue

#### Scenario: Document changes invalidate superseded queued diagrams
- **WHEN** the previewed document changes
- **THEN** the queue SHALL be invalidated, abandoning superseded pending diagrams instead of rendering them into the new preview

#### Scenario: Every rendered diagram uses bounded source-and-theme cache reuse
- **WHEN** a diagram is rendered
- **THEN** SVGs SHALL be reused from an in-memory, size-bounded cache keyed by source text and active theme inputs; a cache hit MUST NOT invoke the mermaid renderer

#### Scenario: Invalid-source render failures are not cached
- **WHEN** a Mermaid render attempt fails because its source is invalid
- **THEN** the failed render MUST NOT be cached, so corrected source re-renders

#### Scenario: Off-screen diagrams do not render at mount
- **WHEN** a document containing many Mermaid diagrams is mounted and most diagrams are far below the viewport
- **THEN** only diagrams at or near the viewport render initially
- **AND** the far-off-screen diagrams have not invoked the mermaid renderer

#### Scenario: The diagram an open viewer shows renders while off-screen
- **WHEN** the fullscreen viewer shows a document's diagram and an edit to the document moves that diagram far below the viewport
- **THEN** that diagram renders without being scrolled to, and the viewer shows its re-render
- **AND** the other far-off-screen diagrams remain pending placeholders

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

## REMOVED Requirements

### Requirement: Inspect Mermaid diagrams in a fullscreen viewer
**Reason**: The fullscreen viewer now serves images, SVGs and chat media as well as Mermaid diagrams, so its requirements move to the `media-zoom` capability. Every existing viewer behaviour is kept there, with three deliberate changes: editing the shown file no longer closes the viewer, which keeps its scale and pan and shows the re-rendered diagram; a click on the empty backdrop also closes the viewer; and a click on a diagram that is zoomed inline pans it instead of opening the viewer.
**Migration**: See `media-zoom`: "One shared fullscreen viewer serves every surface", "The viewer supports pointer, touch, toolbar and keyboard navigation", "The viewer closes only on deliberate dismissal", "Zoomable media is keyboard operable", "Activating media at fit opens the viewer", and "Zoom survives edits to the shown file". The diagram's expand badge becomes the expand control of the inline zoom toolbar. Tests that assert the viewer closes on a file edit change to assert it stays open with the new diagram.
