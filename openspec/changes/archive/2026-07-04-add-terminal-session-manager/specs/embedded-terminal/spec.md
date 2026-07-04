# embedded-terminal delta — add-terminal-session-manager

## ADDED Requirements

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
