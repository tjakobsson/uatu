# embedded-terminal — delta for mobile-terminal-experience

Throughout this delta, "phone-class viewport" means a viewport that is BOTH
coarse-pointer (`pointer: coarse`) AND narrower than the 900-pixel stacked-layout
breakpoint. iPads in landscape and narrow desktop windows are not phone-class.

## MODIFIED Requirements

### Requirement: Panel supports minimize and fullscreen display modes
The panel header SHALL provide minimize and fullscreen controls in addition to the close control. Minimize SHALL collapse the panel body to a header bar while keeping every PTY attached. On viewports that are not phone-class, fullscreen SHALL expand the panel to fill the main content area (preserving the sidebar and topbar). On phone-class viewports, fullscreen SHALL instead pin the panel to the entire visual viewport — no sidebar, no preview, no page scroll behind it — using dynamic-viewport units so the browser's collapsing URL bar cannot leave a gap. Both display-mode changes SHALL be reversible without losing PTY state, and the active display mode SHALL persist across reloads.

#### Scenario: Minimize collapses without losing the session
- **WHEN** a pane is running an active process (e.g., `tail -f` is producing output)
- **AND** the user clicks minimize
- **THEN** the panel body is hidden and only the header bar remains visible
- **AND** every PTY remains attached
- **AND** restoring the panel resumes display of accumulated output

#### Scenario: Fullscreen expands within the app grid
- **WHEN** the user clicks fullscreen on a viewport that is not phone-class
- **THEN** the panel expands to cover the main content area
- **AND** the sidebar and the topbar remain visible
- **AND** xterm fit recalculates so panes use the new dimensions

#### Scenario: Fullscreen covers the whole screen on a phone
- **WHEN** the panel enters fullscreen on a phone-class viewport
- **THEN** the panel covers the entire visual viewport with no sidebar or preview visible
- **AND** the page behind the panel cannot scroll
- **AND** xterm fit recalculates so panes use the new dimensions

#### Scenario: Esc exits fullscreen
- **WHEN** the panel is in fullscreen mode
- **AND** the user presses `Esc` (and no confirmation modal is open)
- **THEN** the panel returns to its previous display mode (normal or minimized)
- **AND** PTYs remain attached

#### Scenario: Display mode persists across reload
- **WHEN** the user puts the panel in fullscreen mode and reloads the page
- **THEN** on reload the panel is restored to fullscreen mode

### Requirement: Touch devices get a terminal keybar
On coarse-pointer devices the terminal panel SHALL show a key row for input a software keyboard cannot produce — at minimum Escape, Tab, Control-C, Control-D, Control-Z, the arrow keys, Page Up, Page Down, Home, and End — sending each key's control sequence down the focused pane's PTY exactly as typed input travels. The row SHALL additionally provide a Paste action that reads the system clipboard within the tap's user-gesture context and writes the text to the focused pane's PTY, and a single-shot sticky Ctrl modifier: tapping Ctrl arms a latch, the next printable character typed is composed to its control character before reaching the PTY, and the latch releases; tapping Ctrl while armed cancels the latch. The armed state MUST be visually indicated and exposed via `aria-pressed`. Activating any keybar affordance MUST NOT move focus out of the terminal (which would dismiss the software keyboard). The row SHALL NOT appear on fine-pointer devices. On devices with a bottom home-indicator inset, the row SHALL sit above the safe-area inset so taps do not trigger the system home gesture.

#### Scenario: Interrupting a process from an iPad
- **WHEN** a user on a coarse-pointer device runs a foreground process and taps the keybar's Control-C
- **THEN** the byte 0x03 reaches the PTY and the process receives the interrupt
- **AND** the terminal keeps keyboard focus

#### Scenario: Paging through a TUI
- **WHEN** a user on a coarse-pointer device has a pager open and taps the keybar's Page Down
- **THEN** the sequence 0x1b `[6~` reaches the PTY
- **AND** the terminal keeps keyboard focus

#### Scenario: Pasting a command from the clipboard
- **WHEN** a user on a coarse-pointer device taps the keybar's Paste and the platform grants the clipboard read
- **THEN** the clipboard text is written to the focused pane's PTY exactly as typed input travels
- **AND** the terminal keeps keyboard focus

#### Scenario: Denied clipboard read is inert
- **WHEN** the user taps Paste and the platform denies the clipboard read or the clipboard is empty
- **THEN** nothing is written to the PTY and the terminal keeps keyboard focus

#### Scenario: Sticky Ctrl composes a reverse-search
- **WHEN** the user taps the keybar's Ctrl (the key shows its armed state) and then types `r` on the software keyboard
- **THEN** the byte 0x12 reaches the PTY instead of the letter r
- **AND** the latch releases so the following typed character arrives unmodified

#### Scenario: Arming Ctrl twice cancels it
- **WHEN** the user taps Ctrl and then taps Ctrl again before typing
- **THEN** the latch is released and the next typed character reaches the PTY unmodified

#### Scenario: Desktop layouts are unchanged
- **WHEN** the terminal panel renders on a fine-pointer device
- **THEN** no keybar row is shown

## ADDED Requirements

### Requirement: Phone-class viewports auto-promote the terminal to fullscreen
On a phone-class viewport the panel SHALL force its effective display mode to fullscreen whenever it is shown in `normal` mode — on open, and when the viewport crosses into phone-class — without overwriting the stored display-mode preference, mirroring the right-dock narrow-viewport fallback. Exiting fullscreen on a phone-class viewport SHALL minimize the panel rather than enter `normal`; the `normal` docked strip SHALL never render on a phone-class viewport.

#### Scenario: Opening the terminal on a phone lands in fullscreen
- **WHEN** a user on a phone-class viewport shows the terminal panel while the stored display mode is `normal`
- **THEN** the panel renders fullscreen
- **AND** the stored display-mode preference is unchanged

#### Scenario: Widening the viewport restores the stored mode
- **WHEN** the panel was auto-promoted to fullscreen on a phone-class viewport
- **AND** the viewport leaves phone-class (e.g., the device rotates to a wide landscape or the session is opened on a desktop)
- **THEN** the panel renders in the stored display mode

#### Scenario: Leaving fullscreen on a phone minimizes
- **WHEN** the panel is fullscreen on a phone-class viewport and the user activates the fullscreen toggle or presses `Esc`
- **THEN** the panel minimizes to its header bar
- **AND** every PTY remains attached

### Requirement: Phone fullscreen tracks the visible viewport
While fullscreen on a phone-class viewport, the panel SHALL size itself to the visual viewport (`window.visualViewport`) rather than the layout viewport, and SHALL refit xterm when the visual viewport changes, so the software keyboard never obscures the prompt line: when the keyboard shows, the panel shrinks to the space above it; when the keyboard hides, the panel reclaims the full height. The visual-viewport subscription SHALL be active only while the panel is phone-fullscreen.

#### Scenario: Software keyboard does not cover the prompt
- **WHEN** the panel is fullscreen on a phone-class viewport and focusing the terminal raises the software keyboard, shrinking the visual viewport
- **THEN** the panel resizes to the remaining visible height and xterm refits
- **AND** the row containing the cursor remains visible

#### Scenario: Dismissing the keyboard reclaims the screen
- **WHEN** the software keyboard is dismissed and the visual viewport regrows
- **THEN** the panel expands to the full viewport height and xterm refits

### Requirement: Phone fullscreen respects device safe areas
The document viewport SHALL be configured with `viewport-fit=cover`, and the phone-fullscreen panel SHALL pad its edges by the device's safe-area insets so no terminal content or control renders under a notch, rounded corner, or the home indicator. On devices without insets the padding SHALL resolve to zero, leaving other layouts unaffected.

#### Scenario: Notched device keeps content clear of hardware
- **WHEN** the panel is fullscreen on a phone-class device that reports non-zero safe-area insets
- **THEN** the header, panes, and keybar are inset so no interactive element sits under the notch or home indicator

#### Scenario: Uninsetted environments are unchanged
- **WHEN** the app renders in an environment reporting zero safe-area insets
- **THEN** panel geometry is identical to the pre-change layout

### Requirement: Touch devices can adjust the terminal font size at runtime
On coarse-pointer devices the terminal panel header SHALL provide decrease/increase font-size controls that apply immediately to every pane (xterm font size updated and panes refit) without reconnecting any PTY. The adjusted size SHALL persist per device and SHALL take precedence over the `.uatu.json` terminal font-size configuration, which remains the default when no per-device adjustment exists. The adjustable range SHALL be clamped to the same bounds the configuration loader accepts. Stepping back to the configured value SHALL clear the per-device override. The controls SHALL NOT appear on fine-pointer devices.

#### Scenario: Growing the font on an iPad
- **WHEN** a user on a coarse-pointer device taps the increase-font-size control
- **THEN** every pane re-renders at the larger size and refits its rows and columns
- **AND** the PTYs remain attached

#### Scenario: Adjustment survives reload and shadows config
- **WHEN** a user has stepped the font size up and reloads the page
- **THEN** the terminal renders at the adjusted size even though `.uatu.json` specifies a different one

#### Scenario: Desktop header is unchanged
- **WHEN** the terminal panel renders on a fine-pointer device
- **THEN** no font-size controls are shown

### Requirement: Touch and wheel scrolling work in both terminal buffers
Vertical scrolling over a terminal pane SHALL reach the right consumer in every buffer. In the normal buffer, the existing scrollback scrolling stands for both wheel and touch. In the alternate-screen buffer (full-screen TUIs): on coarse-pointer devices, vertical swipe distance SHALL be translated into repeated arrow-up/arrow-down key sequences sent to the PTY — quantized by cell height and honoring application cursor-key mode; and for wheel input on any pointer type, when the application has NOT enabled mouse tracking, wheel deltas SHALL be translated the same way (the conventional terminal-emulator alternate-scroll default) instead of scrolling scrollback underneath the TUI. When the application HAS enabled mouse tracking, wheel events SHALL be forwarded as mouse reports per the terminal's protocol handling and MUST NOT additionally produce arrow sequences. Horizontal swipe components SHALL be ignored, and the translation MUST NOT interfere with normal-buffer scrolling or with touch text selection.

#### Scenario: Swiping through a pager on a phone
- **WHEN** a TUI on the alternate buffer is active and the user swipes up one cell-height over the pane
- **THEN** one arrow-down sequence (in the form the current cursor-key mode dictates) reaches the PTY
- **AND** a longer swipe produces proportionally more sequences

#### Scenario: Wheel scrolling a TUI that does not track the mouse
- **WHEN** a TUI on the alternate buffer without mouse tracking is active and the user scrolls the wheel down one cell-height over the pane
- **THEN** one arrow-down sequence reaches the PTY and the scrollback does not move

#### Scenario: Wheel in a mouse-tracking TUI takes the protocol path
- **WHEN** a TUI on the alternate buffer with mouse tracking enabled is active and the user scrolls the wheel
- **THEN** the wheel is delivered as mouse reports and no synthesized arrow sequences are sent

#### Scenario: Shell scrollback still swipes natively
- **WHEN** the normal buffer is active and the user swipes or wheels over the pane
- **THEN** the viewport scrolls the scrollback and no arrow sequences are sent

### Requirement: Phone-class viewports hide panel geometry controls
On phone-class viewports the panel header SHALL hide the split and dock-toggle controls and the panel resizer, keeping the title, minimize, fullscreen, and close controls. Hiding SHALL be presentation-only: stored dock, size, and split state remain intact and reappear when the session is viewed on a non-phone-class viewport.

#### Scenario: Phone header is slim
- **WHEN** the terminal panel renders on a phone-class viewport
- **THEN** the split and dock-toggle buttons and the resizer are not visible
- **AND** minimize, fullscreen, and close remain available

#### Scenario: Geometry state survives the phone
- **WHEN** a session whose panel is right-docked and split is viewed on a phone-class viewport and later on a desktop viewport
- **THEN** the desktop view renders the panel right-docked with its split panes intact
