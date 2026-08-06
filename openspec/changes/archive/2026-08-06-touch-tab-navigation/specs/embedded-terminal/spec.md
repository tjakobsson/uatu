# embedded-terminal — delta for touch-tab-navigation

The phone-class layout requirements re-key onto the UI mode (see the new
`touch-navigation` capability): "touch mode" replaces "phone-class viewport",
extending the behavior to iPads and making it escapable. Input-capability
requirements (keybar, font stepper, scroll routing) are unchanged — they stay
keyed on pointer coarseness.

## MODIFIED Requirements

### Requirement: Panel supports minimize and fullscreen display modes
The panel header SHALL provide minimize and fullscreen controls in addition to the close control. Minimize SHALL collapse the panel body to a header bar while keeping every PTY attached. In desktop mode, fullscreen SHALL expand the panel to fill the main content area (preserving the sidebar and topbar). In touch mode, fullscreen SHALL instead pin the panel to the entire visual viewport — no sidebar, no preview, no page scroll behind it — using dynamic-viewport units so the browser's collapsing URL bar cannot leave a gap, with the bottom tab bar remaining as navigation chrome. Both display-mode changes SHALL be reversible without losing PTY state, and the active display mode SHALL persist across reloads.

#### Scenario: Minimize collapses without losing the session
- **WHEN** a pane is running an active process (e.g., `tail -f` is producing output)
- **AND** the user clicks minimize
- **THEN** the panel body is hidden and only the header bar remains visible
- **AND** every PTY remains attached
- **AND** restoring the panel resumes display of accumulated output

#### Scenario: Fullscreen expands within the app grid
- **WHEN** the user clicks fullscreen in desktop mode
- **THEN** the panel expands to cover the main content area
- **AND** the sidebar and the topbar remain visible
- **AND** xterm fit recalculates so panes use the new dimensions

#### Scenario: Fullscreen covers the whole screen in touch mode
- **WHEN** the panel enters fullscreen in touch mode
- **THEN** the panel covers the visual viewport above the tab bar with no sidebar or preview visible
- **AND** the page behind the panel cannot scroll
- **AND** xterm fit recalculates so panes use the new dimensions

#### Scenario: Esc exits fullscreen
- **WHEN** the panel is in fullscreen mode
- **AND** the user presses `Esc` (and no confirmation modal is open)
- **THEN** in desktop mode the panel returns to its previous display mode, and in touch mode the Preview tab becomes active
- **AND** PTYs remain attached

#### Scenario: Display mode persists across reload
- **WHEN** the user puts the panel in fullscreen mode and reloads the page
- **THEN** on reload the panel is restored to fullscreen mode

### Requirement: Phone-class viewports auto-promote the terminal to fullscreen
In touch mode the panel SHALL render fullscreen whenever the Terminal tab is active — regardless of the stored display mode, and without overwriting the stored display-mode preference, mirroring the right-dock narrow-viewport fallback. Leaving the fullscreen terminal (the fullscreen toggle or `Esc`) SHALL switch to the Preview tab; switching tabs SHALL keep every PTY attached. Neither the `normal` docked strip nor the minimized header strip SHALL ever render in touch mode.

#### Scenario: Opening the Terminal tab lands in fullscreen
- **WHEN** a user in touch mode activates the Terminal tab while the stored display mode is `normal`
- **THEN** the panel renders fullscreen
- **AND** the stored display-mode preference is unchanged

#### Scenario: Desktop mode restores the stored display mode
- **WHEN** the terminal was fullscreen via the Terminal tab in touch mode
- **AND** the device switches to desktop mode (or the session is opened on a desktop)
- **THEN** the panel renders in the stored display mode and dock

#### Scenario: Leaving fullscreen switches to Preview
- **WHEN** the panel is fullscreen in touch mode and the user activates the fullscreen toggle or presses `Esc`
- **THEN** the Preview tab becomes active
- **AND** every PTY remains attached

### Requirement: Phone fullscreen tracks the visible viewport
While fullscreen in touch mode, the panel SHALL size itself to the visual viewport (`window.visualViewport`) rather than the layout viewport, and SHALL refit xterm when the visual viewport changes, so the software keyboard never obscures the prompt line: when the keyboard shows, the panel shrinks to the space above it; when the keyboard hides, the panel reclaims the full height. The visual-viewport subscription SHALL be active only while the panel is touch-mode fullscreen.

#### Scenario: Software keyboard does not cover the prompt
- **WHEN** the panel is fullscreen in touch mode and focusing the terminal raises the software keyboard, shrinking the visual viewport
- **THEN** the panel resizes to the remaining visible height and xterm refits
- **AND** the row containing the cursor remains visible

#### Scenario: Dismissing the keyboard reclaims the screen
- **WHEN** the software keyboard is dismissed and the visual viewport regrows
- **THEN** the panel expands to the full viewport height and xterm refits

### Requirement: Phone-class viewports hide panel geometry controls
In touch mode the panel header SHALL hide the split and dock-toggle controls and the panel resizer, keeping the title, fullscreen, and close controls (the minimize control MAY also hide — tab switching supersedes it). Hiding SHALL be presentation-only: stored dock, size, and split state remain intact and reappear in desktop mode.

#### Scenario: Touch header is slim
- **WHEN** the terminal panel renders in touch mode
- **THEN** the split and dock-toggle buttons and the resizer are not visible
- **AND** fullscreen and close remain available

#### Scenario: Geometry state survives touch mode
- **WHEN** a session whose panel is right-docked and split is viewed in touch mode and later in desktop mode
- **THEN** the desktop view renders the panel right-docked with its split panes intact
