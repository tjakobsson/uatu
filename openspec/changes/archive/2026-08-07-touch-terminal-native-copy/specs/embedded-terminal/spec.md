## ADDED Requirements

### Requirement: Terminal output supports touch selection and Copy
On coarse-pointer clients, the terminal keybar SHALL provide a Select action that snapshots the active pane's bounded xterm buffer, including available scrollback and visible rows, into a document-level transcript outside the terminal panel's overflow and gesture hierarchy. The transcript SHALL use ordinary non-editable line DOM and document scrolling equivalent to Preview's selection model, SHALL initially position the document at the live end near the current prompt, and SHALL permit the platform's native long-press selection and Copy interaction. While transcript content uses terminal colors and typography, a fixed bottom action bar SHALL temporarily replace the touch tab bar and provide an always-reachable Done action that returns to the live terminal. While the transcript is open, the app shell SHALL remain mounted but visually parked and inert; PTY output MAY continue but MUST NOT mutate the static transcript. Done SHALL remove the transcript, restore the prior document position and terminal focus, and reveal output accumulated while it was open. Transcript Copy SHALL remain independent of terminal OSC 52 clipboard policy. Existing normal-mode TUI mouse reporting, keyboard clipboard shortcuts, touch Paste, and touch scrolling SHALL remain unchanged.

#### Scenario: Native Copy works in the document transcript
- **WHEN** an iPhone user activates Select and long-presses transcript text
- **THEN** iOS presents its ordinary text selection handles and Copy action
- **AND** activating Copy writes the selected transcript text to the system clipboard

#### Scenario: Transcript opens at current output
- **WHEN** the terminal has retained scrollback and the user enters Select while viewing the latest prompt
- **THEN** the transcript document opens at its live end near that prompt
- **AND** older retained output remains reachable by scrolling upward

#### Scenario: Transcript uses normal page layout
- **WHEN** terminal output contains long logical lines
- **THEN** transcript line DOM wraps to the viewport like normal reading content
- **AND** selection is not hosted by xterm or a pane-local momentum scroller

#### Scenario: Transcript remains stable while output continues
- **WHEN** new PTY output arrives while the transcript is open
- **THEN** the selectable transcript text remains unchanged
- **AND** Done returns to the live xterm containing the accumulated output

#### Scenario: Done restores terminal interaction
- **WHEN** the user activates the transcript's sticky Done action
- **THEN** the transcript closes and the app shell becomes visible
- **AND** xterm is no longer inert and receives focus

#### Scenario: Done remains reachable in long transcripts
- **WHEN** the transcript is longer than the viewport and the user scrolls anywhere in it
- **THEN** a bottom action bar remains fixed above the safe-area inset
- **AND** its Done action visually replaces the normal touch navigation until the transcript closes

#### Scenario: Transcript Copy is independent of OSC 52 policy
- **WHEN** `.uatu.json` configures `terminal.clipboard` as `off`
- **AND** the user copies selected transcript text through the native platform action
- **THEN** the selected text is copied
- **AND** Uatu emits no OSC 52 toast or PTY input

#### Scenario: Normal terminal and TUI behavior is unchanged
- **WHEN** Select is not active
- **THEN** ordinary terminal touch scrolling, keybar Paste, keyboard input, and xterm desktop selection retain their existing behavior
- **AND** mouse-aware TUIs retain their existing event and OSC 52 paths
