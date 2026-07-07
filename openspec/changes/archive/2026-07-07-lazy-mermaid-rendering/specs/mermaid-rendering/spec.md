## ADDED Requirements

### Requirement: Mermaid diagrams render lazily, one at a time, with rendered-SVG reuse

Mermaid diagram rendering SHALL be deferred until a diagram approaches the viewport (observed with a generous ahead-of-viewport margin) instead of rendering every diagram at document mount. Diagrams that never come near the viewport MUST NOT invoke the mermaid renderer. When multiple diagrams become eligible together, they SHALL render through a single FIFO queue that processes one diagram per pass and yields to the browser's paint cycle between passes, so a batch of diagrams never blocks the main thread as one unit. Un-rendered diagram slots SHALL act as placeholders that reserve a minimum height so lazy rendering does not destabilize scroll position, and SHALL be visually identifiable as pending diagrams rather than broken content. The queue SHALL be invalidated when the previewed document changes, so a superseded document's pending diagrams are abandoned rather than rendered into the new preview. Rendered diagram SVGs SHALL be reused from an in-memory, size-bounded cache keyed by the diagram's source text and the active theme inputs — a cache hit MUST NOT invoke the mermaid renderer. Failed (invalid-source) renders MUST NOT be cached, so a corrected source re-renders. In environments without viewport observation, all diagrams SHALL still render through the yielding queue.

#### Scenario: Off-screen diagrams do not render at mount
- **WHEN** a document containing many Mermaid diagrams is mounted and most diagrams are far below the viewport
- **THEN** only diagrams at or near the viewport render initially
- **AND** the far-off-screen diagrams have not invoked the mermaid renderer

#### Scenario: Scrolling reveals and renders pending diagrams
- **WHEN** the user scrolls toward un-rendered diagram placeholders
- **THEN** those diagrams render as they approach the viewport
- **AND** rendering proceeds one diagram at a time with paint yields between diagrams

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

## MODIFIED Requirements

### Requirement: Render Mermaid diagrams from fenced code blocks
The preview pane SHALL detect Markdown fenced code blocks whose info string is `mermaid` and AsciiDoc listings declared with either the `[source,mermaid]` style or the bare `[mermaid]` block style, and SHALL render those blocks as Mermaid diagrams in the browser instead of leaving them as plain code blocks. Rendering MAY be deferred until a block approaches the viewport (per the lazy-rendering requirement); once rendered, the result SHALL be identical to an eagerly rendered diagram. The bare `[mermaid]` block style SHALL be recognized on `listing` (`----`), `literal` (`....`), and `open` (`--`) block contexts, matching the surface of the upstream Asciidoctor Diagram extension. Each rendered diagram SHALL render at the size Mermaid emits (the library's diagram-specific intended display width, exposed via the SVG's inline `style="max-width: <Wpx>"`), capped at the available preview content width so the diagram does not overflow horizontally. The SVG SHALL be horizontally centered within the preview column. Detailed inspection (zoom, pan, full-canvas viewing) is provided by the fullscreen viewer modal — the inline preview honors Mermaid's library-chosen sizing rather than imposing uniform slot dimensions.

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
