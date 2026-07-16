## ADDED Requirements

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

## MODIFIED Requirements

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
