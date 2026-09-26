# web-push-notifications Specification

## Purpose

Notify users when an agent needs an answer or finishes a turn, even when their Uatu page is closed or suspended, and return them to the relevant conversation when they open the notification.

## Requirements

### Requirement: Notifications require explicit device opt-in
Hub-served Uatu SHALL offer an Enable notifications action in supported secure browser contexts. Permission SHALL be requested only following that action, never on installation, page load, or receipt of an agent event. The UI SHALL report the actual permission and subscription state and SHALL explain denied permission, unsupported environments, and HTTPS requirements without blocking ordinary use. On iPhone and iPad environments requiring a Home Screen installation, the UI SHALL explain that prerequisite before attempting enrollment. Enrollment SHALL use feature detection and SHALL work from the hub dashboard and a hub-served workspace. Enrollment SHALL succeed only when the hub knows the current notification-feed position of every running workspace the enrollment covers — the selected workspaces, or every accessible workspace when All workspaces is on; otherwise the hub SHALL refuse with a retryable error naming the workspace(s) it could not reach, SHALL leave the device's existing enrollment unchanged, and the UI SHALL present that refusal rather than reporting the device enabled.

#### Scenario: Installed iPhone app enrolls
- **WHEN** a user opens Uatu as a Home Screen app over HTTPS on a supported iPhone and taps Enable notifications
- **THEN** the system permission request follows that interaction
- **AND** granting permission and successfully registering the device enables notifications

#### Scenario: Supported desktop browser enrolls without installation
- **WHEN** a user enables notifications in a supported desktop browser over a secure connection
- **THEN** enrollment succeeds without requiring PWA installation

#### Scenario: Installation alone does not prompt
- **WHEN** a user installs or opens Uatu without enabling notifications
- **THEN** Uatu does not request notification permission

#### Scenario: Unavailable notification support remains understandable
- **WHEN** Uatu is opened on plain HTTP at a remote LAN address, in an unsupported browser, or in an iPhone browser context that requires Home Screen installation
- **THEN** the UI explains the applicable prerequisite and does not claim that notifications are enabled
- **AND** chat and document browsing continue to work

#### Scenario: Denied permission is not repeatedly requested
- **WHEN** notification permission is denied
- **THEN** the UI explains how to change the browser or OS permission and does not repeatedly invoke the permission prompt

#### Scenario: A running workspace's feed does not answer in time
- **WHEN** a user enrolls or updates a device selecting a running workspace whose notification feed has not answered within the hub's settle bound
- **THEN** the hub refuses with a retryable service-unavailable error that names that workspace
- **AND** no device record is created or changed and no cutoff is stamped
- **AND** the UI shows the refusal and leaves the device's previous state intact
- **AND** a retry after the feed answers succeeds with a cutoff no earlier than the feed position

#### Scenario: Stopped workspaces do not delay enrollment
- **WHEN** a user enrolls selecting only stopped workspaces, or a mix in which every running workspace's feed answers in time
- **THEN** enrollment succeeds without waiting on the stopped workspaces

#### Scenario: All workspaces enrollment waits for every running workspace
- **WHEN** a user enrolls or updates a device with All workspaces on while several accessible workspaces are running
- **THEN** the hub waits, within one settle bound, for the feed position of each running workspace before stamping any cutoff
- **AND** a running workspace whose feed does not answer in time is named in the refusal exactly as it would be for a per-workspace enrollment
- **AND** stopped workspaces are covered without waiting

### Requirement: Device preferences select workspaces and event categories
Each enrolled browser profile or installed app SHALL have notification preferences associated with its authenticated hub user. For each device the user SHALL choose one workspace mode: All workspaces, or an explicit selection of accessible workspaces. The user SHALL be able to toggle needs-answer notifications and successful-turn-completion notifications independently for that device, in either mode. Both categories SHALL initially be selected in the enrollment form, All workspaces SHALL initially be off, and in the explicit mode the current workspace SHALL be preselected when enrollment starts there and no workspace preselected on the dashboard. Submitting the form SHALL confirm the choice. All workspaces SHALL be stored as a standing rule for the device: it SHALL cover every workspace the user can access at the time of each event, including workspaces registered after it was saved, and SHALL NOT be recorded as the list of workspaces that existed when it was saved. Under the explicit mode, new workspaces SHALL NOT be subscribed automatically. Turning All workspaces off SHALL return the device to its previous explicit selection, or to no workspaces if it never had one. The device state reported to the client SHALL name the mode and the explicit selection. Disabling notifications SHALL stop future sends to that device without affecting the user's other devices.

#### Scenario: Phone and desktop have different preferences
- **WHEN** a user selects two workspaces on their phone and only one on their desktop browser
- **THEN** each device receives only events matching its own workspace and category preferences

#### Scenario: A workspace is added later
- **WHEN** a new workspace becomes accessible after enrollment on a device in the explicit mode
- **THEN** it is absent from the device's notification selection until explicitly selected

#### Scenario: A workspace is added later under All workspaces
- **WHEN** a device has All workspaces on and a new workspace is registered on the hub afterwards
- **THEN** the device receives that workspace's events in its enabled categories without the user revisiting notification settings
- **AND** reopening the settings on that device still shows All workspaces on, not a list expanded to include the new workspace

#### Scenario: One device covers everything while another stays selective
- **WHEN** a user's phone has All workspaces on and their desktop selects one workspace, and an agent asks a question in a workspace the desktop did not select
- **THEN** the phone is notified and the desktop is not

#### Scenario: Switching from All workspaces back to a selection
- **WHEN** a user who previously saved workspaces alpha and beta turns All workspaces on, saves, and later turns it off again
- **THEN** the form shows alpha and beta selected and saving restores that selection
- **AND** a workspace registered while All workspaces was on is not part of the restored selection

#### Scenario: Disable on one device
- **WHEN** a user disables notifications on their phone
- **THEN** future sends and queued unsent notifications for that enrollment stop
- **AND** enrollment on their desktop remains active

### Requirement: Subscriptions follow authenticated ownership and access
Subscription creation, preference changes, and removal SHALL require hub authentication and the hub's existing request protections. The server SHALL verify subscription ownership and workspace access both when preferences change and before sending. Signing out of the enrollment's hub session, expiration or revocation of that session, or loss of workspace access SHALL prevent subsequent sends under that authorization. Signing in again SHALL reconcile enrollment with the current account before sending resumes; a previously enrolled endpoint SHALL NOT silently transfer between users. Subscription details and push credentials SHALL NOT appear in application logs or responses to other users.

#### Scenario: Another user cannot change a subscription
- **WHEN** an authenticated user attempts to modify or remove another user's enrollment
- **THEN** the hub refuses the operation and leaves the enrollment unchanged

#### Scenario: Session ends while a notification is queued
- **WHEN** the enrollment's hub session is signed out, expires, or is revoked before a queued notification is sent
- **THEN** the notification is not sent and the enrollment requires authenticated reconciliation
- **AND** notifications already handed to the platform are not represented as recalled

#### Scenario: Access changes before delivery
- **WHEN** a user loses access to a selected workspace
- **THEN** the hub stops sending that workspace's notifications to that user, including queued unsent events

### Requirement: Notifications describe live agent events
Uatu SHALL produce needs-answer notifications for newly pending questions and permission requests and completion notifications for successful completion of a top-level agent turn in a selected workspace. Events SHALL identify the workspace, agent-qualified conversation, event kind, and stable source occurrence. OpenCode and Claude SHALL follow the same behavior. A new pending interaction SHALL remain distinguishable from an earlier pending interaction in the same workspace. Transcript replay, initial state hydration, unchanged status snapshots, individual tool completion, child-agent completion, failure, cancellation, and a transition into background work SHALL NOT produce a successful-turn-completion notification. An already resolved interaction SHALL be discarded before its unsent notification is dispatched when its resolution is known. A resolution SHALL carry the same identity as the pending event it resolves, regardless of which conversation reported the resolution.

#### Scenario: Another question appears while one is pending
- **WHEN** a second distinct question becomes pending while the workspace already has an unanswered question
- **THEN** the second question produces its own eligible needs-answer event

#### Scenario: One conversation finishes while another runs
- **WHEN** one top-level conversation successfully completes a turn and another conversation in the workspace remains running
- **THEN** the completed turn produces an eligible notification identifying the completed conversation

#### Scenario: History is reopened
- **WHEN** Uatu replays old questions, tools, or completed turns while loading a conversation
- **THEN** those historical records do not create new notifications

#### Scenario: A turn fails or leaves work in the background
- **WHEN** a turn fails, is cancelled, or moves into a background-work state
- **THEN** Uatu does not describe that transition as successful completion

#### Scenario: A subagent's request is resolved through its parent
- **WHEN** a subagent's question or permission request was announced as pending and its answer is later known only through the parent conversation — an answer given from the parent's transcript, or a parent reconciliation that no longer lists the request
- **THEN** the resolution identifies the subagent conversation and request that were announced, not the parent
- **AND** the request is no longer pending in the workspace feed
- **AND** an unsent delivery for that request is discarded

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

### Requirement: Notifications open the relevant conversation
Notifications SHALL display a concise needs-answer or turn-completed message and workspace identity without including transcript text, question answers, permission details, or tool output. Each notification SHALL carry a same-origin destination for the corresponding workspace and agent-qualified conversation. Tapping it SHALL reuse a suitable Uatu window or open one, activate Chat in the current UI mode, and select that conversation. If login is required, the intended destination SHALL survive login. Missing or inaccessible destinations SHALL produce an understandable unavailable state rather than opening a different conversation as though it were the target. Each delivered push SHALL request a visible notification; foreground pages SHALL NOT also display a duplicate local notification.

#### Scenario: Notification opens an installed iPad app
- **WHEN** the user taps a question notification while using the Home Screen installation
- **THEN** Uatu opens the named workspace and conversation with Chat visible in the user's current UI mode
- **AND** any still-pending question is available through the normal chat interaction

#### Scenario: Login is required after tapping
- **WHEN** a delivered notification is opened after authentication expires
- **THEN** the user logs in through the normal hub flow and then returns to the intended accessible conversation

#### Scenario: The conversation was removed
- **WHEN** the notification's conversation no longer exists or is inaccessible
- **THEN** Uatu shows an unavailable destination state without selecting an unrelated conversation as the target

#### Scenario: Foreground delivery has one notification path
- **WHEN** the same eligible event reaches an open page and the push worker
- **THEN** only the push path requests an OS notification

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
