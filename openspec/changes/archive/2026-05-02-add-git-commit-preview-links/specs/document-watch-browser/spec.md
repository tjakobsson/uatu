## ADDED Requirements

### Requirement: Navigate Git Log commit previews by URL
The browser UI SHALL represent Git Log commit previews with a same-origin URL using the query parameters `repository` and `commit` on the SPA root path. A commit preview URL MUST resolve against the bounded repository commit-log data already present in the current state payload. The browser UI MUST restore a resolvable commit preview on direct-link arrival, refresh, and `popstate`. When the URL references a repository or commit that is not present in the current bounded state payload, the browser UI MUST render a clear empty-preview unavailable state instead of selecting an unrelated document.

#### Scenario: Direct commit preview URL renders the commit message
- **WHEN** a user navigates directly to `/?repository=<repositoryId>&commit=<commitSha>`
- **AND** the current state payload contains that repository and commit in its bounded commit log
- **THEN** the SPA boots with that commit message rendered in the main preview
- **AND** no document is selected in the file tree
- **AND** Follow mode is disabled

#### Scenario: Refreshing a commit preview URL restores the commit preview
- **WHEN** a user has opened a commit preview whose URL contains `repository` and `commit` query parameters
- **AND** the user refreshes the page
- **THEN** the SPA boots and renders the same commit preview again
- **AND** the URL remains the commit preview URL

#### Scenario: Back button restores the previous preview from a commit preview
- **WHEN** a user opens a document preview
- **AND** the user opens a commit preview from the Git Log
- **AND** the user clicks the browser back button
- **THEN** the active preview returns to the previous document
- **AND** the sidebar selection matches that document

#### Scenario: Forward button restores a commit preview
- **WHEN** a user has stepped back from a commit preview to a document preview
- **AND** the user clicks the browser forward button
- **THEN** the active preview returns to the commit preview
- **AND** no document is selected in the file tree

#### Scenario: Commit preview URL references unavailable data
- **WHEN** a user navigates to a commit preview URL whose repository or commit is not present in the current bounded state payload
- **THEN** the SPA renders an empty-preview state explaining that the commit preview is unavailable
- **AND** the sidebar remains usable

#### Scenario: Active commit preview is re-resolved after state refresh
- **WHEN** the active preview is a commit preview
- **AND** the browser receives a refreshed state payload
- **THEN** the browser re-resolves the active repository and commit against the refreshed payload
- **AND** the preview renders the refreshed commit data when the commit is still present
- **AND** the preview renders an unavailable empty state when the commit is no longer present

## MODIFIED Requirements

### Requirement: Render bounded commit history in the Git Log pane
The browser UI SHALL render the bounded commit log for the selected or only detected repository in the `Git Log` pane. Each visible commit row MUST show at minimum the short SHA and subject. Each visible commit row MUST be a same-origin link to that commit's preview URL so standard browser link affordances are available. If multiple repositories are detected, the pane SHALL make clear which repository each log belongs to or provide a repository grouping/selection. The pane SHALL provide a history-length control for selecting how many commit rows are visible from the bounded data supplied by the server. The `Git Log` pane body SHALL scroll internally when the visible commit rows exceed its allocated height. If no commit log is available, the pane SHALL show an empty or unavailable state instead of failing to render.

#### Scenario: Single repository has commits
- **WHEN** the browser receives a commit log for one detected repository
- **THEN** the `Git Log` pane lists recent commits for that repository
- **AND** each row includes the commit short SHA and subject
- **AND** each row links to a commit preview URL containing that repository id and commit sha

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
