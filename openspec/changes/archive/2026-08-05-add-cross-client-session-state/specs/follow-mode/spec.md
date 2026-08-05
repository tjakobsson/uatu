## MODIFIED Requirements

### Requirement: Follow defaults to ON; URL direct links force OFF on boot
The system SHALL restore `followEnabled` from the current user's personal workspace state when the SPA boots at the workspace root. If no saved Follow value exists, it SHALL use the server-provided `initialFollow` value, whose default is `true` and which the CLI `--no-follow` flag sets to `false`. When an explicit document or preview URL is opened, the system MUST set Follow off for that client regardless of saved or server defaults. User changes to Follow SHALL be persisted for future root arrivals but SHALL NOT change Follow in another already-open client.

#### Scenario: Root arrival restores saved Follow
- **WHEN** personal workspace state contains `follow=false`
- **AND** the user opens the workspace root
- **THEN** Follow boots off even when the CLI default is on

#### Scenario: Root arrival without saved state honors CLI default
- **WHEN** no personal Follow value exists
- **AND** the CLI was started without `--no-follow`
- **THEN** Follow boots on

#### Scenario: Direct link arrival turns Follow off
- **WHEN** a user opens an explicit document or preview URL
- **THEN** Follow is off in that client
- **AND** the user may re-enable it afterward

#### Scenario: One client's Follow change does not control another
- **WHEN** two clients have the same user's workspace open
- **AND** one client toggles Follow
- **THEN** the other open client's Follow state is unchanged
- **AND** the new value is available on a future root arrival
