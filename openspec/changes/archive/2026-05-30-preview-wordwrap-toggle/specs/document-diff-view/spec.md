## ADDED Requirements

### Requirement: Diff view honors the global Wrap preference

When the diff renders via the Pierre render path, the Diff view SHALL
honor the global Wrap preference by configuring the library's line
overflow mode: wrapping long lines when Wrap is on and scrolling them
horizontally when Wrap is off. The library's own per-line line numbers
SHALL remain correct in both modes. Toggling Wrap MUST re-render the
active diff in place from the already-cached payload — no network
round-trip and no full document reload. On the state-card fallback paths
and the lightweight large-diff fallback (which do not use the library's
line renderer), the Wrap preference MAY have no visible effect.

#### Scenario: Wrap on wraps diff lines
- **WHEN** the diff renders via the Pierre path and the global Wrap preference is on
- **THEN** long diff lines wrap within the available width
- **AND** the library's line numbers remain correct

#### Scenario: Wrap off scrolls diff lines horizontally
- **WHEN** the diff renders via the Pierre path and the global Wrap preference is off
- **THEN** long diff lines scroll horizontally rather than wrapping

#### Scenario: Toggling Wrap re-renders the diff in place
- **WHEN** a diff is rendered via the Pierre path and the user toggles Wrap
- **THEN** the active diff re-renders with the new wrap mode using the cached payload
- **AND** no new fetch is made against the document-diff endpoint
