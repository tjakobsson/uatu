# embedded-terminal delta — persist-detached-pty-sessions

## ADDED Requirements

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

## REMOVED Requirements

### Requirement: Terminal lifecycle is bounded by the connection
**Reason**: The 5-second reconnect grace window was designed to absorb page reloads, but it kills long-running shells whenever the browser closes or the machine sleeps. PTY lifetime is now bounded by the shell process and the server session, not the WebSocket.
**Migration**: Replaced by "Detached PTY sessions persist until shell exit or server shutdown". The reload-reattach behavior is preserved (and generalized to any detachment duration); the "disconnect kills the PTY" behavior is intentionally dropped; the server-shutdown scenario moves to the new requirement.

## MODIFIED Requirements

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
