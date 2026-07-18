# Delta: desktop-macos-shell — external links default to the split browser

## MODIFIED Requirements

### Requirement: External links open outside the embedded WebView
The app SHALL route link activations that target a new browsing context (`target="_blank"` anchors, `window.open()` calls, terminal OSC 8 hyperlink activation) out of the embedded WebView. By default, `http(s)` URLs open in the window's split browser pane (per the `desktop-split-browser` capability); when the "Open external links in system browser" setting is enabled, or the user `⌘`-clicks, they open in the user's default browser instead. Other schemes are always handed to their registered system handler. The WebView MUST NOT silently drop such activations.

#### Scenario: External link in a rendered document

- **WHEN** the user clicks an external `https://` link in a rendered
  Markdown document with default settings
- **THEN** the URL opens in the window's split browser pane and the uatu
  pane keeps its current document

#### Scenario: Opt-out restores system-browser behavior

- **WHEN** "Open external links in system browser" is enabled and the user
  clicks an external `https://` link
- **THEN** the URL opens in the user's default browser and the split is
  unchanged

#### Scenario: Hyperlink printed by a terminal program

- **WHEN** a TUI in the embedded terminal emits an OSC 8 hyperlink and the
  user activates it with default settings
- **THEN** the URL opens in the window's split browser pane

#### Scenario: Non-http scheme

- **WHEN** the user clicks a `mailto:` link
- **THEN** the system's registered mail handler opens

### Requirement: Menu bar exposes window and navigation commands
The app SHALL provide a native "New Tab" command (Command-T) that opens a blank launcher window as a tab in the focused window's macOS tab group. If no window is focused, the command SHALL open a standalone launcher window. The standard "New Window" command (Command-N) SHALL remain available and SHALL create a separate window. The app SHALL provide Safari-like tab navigation: Command-1 through Command-8 SHALL select the corresponding positional tab when present, Command-9 SHALL select the last tab, and Control-Tab / Control-Shift-Tab SHALL select the next / previous tab using native AppKit ordering. The Window menu SHALL list each visible native tab group or standalone window once rather than exposing every tab's backing window as a separate window. The app SHALL also provide menu commands targeting the focused window: choose folder (Command-O), an Open Recent submenu with a clear action, reload page (Command-R), open the current session in the default browser (Shift-Command-O), and toggle the split browser pane (Shift-Command-B). Commands whose destination is unavailable MUST be disabled.

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

#### Scenario: Toggle Split Browser opens or closes the pane
- **WHEN** the user invokes "Toggle Split Browser" on a window with a running server
- **THEN** the focused window's split browser pane opens (with an empty new tab if none exist) or closes

#### Scenario: Commands disabled without a running server
- **WHEN** the focused window shows the launcher
- **THEN** "Reload Page", "Open in Browser", and "Toggle Split Browser" are disabled
