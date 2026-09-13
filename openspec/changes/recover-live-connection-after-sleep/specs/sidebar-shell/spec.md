## ADDED Requirements

### Requirement: The connection indicator offers a manual reconnect
The connection indicator SHALL be an actionable control whenever the connection is not confirmed live, so a user can ask for recovery without depending on browser chrome. It MUST be operable by pointer, touch, and keyboard, MUST carry an accessible name describing the action rather than only the current state, and MUST present a touch target no smaller than the application's other touch-mode controls. While the connection is confirmed live the indicator MAY be inert.

Activating the control SHALL first attempt recovery in place: reconcile authoritative state and re-establish the live channel, preserving the previewed document, scroll position, sidebar selection, and any Chat draft or timeline position. If the connection is not confirmed live within a bounded period after that attempt, the control SHALL reload the page, because an in-place recovery cannot rescue a page whose own recovery machinery is no longer running. The control MUST communicate that an attempt is under way and MUST NOT start a second concurrent attempt while one is in flight.

#### Scenario: Activating the indicator recovers in place
- **WHEN** a user activates the connection indicator while it reads `Reconnecting` and an in-place recovery succeeds
- **THEN** the indicator returns to `Connected` without reloading the page
- **AND** the previewed document, scroll position, and any Chat draft are unchanged

#### Scenario: A dead page falls back to reloading
- **WHEN** a user activates the connection indicator and the connection is still not confirmed live after the bounded attempt window
- **THEN** the page reloads

#### Scenario: The control is reachable without a browser
- **WHEN** the application runs in standalone display mode with no browser reload or pull-to-refresh available
- **THEN** the connection indicator is operable by touch and exposes an accessible name describing the reconnect action

#### Scenario: Repeated activation does not pile up attempts
- **WHEN** a user activates the reconnect control repeatedly while an attempt is in flight
- **THEN** the attempt already running continues and no second concurrent attempt is started
- **AND** the control shows that an attempt is under way
