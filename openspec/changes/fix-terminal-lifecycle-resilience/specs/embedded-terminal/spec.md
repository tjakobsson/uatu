## ADDED Requirements

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
