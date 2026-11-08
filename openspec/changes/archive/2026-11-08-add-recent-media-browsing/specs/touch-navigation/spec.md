## MODIFIED Requirements

### Requirement: A preview-bound navigation switches to the Preview tab
When the user explicitly navigates to preview content by selecting a filename in the tree or Recent, selecting a search result, or opening a commit or other preview destination, the UI SHALL switch to Preview. Directory expansion, Files view/query/filter controls, and media audition actions SHALL NOT switch tabs. A media Play action SHALL stay in Files and retain the current preview destination. Programmatic tree/Recent updates and Follow events MUST NOT switch tabs.

#### Scenario: Pick lands on Preview
- **WHEN** the user taps a filename in All, Recent, or Changed
- **THEN** Preview becomes active and shows that file without initiating media playback or interrupting an already active session

#### Scenario: A search result lands on Preview
- **WHEN** the user taps a project-search result in Files
- **THEN** Preview becomes active with the matched document

#### Scenario: File events do not steal the Files tab
- **WHEN** Files is active and a file event updates the tree or Recent
- **THEN** Files remains active without automatic playback

#### Scenario: Audition stays in Files
- **WHEN** the user activates a Recent media row's Play action
- **THEN** Files remains active and the current preview and URL remain unchanged

## ADDED Requirements

### Requirement: A persistent player fits above the existing touch tabs
During audition the compact player SHALL remain operable above the existing Files/Preview/Chat/Terminal tab bar. Its layout SHALL account for device safe areas, rotation, keyboard/viewport changes, and the available height of each surface. It MUST NOT obscure the last reachable file row, Chat composer, or terminal controls. Video SHALL have an expandable presentation. Switching surfaces or UI mode SHALL retain the player session and time without adding a fifth tab or a duplicate player.

#### Scenario: A clip plays while Chat is used
- **WHEN** the user switches from Files to Chat during playback on a phone
- **THEN** the compact controls remain reachable and do not cover the composer
- **AND** the same playback session continues

#### Scenario: The last Recent row is reached
- **WHEN** the player and bottom tabs are visible and the user scrolls to the end of Recent
- **THEN** the last file row and its actions can be fully brought above the player

#### Scenario: A device rotates or changes UI mode
- **WHEN** the device rotates or switches between touch and desktop presentation during playback
- **THEN** controls fit the usable viewport and the active clip retains its time without duplicate playback

#### Scenario: Terminal remains operable
- **WHEN** Terminal is shown with an active compact player
- **THEN** terminal sizing accounts for both the player and existing tabs while retaining the PTY attachment
