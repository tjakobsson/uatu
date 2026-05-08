## ADDED Requirements

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
