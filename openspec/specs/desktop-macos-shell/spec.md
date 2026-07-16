# desktop-macos-shell Specification

## Purpose

Define the UatuCode Desktop macOS wrapper app: a native shell that supervises a bundled `uatu` server per window, presents a launcher with folder selection and recent folders, reflects server lifecycle states in each window's UI, and exposes window and navigation commands through the menu bar.

## Requirements

### Requirement: App supervises a bundled uatu server per window
UatuCode Desktop SHALL bundle a `uatu` binary inside the app bundle and, when a
folder is opened in a window, SHALL launch it directly as a child process (no
intermediate shell) with the arguments `serve <folder> --no-open
--exit-on-stdin-close`. Each window SHALL own exactly one server process. The
app MUST read the child's standard output and treat the first line matching
`http://…` as the session URL, including its auth token. The app MUST terminate
a window's server process when that window closes, and MUST terminate every
remaining child server process when the app quits.

Because GUI apps inherit launchd's minimal environment while uatu's embedded
terminal spawns a non-login shell that inherits uatu's, the app MUST resolve
the user's login-shell environment (their `$SHELL` run as a login shell) once
per app run and launch every uatu child with it, so shells inside the embedded
terminal see the same `PATH` as the user's terminal. If the probe fails, the
app MUST still launch uatu with the GUI environment extended with the standard
user binary directories (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`).

#### Scenario: Embedded terminal sees the user's PATH
- **WHEN** the user's shell rc references tools installed via Homebrew (e.g. starship)
- **AND** a folder is served from a window of the app
- **THEN** a shell opened in the embedded terminal resolves those tools without "command not found" errors

#### Scenario: Opening a folder starts a server and loads the UI
- **WHEN** the user opens a folder in a window
- **THEN** the app launches the bundled `uatu serve <folder> --no-open --exit-on-stdin-close`
- **AND** loads the URL printed on the child's standard output in the window's web view

#### Scenario: Two windows serve two folders independently
- **WHEN** the user opens folder A in one window and folder B in another
- **THEN** each window supervises its own server process
- **AND** closing one window's server does not affect the other

#### Scenario: Closing a window stops its server
- **WHEN** the user closes a window whose server is running
- **THEN** that window's server process is terminated
- **AND** servers owned by other windows keep running

#### Scenario: Quitting the app leaves no server behind
- **WHEN** the user quits the app while servers are running
- **THEN** every child server process is terminated

#### Scenario: The app crashes while a server is running
- **WHEN** the app process dies without running its termination handlers
- **THEN** the child server exits on its own because its standard input reached EOF

### Requirement: Launcher offers folder selection and recent folders
When a window has no served folder, the app SHALL show a launcher with the app
identity, a folder picker, and a list of recently served folders (most recent
first, shared across windows, bounded in length). Selecting a recent entry or
picking a folder SHALL start a server for it and record it as the most recent
entry.

#### Scenario: Reopening a recent folder
- **WHEN** the user clicks an entry in the recents list
- **THEN** a server starts for that folder and the entry moves to the top of the list

#### Scenario: Recents persist across app restarts
- **WHEN** the user quits and relaunches the app
- **THEN** the previously served folders still appear in the recents list

### Requirement: Window reflects server lifecycle states
Each window SHALL present distinct states for: no folder chosen (launcher),
server starting (progress), server running (web view), and server failed (error
detail including recent server output, with retry and choose-folder actions).
If a running server exits unexpectedly, the window MUST transition to the failed
state rather than showing a dead web view.

#### Scenario: Server fails to start
- **WHEN** the child process exits before printing a URL
- **THEN** the window shows the failure state with the tail of the server output
- **AND** offers "Try Again" and "Choose Folder…" actions

#### Scenario: Running server dies
- **WHEN** the child process exits after the UI was loaded
- **THEN** the window transitions from the web view to the failure state

### Requirement: Native tabs preserve independent window state and server lifecycle
Each UatuCode Desktop tab SHALL be a native macOS window grouped by AppKit rather than an application-defined tab. Each tab SHALL retain its own launcher or served folder, web view, and `UatuServer` process. Switching tabs, moving a tab between native window groups, or moving a tab into a separate window MUST NOT restart or terminate its server. Closing a tab with a running server MUST terminate only that tab's server.

#### Scenario: Switching tabs preserves both servers
- **WHEN** two tabs are serving different folders and the user switches between them
- **THEN** both tabs' server processes continue running
- **AND** returning to either tab shows its existing session

#### Scenario: Moving a tab preserves its server
- **WHEN** a running tab is moved to another native window group or detached into its own window
- **THEN** its server process and loaded session continue without restarting

#### Scenario: Closing one tab stops only its server
- **WHEN** the user closes one running tab in a group containing another running tab
- **THEN** the closed tab's server process is terminated
- **AND** the other tab's server process continues running

### Requirement: Menu bar exposes window and navigation commands
The app SHALL provide a native "New Tab" command (Command-T) that opens a blank launcher window as a tab in the focused window's macOS tab group. If no window is focused, the command SHALL open a standalone launcher window. The standard "New Window" command (Command-N) SHALL remain available and SHALL create a separate window. The app SHALL provide Safari-like tab navigation: Command-1 through Command-8 SHALL select the corresponding positional tab when present, Command-9 SHALL select the last tab, and Control-Tab / Control-Shift-Tab SHALL select the next / previous tab using native AppKit ordering. The Window menu SHALL list each visible native tab group or standalone window once rather than exposing every tab's backing window as a separate window. The app SHALL also provide menu commands targeting the focused window: choose folder (Command-O), an Open Recent submenu with a clear action, reload page (Command-R), and open the current session in the default browser (Shift-Command-O). Commands whose destination is unavailable MUST be disabled.

#### Scenario: New Tab joins the focused window
- **WHEN** the user invokes "New Tab" while a UatuCode window is focused
- **THEN** the app creates a native tab in that window's tab group
- **AND** the new tab shows the blank folder launcher

#### Scenario: New Tab works without a focused window
- **WHEN** the user invokes "New Tab" while no UatuCode window is focused
- **THEN** the app opens a standalone window showing the blank folder launcher

#### Scenario: New Window remains separate
- **WHEN** the user invokes the standard "New Window" command
- **THEN** the app opens a separate launcher window rather than forcing it into the focused tab group

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

#### Scenario: Open in browser hands the session to the default browser
- **WHEN** the user invokes "Open in Browser" on a window with a running server
- **THEN** the tokened session URL opens in the system default browser

#### Scenario: Commands disabled without a running server
- **WHEN** the focused window shows the launcher
- **THEN** "Reload Page" and "Open in Browser" are disabled
