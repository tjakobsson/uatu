## ADDED Requirements

### Requirement: Delivery stays quiet while the user is present
The hub SHALL treat a hub user as *present* while at least one hub-served session page authenticated as that user is visible on any device, and as *recently present* for 30 seconds after the last such page stops being visible or loses its connection. A user who is neither SHALL be *away*. The hub dashboard, the login page, and pages hidden in the background SHALL NOT make a user present. Presence SHALL be evaluated per hub user across all of that user's devices and SHALL govern every enrolled device of that user regardless of each device's workspace and category preferences. When the hub starts, every user SHALL begin as recently present so that pages reconnecting after a restart are counted before any delivery is decided.

Presence SHALL affect sending as follows:
- A successful-turn-completion event that becomes sendable while its user is present SHALL be discarded. One that becomes sendable while its user is recently present SHALL be held; it SHALL be sent if the user becomes away and discarded if the user becomes present first.
- A needs-answer event that becomes sendable while its user is present or recently present SHALL be held. A held needs-answer event SHALL be released for sending when its user becomes away, provided its interaction is still pending and no more than 60 minutes have passed since the source event; otherwise it SHALL be discarded.
- An event that becomes sendable while its user is away SHALL be sent without delay, as before.

Holding SHALL NOT create additional logical deliveries: a held event keeps its one delivery identity per enrollment and is sent at most once. A resolution of a held interaction, loss of workspace access, device removal, and every other rule that discards an unsent delivery SHALL discard a held one alike. Held deliveries and their release state SHALL survive a hub restart. The workspace SHALL keep an unanswered interaction reconcilable for at least the 60-minute hold limit so that a replay gap does not misreport a held interaction as answered or as still pending.

#### Scenario: A question arrives in the conversation on screen
- **WHEN** a user is viewing a workspace's chat on their desktop and the agent there asks a question
- **THEN** no push is sent to any of that user's enrolled devices while the page stays visible
- **AND** the question is presented in the chat as usual

#### Scenario: A turn finishes in another workspace while the user works
- **WHEN** a user has a visible session page for workspace alpha and an agent in workspace beta successfully completes a turn
- **THEN** no completion push is sent for that turn to any of the user's devices
- **AND** the switcher reports beta as finished

#### Scenario: Presence on one device quiets the others
- **WHEN** a user has a visible session page on their desktop, their phone is enrolled with All workspaces, and an agent asks a question
- **THEN** the phone receives no push while the desktop page stays visible

#### Scenario: A question left unanswered follows the user out
- **WHEN** a question arrived while the user was present, remains unanswered, and the user hides or closes their last visible session page
- **THEN** after 30 seconds away the hub sends that question's needs-answer push to the user's devices that cover it
- **AND** the push expires five minutes after it was released if it cannot be delivered

#### Scenario: A brief tab switch sends nothing
- **WHEN** a user with a held question switches away from the Uatu tab and returns within 30 seconds without answering
- **THEN** no push is sent for that question
- **AND** the question remains held

#### Scenario: A turn finishes just after the user looks away
- **WHEN** a user hides their last visible session page and an agent successfully completes a turn 10 seconds later
- **THEN** the completion is held
- **AND** it is sent if the user is still away 30 seconds after hiding the page
- **AND** it is discarded if the user returns before then

#### Scenario: A held question is answered from another device
- **WHEN** a question is held for a present user and is answered from any device
- **THEN** the held delivery is discarded and no push is sent when the user later leaves

#### Scenario: A held question outlives the hold limit
- **WHEN** a question is held for a present user and the user first becomes away more than 60 minutes after it was asked
- **THEN** the held delivery is discarded and no push is sent

#### Scenario: The user is away
- **WHEN** no session page of the user has been visible for more than 30 seconds and an eligible event occurs
- **THEN** the hub sends it without waiting, subject to each device's preferences

#### Scenario: The dashboard does not count as presence
- **WHEN** a user's only open Uatu page is the hub dashboard and an agent asks a question
- **THEN** the hub treats the user as away and sends the needs-answer push

#### Scenario: Another user's presence does not quiet mine
- **WHEN** user A has a visible session page and user B, who has no visible page, has a device covering the same workspace
- **THEN** B's device receives the workspace's eligible pushes without delay

#### Scenario: The hub restarts while the user is looking
- **WHEN** the hub restarts and the user's visible session page reconnects within 30 seconds
- **THEN** events that arrive in that window are held or discarded as for a present user rather than pushed

## MODIFIED Requirements

### Requirement: Delivery continues without an open page
For running workspaces a device covers — its selected workspaces, or every accessible workspace under All workspaces — the hub SHALL observe eligible events and submit Web Push notifications without requiring a browser live stream, an open conversation, or any visible page. Whether an event is sent at once, held, or discarded SHALL follow the presence rule of this capability; an absent page SHALL never prevent a send. Observation SHALL be shared across enrolled devices and SHALL NOT start an unused agent runtime or stopped workspace merely to watch it. A workspace registered after an All workspaces enrollment SHALL be observed once it runs, without any client action; events that occurred before the hub first saw the workspace registered SHALL be treated as history for that device. Device enrollments, server push identity, and pending delivery state SHALL survive hub restart. A reconnect SHALL resume retained events where possible; a replay gap SHALL reconcile still-pending interactions without announcing historical completions. Uatu SHALL document that the hub and agent must be running, that pushes are withheld while the user has a visible session page, and that platform delivery timing is controlled by the browser/OS.

#### Scenario: The phone is locked
- **WHEN** an enrolled phone is locked, its page has released its live connection, the user has no other visible session page, and an observed agent asks a question
- **THEN** the hub submits the matching notification to the phone's push service
- **AND** delivery does not depend on waking the page or opening a browser stream

#### Scenario: All pages are closed
- **WHEN** no Uatu page is open and an observed top-level agent turn successfully completes
- **THEN** the hub submits the matching completion notification

#### Scenario: Watching does not start workspaces or agents
- **WHEN** an enrolled device selects a stopped workspace or a workspace with an unused agent runtime
- **THEN** notification observation alone does not start that workspace or runtime
- **AND** observation becomes effective when the workspace and agent start normally

#### Scenario: A workspace registered after enrollment starts running
- **WHEN** a device has All workspaces on, a workspace is registered later, and that workspace is then started and its agent asks a question
- **THEN** the hub observes the workspace's feed and submits the needs-answer notification to the device
- **AND** a question that was already pending before the hub first saw the workspace registered is not announced to that device

#### Scenario: A covered workspace is removed
- **WHEN** a workspace covered by an All workspaces device is unregistered from the hub
- **THEN** the hub stops observing it for that device and discards its unsent deliveries
- **AND** the device's other coverage is unaffected

#### Scenario: Reconnect has a replay gap
- **WHEN** the hub reconnects to a workspace after its event replay window has been lost
- **THEN** it reconciles current pending interactions using stable request identities
- **AND** it does not infer old successful completions from conversation history

### Requirement: Delivery is bounded and suppresses duplicate events
Each event/enrollment pair SHALL have one logical delivery identity. Repeated source frames and replay within the supported retention window SHALL NOT enqueue a new notification for an already recorded occurrence. Temporary push failures SHALL use bounded retry and a five-minute delivery lifetime. The lifetime SHALL be measured from the source event, except for a needs-answer event held under the presence rule, whose lifetime SHALL be measured from its release; expired events SHALL be discarded. Permanently invalid subscriptions SHALL be removed from sending. Platform-accepted pushes SHALL NOT be deliberately resubmitted as new events. Duplicate deliveries caused by an ambiguous transport outcome SHALL use the same notification identity so they replace rather than multiply visible entries. Uatu SHALL NOT claim exactly-once OS delivery.

#### Scenario: Source replay repeats completion
- **WHEN** a recorded completion event is replayed after reconnect or hub restart within retention
- **THEN** it does not create a second logical delivery for the same enrollment

#### Scenario: A transient failure recovers
- **WHEN** the push service temporarily rejects a send and later accepts a retry before the event expires
- **THEN** the retry uses the same logical notification identity
- **AND** retries stop after acceptance

#### Scenario: An endpoint has expired
- **WHEN** the push service reports a subscription as permanently gone
- **THEN** the hub removes it from active delivery and the client reports that enrollment needs renewal on its next visit

#### Scenario: An old event expires
- **WHEN** five minutes have passed since the source event before a send or retry can occur, and the event was not held under the presence rule
- **THEN** Uatu drops that delivery rather than sending a stale alert

#### Scenario: A released question gets a fresh lifetime
- **WHEN** a question held for 20 minutes is released because its user became away
- **THEN** the hub may send and retry it for five minutes from the release
- **AND** drops it if it has not been accepted by then
