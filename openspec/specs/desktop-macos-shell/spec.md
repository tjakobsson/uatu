# desktop-macos-shell Specification

## Purpose

Define the UatuCode Desktop macOS app: a native hub client that presents a launcher splash with one card per configured hub, reflects hub lifecycle states in each window's UI, and exposes window and navigation commands through the menu bar. The app runs no server of its own — workspaces and sessions belong to hubs.
## Requirements
### Requirement: Native tabs preserve independent window state and server lifecycle
Each UatuCode Desktop tab SHALL be a native macOS window grouped by AppKit rather than an application-defined tab. Each tab SHALL retain its own page (splash, hub dashboard, or workspace session) and web view. Tabs MUST NOT own server processes: sessions belong to their hub, so switching tabs, moving a tab between native window groups, moving a tab into a separate window, or closing a tab MUST NOT stop any session. Two tabs MAY show the same workspace session.

#### Scenario: Switching tabs preserves sessions
- **WHEN** two tabs show different workspace sessions and the user switches between them
- **THEN** both sessions continue running
- **AND** returning to either tab shows its existing page

#### Scenario: Closing a tab leaves its session running
- **WHEN** the user closes a tab showing a running workspace session
- **THEN** the session keeps running on its hub
- **AND** reopening the hub from the splash reconnects to the same session

### Requirement: Menu bar exposes window and navigation commands
The app SHALL provide a native "New Tab" command (Command-T) that opens a splash window as a tab in the focused window's macOS tab group. If no window is focused, the command SHALL open a standalone splash window. The standard "New Window" command (Command-N) SHALL remain available and SHALL create a separate window. The app SHALL provide Safari-like tab navigation: Command-1 through Command-8 SHALL select the corresponding positional tab when present, Command-9 SHALL select the last tab, and Control-Tab / Control-Shift-Tab SHALL select the next / previous tab using native AppKit ordering. The Window menu SHALL list each visible native tab group or standalone window once rather than exposing every tab's backing window as a separate window. The app SHALL also provide menu commands targeting the focused window: reload page (Command-R), open the current page in the default browser (Shift-Command-O), and toggle the split browser pane (Shift-Command-B). Commands whose destination is unavailable MUST be disabled.

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

#### Scenario: Open in browser hands the page to the default browser
- **WHEN** the user invokes "Open in Browser" on a window showing a hub page
- **THEN** that page's URL opens in the system default browser

#### Scenario: Toggle Split Browser opens or closes the pane
- **WHEN** the user invokes "Toggle Split Browser" on a window with an open page
- **THEN** the focused window's split browser pane opens (with an empty new tab if none exist) or closes

#### Scenario: Commands disabled without an open page
- **WHEN** the focused window shows the splash
- **THEN** "Reload Page", "Open in Browser", and "Toggle Split Browser" are disabled

### Requirement: Web page JavaScript dialogs present natively
JavaScript `alert()` and `confirm()` raised by pages in the embedded WebView SHALL present as native panels and return the user's choice to the page. WKWebView shows no JS dialogs without app-provided implementations — it silently answers false — which would turn the hub dashboard's confirmation-gated actions (stop, initialize-and-serve) into dead controls.

#### Scenario: Dashboard confirmations work in the desktop
- **WHEN** a hub page calls `confirm()` (e.g. the dashboard's stop confirmation)
- **THEN** a native dialog appears in the window
- **AND** confirming returns true to the page so the action proceeds

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

### Requirement: Window chrome exposes Back and Forward for the embedded SPA
The app SHALL provide Back and Forward controls — menu commands with `⌘[` and `⌘]` shortcuts and window-toolbar buttons — that navigate the embedded page's back-forward history. Controls MUST be disabled when the corresponding direction has no history entry or no server is running. While the split browser pane has keyboard focus, the `⌘[`/`⌘]` shortcuts SHALL act on the focused browser tab's history instead (see `desktop-split-browser`); the menu items and toolbar buttons continue to reflect the embedded page's history.

#### Scenario: Shortcuts follow the focused browser tab

- **WHEN** the split browser pane has keyboard focus and the user presses `⌘[`
- **THEN** the focused browser tab navigates back and the uatu pane's history is untouched

#### Scenario: Back returns to the previously selected document

- **WHEN** the user selects document A, then document B, then invokes Back
- **THEN** the preview shows document A again, and Forward becomes enabled

#### Scenario: Controls disabled at history edges

- **WHEN** a window has just loaded its first page
- **THEN** both Back and Forward controls are disabled

### Requirement: Windows use a transparent full-height content layout
Content windows SHALL use a full-size content layout: the hosted web view
SHALL span the full window frame including the titlebar region, the titlebar
SHALL be transparent with the window title hidden, and the toolbar controls
(back/forward navigation, split-browser toggle) SHALL float over the content
as system glass material so the page is visible beneath them. Window dragging
via the titlebar region and toolbar interaction MUST keep working at every
horizontal position across the window — over the SPA web view (including a
right-docked terminal column) and over the split-browser pane alike; page
content in the covered strip is visible but not interactive, matching
system-browser behavior.

#### Scenario: Page content reaches the top window edge
- **WHEN** a folder is being served and the SPA is loaded in a window
- **THEN** the page's rendered content extends to the top edge of the window
- **AND** the toolbar renders as glass over the page rather than on an opaque
  bar

#### Scenario: Window remains draggable by the top region
- **WHEN** the user drags in the titlebar region above the content
- **THEN** the window moves, and clicks on toolbar controls activate those
  controls, not the page beneath

#### Scenario: Dragging works over the SPA side, not only the split pane
- **WHEN** the user drags in the titlebar strip above the SPA web view —
  including above the sidebar, the preview, and a right-docked terminal —
  with or without the split browser open
- **THEN** the window moves, exactly as it does when dragging above the
  split-browser pane

### Requirement: Non-running states render correctly under the transparent titlebar
The launcher, starting, and failure states SHALL render correctly with the
transparent titlebar: no control or text in those layouts may be obscured by
the traffic lights or floating toolbar.

#### Scenario: Launcher under the transparent titlebar
- **WHEN** a window shows the launcher (no folder open)
- **THEN** the logo and the hub cards are fully visible
  and clickable

### Requirement: Native tabbing remains correct with full-height content
Native window tabs SHALL continue to work with the full-size content layout:
opening a second tab shows the native tab bar, tab switching works, and the
wrapper reflects the resulting change in covered chrome height to the hosted
page (per the desktop-titlebar-inset capability).

#### Scenario: Opening a second native tab
- **WHEN** the user opens a new tab in a content window
- **THEN** the native tab bar appears and both tabs remain fully usable
- **AND** each tab's hosted page receives the updated titlebar inset

### Requirement: The find shortcut reaches the surface that has focus

The wrapper SHALL ensure no menu item silently claims `⌘F`, `⌘G`, or `⇧⌘G` on
behalf of a responder that cannot act on them. Because `NSMenu` performs the
first matching key equivalent even when the item is disabled, the wrapper SHALL
NOT rely on menu-item enablement to express focus-dependent routing; routing
SHALL be resolved at press time from the window's first responder.

#### Scenario: Find in the embedded SPA

- **WHEN** the embedded uatu web view has focus and the user presses `⌘F`
- **THEN** the key reaches the page and uatu's own find opens

#### Scenario: Find in the split browser

- **WHEN** the split browser has focus and the user presses `⌘F`
- **THEN** the wrapper's native find bar opens over the browser tab and the page's find does not

#### Scenario: Stock text-finding menu items do not intercept

- **WHEN** the app's menu bar is built
- **THEN** no inherited text-editing Find item is left bound to `⌘F` targeting a responder that ignores it

### Requirement: Menu bar exposes find commands for the focused surface

The Edit menu SHALL expose Find, Find Next, and Find Previous with their
standard key equivalents, so the shortcuts are discoverable. These items SHALL
be enabled whenever a window with a running server is focused, and their action
SHALL resolve the target surface when invoked rather than when the menu was
last rebuilt.

#### Scenario: Find is discoverable in the menu

- **WHEN** the user opens the Edit menu with a running window focused
- **THEN** Find, Find Next, and Find Previous are present and enabled with their standard shortcuts

#### Scenario: Menu action follows focus changes

- **WHEN** the user moves focus from the SPA to the split browser and then chooses Edit ▸ Find
- **THEN** find opens over the split browser, not the SPA

### Requirement: Launcher presents the hub splash for configured hubs
When a window has no open page, the app SHALL show a splash with the app identity and one card per configured hub. Each card SHALL show the hub's name or host and SHALL reflect live state — reachable with a running-session summary and the hub's version, sign-in required, or unreachable — refreshed while the splash is visible. The splash is for choosing and configuring hubs only: it MUST NOT list individual workspaces or sessions — each hub's own dashboard is the single workspace listing and management surface, so dashboard improvements reach desktop users without native duplication. Activating a card SHALL open that hub's dashboard in the window. When no hub is configured, the splash SHALL present the add-hub flow and SHALL explain that uatu runs as a hub the app connects to (with `uatu hub` named as the way to run one).

#### Scenario: Splash shows hub cards with live state
- **WHEN** the user opens a new window while one hub is signed in and another is unreachable
- **THEN** the splash shows both cards, with a running summary and version for the reachable hub and distinct sign-in/unreachable states for the other
- **AND** no card lists individual workspaces

#### Scenario: Workspaces are reached through the hub dashboard
- **WHEN** the user activates a hub card
- **THEN** the window shows that hub's dashboard
- **AND** activating a workspace there navigates to its session in the same window

#### Scenario: First run explains the model
- **WHEN** the app starts with no configured hubs
- **THEN** the splash presents the add-hub flow and states that the app connects to a running `uatu hub`

### Requirement: Window reflects hub lifecycle states
Each window SHALL present distinct states for: no page open (splash), page opening (progress — connecting to the hub or session starting), page open (web view), and failed (the connection or authentication error, with retry and back-to-splash actions). If the backing hub becomes unavailable while a page is open — it stops answering or the session is revoked — the window MUST transition to the failed state (or the sign-in flow for auth failures) rather than showing a dead web view.

#### Scenario: Hub becomes unreachable
- **WHEN** the network drops while a hub's session page is open
- **THEN** the window transitions to the failed state naming the hub rather than showing a dead web view

#### Scenario: Session start fails
- **WHEN** a workspace session fails to start through the hub
- **THEN** the window shows the failure state with the hub's reported error
- **AND** offers retry and back-to-splash actions

