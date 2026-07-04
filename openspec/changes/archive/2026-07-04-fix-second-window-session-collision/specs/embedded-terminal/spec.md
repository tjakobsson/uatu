# embedded-terminal delta — fix-second-window-session-collision

## ADDED Requirements

### Requirement: A sessionId collision resolves to a fresh session, not an auth prompt
When a terminal WebSocket closes before opening, the client SHALL NOT assume an authentication failure. The client SHALL probe `GET /api/auth`; the server SHALL respond 204 when the request carries valid terminal credentials (auth cookie or `t` query token) and 401 otherwise. When the probe succeeds, the client SHALL treat the failed upgrade as a `sessionId` collision, mint a fresh `sessionId` for the pane, and reconnect. The paste-token form SHALL be shown only when the probe returns 401.

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

#### Scenario: Probe endpoint gates on credentials
- **WHEN** `GET /api/auth` is requested with a valid auth cookie or a valid `t` query token
- **THEN** the server responds 204
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
