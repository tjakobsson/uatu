## ADDED Requirements

### Requirement: Start a local document watch session
The system SHALL provide a `uatu watch [PATH...]` command that accepts zero or more positional directory paths as watched roots. When no paths are provided, the system MUST use the current working directory as the only watched root. Starting the command SHALL launch a local browser UI server and print its URL to standard output.

#### Scenario: No paths defaults to the current directory
- **WHEN** a user runs `uatu watch` with no positional paths
- **THEN** the current working directory is used as the only watched root
- **AND** the local browser URL is printed

#### Scenario: Multiple positional paths become separate watched roots
- **WHEN** a user runs `uatu watch docs notes`
- **THEN** `docs` and `notes` are both registered as watched roots
- **AND** the browser UI shows them as separate root groups

### Requirement: Configure startup browser behavior
The system SHALL attempt to open the browser automatically and SHALL start with follow mode enabled by default. The command MUST provide flags to disable browser auto-open and to disable follow mode before the watch session starts. The local browser URL MUST be printed whether or not the browser is opened successfully.

#### Scenario: Default startup opens the browser with follow enabled
- **WHEN** a user runs `uatu watch docs`
- **THEN** the system attempts to open the browser automatically
- **AND** the watch session starts with follow mode enabled
- **AND** the local browser URL is printed

#### Scenario: Startup flags disable auto-open and follow
- **WHEN** a user runs `uatu watch docs --no-open --no-follow`
- **THEN** the system does not attempt to open the browser
- **AND** the watch session starts with follow mode disabled
- **AND** the local browser URL is printed

### Requirement: Browse supported documents from watched roots
The browser UI SHALL display a sidebar tree grouped by watched root and SHALL list supported documents discovered recursively under each root. In this change, the supported document set is Markdown only. The preview pane SHALL render the currently selected Markdown file. Files that are not supported documents MUST NOT be shown as selectable documents in the sidebar.

#### Scenario: Sidebar groups supported documents by watched root
- **WHEN** watched roots contain nested Markdown files
- **THEN** the sidebar displays those files within the hierarchy of their corresponding watched root
- **AND** unsupported files are not listed as selectable documents

#### Scenario: Selecting a file renders its preview
- **WHEN** a user selects a Markdown file from the sidebar
- **THEN** the preview pane renders that file
- **AND** the active selection updates to the chosen file

### Requirement: Render GitHub-style Markdown in light mode
The preview pane SHALL default to light mode and SHALL render Markdown using GitHub Flavored Markdown-compatible behavior for common GitHub README features. At minimum, the preview MUST support GitHub-style rendering for tables, task lists, strikethrough, autolinks, and fenced code blocks, and the resulting presentation SHALL follow GitHub's light Markdown visual style.

#### Scenario: A Markdown table and task list render with GitHub-style formatting
- **WHEN** a selected Markdown file contains a table and task list items
- **THEN** the preview renders them as formatted HTML elements rather than plain paragraph text
- **AND** the preview uses light-mode GitHub-style Markdown presentation by default

#### Scenario: A GitHub-style autolink renders as a link
- **WHEN** a selected Markdown file contains a supported GitHub Flavored Markdown autolink
- **THEN** the preview renders it as a clickable link

### Requirement: Render Mermaid diagrams from fenced code blocks
The preview pane SHALL detect fenced code blocks whose info string is `mermaid` and SHALL render those blocks as Mermaid diagrams in the browser instead of leaving them as plain code blocks.

#### Scenario: A Mermaid fenced block renders as a diagram
- **WHEN** a selected Markdown file contains a fenced code block with the info string `mermaid`
- **THEN** the preview renders the block as a Mermaid diagram
- **AND** the rendered diagram remains within the document flow of the preview

### Requirement: Keep the indexed view and preview current
The system SHALL detect Markdown file creation, deletion, rename, and modification events under watched roots and update the indexed sidebar view accordingly. When the currently selected Markdown file changes on disk, the preview MUST refresh automatically. The live update channel MUST remain available during normal idle periods without requiring user action or emitting spurious server timeout warnings for expected long-lived connections.

#### Scenario: A new Markdown file appears in the sidebar
- **WHEN** a new Markdown file is created within a watched root
- **THEN** the sidebar updates to include the new file in the correct root and directory grouping

#### Scenario: The active document refreshes after a save
- **WHEN** the currently selected Markdown file is modified on disk
- **THEN** the preview refreshes to show the updated rendered content

#### Scenario: Idle watch periods do not look like failures
- **WHEN** the browser remains connected to the live update channel during a normal idle period with no file changes
- **THEN** the watch session remains available without requiring the user to reconnect
- **AND** the server does not emit a timeout warning for that expected idle connection

### Requirement: Follow the latest changed Markdown file
When follow mode is enabled, the system SHALL switch the active preview to the latest changed Markdown file under the watched roots. Only Markdown file changes are eligible to change the active preview. Manual file selection in the sidebar MUST disable follow mode and pin the selected document until follow mode is enabled again.

#### Scenario: Follow mode switches to the latest changed Markdown file
- **WHEN** follow mode is enabled and a different Markdown file changes under a watched root
- **THEN** that changed Markdown file becomes the active selection
- **AND** the preview updates to render it

#### Scenario: Manual selection disables follow mode
- **WHEN** a user manually selects a Markdown file from the sidebar while follow mode is enabled
- **THEN** follow mode is disabled
- **AND** the selected file remains active until the user re-enables follow mode or selects another file
