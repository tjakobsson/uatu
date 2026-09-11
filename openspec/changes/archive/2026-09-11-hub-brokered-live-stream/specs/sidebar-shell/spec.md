## MODIFIED Requirements

### Requirement: Animate the live connection indicator
While the browser UI has received and applied authoritative state from its current live update channel, the connection indicator SHALL animate with a subtle pulse so the live state is visually distinguishable from a static label. When the channel enters a reconnecting state, the pulse MUST stop and the indicator MUST communicate the reconnecting state without animation. The indicator MUST remain reconnecting until a current replacement channel has supplied authoritative state, and MUST return to connected immediately after that recovery succeeds rather than waiting for a later file change. The pulse MUST be disabled when the user's operating system requests reduced motion. The indicator's label MUST read `Connected` while the channel is confirmed live, `Reconnecting` while it is recovering, and `Connecting` before the first successful connect. The indicator MUST expose a hover tooltip whose text describes the current connection state to the uatu backend (for example, `Connected to the uatu backend`). The connection indicator SHALL be rendered inside the sidebar header, stacked beneath the `UatuCode` wordmark, so the indicator visually belongs to the application chrome rather than the per-document preview controls. As a tradeoff of this placement, collapsing the sidebar MAY hide the indicator along with the rest of the sidebar chrome. The indicator's label and animation MUST NOT vary by any Mode-equivalent state - the SPA is a single mode. On a hub-served page the live update channel is the hub's brokered stream, and the indicator SHALL reflect that stream's transport state together with the current workspace's applied `document` state; a topic-scoped resync or unavailability for a chat topic MUST NOT change the shell indicator, and Chat transport status SHALL remain scoped to the Chat surface.

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
