## MODIFIED Requirements

### Requirement: Touch devices get a terminal keybar
On coarse-pointer devices the terminal panel SHALL show a key row for input a software keyboard cannot produce — at minimum Escape, Tab, Control-C, Control-D, Control-Z, the arrow keys, Page Up, Page Down, Home, and End — sending each key's control sequence down the focused pane's PTY exactly as typed input travels. The row SHALL additionally provide a Paste action and a single-shot sticky Ctrl modifier: tapping Ctrl arms a latch, the next printable character typed is composed to its control character before reaching the PTY, and the latch releases; tapping Ctrl while armed cancels the latch. The armed state MUST be visually indicated and exposed via `aria-pressed`. Pressing any keybar affordance MUST NOT move focus out of the terminal, which would dismiss the software keyboard. Paste MUST request the system clipboard from a release-time or equivalent semantic button activation carrying transient user activation, MUST invoke at most one clipboard read and one terminal paste per activation, and MUST forward non-empty text through xterm's paste path so newline normalization and bracketed-paste mode are honored. Paste MUST remain keyboard-operable. An unavailable Clipboard API, a synchronous failure, a rejected read, or an empty clipboard MUST leave the action inert without PTY input or an uncaught error. The row SHALL NOT appear on fine-pointer devices. On devices with a bottom home-indicator inset, the row SHALL sit above the safe-area inset so taps do not trigger the system home gesture.

#### Scenario: Interrupting a process from an iPad
- **WHEN** a user on a coarse-pointer device runs a foreground process and taps the keybar's Control-C
- **THEN** the byte 0x03 reaches the PTY and the process receives the interrupt
- **AND** the terminal keeps keyboard focus

#### Scenario: Paging through a TUI
- **WHEN** a user on a coarse-pointer device has a pager open and taps the keybar's Page Down
- **THEN** the sequence 0x1b `[6~` reaches the PTY
- **AND** the terminal keeps keyboard focus

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
