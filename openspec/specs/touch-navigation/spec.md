# touch-navigation Specification

## Purpose
Provide a persistent per-device touch layout with full-screen Files, Preview, Chat, and Terminal tabs, live desktop-mode switching, and intent-driven surface navigation without disrupting background state.

Throughout this spec, "touch mode" and "desktop mode" are the two values of the
per-device UI mode; "wide viewport" means at or above the 900-pixel breakpoint that
also governs the desktop layout's stacking.

## Requirements

### Requirement: UI mode defaults by pointer type and persists per device
The client SHALL resolve a UI mode — `touch` or `desktop` — at boot and stamp it on the document root: a per-device stored override wins when present; otherwise coarse-pointer devices (iPhone AND iPad) default to `touch` and fine-pointer devices to `desktop`.

#### Scenario: Live mode switching changes layout without removing coarse-pointer input
- **WHEN** a client renders or switches UI mode
- **THEN** layout SHALL be keyed on the mode, while pointer-coarseness-gated affordances (touch keybar, size steppers, scroll-gesture routing) SHALL remain available in both modes on coarse-pointer devices
- **AND** switching modes SHALL take effect live without a page reload and SHALL persist per device

#### Scenario: iPad defaults to touch mode
- **WHEN** the app boots on a coarse-pointer tablet with no stored mode override
- **THEN** the UI renders in touch mode with the bottom tab bar

#### Scenario: Desktop browsers are untouched
- **WHEN** the app boots on a fine-pointer device with no stored override
- **THEN** the UI renders the desktop layout with no tab bar and no mode chrome

#### Scenario: Override survives reload
- **WHEN** a coarse-pointer device has switched to desktop mode and reloads
- **THEN** the UI boots straight into the desktop layout

### Requirement: The Files tab hosts the sidebar stack full-screen
The `Files` tab's surface SHALL be the existing sidebar pane stack (the visible panes — by default Change Overview and the Files tree) rendered full-screen, with the same tree DOM and state (expansion, selection, filter chip, follow-mode highlighting) as every other presentation of the tree — never a second tree instance.

#### Scenario: Files pane controls remain usable with touch gestures
- **WHEN** the sidebar stack is used inside Files
- **THEN** the per-pane visibility menu SHALL keep working
- **AND** on coarse-pointer devices each pane's header SHALL act as its gesture surface: dragging resizes the boundary above, rather than using the thin desktop resizer strip as a finger target
- **AND** on coarse-pointer devices double-tapping the header SHALL toggle collapse as a reachable version of the small − / + button, while taps on header controls keep working

#### Scenario: Tree state is continuous across tabs
- **WHEN** the user expands a directory in the Files tab, switches to Preview, and returns
- **THEN** the expansion state is exactly as they left it

#### Scenario: A pane header is the touch resize handle
- **WHEN** the user drags a pane's header vertically on a coarse-pointer device
- **THEN** the pane above it trades height with the dragged pane
- **AND** the new heights persist like a desktop resizer drag

#### Scenario: Double-tapping a pane header toggles its collapse
- **WHEN** the user double-taps a pane's header on a coarse-pointer device
- **THEN** the pane collapses (or expands, if collapsed), persisted exactly as the − / + button would
- **AND** a single tap changes nothing

### Requirement: A preview-bound navigation switches to the Preview tab
When the user explicitly navigates to preview content by selecting a filename in the tree or Recent, selecting a search result, or opening a commit or other preview destination, the UI SHALL switch to Preview. Directory expansion, Files view/query/filter controls, and media audition actions SHALL NOT switch tabs. A media Play action SHALL stay in Files and retain the current preview destination. Programmatic tree/Recent updates and Follow events MUST NOT switch tabs.

#### Scenario: Pick lands on Preview
- **WHEN** the user taps a filename in All, Recent, or Changed
- **THEN** Preview becomes active and shows that file without initiating media playback or interrupting an already active session

#### Scenario: A search result lands on Preview
- **WHEN** the user taps a project-search result in Files
- **THEN** Preview becomes active with the matched document

#### Scenario: File events do not steal the Files tab
- **WHEN** Files is active and a file event updates the tree or Recent
- **THEN** Files remains active without automatic playback

#### Scenario: Audition stays in Files
- **WHEN** the user activates a Recent media row's Play action
- **THEN** Files remains active and the current preview and URL remain unchanged

### Requirement: A surface-directed shortcut SHALL bring its surface forward
A keyboard shortcut that acts on a specific surface SHALL make that surface the active tab before it acts, so its affordance is never mounted or focused inside a hidden subtree.

#### Scenario: User shortcuts promote their target but background activity does not
- **WHEN** a surface-directed shortcut is pressed
- **THEN** `⌘F` SHALL target the preview and activate Preview, and `⇧⌘F` SHALL target the Search pane in the sidebar stack and activate Files

#### Scenario: Background activity never promotes a surface
- **WHEN** programmatic activity occurs, including follow-mode Rules C/D or file events, whether or not a user shortcut also occurs
- **THEN** it MUST NOT promote a surface; a shortcut the user presses is an act of intent, like explicit preview-bound navigation, so it may promote its surface

#### Scenario: Consumed shortcuts leave a visible usable affordance
- **WHEN** a shortcut consumes the key and suppresses the host's own handling
- **THEN** it MUST NOT leave the user with nothing visible to use

#### Scenario: Find brings the Preview tab forward
- **WHEN** the Files tab is active and the user presses `⌘F` on a hardware keyboard
- **THEN** the Preview tab becomes active and the find bar opens on it with its input focused

#### Scenario: Project search brings the Files tab forward
- **WHEN** the Preview or Terminal tab is active and the user presses `⇧⌘F` on a hardware keyboard
- **THEN** the Files tab becomes active with the Search pane visible and its query input focused

#### Scenario: The shortcut is not consumed without an effect
- **WHEN** a surface-directed shortcut suppresses the host's native handling of that key
- **THEN** the corresponding surface is visible and the affordance it opened is usable

#### Scenario: Programmatic activity still does not promote a surface
- **WHEN** a watched-file event or a follow-mode Rule C/D update changes the tree while the Files tab is active
- **THEN** the Files tab remains active and no surface is promoted

### Requirement: The Terminal tab preserves PTY attachment across switches
Selecting the `Terminal` tab SHALL show the terminal full-screen, spawning or reattaching exactly as the desktop toggle does. Switching to another tab SHALL keep every PTY attached (output keeps accumulating, as minimize does today) and MUST NOT tear down or detach panes; returning to the Terminal tab SHALL show the same session with accumulated output. The minimized header strip SHALL NOT render in touch mode — the tab is the return affordance.

#### Scenario: Long-running process survives tab switches
- **WHEN** a process is producing output in the Terminal tab and the user switches to Preview and back
- **THEN** the same PTY is attached and the accumulated output is visible

### Requirement: The sidebar chrome offers the mode switch — never the tab bar
On coarse-pointer devices the UI SHALL offer a single mode toggle in the sidebar header, inside Files in touch mode and in desktop chrome with a collapsed-sidebar rail variant in desktop mode. It SHALL switch touch/desktop renderings live, remain reachable at every viewport width, and persist the chosen mode per device. The tab bar SHALL contain only the four surface tabs, never a mode control.

#### Scenario: Coarse-pointer desktop mode remains a complete and escapable desktop layout
- **WHEN** a coarse-pointer device uses desktop mode, including after iPad landscape-to-portrait rotation
- **THEN** the UI SHALL render exactly as a desktop browser: sidebar, Preview-and-Chat split work area, docked terminal, and no tab bar
- **AND** the toggle SHALL remain available at every viewport width in both modes so the device cannot be stranded without a way back

#### Scenario: Mode changes normalize the previously active surfaces
- **WHEN** the user switches modes
- **THEN** the terminal SHALL return to its stored dock and display mode
- **AND** entering desktop with Chat active SHALL open the chat panel
- **AND** entering touch SHALL land on Chat only when the user was last working in an open chat panel, otherwise Preview
- **AND** no touch-only surface promotion SHALL remain

#### Scenario: iPad flips to the desktop rendering and back
- **WHEN** a user on a coarse-pointer viewport activates the mode toggle in the Files tab, works in the desktop layout, and then activates the toggle again
- **THEN** each switch re-renders live into the full target layout
- **AND** the last chosen mode is restored after a reload

#### Scenario: The tab bar carries no mode control
- **WHEN** the tab bar renders at any viewport width
- **THEN** it contains exactly the Files, Preview, Chat, and Terminal tabs

#### Scenario: Rotation cannot strand desktop mode
- **WHEN** a coarse-pointer device in desktop mode narrows below the wide breakpoint (e.g. iPad rotating to portrait) or collapses the sidebar
- **THEN** a mode toggle remains reachable and switches the device back to touch mode

#### Scenario: Leaving touch mode on the Chat tab keeps the conversation visible
- **WHEN** a user on the Chat tab switches to desktop mode
- **THEN** the chat panel is open beside Preview in the desktop rendering

### Requirement: The active tab persists per device
The active tab SHALL default to `Preview` on first use and SHALL persist per device, restoring on reload. Restoring the Terminal tab at boot SHALL follow the terminal's existing restore semantics (no PTY auto-spawn beyond what the persisted terminal state already implies, and no focus steal).

#### Scenario: Reload lands on the last tab
- **WHEN** the user was on the Files tab and reloads
- **THEN** the app boots into touch mode with the Files tab active

### Requirement: Touch mode shows a bottom tab bar with four surfaces
In touch mode the UI SHALL render a bottom tab bar — fixed to the bottom edge, padded by the device's bottom safe-area inset, with `role="tablist"` and `aria-selected` on the active tab — containing exactly four tabs: `Files`, `Preview`, `Chat`, and `Terminal`. Exactly one tab's surface SHALL fill the viewport at a time. The bar SHALL NOT render in desktop mode.

#### Scenario: Software keyboard temporarily covers the navigation bar
- **WHEN** an input has focus and the software keyboard is visible
- **THEN** the keyboard MAY cover the bar according to platform convention
- **AND** the bar SHALL reappear when the keyboard dismisses

#### Scenario: One surface at a time
- **WHEN** the app renders in touch mode
- **THEN** the tab bar is visible above the home-indicator inset
- **AND** only the active tab's surface is visible above it

#### Scenario: Tab switching swaps surfaces
- **WHEN** the user taps the Chat tab, then the Terminal tab, and then the Preview tab
- **THEN** each tap makes that tab active (`aria-selected`) and its surface fills the viewport

### Requirement: Desktop mode respects device safe areas
Desktop mode on a tablet SHALL retain the desktop arrangement while keeping sidebar controls, preview headings and actions, conversation controls, and the mode toggle inside the device's usable safe area. System status-bar treatments and application blur layers SHALL NOT obscure those controls.

#### Scenario: Desktop safe-area geometry tracks device changes and attached input
- **WHEN** desktop layout is evaluated after initial load, rotation, resizing, or live UI mode changes
- **THEN** the layout SHALL account for top, side, and bottom insets
- **AND** physical-device insets SHALL NOT be inferred solely from viewport width or primary pointer type, since attaching a keyboard or trackpad does not remove the device's safe areas

#### Scenario: Installed iPad app enters desktop mode
- **WHEN** an 11-inch iPad Pro opens the installed Uatu PWA in landscape and switches to desktop mode
- **THEN** the sidebar identity and controls, preview heading/actions, and chat header remain legible and operable below the system status area
- **AND** no top-edge blur covers those controls

#### Scenario: Rotation preserves the way back
- **WHEN** the iPad rotates between landscape and portrait in desktop mode with the sidebar expanded or collapsed
- **THEN** controls remain inside the updated safe area and a mode toggle remains reachable

#### Scenario: A desktop browser has no device insets
- **WHEN** desktop mode runs in a browser reporting zero safe-area insets
- **THEN** the layout does not add an artificial tablet status-bar gap

### Requirement: Desktop mode follows the visible viewport during text entry
When a tablet uses desktop mode, the workspace SHALL fit the visible viewport during software-keyboard and hardware-keyboard accessory-bar transitions, including viewport panning.

#### Scenario: Composer focus keeps desktop headers and editing controls visible
- **WHEN** the chat composer is focused on a tablet in desktop mode, whether or not a keyboard transition is occurring
- **THEN** sidebar, preview, and chat headers SHALL remain visible while the composer and send control stay above the occluded area

#### Scenario: Tablet desktop content and small occlusions retain their own boundaries
- **WHEN** a tablet uses desktop mode, with or without composer focus
- **THEN** small accessory-bar occlusions SHALL be handled even below the software-keyboard detection threshold
- **AND** Chat and preview content SHALL scroll within their appropriate panes rather than requiring whole-workspace scrolling to recover headers

#### Scenario: Editing geometry recovers without changing content state
- **WHEN** blur, keyboard dismissal, rotation, or mode switching changes geometry
- **THEN** geometry SHALL recover without clearing drafts, changing the selected conversation/document, or repeatedly forcing page scroll

#### Scenario: Magic Keyboard accessory bar appears
- **WHEN** a user with a Magic Keyboard attached to an 11-inch iPad Pro in installed-PWA desktop mode focuses the chat composer and iPadOS shows its input accessory bar
- **THEN** the workspace adjusts to the visible area
- **AND** the sidebar, preview, and conversation headers stay visible
- **AND** the composer and send button remain usable above the accessory bar

#### Scenario: Software keyboard pans the viewport
- **WHEN** the user focuses the composer with the software keyboard and the platform changes both visible viewport height and offset
- **THEN** desktop-mode geometry follows both measurements and keeps the headers and composer within the usable area

#### Scenario: Dismissal restores the workspace
- **WHEN** the keyboard or accessory bar dismisses after the user has typed a draft
- **THEN** the workspace returns to the available height without a blank keyboard-sized strip or stranded scroll offset
- **AND** the draft, selected conversation, and selected document are preserved

#### Scenario: Mode switches during editing
- **WHEN** the user switches between touch and desktop mode during an editing session
- **THEN** the target layout uses the current viewport and safe areas without stale padding or double-counted insets
- **AND** the draft and current conversation survive the switch

### Requirement: A persistent player fits above the existing touch tabs
During audition the compact player SHALL remain operable above the existing Files/Preview/Chat/Terminal tab bar. Its layout SHALL account for device safe areas, rotation, keyboard/viewport changes, and the available height of each surface. It MUST NOT obscure the last reachable file row, Chat composer, or terminal controls. Video SHALL have an expandable presentation. Switching surfaces or UI mode SHALL retain the player session and time without adding a fifth tab or a duplicate player.

#### Scenario: A clip plays while Chat is used
- **WHEN** the user switches from Files to Chat during playback on a phone
- **THEN** the compact controls remain reachable and do not cover the composer
- **AND** the same playback session continues

#### Scenario: The last Recent row is reached
- **WHEN** the player and bottom tabs are visible and the user scrolls to the end of Recent
- **THEN** the last file row and its actions can be fully brought above the player

#### Scenario: A device rotates or changes UI mode
- **WHEN** the device rotates or switches between touch and desktop presentation during playback
- **THEN** controls fit the usable viewport and the active clip retains its time without duplicate playback

#### Scenario: Terminal remains operable
- **WHEN** Terminal is shown with an active compact player
- **THEN** terminal sizing accounts for both the player and existing tabs while retaining the PTY attachment
