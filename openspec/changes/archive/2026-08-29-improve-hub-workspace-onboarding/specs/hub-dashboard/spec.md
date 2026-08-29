## ADDED Requirements

### Requirement: Dashboard configures a workspace before first start
Selecting an unregistered Git repository in the directory browser SHALL open an Add workspace form instead of registering or starting it immediately. The form SHALL show the canonical folder path, prefill an editable workspace display name from the folder basename, allow separate compatible authentication and signing credential selections, and offer Add workspace as the primary action plus Add and start as an explicit alternative. Add workspace SHALL finish with a stopped registered workspace. Cancelling SHALL leave the folder, registry, credentials, and sessions unchanged.

#### Scenario: Existing repository is added stopped
- **WHEN** a user selects an unregistered Git repository, accepts the default display name, optionally selects credentials, and activates Add workspace
- **THEN** the Hub registers the workspace and its selected assignments without starting a session
- **AND** the dashboard shows it in the stopped workspace list ready to Start

#### Scenario: User explicitly adds and starts
- **WHEN** the same user activates Add and start
- **THEN** the Hub commits the workspace configuration before starting its session
- **AND** startup uses the selected credential assignments

#### Scenario: Add is cancelled
- **WHEN** the user closes or cancels the Add workspace form
- **THEN** no registration, assignment, filesystem, or session mutation occurs

### Requirement: Dashboard creates a new stopped workspace
The dashboard SHALL provide a Create workspace flow with a workspace display name, a visible single-segment folder name, an absolute parent directory defaulted from Hub Settings, and optional authentication and signing credentials. On success the Hub SHALL create the child folder, initialize an empty Git repository, register the workspace with its chosen display name and assignments, and leave it stopped. Existing destinations, invalid names, unavailable parents, Git initialization failures, and configuration persistence failures SHALL produce actionable errors without starting a session or silently adopting an existing folder.

#### Scenario: New workspace is created under the default parent
- **WHEN** a user accepts the configured default parent, enters workspace and folder names, selects credentials, and confirms creation
- **THEN** the Hub creates and initializes the child repository
- **AND** it appears as a stopped workspace with the selected display name and assignments

#### Scenario: Workspace and folder names differ
- **WHEN** a user enters display name `Payments API` and folder name `payments-service`
- **THEN** the workspace is shown as `Payments API`
- **AND** its source path ends in `payments-service`

#### Scenario: Destination already exists
- **WHEN** the requested child folder already names any filesystem entry
- **THEN** creation fails without registering, starting, replacing, or modifying that entry

### Requirement: Settings manages the default workspace parent
Hub Settings SHALL let an authenticated user configure or clear one absolute default workspace parent directory. The setting SHALL be validated as an existing direct directory before it is saved. Create, clone, and directory-browser flows SHALL initially open at that directory when configured and readable, otherwise they SHALL fall back to the daemon user's home with an explanation. The default SHALL remain a convenience only: users MAY browse and register folders elsewhere, and clearing it SHALL restore the home-directory default.

#### Scenario: Default parent is used by onboarding
- **WHEN** `/srv/workspaces` is configured and a user opens Create workspace or Clone
- **THEN** the parent or browser starts at `/srv/workspaces`
- **AND** the user can still navigate elsewhere

#### Scenario: Configured parent becomes unavailable
- **WHEN** the saved default parent no longer exists or cannot be read
- **THEN** onboarding falls back to the daemon user's home
- **AND** the page explains that the configured default is unavailable

#### Scenario: Invalid parent is not saved
- **WHEN** a user submits a relative path, missing path, file, or symbolic-link directory as the default parent
- **THEN** Settings rejects it and preserves the previous value

### Requirement: Workspace and filesystem actions use distinct language
Workspace rows and directory rows SHALL distinguish Rename workspace, Rename folder, Remove from Hub, and Remove folder. Rename workspace SHALL be available while stopped or running and SHALL change only the workspace display name. Rename folder SHALL retain the existing coordinated filesystem behavior and stable URL id. Remove from Hub SHALL preserve the folder, while Remove folder SHALL retain its empty-directory restriction. A stopped registered directory SHALL offer Start rather than Open; a running workspace SHALL offer Open.

#### Scenario: Running workspace display name is changed
- **WHEN** a user renames a running workspace from `API` to `Payments API`
- **THEN** Hub-owned workspace lists and navigation show `Payments API`
- **AND** its session, folder path, stable id, and URL remain unchanged

#### Scenario: Stopped registered folder is selected
- **WHEN** the directory browser lists a registered workspace with no running session
- **THEN** its primary action is Start
- **AND** activating it uses the normal credential-aware start flow rather than navigating to an unavailable session

## MODIFIED Requirements

### Requirement: Dashboard lists sessions and workspaces with live status
The hub SHALL serve an authenticated dashboard listing running sessions and stopped registered workspaces. Every row SHALL use the mutable workspace display name as its title and show the source path as secondary text; stable ids MAY appear as advanced URL details but MUST NOT be the primary label. Each running session SHALL show a live shell summary sourced from the child's terminal session inventory (shell count, attached/detached, best-effort foreground-process label); each stopped workspace SHALL offer Start. Activating Open for a running session SHALL navigate to its `/s/<id>/` URL. The dashboard SHALL be served under the hub origin so it shares the PWA installation with the sessions it links to.

#### Scenario: Running session shows live shell detail
- **WHEN** a session has two shells, one running a long-lived TUI, and the user opens the dashboard
- **THEN** the session's row reports the shells and the foreground-process label under its workspace display name

#### Scenario: Jump into a session
- **WHEN** the user activates Open on a running session's entry
- **THEN** the browser navigates to that session's stable `/s/<id>/` URL and the SPA loads

#### Scenario: Resume a stopped workspace
- **WHEN** the user activates Start on a stopped workspace
- **THEN** the hub starts a session for it via the workspace's backend and the entry becomes running

### Requirement: Clone page adds folders through a server-side directory browser
The authenticated `/clone` page SHALL offer workspace registration by browsing the hub host's filesystem, not by typing source paths: the hub SHALL expose a directory-listing API that starts from the configured default workspace parent when available and otherwise the daemon user's home, and returns a directory's parent and child directories with name, Git status, registration identity, and running state. It SHALL list directories only and hide dot-directories. Selecting an unregistered repository SHALL open the Add workspace configuration flow. Selecting a registered stopped workspace SHALL offer Start; selecting a running workspace SHALL offer Open.

Adding a non-Git folder as a workspace SHALL require explicit Git initialization confirmation before registration. The clone page SHALL additionally offer `git clone <url>` with a browsed destination directory, an optional visible single-segment checkout folder name defaulting from the remote, an independently editable workspace display name defaulting from that folder, optional compatible clone authentication, optional retained workspace authentication and signing assignments, and an explicit Start after clone choice that defaults off. Clone MUST NOT inherit an ambient external SSH agent, automatically fall back to an unselected stored credential, persist interactively supplied credentials, or pass `--force` to the server. The local-backend warning SHALL make clear that same-UID processes can bypass normal tool configuration.

#### Scenario: Browsing to and adding a folder
- **WHEN** the user selects a Git repository folder and completes Add workspace
- **THEN** the Hub registers it stopped with a stable id, display name, and chosen assignments

#### Scenario: Registered folders are marked while browsing
- **WHEN** the directory browser lists a registered workspace
- **THEN** it offers Start when stopped and Open when running rather than offering Add

#### Scenario: Non-git folder is initialized and served
- **WHEN** the user selects a non-Git folder, confirms initialization, and completes Add workspace
- **THEN** the Hub runs `git init`, records the workspace configuration, and leaves it stopped unless Add and start was explicitly selected

#### Scenario: Declined initialization leaves no trace
- **WHEN** the user declines initialization for a non-Git folder
- **THEN** no session starts and the folder is not added to the registry

#### Scenario: Clone into a browsed destination
- **WHEN** the user submits a repository URL, chooses checkout and workspace names, selects compatible credentials, and leaves Start after clone off
- **THEN** the Hub clones into the selected child folder and registers the result stopped with those assignments

#### Scenario: Clone with a custom checkout folder
- **WHEN** the user submits a valid custom checkout folder name
- **THEN** the Hub clones into that folder independently of the workspace display name
- **AND** path-like names and dot segments are rejected before a clone job starts

#### Scenario: Already-loaded SSH key is used without prompting
- **WHEN** the clone URL uses SSH and the selected clone credential is unlocked and usable
- **THEN** the clone uses the Hub-managed agent and completes without asking for the key passphrase again

#### Scenario: Failed clone or init is reported
- **WHEN** `git clone` or `git init` exits non-zero
- **THEN** the clone page shows the Git error output and no workspace is registered

### Requirement: Clone page handles interactive clone progress
The authenticated `/clone` page SHALL show live terminal output and current phase for an in-progress clone and SHALL provide an always-available masked response input that writes one response to the clone terminal without displaying or retaining the submitted value. Recognizing a common credential, trust, or verification prompt MAY focus or label the response input, but unrecognized terminal prompts MUST remain answerable. The clone page SHALL provide cancellation while the clone is active and SHALL report cancellation, timeout, clone failure, registration failure, optional session-start failure, and successful completion distinctly. Successful clone and registration SHALL finish on the stopped workspace unless Start after clone was selected; only a successful requested start SHALL navigate into the workspace session. Once a clone reaches any terminal outcome, prompt input and cancellation controls SHALL no longer appear active, while failure output remains visible and the clone form is available for retry. Unlocking a selected stored credential SHALL use the credential operation's masked secret path; responses entered into the clone PTY SHALL remain one-operation inputs and MUST NOT silently create or update a stored credential.

#### Scenario: Selected credential requires unlock
- **WHEN** a selected stored credential is locked when the user submits a clone
- **THEN** the clone page requests an unlock through the credential flow before starting Git
- **AND** the passphrase is not written to clone output or retained as clone input

#### Scenario: SSH passphrase is answered on the clone page
- **WHEN** an SSH clone with no selected stored credential prompts for a private-key passphrase
- **THEN** the prompt appears in clone output and the user can submit the passphrase through the masked response input
- **AND** the submitted passphrase is neither displayed nor added to the Hub credential catalog

#### Scenario: HTTPS credentials are answered on the clone page
- **WHEN** an HTTPS remote with no selected stored credential requests a username, password, or token
- **THEN** the prompt appears in clone output and the user can submit each requested value through the response input
- **AND** the submitted values are not stored automatically

#### Scenario: Unrecognized prompt remains answerable
- **WHEN** Git or SSH emits an interactive prompt the clone page does not recognize
- **THEN** the user can still read it in the streamed output and submit a response

#### Scenario: User cancels a clone
- **WHEN** the user activates cancel while a clone is running or waiting for input
- **THEN** the clone terminates, the clone page reports it as cancelled, and no workspace is registered

#### Scenario: Clone fails and can be retried
- **WHEN** the clone reaches a failure or timeout
- **THEN** its output and terminal status remain visible
- **AND** prompt input and cancellation are hidden while the clone form is available for retry

#### Scenario: Clone succeeds without requested start
- **WHEN** the user completes an interactive clone with Start after clone off
- **THEN** the clone page reports that the workspace was added and provides Start and return-to-dashboard actions

#### Scenario: Clone succeeds after interaction
- **WHEN** the clone, registration, assignment, and requested session start all succeed
- **THEN** the clone page reports completion and navigates to the workspace's stable session URL

### Requirement: Hub-served sessions expose hub navigation
When the SPA is served through a hub (a hub-session-shaped base path AND the hub API answering at the origin root), the sidebar header SHALL show a workspace switcher naming the current workspace by its display name, whose menu links to the hub dashboard and to every registered workspace by display name with running or stopped state and offers a sign-out entry. Duplicate display names SHALL be disambiguated with path or stable-id detail. Outside a hub, including plain `uatu serve` and a bare `--base-path` invocation, the affordance MUST stay hidden. The hub's brand header SHALL show the logo centered with the wordmark beneath it and no tagline.

#### Scenario: Switching workspaces from inside a session
- **WHEN** a user inside a hub-served session opens the workspace switcher
- **THEN** they see the dashboard and sibling workspaces by display name with running or stopped state
- **AND** activating a running workspace navigates to its stable session URL while a stopped workspace offers Start

#### Scenario: Duplicate names are distinguishable
- **WHEN** two registered workspaces share one display name
- **THEN** the switcher provides path or stable-id detail that distinguishes them without requiring names to be unique

#### Scenario: No hub affordance outside a hub
- **WHEN** the SPA runs under plain `uatu serve` or under a base path with no hub answering at the origin root
- **THEN** the workspace switcher is not shown
