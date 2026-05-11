## ADDED Requirements

### Requirement: Terminal supports Windows-Terminal-parity clipboard shortcuts

Each terminal pane SHALL intercept a fixed set of clipboard keyboard shortcuts before `xterm.js` interprets them as PTY keystrokes, using `xterm.js`'s `attachCustomKeyEventHandler` API. The intercepted set and behavior SHALL match Microsoft's Windows Terminal so that users get the same muscle memory inside UatuCode. macOS Cmd-modified shortcuts SHALL remain unchanged from `xterm.js`'s defaults — the handler SHALL NOT alter their behavior.

#### Scenario: Bare Ctrl+C with a selection copies and clears the selection

- **WHEN** the user has highlighted text in a terminal pane on Windows or Linux
- **AND** the user presses `Ctrl+C` with no other modifiers
- **THEN** the highlighted text is written to the system clipboard via `navigator.clipboard.writeText`
- **AND** the terminal's selection is cleared
- **AND** no byte is sent to the PTY (the SIGINT byte `0x03` is not transmitted)

#### Scenario: Bare Ctrl+C without a selection sends SIGINT

- **WHEN** the terminal pane has no selection on Windows or Linux
- **AND** the user presses `Ctrl+C` with no other modifiers
- **THEN** the byte `0x03` (ETX) is sent to the PTY
- **AND** the clipboard is not modified

#### Scenario: Bare Ctrl+V pastes the clipboard

- **WHEN** the user has text in the system clipboard
- **AND** the user presses `Ctrl+V` with no other modifiers in a terminal pane on Windows or Linux
- **THEN** the clipboard text is retrieved via `navigator.clipboard.readText` and forwarded through `term.paste`
- **AND** the byte `0x16` (`^V`) is NOT sent to the PTY
- **AND** bracketed-paste markers are emitted around the pasted content when the shell has enabled bracketed-paste mode

#### Scenario: Ctrl+Shift+C copies the selection

- **WHEN** the user has highlighted text in a terminal pane on Windows or Linux
- **AND** the user presses `Ctrl+Shift+C`
- **THEN** the highlighted text is written to the system clipboard
- **AND** no further handling fires (the browser's DevTools shortcut does not open)

#### Scenario: Ctrl+Shift+C with no selection is a no-op

- **WHEN** the terminal pane has no selection
- **AND** the user presses `Ctrl+Shift+C`
- **THEN** the clipboard is not modified
- **AND** the byte sequence corresponding to `Ctrl+Shift+C` is NOT sent to the PTY
- **AND** the browser's DevTools shortcut does not open

#### Scenario: Ctrl+Shift+V pastes the clipboard

- **WHEN** the user has text in the system clipboard
- **AND** the user presses `Ctrl+Shift+V` in a terminal pane on Windows or Linux
- **THEN** the clipboard text is retrieved via `navigator.clipboard.readText` and forwarded through `term.paste`
- **AND** bracketed-paste markers are emitted around the pasted content when the shell has enabled bracketed-paste mode

#### Scenario: macOS Cmd+C copies via the existing xterm.js path

- **WHEN** the user has highlighted text in a terminal pane on macOS
- **AND** the user presses `Cmd+C`
- **THEN** the highlighted text is written to the system clipboard by `xterm.js`'s built-in `copy` event hook
- **AND** the custom handler does not intercept the event

#### Scenario: macOS bare Ctrl+C still sends SIGINT regardless of selection

- **WHEN** the user has highlighted text in a terminal pane on macOS
- **AND** the user presses `Ctrl+C`
- **THEN** the byte `0x03` (ETX) is sent to the PTY
- **AND** the highlighted text remains highlighted and is NOT copied (the custom Windows/Linux selection-aware branch does not run on macOS)

#### Scenario: Paste failure is silent

- **WHEN** the user presses `Ctrl+V` or `Ctrl+Shift+V`
- **AND** `navigator.clipboard.readText` rejects (permission denied, focus lost, or unsupported)
- **THEN** the terminal renders no output
- **AND** the PTY receives no bytes for this keystroke
- **AND** no user-visible error modal is shown

### Requirement: Installed PWA acquires Keyboard Lock for `KeyC`

When the page is running in `display-mode: standalone` AND `navigator.keyboard.lock` is available, the application SHALL request `navigator.keyboard.lock(['KeyC'])` at most once per page so that `Ctrl+Shift+C` is delivered to the page instead of being consumed by the browser as a DevTools shortcut. The lock request SHALL be best-effort: failure or unsupported browsers SHALL NOT surface a user-visible error and SHALL NOT block any other terminal functionality.

#### Scenario: Standalone PWA on a supporting browser acquires the lock

- **WHEN** the user opens UatuCode as an installed PWA in standalone mode on Chromium-based Edge
- **AND** a terminal pane is opened
- **THEN** `navigator.keyboard.lock(['KeyC'])` is called exactly once
- **AND** subsequent `Ctrl+Shift+C` keystrokes inside the PWA reach the custom key handler
- **AND** the browser's DevTools "inspect element" shortcut does not open

#### Scenario: Browser tab does not acquire the lock

- **WHEN** the user opens UatuCode in a regular browser tab (`display-mode: browser`)
- **AND** a terminal pane is opened
- **THEN** `navigator.keyboard.lock` is NOT called
- **AND** the terminal still functions; users on Windows can still copy via bare `Ctrl+C` with a selection, and pasting via `Ctrl+V` / `Ctrl+Shift+V` still works

#### Scenario: Browser without `navigator.keyboard` is unaffected

- **WHEN** the user opens UatuCode in a browser that does not implement the Keyboard Lock API (e.g., Firefox, Safari)
- **AND** a terminal pane is opened
- **THEN** no Keyboard Lock call is attempted
- **AND** no error is thrown or logged at user-visible severity
- **AND** the custom key handler still intercepts the supported clipboard shortcuts on Windows / Linux

#### Scenario: Multiple panes do not retry the lock

- **WHEN** the user opens a terminal pane that triggers a Keyboard Lock request
- **AND** the user splits the panel into multiple panes
- **THEN** `navigator.keyboard.lock` is still called exactly once for the page lifetime
- **AND** each pane's custom key handler is attached independently
