# touch-navigation Specification

## Purpose
TBD - created by syncing change touch-tab-navigation. Update Purpose after archive.

Throughout this spec, "touch mode" and "desktop mode" are the two values of the
per-device UI mode; "wide viewport" means at or above the 900-pixel breakpoint that
also governs the desktop layout's stacking.

## Requirements

### Requirement: UI mode defaults by pointer type and persists per device
The client SHALL resolve a UI mode — `touch` or `desktop` — at boot and stamp it on the document root: a per-device stored override wins when present; otherwise coarse-pointer devices (iPhone AND iPad) default to `touch` and fine-pointer devices to `desktop`. Layout SHALL be keyed on the mode, while input affordances gated on pointer coarseness (touch keybar, size steppers, scroll-gesture routing) SHALL remain available in both modes on coarse-pointer devices. Switching modes SHALL take effect live, without a page reload, and SHALL persist per device.

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
The `Files` tab's surface SHALL be the existing sidebar pane stack (the visible panes — by default Change Overview and the Files tree) rendered full-screen, with the same tree DOM and state (expansion, selection, filter chip, follow-mode highlighting) as every other presentation of the tree — never a second tree instance. The per-pane visibility menu SHALL keep working inside the tab. On coarse-pointer devices each pane's header SHALL act as the gesture surface for the pane: dragging it resizes the boundary above (the thin desktop resizer strip is not a finger target), and double-tapping it toggles the pane's collapse (the reachable version of the small − / + button) — while taps on the header's controls keep working.

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
When the user navigates to content the preview renders — picking a document (a tree row or a search-pane result, both the follow-mode Rule A path), opening a review score, or opening a commit — the UI SHALL switch to the Preview tab showing that content. Directory expand/collapse taps SHALL NOT switch tabs. Programmatic tree updates (follow-mode Rules C/D, file events) MUST NOT switch tabs.

#### Scenario: Pick lands on Preview
- **WHEN** the user taps a document row in the Files tab
- **THEN** the Preview tab becomes active showing the picked document

#### Scenario: A search result lands on Preview
- **WHEN** the user taps a search-pane result in the Files tab
- **THEN** the Preview tab becomes active showing the matched document

#### Scenario: File events do not steal the Files tab
- **WHEN** the Files tab is active and a watched-file event updates the tree
- **THEN** the Files tab remains active with the tree updated

### Requirement: A surface-directed shortcut SHALL bring its surface forward
A keyboard shortcut that acts on a specific surface SHALL make that surface the active tab before it acts, so its affordance is never mounted or focused inside a hidden subtree. `⌘F` targets the preview and SHALL activate the Preview tab; `⇧⌘F` targets the Search pane in the sidebar stack and SHALL activate the Files tab. This is the shortcut counterpart of the existing rule for preview-bound navigations: a shortcut the user pressed is an act of intent, so it may promote a surface, whereas programmatic activity (follow-mode Rules C/D, file events) still MUST NOT. A shortcut that consumes the key and suppresses the host's own handling MUST NOT leave the user with nothing visible to use.

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
On coarse-pointer devices the UI SHALL offer a single mode toggle in the sidebar header — rendered inside the Files tab in touch mode, and in the desktop chrome (with a collapsed-sidebar rail variant) in desktop mode — switching between the touch and desktop renderings: desktop mode is the UI exactly as a desktop browser renders it (sidebar, main Preview-or-Chat surface, docked terminal, no tab bar), and the chosen mode persists per device. The toggle SHALL be available at every viewport width in both modes, so a coarse-pointer device can never be stranded in either mode (escaping in iPad landscape and rotating to portrait must keep the way back reachable). The tab bar SHALL contain only the four surface tabs — no mode control. Switching modes SHALL normalize surface state: the terminal returns to its stored dock and display mode, the active Preview-or-Chat main surface remains selected, and no touch-only surface promotion remains.

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

### Requirement: The active tab persists per device
The active tab SHALL default to `Preview` on first use and SHALL persist per device, restoring on reload. Restoring the Terminal tab at boot SHALL follow the terminal's existing restore semantics (no PTY auto-spawn beyond what the persisted terminal state already implies, and no focus steal).

#### Scenario: Reload lands on the last tab
- **WHEN** the user was on the Files tab and reloads
- **THEN** the app boots into touch mode with the Files tab active

### Requirement: Touch mode shows a bottom tab bar with four surfaces
In touch mode the UI SHALL render a bottom tab bar — fixed to the bottom edge, padded by the device's bottom safe-area inset, with `role="tablist"` and `aria-selected` on the active tab — containing exactly four tabs: `Files`, `Preview`, `Chat`, and `Terminal`. Exactly one tab's surface SHALL fill the viewport at a time. The bar SHALL NOT render in desktop mode. The software keyboard MAY cover the bar while an input has focus (the platform convention); the bar reappears when the keyboard dismisses.

#### Scenario: One surface at a time
- **WHEN** the app renders in touch mode
- **THEN** the tab bar is visible above the home-indicator inset
- **AND** only the active tab's surface is visible above it

#### Scenario: Tab switching swaps surfaces
- **WHEN** the user taps the Chat tab, then the Terminal tab, and then the Preview tab
- **THEN** each tap makes that tab active (`aria-selected`) and its surface fills the viewport
