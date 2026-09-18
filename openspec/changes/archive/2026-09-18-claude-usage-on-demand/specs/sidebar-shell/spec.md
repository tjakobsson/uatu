## MODIFIED Requirements

### Requirement: The sidebar hosts a Usage pane in the pane stack
The sidebar SHALL include a Usage pane participating in the existing pane-stack behavior: it can be collapsed, hidden, resized, and restored from the panels menu, and its visibility and height SHALL persist across reloads like the other panes. The pane SHALL show the workspace's last-known plan-usage windows — each window's name, percentage used, and reset time — with the time they were read and how long ago; a report older than ten minutes SHALL be marked stale while remaining readable. The pane SHALL show the last-known report as soon as the client loads, without waiting for a conversation to be opened or a turn to end, and SHALL follow every newer report from any Claude Code conversation. The pane SHALL offer a control that reads plan usage now, subject to the same rules as the chat readout's control: a live Claude Code session answers without interruption, an idle conversation is started and retired for the read, the control shows a read in flight, and a failed read keeps the figures and states why. Opening the pane while its report is stale and a Claude Code session is live SHALL refresh through that session unasked. When no report has ever been read, the pane SHALL show an empty state that offers the read control. The pane SHALL default to hidden. When the chat's plan readout is open and the sidebar is displayed beside the chat, the readout SHALL offer a control that reveals the Usage pane.

#### Scenario: Usage pane behaves like its siblings
- **WHEN** the user collapses, hides, and then restores the Usage pane from the panels menu
- **THEN** it behaves identically to the Files and Git Log panes and its state persists across a reload

#### Scenario: Pinning from the readout reveals the pane
- **WHEN** the plan readout is open beside a displayed sidebar and the user activates its keep-in-sidebar control
- **THEN** the Usage pane becomes visible and expanded without disturbing the other panes' persisted state

#### Scenario: The pane follows the newest report
- **WHEN** a Claude Code conversation reports fresh plan usage after a turn or a read
- **THEN** the Usage pane shows those figures without the user reselecting anything

#### Scenario: The pane survives a reload
- **WHEN** the client reloads or returns to the workspace and no turn has ended since the last report
- **THEN** the Usage pane shows the last-known windows with the time they were read and how long ago

#### Scenario: A stale report says so
- **WHEN** the pane's report was read more than ten minutes ago
- **THEN** its figures remain shown and are marked stale

#### Scenario: The pane reads on demand
- **WHEN** the user activates the pane's read control
- **THEN** the control shows the read in flight
- **AND** the pane shows the refreshed windows with a new read time when it completes

#### Scenario: A failed read keeps the pane's figures
- **WHEN** the pane's read fails
- **THEN** the last-known windows remain shown
- **AND** the pane states that the read failed and why

#### Scenario: No report yet
- **WHEN** no plan usage has ever been read in this workspace
- **THEN** the Usage pane states that nothing has been read yet and offers the read control
