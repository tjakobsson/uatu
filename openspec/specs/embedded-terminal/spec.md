## Purpose

Define the embedded terminal capability: a bottom panel in the UatuCode UI that hosts an `xterm.js`-rendered terminal connected to a real PTY shell process running in the watched repository's working directory, complete with token-gated transport, persistence, theming, and `.uatu.json`-driven font configuration.

## Requirements

### Requirement: Bottom panel hosts an interactive terminal
The UI SHALL provide a bottom panel that, when visible, hosts an `xterm.js`-rendered terminal connected to a real PTY shell process running in the watched repository's working directory. The panel SHALL be hidden by default on first load.

#### Scenario: Panel is hidden on first load
- **WHEN** a user loads the UI for the first time with no persisted panel state
- **THEN** the bottom panel is not rendered
- **AND** the preview area uses the full available height below the preview header

#### Scenario: Toggle reveals the panel
- **WHEN** the user presses `Ctrl+`` or activates the panel toggle control while the panel is hidden
- **THEN** the bottom panel becomes visible at its persisted height (or a default of 240 pixels)
- **AND** the panel's terminal element receives keyboard focus
- **AND** within 500 milliseconds the terminal is connected to a PTY and shows a shell prompt

#### Scenario: Toggle hides the panel
- **WHEN** the user presses `Ctrl+`` or activates the panel toggle control while the panel is visible
- **THEN** the bottom panel is removed from layout
- **AND** the terminal's WebSocket is closed
- **AND** the underlying PTY process is terminated within the disconnect grace window

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
The bottom panel SHALL be vertically resizable via a drag handle on its top edge, with a minimum height of 120 pixels and a maximum of 70% of the viewport height. The resolved height and the panel's hidden/visible state SHALL persist across reloads via `localStorage`.

#### Scenario: Drag resizes the panel
- **WHEN** the user drags the panel's top resizer up by 100 pixels
- **THEN** the panel height increases by 100 pixels
- **AND** the xterm fit addon recomputes the character grid so the visible terminal resizes without truncation

#### Scenario: Height persists across reload
- **WHEN** the user resizes the panel to 380 pixels and reloads the page
- **THEN** on reattach the panel renders at 380 pixels

#### Scenario: Hidden state persists across reload
- **WHEN** the user hides the panel and reloads the page
- **THEN** on the next load the panel is hidden and no PTY is spawned

### Requirement: Server exposes a token-gated terminal WebSocket
The server SHALL expose a single WebSocket upgrade endpoint that proxies bytes between the browser and a real PTY shell process. The upgrade SHALL be rejected unless the request carries a valid per-server-session token AND its `Origin` header matches the server's bound origin or the registered PWA origin.

#### Scenario: Valid token and origin succeed
- **WHEN** the browser sends a WebSocket upgrade to `/api/terminal?t=<valid-token>` with `Origin: http://127.0.0.1:<port>`
- **THEN** the server upgrades the connection and spawns a PTY

#### Scenario: Missing token is rejected
- **WHEN** the browser sends a WebSocket upgrade to `/api/terminal` with no `t` query parameter
- **THEN** the server responds with HTTP 401 and does not spawn a PTY

#### Scenario: Wrong token is rejected
- **WHEN** the browser sends a WebSocket upgrade to `/api/terminal?t=garbage`
- **THEN** the server responds with HTTP 401 and does not spawn a PTY

#### Scenario: Foreign origin is rejected
- **WHEN** a client sends a WebSocket upgrade to `/api/terminal?t=<valid-token>` with `Origin: http://attacker.example`
- **THEN** the server responds with HTTP 403 and does not spawn a PTY

#### Scenario: Token is unique per server start
- **WHEN** the server is restarted
- **THEN** the previous token no longer authenticates terminal upgrades

### Requirement: Terminal lifecycle is bounded by the connection
The PTY SHALL be spawned on a successful WebSocket upgrade and terminated when the WebSocket closes. The server MAY hold the PTY for a reconnect grace window of up to 5 seconds before sending `SIGHUP`/`SIGTERM`, to absorb page reloads.

#### Scenario: Disconnect kills the PTY
- **WHEN** the browser closes the terminal WebSocket
- **AND** no reconnect occurs within 5 seconds
- **THEN** the PTY process receives `SIGHUP` and is reaped

#### Scenario: Server shutdown kills the PTY
- **WHEN** the uatu server is stopped (Ctrl+C or idle timeout)
- **THEN** any live PTY is terminated as part of shutdown

### Requirement: Terminal protocol carries input, output, and resize
The browser-server protocol on the terminal WebSocket SHALL carry shell input as binary frames written to the PTY's stdin, shell output as binary frames written from the PTY's stdout/stderr, and terminal resize events as small JSON frames of the shape `{"type":"resize","cols":<n>,"rows":<n>}`.

#### Scenario: Keystrokes reach the shell
- **WHEN** the user types `echo hi` and presses Enter in the terminal
- **THEN** within 200 milliseconds the terminal renders a line containing `hi` from the shell's stdout

#### Scenario: Resize syncs the PTY
- **WHEN** the panel is resized so xterm-addon-fit reports `cols=120, rows=30`
- **THEN** the client sends a resize frame
- **AND** the server calls the PTY's `resize(120, 30)`
- **AND** running TUI applications redraw at the new dimensions
