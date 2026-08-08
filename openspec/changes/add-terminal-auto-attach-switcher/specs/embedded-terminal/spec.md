## MODIFIED Requirements

### Requirement: New panes offer existing sessions instead of silently spawning
When a client has no per-window attachment to restore, the panel SHALL attach automatically to every detached PTY in terminal inventory that the window is not already showing — oldest first, bounded by the panel's pane cap — without presenting a chooser. A PTY held by another client SHALL NOT be attached automatically; ownership transfers only through an explicit takeover. When inventory holds no detached PTY but at least one attached-elsewhere PTY, the panel SHALL list them and require an explicit takeover, terminate, or New shell choice. When inventory holds nothing to attach, the panel SHALL create a fresh shell directly. New shell SHALL create a server resource before attaching. The user's saved last-active PTY, when among the auto-attached set, SHALL become the active pane; otherwise the newest auto-attached pane SHALL be active. The saved reference SHALL NOT otherwise change which PTYs are attached, and SHALL never cause a takeover.

#### Scenario: A detached orphan attaches without a chooser
- **WHEN** one detached PTY exists and a browser opens the terminal panel with nothing to restore
- **THEN** the panel attaches a pane to that PTY
- **AND** no session chooser is shown

#### Scenario: Every detached session attaches
- **WHEN** three detached PTYs exist and the user opens the terminal panel
- **THEN** three panes attach, one per PTY, ordered oldest first
- **AND** no session chooser is shown

#### Scenario: Auto-attach stops at the pane cap
- **WHEN** more detached PTYs exist than the pane cap allows
- **THEN** the panel attaches up to the cap, oldest first
- **AND** the remaining PTYs stay detached and reachable from the switcher or the chooser

#### Scenario: Sessions held elsewhere are never taken over automatically
- **WHEN** inventory contains PTYs attached by another window
- **THEN** no pane attaches to them
- **AND** they transfer only after the user activates an explicit takeover

#### Scenario: Only attached-elsewhere sessions remain a decision
- **WHEN** every PTY in inventory is attached by another client and the user opens the terminal
- **THEN** the chooser lists them with takeover, terminate, and New shell
- **AND** nothing attaches until the user chooses

#### Scenario: Empty inventory spawns directly
- **WHEN** no PTY exists and the user opens or splits the terminal panel
- **THEN** the server creates a PTY and the pane attaches to it

#### Scenario: Last-active reference selects, never attaches
- **WHEN** personal state names a live PTY that auto-attach has just attached
- **THEN** that pane becomes the active pane
- **AND** when the same PTY is attached by another client, no pane attaches to it and no takeover occurs

#### Scenario: Per-window restore still wins
- **WHEN** the window has persisted pane records to restore
- **THEN** those records drive attachment as before
- **AND** auto-attach of unrelated detached PTYs does not run

#### Scenario: New shell uses server creation
- **WHEN** the user chooses New shell
- **THEN** the server creates a PTY id and the pane attaches to that resource

#### Scenario: Chooser termination removes resource
- **WHEN** the user terminates a listed PTY
- **THEN** DELETE removes it without attaching a pane

### Requirement: Touch devices get a terminal keybar
On coarse-pointer devices the terminal panel SHALL show a key row for input a software keyboard cannot produce — at minimum Escape, Tab, Control-C, Control-D, Control-Z, the arrow keys, Page Up, Page Down, Home, and End — sending each key's control sequence down the focused pane's PTY exactly as typed input travels. The row SHALL additionally provide a Paste action, a single-shot sticky Ctrl modifier, and a terminal switch action that opens the terminal switcher. Sticky Ctrl works as follows: tapping Ctrl arms a latch, the next printable character typed is composed to its control character before reaching the PTY, and the latch releases; tapping Ctrl while armed cancels the latch. The armed state MUST be visually indicated and exposed via `aria-pressed`. The switch action MUST carry an accessible name naming the terminal switcher, MUST expose the sheet's open state via `aria-expanded`, and MUST toggle the sheet rather than opening a second one. Pressing any keybar affordance MUST NOT move focus out of the terminal, which would dismiss the software keyboard; the switcher is the one exception — it takes focus deliberately while open and returns it to the visible pane on dismissal. Paste MUST request the system clipboard from a release-time or equivalent semantic button activation carrying transient user activation, MUST invoke at most one clipboard read and one terminal paste per activation, and MUST forward non-empty text through xterm's paste path so newline normalization and bracketed-paste mode are honored. Paste MUST remain keyboard-operable. An unavailable Clipboard API, a synchronous failure, a rejected read, or an empty clipboard MUST leave the action inert without PTY input or an uncaught error. The row SHALL NOT appear on fine-pointer devices. On devices with a bottom home-indicator inset, the row SHALL sit above the safe-area inset so taps do not trigger the system home gesture. While the selection transcript is open, the switch action SHALL be unavailable alongside the other non-selection keys.

#### Scenario: Interrupting a process from an iPad
- **WHEN** a user on a coarse-pointer device runs a foreground process and taps the keybar's Control-C
- **THEN** the byte 0x03 reaches the PTY and the process receives the interrupt
- **AND** the terminal keeps keyboard focus

#### Scenario: Paging through a TUI
- **WHEN** a user on a coarse-pointer device has a pager open and taps the keybar's Page Down
- **THEN** the sequence 0x1b `[6~` reaches the PTY
- **AND** the terminal keeps keyboard focus

#### Scenario: Switch opens the terminal switcher
- **WHEN** a user on a coarse-pointer device taps the keybar's switch action
- **THEN** the terminal switcher opens over the terminal surface
- **AND** the control reports `aria-expanded="true"`

#### Scenario: Switch toggles rather than stacking
- **WHEN** the user taps the switch action while the switcher is already open
- **THEN** the switcher closes and focus returns to the visible pane
- **AND** no second sheet is created

#### Scenario: Touch Paste waits for release-time activation
- **WHEN** a user presses the keybar's Paste with a non-mouse pointer
- **THEN** the press preserves terminal focus without requesting the clipboard
- **AND** the clipboard read starts from the release-time or equivalent semantic activation

#### Scenario: Pasting a command from the clipboard
- **WHEN** a user activates the keybar's Paste and the platform grants a non-empty clipboard read
- **THEN** the clipboard text is forwarded through xterm's paste path to the focused pane
- **AND** bracketed-paste markers are emitted when the shell has enabled bracketed-paste mode
- **AND** the terminal keeps keyboard focus

#### Scenario: A touch activation pastes exactly once
- **WHEN** one touch produces its pointer and click event sequence on the Paste control
- **THEN** the clipboard is read at most once
- **AND** the clipboard text is pasted at most once

#### Scenario: Keyboard user activates Paste
- **WHEN** a keyboard user focuses the Paste button and activates it with Enter or Space
- **THEN** the clipboard read and xterm paste follow the same behavior as touch activation

#### Scenario: Clipboard read cannot provide text
- **WHEN** the Clipboard API is unavailable, invocation throws synchronously, the read rejects, or the clipboard is empty
- **THEN** nothing is written to the PTY
- **AND** no error escapes the Paste action
- **AND** the terminal keeps keyboard focus

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

### Requirement: Touch mode renders one terminal pane at a time
In touch mode the terminal panel SHALL render exactly one pane — the active pane — filling the terminal surface, and SHALL hide every other pane without detaching it. Hiding SHALL be presentation-only: hidden panes keep their PTY attachment, keep receiving output into scrollback, and keep their persisted pane records and split geometry, all of which reappear unchanged in desktop mode. Input affordances that address "the active pane" — keybar sequences, sticky Ctrl, Paste, the selection transcript, and terminal find — SHALL address the visible pane. The Terminal tab's output badge SHALL reflect output from any attached pane, not only the visible one.

#### Scenario: Several attached panes show one
- **WHEN** three panes are attached and the panel renders in touch mode
- **THEN** exactly one pane is visible and fills the terminal surface
- **AND** the other two remain attached to their PTYs

#### Scenario: Hidden panes keep running
- **WHEN** a hidden pane's process emits output
- **THEN** the output lands in that pane's scrollback
- **AND** it is present when the user switches to that terminal

#### Scenario: Keybar addresses the visible pane
- **WHEN** the user taps Control-C in touch mode with several panes attached
- **THEN** the byte reaches the visible pane's PTY only

#### Scenario: Desktop renders the splits again
- **WHEN** a window with three attached panes is viewed in touch mode and then in desktop mode
- **THEN** desktop mode renders all three panes with their stored split geometry

### Requirement: Touch devices switch terminals from a switcher sheet
On coarse-pointer devices the terminal SHALL provide a switcher sheet, opened from the keybar, that lists this window's attached terminals and every server session the window is not showing, and SHALL offer a New terminal action. Each row SHALL carry the session's label, its state — visible, attached in this window, detached, or attached elsewhere — and a coarse age. Selecting a visible-or-attached row SHALL make that pane the visible pane. Selecting a detached session SHALL attach it as a new pane and make it visible. A session attached by another client SHALL require an explicit Take over activation, and SHALL never transfer from a plain row selection. Each listed session SHALL offer termination, which SHALL remove the resource; terminating the visible terminal SHALL fall back to another attached pane, or close the panel when none remains. New terminal SHALL create a server resource and attach a pane to it. When the pane cap is reached, New terminal and attach SHALL be disabled with a stated reason while switching between attached panes stays available. The sheet SHALL be dismissible without choosing, SHALL return focus to the visible pane on dismissal, and SHALL be the touch-mode replacement for the desktop session chooser — that chooser SHALL NOT render in touch mode.

#### Scenario: Switching between two attached terminals
- **WHEN** two panes are attached in touch mode and the user opens the switcher and selects the hidden terminal
- **THEN** that pane becomes the visible pane with its scrollback intact
- **AND** the sheet closes and focus lands in the now-visible pane

#### Scenario: Attaching a detached session from the switcher
- **WHEN** the switcher lists a detached session and the user selects it
- **THEN** a pane attaches to that session and becomes visible

#### Scenario: Creating a terminal from the switcher
- **WHEN** the user activates New terminal
- **THEN** the server creates a PTY, a pane attaches to it, and it becomes the visible terminal

#### Scenario: Taking over is explicit on touch
- **WHEN** the switcher lists a session attached by another window and the user selects its row
- **THEN** no attachment occurs
- **AND** transfer happens only when the user activates that row's Take over action

#### Scenario: Terminating the visible terminal
- **WHEN** the user terminates the visible terminal from the switcher and another attached pane exists
- **THEN** the resource is deleted and the remaining pane becomes visible

#### Scenario: Terminating the last terminal
- **WHEN** the user terminates the only attached terminal from the switcher
- **THEN** the resource is deleted and the terminal panel closes

#### Scenario: Pane cap disables creation
- **WHEN** the window already shows the maximum number of panes
- **THEN** New terminal and attach actions are disabled with a stated reason
- **AND** selecting an attached terminal still switches to it

#### Scenario: Dismissing without choosing
- **WHEN** the user dismisses the switcher without selecting a row
- **THEN** the visible terminal is unchanged and regains focus

#### Scenario: Touch mode never shows the desktop chooser
- **WHEN** a decision that would render the desktop session chooser arises in touch mode
- **THEN** the switcher is presented instead
