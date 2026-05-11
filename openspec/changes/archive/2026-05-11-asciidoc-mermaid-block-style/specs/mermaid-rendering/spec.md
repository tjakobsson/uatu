## MODIFIED Requirements

### Requirement: Render Mermaid diagrams from fenced code blocks

The preview pane SHALL detect Markdown fenced code blocks whose info string is `mermaid` and AsciiDoc listings declared with either the `[source,mermaid]` style or the bare `[mermaid]` block style, and SHALL render those blocks as Mermaid diagrams in the browser instead of leaving them as plain code blocks. The bare `[mermaid]` block style SHALL be recognized on `listing` (`----`), `literal` (`....`), and `open` (`--`) block contexts, matching the surface of the upstream Asciidoctor Diagram extension. Each rendered diagram SHALL render at the size Mermaid emits (the library's diagram-specific intended display width, exposed via the SVG's inline `style="max-width: <Wpx>"`), capped at the available preview content width so the diagram does not overflow horizontally. The SVG SHALL be horizontally centered within the preview column. Detailed inspection (zoom, pan, full-canvas viewing) is provided by the fullscreen viewer modal — the inline preview honors Mermaid's library-chosen sizing rather than imposing uniform slot dimensions.

#### Scenario: A Markdown Mermaid fenced block renders as a diagram

- **WHEN** a selected Markdown file contains a fenced code block with the info string `mermaid`
- **THEN** the preview renders the block as a Mermaid diagram
- **AND** the rendered diagram remains within the document flow of the preview

#### Scenario: An AsciiDoc `[source,mermaid]` listing renders as a diagram

- **WHEN** a selected AsciiDoc file contains a `[source,mermaid]` listing
- **THEN** the preview renders the listing as a Mermaid diagram
- **AND** the rendered diagram remains within the document flow of the preview

#### Scenario: An AsciiDoc bare `[mermaid]` block renders as a diagram

- **WHEN** a selected AsciiDoc file contains a bare `[mermaid]` block (declared with `[mermaid]` above a `----`, `....`, or `--` delimited block)
- **THEN** the preview renders the block as a Mermaid diagram
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
