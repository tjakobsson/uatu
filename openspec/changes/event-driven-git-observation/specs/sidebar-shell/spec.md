## MODIFIED Requirements

### Requirement: Render bounded commit history in the Git Log pane
The browser UI SHALL render the bounded commit log for the selected or only detected repository in the `Git Log` pane. Each visible commit row MUST show at minimum the short SHA and subject. Each visible commit row SHALL show the commit's age, derived from its commit time. Displayed ages SHALL stay current while the page is open, without new repository data and without refetching repository data. Each visible commit row MUST be a same-origin link to that commit's preview URL so standard browser link affordances are available. If multiple repositories are detected, the pane SHALL make clear which repository each log belongs to or provide a repository grouping/selection. The pane SHALL provide a history-length control for selecting how many commit rows are visible from the bounded data supplied by the server. The `Git Log` pane body SHALL scroll internally when the visible commit rows exceed its allocated height. If no commit log is available, the pane SHALL show an empty or unavailable state instead of failing to render. The Git Log pane is available at all times — it is not gated by Mode.

#### Scenario: Single repository has commits
- **WHEN** the browser receives a commit log for one detected repository
- **THEN** the `Git Log` pane lists recent commits for that repository
- **AND** each row includes the commit short SHA and subject
- **AND** each row links to a commit preview URL containing that repository id and commit sha

#### Scenario: Commit ages stay current
- **WHEN** the `Git Log` pane is visible and no repository change occurs for several minutes
- **THEN** each row's age advances to reflect the elapsed time
- **AND** keeping the ages current does not request repository data from the server

#### Scenario: Commit history length can be changed
- **WHEN** a user selects a different history length in the `Git Log` pane
- **THEN** the pane updates the visible commit rows to that selected limit
- **AND** the selected history length persists across reloads in the same browser for that origin

#### Scenario: Git Log pane scrolls internally
- **WHEN** the visible commit rows exceed the `Git Log` pane height
- **THEN** the `Git Log` pane body scrolls
- **AND** the pane stack remains within the expanded-sidebar height

#### Scenario: Commit click renders full message in preview
- **WHEN** a user clicks a commit row in the `Git Log` pane without a modifier key and without requesting a new browsing context
- **THEN** the main preview renders that commit's full commit message
- **AND** the preview shows the commit's age, derived from its commit time in the same way
- **AND** Follow mode is disabled
- **AND** the browser URL updates to the commit preview URL
- **AND** a new entry is added to the browser history stack
- **AND** no hover-only popover is required to read the full message

#### Scenario: Commit row supports browser link affordances
- **WHEN** a user uses a browser link affordance on a commit row such as copy link, open in new tab, or a modifier-click
- **THEN** the commit row behaves as a normal same-origin link
- **AND** the SPA click interception does not prevent the browser's requested link behavior

#### Scenario: Multiple repositories have commits
- **WHEN** the browser receives commit logs for multiple detected repositories
- **THEN** the `Git Log` pane separates or labels commits by repository
- **AND** the user can tell which repository a commit belongs to

#### Scenario: Commit log is unavailable
- **WHEN** no commit log is available for the watched repository context
- **THEN** the `Git Log` pane displays an empty or unavailable state
- **AND** the rest of the sidebar remains usable
