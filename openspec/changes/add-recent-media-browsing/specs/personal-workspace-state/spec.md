## ADDED Requirements

### Requirement: Personal Files state supports Recent and ignored visibility
The validated personal workspace-state record SHALL accept All, Recent, and Changed as Files view values and a boolean Show ignored files preference. Existing All/Changed records SHALL retain their meaning and unrelated saved fields. Missing Files view SHALL default to All. Missing ignored visibility SHALL resolve from explicit legacy session/project defaults, otherwise to show. Stored personal visibility SHALL take precedence over those initial defaults. Partial updates SHALL persist these choices per authenticated user and workspace without altering another open client's current view or visibility. Invalid new values SHALL be rejected without changing persisted state.

#### Scenario: Recent is restored on another client
- **WHEN** a user saves Recent and later opens the same workspace on another device
- **THEN** that device starts Files in Recent
- **AND** an explicit preview URL still determines the preview independently

#### Scenario: Existing records retain their meaning
- **WHEN** an existing record contains Changed but no ignored-visibility field
- **THEN** Changed is restored and ignored visibility uses the documented initial default
- **AND** the saved document, Follow, compare target, preview mode, and PTY reference remain intact

#### Scenario: Ignored visibility remains independent between open clients
- **WHEN** one client saves Show ignored files as off
- **THEN** another already-open client retains its current visibility and playback
- **AND** a later client boot restores the saved off preference

#### Scenario: An invalid update is rejected
- **WHEN** a client supplies an unknown Files view or a non-boolean ignored visibility
- **THEN** the personal-state API refuses the update without changing any saved fields

#### Scenario: Conflicting root defaults do not prevent personal restoration
- **WHEN** watched roots have conflicting explicit respectGitignore defaults
- **THEN** the session remains available and a saved personal showIgnored preference takes precedence
- **AND** without that preference --no-gitignore selects show, otherwise any root's explicit true selects hide, independently of root order

#### Scenario: Runtime audition data is not personal state
- **WHEN** a user plays a clip, seeks, or changes the temporary media-type filter
- **THEN** media bytes, playback position, active playback, and audition ordering are not written into the personal workspace-state record
