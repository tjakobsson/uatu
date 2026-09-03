## ADDED Requirements

### Requirement: The sidebar hosts a Usage pane in the pane stack
The sidebar SHALL include a Usage pane participating in the existing pane-stack behavior: it can be collapsed, hidden, resized, and restored from the panels menu, and its visibility and height SHALL persist across reloads like the other panes. The pane SHALL show the plan-usage windows most recently reported to this client by a Claude Code conversation — each window's name, percentage used, and reset time — and SHALL show an explanatory empty state when no conversation has reported plan usage. The pane SHALL default to hidden. When the chat's plan readout is open and the sidebar is displayed beside the chat, the readout SHALL offer a control that reveals the Usage pane.

#### Scenario: Usage pane behaves like its siblings
- **WHEN** the user collapses, hides, and then restores the Usage pane from the panels menu
- **THEN** it behaves identically to the Files and Git Log panes and its state persists across a reload

#### Scenario: Pinning from the readout reveals the pane
- **WHEN** the plan readout is open beside a displayed sidebar and the user activates its keep-in-sidebar control
- **THEN** the Usage pane becomes visible and expanded without disturbing the other panes' persisted state

#### Scenario: The pane follows the newest report
- **WHEN** a Claude Code conversation reports fresh plan usage after a turn
- **THEN** the Usage pane shows those figures without the user reselecting anything

#### Scenario: No report yet
- **WHEN** no conversation on this client has reported plan usage
- **THEN** the Usage pane states that plan usage appears after a Claude Code turn

## MODIFIED Requirements

### Requirement: Fresh clients default to a lean pane set
On a client with no stored pane state, the sidebar SHALL default to `Change Overview` and `Files` visible, with `Git Log`, `Search`, and `Usage` hidden. Hidden-by-default panes SHALL remain available through the per-pane visibility menu. Stored pane state SHALL always take precedence over defaults — changing defaults MUST NOT alter any client's existing arrangement. The pane-state reader SHALL ignore stored entries for pane ids that no longer exist, without error and without discarding the rest of the stored state.

#### Scenario: First visit shows the lean sidebar
- **WHEN** the app loads on a client with no `uatu:sidebar-panes` stored state
- **THEN** Change Overview and Files are visible and Git Log, Search, and Usage are not
- **AND** the panes menu lists Git Log and Usage as available toggles

#### Scenario: Existing arrangements are untouched
- **WHEN** the app loads on a client whose stored pane state has Git Log visible
- **THEN** Git Log renders visible exactly as stored

#### Scenario: Stale pane ids in storage are inert
- **WHEN** the stored pane state contains an entry for a pane id that no longer exists (e.g., `selection-inspector`)
- **THEN** the app boots normally and the remaining pane entries are honored
