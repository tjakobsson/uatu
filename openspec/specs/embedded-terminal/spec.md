## Purpose

Define the embedded terminal capability: a dockable panel in the UatuCode UI that hosts one or more `xterm.js`-rendered terminals connected to real PTY shell processes running in the watched repository's working directory, complete with token-gated transport, per-session WebSockets, persistence, theming, dock/display modes, multi-pane splits, and `.uatu.json`-driven font configuration.

Throughout this spec, "phone-class viewport" means a viewport that is BOTH
coarse-pointer (`pointer: coarse`) AND narrower than the 900-pixel stacked-layout
breakpoint. iPads in landscape and narrow desktop windows are not phone-class.
## Requirements
### Requirement: Fresh terminal clients receive coherent reconstructed state
The terminal server SHALL maintain sufficient emulator state for each live PTY to reconstruct a fresh client coherently after detachment or takeover. Reconstruction MUST preserve the visible terminal contents and the control state needed by ordinary shells and supported alternate-screen TUIs, MUST begin at a control-sequence boundary, and MUST replace arbitrary bounded byte-tail replay as the correctness mechanism. Detaching and reconstructing MUST NOT modify the PTY's termios mode on behalf of the foreground process.

#### Scenario: Raw-mode TUI resumes on a fresh client
- **WHEN** a TUI is running in raw mode and alternate-screen mode and its client disconnects
- **AND** a fresh client attaches later at different dimensions
- **THEN** the running process remains alive and in control of its PTY mode
- **AND** the new terminal displays a coherent TUI screen without normal-buffer scrollback corruption or partial escape-sequence artifacts

#### Scenario: Detached output is represented in reconstruction
- **WHEN** a PTY emits output while no client is attached
- **THEN** its server-side terminal state consumes that output
- **AND** a later reconstruction reflects the resulting current state

#### Scenario: Ordinary shell scrollback reconstructs coherently
- **WHEN** a detached ordinary shell has produced output and a fresh client attaches
- **THEN** available bounded scrollback and the current prompt reconstruct without replacement characters or parser artifacts

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
The panel SHALL remain resizable and retain its existing bottom/right clamps, display modes, and responsive fallback. Dock, dimensions, display mode, visibility, split geometry, and pane arrangement SHALL be client presentation state, namespaced by workspace/base path in browser storage or owned by the native client where applicable. These physical values MUST NOT be stored as personal Hub workspace state or applied to another client. Legacy terminal persistence keys SHALL not be migrated when this model is enabled.

#### Scenario: Drag resizes only the current client
- **WHEN** a user resizes a terminal panel on one client
- **THEN** its xterm grids refit and the client stores the new local dimension
- **AND** another client's terminal geometry is unchanged

#### Scenario: Dock dimensions remain independent locally
- **WHEN** a client stores bottom height and right width values
- **THEN** switching docks restores the corresponding local dimension

#### Scenario: Narrow viewport adapts without overwriting preference
- **WHEN** a locally right-docked terminal enters a narrow viewport
- **THEN** it falls back to bottom presentation
- **AND** the local right-dock preference remains available when the viewport widens

#### Scenario: Legacy terminal keys are ignored
- **WHEN** only legacy terminal persistence and reattach-hint keys exist
- **THEN** the new terminal model starts from current defaults and inventory

### Requirement: Server exposes a token-gated terminal WebSocket
The server SHALL expose a token- and origin-gated WebSocket that attaches to an existing server-created PTY id. The id MUST be syntactically valid and present in the authenticated terminal inventory; the WebSocket upgrade MUST NOT create a PTY as a side effect. An attached PTY SHALL reject a normal attach and SHALL accept only an explicit takeover according to the takeover requirement. Existing mapped-port, base-path, token, cookie, and origin protections SHALL remain in force.

#### Scenario: Valid attach succeeds
- **WHEN** a client upgrades with valid credentials, origin, and an existing detached PTY id
- **THEN** the WebSocket opens without spawning another PTY

#### Scenario: Unknown PTY is rejected
- **WHEN** a client upgrades with a well-formed id absent from inventory
- **THEN** the server responds 404 and creates no PTY

#### Scenario: Missing or malformed id is rejected
- **WHEN** an upgrade omits the PTY id or supplies a malformed value
- **THEN** the server responds 400

#### Scenario: Attached PTY requires takeover
- **WHEN** a PTY already has an interactive holder and another normal attach arrives
- **THEN** the server responds 409 and preserves the current holder

#### Scenario: Authentication and origin remain mandatory
- **WHEN** credentials are missing/invalid or Origin fails the existing gate
- **THEN** the server rejects the upgrade without exposing inventory or creating a PTY

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

### Requirement: Terminal protocol carries input, output, resize, and attach readiness
The terminal WebSocket SHALL carry binary shell input/output and JSON control frames without server UTF-8 transcoding. On every fresh-emulator attach, the client MUST open and fit xterm before sending an attach-ready frame containing positive integer columns and rows. The server MUST ignore input until readiness, MUST establish attachment ownership only after a valid ready frame, MUST apply those dimensions before reconstruction, and MUST send reconstruction before subsequent live output. Later resize frames SHALL continue to resize the active PTY and terminal model.

#### Scenario: New client dimensions precede reconstruction
- **WHEN** a 160×50 client detaches and a fresh 90×28 client begins attachment
- **THEN** the server receives 90×28 readiness before granting ownership or sending reconstruction
- **AND** the PTY and terminal model use 90×28 for the reconstructed client

#### Scenario: Input before readiness is ignored
- **WHEN** a socket sends binary input before a valid attach-ready frame
- **THEN** no bytes reach the PTY

#### Scenario: Keystrokes reach the ready PTY
- **WHEN** readiness completed and the user types into the terminal
- **THEN** binary input reaches that PTY and its output returns to that client

#### Scenario: Later resize remains synchronized
- **WHEN** the active fitted grid changes
- **THEN** the client sends a resize frame
- **AND** both PTY and server terminal model adopt the new dimensions

#### Scenario: Split UTF-8 remains byte-exact
- **WHEN** a multibyte codepoint spans PTY callback chunks
- **THEN** server terminal state and browser xterm receive the original byte sequence without `U+FFFD`

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
Each server-created PTY SHALL remain registered when its WebSocket detaches, with no time limit. It SHALL end only on shell exit, explicit authenticated termination, or child-server shutdown. A subsequent explicit attach SHALL reuse the PTY and reconstruct the client's emulator from maintained terminal state; arbitrary replay-buffer delivery SHALL NOT define restored correctness.

#### Scenario: Browser close leaves shell running
- **WHEN** a WebSocket closes without explicit termination
- **THEN** the PTY remains in inventory as detached

#### Scenario: Explicit attach resumes the same PTY
- **WHEN** a client chooses a detached PTY from inventory and completes readiness
- **THEN** the existing PTY is attached without spawning another
- **AND** coherent reconstructed state is delivered

#### Scenario: Explicit terminate kills the PTY
- **WHEN** an authenticated client terminates a PTY resource
- **THEN** it receives `SIGHUP` and leaves inventory

#### Scenario: Shell exit while detached removes resource
- **WHEN** a detached PTY's shell exits
- **THEN** the resource disappears from inventory

#### Scenario: Server shutdown kills all PTYs
- **WHEN** the child server stops
- **THEN** every attached and detached PTY is terminated

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

### Requirement: Server exposes an authenticated session inventory
The server SHALL expose authenticated operations to create, list, and terminate PTY resources. POST creation SHALL generate the PTY id server-side, spawn the configured shell in the workspace, initialize terminal-emulator state at validated dimensions, and return the resource metadata. GET SHALL list attached and detached resources with id, creation time, dimensions, and label. DELETE SHALL terminate a known resource. Unknown ids SHALL return 404 and unauthenticated requests 401.

#### Scenario: Server creates PTY identity
- **WHEN** an authenticated client requests a new terminal with valid dimensions
- **THEN** the server generates the id, spawns one PTY, and returns its inventory record

#### Scenario: Inventory lists attached and detached resources
- **WHEN** live PTYs exist in both states
- **THEN** GET returns both with attachment state, label, creation time, and dimensions

#### Scenario: Kill removes a resource
- **WHEN** an authenticated client DELETEs a known PTY
- **THEN** the process is terminated and subsequent inventory omits it

#### Scenario: Unauthenticated lifecycle access is refused
- **WHEN** create, list, or terminate is requested without valid credentials
- **THEN** the server responds 401 and reveals nothing

### Requirement: A client can attach to any session, taking over attached ones
A PTY SHALL have at most one interactive client. A detached resource accepts normal attach. An attached resource requires explicit takeover; ownership transfers only after the new client sends valid attach readiness. The previous holder SHALL then receive close code 4410 and show the existing take-back affordance without automatic reconnection. If the prospective new client disconnects before readiness, the current holder SHALL remain attached.

#### Scenario: Takeover moves a ready session
- **WHEN** a second client requests takeover and completes readiness
- **THEN** ownership and active dimensions move to it
- **AND** the previous holder receives 4410 and parks

#### Scenario: Failed half-attach preserves holder
- **WHEN** a takeover socket opens but disconnects before readiness
- **THEN** the original holder remains attached and usable

#### Scenario: Take-back reverses takeover explicitly
- **WHEN** the parked client activates Take back and completes readiness
- **THEN** ownership returns and the other holder parks

#### Scenario: No silent ping-pong
- **WHEN** a client loses ownership
- **THEN** it makes no automatic attachment attempt

#### Scenario: Takeover flag on detached PTY is harmless
- **WHEN** a client requests takeover of a detached PTY
- **THEN** it follows the normal attach-ready path

### Requirement: New panes offer existing sessions instead of silently spawning
When a client has no per-window attachment to restore and terminal inventory contains PTYs not already represented in that window, the panel SHALL list them and require an explicit attach, takeover, terminate, or New shell choice. The user's saved last-active PTY MAY be highlighted but MUST NOT auto-attach or auto-take-over. New shell SHALL create a server resource before attaching. Empty inventory MAY create a new shell directly when the user explicitly opens or splits the terminal panel.

#### Scenario: New client lists an orphan without attaching
- **WHEN** a detached PTY exists and a different browser opens the terminal panel
- **THEN** the PTY appears in the picker
- **AND** it remains detached until selected

#### Scenario: Last-active reference only highlights
- **WHEN** personal state names a live PTY
- **THEN** the picker may emphasize that row
- **AND** no attachment occurs without user action

#### Scenario: New shell uses server creation
- **WHEN** the user chooses New shell
- **THEN** the server creates a PTY id and the pane attaches to that resource

#### Scenario: Picker termination removes resource
- **WHEN** the user terminates a listed PTY
- **THEN** DELETE removes it without attaching a pane

### Requirement: Terminal auth cookie is scoped to the request's Host port
The terminal auth cookie name SHALL be derived from the port of the request's `Host` header (default-port normalized), e.g. `uatu_term_4712` for a request reaching the server at `localhost:4712`. The server SHALL use this derivation consistently at set time (the `Set-Cookie` issued when a token is promoted to a cookie) and at read time (the WebSocket upgrade gate, the auth probe, and the terminal sessions REST endpoints). The legacy fixed-name `uatu_term` cookie SHALL NOT be read; a client holding only the legacy cookie re-authenticates via the paste-token flow once.

The `Set-Cookie` issued at promotion SHALL additionally carry a `Path` attribute equal to the server's configured base path, so that when multiple sessions are proxied under one origin at distinct path prefixes, the browser presents each session's cookie only to that session's subtree and same-named cookies cannot collide across sessions. At the default base path `/` the attribute is `Path=/` and behavior is unchanged.

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

#### Scenario: Sessions sharing an origin keep independent credentials
- **WHEN** two sessions are served under one origin at base paths `/s/alpha/` and `/s/beta/` and the terminal is authenticated in both
- **THEN** each session's cookie is set with its own base path as the `Path` attribute
- **AND** requests to one session's subtree never carry the other session's cookie


### Requirement: Terminal bridges OSC 52 copy sequences to the host clipboard
Each terminal pane SHALL register an OSC 52 handler on its `xterm.js` parser (`term.parser.registerOscHandler(52, …)`) that decodes application-initiated copy sequences (`ESC ] 52 ; <selection> ; <base64-data> BEL/ST`) arriving from the PTY and writes the decoded text to the system clipboard via `navigator.clipboard.writeText`, subject to the configured clipboard policy. The bridge SHALL be write-only: when the data field is `?` (a clipboard read query), the handler SHALL NOT emit any response sequence and SHALL NOT read the clipboard. The handler SHALL honor the selection parameters `c`, `p`, and `s` (all targeting the single browser clipboard) and SHALL ignore sequences with other selection parameters, invalid base64 data, or a decoded payload larger than 100 KB. `allowProposedApi` SHALL be `true`, enabled solely because search decorations (`registerDecoration`), which terminal find uses to mark every match, are proposed API in xterm 6 and throw without it. The OSC 52 bridge itself SHALL NOT depend on any proposed API.

#### Scenario: TUI select-to-copy reaches the host clipboard
- **WHEN** a program in the terminal (e.g. a mouse-mode TUI reacting to a selection) emits `ESC ] 52 ; c ; <base64 of "hello"> BEL` and the clipboard policy is `notify` or `silent`
- **THEN** `navigator.clipboard.writeText("hello")` is invoked
- **AND** the host clipboard — not any container-local clipboard — receives the text, because the browser executing the write runs on the host

#### Scenario: Clipboard read query is never answered
- **WHEN** a program in the terminal emits `ESC ] 52 ; c ; ? BEL`
- **THEN** no response sequence is written to the PTY
- **AND** `navigator.clipboard.readText` is not invoked

#### Scenario: Oversized payload is dropped and reported
- **WHEN** a program emits an OSC 52 sequence whose decoded payload exceeds 100 KB and the clipboard policy is `notify` or `confirm`
- **THEN** the clipboard is not modified
- **AND** the pane shows feedback that the copy was rejected for size

#### Scenario: Invalid base64 is dropped silently
- **WHEN** a program emits an OSC 52 sequence whose data field is not valid base64 and is not `?`
- **THEN** the clipboard is not modified
- **AND** no toast is shown

#### Scenario: Blocked silent write degrades to a Copy button
- **WHEN** the clipboard policy is `notify` or `silent` and `navigator.clipboard.writeText` rejects (e.g. the browser requires user activation)
- **THEN** the pane shows a persistent toast with a Copy control
- **AND** activating the Copy control writes the pending text to the clipboard from within the click gesture

### Requirement: OSC 52 copies are visible and policy-governed via `.uatu.json`
The `terminal` block of `.uatu.json` SHALL accept an optional `clipboard` key with the values `notify` (default), `confirm`, `silent`, and `off`, validated with the same warn-and-fallback approach as the existing terminal font keys. Under `notify`, an accepted OSC 52 write SHALL show a transient pane-scoped toast reporting that the terminal copied N characters. Under `confirm`, the write SHALL NOT happen automatically; the toast SHALL offer a Copy control and the write SHALL occur only from its activation. Under `silent`, accepted writes SHALL show no toast. Under `off`, the OSC 52 handler SHALL NOT be registered. Rapid successive sequences SHALL coalesce so at most one toast is visible per pane.

#### Scenario: Default policy notifies on copy
- **WHEN** no `terminal.clipboard` key is configured and a valid OSC 52 copy is accepted
- **THEN** the text is written to the clipboard
- **AND** a transient toast in the receiving pane reports the number of characters copied

#### Scenario: Confirm policy requires a user gesture
- **WHEN** `terminal.clipboard` is `confirm` and a valid OSC 52 copy arrives
- **THEN** the clipboard is not modified until the user activates the toast's Copy control
- **AND** activating the control writes the pending text to the clipboard

#### Scenario: Off policy leaves sequences unhandled
- **WHEN** `terminal.clipboard` is `off` and a program emits an OSC 52 sequence
- **THEN** no handler processes the sequence beyond xterm.js's default ignore
- **AND** the clipboard is not modified and no toast is shown

#### Scenario: Invalid policy value warns and falls back
- **WHEN** `.uatu.json` sets `terminal.clipboard` to an unrecognized value
- **THEN** a startup warning is surfaced alongside the existing terminal config warnings
- **AND** the pane behaves as if the policy were `notify`

#### Scenario: Rapid copies coalesce into one toast
- **WHEN** multiple valid OSC 52 sequences arrive in quick succession under the `notify` policy
- **THEN** at most one toast is visible in the pane, reflecting the most recent copy

### Requirement: Focusing a terminal pane makes the terminal the active surface

Clicking or otherwise focusing a terminal pane SHALL set the app's active
surface to `terminal`, and the surface SHALL remain `terminal` until the user
interacts with another surface. Terminal output arriving while the user is
elsewhere SHALL NOT change the active surface.

#### Scenario: Clicking into the terminal

- **WHEN** the user clicks a terminal pane
- **THEN** the active surface becomes `terminal`

#### Scenario: Background output does not claim the surface

- **WHEN** a detached command writes output while the user is reading the preview
- **THEN** the active surface remains `preview`

### Requirement: Terminal panes are searchable

Each terminal pane SHALL support searching its scrollback buffer, scoped to the
focused pane. Search SHALL reveal matches that are scrolled out of view, mark
the current match, and support forward and backward navigation. Searching SHALL
NOT write to the PTY or disturb the running program.

#### Scenario: Search does not reach the shell

- **WHEN** the user searches the terminal while a program is running
- **THEN** no input is sent to the PTY and the program is unaffected

#### Scenario: Search is scoped to the focused pane

- **WHEN** the panel is split and the user searches from one pane
- **THEN** matches in the other pane are neither counted nor highlighted

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

### Requirement: Bare Ctrl+letter chords are synthesized from the key value
The client SHALL derive bare Ctrl+letter control bytes (^A = 0x01 … ^Z = 0x1a) from the keydown's key value and send them down the PTY itself, consuming the event, instead of relying on xterm's key-code-driven evaluation — which drops the hardware-keyboard Ctrl chords iPadOS Safari delivers with unusable key codes. The synthesized bytes MUST equal what xterm's own evaluation produces on desktop platforms, so behavior there is unchanged. Clipboard shortcut handling (Ctrl+C-with-selection copy on non-Mac platforms) SHALL take precedence, and composition events, non-letter keys, and chords with additional modifiers SHALL take xterm's normal path.

#### Scenario: Ctrl-C from an iPad hardware keyboard
- **WHEN** a keydown arrives with ctrlKey set and key "c", in whatever key-code shape the platform delivers
- **THEN** the byte 0x03 is sent to the PTY exactly once

#### Scenario: Desktop copy shortcut still wins
- **WHEN** a non-Mac user presses Ctrl+C while the terminal has a selection
- **THEN** the selection is copied and no interrupt byte is sent

### Requirement: Opening the terminal by user action focuses it
A user-initiated show of the terminal panel (the sidebar Terminal control or the toggle shortcut) SHALL move keyboard focus into the active pane's terminal once it is attached, so typing works immediately. Restoring the panel's visibility at page load MUST NOT steal focus.

#### Scenario: Sidebar button lands the cursor in the shell
- **WHEN** the user activates the sidebar Terminal control and the panel opens
- **THEN** the active pane's terminal has keyboard focus

#### Scenario: Boot restore does not steal focus
- **WHEN** a page load restores a previously visible terminal panel
- **THEN** focus stays wherever the page put it, not in the terminal

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
