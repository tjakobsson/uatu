## MODIFIED Requirements

### Requirement: Terminal protocol carries input, output, and resize
The browser-server protocol on the terminal WebSocket SHALL carry shell input as binary frames written to the PTY's stdin, shell output as binary frames written from the PTY's stdout/stderr, and terminal resize events as small JSON frames of the shape `{"type":"resize","cols":<n>,"rows":<n>}`. Shell output bytes SHALL be forwarded from the PTY to the browser without any UTF-8 decode/re-encode round trip on the server, so that arbitrary multi-byte codepoints split across PTY `read()` chunk boundaries are preserved end-to-end and reach the xterm.js parser intact.

#### Scenario: Keystrokes reach the shell
- **WHEN** the user types `echo hi` and presses Enter in the terminal
- **THEN** within 200 milliseconds the terminal renders a line containing `hi` from the shell's stdout

#### Scenario: Resize syncs the PTY
- **WHEN** the panel is resized so xterm-addon-fit reports `cols=120, rows=30`
- **THEN** the client sends a resize frame
- **AND** the server calls the PTY's `resize(120, 30)`
- **AND** running TUI applications redraw at the new dimensions

#### Scenario: Multi-byte UTF-8 split across chunk boundaries renders without replacement characters
- **WHEN** a PTY emits a sequence containing the 3-byte UTF-8 codepoint `─` (`U+2500`, bytes `E2 94 80`) and the chunk boundary falls between any two of those bytes
- **THEN** the rendered xterm buffer contains the original `─` character
- **AND** no `U+FFFD REPLACEMENT CHARACTER` is introduced at the seam
- **AND** the rendered cell count for the line equals the number of source codepoints (no extra cells from spurious replacements)

#### Scenario: Concurrent terminal sessions do not corrupt each other's output
- **WHEN** two terminal panes are open in the same browser tab and both PTYs simultaneously emit dense multi-byte output (e.g., box-drawing characters)
- **THEN** each pane renders only the codepoints emitted by its own PTY
- **AND** no `U+FFFD` is introduced by partial-codepoint state leaking between sessions
