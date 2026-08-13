# hub-dashboard Specification

## Purpose

Define the hub's browser surface: an authenticated dashboard that lists running sessions and stopped workspaces with live shell status, offers stop/resume/forget actions, adds workspaces through a server-side directory browser or by cloning a repository, and follows uatu's visual language — plus the in-session workspace switcher that hub-served sessions expose for navigating between the dashboard and sibling workspaces.
## Requirements
### Requirement: Dashboard lists sessions and workspaces with live status
The hub SHALL serve an authenticated dashboard listing running sessions and stopped registered workspaces. Each running session SHALL show its workspace name and path and a live shell summary sourced from the child's terminal session inventory (shell count, attached/detached, best-effort foreground-process label); each stopped workspace SHALL offer resume. Activating a running session SHALL navigate to its `/s/<id>/` URL. The dashboard SHALL be served under the hub origin so it shares the PWA installation with the sessions it links to.

#### Scenario: Running session shows live shell detail
- **WHEN** a session has two shells, one running a long-lived TUI, and the user opens the dashboard
- **THEN** the session's row reports the shells and the foreground-process label

#### Scenario: Jump into a session
- **WHEN** the user activates a running session's entry
- **THEN** the browser navigates to that session's `/s/<id>/` URL and the SPA loads

#### Scenario: Resume a stopped workspace
- **WHEN** the user activates resume on a stopped workspace
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

### Requirement: Dashboard adds folders through a server-side directory browser
The dashboard SHALL offer workspace registration by browsing the hub host's filesystem, not by typing paths: the hub SHALL expose a directory-listing API that, for a given absolute path (defaulting to the daemon user's home), returns its parent and its child directories — each with its name, whether it is a git repository, and its registered workspace id if any — listing directories only and hiding dot-directories. The dashboard SHALL present this as a drill-down browser ending in an "add this folder" action. Filesystem visibility through the browser is within the documented trust model: hub users already hold shell access through the embedded terminal.

Registration SHALL submit the browsed absolute path. Adding a non-git folder SHALL apply the git preflight: the hub probes with `git rev-parse --show-toplevel` and, when the probe definitively reports no repository, answers with a needs-initialization response so the client can confirm and resubmit with initialization requested; on decline the folder MUST NOT be registered or served. When the probe fails for any other reason the hub SHALL skip the offer and start the session, letting the CLI's own git preflight report. The dashboard SHALL additionally offer `git clone <url>` with a browsed destination directory and an optional single-folder checkout name, defaulting to the name derived from the remote when omitted, then register and serve the resulting folder. Clone SHALL rely on the daemon user's ambient Git configuration and already-loaded SSH agent keys, but MUST NOT use Git credential helpers or GUI askpass programs for credentials requested by the clone. The hub MUST NOT persist credentials supplied during cloning and MUST NOT pass `--force` to the server.

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
- **THEN** the hub starts an observable clone into that directory, registers the result with a stable id after the clone succeeds, and starts its session

#### Scenario: Clone with a custom checkout folder
- **WHEN** the user submits a repository URL with a valid custom checkout folder name
- **THEN** the hub clones into that folder rather than the name derived from the remote
- **AND** path-like names and dot segments are rejected before a clone job starts

#### Scenario: Already-loaded SSH key is used without prompting
- **WHEN** the clone URL uses SSH and the daemon user's existing SSH agent can authenticate with an already-loaded key
- **THEN** the clone uses that agent and completes without asking the user to enter the key passphrase again

#### Scenario: Failed clone or init is reported
- **WHEN** `git clone` or `git init` exits non-zero
- **THEN** the dashboard shows the Git error output and no workspace is registered

### Requirement: Dashboard handles interactive clone progress
The dashboard SHALL show live terminal output and current phase for an in-progress clone and SHALL provide an always-available masked response input that writes one response to the clone terminal without displaying or retaining the submitted value. Recognizing a common credential, trust, or verification prompt MAY focus or label the response input, but unrecognized terminal prompts MUST remain answerable. The dashboard SHALL provide cancellation while the clone is active and SHALL report cancellation, timeout, clone failure, registration or session-start failure, and successful completion distinctly. On successful registration and session start, the dashboard SHALL navigate to the resulting workspace session. Once a clone reaches any terminal outcome, the prompt input and cancellation controls SHALL no longer appear active, while failure output remains visible and the clone form is available for retry.

#### Scenario: SSH passphrase is answered in the dashboard
- **WHEN** SSH requests the passphrase for a key that is not unlocked in the retained agent
- **THEN** the prompt appears in the clone output and the user can submit the passphrase through the masked response input
- **AND** the submitted passphrase is not added to the visible output

#### Scenario: HTTPS credentials are answered in the dashboard
- **WHEN** an HTTPS remote requests a username, password, or token
- **THEN** the prompt appears in the clone output and the user can submit each requested value through the response input

#### Scenario: Unrecognized prompt remains answerable
- **WHEN** Git or SSH emits an interactive prompt the dashboard does not recognize
- **THEN** the user can still read it in the streamed output and submit a response

#### Scenario: User cancels a clone
- **WHEN** the user activates cancel while a clone is running or waiting for input
- **THEN** the clone terminates, the dashboard reports it as cancelled, and no workspace is registered

#### Scenario: Clone fails and can be retried
- **WHEN** the clone reaches a failure or timeout
- **THEN** its output and terminal status remain visible
- **AND** prompt input and cancellation are hidden while the clone form is available for retry

#### Scenario: Clone succeeds after interaction
- **WHEN** the user supplies the required responses and the clone, registration, and session start all succeed
- **THEN** the dashboard reports completion and navigates to the new workspace session

### Requirement: Hub-served sessions expose hub navigation
When the SPA is served through a hub (a hub-session-shaped base path AND the hub API answering at the origin root), the sidebar header SHALL show a workspace switcher naming the current workspace, whose menu links to the hub dashboard and to every registered workspace (running state indicated; stopped workspaces labeled) and offers a sign-out entry. Outside a hub — plain `uatu serve`, a bare `--base-path` invocation — the affordance MUST stay hidden. (Desktop sessions are hub sessions and show the switcher.) The hub's brand header SHALL show the logo centered with the wordmark beneath it and no tagline.

#### Scenario: Switching workspaces from inside a session
- **WHEN** a user inside a hub-served session opens the workspace switcher
- **THEN** they see the hub dashboard link and the other workspaces with running/stopped state
- **AND** activating one navigates to that workspace's session URL

#### Scenario: No hub affordance outside a hub
- **WHEN** the SPA runs under plain `uatu serve` (default base path) or under a base path with no hub answering at the origin root
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
