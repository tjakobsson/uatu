## ADDED Requirements

### Requirement: Pane headers render title and metadata without visual overlap
Every sidebar pane header SHALL render its title (`<h2>`) and its metadata block (file count, filter chip, and any action buttons) without visual overlap at every supported sidebar width. When the metadata and action blocks together would otherwise crowd the title to the point of overlap, the title MUST clip with an ellipsis rather than paint into the metadata block's coordinate space. The metadata and action blocks MUST NOT shrink at any width — they hold the time-varying information the user reads at a glance. The horizontal gap between title and metadata MUST be non-zero so the layout remains visually parsable even when the title is heavily clipped.

#### Scenario: Files-pane header is legible at default sidebar width
- **WHEN** the sidebar is at its default width
- **AND** the workspace contains enough files that the document-count text is non-empty (e.g. "65 files · 5 binary")
- **THEN** the Files-pane title bounding rectangle does NOT overlap the document-count bounding rectangle
- **AND** the All/Changed filter chip remains visible
- **AND** the collapse and hide action buttons remain visible

#### Scenario: Files-pane header is legible at minimum sidebar width
- **WHEN** the sidebar is at its minimum supported width (320px)
- **AND** the document-count text is non-empty
- **THEN** the Files-pane title bounding rectangle does NOT overlap the document-count bounding rectangle
- **AND** if the title cannot fit alongside the metadata, the title clips with an ellipsis rather than overlapping the count

#### Scenario: Other pane headers benefit from the same rule
- **WHEN** any sidebar pane header is rendered (Change Overview, Files, Git Log)
- **AND** the metadata block contains visible content
- **THEN** the title and metadata block do NOT visually overlap
