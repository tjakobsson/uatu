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
When the panel attaches a PTY, the shell SHALL start with its working directory set to the first watch root resolved by the CLI. The shell selection SHALL prefer a valid explicit terminal-server shell override, then the `SHELL` environment variable when it is non-empty, and SHALL fall back to `/bin/sh` only when those are unset or empty. The terminal SHALL NOT reconstruct the user's login shell from the user database. When `SHELL` is unset or empty and the terminal backend is available, uatu SHALL print a warning to stdout once at startup explaining that terminals will run `/bin/sh` instead of the user's login shell. When a terminal subsequently falls back to `/bin/sh`, uatu SHALL write a notice into each newly opened terminal session before the shell's first prompt. uatu SHALL NOT synthesize or modify the `SHELL` variable in the spawned PTY environment; the child inherits `SHELL` exactly as uatu received it.

#### Scenario: PTY inherits watch root as cwd
- **WHEN** uatu is started as `uatu watch ./some/dir` and the user opens the terminal panel
- **AND** the user types `pwd` and presses Enter in the terminal
- **THEN** the terminal output shows the absolute path of `./some/dir`

#### Scenario: PTY uses valid SHELL environment value
- **WHEN** the user's `SHELL` environment variable is set to `/opt/homebrew/bin/fish`
- **AND** the user opens the terminal panel
- **THEN** the spawned PTY runs `/opt/homebrew/bin/fish`
- **AND** the PTY inherits `SHELL=/opt/homebrew/bin/fish` unchanged
- **AND** no fallback warning is emitted

#### Scenario: Unset SHELL warns once at startup
- **WHEN** uatu starts with `SHELL` unset or empty
- **AND** the terminal backend is available
- **THEN** a warning naming `$SHELL` and `/bin/sh` is printed to stdout once at startup
- **AND** the warning is not repeated when terminal sessions are subsequently opened

#### Scenario: Missing SHELL falls back to sh with an in-terminal notice
- **WHEN** the user's `SHELL` environment variable is unset or empty
- **AND** no explicit terminal-server shell override is configured
- **AND** the user opens the terminal panel
- **THEN** the spawned PTY runs `/bin/sh`
- **AND** the spawned PTY's `SHELL` remains unset — uatu does not synthesize it
- **AND** a notice naming `$SHELL` and `/bin/sh` is written into the terminal session

### Requirement: Terminal honors `.uatu.json` font configuration
The server SHALL read the optional `terminal` block from `.uatu.json` at the watch root and surface validated values via `/api/state.terminalConfig`. The browser SHALL apply `terminal.fontFamily` (string) and `terminal.fontSize` (number, 8–32) to the xterm instance when present. Invalid values SHALL be ignored with a warning printed to stderr; the rest of the block remains in effect. The terminal's default font SHALL be `var(--terminal-font-family)`, which falls through to `var(--mono-font-family)` and ultimately to the bundled Hack Nerd Font Mono face when no override is configured — so that both ASCII and Nerd Font icon glyphs render correctly out of the box in every browser (including Safari, which does not expose user-installed system fonts to web pages). A `terminal.fontFamily` value in `.uatu.json` SHALL fully override the terminal's default. When both `mono.fontFamily` and `terminal.fontFamily` are configured, `terminal.fontFamily` is the narrower override that wins inside the terminal panel; `mono.fontFamily` continues to apply to every other monospace surface.

#### Scenario: Override beats the bundled default

- **WHEN** `.uatu.json` contains `{"terminal": {"fontFamily": "FiraCode Nerd Font Mono", "fontSize": 14}}`
- **AND** the user opens the terminal panel
- **THEN** `/api/state` returns `{"terminalConfig": {"fontFamily": "FiraCode Nerd Font Mono", "fontSize": 14}}`
- **AND** the rendered xterm instance uses `FiraCode Nerd Font Mono` (not the bundled Hack Nerd Font Mono)

#### Scenario: Out-of-range fontSize is dropped with a warning

- **WHEN** `.uatu.json` contains `{"terminal": {"fontSize": 9999, "fontFamily": "Hack Nerd Font Mono"}}`
- **THEN** the server logs a warning about the invalid `fontSize`
- **AND** `/api/state.terminalConfig` contains `fontFamily` only

#### Scenario: Missing terminal block falls back to the bundled default

- **WHEN** `.uatu.json` has no `terminal` block (or no `.uatu.json` exists)
- **AND** no `mono.fontFamily` override is configured either
- **THEN** `/api/state.terminalConfig` is absent
- **AND** the browser renders the terminal using the bundled Hack Nerd Font Mono face (via `--terminal-font-family` → `--mono-font-family`)

#### Scenario: Bundled default renders in Safari with no local Nerd Font installed

- **WHEN** the user opens the terminal panel in Safari
- **AND** no `.uatu.json terminal.fontFamily` override is set
- **AND** the user's machine has no Nerd Font installed
- **THEN** the terminal renders ASCII glyphs using the bundled Hack Nerd Font Mono face
- **AND** the terminal renders the Private-Use-Area codepoint `U+E0B0` (powerline right-arrow) using a real glyph (not TOFU)

#### Scenario: Bundled default renders in a clean Chromium profile

- **WHEN** the user opens the terminal panel in a freshly-installed Chromium with no extra fonts
- **AND** no `.uatu.json terminal.fontFamily` override is set
- **THEN** the terminal renders ASCII glyphs using the bundled Hack Nerd Font Mono face
- **AND** the terminal renders Nerd Font icon codepoints using real glyphs (not TOFU)

#### Scenario: terminal.fontFamily wins over mono.fontFamily inside the panel

- **WHEN** `.uatu.json` contains `{"mono": {"fontFamily": "Berkeley Mono, monospace"}, "terminal": {"fontFamily": "JetBrains Mono, monospace"}}`
- **AND** the user opens the terminal panel
- **THEN** the xterm instance uses `"JetBrains Mono"` (the narrower override)
- **AND** code blocks and other non-terminal monospace surfaces use `"Berkeley Mono"`

#### Scenario: Only mono.fontFamily set — terminal inherits from mono

- **WHEN** `.uatu.json` contains `{"mono": {"fontFamily": "Berkeley Mono, monospace"}}` and no `terminal.fontFamily`
- **AND** the user opens the terminal panel
- **THEN** the xterm instance uses `"Berkeley Mono"` (inherited via `--terminal-font-family` → `--mono-font-family`)

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
The server SHALL expose a single WebSocket upgrade endpoint that proxies bytes between the browser and a real PTY shell process. The upgrade SHALL be rejected unless the request carries a valid per-server-session token, a syntactically valid `sessionId` query parameter (UUID), AND its `Origin` header passes the origin gate. The origin gate SHALL accept an Origin whose hostname is `localhost` or `127.0.0.1` AND whose port equals the port of the request's `Host` header; ports SHALL be compared after default-port normalization (an absent port means 80 for `http` and 443 for `https`). The server's listen port SHALL NOT participate in the comparison, so the gate holds unchanged when the browser reaches the server through a mapped port. A given `sessionId` already in use SHALL be rejected so concurrent PTYs cannot be cross-wired.

#### Scenario: Valid token, sessionId, and origin succeed
- **WHEN** the browser sends a WebSocket upgrade to `/api/terminal?t=<valid-token>&sessionId=<fresh-uuid>` with `Origin: http://127.0.0.1:<port>` and `Host: 127.0.0.1:<port>`
- **THEN** the server upgrades the connection and spawns a PTY associated with that `sessionId`

#### Scenario: Port-mapped access succeeds without configuration
- **WHEN** the server listens on port 4711 inside a container published to host port 4712
- **AND** the browser sends a WebSocket upgrade with a valid token and fresh `sessionId`, `Origin: http://localhost:4712`, and `Host: localhost:4712`
- **THEN** the server upgrades the connection and spawns a PTY

#### Scenario: Page on another localhost port is rejected
- **WHEN** a page served from `localhost:9999` sends a WebSocket upgrade with a valid token to the server reached at `Host: localhost:4712`, carrying `Origin: http://localhost:9999`
- **THEN** the server responds with HTTP 403 and does not spawn a PTY

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
- **AND** this holds even when the Origin's port equals the Host header's port (a DNS-rebinding origin such as `http://evil.example:4712` against `Host: evil.example:4712` fails the hostname pin)

#### Scenario: Token is unique per server start
- **WHEN** the server is restarted
- **THEN** the previous token no longer authenticates terminal upgrades

### Requirement: Terminal WebSocket URL excludes fragment identifiers
The browser-side terminal WebSocket URL builder SHALL strip the fragment identifier (`#…`) from the constructed URL before passing it to the `WebSocket` constructor. The fragment from `window.location` MUST NOT be propagated into the WebSocket URL. This applies to every connection attempt: initial attach, reconnect after disconnect, and reattach within the PTY grace window.

#### Scenario: Deep-link refresh does not throw
- **WHEN** a user loads a page whose URL is `http://localhost:<port>/some/doc.md#user-content-section-id`
- **AND** the persisted terminal-visibility preference is true
- **THEN** the terminal pane attaches and constructs its WebSocket URL without raising a `SyntaxError`
- **AND** the WebSocket URL passed to `new WebSocket(...)` has no `#` component

#### Scenario: Reconnect after disconnect does not regrow a fragment
- **WHEN** a terminal pane reconnects (e.g. after the user re-enables the panel within the PTY grace window) on a page whose URL still carries a fragment
- **THEN** the reconnect WebSocket URL also has no fragment identifier

### Requirement: Terminal first paint converges without user resize
The terminal pane's first attach on boot, including the restore-on-refresh path that calls `setVisible(true)` from the persisted visibility preference, SHALL converge to a correctly-sized character grid without requiring a user-initiated resize. When PTY output is buffered before the WebSocket fully opens, that buffered output SHALL render to the visible canvas on the first paint after the WebSocket opens. The terminal MUST NOT remain visually empty after the page has finished loading.

#### Scenario: Refresh on a visible terminal renders existing output
- **WHEN** a user has the terminal panel visible with a running shell, then refreshes the page
- **AND** the panel is restored from persisted visibility preference
- **THEN** within one second of page load, the terminal pane displays the shell's current output
- **AND** no user-initiated resize is required for the output to become visible

#### Scenario: First paint after WebSocket open redraws cleanly
- **WHEN** a fresh pane attaches and its WebSocket transitions to `OPEN`
- **THEN** the terminal's character grid matches the visible panel dimensions
- **AND** any output sent by the PTY during the layout-settling window is visible

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
When the user clicks the close (×) control on a pane that has at least one attached PTY, the UI SHALL display a confirmation modal warning that the shell session will be lost. The modal SHALL default focus to the cancel action and SHALL dismiss on `Esc`. The PTY SHALL only be torn down after the user explicitly confirms, and teardown SHALL be effected by sending the explicit terminate signal to the server before closing the pane's WebSocket. Confirmation SHALL NOT be shown for the keyboard panel toggle, minimize, fullscreen toggle, or for closing a pane whose shell has already exited.

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
- **THEN** the client sends the explicit terminate signal and the pane's WebSocket closes
- **AND** the underlying PTY is killed by the server
- **AND** the pane is removed from the panel; if it was the last pane, the panel hides

#### Scenario: Keyboard toggle does not prompt
- **WHEN** the user presses the panel toggle keyboard shortcut while the panel is visible
- **THEN** the panel hides without showing a confirmation modal
- **AND** no PTY is terminated

#### Scenario: Exited pane closes without prompting
- **WHEN** a pane's shell process has already exited
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

### Requirement: Detached PTY sessions persist until shell exit or server shutdown
For each `sessionId`, the PTY SHALL be spawned on a successful WebSocket upgrade. When the WebSocket closes without an explicit terminate signal (tab close, browser quit, system sleep, network drop), the server SHALL detach the socket and keep the PTY running, keyed by `sessionId`, with no time limit. A detached session SHALL end only when its shell process exits, when the server shuts down, or when a client explicitly terminates it. A subsequent upgrade carrying the same `sessionId` SHALL reattach to the live PTY and SHALL replay recent output from the bounded replay buffer to seed the new client's canvas.

#### Scenario: Browser close leaves the shell running
- **WHEN** the browser closes a terminal WebSocket without sending the explicit terminate signal
- **THEN** the PTY process keeps running
- **AND** the session remains registered under its `sessionId` indefinitely

#### Scenario: Reattach after an arbitrary detachment
- **WHEN** a session is detached (e.g., the machine slept or the browser was closed)
- **AND** a new WebSocket upgrade arrives later with the same `sessionId` and a valid token
- **THEN** the server reuses the existing PTY without spawning a new one
- **AND** recent output from the replay buffer is delivered to the new client

#### Scenario: Explicit terminate kills the PTY
- **WHEN** an attached client sends the explicit terminate signal for its session
- **THEN** the PTY receives `SIGHUP`
- **AND** the session is removed so a later upgrade with the same `sessionId` spawns a fresh PTY

#### Scenario: Shell exit while detached removes the session
- **WHEN** a detached session's shell process exits
- **THEN** the session is removed from the registry
- **AND** a later upgrade with the same `sessionId` spawns a fresh PTY

#### Scenario: Server shutdown kills all PTYs
- **WHEN** the uatu server is stopped
- **THEN** every live PTY — attached or detached — is terminated as part of shutdown

### Requirement: Terminal grid fits within the visible pane
The terminal character grid SHALL always fit entirely within its pane host's content box: `rows × cellHeight` SHALL NOT exceed the vertical space available inside the pane's padding, and `cols × cellWidth` (plus the scrollbar allowance) SHALL NOT exceed the horizontal space. Grid-size measurements SHALL account for any padding applied around the terminal element so that no character row or column is ever clipped by the pane's overflow bounds. This SHALL hold at any pane size, including sizes produced by dragging the panel or inter-pane resizers to arbitrary pixel positions, in both docks, for single panes and splits.

#### Scenario: Bottom row is fully visible at arbitrary pane heights
- **WHEN** the terminal panel or an inter-pane resizer is dragged so a pane lands on an arbitrary pixel height
- **THEN** the rendered grid's height (`rows × cellHeight`) is less than or equal to the pane host's content-box height
- **AND** the last character row is fully visible, not partially clipped

#### Scenario: Content at a split boundary is not swallowed
- **WHEN** two panes are split and a shell prompt or TUI status line renders on the last row of the upper/left pane
- **THEN** that row renders completely inside its own pane
- **AND** no pixels of it are clipped by or bleed toward the neighboring pane

#### Scenario: Padding is accounted for in fit measurement
- **WHEN** visual padding is applied around the terminal rendering area
- **THEN** the fit measurement subtracts that padding before computing rows and columns
- **AND** the proposed grid changes accordingly rather than overflowing the clip bounds

### Requirement: A sessionId collision resolves to a fresh session, not an auth prompt
When a terminal WebSocket closes before opening, the client SHALL NOT assume an authentication failure. The client SHALL probe `GET /api/auth`. The server SHALL answer the probe with one of three verdicts: 204 when the request carries valid terminal credentials (auth cookie or `t` query token) AND the requester's effective origin passes the same origin gate as the WebSocket upgrade; 403 when credentials are valid but the effective origin is rejected; 401 when credentials are invalid. The effective origin SHALL be the request's `Origin` header when present, and otherwise SHALL be synthesized from the request's scheme and `Host` header (exact for the client's same-origin fetch). The probe and the upgrade gate SHALL share one origin predicate so their verdicts cannot diverge for the same request shape.

The client SHALL map the verdicts to distinct outcomes: on 204 it SHALL treat the failed upgrade as a `sessionId` collision, mint a fresh `sessionId` for the pane, and reconnect; on 403 it SHALL show an origin-rejected notice that names the address mismatch as the cause and SHALL NOT show the paste-token form or claim the server restarted; on 401 it SHALL show the paste-token form. The paste-token form SHALL be shown only for the 401 verdict.

#### Scenario: Second window gets its own shell without a token prompt
- **WHEN** a second browser window of the same uatu instance opens the terminal while the first window holds the persisted `sessionId`
- **THEN** the second window's pane connects with a freshly minted `sessionId` and reaches a working shell
- **AND** no paste-token form is shown

#### Scenario: First window is unaffected by the collision
- **WHEN** the second window resolves its collision with a fresh session
- **THEN** the first window's attached session continues uninterrupted

#### Scenario: Genuine auth failure still shows the paste-token form
- **WHEN** a terminal WebSocket closes before opening
- **AND** `GET /api/auth` returns 401 (stale cookie after a uatu restart, or a fresh PWA window with no credentials)
- **THEN** the paste-token form is shown

#### Scenario: Origin rejection produces an honest error, not the paste-token form
- **WHEN** a terminal WebSocket closes before opening
- **AND** `GET /api/auth` returns 403 (valid credentials, origin rejected)
- **THEN** the pane shows an origin-rejected notice explaining that the address the browser is using does not pass the terminal's origin gate
- **AND** the paste-token form is not shown
- **AND** the client does not enter a reconnect loop for that pane

#### Scenario: Probe endpoint gates on credentials and origin
- **WHEN** `GET /api/auth` is requested with a valid auth cookie or a valid `t` query token from a page whose origin passes the origin gate
- **THEN** the server responds 204
- **WHEN** it is requested with valid credentials but an effective origin the upgrade gate would reject
- **THEN** the server responds 403
- **WHEN** it is requested with no or invalid credentials
- **THEN** the server responds 401

### Requirement: Pane reattach hints are single-claimant across windows
Per-pane session records SHALL be owned by the window that created them (per-window storage that survives reload of that window). A shared copy of the records SHALL be kept as restart reattach hints. A window that has its own records SHALL use them. A window with no records SHALL attempt to adopt the shared hints; adoption is arbitrated by the server's duplicate-sessionId rejection — the first claimant adopts, and later windows SHALL fall back to fresh sessions WITHOUT overwriting the shared hints. Shared layout preferences (dock, sizes, display mode) remain shared across windows.

#### Scenario: Reload reattaches a window's own sessions
- **WHEN** a window with live terminal panes reloads
- **THEN** it reattaches to the same sessions it held before the reload, regardless of what other windows are doing

#### Scenario: First window after browser restart adopts the hinted sessions
- **WHEN** the browser restarts and a window opens the terminal with no per-window records
- **THEN** it adopts the shared hints and reattaches to the still-running PTYs

#### Scenario: A collision loser does not clobber the hints
- **WHEN** a second window fails to claim a hinted `sessionId` and falls back to a fresh session
- **THEN** the shared hints still reference the first claimant's sessions
- **AND** the first window can still reattach to them after its own reload or a browser restart

### Requirement: Server exposes an authenticated session inventory
The server SHALL expose `GET /api/terminal/sessions`, gated by the same credentials as the terminal upgrade (auth cookie or `t` query token), returning every live PTY session with: `sessionId`, attachment state (attached/detached), creation time, current dimensions, and a human label (at minimum the shell name; the foreground process name where cheaply obtainable on the platform). The server SHALL also expose `DELETE /api/terminal/sessions/<id>` with the same gate, which SHALL terminate the session's PTY and remove it from the registry. Both endpoints SHALL reject unauthenticated requests with 401 and unknown session ids with 404.

#### Scenario: Inventory lists attached and detached sessions
- **WHEN** one window holds an attached session and another session is detached (its window closed)
- **AND** an authenticated client requests `GET /api/terminal/sessions`
- **THEN** the response lists both sessions with their attachment states and labels

#### Scenario: Kill removes a detached session
- **WHEN** an authenticated client sends `DELETE /api/terminal/sessions/<id>` for a detached session
- **THEN** the PTY receives `SIGHUP` and the session disappears from subsequent inventory responses

#### Scenario: Unauthenticated access is refused
- **WHEN** either endpoint is requested without valid credentials
- **THEN** the server responds 401 and reveals nothing about sessions

### Requirement: A client can attach to any session, taking over attached ones
The WebSocket upgrade SHALL accept a `takeover=1` query parameter. For a detached session the upgrade behaves as a normal reattach. For an attached session with `takeover=1`, the server SHALL close the current holder's socket with app close code 4410 ("session taken"), attach the new socket, and replay the buffer to it. Without `takeover=1`, an attached session SHALL continue to be refused with 409. A pane whose socket is closed with 4410 SHALL display an "attached in another window" notice with an explicit take-back action; it SHALL NOT be torn down automatically and SHALL NOT re-claim the session without user action.

#### Scenario: Takeover moves a live session between windows
- **WHEN** window 2 attaches to window 1's attached session with `takeover=1`
- **THEN** window 2's pane shows the session's screen and receives subsequent output
- **AND** window 1's pane shows the "attached in another window" notice instead of a dead pane

#### Scenario: Take-back reverses the takeover
- **WHEN** the user activates the take-back action on a taken-over pane
- **THEN** that pane reattaches with `takeover=1` and the other window's pane shows the notice

#### Scenario: No silent ping-pong
- **WHEN** a pane's session is taken over
- **THEN** the losing pane makes no automatic reconnection attempt for that session

#### Scenario: Takeover of a detached session is a plain reattach
- **WHEN** a client attaches with `takeover=1` to a session with no current holder
- **THEN** the behavior is identical to the existing reattach path

### Requirement: New panes offer existing sessions instead of silently spawning
When the terminal panel is about to create a pane (first open with no restorable records, or an explicit new-pane action) and the session inventory contains sessions not already shown in this window, the pane area SHALL offer a picker listing those sessions with their labels and attachment states, offering: attach (using takeover when the session is attached elsewhere), kill, and "new shell". Selecting "new shell" — or the inventory being empty — SHALL spawn a fresh PTY as today. The picker SHALL be skippable without a session choice becoming sticky state.

#### Scenario: Orphaned session is recoverable from a new window
- **WHEN** a window with a running program (e.g. htop) closes for good, orphaning its detached session
- **AND** a new window opens the terminal panel
- **THEN** the picker lists the orphaned session with its label
- **AND** choosing it attaches the pane to the still-running program

#### Scenario: Empty inventory spawns directly
- **WHEN** the panel opens with no live sessions beyond this window's own
- **THEN** a fresh shell spawns with no picker interposed

#### Scenario: Kill from the picker
- **WHEN** the user activates kill on a listed detached session
- **THEN** the session is terminated via the DELETE endpoint and leaves the list
- **AND** no pane attaches to it

### Requirement: Terminal auth cookie is scoped to the request's Host port
The terminal auth cookie name SHALL be derived from the port of the request's `Host` header (default-port normalized), e.g. `uatu_term_4712` for a request reaching the server at `localhost:4712`. The server SHALL use this derivation consistently at set time (the `Set-Cookie` issued when a token is promoted to a cookie) and at read time (the WebSocket upgrade gate, the auth probe, and the terminal sessions REST endpoints). The legacy fixed-name `uatu_term` cookie SHALL NOT be read; a client holding only the legacy cookie re-authenticates via the paste-token flow once.

#### Scenario: Instances on different host ports keep independent credentials
- **WHEN** two uatu instances are reached at `localhost:4712` and `localhost:4713` and the user authenticates the terminal in both
- **THEN** each instance sets and reads its own port-suffixed cookie
- **AND** authenticating the second instance does not invalidate the first instance's terminal

#### Scenario: Cookie set through a mapped port authenticates through that port
- **WHEN** the server listens on 4711 but is reached at `Host: localhost:4712` and the token is promoted to a cookie
- **THEN** the cookie is named for port 4712
- **AND** a subsequent WebSocket upgrade arriving with `Host: localhost:4712` reads that cookie and authenticates

#### Scenario: Legacy cookie is ignored
- **WHEN** a request carries only a legacy `uatu_term` cookie with a valid token value
- **AND** no `t` query token is supplied
- **THEN** the request is treated as unauthenticated (401)

