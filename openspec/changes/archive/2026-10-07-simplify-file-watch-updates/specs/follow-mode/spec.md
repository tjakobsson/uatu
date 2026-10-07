## ADDED Requirements

### Requirement: Discovery does not impersonate file edits

Initial discovery SHALL populate the file tree without causing Follow to visit each discovered file. On completion, an untouched initial session SHALL use the existing newest-mtime non-binary default selection. Explicit navigation, restored selection, direct links, deliberate emptiness, and newer live-event selection SHALL take precedence over that default. Discovery SHALL NOT move keyboard focus, change the active surface, or enable Follow. Catch-up requested while indexing is incomplete SHALL finish once the inventory is ready only if no newer user action or live-event selection has superseded it.

#### Scenario: Follow is on during discovery
- **WHEN** many existing files are discovered before the inventory is complete
- **THEN** the tree fills without a preview load for every discovered file
- **AND** an otherwise untouched session selects the newest eligible file once discovery completes

#### Scenario: The user navigates before discovery finishes
- **WHEN** the user selects a file or deliberately clears selection during indexing
- **THEN** discovery completion preserves that decision and the resulting Follow state

#### Scenario: A real edit occurs during discovery
- **WHEN** an already discovered file receives a live modification event while indexing continues and Follow is on
- **THEN** its fresh preview can be shown before full discovery completes
- **AND** discovery completion does not replace it with the initial default

### Requirement: Batch follow selection and active-file freshness are independent

For each applied live file batch, Follow SHALL select the last observed eligible create or modification in the client's scope that remains present after the batch. A later binary, directory, or removal event MUST NOT erase an earlier eligible candidate. With Follow off, the selected destination SHALL remain unchanged, and an update to that destination SHALL reload current content even when another path is the batch's Follow candidate. With Follow on and the target already selected, its update SHALL still reload current content. No refresh SHALL reuse a preview cache invalidated by the batch. Source, Rendered, split, Diff, and image presentations SHALL invalidate affected representations; historical commit previews SHALL remain historical. Selection changes SHALL preserve existing URL replacement, focus, active-surface, and programmatic-tree guards.

#### Scenario: A binary event follows a text edit
- **WHEN** Follow is on and a batch contains a text edit followed by a binary edit
- **THEN** the text file remains the eligible Follow target

#### Scenario: The open file is not the last changed path
- **WHEN** Follow is off, file A is open, and one batch changes A followed by B
- **THEN** A remains selected and renders fresh content
- **AND** B's update does not suppress A's invalidation

#### Scenario: Follow targets the already open file
- **WHEN** Follow is on and its eligible target is the currently previewed file
- **THEN** that file reloads from current bytes even though selection did not change

#### Scenario: An old representation arrives after invalidation
- **WHEN** a source, rendered, split-pane, diff, or image load started before a file update finishes afterward
- **THEN** it cannot restore content or caches belonging to the earlier revision

#### Scenario: A saved image is open with Follow off
- **WHEN** the selected image is replaced at the same path
- **THEN** its preview fetches the new image bytes while selection, URL, focus, and active surface remain unchanged
