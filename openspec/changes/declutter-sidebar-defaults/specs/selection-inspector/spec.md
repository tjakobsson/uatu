# selection-inspector — delta for declutter-sidebar-defaults

The capability is retired in full. All requirements share the same reason and
migration.

## REMOVED Requirements

### Requirement: Selection Inspector pane is available in Review mode
**Reason**: Capability retired — the capture-a-line-reference workflow saw little use and its Review/Author mode gating has drifted from the current app.
**Migration**: Line references can be composed manually from the Source view's line-number gutter. The archived spec is the blueprint if the capability is ever revived.

### Requirement: Selection Inspector pane is hidden in Author mode
**Reason**: Capability retired.
**Migration**: None — mode gating disappears with the pane.

### Requirement: Pane captures line ranges from Source-view selections
**Reason**: Capability retired.
**Migration**: Compose `@path#L…` references manually from the visible line numbers.

### Requirement: Pane displays a Claude-Code-style at-mention reference
**Reason**: Capability retired.
**Migration**: Compose references manually.

### Requirement: Clicking the reference copies it to the clipboard
**Reason**: Capability retired.
**Migration**: Copy manually composed references.

### Requirement: Rendered view shows an active hint, not a captured reference
**Reason**: Capability retired.
**Migration**: None — the hint has no successor.

### Requirement: Selections inside fenced code blocks in Rendered view are ignored
**Reason**: Capability retired.
**Migration**: None.

### Requirement: Selections outside the source-view code block are ignored
**Reason**: Capability retired.
**Migration**: None.

### Requirement: Pane shows a placeholder when there is no preview selection
**Reason**: Capability retired.
**Migration**: None.

### Requirement: Pane clears on document or view-mode change
**Reason**: Capability retired.
**Migration**: None.

### Requirement: Selection state is not persisted across reloads
**Reason**: Capability retired.
**Migration**: Stored `selection-inspector` entries in `uatu:sidebar-panes` are ignored by the pane-state reader; no cleanup required.
