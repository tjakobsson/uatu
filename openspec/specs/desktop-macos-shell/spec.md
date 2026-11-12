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

Native menus SHALL provide New Tab, New Window, positional and sequential tab navigation, and focused-window reload, external opening, and split-browser commands with the shortcuts below. The Window menu SHALL list each visible native tab group or standalone window once, not each tab's backing window. Commands with unavailable destinations MUST be disabled.

#### Scenario: Create windows and select native tabs by shortcut
- **WHEN** Command-T is invoked
- **THEN** a splash opens in the focused window's native tab group, or standalone if no window is focused
- **AND** Command-N remains available to create a separate window

#### Scenario: Use positional and sequential tab shortcuts
- **WHEN** Command-1 through Command-8 select a position that exists
- **THEN** the corresponding native tab is selected
- **AND** Command-9 selects the last tab; Control-Tab / Control-Shift-Tab select next / previous in native AppKit order

#### Scenario: Invoke a focused-window page command
- **WHEN** an available page command is invoked by menu or shortcut
- **THEN** Command-R reloads the focused page, Shift-Command-O opens it in the default browser, and Shift-Command-B toggles its split browser pane

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

The embedded WebView SHALL present `alert()`, `confirm()`, and `prompt()` as native window-attached panels and return the user's answer. File inputs SHALL use the system open panel, honor single-or-multiple selection, and return chosen files or none on cancel. WKWebView otherwise silently answers false, null, or nothing, disabling dashboard confirmations and private-key selection.

#### Scenario: Complete a JavaScript dialog
- **WHEN** any embedded page calls `alert()`, `confirm()`, or `prompt()`
- **THEN** alert returns after dismissal, confirm returns true only on confirmation, and prompt returns entered text on OK or null on Cancel
- **AND** the prompt field is prefilled with the page's default text

#### Scenario: Choose multiple files when the input permits them
- **WHEN** an embedded page activates `<input type="file">`
- **THEN** the system picker permits one or multiple files according to that input and returns the selected files; cancellation returns none

#### Scenario: Dashboard confirmations work in the desktop
- **WHEN** a hub page calls `confirm()` (e.g. the dashboard's stop confirmation)
- **THEN** a native dialog appears in the window
- **AND** confirming returns true to the page so the action proceeds

#### Scenario: A prompt returns the entered text
- **WHEN** a page in the embedded WebView calls `prompt("Name?", "draft")`
- **THEN** a native panel with a text field prefilled with `draft` appears
- **AND** OK returns the field's text to the page and Cancel returns null

#### Scenario: A file input opens the system picker
- **WHEN** the user activates the hub dashboard's "Private key file" input
- **THEN** the system open panel appears
- **AND** choosing a file populates the input, and cancelling leaves it empty

### Requirement: External links open outside the embedded WebView

New-browsing-context link activations SHALL leave the embedded WebView. Web URLs SHALL use the split pane by default (per `desktop-split-browser`) or the system browser when configured or explicitly requested; other schemes SHALL use their registered handlers. The WebView MUST NOT silently drop these activations.

#### Scenario: Route every supported new-context activation
- **WHEN** a `target="_blank"` anchor, `window.open()` call, or terminal OSC 8 hyperlink is activated
- **THEN** `http(s)` opens in the window's split pane by default, or in the default browser if "Open external links in system browser" is enabled or the user `⌘`-clicks
- **AND** other schemes go to their registered system handler; the WebView MUST NOT silently drop the activation

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

Window menus and toolbar controls SHALL expose embedded-page Back and Forward navigation with appropriate disabled states. Back/Forward shortcuts SHALL instead target the focused split-browser tab while that pane has keyboard focus (see `desktop-split-browser`).

#### Scenario: Inspect native history controls and shortcuts
- **WHEN** the window exposes its menu and toolbar navigation
- **THEN** Back and Forward are available as menu commands with `⌘[` and `⌘]` and as toolbar buttons for embedded-page history
- **AND** each control MUST be disabled if its direction has no history entry or no server is running

#### Scenario: Split-browser focus changes only the shortcut target
- **WHEN** the split-browser pane has keyboard focus
- **THEN** `⌘[` and `⌘]` navigate the focused browser tab, while menu items and toolbar buttons still reflect embedded-page history

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

Content windows SHALL place the WebView across the full frame beneath transparent native chrome and floating system-glass toolbar controls. Titlebar dragging and toolbar interaction MUST remain usable across the window width.

#### Scenario: Render full-height content beneath native glass
- **WHEN** a content window is displayed
- **THEN** its WebView spans the whole frame including the titlebar; the titlebar is transparent and the window title hidden
- **AND** back/forward and split-browser toolbar controls float as system glass with page content visible beneath

#### Scenario: Native chrome covers any horizontal window region
- **WHEN** a drag or toolbar interaction occurs anywhere across the titlebar, above the SPA, right-docked terminal, or split browser
- **THEN** window dragging and toolbar interaction MUST work there, while covered page content remains visible but non-interactive

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

A window with no open page SHALL show the app identity and one live card per configured Hub, opening that Hub's dashboard on activation. The splash MUST NOT list individual workspaces or sessions; the Hub dashboard remains their management surface. With no configured Hub, the splash SHALL offer add-Hub and explain the connect-only model, naming `uatu hub` as the way to run a Hub.

#### Scenario: Keep every configured Hub card current
- **WHEN** the splash is visible
- **THEN** each card shows its Hub name or host and refreshes its reachable, sign-in-required, or unreachable state
- **AND** reachable cards include a running-session summary and Hub version without listing individual workspaces or sessions

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
