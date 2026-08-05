# hub-dashboard — delta for unify-desktop-on-hub

## REMOVED Requirements

### Requirement: Dashboard creates workspaces from the workspaces root
**Reason**: The workspaces-root model is removed (hub-service delta); workspaces are registered by absolute path, so "pick a subfolder of the root" no longer describes the flow.
**Migration**: Replaced by "Dashboard adds folders through a server-side directory browser" below. The git preflight (`409 needsInit` handshake), the clone action, and the no-`--force` rule all carry over into the new requirement.

## MODIFIED Requirements

### Requirement: Dashboard can forget a stopped workspace
The dashboard SHALL offer a forget action on stopped workspaces that removes the registration only: the folder on disk MUST NOT be touched and SHALL reappear in the directory browser as an unregistered folder. The hub SHALL reject forgetting a workspace whose session is running or still starting, so a forget can never race an in-flight spawn into a live child that the dashboard no longer knows about.

#### Scenario: Forgetting returns the folder to the browser
- **WHEN** the user forgets a stopped workspace
- **THEN** the workspace disappears from the registered list and its folder shows as unregistered when browsed to

#### Scenario: A running or starting session cannot be forgotten
- **WHEN** a forget request names a workspace whose session is running or whose start is still in flight
- **THEN** the hub rejects it and the registration is unchanged

### Requirement: Hub-served sessions expose hub navigation
When the SPA is served through a hub (a hub-session-shaped base path AND the hub API answering at the origin root), the sidebar header SHALL show a workspace switcher naming the current workspace, whose menu links to the hub dashboard and to every registered workspace (running state indicated; stopped workspaces labeled) and offers a sign-out entry when the hub has a login. In local mode (`--local`) the sign-out entry SHALL be omitted — no login exists and its routes are absent, so the entry could only lead to a 404; the state API SHALL tell clients the hub is local. Outside a hub — plain `uatu serve`, a bare `--base-path` invocation — the affordance MUST stay hidden. (Desktop wrapper sessions are hub sessions and show the switcher.) The hub's brand header SHALL show the logo centered with the wordmark beneath it and no tagline.

#### Scenario: Switching workspaces from inside a session
- **WHEN** a user inside a hub-served session opens the workspace switcher
- **THEN** they see the hub dashboard link and the other workspaces with running/stopped state
- **AND** activating one navigates to that workspace's session URL

#### Scenario: No hub affordance outside a hub
- **WHEN** the SPA runs under plain `uatu serve` (default base path) or under a base path with no hub answering at the origin root
- **THEN** the workspace switcher is not shown

#### Scenario: Local mode has no sign-out entry
- **WHEN** a user opens the workspace switcher in a session served by a `--local` hub
- **THEN** the menu shows the dashboard link and workspaces but no sign-out entry

## ADDED Requirements

### Requirement: Dashboard adds folders through a server-side directory browser
The dashboard SHALL offer workspace registration by browsing the hub host's filesystem, not by typing paths: the hub SHALL expose a directory-listing API that, for a given absolute path (defaulting to the daemon user's home), returns its parent and its child directories — each with its name, whether it is a git repository, and its registered workspace id if any — listing directories only and hiding dot-directories. The dashboard SHALL present this as a drill-down browser ending in an "add this folder" action. Filesystem visibility through the browser is within the documented trust model: hub users already hold shell access through the embedded terminal.

In local mode (`--local`, the desktop's trusted loopback hub) the dashboard SHALL omit the directory browser and the clone form: the desktop app owns folder adding there through the native folder picker, and a web facsimile of it would be a worse duplicate. Registration through the API is unaffected.

Registration SHALL submit the browsed absolute path. Adding a non-git folder SHALL apply the git preflight: the hub probes with `git rev-parse --show-toplevel` and, when the probe definitively reports no repository, answers with a needs-initialization response so the client can confirm and resubmit with initialization requested; on decline the folder MUST NOT be registered or served. When the probe fails for any other reason the hub SHALL skip the offer and start the session, letting the CLI's own git preflight report. The dashboard SHALL additionally offer `git clone <url>` with a browsed destination directory, registering and serving the resulting folder; clone SHALL rely on the daemon user's ambient git credentials and the hub MUST NOT store credentials. The hub MUST NOT pass `--force` to the server.

#### Scenario: Browsing to and adding a folder
- **WHEN** the user drills into `~/src`, selects a git repository folder, and confirms adding it
- **THEN** the hub registers the folder with a stable id and starts its session

#### Scenario: Registered folders are marked while browsing
- **WHEN** the directory browser lists a folder that is already a registered workspace
- **THEN** the listing shows it as registered rather than offering to add it again

#### Scenario: Non-git folder is initialized and served
- **WHEN** the user adds a folder that is not inside a git worktree and confirms initialization
- **THEN** the hub runs `git init` there, registers the workspace, and starts its session

#### Scenario: Declined initialization leaves no trace
- **WHEN** the user adds a non-git folder and declines initialization
- **THEN** no session starts and the folder is not added to the registry

#### Scenario: Clone into a browsed destination
- **WHEN** the user submits a repository URL and picks a destination directory in the browser
- **THEN** the hub clones into that directory, registers the result with a stable id, and starts its session

#### Scenario: Failed clone or init is reported
- **WHEN** `git clone` or `git init` exits non-zero
- **THEN** the dashboard shows the git error output and no workspace is registered

#### Scenario: Local mode hides the browser
- **WHEN** the dashboard is served by a `--local` hub
- **THEN** the Add Folder browser and clone form are absent
- **AND** sessions, workspaces, and their stop/resume/forget actions render as usual

### Requirement: The workspace switcher chip reflects real session state
The in-session workspace switcher's collapsed chip SHALL show the current workspace's live indicator from hub-reported state, never from an assumption that the viewed session is running: a session page can outlive its server (a stop from the dashboard, a back/forward-cache restore). The chip SHALL update from fresh hub state on page-cache restores and whenever the menu's state refresh completes, so chip and menu can never disagree.

#### Scenario: A cached page of a stopped session shows a truthful chip
- **WHEN** the user stops a session from the dashboard and returns to its page via browser history
- **THEN** the switcher chip's indicator shows not-running
- **AND** opening the menu shows the same state

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
