# web-push-notifications Specification

## Purpose

Notify users when an agent needs an answer or finishes a turn, even when their Uatu page is closed or suspended, and return them to the relevant conversation when they open the notification.

## Requirements

### Requirement: Notifications require explicit device opt-in
Hub-served Uatu SHALL offer feature-detected, explicit notification opt-in in supported secure contexts from dashboard and workspaces. Enrollment SHALL require current feed positions for every covered running workspace and preserve existing enrollment on refusal.

#### Scenario: Permission enrollment follows explicit supported-context intent
- **WHEN** Enable notifications is activated
- **THEN** permission SHALL be requested only after that action, never at installation, page load, or agent-event receipt
- **AND** the UI SHALL report actual permission/subscription state and explain denied permission, unsupported environments, and HTTPS without blocking normal use
- **AND** iPhone/iPad Home Screen installation prerequisites SHALL be explained before enrollment when required
- **AND** enrollment SHALL use feature detection from dashboard and hub-served workspaces

#### Scenario: Enrollment requires every covered running feed position
- **WHEN** enrollment covers selected workspaces or all accessible workspaces under All workspaces
- **THEN** success SHALL require the hub to know every covered running workspace's current notification-feed position
- **AND** otherwise the hub SHALL refuse retryably naming unreachable workspaces, leave existing enrollment unchanged, and the UI SHALL present refusal rather than enabled state

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
Each enrolled profile/app SHALL have authenticated-user-associated, device-specific workspace and event-category preferences. All workspaces SHALL be a standing access rule, not a saved inventory snapshot; explicit selections and other devices SHALL remain independent.

#### Scenario: Enrollment defaults and submission record a device's explicit choices
- **WHEN** the enrollment form opens
- **THEN** it SHALL offer All workspaces or explicit accessible-workspace selection and independently toggle needs-answer and successful-turn-completion categories in either mode
- **AND** both categories SHALL default selected, All workspaces off, with current workspace preselected from a workspace and none preselected from dashboard
- **AND** submitting SHALL confirm choices; reported device state SHALL name mode and explicit selection

#### Scenario: Workspace mode changes retain selective history and live access coverage
- **WHEN** All workspaces is saved
- **THEN** it SHALL stand for every workspace accessible at each event, including later registrations, and SHALL NOT store the then-existing inventory list
- **WHEN** All workspaces is turned off
- **THEN** the prior explicit selection SHALL return, or none if absent; explicit mode SHALL NOT automatically subscribe new workspaces
- **WHEN** notifications are disabled on one device
- **THEN** future sends SHALL stop there without affecting the user's other devices

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
Subscription creation, preference changes, and removal SHALL use hub authentication and existing request protections. Ownership and workspace access SHALL be checked on changes and before sends; ended authorization SHALL prevent sending, and enrollment MUST remain account-bound and private.

#### Scenario: Authorization changes stop sends and require account reconciliation
- **WHEN** enrollment's hub session signs out, expires, or is revoked, or workspace access is lost
- **THEN** subsequent sends under that authorization SHALL stop
- **WHEN** sign-in occurs again
- **THEN** enrollment SHALL reconcile with the current account before sends resume, and endpoints SHALL NOT silently transfer users

#### Scenario: Normal enrollment operation retains subscription privacy
- **WHEN** subscription details or push credentials are handled, with or without an authorization change
- **THEN** they SHALL NOT appear in application logs or other users' responses

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
OpenCode and Claude SHALL notify alike for new questions/permissions and successful top-level turns in selected workspaces, using stable occurrence identities. Historical or non-success transitions SHALL NOT produce completion notifications, and known resolved interactions SHALL be discarded before unsent dispatch.

#### Scenario: Live notifications distinguish occurrences from replay and non-top-level outcomes
- **WHEN** a new needs-answer or successful top-level-turn event occurs
- **THEN** it SHALL identify workspace, agent-qualified conversation, event kind, and stable source occurrence, distinguishing successive pending interactions in one workspace
- **AND** transcript replay, initial hydration, unchanged snapshots, individual tool or child-agent completion, failure, cancellation, and transition to background work SHALL NOT produce successful-turn-completion notifications

#### Scenario: Resolution identity cancels the exact unsent pending occurrence
- **WHEN** an interaction's resolution is known before dispatch
- **THEN** its unsent notification SHALL be discarded
- **AND** resolution SHALL carry the pending event's same identity regardless of which conversation reported it

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
The hub SHALL observe covered running workspaces and send eligible Web Push without open pages, conversations, or browser live streams, subject to presence rules. Shared observation SHALL avoid starting idle runtimes/workspaces and preserve enrollments, push identity, and pending delivery across restart.

#### Scenario: Page-independent observation respects coverage and runtime lifecycle
- **WHEN** a device covers selected workspaces or all accessible workspaces under All workspaces
- **THEN** eligible running-workspace events SHALL be observed/submitted without browser live stream, open conversation, or visible page; presence SHALL decide send/hold/discard, never page absence preventing send
- **AND** observation SHALL be shared across enrolled devices and SHALL NOT start unused agent runtimes or stopped workspaces solely to watch
- **AND** later-registered All workspaces members SHALL be observed on running without client action, treating events before the hub first saw registration as history for that device

#### Scenario: Restart and replay gaps preserve pending delivery rather than historical completions
- **WHEN** the hub restarts or reconnects
- **THEN** device enrollments, server push identity, and pending delivery SHALL survive restart, and reconnect SHALL resume retained events where possible
- **AND** replay gaps SHALL reconcile still-pending interactions without historical-completion announcements
- **AND** Uatu SHALL document required running hub/agent, withholding while users have visible session pages, and browser/OS control of delivery timing

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
Each event/enrollment pair SHALL keep one logical delivery identity across replay and bounded retries, with a five-minute lifetime. Accepted pushes SHALL NOT be deliberately resent as new events, and Uatu SHALL NOT claim exactly-once OS delivery.

#### Scenario: Retry lifetime and transport ambiguity preserve one logical notification
- **WHEN** repeated frames or replay occur within supported retention
- **THEN** recorded occurrences SHALL NOT enqueue new notifications
- **WHEN** temporary push failures or ambiguous transport outcomes occur
- **THEN** retries SHALL be bounded to five minutes from source event, except presence-held needs-answer lifetime SHALL start on release; expired events SHALL be discarded
- **AND** ambiguous duplicate deliveries SHALL keep the same identity to replace rather than multiply visible entries
- **AND** permanently invalid subscriptions SHALL be removed from sending, and accepted pushes SHALL NOT deliberately resubmit as new events

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
Notifications SHALL identify workspace and needs-answer/completion state without conversation details and carry same-origin conversation destinations. Activation SHALL open the correct Chat, survive login, and explain unavailable targets; delivered pushes SHALL visibly notify without foreground duplicates.

#### Scenario: Push content and activation preserve privacy and exact conversation destination
- **WHEN** a notification is delivered or tapped
- **THEN** its concise needs-answer/turn-completed message and workspace identity SHALL exclude transcript text, question answers, permission details, and tool output
- **AND** its same-origin destination SHALL identify workspace and agent-qualified conversation; tapping SHALL reuse a suitable Uatu window or open one, activate Chat in current UI mode, and select that conversation
- **AND** login SHALL preserve destination; missing/inaccessible destinations SHALL show understandable unavailable state rather than a different conversation as target
- **AND** each push SHALL request a visible notification while foreground pages SHALL NOT duplicate it locally

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
Per-user presence across devices SHALL govern notification sending: visible authenticated session pages imply present, the next 30 seconds imply recently present, otherwise away. Presence SHALL discard or hold completions and hold pending questions, retaining bounded release and restart-safe delivery identities.

#### Scenario: Presence is user-wide and excludes non-session or hidden pages
- **WHEN** presence is evaluated
- **THEN** any visible hub-served session page authenticated as that user on any device SHALL make the user present, with recently-present lasting 30 seconds after the last such page hides or disconnects, and away otherwise
- **AND** dashboard, login, and background-hidden pages SHALL NOT make presence; state SHALL govern every enrolled device regardless of workspace/category preferences
- **WHEN** the hub starts
- **THEN** every user SHALL begin recently present so reconnecting pages count before delivery decisions

#### Scenario: Sendable events obey distinct completion and pending-question presence rules
- **WHEN** a successful top-level completion becomes sendable
- **THEN** it SHALL be discarded if present, held if recently present, then sent on away or discarded if presence returns first
- **WHEN** needs-answer becomes sendable while present or recently present
- **THEN** it SHALL be held and released on away only if still pending and at most 60 minutes from source event, otherwise discarded
- **WHEN** any event becomes sendable while away
- **THEN** it SHALL send without delay as before

#### Scenario: Held deliveries survive restart without multiplying or outliving resolved requests
- **WHEN** an event is held
- **THEN** holding SHALL NOT add logical deliveries; it SHALL keep one identity per enrollment and send at most once
- **AND** resolution, access loss, device removal, or any other unsent-discard rule SHALL discard held deliveries alike
- **AND** held deliveries and release state SHALL survive restart; unanswered interactions SHALL stay reconcilable at least the 60-minute limit so replay gaps do not misreport answered or still-pending state

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
