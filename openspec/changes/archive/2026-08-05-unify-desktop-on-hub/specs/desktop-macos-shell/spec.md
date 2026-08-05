# desktop-macos-shell — delta for unify-desktop-on-hub

## REMOVED Requirements

### Requirement: App supervises a bundled uatu server per window
**Reason**: Windows no longer own server processes; the app supervises one local hub and windows are hub clients.
**Migration**: Replaced by "App supervises a single local hub" below, which carries over the bundled-binary, stdout-URL, login-shell-environment, and termination/backstop contracts at the hub level.

### Requirement: Launcher offers folder selection and recent folders
**Reason**: The launcher becomes the hub splash; the recents list is superseded by the local hub's registered workspaces.
**Migration**: Replaced by "Launcher presents the hub splash" below. Existing recents are imported into the local hub registry once (best-effort, missing paths skipped).

## ADDED Requirements

### Requirement: App supervises a single local hub
UatuCode Desktop SHALL bundle a `uatu` binary inside the app bundle and, at app launch, SHALL launch it directly as a child process (no intermediate shell) with the arguments `hub --local --port 0 --exit-on-stdin-close`. The app SHALL own exactly one hub process regardless of how many windows are open. The app MUST read the child's standard output and treat the first line matching `http://…` as the local hub's base URL. The app MUST terminate the hub process when the app quits (after the quit confirmation, when applicable), and the hub's stdin-close backstop covers the crash path. If the hub process exits unexpectedly, the app SHALL surface a native failure state (with the tail of the hub's output and a relaunch action) in affected windows rather than dead web views, and relaunching SHALL restore the splash.

Because GUI apps inherit launchd's minimal environment while uatu's embedded terminal spawns a non-login shell that inherits uatu's, the app MUST resolve the user's login-shell environment (their `$SHELL` run as a login shell) once per app run and launch the hub with it, so shells inside embedded terminals of every session see the same `PATH` as the user's terminal. If the probe fails, the app MUST still launch the hub with the GUI environment extended with the standard user binary directories (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`).

#### Scenario: One hub serves many windows
- **WHEN** the user opens three windows/tabs on local workspaces
- **THEN** exactly one bundled hub process is running and every window is served through it

#### Scenario: Embedded terminal sees the user's PATH
- **WHEN** the user's shell rc references tools installed via Homebrew (e.g. starship)
- **AND** a local workspace session is opened from the app
- **THEN** a shell in that session's embedded terminal resolves those tools without "command not found" errors

#### Scenario: Quitting the app leaves no processes behind
- **WHEN** the user quits the app (confirming the warning if it appears)
- **THEN** the hub process and every session child it owns are terminated

#### Scenario: The app crashes while the hub is running
- **WHEN** the app process dies without running its termination handlers
- **THEN** the hub exits on its own because its standard input reached EOF, taking its session children with it

#### Scenario: The hub dies out from under the app
- **WHEN** the local hub process exits unexpectedly
- **THEN** windows on local pages show a native failure state with a relaunch action instead of a dead web view

### Requirement: Launcher presents the hub splash
When a window has no open page, the app SHALL show a splash with the app identity, a folder picker, and one card per hub: "This Mac" (the local hub) first, then each configured remote hub. The local card SHALL be captioned to say it runs only while the app is open; remote cards SHALL show the hub's name or host. Each card SHALL reflect live state — reachable with a running-session summary and the hub's version, sign-in required, or unreachable — refreshed while the splash is visible. The splash is for choosing and configuring hubs only: it MUST NOT list individual workspaces or sessions — each hub's own dashboard is the single workspace listing and management surface, so dashboard improvements reach desktop users without native duplication. Activating a card SHALL open that hub's dashboard in the window. Picking a folder SHALL register it with the local hub (subject to the initialization handshake) and open its session.

#### Scenario: Splash shows hub cards with live state
- **WHEN** the user opens a new window while one remote hub is signed in and another is unreachable
- **THEN** the splash shows "This Mac" plus both remote cards, with running summaries and version for the reachable hubs and distinct sign-in/unreachable states for the others
- **AND** no card lists individual workspaces

#### Scenario: Workspaces are reached through the hub dashboard
- **WHEN** the user activates a hub card
- **THEN** the window shows that hub's dashboard
- **AND** activating a workspace there navigates to its session in the same window

#### Scenario: Choosing a folder registers it with the local hub
- **WHEN** the user picks a git-repository folder with the folder picker
- **THEN** the folder is registered as a local hub workspace, its session starts, and the window shows it
- **AND** it appears on the local hub's dashboard and in the Open Recent menu

#### Scenario: Recents import once
- **WHEN** the user first launches a version with the hub splash, having recents from an earlier version
- **THEN** each still-existing recent folder appears as a registered local workspace
- **AND** recents whose folders no longer exist are skipped silently

### Requirement: Web page JavaScript dialogs present natively
JavaScript `alert()` and `confirm()` raised by pages in the embedded WebView SHALL present as native panels and return the user's choice to the page. WKWebView shows no JS dialogs without app-provided implementations — it silently answers false — which would turn the hub dashboard's confirmation-gated actions (stop, initialize-and-serve) into dead controls.

#### Scenario: Dashboard confirmations work in the desktop
- **WHEN** a hub page calls `confirm()` (e.g. the dashboard's stop confirmation)
- **THEN** a native dialog appears in the window
- **AND** confirming returns true to the page so the action proceeds

### Requirement: Quitting warns when local sessions have live terminal shells
The app SHALL intercept quit. When no local session is running, or none has live terminal shells, quit SHALL proceed silently. Otherwise the app SHALL present a confirmation listing each affected local workspace with its shell count, stating that sessions on this Mac will stop and that remote sessions are unaffected. Cancel SHALL abort termination entirely; confirming SHALL terminate the hub (which stops its sessions) and quit. The shell information SHALL come from the local hub's state API.

#### Scenario: Quiet quit with nothing to lose
- **WHEN** the user quits while local sessions run but no terminal shells are open in any of them
- **THEN** the app quits without a confirmation dialog

#### Scenario: Live shells prompt a confirmation
- **WHEN** the user quits while a local session has two terminal shells
- **THEN** a dialog names the workspace and its shell count and notes that remote sessions are unaffected
- **AND** cancel leaves everything running while confirm stops the hub and quits

## MODIFIED Requirements

### Requirement: Opening a non-git folder offers repository initialization
Folder registration SHALL go through the hub's initialization handshake: the app submits the picked folder to the local hub, and when the hub answers that the folder needs initialization (its probe definitively found no repository), the app SHALL present a confirmation dialog offering to initialize a new git repository there. On confirmation the app SHALL resubmit with initialization requested, and the hub runs `git init`, registers, and serves the folder. On decline the app MUST NOT register or serve the folder: a window with no open page SHALL show the splash, while a window with a running session SHALL keep it untouched. If initialization fails hub-side, the app SHALL surface the git error output in the window's failure state. When the hub's probe cannot determine repository state, the hub starts the session and the CLI's own git preflight reports; the app SHALL NOT run its own git probe or `git init`. The app MUST NOT cause `--force` to be passed to the server.

#### Scenario: Non-git folder is initialized and served
- **WHEN** the user picks a folder that is not inside a git worktree
- **AND** confirms the initialization dialog
- **THEN** the folder is registered with initialization requested, the hub runs `git init`, and the session opens as usual

#### Scenario: Declining initialization returns to the splash
- **WHEN** the user picks a non-git folder from the splash and declines the initialization dialog
- **THEN** nothing is registered or started
- **AND** the window shows the splash again

#### Scenario: Declining with a running session keeps the session
- **WHEN** a window is showing a session and the user picks a non-git folder via the choose-folder command
- **AND** declines the initialization dialog
- **THEN** nothing is registered for the declined folder
- **AND** the window's existing session keeps running unchanged

#### Scenario: Git folder opens without any dialog
- **WHEN** the user picks a folder inside an existing git worktree (including a subdirectory of a repository)
- **THEN** no initialization dialog appears
- **AND** the session opens immediately

#### Scenario: git init fails
- **WHEN** the user confirms initialization and the hub's `git init` exits non-zero
- **THEN** the window shows the failure state including the git error output

### Requirement: Window reflects server lifecycle states
Each window SHALL present distinct states for: no page open (splash), page opening (progress — hub starting, session starting, or remote hub connecting), page open (web view), and failed (error detail with retry and back-to-splash actions — local hub output for local failures, the connection or authentication error for remote ones). If the backing hub becomes unavailable while a page is open — the local hub exits, or a remote hub stops answering — the window MUST transition to the failed state rather than showing a dead web view.

#### Scenario: Local session fails to start
- **WHEN** a workspace session fails to start through the local hub
- **THEN** the window shows the failure state with the relevant hub/session output
- **AND** offers retry and back-to-splash actions

#### Scenario: Remote hub becomes unreachable
- **WHEN** the network drops while a remote hub's session page is open
- **THEN** the window transitions to the failed state naming the hub rather than showing a dead web view

### Requirement: Native tabs preserve independent window state and server lifecycle
Each UatuCode Desktop tab SHALL be a native macOS window grouped by AppKit rather than an application-defined tab. Each tab SHALL retain its own page (splash, hub dashboard, or workspace session) and web view. Tabs MUST NOT own server processes: sessions belong to their hub, so switching tabs, moving a tab between native window groups, moving a tab into a separate window, or closing a tab MUST NOT stop any session. Two tabs MAY show the same workspace session.

#### Scenario: Switching tabs preserves sessions
- **WHEN** two tabs show different workspace sessions and the user switches between them
- **THEN** both sessions continue running
- **AND** returning to either tab shows its existing page

#### Scenario: Closing a tab leaves its session running
- **WHEN** the user closes a tab showing a running local workspace session
- **THEN** the session keeps running on the local hub
- **AND** reopening it from the splash reconnects to the same session

### Requirement: Menu bar exposes window and navigation commands
The app SHALL provide a native "New Tab" command (Command-T) that opens a splash window as a tab in the focused window's macOS tab group. If no window is focused, the command SHALL open a standalone splash window. The standard "New Window" command (Command-N) SHALL remain available and SHALL create a separate window. The app SHALL provide Safari-like tab navigation: Command-1 through Command-8 SHALL select the corresponding positional tab when present, Command-9 SHALL select the last tab, and Control-Tab / Control-Shift-Tab SHALL select the next / previous tab using native AppKit ordering. The Window menu SHALL list each visible native tab group or standalone window once rather than exposing every tab's backing window as a separate window. The app SHALL also provide menu commands targeting the focused window: choose folder (Command-O), an Open Recent submenu listing the local hub's workspaces, reload page (Command-R), open the current page in the default browser (Shift-Command-O), and toggle the split browser pane (Shift-Command-B). Commands whose destination is unavailable MUST be disabled.

#### Scenario: New Tab joins the focused window
- **WHEN** the user invokes "New Tab" while a UatuCode window is focused
- **THEN** the app creates a native tab in that window's tab group
- **AND** the new tab shows the splash

#### Scenario: New Tab works without a focused window
- **WHEN** the user invokes "New Tab" while no UatuCode window is focused
- **THEN** the app opens a standalone window showing the splash

#### Scenario: New Window remains separate
- **WHEN** the user invokes the standard "New Window" command
- **THEN** the app opens a separate splash window rather than forcing it into the focused tab group

#### Scenario: Numbered shortcuts select tabs
- **WHEN** a native window group contains at least four tabs
- **AND** the user invokes Command-3
- **THEN** the third tab becomes selected

#### Scenario: Command-9 selects the last tab
- **WHEN** a native window group contains any number of multiple tabs
- **AND** the user invokes Command-9
- **THEN** the final tab in native tab order becomes selected

#### Scenario: Control-Tab navigates native tab order
- **WHEN** a native window group contains multiple tabs
- **AND** the user invokes Control-Tab or Control-Shift-Tab
- **THEN** AppKit selects the next or previous tab respectively

#### Scenario: Window menu represents a tab group once
- **WHEN** one native window group contains multiple tabs
- **THEN** the Window menu's window list contains one entry for that group
- **AND** its title reflects the group's selected tab

#### Scenario: Separate windows remain separately selectable
- **WHEN** the app has multiple standalone windows or native tab groups
- **THEN** the Window menu's window list contains one selectable entry for each window or group

#### Scenario: Open Recent lists local workspaces
- **WHEN** the user opens the Open Recent submenu
- **THEN** it lists the local hub's registered workspaces
- **AND** activating one opens that workspace's session in the focused window

#### Scenario: Open in browser hands the page to the default browser
- **WHEN** the user invokes "Open in Browser" on a window showing a hub page
- **THEN** that page's URL opens in the system default browser

#### Scenario: Toggle Split Browser opens or closes the pane
- **WHEN** the user invokes "Toggle Split Browser" on a window with an open page
- **THEN** the focused window's split browser pane opens (with an empty new tab if none exist) or closes

#### Scenario: Commands disabled without an open page
- **WHEN** the focused window shows the splash
- **THEN** "Reload Page", "Open in Browser", and "Toggle Split Browser" are disabled
