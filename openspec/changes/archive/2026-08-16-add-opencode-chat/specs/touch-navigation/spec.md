## REMOVED Requirements

### Requirement: Touch mode shows a bottom tab bar with three surfaces
Replaced by the four-surface requirement below: Chat joins Files, Preview, and
Terminal as a peer tab, so the requirement is renamed rather than edited in
place.

## ADDED Requirements

### Requirement: Touch mode shows a bottom tab bar with four surfaces
In touch mode the UI SHALL render a bottom tab bar — fixed to the bottom edge, padded by the device's bottom safe-area inset, with `role="tablist"` and `aria-selected` on the active tab — containing exactly four tabs: `Files`, `Preview`, `Chat`, and `Terminal`. Exactly one tab's surface SHALL fill the viewport at a time. The bar SHALL NOT render in desktop mode. The software keyboard MAY cover the bar while an input has focus (the platform convention); the bar reappears when the keyboard dismisses.

#### Scenario: One surface at a time
- **WHEN** the app renders in touch mode
- **THEN** the tab bar is visible above the home-indicator inset
- **AND** only the active tab's surface is visible above it

#### Scenario: Tab switching swaps surfaces
- **WHEN** the user taps the Chat tab, then the Terminal tab, and then the Preview tab
- **THEN** each tap makes that tab active (`aria-selected`) and its surface fills the viewport

## MODIFIED Requirements

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
