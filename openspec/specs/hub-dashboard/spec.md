# hub-dashboard Specification

## Purpose

Define the hub's browser surface: an authenticated dashboard that lists running sessions and stopped workspaces with live shell status, offers stop/resume/forget actions, adds workspaces through a server-side directory browser or by cloning a repository, and follows uatu's visual language — plus the in-session workspace switcher that hub-served sessions expose for navigating between the dashboard and sibling workspaces.

## Requirements

### Requirement: Settings manages Hub credentials and tool readiness
The authenticated `/settings` page SHALL provide a Credentials area that lists credential type, declared purpose, public identifier, lock/readiness state, workspace assignments, and required-tool status. Credential cards SHALL be collapsed by default, retain their expanded state across catalog refreshes, and summarize name, type, enabled state, useful lock state, aggregate readiness, and deduplicated assigned workspace names and count without interactive controls in the summary. Expanded cards SHALL provide generate, import, unlock, lock, disable, test, and delete actions as applicable to each credential type, use masked inputs for every submitted secret, and never redisplay stored private keys or tokens. Assignment management SHALL be workspace-oriented and collapsed by default: workspaces with assignments SHALL list their authentication and signing credentials with role icons and removal controls, while one form SHALL keep a stable layout and allow any registered workspace to receive separate authentication and signing credentials together. The form SHALL state its default-replacement behavior and keep its authentication-host control visible but disabled until an authentication credential is selected. Missing or incompatible tooling SHALL show an actionable explanation, detected path, optional absolute-path override, and Test action. The shared-UID advisory SHALL appear on `/settings` and `/clone`, use one per-user browser dismissal key across both pages, and SHALL NOT require repeated confirmation during assignment. The dashboard SHALL contain sessions and workspaces only, apart from shared chrome, and shared navigation SHALL link Dashboard, Clone, Settings, and sign out.

Removing an assignment from a running workspace SHALL warn that stopping terminates its shells. Disabling or confirming deletion of a provider CLI token SHALL warn that running workspaces still using the token may stop, without claiming that current assignment rows identify which sessions projected it. Confirming SHALL stop the required workspace or workspaces before changing the assignment or provider token catalog; cancelling or a failed stop SHALL leave the catalog unchanged.

Credential create/import forms, each credential card action and assignment area, and each tool override row SHALL have a contextual alert for failures from their own controls. The page-level alert SHALL be reserved for load failures. SSH import SHALL prefer a file upload, retain paste as a secondary option, require exactly one source, reject files larger than 1 MiB before reading them, and clear file and secret inputs after each attempt.

Running and stopped workspace rows SHALL show a neutral summary of assigned authentication and signing credential names, deduplicated by role, or `No credentials assigned` when both roles are empty. Before starting or resuming a stopped workspace with no assignments, the dashboard SHALL use a native confirmation that Git authentication and signing may be unavailable but the workspace can still start. Cancelling MUST NOT start it. The dashboard MUST NOT show this confirmation when any assignment exists and MUST NOT treat assignment presence as credential readiness. If assigned credentials require an unlock, Resume SHALL request their passphrases in a contextual dialog and continue the same start operation after every unlock succeeds. Disabled or otherwise unavailable assigned credentials remain startup errors.

#### Scenario: User tests a configured signing tool
- **WHEN** an authenticated user opens Credentials, configures a signing-tool path, and activates Test
- **THEN** settings reports binary, agent, and signing readiness separately with sanitized diagnostics

#### Scenario: Stored token is never redisplayed
- **WHEN** a user returns to a saved HTTPS/provider credential
- **THEN** settings shows its host, capabilities, state, and assignments
- **AND** no API response or form value contains the saved token

#### Scenario: SSH import validates its source locally
- **WHEN** a user submits both an uploaded key and pasted key, neither source, or an uploaded file larger than 1 MiB
- **THEN** settings reports the error next to the SSH import controls without reading an oversized file or using the page-level error

#### Scenario: User resumes a workspace without credential assignments
- **WHEN** a stopped workspace has no authentication or signing assignments and the user activates Resume
- **THEN** the dashboard asks whether to continue without assigned Git authentication or signing
- **AND** cancelling leaves the workspace stopped while continuing uses the normal start operation

#### Scenario: Assigned credential is not treated as missing
- **WHEN** a stopped workspace has any credential assignment whose credential is locked, disabled, or unavailable
- **THEN** the dashboard does not show the no-assignment confirmation
- **AND** a locked credential opens a masked unlock dialog that resumes the workspace after successful unlock
- **AND** backend startup validation reports a disabled or otherwise unavailable credential

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

### Requirement: Dashboard can stop a running session
The dashboard SHALL offer a stop action per running session that terminates the session's server after an explicit confirmation naming the workspace, since stopping terminates that session's shells. A stop that races an in-flight session start SHALL await the start and then terminate the child, so no session can come alive after its stop was reported.

#### Scenario: Stop requires confirmation
- **WHEN** the user activates stop on a running session and confirms
- **THEN** the session's child process is terminated and the workspace moves to the stopped list

### Requirement: Dashboard can forget a stopped workspace
The dashboard SHALL offer a forget action on stopped workspaces that removes the registration only: the folder on disk MUST NOT be touched and SHALL reappear in the directory browser as an unregistered folder. The hub SHALL reject forgetting a workspace whose session is running or still starting, so a forget can never race an in-flight spawn into a live child that the dashboard no longer knows about.

#### Scenario: Forgetting returns the folder to the browser
- **WHEN** the user forgets a stopped workspace
- **THEN** the workspace disappears from the registered list and its folder shows as unregistered when browsed to

#### Scenario: A running or starting session cannot be forgotten
- **WHEN** a forget request names a workspace whose session is running or whose start is still in flight
- **THEN** the hub rejects it and the registration is unchanged

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
- **WHEN** the user adds a non-git folder and declines initialization
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
- **THEN** the prompt appears in the clone output and the user can submit each requested value through the response input
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

### Requirement: The workspace switcher chip reflects real session state
The in-session workspace switcher's collapsed chip SHALL show the current workspace's live indicator from hub-reported state, never from an assumption that the viewed session is running: a session page can outlive its server (a stop from the dashboard, a back/forward-cache restore). The chip SHALL update from fresh hub state on page-cache restores and whenever the menu's state refresh completes, so chip and menu can never disagree.

#### Scenario: A cached page of a stopped session shows a truthful chip
- **WHEN** the user stops a session from the dashboard and returns to its page via browser history
- **THEN** the switcher chip's indicator shows not-running
- **AND** opening the menu shows the same state

### Requirement: Dashboard and login follow uatu's visual language
The hub's pages (login, dashboard, session-unavailable) SHALL use uatu's design system, not an ad-hoc theme: the same brand header (inline logo with its dark-scheme retint, wordmark typography), `color-scheme: light dark` with the app's `light-dark()` token palette so both schemes render correctly, the app's sans-serif body font with monospace reserved for paths and code, pane-style section headers, and the app's indicator-dot idiom for live/running state. Fixed single-scheme palettes MUST NOT be used.

#### Scenario: Both color schemes render correctly
- **WHEN** the dashboard is viewed under a light system scheme and under a dark system scheme
- **THEN** surfaces, text, and borders adapt via the token palette in both, with no illegible fixed-scheme colors

#### Scenario: The dashboard reads as uatu
- **WHEN** a user familiar with the uatu SPA opens the dashboard
- **THEN** the brand header, section headers, typography, and running-state indicators follow the same visual idioms as the SPA's sidebar chrome

### Requirement: Hub pages respect the desktop titlebar inset
When served inside UatuCode Desktop's full-height WebView — the wrapper sets a `--titlebar-inset` custom property on the document root for the strip covered by the transparent titlebar and native tab bar — the hub's pages (login, dashboard, stopped-session) SHALL pad their content below the covered strip so nothing renders beneath the native chrome. In a plain browser, where the property is unset, the pages SHALL render unchanged.

#### Scenario: Dashboard clears the native tab bar
- **WHEN** the dashboard loads in the desktop WebView with a native tab bar showing
- **THEN** the page's header content starts below the covered strip instead of rendering behind it

### Requirement: Slow dashboard actions signal progress
Dashboard actions that wait on the hub — resuming/starting a session, stopping one, adding a folder, cloning — SHALL disable their control and show an in-progress label until the action settles, so a multi-second session start reads as working rather than dead. When an action ends in navigation into a session, the dashboard SHALL additionally show a full-page opening indicator from the moment navigation begins until the session page replaces it — the session's SPA takes time to load after the start API answers, and that gap MUST NOT read as a return to idle.

#### Scenario: Resume shows progress while the session starts
- **WHEN** the user activates resume and the session takes several seconds to start
- **THEN** the control is disabled and labeled as starting, and it MUST NOT revert to its idle label before the page navigates away (only an error restores it)
- **AND** a full-page opening indicator covers the dashboard from navigation start until the session renders

#### Scenario: Returning to the dashboard clears the indicator
- **WHEN** the user navigates back to the dashboard from a session (a page-cache restore)
- **THEN** no opening indicator remains and the action controls render in their idle state

### Requirement: Authenticated surfaces show the hub version
The hub's state API SHALL include the hub's uatu version, and the dashboard SHALL display it to signed-in users (e.g. in the brand header or footer). The version MUST NOT be disclosed on the login page or any other unauthenticated response.

#### Scenario: Signed-in user sees the version
- **WHEN** an authenticated user opens the dashboard
- **THEN** the page shows the hub's uatu version
- **AND** the state API payload carries the same version string

#### Scenario: Login page stays version-silent
- **WHEN** an unauthenticated browser loads the login page
- **THEN** the response contains no uatu version string

### Requirement: Hub pages are installable as a web app
The hub SHALL serve a web-app manifest at its origin (`/manifest.webmanifest`) declaring `name`/`short_name` branding for the hub, `display: "standalone"`, `start_url: "/"`, `scope: "/"`, and 192x192 plus 512x512 PNG icons, and the login and dashboard pages SHALL link it from `<head>`. The manifest and its icons SHALL be served without authentication, since install-time fetches may be anonymous and the manifest carries only branding. An app installed from a hub page SHALL keep the entire hub origin — login, dashboard, and every `/s/<id>/` session — inside its scope so no in-app browser chrome appears while navigating between them.

#### Scenario: Hub manifest is reachable without a session
- **WHEN** an unauthenticated client requests `/manifest.webmanifest`
- **THEN** the response is 200 with `Content-Type: application/manifest+json`
- **AND** the JSON declares `scope: "/"`, `start_url: "/"`, and `display: "standalone"`

#### Scenario: Login and dashboard pages link the manifest
- **WHEN** a client requests `/login` or `/`
- **THEN** the returned HTML contains a `<link rel="manifest">` referencing `/manifest.webmanifest` inside `<head>`

#### Scenario: Installed hub app stays standalone across sign-in
- **WHEN** a user installs the hub from the dashboard on iOS, later launches it signed out, signs in, and opens a workspace session
- **THEN** every page in that flow renders standalone, with no in-app browser bars

### Requirement: Dashboard lists and revokes device sessions
The dashboard SHALL show the signed-in user's active sessions — device label, issue time, and which one is the current session — and SHALL offer a revoke action per session. Revoking SHALL take effect server-side immediately for every transport; revoking the current session behaves as sign-out. Revocation SHALL be a POST guarded like other state-changing endpoints.

#### Scenario: Another device's session is revoked
- **WHEN** a user revokes a listed session belonging to another device
- **THEN** that device's next request is treated as unauthenticated
- **AND** the current browser session remains signed in

#### Scenario: The current session is marked
- **WHEN** the sessions list renders
- **THEN** the session serving the request is visibly identified as the current one

#### Scenario: Revoking the current session signs out
- **WHEN** a user revokes the session marked as current
- **THEN** the response clears the cookie and lands on the login page

### Requirement: Directory browser manages folders
The authenticated Hub directory browser SHALL let users create an empty child folder in the currently browsed directory, rename a listed child folder, and remove a listed child folder only when it is empty. These actions SHALL be available for both unregistered folders and registered workspaces. Folder names MUST be non-empty visible single path segments; path separators, dot segments, NUL, and names beginning with `.` MUST be rejected. The browser SHALL refresh the affected listing after a successful mutation and SHALL show an actionable error without navigating away when a mutation fails.

#### Scenario: Create an empty folder
- **WHEN** a user enters a valid unused name while browsing a writable directory
- **THEN** the Hub creates that directory as an immediate child
- **AND** the refreshed browser lists the new folder

#### Scenario: Invalid or colliding name is rejected
- **WHEN** a user attempts to create or rename a folder with an invalid name or a name already used in the destination directory
- **THEN** the Hub rejects the mutation without replacing or changing any existing folder
- **AND** the browser explains the conflict

#### Scenario: Rename an unregistered folder
- **WHEN** a user renames an unregistered folder to a valid unused sibling name
- **THEN** the folder and all of its contents move to the new path
- **AND** the browser remains in the containing directory and shows the new name

#### Scenario: Remove an empty folder
- **WHEN** a user confirms removal of an empty folder
- **THEN** the folder is removed and disappears from the refreshed listing

#### Scenario: Non-empty removal is rejected
- **WHEN** a user attempts to remove a folder containing any entry, including a hidden entry
- **THEN** the Hub leaves the folder and its contents unchanged
- **AND** the browser reports that only empty folders can be removed

### Requirement: Registered folder mutations offer coordinated session stopping
When rename or removal affects one or more registered workspaces, the browser SHALL preserve workspace registration semantics rather than treating the folders as unrelated filesystem entries. If every affected workspace is stopped, the action SHALL proceed without an additional session-stop prompt. If any affected workspace is running or starting, the browser SHALL identify the affected workspaces and offer to stop them and continue. Confirming MUST stop all affected sessions, including any start already in flight, before mutating the folder; declining MUST leave sessions, folders, and registrations unchanged. The control SHALL remain disabled with an in-progress label while stopping and mutation are underway.

#### Scenario: Rename a stopped registered workspace
- **WHEN** a user renames a registered workspace whose session is stopped
- **THEN** the folder is renamed while its stable workspace id and `/s/<id>/` URL remain unchanged
- **AND** the dashboard reports the new path for that workspace

#### Scenario: User confirms stop and rename
- **WHEN** a rename affects a running registered workspace and the user confirms the offered stop-and-continue action
- **THEN** the Hub terminates the workspace session and its shells before renaming the folder
- **AND** the workspace remains registered under its existing id at the new path

#### Scenario: User declines session stopping
- **WHEN** a folder mutation would affect a running or starting workspace and the user declines the offered stop
- **THEN** no affected session is stopped
- **AND** no folder or registration is changed

#### Scenario: Rename affects nested registered workspaces
- **WHEN** a renamed folder contains multiple registered workspace descendants
- **THEN** the stop offer names every running or starting affected workspace
- **AND** after all affected workspaces are stopped, every registration keeps its id and points to the corresponding path beneath the renamed folder

#### Scenario: Remove an empty registered workspace
- **WHEN** a user removes an empty registered workspace folder after any active session has been stopped
- **THEN** the folder and its workspace registration are removed
- **AND** associated personal workspace state and credential assignments are removed

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
