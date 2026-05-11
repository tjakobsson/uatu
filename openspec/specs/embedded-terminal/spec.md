## Purpose

Define the embedded terminal capability: a dockable panel in the UatuCode UI that hosts one or more `xterm.js`-rendered terminals connected to real PTY shell processes running in the watched repository's working directory, complete with token-gated transport, per-session WebSockets, persistence, theming, dock/display modes, multi-pane splits, and `.uatu.json`-driven font configuration.

## Requirements

### Requirement: Bottom panel hosts an interactive terminal
The UI SHALL provide a panel that, when visible, hosts one or more `xterm.js`-rendered terminals connected to real PTY shell processes running in the watched repository's working directory. The panel SHALL be hidden by default on first load and SHALL default its dock position to the bottom of the main content area.

#### Scenario: Panel is hidden on first load
- **WHEN** a user loads the UI for the first time with no persisted panel state
- **THEN** the panel is not rendered
- **AND** the preview area uses the full available height below the preview header

#### Scenario: Toggle reveals the panel with one pane
- **WHEN** the user activates the panel toggle control while the panel is hidden
- **THEN** the panel becomes visible at its persisted dock position and dimension (or the defaults: bottom dock, 240px height)
- **AND** the panel contains exactly one terminal pane
- **AND** the pane's terminal element receives keyboard focus
- **AND** within 500 milliseconds the pane's terminal is connected to a PTY and shows a shell prompt

#### Scenario: Toggle hides the panel
- **WHEN** the user activates the panel toggle control while the panel is visible
- **THEN** the panel is removed from layout
- **AND** all attached terminal WebSockets are closed
- **AND** the underlying PTY processes are terminated within the disconnect grace window
- **AND** no confirmation prompt is shown

### Requirement: Terminal works in the watched repository directory
When the panel attaches a PTY, the shell SHALL start with its working directory set to the first watch root resolved by the CLI, and SHALL use the user's default login shell as reported by the `SHELL` environment variable (falling back to `/bin/sh` if unset or invalid).

#### Scenario: PTY inherits watch root as cwd
- **WHEN** uatu is started as `uatu watch ./some/dir` and the user opens the terminal panel
- **AND** the user types `pwd` and presses Enter in the terminal
- **THEN** the terminal output shows the absolute path of `./some/dir`

#### Scenario: PTY uses default shell
- **WHEN** the user's `SHELL` environment variable is set to `/opt/homebrew/bin/fish`
- **AND** the user opens the terminal panel
- **THEN** the spawned PTY runs `/opt/homebrew/bin/fish`

### Requirement: Terminal honors `.uatu.json` font configuration
The server SHALL read the optional `terminal` block from `.uatu.json` at the watch root and surface validated values via `/api/state.terminalConfig`. The browser SHALL apply `terminal.fontFamily` (string) and `terminal.fontSize` (number, 8–32) to the xterm instance when present. Invalid values SHALL be ignored with a warning printed to stderr; the rest of the block remains in effect. The default font stack (in `--terminal-font-family`) prefers locally-installed Nerd Fonts so user shell prompts render their glyphs without bundling a font.

#### Scenario: Valid terminal config flows through state
- **WHEN** `.uatu.json` contains `{"terminal": {"fontFamily": "FiraCode Nerd Font Mono", "fontSize": 14}}`
- **AND** the user opens the terminal panel
- **THEN** `/api/state` returns `{"terminalConfig": {"fontFamily": "FiraCode Nerd Font Mono", "fontSize": 14}}`
- **AND** the rendered xterm instance uses those values

#### Scenario: Out-of-range fontSize is dropped with a warning
- **WHEN** `.uatu.json` contains `{"terminal": {"fontSize": 9999, "fontFamily": "Hack Nerd Font Mono"}}`
- **THEN** the server logs a warning about the invalid `fontSize`
- **AND** `/api/state.terminalConfig` contains `fontFamily` only

#### Scenario: Missing terminal block falls back to defaults
- **WHEN** `.uatu.json` has no `terminal` block (or no `.uatu.json` exists)
- **THEN** `/api/state.terminalConfig` is absent
- **AND** the browser uses the default font stack from `--terminal-font-family`

### Requirement: Terminal is themed with the uatu ANSI dark palette
The terminal SHALL render text using a dark ANSI 16-color palette that matches the uatu UI theme out of the box, with no required configuration. The palette SHALL be driven by CSS variables so it can be overridden centrally.

#### Scenario: Default theme applied on first attach
- **WHEN** a user opens the terminal panel on a fresh install
- **THEN** the terminal background matches the uatu dark surface color
- **AND** the foreground, cursor, selection background, and 16 ANSI colors all resolve to defined values (no `null` or browser-default colors)

#### Scenario: Theme tracks CSS variable updates
- **WHEN** the page's `--terminal-bg` CSS variable is changed at runtime
- **AND** the terminal is re-themed (via re-attach or explicit refresh)
- **THEN** the new background color is reflected in the terminal canvas

### Requirement: Terminal panel is resizable and persistent
The panel SHALL be resizable via a drag handle on the edge facing the preview (top edge when bottom-docked, left edge when right-docked). When bottom-docked, height is clamped to `[120px, 70% of viewport height]`. When right-docked, width is clamped to `[280px, 60% of viewport width]`. The dock position, the most recent height (for bottom dock) and width (for right dock), the display mode, and the panel's hidden/visible state SHALL persist across reloads via `localStorage` and `sessionStorage`.

#### Scenario: Drag resizes the panel in the active dock orientation
- **WHEN** the panel is bottom-docked at 240px and the user drags the top resizer up by 100 pixels
- **THEN** the panel height increases to 340 pixels
- **AND** every pane's xterm fit addon recomputes the character grid so terminals resize without truncation

#### Scenario: Right-dock width is independently persisted
- **WHEN** the user resizes a right-docked panel to 420 pixels and reloads
- **THEN** on reattach the panel renders at 420 pixels wide
- **AND** the bottom-dock height (if previously set) is preserved unchanged for the next time the user docks to bottom

#### Scenario: Hidden state persists across reload
- **WHEN** the user hides the panel and reloads the page
- **THEN** on the next load the panel is hidden and no PTY is spawned

#### Scenario: Legacy persistence is migrated on first load after upgrade
- **WHEN** a returning user has only legacy `uatu:terminal-visible` and `uatu:terminal-height` keys set
- **THEN** the next load reads those values and writes the new persistence shape (dock=bottom, bottomHeight=<legacy height>)
- **AND** the user sees the panel at the same height it had before the upgrade

### Requirement: Server exposes a token-gated terminal WebSocket
The server SHALL expose a single WebSocket upgrade endpoint that proxies bytes between the browser and a real PTY shell process. The upgrade SHALL be rejected unless the request carries a valid per-server-session token, a syntactically valid `sessionId` query parameter (UUID), AND its `Origin` header matches the server's bound origin or the registered PWA origin. A given `sessionId` already in use SHALL be rejected so concurrent PTYs cannot be cross-wired.

#### Scenario: Valid token, sessionId, and origin succeed
- **WHEN** the browser sends a WebSocket upgrade to `/api/terminal?t=<valid-token>&sessionId=<fresh-uuid>` with `Origin: http://127.0.0.1:<port>`
- **THEN** the server upgrades the connection and spawns a PTY associated with that `sessionId`

#### Scenario: Missing sessionId is rejected
- **WHEN** the browser sends a WebSocket upgrade to `/api/terminal?t=<valid-token>` with no `sessionId` parameter
- **THEN** the server responds with HTTP 400 and does not spawn a PTY

#### Scenario: Malformed sessionId is rejected
- **WHEN** the browser sends a WebSocket upgrade with `sessionId=not-a-uuid`
- **THEN** the server responds with HTTP 400 and does not spawn a PTY

#### Scenario: Duplicate sessionId is rejected
- **WHEN** a `sessionId` is already attached to an active PTY
- **AND** another upgrade arrives with the same `sessionId` and a valid token
- **THEN** the server responds with HTTP 409 and does not spawn a second PTY

#### Scenario: Missing token is rejected
- **WHEN** the browser sends a WebSocket upgrade to `/api/terminal?sessionId=<fresh-uuid>` with no `t` query parameter
- **THEN** the server responds with HTTP 401 and does not spawn a PTY

#### Scenario: Foreign origin is rejected
- **WHEN** a client sends a WebSocket upgrade to `/api/terminal?t=<valid-token>&sessionId=<fresh-uuid>` with `Origin: http://attacker.example`
- **THEN** the server responds with HTTP 403 and does not spawn a PTY

#### Scenario: Token is unique per server start
- **WHEN** the server is restarted
- **THEN** the previous token no longer authenticates terminal upgrades

### Requirement: Terminal lifecycle is bounded by the connection
For each `sessionId`, the PTY SHALL be spawned on a successful WebSocket upgrade and terminated when its WebSocket closes. The server MAY hold the PTY for a reconnect grace window of up to 5 seconds, keyed by `sessionId`, before sending `SIGHUP`/`SIGTERM`, to absorb page reloads.

#### Scenario: Disconnect kills the PTY
- **WHEN** the browser closes a terminal WebSocket
- **AND** no upgrade with the same `sessionId` arrives within 5 seconds
- **THEN** that PTY process receives `SIGHUP` and is reaped

#### Scenario: Reload reattaches to the same PTY within grace
- **WHEN** the browser disconnects and within 5 seconds opens a new WebSocket with the same `sessionId` and a valid token
- **THEN** the server reuses the existing PTY for that session and resumes I/O without spawning a new one

#### Scenario: Server shutdown kills all PTYs
- **WHEN** the uatu server is stopped (Ctrl+C or idle timeout)
- **THEN** every live PTY is terminated as part of shutdown

### Requirement: Terminal entry point lives in the sidebar
The control that toggles the terminal panel's visibility SHALL be located in the sidebar's mode-control region, adjacent to (and orthogonal with) the Author/Review mode controls. The control SHALL display the keyboard hint for the toggle shortcut. The terminal SHALL NOT be presented as a third mutually-exclusive mode alongside Author and Review.

#### Scenario: Sidebar toggle reveals the terminal
- **WHEN** the user clicks the "Terminal" control in the sidebar with the panel hidden
- **THEN** the panel becomes visible
- **AND** the Author/Review mode selection is unchanged

#### Scenario: Mode switches preserve terminal visibility
- **WHEN** the panel is visible
- **AND** the user toggles between Author and Review modes
- **THEN** the panel remains visible across the switch
- **AND** all attached PTYs remain alive

#### Scenario: No terminal entry point in the preview toolbar
- **WHEN** the UI renders with the embedded-terminal feature enabled
- **THEN** there is no terminal toggle button rendered inside the preview toolbar

### Requirement: Closing the terminal pane confirms loss of session
When the user clicks the close (×) control on a pane that has at least one attached PTY, the UI SHALL display a confirmation modal warning that the shell session will be lost. The modal SHALL default focus to the cancel action and SHALL dismiss on `Esc`. The PTY SHALL only be torn down after the user explicitly confirms. Confirmation SHALL NOT be shown for the keyboard panel toggle, minimize, fullscreen toggle, or for closing a pane whose WebSocket is already detached.

#### Scenario: Close button on attached pane prompts confirmation
- **WHEN** a pane has an attached PTY
- **AND** the user clicks its close (×) button
- **THEN** a confirmation modal appears with text describing that the session will be lost
- **AND** focus is on the cancel action

#### Scenario: Cancel keeps the PTY alive
- **WHEN** the confirmation modal is open
- **AND** the user activates Cancel or presses `Esc`
- **THEN** the modal closes
- **AND** the pane remains visible
- **AND** the PTY remains attached and running

#### Scenario: Confirm tears down the pane
- **WHEN** the confirmation modal is open
- **AND** the user activates "Close terminal"
- **THEN** the pane's WebSocket closes
- **AND** the underlying PTY is reaped within the grace window
- **AND** the pane is removed from the panel; if it was the last pane, the panel hides

#### Scenario: Keyboard toggle does not prompt
- **WHEN** the user presses the panel toggle keyboard shortcut while the panel is visible
- **THEN** the panel hides without showing a confirmation modal

#### Scenario: Detached pane closes without prompting
- **WHEN** a pane's PTY has already been reaped (e.g., shell exited)
- **AND** the user clicks the pane's close button
- **THEN** the pane is removed immediately with no confirmation modal

### Requirement: Panel supports minimize and fullscreen display modes
The panel header SHALL provide minimize and fullscreen controls in addition to the close control. Minimize SHALL collapse the panel body to a header bar while keeping every PTY attached. Fullscreen SHALL expand the panel to fill the main content area (preserving the sidebar and topbar). Both display-mode changes SHALL be reversible without losing PTY state, and the active display mode SHALL persist across reloads.

#### Scenario: Minimize collapses without losing the session
- **WHEN** a pane is running an active process (e.g., `tail -f` is producing output)
- **AND** the user clicks minimize
- **THEN** the panel body is hidden and only the header bar remains visible
- **AND** every PTY remains attached
- **AND** restoring the panel resumes display of accumulated output

#### Scenario: Fullscreen expands within the app grid
- **WHEN** the user clicks fullscreen
- **THEN** the panel expands to cover the main content area
- **AND** the sidebar and the topbar remain visible
- **AND** xterm fit recalculates so panes use the new dimensions

#### Scenario: Esc exits fullscreen
- **WHEN** the panel is in fullscreen mode
- **AND** the user presses `Esc` (and no confirmation modal is open)
- **THEN** the panel returns to its previous display mode (normal or minimized)
- **AND** PTYs remain attached

#### Scenario: Display mode persists across reload
- **WHEN** the user puts the panel in fullscreen mode and reloads the page
- **THEN** on reload the panel is restored to fullscreen mode

### Requirement: Panel can dock to the bottom or the right
The panel SHALL support two dock positions, `bottom` and `right`. The user SHALL be able to switch between them via a control in the panel header. Switching dock positions SHALL preserve every attached PTY (no remount). When the viewport is narrower than 720 pixels, the right dock SHALL not be available and the panel SHALL fall back to the bottom dock automatically.

#### Scenario: User switches dock from bottom to right
- **WHEN** the panel is bottom-docked and the user activates the dock-right control
- **THEN** the panel relocates to the right side of the main content area
- **AND** every attached PTY remains alive
- **AND** every xterm instance is refit to the new dimensions

#### Scenario: Dock choice persists across reload
- **WHEN** the user docks the panel to the right and reloads
- **THEN** the panel renders right-docked at its persisted right-dock width

#### Scenario: Narrow viewport falls back to bottom dock
- **WHEN** the panel is right-docked and the viewport width drops below 720 pixels
- **THEN** the panel automatically docks to the bottom
- **AND** the persisted dock preference remains "right" so the panel re-docks to the right when the viewport widens again

### Requirement: Panel supports splitting into multiple terminal panes
The panel SHALL provide a split control that creates an additional concurrent terminal pane within the same panel, each backed by its own PTY and `sessionId`. The number of panes is bounded by a soft cap (8) and by the per-pane minimum drag size (so panes never collapse below a usable width); the split control SHALL be disabled when the cap is reached. Split orientation SHALL be perpendicular to the dock axis: panes are side-by-side when bottom-docked, stacked when right-docked. Each pane SHALL have its own focus, its own close (×) control, and its own resizer between it and each sibling pane. Closing the last remaining pane SHALL also hide the panel.

#### Scenario: Split spawns a second pane with a fresh PTY
- **WHEN** a single-pane panel is open and the user activates split
- **THEN** a second pane appears
- **AND** within 500 milliseconds it is connected to a new PTY with its own `sessionId`
- **AND** keyboard focus moves to the new pane

#### Scenario: Split orientation matches dock
- **WHEN** the panel is bottom-docked and split
- **THEN** the two panes are arranged side-by-side, each occupying half the panel width by default
- **WHEN** the panel is right-docked and split
- **THEN** the two panes are stacked, each occupying half the panel height by default

#### Scenario: Inter-pane resizer adjusts split ratio
- **WHEN** the panel is split
- **AND** the user drags the resizer between the two panes
- **THEN** the panes' relative sizes change accordingly
- **AND** both xterm fit addons recompute their grids

#### Scenario: Split control disabled at the soft cap
- **WHEN** the panel already has the maximum number of panes (8)
- **THEN** the split control is disabled

#### Scenario: Closing the last pane hides the panel
- **WHEN** the panel has one pane (the user has previously closed the other or never split)
- **AND** the user closes the remaining pane (after confirmation, if it has an attached PTY)
- **THEN** the panel is removed from layout
- **AND** the persisted visibility flag becomes hidden

#### Scenario: Closing one of multiple panes keeps the panel open
- **WHEN** the panel has two or more panes
- **AND** the user closes one (after confirmation, if attached)
- **THEN** that pane is removed
- **AND** the remaining panes expand to share the freed space
- **AND** the panel and the other PTYs remain visible

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

#### Scenario: Ctrl+Shift+C copies the selection and clears it
- **WHEN** the user has highlighted text in a terminal pane on Windows or Linux
- **AND** the user presses `Ctrl+Shift+C`
- **THEN** the highlighted text is written to the system clipboard
- **AND** the terminal's selection is cleared (matches Windows Terminal — the disappearing markings are the user-visible confirmation that the copy fired)
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
