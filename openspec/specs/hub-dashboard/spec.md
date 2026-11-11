# hub-dashboard Specification

## Purpose

Define the hub's browser surface: an authenticated dashboard that lists running sessions and stopped workspaces with live shell status, offers stop/resume/forget actions, adds workspaces through a server-side directory browser or by cloning a repository, and follows uatu's visual language — plus the in-session workspace switcher that hub-served sessions expose for navigating between the dashboard and sibling workspaces.

## Requirements

### Requirement: Settings manages Hub credentials and tool readiness
The authenticated `/settings` page SHALL manage credential identity, readiness, assignments, secret-safe actions, and tool configuration. Workspace start and credential changes SHALL preserve contextual feedback, explicit confirmation, and credential readiness boundaries.

#### Scenario: Credentials are browsed and expanded
- **WHEN** an authenticated user opens the Credentials area on `/settings`
- **THEN** it SHALL list credential type, declared purpose, public identifier, lock/readiness state, workspace assignments, and required-tool status
- **AND** cards SHALL be collapsed by default, retain expansion across catalog refreshes, and summarize name, type, enabled state, useful lock state, aggregate readiness, and deduplicated assigned workspace names and count without interactive summary controls
- **WHEN** a card is expanded
- **THEN** it SHALL provide generate, import, unlock, lock, disable, test, and delete actions as applicable to its type, mask every submitted secret, and never redisplay stored private keys or tokens

#### Scenario: Workspace assignments and tools are configured
- **WHEN** `/settings` displays assignment management
- **THEN** it SHALL be workspace-oriented and collapsed by default, with assigned workspaces listing authentication and signing credentials, role icons, and removal controls
- **AND** one stable-layout form SHALL let any registered workspace receive separate authentication and signing credentials together, state default-replacement behavior, and keep the authentication-host control visible but disabled until authentication is selected
- **WHEN** tooling is missing or incompatible
- **THEN** it SHALL show an actionable explanation, detected path, optional absolute-path override, and Test action

#### Scenario: Shared navigation and UID advice remain consistent
- **WHEN** `/settings` or `/clone` is shown
- **THEN** the shared-UID advisory SHALL appear, use one per-user browser dismissal key across both pages, and SHALL NOT require repeated confirmation during assignment

#### Scenario: Shared navigation and dashboard contents are rendered
- **WHEN** a Hub page displays shared navigation
- **THEN** it SHALL link Dashboard, Clone, Settings, and sign out
- **WHEN** the dashboard is displayed
- **THEN** it SHALL contain sessions and workspaces only, apart from shared chrome

#### Scenario: Credential changes require stopping affected activity
- **WHEN** an assignment is removed from a running workspace
- **THEN** the warning SHALL say stopping terminates its shells
- **WHEN** a provider CLI token is disabled or its deletion is confirmed
- **THEN** the warning SHALL say running workspaces still using it may stop, without claiming current assignment rows identify which sessions projected it
- **WHEN** either an assignment-removal or token-change stop confirmation is accepted
- **THEN** confirmation SHALL stop required workspaces before changing the assignment or token catalog
- **WHEN** either confirmation is cancelled or a required stop fails
- **THEN** the catalog SHALL remain unchanged

#### Scenario: Credential failures and SSH import stay local and secret-safe
- **WHEN** a create/import form, card action, assignment area, or tool override row fails
- **THEN** its own controls SHALL have a contextual alert; the page-level alert SHALL be reserved for load failures
- **WHEN** SSH keys are imported
- **THEN** file upload SHALL be preferred, paste SHALL remain secondary, exactly one source SHALL be required, files larger than 1 MiB SHALL be rejected before reading, and file and secret inputs SHALL clear after each attempt

#### Scenario: Workspace credential summaries govern start confirmation and unlock
- **WHEN** running or stopped workspace rows are displayed
- **THEN** they SHALL show neutral assigned authentication and signing credential names deduplicated by role, or `No credentials assigned` if both roles are empty
- **WHEN** a stopped workspace with no assignments is started or resumed
- **THEN** a native confirmation SHALL explain Git authentication and signing may be unavailable but start is possible; cancellation MUST NOT start it
- **WHEN** any assignment exists
- **THEN** the dashboard MUST NOT show that confirmation or treat assignment presence as readiness
- **AND** Resume SHALL request required passphrases in a contextual dialog and continue the same start after every unlock succeeds; disabled or otherwise unavailable credentials remain startup errors

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
The hub SHALL serve an authenticated dashboard listing running sessions and stopped registered workspaces, with live shell status and explicit Open or Start actions under the hub origin.

#### Scenario: Dashboard rows identify workspaces and shell state
- **WHEN** the authenticated dashboard renders its rows
- **THEN** every row SHALL use the mutable workspace display name as title and source path as secondary text; stable ids MAY appear as advanced URL details but MUST NOT be the primary label
- **AND** running rows SHALL show shell count, attached/detached state and best-effort foreground-process label from the child's terminal session inventory; stopped rows SHALL offer Start
- **AND** Open SHALL navigate to `/s/<id>/`, and the dashboard SHALL share the hub origin and PWA installation with its linked sessions

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
The authenticated `/clone` page SHALL register workspaces through server-side directory browsing or explicit cloning, with separate checkout and workspace naming, compatible credentials, and opt-in startup. Non-Git registration SHALL require Git initialization confirmation.

#### Scenario: Directory browsing exposes registration-aware choices
- **WHEN** an authenticated user opens `/clone`
- **THEN** the page SHALL offer registration by browsing the hub host's filesystem, not typing source paths, and the hub SHALL expose a directory-listing API
- **AND** that API SHALL start at the available configured default workspace parent, otherwise the daemon user's home, and return parent and child directories with name, Git status, registration identity, and running state
- **AND** it SHALL list directories only, hiding dot-directories
- **AND** an unregistered repository SHALL open Add workspace, a registered stopped workspace SHALL offer Start, and a running one SHALL offer Open
- **AND** adding a non-Git folder SHALL require explicit Git initialization confirmation before registration

#### Scenario: Clone options preserve explicit credential and startup intent
- **WHEN** the user prepares `git clone <url>`
- **THEN** the page SHALL offer a browsed destination, optional visible single-segment checkout folder defaulted from the remote, independently editable workspace display name defaulted from that folder, optional compatible clone authentication, optional retained workspace authentication/signing assignments, and Start after clone defaulting off
- **AND** clone MUST NOT inherit an ambient external SSH agent, fall back automatically to unselected stored credentials, persist interactive credentials, or pass `--force` to the server
- **AND** the local-backend warning SHALL explain same-UID processes can bypass normal tool configuration

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
The authenticated `/clone` page SHALL stream clone output and phase, support masked interactive responses and cancellation, and distinguish terminal outcomes. Credentials and optional session startup SHALL remain explicit.

#### Scenario: Clone prompts can be answered without storing secrets
- **WHEN** a clone is in progress
- **THEN** live terminal output and current phase SHALL be shown with an always-available masked input that writes one response without displaying or retaining it
- **AND** recognized credential, trust, or verification prompts MAY focus or label that input, but unrecognized prompts MUST remain answerable

#### Scenario: Stored clone credentials unlock through their masked secret path
- **WHEN** a selected stored credential is unlocked for cloning, including before the clone starts
- **THEN** unlocking SHALL use the credential operation's masked secret path

#### Scenario: Every clone PTY response remains a one-operation input
- **WHEN** a response is entered into the clone PTY
- **THEN** it SHALL remain a one-operation input and MUST NOT silently create or update a stored credential

#### Scenario: Clone terminal outcomes settle controls and navigation
- **WHEN** a clone is active or reaches a terminal outcome
- **THEN** cancellation SHALL be available while active, and cancellation, timeout, clone failure, registration failure, optional session-start failure, and completion SHALL be reported distinctly
- **AND** successful clone/registration SHALL leave the workspace stopped unless Start after clone was selected; only successful requested start SHALL navigate into its session
- **AND** at any terminal outcome prompt and cancellation controls SHALL no longer appear active, failure output SHALL remain visible, and the form SHALL allow retry

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
Hub-served sessions SHALL expose a sidebar workspace switcher for dashboard, workspace, and sign-out navigation. Ordinary same-tab activation of the current running workspace SHALL preserve the page and terminal connections; outside a hub the switcher MUST stay hidden. The hub's brand header SHALL show the logo centered with the wordmark beneath it and no tagline.

#### Scenario: Hub context exposes named navigation
- **WHEN** a hub-session-shaped base path and answering hub API at the origin root establish hub serving
- **THEN** the sidebar header SHALL name the current workspace by display name and link the dashboard and every registered workspace by display name and running/stopped state, with sign out
- **AND** duplicate names SHALL be disambiguated by path or stable-id detail

#### Scenario: Current workspace navigation respects browser intent
- **WHEN** the current running workspace is activated for ordinary same-tab navigation
- **THEN** its menu SHALL dismiss without navigation, document URL change, or terminal interruption
- **WHEN** explicit browser gestures open it in another tab/window
- **THEN** normal link behavior SHALL remain

#### Scenario: A stopped current workspace retains recovery navigation
- **WHEN** the current workspace is stopped
- **THEN** it SHALL retain Start and in-place recovery

#### Scenario: A page has no Hub serving context
- **WHEN** the page is outside a hub, including a source-run child at the default path or bare `--base-path`
- **THEN** the switcher MUST remain hidden

#### Scenario: Switching workspaces from inside a session
- **WHEN** a user inside a hub-served session opens the workspace switcher
- **THEN** they see the dashboard and sibling workspaces by display name with running or stopped state
- **AND** activating another running workspace navigates to its stable session URL while a stopped workspace offers Start

#### Scenario: Selecting the current running workspace
- **WHEN** the user clicks or keyboard-activates the current running workspace's entry for same-tab navigation
- **THEN** the menu closes and the current page and document URL remain unchanged
- **AND** open terminals retain their panes, connections, and shell processes without showing a takeover action

#### Scenario: Opening the current workspace in another tab
- **WHEN** the user explicitly opens the current running workspace's link in a new tab or window using browser link gestures
- **THEN** the browser opens the workspace there normally
- **AND** the original page and its terminal connections remain intact

#### Scenario: Starting the current stopped workspace
- **WHEN** the current workspace is stopped and the user activates its Start action
- **THEN** the Hub starts that workspace and the current page recovers in place
- **AND** the current-workspace no-navigation behavior does not suppress the Start request

#### Scenario: Duplicate names are distinguishable
- **WHEN** two registered workspaces share one display name
- **THEN** the switcher provides path or stable-id detail that distinguishes them without requiring names to be unique

#### Scenario: No hub affordance outside a hub
- **WHEN** the SPA runs under a source-run session child or under a base path with no hub answering at the origin root
- **THEN** the workspace switcher is not shown

### Requirement: The workspace switcher chip reflects real session state
The workspace switcher chip, open menu, and shell connection indicator SHALL consistently reflect authoritative hub session state. Starting the current stopped workspace SHALL recover in place without navigation.

#### Scenario: Hub updates and cached-page restores refresh all session indicators
- **WHEN** workspace state changes, a page-cache restore occurs, or a menu state refresh completes
- **THEN** the chip and open menu SHALL update from the brokered activity topic as workspace state changes and from fresh hub state on restores and completed menu refreshes so they cannot disagree
- **AND** the chip SHALL use hub-reported state, never assume a viewed session is running even after dashboard stop or back/forward-cache restore
- **AND** the shell connection indicator SHALL derive stopped state from that same hub report
- **WHEN** the current workspace is stopped
- **THEN** its menu entry SHALL offer Start like other stopped workspaces and successful Start SHALL leave the page to recover from the stream without navigating

#### Scenario: A cached page of a stopped session shows a truthful chip
- **WHEN** the user stops a session from the dashboard and returns to its page via browser history
- **THEN** the switcher chip's indicator shows not-running
- **AND** opening the menu shows the same state

#### Scenario: A stop elsewhere updates the chip without a refresh
- **WHEN** the viewed workspace's session is stopped from another device while its page is open
- **THEN** the chip's indicator turns not-running from the stream update, without the menu being opened or the page reloaded

#### Scenario: The current workspace's row starts its stopped session
- **WHEN** the user opens the switcher menu on a page whose session is stopped and activates the current workspace's entry
- **THEN** the hub is asked to start that session and the entry shows it starting
- **AND** the page is not navigated away; the chip's indicator and the connection indicator turn live once the started session's state arrives

#### Scenario: Chip and indicator agree
- **WHEN** the hub reports the current workspace's session not running
- **THEN** the switcher chip shows not-running and the connection indicator reads `Stopped`
- **AND** neither claims the session is running while the other says it is stopped

### Requirement: Dashboard and login follow uatu's visual language
The hub's login, dashboard, and session-unavailable pages SHALL use uatu's design system and adapt to light and dark schemes. Fixed single-scheme palettes MUST NOT be used.

#### Scenario: Hub page chrome uses shared design primitives
- **WHEN** login, dashboard, or session-unavailable is rendered
- **THEN** it SHALL use the shared inline-logo brand header with dark-scheme retint and wordmark typography, `color-scheme: light dark`, and the app's `light-dark()` token palette
- **AND** it SHALL use the app's sans-serif body font, monospace only for paths/code, pane-style section headers, and indicator dots for live/running state rather than an ad-hoc theme

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
Dashboard actions waiting on the hub SHALL disable their controls and show progress until settled. Session navigation SHALL retain a full-page opening indication until the destination replaces the dashboard.

#### Scenario: Hub actions remain visibly pending through navigation
- **WHEN** resuming/starting or stopping a session, adding a folder, or cloning waits on the hub
- **THEN** its control SHALL be disabled with an in-progress label until settled so multi-second startup reads as working
- **WHEN** the action navigates into a session
- **THEN** a full-page opening indicator SHALL cover the dashboard from navigation start until the session page replaces it, and the post-start-API SPA loading gap MUST NOT read as idle

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
The hub SHALL provide an anonymously accessible, origin-scoped web-app manifest and icons linked by login and dashboard pages, keeping installed navigation between hub pages and sessions standalone.

#### Scenario: Installation metadata spans the entire hub origin
- **WHEN** a browser fetches `/manifest.webmanifest` at the hub origin
- **THEN** it SHALL declare hub `name`/`short_name`, `display: "standalone"`, `start_url: "/"`, `scope: "/"`, and 192x192 and 512x512 PNG icons
- **AND** login and dashboard SHALL link it from `<head>`; manifest and icons SHALL need no authentication, since install-time fetches may be anonymous and the manifest carries only branding
- **AND** an installed hub app SHALL keep login, dashboard, and every `/s/<id>/` session in scope without in-app browser chrome

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
The authenticated Hub directory browser SHALL let users create empty child folders in the currently browsed directory, rename listed children, and remove only empty listed children for registered and unregistered folders, using validated names and contextual results.

#### Scenario: Folder mutation validates names and refreshes in place
- **WHEN** a user requests creation of an empty child in the current directory, rename of a listed child, or removal of a listed child, whether registered or not
- **THEN** names MUST be non-empty visible single segments and MUST reject separators, dot segments, NUL, and leading `.`
- **AND** successful mutation SHALL refresh the affected listing; failure SHALL show an actionable error without navigating away

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
Registered-folder rename and removal SHALL coordinate all affected workspace sessions and preserve registration semantics. When affected workspaces are running or starting, mutation MUST wait for confirmed stops, including in-flight starts; all-stopped workspaces SHALL proceed without another stop prompt.

#### Scenario: Registered-folder mutation stops only with informed confirmation
- **WHEN** rename or removal affects registered workspaces
- **THEN** the browser SHALL preserve their registration semantics rather than treating folders as unrelated filesystem entries
- **AND** all-stopped workspaces SHALL proceed without another stop prompt; any running/starting workspace SHALL be identified with an offer to stop and continue
- **AND** confirming MUST stop all affected sessions including in-flight starts before mutation; declining MUST leave sessions, folders, and registrations unchanged
- **AND** the control SHALL stay disabled with progress while stopping and mutating

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
Selecting an unregistered Git repository SHALL open a configuration form before registration or startup. Add workspace SHALL register it stopped; Add and start SHALL be an explicit alternative, and cancellation SHALL leave existing state unchanged.

#### Scenario: Add form configures identity and credentials before registration
- **WHEN** an unregistered Git repository is selected in the directory browser
- **THEN** Add workspace SHALL open rather than immediately register/start it, show the canonical path, prefill an editable display name from the basename, and allow separate compatible authentication and signing selections
- **AND** Add workspace SHALL be primary and finish stopped, with Add and start an explicit alternative; cancelling SHALL leave folder, registry, credentials, and sessions unchanged

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
The dashboard SHALL create new stopped Git workspaces with explicit display/folder names, parent directory, and optional credentials. Failures SHALL be actionable without starting sessions or silently adopting existing folders.

#### Scenario: Create workspace initializes and registers only a new destination
- **WHEN** the dashboard presents its Create workspace flow
- **THEN** it SHALL offer a display name, visible single-segment folder name, absolute parent defaulted from Hub Settings, and optional authentication/signing credentials
- **AND** success SHALL create the child folder, initialize an empty Git repository, register the chosen display name and assignments, and leave it stopped
- **AND** existing destinations, invalid names, unavailable parents, Git initialization failures, and configuration persistence failures SHALL yield actionable errors without session start or silent adoption

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
Hub Settings SHALL let an authenticated user configure or clear one validated absolute default workspace parent. It SHALL guide onboarding without restricting where folders can be browsed or registered.

#### Scenario: Default parent directs onboarding with a safe fallback
- **WHEN** a default workspace parent is submitted for saving
- **THEN** it SHALL be validated as an existing direct directory before saving
- **WHEN** Create, clone, or directory browsing opens
- **THEN** it SHALL start at that directory if configured and readable, otherwise the daemon user's home with an explanation
- **AND** users MAY browse/register elsewhere

#### Scenario: Clearing the default parent restores the home-directory default
- **WHEN** the default workspace parent setting is cleared
- **THEN** the home-directory default SHALL be restored

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
Workspace and directory rows SHALL distinguish display-name editing, filesystem rename/removal, unregistration, and guarded worktree deletion. Git dependency safety SHALL constrain folder moves independently of runtime state.

#### Scenario: Workspace naming is separate from folder movement
- **WHEN** workspace or directory row actions are shown
- **THEN** they SHALL distinguish Rename workspace, Rename folder, Remove from Hub, Remove folder, and Delete worktree
- **AND** Rename workspace SHALL remain available for ordinary/main workspaces while stopped or running and SHALL change only the display name; linked child names SHALL reflect exact local branches, with independent child and branch renaming out of scope
- **WHEN** Rename folder would break linked-checkout, main/common-directory, or ancestor dependencies, including outside the Hub registry
- **THEN** it SHALL be refused with an explanation that stopping cannot make it safe and display-name editing offered only where applicable, without a separate folder-policy dialog
- **WHEN** a folder move is permitted by those guards
- **THEN** it SHALL retain existing coordinated filesystem behavior and stable URL id

#### Scenario: Removal and lifecycle actions communicate distinct effects
- **WHEN** a row offers removal or lifecycle actions
- **THEN** Remove from Hub SHALL preserve the folder; Remove folder SHALL remain empty-directory-only; Delete worktree SHALL be separate and guarded for verified Uatu-created linked checkouts
- **AND** stopped registered directories SHALL offer Start, not Open; running workspaces SHALL offer Open

#### Scenario: Running workspace display name is changed
- **WHEN** a user renames a running workspace from `API` to `Payments API`
- **THEN** Hub-owned workspace lists and navigation show `Payments API`
- **AND** its session, folder path, stable id, and URL remain unchanged

#### Scenario: Stopped registered folder is selected
- **WHEN** the directory browser lists a registered workspace with no running session
- **THEN** its primary action is Start
- **AND** activating it uses the normal credential-aware start flow rather than navigating to an unavailable session

#### Scenario: Unsafe folder move is explained
- **WHEN** a proposed folder rename would invalidate worktree links
- **THEN** the browser reports the refusal without stop as a bypass; ordinary/main display-name editing remains available, while a child's name continues to follow its branch

### Requirement: The switcher surfaces other workspaces' activity
The in-session switcher SHALL report other accessible workspaces' live activity, with the badge and menu-state rules below. Viewing finished Chat SHALL clear its state across devices. Activity presentation MUST NOT reveal conversation content or titles, and MUST NOT vary by mode beyond the switcher's existing placement rules.

#### Scenario: Other-workspace activity is presented privately and consistently
- **WHEN** the brokered activity topic reports other accessible workspaces
- **THEN** the switcher SHALL show session running state, agent work, awaiting interaction, and finished work since last viewing Chat
- **AND** menu running states SHALL read awaiting the user, working, finished, or idle by absence of a word
- **AND** the collapsed chip SHALL carry a badge while any other workspace awaits the user, a distinct badge while any other workspace has finished unviewed work, and SHALL distinguish both from mere agent activity; when several apply the chip shows the most urgent in the order awaiting, finished, working
- **AND** presentation MUST NOT reveal conversation content/titles or vary by mode beyond existing placement rules
- **WHEN** a finished workspace's Chat is opened
- **THEN** its entry and badge SHALL clear on every device without reload

#### Scenario: An agent finishes in another workspace
- **WHEN** an agent in a workspace the user is not viewing transitions from working to idle
- **THEN** that workspace's entry in the switcher menu changes from working to finished without the menu being reopened
- **AND** the collapsed chip shows a finished badge

#### Scenario: Background work reads as working
- **WHEN** an agent in another workspace has ended its turn but still holds a backgrounded task
- **THEN** that workspace's entry still reads as working

#### Scenario: Opening the finished workspace clears the state
- **WHEN** the user opens a finished workspace and its chat surface is in view
- **THEN** the workspace's entry no longer reads finished and the badge clears on the user's other open pages

#### Scenario: A question elsewhere badges the chip
- **WHEN** an agent in another running workspace asks the user a question
- **THEN** the collapsed switcher chip shows an awaiting-interaction badge
- **AND** the menu entry for that workspace names it as awaiting the user
- **AND** the badge clears once the interaction is answered from any device

#### Scenario: Awaiting outranks finished on the chip
- **WHEN** one other workspace awaits the user and another has finished unviewed work
- **THEN** the collapsed chip shows the awaiting badge
- **AND** each menu entry still names its own state

### Requirement: Worktree-capable dashboard uses selected Active groups layout
Active groups SHALL be the sole worktree-capable dashboard layout, preserving original presentation, lifecycle actions, exact branches, provenance, and safety. Repository headings SHALL own parent Rename and fork; main checkouts SHALL have independent rows and lifecycle. No-capability product behavior SHALL remain unchanged.

#### Scenario: Active groups remain stable across dashboard operations
- **WHEN** the dashboard loads, reloads, creates, deletes, starts, or stops a checkout
- **THEN** it SHALL use reusable actual dashboard presentation with no discarded alternative or layout toggle
- **AND** original row styling/actions, exact branches, provenance, and safety SHALL remain, with no-capability behavior unchanged
- **AND** a separate main row SHALL expose its actual branch and independent lifecycle

#### Scenario: Repository actions align and share the fork glyph
- **WHEN** a repository heading renders at desktop or narrow width
- **THEN** parent Rename and fork SHALL be grouped at the trailing edge aligned with subordinate rows' Open/Stop edge, with fork last, wrapping beneath the name without horizontal overflow

#### Scenario: Every fork control uses the same single-definition glyph
- **WHEN** a fork control renders on a dashboard heading or a picker group header
- **THEN** it SHALL draw one shared glyph defined in a single place

#### Scenario: Main stops while a child runs
- **WHEN** main Stop is activated
- **THEN** only main stops and child runtime remains unchanged; children can also start while main is stopped
- **AND** the repository stays under Active with a clearly stopped main row until the last running checkout stops

#### Scenario: Active and inactive group treatment
- **WHEN** the worktree-capable dashboard loads
- **THEN** groups with any running checkout appear first under Active, stopped children are under expandable `N stopped worktrees`, and entirely stopped repositories are under collapsed Inactive groups with clear expand-to-Start/fork affordance
- **AND** desktop/touch keyboard disclosures and mixed/all-stopped evidence are required

### Requirement: Hub offers explicit worktree lifecycle navigation
The workspace picker SHALL focus on switching and parent-only creation forks, with explicit repository grouping and checkout identity. Real picker and dashboard surfaces SHALL preserve lifecycle, provenance, safety, accessible interaction, and independent workspace context without generic Details navigation.

#### Scenario: Picker repository identity and grouping are unambiguous
- **WHEN** the picker shows workspaces with or without repository-family membership
- **THEN** each repository-family checkout's selector SHALL name the repository (child's parent or main checkout's own name) followed by branch, identically for main and child, and SHALL be the only place the picker names that current checkout's repository, with no separate title above it
- **AND** rows SHALL group under a non-interactive repository header with trailing fork, then main then children on one left edge without indentation, with consecutive groups visually separated
- **AND** workspaces without a repository family SHALL keep only their display name without branch and remain ungrouped; grouping MUST NOT be inferred from names

#### Scenario: Dashboard hierarchy preserves focused lifecycle and policy access
- **WHEN** the dashboard or picker exposes worktree actions
- **THEN** the picker SHALL have switching and parent-only forks without Details or a global worktree action
- **AND** the dashboard SHALL retain original rows/actions, explicit parent/repository hierarchy, exact branch child names and parent forks, with all group rows on one left edge and no child indentation/tree lines
- **AND** generic Details SHALL be absent; live-inherited parent credentials/shared policy SHALL be managed through Hub Settings' own navigation, without heading/child Configure controls
- **AND** Open/Start/Stop and Remove from Uatu (unregister) remain distinct from guarded owned-only Delete worktree, using existing secondary affordances when available

#### Scenario: Worktree recovery and opening preserve context on real surfaces
- **WHEN** the real picker or dashboard surfaces are displayed
- **THEN** inventory, discovery, recovery, and missing-path states SHALL be reviewable, and errors SHALL provide relevant inline retry/actions
- **AND** compact creation omits policy/path/base readouts and defaults stopped without switching; explicit Open SHALL use separate stable `/s/<workspace-id>/` context and restore its own files/preview/terminal/chat without conversation migration
- **AND** external registration preserves path/ownership; missing/uncertain trees remain unavailable without silent recreation
- **AND** keyboard, touch, themes, and titlebar inset SHALL be supported, with no-capability dashboard behavior unchanged

#### Scenario: Fork targets the selected main workspace
- **WHEN** the reviewer activates the fork on either of two main workspace rows in the picker or real dashboard
- **THEN** a small dropdown offers New branch / worktree, Existing branch and Register worktree…, and creation targets that parent only without a source/path readout in the popup
- **AND** Register worktree… opens a compact list of only the checkouts Git lists for that repository that Uatu has not registered — each with its branch, ownership label and path, offering Register workspace for an external tree and Retry registration for a retained Uatu-created checkout — with `Every worktree Git lists is registered.` and Cancel when there are none
- **AND** neither child has a fork action or independent credential/settings form

#### Scenario: Compact creation has an explicit starting branch
- **WHEN** New branch / worktree is selected
- **THEN** the popup contains target title, Name, Create from and Create/Cancel; Create from uses the shared local/remote editable fuzzy combobox plus adjacent Fetch
- **AND** initial choice prefers local main then sole remote main, otherwise stays empty; current checkout does not control defaults and refetch never reapplies them
- **WHEN** Existing branch is selected
- **THEN** an editable fuzzy combobox covers all local/remote branches with badges and qualified names; picking fills the input exactly, edits clear selection and disable Create, reopening permits reviewing all refs, and arrows/Enter/Escape, focus, touch and empty results are supported
- **AND** the adjacent Fetch remote branches icon explicitly refreshes cached refs, preserving query and a valid choice or invalidating a disappeared choice, with loading and inline errors; opening does not fetch
- **AND** neither popup contains extra metadata/destination/configuration/ownership readouts; cancellation and no submission do not mutate
- **AND** clicking an initial local or remote row without typing commits the exact input value and enables successful Create

#### Scenario: Preserve dashboard and existing lifecycle access
- **WHEN** worktree capability data is present
- **THEN** the original dashboard row renderer, paths, status dots, shell/credential summaries, style and applicable Rename/Stop/Start/Remove actions remain, augmented by nesting, branch labels and parent forks
- **AND** children follow their parent while retaining truthful individual status/actions, and child rename remains excluded
- **AND** there is no generic Details navigation, global switcher worktree button or per-repository Configure control; parent policy on the Hub's Settings page, relevant recovery actions and guarded owned-only Delete remain available outside the focused switcher

#### Scenario: Nested rows show unobtrusive truthful provenance
- **WHEN** child workspaces appear in the actual workspace selector or original-style dashboard
- **THEN** their exact branch remains primary and a small muted label states ownership first: `External worktree` for a registered external tree, `Ownership uncertain` for an unverifiable one, and otherwise `from <recorded-source-ref>` or, for a Uatu-owned branch with no recorded history, `origin unknown`
- **AND** new branch sources reflect the exact selected starting ref, remote-created tracking branches show their selected remote ref, and existing-local/external branches without recorded history remain unknown
- **AND** labels do not change with parent checkout/configuration or upstream updates

#### Scenario: Current main checkout is not creation provenance
- **WHEN** the main workspace is checked out on feature/foo
- **THEN** dashboard and selector display feature/foo compactly, distinct from repository identity and child origin labels
- **WHEN** the checkout changes, is detached, or its branch is unknown
- **THEN** refresh reflects the current ref or explicit Detached HEAD / Branch unknown state without guessing main or modifying child sourceRef

#### Scenario: Picker labels every checkout the same way and groups without indentation
- **WHEN** a user opens the workspace picker from a child worktree of a repository
- **THEN** the selector reads that checkout's repository followed by its branch, in the same weight and size as a main checkout's own repository-then-branch reading, keeping its running/stopped indicator and its activity badge
- **WHEN** the picker's menu lists two repositories
- **THEN** each repository's group header carries its name with its single fork control at the header's trailing edge, the header is visually distinct from the rows beneath it, and consecutive groups are separated from one another while the first group needs no separator of its own
- **AND** the main checkout row leads its group with its branch beneath, children follow with their ownership labels beneath, and every row — main checkout and child alike — shares one left edge with no indentation or tree lines
- **AND** the menu fits a 390 px viewport without horizontal overflow in both colour schemes

#### Scenario: Worktree actions are available without leaving the workspace
- **WHEN** a user opens the existing workspace picker while viewing a document or conversation
- **THEN** worktree registration, create and explicit switch actions are available there without first visiting the Hub dashboard
- **AND** opening or refreshing that list does not change the active document, terminal or conversation context

#### Scenario: Created workspace is opened deliberately
- **WHEN** creation succeeds without a start request
- **THEN** the popup closes, the source list/picker/dashboard refreshes, the source remains selected and a small `Created <branch>` confirmation, rendered at the top of the viewport below the titlebar inset and in the app's success colour, offers Open while leaving the child stopped
- **AND** no Worktree ready, Details or registration popup opens automatically on any SPA, dashboard or review creation path
- **AND** only explicit Open starts then navigates to its separate stable session URL displaying its own files, preview, terminal and chat

#### Scenario: Partial creation is not described as total failure
- **WHEN** checkout creation succeeds but registration fails
- **THEN** a compact actionable error in the originating flow explains that the checkout and branch remain and offers same-checkout Retry registration rather than duplicate Create or a metadata dump

#### Scenario: Small screen deletion remains intelligible
- **WHEN** a touch user reviews deletion
- **THEN** the compact `Delete worktree?` dialog identifies `<parent display name> / <branch>` with no full path, internal IDs, ownership, status card, duplicate fields or configuration inside
- **AND** stopped copy is “The worktree’s files will be removed. The Git branch will be kept.” with Cancel and destructive Delete
- **AND** running copy is “Its Uatu terminal and agent sessions will stop, then the worktree’s files will be removed. The Git branch will be kept.” with Cancel and destructive Stop and delete, with no extra checkbox
- **AND** normal cases fit the phone viewport without dialog overflow or scrolling

#### Scenario: Safety blocker stays compact and cannot be bypassed
- **WHEN** preflight or recheck identifies dirty/untracked/ignored data, a lock, external ownership/activity, nested dependency or stop failure
- **THEN** a short actionable reason replaces normal deletion consequences and prevents proceeding, with Cancel/Close and retry only where meaningful
- **AND** files and registration remain; no force action or promise to stop unknown external applications is shown
- **WHEN** explicitly authorized known Uatu activity stops successfully and all checks pass
- **THEN** deletion closes the dialog and removes the row, preserves the branch, and uses existing safe navigation if the removed workspace was active

#### Scenario: Back restores usable navigation
- **WHEN** the user opens a worktree and returns via the existing workspace picker or browser history
- **THEN** the opening indicator clears, authoritative or explicitly stale checkout state is shown, and the returning workspace restores its own document/preview, terminal context and selected conversation
- **AND** neither workspace's conversations are migrated or replaced by those from the other checkout

### Requirement: Worktree dialogs are client-rendered from the published JSON
One unchanged client dialog module SHALL render every worktree view from published Hub JSON in both picker and dashboard. The published contract, capability discovery, contextual recovery, and prefix-aware requests SHALL support equivalent behavior without server-rendered fragments or redirects.

#### Scenario: Both entry points discover and render the entire worktree family
- **WHEN** picker or dashboard offers worktree views
- **THEN** the same unchanged client module SHALL render the unregistered-checkout list, new/existing-branch create, delete, register, forget, and retry-open from published JSON with identical roles, labels, copy, and keyboard behavior
- **AND** the Hub SHALL NOT serve HTML fragments or action redirects, and no worktree path SHALL be excluded from the published API contract
- **AND** discovery SHALL use published state's worktree API field only when served, a boolean main-checkout fork marker, and existing parent configuration navigation
- **AND** client requests SHALL use the application URL helper for relocated sessions

#### Scenario: Dialog results stay in their originating flow
- **WHEN** creation succeeds on any entry path
- **THEN** its dialog SHALL close, source lists refresh, and a small success-coloured `Created <branch>` confirmation with explicit Open SHALL appear at viewport top without automatic switching
- **WHEN** an operation is refused or registration fails after checkout retention
- **THEN** a short actionable reason SHALL replace normal consequences in the originating flow, with retry only where meaningful and registration retry on that same retained checkout
#### Scenario: Every missing or replaced path offers refresh without recreation
- **WHEN** a picker or dashboard row shows a missing or replaced path
- **THEN** it SHALL offer inline Retry refresh and MUST NOT recreate a checkout

#### Scenario: Live inventory and branch selection preserve the active workspace
- **WHEN** `worktrees` invalidation reaches an open register list
- **THEN** it SHALL refresh without changing active document, terminal context, or conversation
- **WHEN** any branch list opens or an option is chosen
- **THEN** it SHALL open expanded with full local/remote listing, and pointer, touch, and keyboard selection SHALL commit the option and enable Create alike

#### Scenario: Both entry points render the same dialog
- **WHEN** a user opens worktree creation, deletion, registration or forget from the in-workspace picker and from the Hub dashboard
- **THEN** each renders from the published worktree JSON with the same dialog roles, labels and copy, and no navigation to a server-rendered worktree page or redirect occurs

#### Scenario: Refusal is shown where the user is working
- **WHEN** an operation is refused, whether by validation, a safety blocker or a failed stop
- **THEN** the originating dialog shows its short actionable reason in place of the normal consequences, keeps the user's valid draft where one exists, and nothing is mutated

#### Scenario: Unavailable checkout offers refresh, not recreation
- **WHEN** a registered checkout's path is missing or now holds a different checkout
- **THEN** the row stays visible and disabled with an inline Retry that re-reads authoritative inventory, and no create or recreate action is offered

### Requirement: Session pages announce questions waiting in other workspaces
A hub-served session page SHALL privately announce newly awaiting interactions in other accessible workspaces through in-app notices. Open SHALL reach the waiting Chat conversation, preserving login redirects and handling already-answered requests without selecting unrelated content.

#### Scenario: Activity transitions raise notices against the page's known baseline
- **WHEN** another accessible workspace changes from not awaiting to awaiting in the activity topic
- **THEN** the page SHALL compare with its last known state, using the first activity report after load as baseline and retaining comparison state across background return/reconnect
- **AND** it SHALL name the workspace, say an agent needs an answer, and offer Open/Dismiss without revealing conversation content, titles, questions, or tool details

#### Scenario: Own workspace and non-new questions do not raise notices
- **WHEN** activity is for the page's own workspace, a workspace already awaiting when the page loaded, or an agent that finished without asking
- **THEN** the page SHALL NOT show a notice for it

#### Scenario: Notices stack safely and clear independently of push enrollment
- **WHEN** notices for one or more workspaces are present
- **THEN** at most one per workspace SHALL appear, newest first, without covering composer, touch tab bar, or hub navigation
- **AND** dismissal, opening, or any end to awaiting state including another-device answer or workspace stop SHALL clear the notice
- **AND** notices SHALL be independent of notification enrollment and SHALL NOT request OS notifications

#### Scenario: Notice Open resolves the current waiting interaction
- **WHEN** Open is activated
- **THEN** it SHALL navigate to the named workspace with Chat active in the current UI mode and select the waiting conversation, preferring the most recently raised interaction when several wait
- **AND** if none awaits on arrival, Chat SHALL show its list with a short already-answered note and SHALL NOT select an unrelated conversation as target
- **AND** the destination link SHALL survive login redirect

#### Scenario: A question in another workspace raises a notice
- **WHEN** a user is working in workspace alpha and an agent in workspace beta asks a question
- **THEN** alpha's page shows a notice naming beta with Open and Dismiss
- **AND** the switcher chip still carries its awaiting badge

#### Scenario: Open lands on the waiting conversation
- **WHEN** the user presses Open on a notice for beta
- **THEN** beta opens with Chat in front and the conversation holding the question selected
- **AND** the pending question is available through the normal chat interaction

#### Scenario: The question is answered elsewhere first
- **WHEN** a notice for beta is showing and the question is answered from the user's phone
- **THEN** the notice clears without user action

#### Scenario: Open after the answer
- **WHEN** the user opens beta from a link whose request was answered before the page loaded
- **THEN** Chat shows its conversation list and a note that the request was already answered
- **AND** no conversation is selected as though it were the target

#### Scenario: The current workspace does not notify itself
- **WHEN** an agent in the workspace the page is serving asks a question
- **THEN** that page shows no notice for it

#### Scenario: Already-waiting workspaces stay quiet on load
- **WHEN** a user opens a session page while workspace beta is already awaiting an answer
- **THEN** the page shows no notice for beta
- **AND** the switcher badge reports beta as awaiting

#### Scenario: A question raised during a brief tab switch
- **WHEN** a user hides their session page for alpha for 10 seconds, an agent in beta asks a question meanwhile, and the user returns
- **THEN** alpha's page shows a notice for beta once it has reconnected
- **AND** no push was sent for that question

#### Scenario: Completions do not raise a notice
- **WHEN** an agent in another workspace finishes a turn without asking anything
- **THEN** no notice appears
- **AND** the switcher reports that workspace as finished

#### Scenario: Touch mode keeps the tab bar usable
- **WHEN** a notice appears on a page in touch mode
- **THEN** it is shown above the bottom tab bar and every tab remains reachable

### Requirement: Settings manages agent accounts
The authenticated `/settings` page SHALL provide Agent accounts separately from Credentials, implementing the `agent-accounts` capability with per-agent summaries, contextual progress/errors, and phone-usable login flows.

#### Scenario: Agent account cards retain state and local feedback
- **WHEN** Agent accounts is displayed or refreshed
- **THEN** one card per agent SHALL default collapsed and summarize name, installation state, and login plainly as "Logged in as <account> · <plan>", "Not logged in", or logged-in OpenCode provider count
- **AND** expanded state SHALL persist across refreshes; each login form, attempt, and card action SHALL report its own errors locally, reserving the page alert for load failures
- **AND** waiting agent actions SHALL disable their controls with progress until settled

#### Scenario: Phone login supports external verification and full-value paste
- **WHEN** login is started at phone width
- **THEN** its URL SHALL be a new-tab link, any code SHALL be large selectable text with Copy, and paste fields SHALL accept the whole pasted value

#### Scenario: Collapsed summary states the login
- **WHEN** Claude Code is logged in with a subscription and OpenCode has three providers logged in
- **THEN** the collapsed Claude Code card reads "Logged in as <email> · <plan>"
- **AND** the collapsed OpenCode card reads "3 providers logged in"

#### Scenario: Login attempt errors stay local
- **WHEN** a pasted code is rejected
- **THEN** the error appears next to that login attempt's code field
- **AND** the page-level alert is not used

#### Scenario: Device code on a phone
- **WHEN** a user starts a device-code login on a phone-width screen
- **THEN** the code is shown large enough to read and has a copy control, and the verification URL opens in a new tab

### Requirement: Chat links a missing login to Agent accounts
When a session is served by the Hub and the chat reports that an agent has
no usable login, the chat SHALL offer a link that opens the Hub's Settings at
the Agent accounts area with that agent's card expanded. Outside a Hub there
is no Settings page, so the chat SHALL name the agent's own login command
instead.

#### Scenario: Link from a failed Claude turn
- **WHEN** a Claude turn in a Hub-served workspace fails because there is no usable login
- **THEN** the failure offers "Log in to Claude Code", which opens Settings with the Claude Code card expanded

### Requirement: Hub accounts have personal synchronized chat preferences
Authenticated Hub Settings SHALL offer an explicitly saved, account-scoped automatic-backgrounding preference, default ON when absent. Policy SHALL be authoritative across devices and workspaces, preserve accepted-action snapshots, and reject stale conflicting saves.

#### Scenario: Personal preference controls disclose scope and effects
- **WHEN** Personal chat preferences is displayed
- **THEN** a compact **Keep workers running when I steer** switch SHALL default ON without a saved value, show a one-line helper **Applies to your account on this Hub.**, and use compact explicit **Save**, not autosave, with at least 44px switch/Save targets
- **AND** the setting SHALL apply only to the initiating account on this Hub across devices/workspaces, persist through restart, and never change another account's value
- **AND** collapsed **Learn more** SHALL distinguish machine-wide logins and workspace defaults, describe accepted-steer rather than job-start backgrounding, disclose all eligible blocking jobs including shells/shared-workspace effects, and retain non-atomic/native-resume caveats
- **AND** existing pending/conflict/unavailable handling SHALL remain unchanged

#### Scenario: Refresh and concurrent saves retain authoritative policy snapshots
- **WHEN** Settings is entered, returns to visibility/focus, or reconnects
- **THEN** it SHALL load the current value and show saved confirmation only after persistence succeeds
- **WHEN** an eligible action occurs
- **THEN** policy SHALL resolve from authoritative Hub state, not a device's cached display
- **WHEN** a setting change completes
- **THEN** it affects subsequent actions and SHALL NOT retroactively add or cancel follow-ups for an action already accepted under a prior policy snapshot
- **WHEN** a stale concurrent update is submitted
- **THEN** it SHALL report a conflict with current own-account state rather than silently overwrite a newer save

#### Scenario: New and existing accounts have the requested default
- **WHEN** an account with no personal chat preference opens Settings, including after upgrading an existing Hub
- **THEN** automatic backgrounding on accepted steers is ON for that account
- **AND** no operator configuration or other user's preference is rewritten

#### Scenario: Saved OFF is shared by the account's devices
- **WHEN** one device saves OFF and another device for the same account re-enters or refreshes Settings, even in another workspace after a Hub restart
- **THEN** it reads OFF
- **AND** subsequent steer actions from either device use OFF even if an earlier page had displayed ON

#### Scenario: Other accounts remain independent in a shared workspace
- **WHEN** A saves ON and B saves OFF while both use the same workspace
- **THEN** A's qualifying actions use ON and B's actions use OFF
- **AND** shared worker effects do not change either account's setting or cause one device to display the other's preference

#### Scenario: Concurrent settings updates do not overwrite silently
- **WHEN** two devices save changes based on the same saved revision and one has already committed
- **THEN** the stale save reports a conflict and the account's current value
- **AND** the first committed value remains until another explicitly resolved update succeeds

#### Scenario: Settings navigation is available from the workspace
- **WHEN** an authenticated user opens the workspace Hub menu with touch, pointer or keyboard
- **THEN** a labelled Settings link reaches the personal chat preference without adding permanent chat toolbar controls
- **AND** menu refresh and dismissal retain existing focus and outside-tap safety

### Requirement: Personal chat preference persistence and access preserve account boundaries
Personal chat preferences and dispatch SHALL preserve authenticated account boundaries, private fresh-child authority, and atomic owner-only storage. Unavailable trust/state SHALL fail explicitly without automatic-backgrounding authority or weakened receipt isolation. Policy secrets SHALL NOT be exposed through public credentials, URLs, configuration, diagnostics, or tool subprocess inheritance.

#### Scenario: Preference reads and dispatch authenticate account and workspace scope
- **WHEN** the preference API is called
- **THEN** identity SHALL come only from authenticated cookie/bearer session, only its preference SHALL return with no-store semantics, and a closed versioned contract and cross-origin cookie-mutation protection SHALL apply
- **AND** clients SHALL NOT select another account through body/query/header/workspace path
- **WHEN** Hub chat dispatch handles a request
- **THEN** it SHALL use authenticated workspace-bound context and SHALL NOT trust caller policy metadata or store initiating-user policy as shared conversation/adapter state

#### Scenario: Policy metadata never leaks through shared read surfaces
- **WHEN** shared conversation replay, diagnostics, or another viewer's responses are produced
- **THEN** account policy metadata SHALL NOT be exposed through them

#### Scenario: Child policy trust is private and invalidated by replacement
- **WHEN** a child is spawned or replaced
- **THEN** policy authority SHALL be privately established independently of workspace/terminal credentials and bound to a required fresh child-instance identity
- **AND** replacement SHALL invalidate prior authority/envelopes despite reused workspace identity, endpoint, or credential

#### Scenario: Workspace credentials cannot authorize Hub policy assertions
- **WHEN** a caller presents a valid workspace credential
- **THEN** that credential SHALL NOT authorize asserting a Hub principal or signing policy

#### Scenario: Missing terminal credentials never select fallback policy keys
- **WHEN** terminal credentials are nullable or absent
- **THEN** they SHALL NOT select a fallback policy key; private bootstrap can establish policy trust independently, subject to unchanged primary access gates

#### Scenario: Missing policy proof degrades without granting authority
- **WHEN** private trust or instance proof cannot be established
- **THEN** automatic backgrounding SHALL be explicitly unavailable without unsigned/default-ON fallback, while ordinary steering/background API retain existing access checks
- **AND** unavailable trust SHALL NOT merge authenticated accounts' mutation receipts or disable unknown-outcome retention

#### Scenario: Degraded operation identifiers preserve correlation without authority
- **WHEN** a degraded operation identifier is used
- **THEN** it SHALL preserve original client correlation without asserting an unsigned principal or authorizing automatic backgrounding

#### Scenario: First feedback decisions remain scoped to their authenticated initiator
- **WHEN** a first feedback decision is made while bounded in-memory receipt/snapshot protection is retained
- **THEN** it SHALL remain scoped to the authenticated initiating account

#### Scenario: Preference storage preserves OFF values and fails safely
- **WHEN** preferences are read or updated
- **THEN** persistence SHALL use owner-only storage, atomic serialized updates, rollback on an uncommitted failure, preservation of other users' records and explicit OFF, and rejection of unsupported wire versions
- **AND** a missing initial file/record SHALL resolve ON; corrupt/unreadable/unsupported-version state SHALL report unavailable without overwrite or OFF-to-ON reset
- **WHEN** preference resolution is unavailable
- **THEN** steering SHALL remain usable, skipping automatic backgrounding with explanatory feedback

#### Scenario: Standalone chat has no personal Hub policy
- **WHEN** chat runs standalone without a Hub account
- **THEN** it SHALL have no personal toggle or automatic Hub policy; the background API SHALL remain available without manual Continue UI

#### Scenario: Client tries to choose another account
- **WHEN** a client supplies a foreign identity, unknown field or unsupported version to the personal preference API
- **THEN** the request is rejected without reading or changing another account's state

#### Scenario: Unauthorized or cross-origin preference mutation
- **WHEN** a missing/revoked session or cross-origin cookie request attempts to change the preference
- **THEN** it is refused without a preference write or background operation

#### Scenario: Spoofed dispatch context cannot activate policy elsewhere
- **WHEN** a caller supplies forged policy metadata or reuses context for a different workspace, child instance, principal or action
- **THEN** it cannot authorize automatic backgrounding for that action
- **AND** a direct standalone request cannot acquire another Hub user's policy

#### Scenario: Failed save preserves explicit OFF and other users
- **WHEN** saving a preference fails before its atomic commit
- **THEN** Settings reports failure without claiming the new value was saved
- **AND** the prior saved value and other accounts' records remain intact

#### Scenario: Workspace credential cannot forge an initiating principal
- **WHEN** a caller holding a valid workspace credential attempts to sign policy asserting another Hub principal using that credential
- **THEN** policy verification fails and no automatic follow-up is authorized
- **AND** supplying the same credential through a legitimate workspace route does not elevate it to Hub policy authority

#### Scenario: Null terminal token has independent policy trust
- **WHEN** a child has no terminal token but completes verified private policy bootstrap with its fresh instance identity
- **THEN** policy trust is established independently of terminal availability
- **AND** existing primary-route authentication/origin checks are not bypassed or relaxed

#### Scenario: Bootstrap unavailable fails explicitly
- **WHEN** private bootstrap or instance proof is missing, unsupported, malformed or times out, including with a null terminal token
- **THEN** automatic backgrounding is reported unavailable and no policy authority is inferred from workspace credentials or account defaults
- **AND** otherwise permitted steering/background API requests retain their existing behavior without unsigned principal propagation

#### Scenario: Restart invalidates old policy authority
- **WHEN** a child restarts in the same workspace with the same endpoint or workspace credential
- **THEN** it establishes a fresh private policy secret and instance identity
- **AND** old-instance signed policy or readiness proofs cannot authorize new actions, and uncertain mutations are not replayed on rotation

#### Scenario: Persisted preference data cannot be safely read
- **WHEN** persisted personal chat preferences are corrupt, unreadable or from an unsupported format version
- **THEN** Settings reports unavailable without overwriting them
- **AND** an otherwise accepted steer is preserved while its automatic background follow-up is skipped with an explanation

#### Scenario: Standalone keeps explicit behavior
- **WHEN** chat runs outside a Hub account context
- **THEN** the personal automatic-background toggle is absent and steer actions do not automatically background work
- **AND** the capability-gated background API retains its existing semantics without a manual Continue control or replacement menu

#### Scenario: Degraded trust preserves account receipt isolation without authority
- **WHEN** two authenticated Hub accounts submit different inputs with the same conversation and client request identifier while private policy trust is unavailable
- **THEN** both inputs have distinct operation receipts and neither account receives the other's result
- **AND** neither operation acquires an unsigned principal or automatic-background authority
- **AND** same-account retries preserve the first retained result/feedback even after a preference change
