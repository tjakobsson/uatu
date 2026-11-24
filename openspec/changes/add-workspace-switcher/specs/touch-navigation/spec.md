## MODIFIED Requirements

### Requirement: Touch mode shows a bottom tab bar with four surfaces
In touch mode the UI SHALL render a bottom tab bar — fixed to the bottom edge, padded by the device's bottom safe-area inset, with `role="tablist"` and `aria-selected` on the active tab — containing exactly four tabs: `Files`, `Preview`, `Chat`, and `Terminal`, followed, outside the tablist, by the switcher button whenever the switcher is offered (workspace-switcher). Exactly one tab's surface SHALL fill the viewport at a time. The bar SHALL NOT render in desktop mode.

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

#### Scenario: The switcher button is not a tab
- **WHEN** the tab bar shows the switcher button beside the four tabs
- **THEN** the button sits last, about one and a half tab cells wide with a divider before it, is never `aria-selected`, and the arrow keys that rove the tabs skip it
- **AND** activating it opens the switcher without changing the active tab

### Requirement: The sidebar chrome offers the mode switch — never the tab bar
On coarse-pointer devices, in windows 900px wide or less, and in touch mode, the UI SHALL offer a single mode toggle in the sidebar header, inside Files in touch mode; coarse-pointer desktop mode adds a collapsed-sidebar rail variant. It SHALL switch renderings live, remain reachable at every viewport width, and persist the chosen mode per device. The tab bar SHALL contain the four surface tabs and the switcher button, never a mode control.

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
- **THEN** it contains exactly the Files, Preview, Chat, and Terminal tabs, and the switcher button when the switcher is offered
- **AND** no mode control

#### Scenario: Rotation cannot strand desktop mode
- **WHEN** a coarse-pointer device in desktop mode narrows below the wide breakpoint (e.g. iPad rotating to portrait) or collapses the sidebar
- **THEN** a mode toggle remains reachable and switches the device back to touch mode

#### Scenario: Leaving touch mode on the Chat tab keeps the conversation visible
- **WHEN** a user on the Chat tab switches to desktop mode
- **THEN** the chat panel is open beside Preview in the desktop rendering

#### Scenario: A narrow fine-pointer window can switch to touch mode
- **WHEN** a fine-pointer browser at 390×844 renders the default desktop layout, the sidebar stacked above the preview
- **THEN** the sidebar header shows the mode toggle, and activating it renders touch mode
- **AND** in touch mode the toggle stays in the Files tab's header whatever the width, so the window can return to desktop mode
- **AND** a fine-pointer window wider than 900px in desktop mode still shows no mode toggle

#### Scenario: A desktop window narrowed over a preview offers touch layout
- **WHEN** a desktop-layout window showing a pull request (or any preview) at 1440×900 is resized to 390×844 without switching layout, and no explicit desktop choice is stored
- **THEN** the preview's top stays at the viewport's top instead of below the stacked sidebar, and a small non-blocking bar asks `Narrow window: switch to touch layout?` with Switch and Not now
- **AND** Switch renders touch mode; Not now, or a stored desktop choice, leaves the layout alone for the page
