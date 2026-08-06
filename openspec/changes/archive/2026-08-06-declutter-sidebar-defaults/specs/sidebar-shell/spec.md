# sidebar-shell — delta for declutter-sidebar-defaults

## ADDED Requirements

### Requirement: Fresh clients default to a lean pane set
On a client with no stored pane state, the sidebar SHALL default to `Change Overview` and `Files` visible, with `Git Log` and `Search` hidden. Hidden-by-default panes SHALL remain available through the per-pane visibility menu. Stored pane state SHALL always take precedence over defaults — changing defaults MUST NOT alter any client's existing arrangement. The pane-state reader SHALL ignore stored entries for pane ids that no longer exist, without error and without discarding the rest of the stored state.

#### Scenario: First visit shows the lean sidebar
- **WHEN** the app loads on a client with no `uatu:sidebar-panes` stored state
- **THEN** Change Overview and Files are visible and Git Log and Search are not
- **AND** the panes menu lists Git Log as an available toggle

#### Scenario: Existing arrangements are untouched
- **WHEN** the app loads on a client whose stored pane state has Git Log visible
- **THEN** Git Log renders visible exactly as stored

#### Scenario: Stale pane ids in storage are inert
- **WHEN** the stored pane state contains an entry for a pane id that no longer exists (e.g., `selection-inspector`)
- **THEN** the app boots normally and the remaining pane entries are honored
