## ADDED Requirements

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

## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: A sessionId collision resolves to a fresh session, not an auth prompt
**Reason**: Browser-created ids and collision-as-creation are replaced by explicit server-created PTY resources and attach/takeover responses.
**Migration**: Clients create PTYs through the authenticated resource API and treat 409 only as an attached-resource ownership conflict.

### Requirement: Pane reattach hints are single-claimant across windows
**Reason**: Shared localStorage hints are origin-wide, leak across Hub workspaces, and conflate pane presentation with PTY identity.
**Migration**: Per-window attachment references are workspace-namespaced; all other clients discover PTYs through authenticated inventory and attach explicitly.
