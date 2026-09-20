## MODIFIED Requirements

### Requirement: Animate the live connection indicator
While the browser UI has received and applied authoritative state from its current live update channel, the connection indicator SHALL animate with a subtle pulse so the live state is visually distinguishable from a static label. When the channel enters a reconnecting state, the pulse MUST stop and the indicator MUST communicate the reconnecting state without animation. The indicator MUST remain reconnecting until a current replacement channel has supplied authoritative state, and MUST return to connected immediately after that recovery succeeds rather than waiting for a later file change. The pulse MUST be disabled when the user's operating system requests reduced motion. The indicator's label MUST read `Connected` while the channel is confirmed live, `Reconnecting` while it is recovering, `Connecting` before the first successful connect, and — on a hub-served page — `Stopped` while the hub reports the current workspace's session not running and the channel is not confirmed live. A stopped session MUST NOT be presented as `Reconnecting`: the word is reserved for a transport gap or an unreachable child of a running session. The `Stopped` state SHALL be sourced from the hub's own report of the session (the activity topic prompting a read of the hub's workspace state), so a running session whose child is momentarily unreachable stays `Reconnecting`, and it SHALL clear from the stream when the session is started from anywhere, without a reload. The indicator MUST expose a hover tooltip whose text describes the current connection state to the uatu backend (for example, `Connected to the uatu backend`, or for a stopped session, `The workspace session is stopped`). The connection indicator SHALL be rendered inside the sidebar header, stacked beneath the `UatuCode` wordmark, so the indicator visually belongs to the application chrome rather than the per-document preview controls. As a tradeoff of this placement, collapsing the sidebar MAY hide the indicator along with the rest of the sidebar chrome. The indicator's label and animation MUST NOT vary by any Mode-equivalent state - the SPA is a single mode. On a hub-served page the live update channel is the hub's brokered stream, and the indicator SHALL reflect that stream's transport state together with the current workspace's applied `document` state; a topic-scoped resync or unavailability for a chat topic MUST NOT change the shell indicator, and Chat transport status SHALL remain scoped to the Chat surface. A page served directly, without a hub, never shows `Stopped`.

#### Scenario: The indicator pulses while connected to the server
- **WHEN** the browser UI's current event channel supplies authoritative state that the client applies
- **THEN** the connection indicator displays a pulsing animation labeled `Connected`
- **AND** the indicator's hover tooltip reads `Connected to the uatu backend`

#### Scenario: Reconnecting stops the pulse
- **WHEN** the browser UI's event channel reports an error and enters a reconnecting state
- **THEN** the indicator stops pulsing
- **AND** the label reads `Reconnecting`
- **AND** the hover tooltip describes the reconnecting state

#### Scenario: Successful recovery clears reconnecting immediately
- **WHEN** a replacement event channel supplies and applies its authoritative state
- **THEN** the indicator returns to `Connected` without waiting for a watched file to change
- **AND** an older recovery attempt cannot return the indicator to a stale state

#### Scenario: A stopped session reads Stopped, not Reconnecting
- **WHEN** the viewed workspace's session is stopped from the dashboard or another device while its page is open
- **THEN** the indicator's label changes to `Stopped` without the page reloading
- **AND** the indicator does not pulse
- **AND** the hover tooltip says the workspace session is stopped

#### Scenario: An unreachable child of a running session stays Reconnecting
- **WHEN** the stream reports the current workspace not running but the hub's workspace state still lists its session as running
- **THEN** the indicator reads `Reconnecting`
- **AND** no start is offered

#### Scenario: A start from elsewhere clears Stopped
- **WHEN** a stopped session whose page reads `Stopped` is started from the dashboard or another device
- **THEN** the page's indicator leaves `Stopped` from the stream update and returns to `Connected` once the replacement state is applied, without a reload

#### Scenario: Chat status does not misrepresent document connectivity
- **WHEN** a chat topic on the brokered stream requires a resync while the stream and its `document` topic remain confirmed live
- **THEN** the shell connection indicator remains `Connected`
- **AND** Chat reports its own status within the Chat surface

#### Scenario: Reduced-motion users see no animation
- **WHEN** the operating system reports a reduced-motion preference
- **THEN** the indicator does not pulse even while connected
- **AND** the live state is still communicated (e.g. via color and label)

#### Scenario: Indicator lives under the UatuCode wordmark
- **WHEN** the SPA renders the sidebar header
- **THEN** the connection indicator is rendered inside `.sidebar-header > .brand > .brand-text`, immediately below the `UatuCode` wordmark
- **AND** the connection indicator is NOT rendered in the preview toolbar

#### Scenario: Indicator hides when the sidebar is collapsed
- **WHEN** a user collapses the sidebar
- **THEN** the connection indicator is no longer visible (it lives inside the sidebar chrome that the collapse hides)

### Requirement: The connection indicator offers a manual reconnect
The connection indicator SHALL be an actionable control whenever the connection is not confirmed live, so a user can ask for recovery without depending on browser chrome. It MUST be operable by pointer, touch, and keyboard, MUST carry an accessible name describing the action rather than only the current state, and MUST present a touch target no smaller than the application's other touch-mode controls. While the connection is confirmed live the indicator MAY be inert.

Activating the control SHALL first attempt recovery in place: reconcile authoritative state and re-establish the live channel, preserving the previewed document, scroll position, sidebar selection, and any Chat draft or timeline position. If the connection is not confirmed live within a bounded period after that attempt, the control SHALL reload the page, because an in-place recovery cannot rescue a page whose own recovery machinery is no longer running. The control MUST communicate that an attempt is under way and MUST NOT start a second concurrent attempt while one is in flight.

While the indicator reads `Stopped`, its action SHALL be to start the workspace's session through the hub instead of reconnecting, and its accessible name SHALL say so. A successful start SHALL return the page to `Connected` in place, preserving the previewed document, scroll position, sidebar selection, and any Chat draft or timeline position; the page MUST NOT reload as part of the start. The control MUST NOT fall back to reloading the page while the session is stopped — a reload cannot offer more than the control already does — and a recovery attempt already in flight when the session stopped MUST settle without reloading. A start the hub refuses because the workspace's credentials are locked SHALL hand off to the hub dashboard's unlock flow; any other refusal SHALL be shown at the indicator and the control SHALL remain available. If the hub accepts the start but the channel is not confirmed live within the bounded period, the indicator SHALL return to `Reconnecting` with its ordinary reconnect action.

#### Scenario: Activating the indicator recovers in place
- **WHEN** a user activates the connection indicator while it reads `Reconnecting` and an in-place recovery succeeds
- **THEN** the indicator returns to `Connected` without reloading the page
- **AND** the previewed document, scroll position, and any Chat draft are unchanged

#### Scenario: A dead page falls back to reloading
- **WHEN** a user activates the connection indicator and the connection is still not confirmed live after the bounded attempt window
- **THEN** the page reloads

#### Scenario: Activating a stopped indicator starts the session
- **WHEN** a user activates the connection indicator while it reads `Stopped`
- **THEN** the hub is asked to start the workspace's session and the control shows an attempt under way
- **AND** once the started session's state is applied the indicator reads `Connected`
- **AND** the page did not reload, and the previewed document, scroll position, and any Chat draft are unchanged

#### Scenario: A stopped session never reloads on its own
- **WHEN** a recovery attempt was in flight and the session is stopped before the attempt's window elapses
- **THEN** the page does not reload
- **AND** the indicator reads `Stopped` and offers the start

#### Scenario: A locked start hands off to the dashboard
- **WHEN** a user activates a `Stopped` indicator and the hub refuses because the workspace's credentials are locked
- **THEN** the page navigates to the hub dashboard, where the credential-aware start flow collects the passphrase

#### Scenario: A failed start stays actionable
- **WHEN** a user activates a `Stopped` indicator and the hub refuses for another reason
- **THEN** the refusal's message is shown at the indicator
- **AND** the indicator still reads `Stopped` and can be activated again

#### Scenario: The control is reachable without a browser
- **WHEN** the application runs in standalone display mode with no browser reload or pull-to-refresh available
- **THEN** the connection indicator is operable by touch and exposes an accessible name describing the reconnect action

#### Scenario: Repeated activation does not pile up attempts
- **WHEN** a user activates the reconnect control repeatedly while an attempt is in flight
- **THEN** the attempt already running continues and no second concurrent attempt is started
- **AND** the control shows that an attempt is under way
