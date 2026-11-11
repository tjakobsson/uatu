## Purpose

Define the embedded terminal capability: a dockable panel in the UatuCode UI that hosts one or more `xterm.js`-rendered terminals connected to real PTY shell processes running in the watched repository's working directory, complete with token-gated transport, per-session WebSockets, persistence, theming, dock/display modes, multi-pane splits, and `.uatu.json`-driven font configuration.

Throughout this spec, "phone-class viewport" means a viewport that is BOTH
coarse-pointer (`pointer: coarse`) AND narrower than the 900-pixel stacked-layout
breakpoint. iPads in landscape and narrow desktop windows are not phone-class.
## Requirements
### Requirement: Fresh terminal clients receive coherent reconstructed state

The server SHALL maintain emulator state for each live PTY sufficient for coherent fresh-client reconstruction after detachment or takeover. Reconstruction MUST preserve visible contents and control state for ordinary shells and supported alternate-screen TUIs, begin at a control-sequence boundary, and replace arbitrary bounded byte-tail replay as the correctness mechanism. Detaching and reconstructing MUST NOT modify PTY termios on the foreground process's behalf.

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

PTY shells SHALL start in the first CLI-resolved watch root, preferring a valid explicit terminal-server shell override, then non-empty `SHELL`, falling back to `/bin/sh` only when those are unset or empty. The terminal SHALL NOT reconstruct login shells from the user database or synthesize or modify inherited `SHELL`. Missing `SHELL` SHALL produce a once-at-startup stdout warning when the backend is available; every fallback session SHALL receive a notice before its first prompt.

#### Scenario: An explicit override wins without rewriting the inherited environment
- **WHEN** a valid explicit terminal-server shell override is set
- **THEN** the PTY runs that shell ahead of a non-empty inherited `SHELL`
- **AND** `SHELL` remains exactly as uatu received it, even when it names another shell

#### Scenario: Every fallback session explains the shell before its first prompt
- **WHEN** a newly opened terminal falls back to `/bin/sh`
- **THEN** a notice names `$SHELL` and `/bin/sh` before the shell's first prompt

#### Scenario: Missing SHELL explains the fallback at startup
- **WHEN** uatu starts with `SHELL` unset or empty and the terminal backend is available
- **THEN** stdout receives one warning explaining that terminals will use `/bin/sh` instead of the user's login shell

#### Scenario: PTY inherits watch root as cwd
- **WHEN** a session child is started with `./some/dir` and the user opens the terminal panel
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

The panel SHALL remain resizable with existing bottom/right clamps, display modes, and responsive fallback. Dock, dimensions, display mode, visibility, split geometry, and pane arrangement SHALL be client state, namespaced by workspace/base path in browser storage or owned by the native client where applicable. These values MUST NOT become personal Hub workspace state or apply to another client. Legacy terminal persistence keys SHALL not be migrated when this model is enabled.

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

Closing (×) a pane with at least one attached PTY SHALL show a shell-session-loss confirmation modal, focus Cancel by default, and dismiss on `Esc`. Teardown SHALL require explicit confirmation and send the explicit terminate signal to the server before closing the WebSocket. Confirmation SHALL NOT appear for keyboard panel toggle, minimize, fullscreen toggle, or closing an already-exited shell.

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

The panel header SHALL provide minimize, fullscreen, and Close controls. Minimize SHALL collapse to a header bar while keeping every PTY attached. Desktop fullscreen SHALL fill main content, retaining sidebar and topbar; touch fullscreen SHALL fill the visual viewport with the bottom tab bar as navigation chrome. Both changes SHALL be reversible without PTY-state loss, and active display mode SHALL persist across reloads.

#### Scenario: Touch fullscreen follows collapsing browser chrome
- **WHEN** touch fullscreen is active, including while the browser URL bar collapses or expands
- **THEN** dynamic-viewport units keep the panel pinned to the entire visual viewport without a gap
- **AND** no sidebar or preview is visible, the page behind cannot scroll, and the bottom tab bar remains navigation chrome

#### Scenario: Minimize collapses without losing the session
- **WHEN** a pane is running an active process (e.g., `tail -f` is producing output)
- **AND** the user clicks minimize
- **THEN** the panel body is hidden and only the header bar remains visible
- **AND** every PTY remains attached
- **AND** restoring the panel resumes display of accumulated output

#### Scenario: Fullscreen expands within the app grid
- **WHEN** the user clicks fullscreen in desktop mode
- **THEN** the panel expands to cover the main content area
- **AND** the sidebar and the topbar remain visible
- **AND** xterm fit recalculates so panes use the new dimensions

#### Scenario: Fullscreen covers the whole screen in touch mode
- **WHEN** the panel enters fullscreen in touch mode
- **THEN** the panel covers the visual viewport above the tab bar with no sidebar or preview visible
- **AND** the page behind the panel cannot scroll
- **AND** xterm fit recalculates so panes use the new dimensions

#### Scenario: Esc exits fullscreen
- **WHEN** the panel is in fullscreen mode
- **AND** the user presses `Esc` (and no confirmation modal is open)
- **THEN** in desktop mode the panel returns to its previous display mode, and in touch mode the Preview tab becomes active
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

The panel SHALL provide a split control creating concurrent panes within it, each with its own PTY, `sessionId`, focus, Close (×), and resizer between siblings. Panes SHALL be side-by-side when bottom-docked and stacked when right-docked. Pane count is bounded by the soft cap (8) and per-pane minimum drag size, preventing unusable widths; splitting SHALL be disabled at the cap. Closing the last pane SHALL hide the panel.

#### Scenario: Split dragging cannot collapse a pane below usable size
- **WHEN** the user drags a resizer between sibling panes
- **THEN** the per-pane minimum drag size bounds the layout so no pane collapses below usable width
- **AND** each pane retains independent focus, a close control, and a resizer between it and its sibling

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

The WebSocket SHALL carry binary shell I/O and JSON control frames without server UTF-8 transcoding. Every fresh-emulator attach MUST open and fit xterm before sending positive integer columns and rows in attach-ready. The server MUST ignore input until readiness, establish ownership only after valid readiness, apply dimensions before reconstruction, and send reconstruction before live output. Later resize frames SHALL resize the active PTY and terminal model.

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

At every pane size, in both docks, single panes and splits, the grid SHALL fit wholly within the host content box. `rows × cellHeight` SHALL NOT exceed vertical space inside padding; `cols × cellWidth` plus scrollbar allowance SHALL NOT exceed horizontal space. Fit measurements SHALL account for all terminal padding so no row or column is clipped, including at arbitrary pixel dimensions from panel or inter-pane dragging.

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

With no per-window attachment to restore, the panel SHALL auto-attach all detached inventory PTYs not already shown, oldest first up to the pane cap, without a chooser. PTYs held elsewhere SHALL NOT auto-attach; takeover SHALL require explicit action. New shell SHALL create a server resource before attaching. The active pane SHALL be the saved last-active PTY if auto-attached, otherwise the newest auto-attached pane; the saved reference SHALL NOT change attachments or cause takeover.

#### Scenario: Non-detached inventory requires a decision or a fresh shell
- **WHEN** a client without a per-window attachment to restore finds no detached PTY
- **THEN** if any PTYs are attached elsewhere, the panel lists them and requires an explicit takeover, terminate, or New shell choice
- **AND** when inventory holds nothing to attach, the panel creates a fresh shell directly

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
- **AND** the remaining PTYs stay detached, listed by the touch switcher with their attach action disabled, and attach on any surface as soon as a pane slot frees

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

### Requirement: Terminal auth cookie is scoped to the request's Host port

Terminal auth cookies SHALL use the request `Host` port, default-port normalized, consistently at token promotion, WebSocket upgrade, auth probe, and sessions REST reads. Promotion `Set-Cookie` SHALL set `Path` to the configured base path, keeping cookies within each session subtree; the default `/` remains `Path=/`. The legacy `uatu_term` cookie SHALL NOT be read; clients holding only it reauthenticate once through paste-token.

#### Scenario: Port-derived names normalize the default port consistently
- **WHEN** a token is promoted or a WebSocket upgrade, auth probe, or terminal sessions REST request reads authentication
- **THEN** the same default-port-normalized request Host port determines the cookie name, such as `uatu_term_4712` for `localhost:4712`
- **AND** the server's internal listening port does not replace the request's Host port

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

Each `xterm.js` pane SHALL register `term.parser.registerOscHandler(52, …)` to decode PTY OSC 52 copies and write text via `navigator.clipboard.writeText`. The bridge SHALL NOT read the clipboard or answer `?` queries. It SHALL accept `c`, `p`, and `s` for the single browser clipboard, ignoring other selections, invalid base64, and decoded payloads over 100 KB. `allowProposedApi` SHALL be `true` solely for terminal-find decorations; the OSC 52 bridge SHALL NOT depend on proposed APIs.

#### Scenario: Supported OSC 52 selection parameters share the browser clipboard
- **WHEN** the PTY sends `ESC ] 52 ; <selection> ; <base64-data> BEL/ST`
- **THEN** selections `c`, `p`, and `s` decode to the same browser clipboard when valid and at most 100 KB
- **AND** other selections are ignored, as are invalid base64 and decoded payloads larger than 100 KB

#### Scenario: Proposed API enablement belongs to terminal find, not clipboard bridging
- **WHEN** each xterm 6 pane is configured
- **THEN** `allowProposedApi` is `true` for terminal find's `registerDecoration` match markers
- **AND** OSC 52 registration and handling use no proposed API

#### Scenario: TUI select-to-copy reaches the host clipboard
- **WHEN** a program in the terminal (e.g. a mouse-mode TUI reacting to a selection) emits `ESC ] 52 ; c ; <base64 of "hello"> BEL`
- **THEN** `navigator.clipboard.writeText("hello")` is invoked
- **AND** the host clipboard — not any container-local clipboard — receives the text, because the browser executing the write runs on the host

#### Scenario: Clipboard read query is never answered
- **WHEN** a program in the terminal emits `ESC ] 52 ; c ; ? BEL`
- **THEN** no response sequence is written to the PTY
- **AND** `navigator.clipboard.readText` is not invoked

#### Scenario: Oversized payload is dropped and reported
- **WHEN** a program emits an OSC 52 sequence whose decoded payload exceeds 100 KB
- **THEN** the clipboard is not modified
- **AND** the pane shows feedback that the copy was rejected for size

#### Scenario: Invalid base64 is dropped silently
- **WHEN** a program emits an OSC 52 sequence whose data field is not valid base64 and is not `?`
- **THEN** the clipboard is not modified
- **AND** no toast is shown

#### Scenario: Blocked silent write degrades to a Copy button
- **WHEN** `navigator.clipboard.writeText` rejects (e.g. the browser requires user activation)
- **THEN** the pane shows a persistent toast with a Copy control
- **AND** activating the Copy control writes the pending text to the clipboard from within the click gesture

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

Coarse-pointer terminals SHALL show a keybar with at least Escape, Tab, Control-C/D/Z, arrows, Page Up/Down, Home, End, Paste, sticky Ctrl, and terminal switching. Keys SHALL use the focused PTY's typed-input path. Keybar actions MUST preserve terminal focus except the switcher, which takes focus while open and returns it on dismissal. The row SHALL NOT appear on fine-pointer devices, SHALL sit above a home-indicator inset, and SHALL disable switching with other non-selection keys during Select.

#### Scenario: Sticky Ctrl exposes and consumes its single-shot latch
- **WHEN** Ctrl is tapped on the keybar
- **THEN** its armed state is visually indicated and MUST be exposed through `aria-pressed`
- **AND** the next printable character is composed to its control character before PTY delivery and releases the latch; tapping Ctrl again while armed cancels it

#### Scenario: Terminal switching has an accessible name and state
- **WHEN** the coarse-pointer keybar is shown
- **THEN** its switch action MUST name the terminal switcher accessibly and expose sheet state with `aria-expanded`
- **AND** activation toggles that sheet rather than opening another

#### Scenario: Every Paste activation retains gesture, cardinality, and paste semantics
- **WHEN** the coarse-pointer keybar provides Paste or a user activates it
- **THEN** Paste MUST remain keyboard-operable and request the clipboard from release-time or equivalent semantic button activation carrying transient user activation
- **AND** each activation MUST read the clipboard at most once and paste at most once, sending non-empty text through xterm's paste path with newline normalization and bracketed-paste handling
- **AND** unavailable Clipboard API, synchronous failure, rejected read, or empty text MUST be inert without PTY input or an uncaught error

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

### Requirement: Terminal output supports touch selection and Copy

Coarse-pointer keybars SHALL offer Select to snapshot the active pane's bounded xterm scrollback and visible rows into a document transcript outside panel overflow and gestures. The transcript SHALL support native long-press selection and Copy independently of OSC 52 policy. The app shell SHALL stay mounted, visually parked and inert; PTY output MAY continue but MUST NOT mutate the snapshot. Done SHALL remove it, restore prior document position and terminal focus, and reveal accumulated output.

#### Scenario: Selection uses ordinary document presentation and persistent Done
- **WHEN** the user enters Select on a coarse-pointer client
- **THEN** ordinary non-editable line DOM uses terminal colors and typography with document scrolling equivalent to Preview selection, initially at the live end near the prompt
- **AND** a fixed bottom action bar replaces the touch tab bar with an always-reachable Done action

#### Scenario: Select preserves existing terminal interaction paths
- **WHEN** the terminal handles normal-mode TUI mouse reporting, keyboard clipboard shortcuts, touch Paste, or touch scrolling
- **THEN** the Select capability leaves each existing behavior unchanged

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

#### Scenario: Transcript Copy is independent of the OSC 52 bridge
- **WHEN** the user copies selected transcript text through the native platform action
- **THEN** the selected text is copied
- **AND** Uatu emits no OSC 52 toast or PTY input

#### Scenario: Normal terminal and TUI behavior is unchanged
- **WHEN** Select is not active
- **THEN** ordinary terminal touch scrolling, keybar Paste, keyboard input, and xterm desktop selection retain their existing behavior
- **AND** mouse-aware TUIs retain their existing event and OSC 52 paths

### Requirement: Bare Ctrl+letter chords are synthesized from the key value

The client SHALL synthesize bare Ctrl+letter bytes (^A = 0x01 … ^Z = 0x1a) from keydown's key value, send them to the PTY itself, and consume the event rather than rely on xterm's key-code evaluation. Bytes MUST match desktop xterm. Clipboard handling, including non-Mac Ctrl+C-with-selection copy, SHALL take precedence; composition events, non-letter keys, and extra-modifier chords SHALL take xterm's normal path.

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
In touch mode the panel SHALL render fullscreen whenever the Terminal tab is active — regardless of the stored display mode, and without overwriting the stored display-mode preference, mirroring the right-dock narrow-viewport fallback. Leaving the fullscreen terminal (the fullscreen toggle or `Esc`) SHALL switch to the Preview tab; switching tabs SHALL keep every PTY attached. Neither the `normal` docked strip nor the minimized header strip SHALL ever render in touch mode.

#### Scenario: Opening the Terminal tab lands in fullscreen
- **WHEN** a user in touch mode activates the Terminal tab while the stored display mode is `normal`
- **THEN** the panel renders fullscreen
- **AND** the stored display-mode preference is unchanged

#### Scenario: Desktop mode restores the stored display mode
- **WHEN** the terminal was fullscreen via the Terminal tab in touch mode
- **AND** the device switches to desktop mode (or the session is opened on a desktop)
- **THEN** the panel renders in the stored display mode and dock

#### Scenario: Leaving fullscreen switches to Preview
- **WHEN** the panel is fullscreen in touch mode and the user activates the fullscreen toggle or presses `Esc`
- **THEN** the Preview tab becomes active
- **AND** every PTY remains attached

### Requirement: Phone fullscreen tracks the visible viewport
While fullscreen in touch mode, the panel SHALL size itself to the visual viewport (`window.visualViewport`) rather than the layout viewport, and SHALL refit xterm when the visual viewport changes, so the software keyboard never obscures the prompt line: when the keyboard shows, the panel shrinks to the space above it; when the keyboard hides, the panel reclaims the full height. The visual-viewport subscription SHALL be active only while the panel is touch-mode fullscreen.

#### Scenario: Software keyboard does not cover the prompt
- **WHEN** the panel is fullscreen in touch mode and focusing the terminal raises the software keyboard, shrinking the visual viewport
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

Coarse-pointer panel headers SHALL offer decrease/increase font-size controls that immediately update and refit every xterm pane without PTY reconnection. Adjustments SHALL persist per device and override `.uatu.json` terminal font size, which remains the default without an override. The range SHALL match configuration-loader bounds; stepping back to the configured value SHALL clear the override. Controls SHALL NOT appear on fine-pointer devices.

#### Scenario: Font adjustments clamp and return to the configured default
- **WHEN** a coarse-pointer user steps font size beyond configuration-loader bounds or back to the configured value
- **THEN** the accepted range stays clamped to those same bounds
- **AND** reaching the configured value clears the per-device override, so configuration is again the default

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

Normal-buffer wheel and touch SHALL retain scrollback scrolling. Only in the alternate screen, coarse-pointer vertical swipes and untracked wheel input on any pointer SHALL send repeated up/down keys, cell-height quantized and honoring application cursor-key mode. Mouse-tracked alternate-screen wheel input SHALL use protocol mouse reports and MUST NOT also emit arrows. Horizontal swipe components SHALL be ignored; translation MUST NOT interfere with normal scrolling or touch text selection.

#### Scenario: Alternate-screen translation honors direction, quantization, and cursor mode
- **WHEN** a coarse-pointer vertical swipe or an untracked wheel delta on any pointer occurs in the alternate screen
- **THEN** its vertical distance produces repeated arrow-up or arrow-down sequences quantized by cell height in the current application cursor-key mode, rather than moving underlying scrollback
- **AND** horizontal swipe components produce no input, and touch text selection is not disturbed

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
In touch mode the panel header SHALL hide the split and dock-toggle controls and the panel resizer, keeping the title, fullscreen, and close controls (the minimize control MAY also hide — tab switching supersedes it). Hiding SHALL be presentation-only: stored dock, size, and split state remain intact and reappear in desktop mode.

#### Scenario: Touch header is slim
- **WHEN** the terminal panel renders in touch mode
- **THEN** the split and dock-toggle buttons and the resizer are not visible
- **AND** fullscreen and close remain available

#### Scenario: Geometry state survives touch mode
- **WHEN** a session whose panel is right-docked and split is viewed in touch mode and later in desktop mode
- **THEN** the desktop view renders the panel right-docked with its split panes intact

### Requirement: Touch mode renders one terminal pane at a time

Touch mode SHALL show exactly the active pane, filling the terminal surface, hiding other panes without detaching them. Hidden panes SHALL retain attachment, incoming scrollback, persisted pane records, and split geometry, restored unchanged on desktop. Active-pane keybar sequences, sticky Ctrl, Paste, selection transcript, and terminal find SHALL target the visible pane. The Terminal tab's output badge SHALL reflect any attached pane's output, not just the visible pane's.

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

Coarse-pointer terminals SHALL provide a keybar-opened switcher sheet listing this window's attached terminals and every server session not shown, offering New terminal and per-session termination. Rows SHALL switch or attach by session state, never take over without explicit Take over. Pane-cap exhaustion SHALL disable New terminal and attach with a reason, not switching. Dismissal SHALL require no choice and restore visible-pane focus; the desktop chooser SHALL NOT render in touch mode.

#### Scenario: Every switcher row identifies its resource and attachment state
- **WHEN** the coarse-pointer switcher lists sessions
- **THEN** each row carries the session label, coarse age, and visible, attached-in-this-window, detached, or attached-elsewhere state
- **AND** selecting a visible or attached row makes that pane visible; selecting a detached row attaches a new pane and makes it visible

#### Scenario: Termination applies to every listed resource
- **WHEN** a user terminates any listed session, including one not shown in this window
- **THEN** its server resource is removed
- **AND** terminating the visible pane selects another attached pane, or closes the panel if none remains

#### Scenario: New terminal creates before it attaches
- **WHEN** the user activates New terminal
- **THEN** the server creates a terminal resource before attaching a pane to it

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

### Requirement: Terminal renders the bundled default font

The terminal font SHALL be `var(--terminal-font-family)`, falling through `var(--mono-font-family)` to bundled Hack Nerd Font Mono for out-of-box ASCII and Nerd Font glyphs in every browser. Repository configuration SHALL NOT override terminal font or size: `.uatu.json` has no `terminal` block and `/api/state` has no `terminalConfig` field.

#### Scenario: Terminal renders the bundled default

- **WHEN** the user opens the terminal panel
- **THEN** the rendered xterm instance uses the bundled Hack Nerd Font Mono face (via `--terminal-font-family` → `--mono-font-family`)

#### Scenario: Bundled default renders in Safari with no local Nerd Font installed

- **WHEN** the user opens the terminal panel in Safari
- **AND** the user's machine has no Nerd Font installed
- **THEN** the terminal renders ASCII glyphs using the bundled Hack Nerd Font Mono face
- **AND** the terminal renders the Private-Use-Area codepoint `U+E0B0` (powerline right-arrow) using a real glyph (not TOFU)

#### Scenario: Bundled default renders in a clean Chromium profile

- **WHEN** the user opens the terminal panel in a freshly-installed Chromium with no extra fonts
- **THEN** the terminal renders ASCII and Nerd Font icon glyphs using the bundled face

#### Scenario: A legacy terminal block is not read

- **WHEN** the watch root's `.uatu.json` contains a `terminal` block with `fontFamily` or `fontSize`
- **THEN** `/api/state` contains no `terminalConfig` field
- **AND** the terminal renders with the bundled default face and size

### Requirement: OSC 52 copies are always visible
Accepted OSC 52 writes SHALL always be visible: each write SHALL show a transient pane-scoped toast reporting that the terminal copied N characters. Rapid successive sequences SHALL coalesce so at most one toast is visible per pane. This notify behavior is fixed — no repository configuration selects a different clipboard policy. (A per-user policy choice may return later through hub user settings; it is not configurable from `.uatu.json`.)

#### Scenario: Copy notifies with a toast
- **WHEN** a valid OSC 52 copy is accepted
- **THEN** the text is written to the clipboard
- **AND** a transient toast in the receiving pane reports the number of characters copied

#### Scenario: Rapid copies coalesce into one toast
- **WHEN** multiple valid OSC 52 sequences arrive in quick succession
- **THEN** at most one toast is visible in the pane, reflecting the most recent copy

#### Scenario: A legacy clipboard policy key is not read
- **WHEN** the watch root's `.uatu.json` sets `terminal.clipboard` to any value
- **THEN** the pane behaves with the fixed notify behavior
- **AND** no configuration warning is emitted for the unread block

### Requirement: Same-tab navigation preserves workspace terminal state

Same-tab reload, workspace round trips, and history restoration SHALL preserve each workspace's visibility and pane references independently, in browser tabs and installed PWAs. Leaving SHALL release connections without terminating shells or recording user-hidden state. Returning to previously visible, live, unclaimed PTYs SHALL restore the panel and same shells automatically, without takeover or replacement. Hidden terminals SHALL stay hidden. Restoration SHALL NOT steal keyboard focus.

#### Scenario: Reload restores a running terminal
- **WHEN** a user reloads a workspace with a visible terminal and a live shell that no other client claims
- **THEN** the terminal becomes visible and interactive with the same shell state
- **AND** the user does not need to open Terminal or activate Take over

#### Scenario: Workspace round trip restores multiple panes
- **WHEN** the user leaves workspace A with multiple visible terminal panes, opens workspace B, and returns to A in the same tab
- **AND** A's shells remain alive and unclaimed
- **THEN** A restores its pane arrangement and reconnects those shells without creating additional PTYs
- **AND** A's stored dock, dimensions, and display mode remain in effect

#### Scenario: Visibility belongs to each workspace
- **WHEN** A has a visible terminal and B has a hidden terminal in the same tab
- **AND** the user switches from A to B and back
- **THEN** B's terminal stays hidden and A's terminal is restored visible

#### Scenario: Browser restores a cached page
- **WHEN** browser history restores a workspace page after its terminal connections were released on departure
- **THEN** the visible terminal reconciles its saved panes with live inventory and resumes available shells
- **AND** obsolete connection callbacks do not remove the restored panes or hide the panel

### Requirement: Attachment recovery preserves presentation and explicit ownership

Connection failure alone SHALL NOT mean shell exit, pane closure, or hiding. Visible saved-PTY panes SHALL stay visible during authenticated-inventory reconciliation, distinguishing detached, occupied, missing, and unavailable inventory/authentication. Transient failures SHALL get bounded automatic recovery then an actionable result, not endless retries. Neither recovery nor saved references SHALL authorize takeover or automatic replacement shells.

#### Scenario: Confirmed resource state determines the parked pane's action
- **WHEN** recovery confirms a missing or exited PTY or an explicit takeover by another client
- **THEN** missing or exited PTYs are reported ended or unavailable, not offered for takeover
- **AND** explicit takeover retains the existing Take back behavior without automatic reclamation

#### Scenario: Previous connection is released after restore begins
- **WHEN** a saved-pane restoration encounters its previous connection still attached
- **AND** that connection is released within the bounded recovery window without another client claiming the PTY
- **THEN** the pane automatically attaches to the now-detached PTY using an ordinary attach
- **AND** the panel stays visible and no takeover action is required

#### Scenario: Another client keeps the terminal
- **WHEN** a saved PTY remains attached to another client throughout the recovery window
- **THEN** the panel stays visible and offers an explicit takeover action for that PTY
- **AND** the existing holder stays interactive until the user explicitly takes over
- **AND** copied or duplicated-tab pane references do not bypass this rule

#### Scenario: Hub accepts the browser connection but the child rejects attachment
- **WHEN** the browser-side WebSocket opens through the Hub but attachment fails before terminal reconstruction completes
- **THEN** the client treats it as an attachment failure and reconciles the saved PTY
- **AND** the failure does not delete the pane or persist hidden visibility

#### Scenario: Inventory cannot be reached
- **WHEN** recovery cannot obtain authenticated terminal inventory within its bounded window
- **THEN** the pane retains its saved PTY reference and the panel shows a retry or authentication action appropriate to the failure
- **AND** unavailable inventory is not presented as proof of another holder or shell exit

#### Scenario: Page address fails the origin gate
- **WHEN** credentials are valid but the address the page uses does not pass the terminal's origin gate
- **THEN** the authenticated inventory read reports that refusal and recovery ends with the origin explanation
- **AND** the pane retains its saved PTY reference and spends no further attach attempts on that address

#### Scenario: Saved shell no longer exists
- **WHEN** recovery successfully reads inventory and the saved PTY is absent
- **THEN** the panel reports that terminal as ended or unavailable and offers an explicit way to open a new shell
- **AND** it neither attempts takeover of that PTY nor silently replaces it
- **AND** a replacement shell whose creation fails leaves the parked pane and its actions in place

#### Scenario: Explicit takeover does not start a recovery fight
- **WHEN** another client explicitly takes over an attached terminal
- **THEN** the displaced pane presents its existing Take back action
- **AND** navigation or pending retry callbacks do not automatically reclaim the terminal

#### Scenario: User action supersedes recovery
- **WHEN** the user hides or closes a terminal while its restoration is pending
- **THEN** pending recovery cannot reopen the panel or attach a superseded pane
- **AND** hiding keeps the shell alive while explicit confirmed termination retains its existing destructive behavior
