# embedded-terminal Delta Spec

## ADDED Requirements

### Requirement: Touch devices get a terminal keybar
On coarse-pointer devices the terminal panel SHALL show a key row for input a software keyboard cannot produce — at minimum Escape, Tab, Control-C, Control-D, Control-Z, and the arrow keys — sending each key's control sequence down the focused pane's PTY exactly as typed input travels. Activating a key MUST NOT move focus out of the terminal (which would dismiss the software keyboard). The row SHALL NOT appear on fine-pointer devices.

#### Scenario: Interrupting a process from an iPad
- **WHEN** a user on a coarse-pointer device runs a foreground process and taps the keybar's Control-C
- **THEN** the byte 0x03 reaches the PTY and the process receives the interrupt
- **AND** the terminal keeps keyboard focus

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

## MODIFIED Requirements

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
