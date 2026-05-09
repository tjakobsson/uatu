## ADDED Requirements

### Requirement: Render Mermaid diagrams from fenced code blocks
The preview pane SHALL detect Markdown fenced code blocks whose info string is `mermaid` and AsciiDoc `[source,mermaid]` listings, and SHALL render those blocks as Mermaid diagrams in the browser instead of leaving them as plain code blocks. AsciiDoc bare `[mermaid]` blocks (without the `source` style) MUST NOT render as diagrams — this matches GitHub's behavior, which only recognizes `[source,mermaid]`. Each rendered diagram SHALL render at the size Mermaid emits (the library's diagram-specific intended display width, exposed via the SVG's inline `style="max-width: <Wpx>"`), capped at the available preview content width so the diagram does not overflow horizontally. The SVG SHALL be horizontally centered within the preview column. Detailed inspection (zoom, pan, full-canvas viewing) is provided by the fullscreen viewer modal — the inline preview honors Mermaid's library-chosen sizing rather than imposing uniform slot dimensions.

#### Scenario: A Markdown Mermaid fenced block renders as a diagram
- **WHEN** a selected Markdown file contains a fenced code block with the info string `mermaid`
- **THEN** the preview renders the block as a Mermaid diagram
- **AND** the rendered diagram remains within the document flow of the preview

#### Scenario: An AsciiDoc `[source,mermaid]` listing renders as a diagram
- **WHEN** a selected AsciiDoc file contains a `[source,mermaid]` listing
- **THEN** the preview renders the listing as a Mermaid diagram
- **AND** the rendered diagram remains within the document flow of the preview

#### Scenario: An AsciiDoc bare `[mermaid]` block renders as a literal block
- **WHEN** a selected AsciiDoc file contains a bare `[mermaid]` block (without the `source` style)
- **THEN** the preview renders the block as a literal block, not as a diagram
- **AND** the block content is shown as text, matching GitHub's behavior

#### Scenario: A diagram renders at Mermaid's library-chosen size, centered in the preview
- **WHEN** a Mermaid diagram of any supported type renders in the preview
- **THEN** the rendered SVG width matches Mermaid's emitted `max-width` (the library's intended display size for that diagram)
- **AND** the SVG is horizontally centered within the preview column

#### Scenario: A wide diagram does not overflow the preview width
- **WHEN** Mermaid's emitted intended width for a diagram is greater than the available preview content width
- **THEN** the rendered SVG shrinks to fit within the preview content width
- **AND** the diagram is not horizontally clipped, and its aspect ratio is preserved

### Requirement: Inspect Mermaid diagrams in a fullscreen viewer
The preview pane SHALL make every rendered Mermaid diagram openable in a fullscreen modal viewer. The trigger MUST be the rendered diagram itself, presented as a button-like surface with a `cursor: zoom-in` affordance and a visible expand badge that appears on hover or keyboard focus. The viewer modal SHALL fill the entire browser viewport (full width and height). The viewer modal SHALL support: drag-to-pan, wheel-to-zoom centered on the cursor, double-click to fit-to-screen, an inline toolbar for zoom-in / zoom-out / fit-to-screen, and keyboard shortcuts `+`, `-`, and `0` or `f` (fit-to-screen). The modal MUST be dismissible with the Escape key and by an explicit close control in the toolbar. When the modal closes, focus MUST return to the trigger element that opened it. When the watched file changes while the modal is open, the modal MUST close automatically because the trigger element no longer exists in the new render.

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

#### Scenario: Drag pans the diagram
- **WHEN** the modal is open and the user presses a pointer button on the diagram and drags
- **THEN** the diagram moves with the pointer
- **AND** releasing the pointer ends the pan

#### Scenario: Double-click fits the diagram to the screen
- **WHEN** the modal is open and the user double-clicks anywhere on the diagram
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

#### Scenario: The viewer modal fills the entire browser viewport
- **WHEN** the modal opens
- **THEN** the modal element occupies the full window width and full window height

#### Scenario: A file change while the viewer is open closes the viewer
- **WHEN** the modal is open showing a diagram from the active file
- **AND** the active file is modified on disk and the preview re-renders
- **THEN** the modal closes automatically
- **AND** the inline diagrams reflect the new file contents

### Requirement: Apply the active UI theme to Mermaid diagrams
The Mermaid renderer SHALL be initialized with theme inputs that can be supplied by the rest of the application, including a `theme` name (one of Mermaid's supported theme names) and an optional `themeVariables` object. Until the application provides a non-default theme, the preview MUST continue to use Mermaid's existing light visual. When the application's theme changes during a watch session, the rendered Mermaid diagrams in the visible preview MUST be re-rendered with the new theme inputs so they match the surrounding UI.

#### Scenario: Diagrams render with the default light theme by default
- **WHEN** the application is using its default light theme
- **THEN** Mermaid diagrams render with the existing light visual style

#### Scenario: A theme change re-renders visible diagrams
- **WHEN** the application's active theme changes during a watch session
- **AND** the current preview contains rendered Mermaid diagrams
- **THEN** those diagrams are re-rendered using the new theme inputs
- **AND** the new visuals match the active UI theme

### Requirement: Tolerate invalid Mermaid diagrams without aborting the preview
The preview pane SHALL treat a Mermaid block whose source fails to parse or render as a per-block failure, not a document-level failure. The renderer MUST NOT propagate the failure as an unhandled promise rejection. The failing block SHALL display Mermaid's built-in inline error indicator at the position where the diagram would have rendered. Other Mermaid diagrams in the same document — both before and after the failing block — MUST continue to render normally. Non-diagram content (Markdown text, AsciiDoc sections, code blocks) MUST continue to render normally regardless of any Mermaid failure.

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
