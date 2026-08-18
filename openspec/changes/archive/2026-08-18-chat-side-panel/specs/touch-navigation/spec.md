## MODIFIED Requirements

### Requirement: The sidebar chrome offers the mode switch — never the tab bar
On coarse-pointer devices the UI SHALL offer a single mode toggle in the sidebar header — rendered inside the Files tab in touch mode, and in the desktop chrome (with a collapsed-sidebar rail variant) in desktop mode — switching between the touch and desktop renderings: desktop mode is the UI exactly as a desktop browser renders it (sidebar, the Preview-and-Chat split work area, docked terminal, no tab bar), and the chosen mode persists per device. The toggle SHALL be available at every viewport width in both modes, so a coarse-pointer device can never be stranded in either mode (escaping in iPad landscape and rotating to portrait must keep the way back reachable). The tab bar SHALL contain only the four surface tabs — no mode control. Switching modes SHALL normalize surface state: the terminal returns to its stored dock and display mode, entering desktop with the Chat tab active opens the chat panel, entering touch lands on the Chat tab only when the user was last working in an open chat panel (otherwise Preview), and no touch-only surface promotion remains.

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
