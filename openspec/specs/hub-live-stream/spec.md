# hub-live-stream Specification

## Purpose

The hub-brokered live stream is the one long-lived connection a hub-served session page holds for everything that is pushed to it: document state, conversation inventory, conversation events, subagent transcripts, and a bounded activity summary of the user's other workspaces. The hub subscribes to each workspace child once per watched topic and fans events out, so the browser's per-host connection budget and the hub's upstream connection count are both bounded by what is watched rather than by how many tabs are open.

## Requirements

### Requirement: A hub-served page holds exactly one live connection
A hub-served page SHALL receive every pushed update, including document state, conversation inventory/events, subagent transcripts, and cross-workspace activity, over one authenticated SSE connection. Conversation/transcript selection, opening/collapsing Chat, and preview changes MUST NOT add pushed-update connections. Streams SHALL carry only authorized workspaces; hidden-page and media/terminal exceptions follow below.

#### Scenario: A page is hidden or uses independent terminal/media transport
- **WHEN** a page becomes hidden
- **THEN** it SHALL release its live connection, retain subscriptions/cursors, and resume topics from them when visible

#### Scenario: A page is initially opened out of view
- **WHEN** a page is initially opened hidden
- **THEN** it SHALL wait until visible before connecting

#### Scenario: Terminal and media transport remain independent while visible or hidden
- **WHEN** a page uses terminal or media transport, regardless of its visibility
- **THEN** terminal WebSockets and finite independently cancellable media GET/HEAD/range responses SHALL remain outside the one-SSE guarantee
- **AND** media bytes MUST NOT enter SSE

#### Scenario: A page with everything open holds one stream
- **WHEN** a page has Chat, a conversation, a child transcript, and a preview open
- **THEN** it holds one SSE connection for pushed updates

#### Scenario: Background tabs do not exhaust the browser
- **WHEN** six or more workspace tabs exist with only one visible
- **THEN** hidden tabs hold no live-update connection
- **AND** ordinary visible-tab requests do not wait for a hidden tab's live stream to close

#### Scenario: A background tab resumes where it was left
- **WHEN** a hidden workspace tab becomes visible
- **THEN** its one replacement stream resumes retained topic cursors without losing its preview, draft, or timeline

#### Scenario: A tab opened in the background waits to connect
- **WHEN** a workspace tab is opened hidden
- **THEN** its live stream waits until the page is shown

#### Scenario: Terminals do not count
- **WHEN** several terminal panes are attached
- **THEN** the page still has one pushed-update SSE connection independently of terminal WebSockets

#### Scenario: Seeking does not add another update stream
- **WHEN** a video plays or seeks through media range requests
- **THEN** the page retains one pushed-update stream and media bytes travel only in the independent HTTP responses
- **AND** cancelling a media request does not close the live stream

### Requirement: Events are enveloped by workspace and topic with independent cursors
Every `live` event SHALL carry its workspace, topic, and topic-scoped cursor. Other frames SHALL be only opening `hello` (naming stream id) and transport keepalives. Keepalives SHALL be unenveloped comment frames and MUST NOT advance cursors. The fixed topics SHALL be `document`, `inventory`, `conversation`, `activity`, `worktrees`, and `personal`, with the payload, replay, isolation, and invalidation contracts below.

#### Scenario: A live frame selects a topic contract
- **WHEN** a `live` event is emitted
- **THEN** `document` SHALL carry workspace state snapshots/change signals; `inventory` SHALL invalidate conversation inventory; `conversation` SHALL carry one conversation's ordered events keyed by conversation id
- **AND** `activity` SHALL carry the cross-workspace summary; `worktrees` SHALL carry bounded inventory invalidation scoped to an accessible source workspace; `personal` SHALL carry account-private personal-state invalidation for the stream's workspace
- **AND** keepalives SHALL instead be unenveloped comment frames and MUST NOT advance any cursor

#### Scenario: Cursor-bearing topics resume independently
- **WHEN** a client reconnects with `document`, `inventory`, or `conversation` subscriptions
- **THEN** it SHALL present each subscription's last applied cursor, and the hub SHALL replay each in order before live events or signal topic-scoped resync if unreplayable
- **AND** cursors SHALL be independent: replay MUST NOT depend on, reorder, or duplicate another topic's events, and one topic falling behind SHALL never resync the entire stream

#### Scenario: Any topic replay stays independent of every other topic
- **WHEN** a topic is replayed, whether on reconnect or after a subscription change
- **THEN** its cursor SHALL be independent and replay MUST NOT depend on, reorder, or duplicate another topic's events
- **AND** one topic falling behind SHALL never cause whole-stream resync

#### Scenario: Every stream open supplies fresh cursor-free activity
- **WHEN** a live stream opens, including an initial open or activity-only reconnect
- **THEN** `activity` SHALL take no cursor and SHALL send a fresh summary for every accessible workspace rather than replay

#### Scenario: Worktree inventory invalidates or reconnects
- **WHEN** `worktrees` is subscribed or reconnects
- **THEN** it SHALL require no replay cursor and send fresh invalidation for an authoritative inventory fetch

#### Scenario: A worktree operation commits or reconciliation changes inventory
- **WHEN** a Uatu worktree operation commits or reconciliation changes inventory
- **THEN** `worktrees` SHALL invalidate immediately, without adding paths/content to `activity` or opening another long-lived connection

#### Scenario: Every worktree invalidation and inventory refresh preserves context
- **WHEN** any worktree invalidation, event, or inventory response arrives, including reconnect refresh
- **THEN** invalidation/reconnect refresh SHALL update the existing in-workspace picker while preserving active workspace, selected document/preview, terminal context, and selected conversation
- **AND** invalidations MUST reveal no inaccessible workspace, path, credential, or conversation content
- **AND** delayed events or responses scoped to another workspace MUST NOT overwrite active context

#### Scenario: A private personal-state category changes or attaches
- **WHEN** `personal` attaches/reconnects or a personal dismissal change commits
- **THEN** it SHALL invalidate without replay cursor and require an authenticated personal-state fetch

#### Scenario: Every personal-topic delivery stays private and presentation-only
- **WHEN** the `personal` topic is delivered for any invalidation
- **THEN** its payload SHALL be only a bounded changed-category invalidation, not account identity, dismissal marks, conversation content, or credentials
- **AND** routing SHALL use stream-authenticated account and authorized workspace, never shared workspace fanout or caller-selected username
- **AND** it SHALL use no replay cursor and SHALL NOT open another long-lived connection, command another client's navigation, or change shared workspace activity

#### Scenario: One topic resyncs, the others resume
- **WHEN** a client reconnects with a conversation cursor that is no longer replayable and a document cursor that is
- **THEN** the conversation topic reports that a fresh snapshot is required
- **AND** the document topic replays from its cursor without a snapshot

#### Scenario: Replay preserves per-conversation ordering
- **WHEN** a client resumes a conversation topic from a retained cursor after missing events
- **THEN** every later event for that conversation arrives once, in order, before live events continue

#### Scenario: Keepalives leave cursors untouched
- **WHEN** an idle stream emits transport keepalives
- **THEN** no topic cursor advances and no application state changes

#### Scenario: Committed operation appears without polling delay
- **WHEN** a Uatu worktree operation commits in another authorized session while a page subscribes to its source workspace's worktree topic
- **THEN** the existing stream immediately invalidates inventory and the existing workspace picker refreshes it without changing the active workspace, selected document/preview, terminal context or selected conversation

#### Scenario: Reconnection recovers missed inventory changes
- **WHEN** a subscribed page reconnects after missing a worktree update
- **THEN** fresh worktree invalidation triggers authoritative inventory refresh independently of conversation/document replay
- **AND** the refreshed picker inventory leaves the active workspace and its document, terminal and conversation selections unchanged

#### Scenario: External discovery is inventory-only
- **WHEN** reconciliation discovers an external worktree and emits an invalidation to the active workspace frontend
- **THEN** the existing picker offers the external checkout for explicit open/registration without automatically switching workspace or changing its files/preview, terminal or chat context

#### Scenario: Live refresh respects workspace boundaries
- **WHEN** worktree invalidation or reconnect refresh reaches the frontend after navigation between separate workspace URLs
- **THEN** it refreshes only the applicable inventory and does not apply another workspace's delayed document, terminal or conversation state to the active context

#### Scenario: Personal dismissal changes reach only their account
- **WHEN** two accounts subscribe to the same workspace and one account commits a worker dismissal
- **THEN** only that account's authorized personal subscriptions receive an invalidation over their existing live connections
- **AND** other accounts receive neither the invalidation nor the changed marks

#### Scenario: Personal invalidation is missed
- **WHEN** a personal subscription attaches or reconnects after changes made on another device
- **THEN** a fresh invalidation causes an authoritative personal-state fetch without replaying execution mutations or adding another stream

### Requirement: Subscriptions change without reconnecting
A client SHALL add/remove topic subscriptions without reopening the stream: conversation on selection, subagent transcript on opening, and unsubscribe on closing. New subscriptions SHALL start from a supplied snapshot cursor or current position; unsubscribed topic events MUST stop promptly. Control requests SHALL follow the authentication and ownership rules below.

#### Scenario: A client modifies an open stream's subscriptions
- **WHEN** a subscription control request is received
- **THEN** it SHALL be authenticated as the stream is and MUST be bound to that stream, preventing one client from altering another's subscriptions

#### Scenario: Selecting a conversation adds a topic
- **WHEN** a user selects a conversation while the stream is open
- **THEN** the conversation's events begin arriving on the existing connection from the snapshot's cursor
- **AND** no new HTTP connection is opened

#### Scenario: Closing a subagent transcript stops its events
- **WHEN** a user closes an open subagent drill-down
- **THEN** that transcript's events stop arriving on the stream
- **AND** the parent conversation's events continue

#### Scenario: Subscription control is bound to its stream
- **WHEN** a request attempts to change subscriptions on a stream it does not own
- **THEN** the request is refused and the stream is unaffected

### Requirement: The hub fans out and bounds upstream subscriptions
The hub SHALL hold at most one upstream subscription per child/topic (per conversation for `conversation`), regardless of client count, and release it within a bounded period after the last client unsubscribes or disconnects. Outbound live-delivery connections MUST be bounded by watched topics, never clients. Upstream failure SHALL remain topic-scoped as below.

#### Scenario: An upstream topic fails or its child exits
- **WHEN** an upstream subscription fails or the child exits
- **THEN** every subscribed client SHALL receive a topic-scoped resync or unavailability signal
- **AND** that outcome MUST NOT end the client stream

#### Scenario: Many tabs, one upstream
- **WHEN** four tabs subscribe to the same conversation of one workspace
- **THEN** the child holds one subscription for that conversation
- **AND** each tab receives every event

#### Scenario: Last subscriber leaving releases the child
- **WHEN** the last client stream subscribed to a workspace topic disconnects
- **THEN** the hub cancels its upstream subscription within a bounded period
- **AND** the child no longer counts it as a live subscriber

#### Scenario: A child restart does not drop the page
- **WHEN** a workspace child exits while client streams are subscribed to its topics
- **THEN** each client receives a topic-scoped unavailability signal for that workspace
- **AND** the client stream stays open and continues delivering other workspaces' activity

### Requirement: The stream carries a bounded activity summary of the user's other workspaces
The stream SHALL deliver `activity` for every workspace accessible to the authenticated user: running and, when running, working, awaiting interaction, and finished-but-unviewed facts. Changes SHALL update the summary, which MUST be bounded to those facts and MUST NOT carry conversation content, titles, paths, or per-conversation detail. Working and per-user finished state SHALL follow the rules below.

#### Scenario: Workspace activity determines working and awaiting state
- **WHEN** a workspace's activity is summarized
- **THEN** a conversation SHALL count as working during an in-flight turn or live background work (backgrounded command, subagent, or monitor), but not ambient housekeeping
- **AND** permission requests and questions SHALL count as interactions awaiting the user
- **AND** an unreachable child SHALL be reported as not running, not withheld; a non-running workspace SHALL never be finished
- **AND** a workspace never yet observed working, such as a newly started session, SHALL NOT be finished

#### Scenario: Work finishes while no page is watching
- **WHEN** a running workspace the hub has observed working becomes quiet, with no conversation working or interaction awaiting
- **THEN** its finished fact SHALL become true per user
- **AND** it SHALL remain true until that user views the workspace chat, the session is stopped while the hub watches it, or work starts again

#### Scenario: Every running workspace is observed even without viewers
- **WHEN** a workspace is running, whether or not any page is open
- **THEN** the hub SHALL observe its activity throughout its running lifetime so work finishing while nobody watches is recorded

#### Scenario: Viewing chat clears finished for that user on every device
- **WHEN** a user's session page reports its workspace's chat surface in view
- **THEN** the acknowledgement SHALL clear finished for that user on every device and MUST NOT affect other users

#### Scenario: Hub restart preserves previously recorded finish and view facts
- **WHEN** the hub restarts, whether or not a chat view acknowledgement accompanies the restart
- **THEN** recorded finish and view facts SHALL remain in force
- **AND** restarting the hub stops sessions but does not count as the workspace being stopped for this purpose

#### Scenario: Another workspace's agent finishes
- **WHEN** an agent conversation in a workspace the user is not viewing transitions from working to idle
- **THEN** the user's open session tabs receive an activity update for that workspace reporting it running, not working, and finished

#### Scenario: Background work keeps the workspace working
- **WHEN** a turn ends in another workspace while the agent still holds a backgrounded task
- **THEN** the activity summary for that workspace continues to report it working
- **AND** it reports the workspace finished once the background work is gone and no turn is running

#### Scenario: An interaction awaits the user elsewhere
- **WHEN** an agent in another running workspace asks a question or requests permission
- **THEN** the activity summary for that workspace reports an interaction awaiting the user until it is answered
- **AND** the workspace is not reported finished while the interaction awaits

#### Scenario: Viewing the chat clears finished for that user only
- **WHEN** a workspace is reported finished for two users and one of them opens that workspace's chat on any device
- **THEN** that user's other open pages receive an update with finished cleared
- **AND** the other user's summary still reports the workspace finished

#### Scenario: Stopping or restarting work clears finished
- **WHEN** a workspace reported finished is stopped, or an agent there starts working again
- **THEN** the summary no longer reports it finished

#### Scenario: A workspace that has not worked is not finished
- **WHEN** a session starts and no agent has worked in it
- **THEN** it is reported running and idle, not finished

#### Scenario: Work finishing with no page open is still recorded
- **WHEN** the user closes every page and an agent then finishes its work in a running workspace
- **THEN** the next page the user opens reports that workspace finished

#### Scenario: A restart does not forget what finished
- **WHEN** the hub restarts while a workspace is reported finished for one user and viewed by another, and that workspace is running again afterwards
- **THEN** the first user's summary still reports it finished
- **AND** the second user's summary does not

#### Scenario: The summary carries no content
- **WHEN** an activity update is delivered
- **THEN** it contains the workspace identity and running/working/awaiting/finished facts only

### Requirement: The stream opens at once and recovers on one channel
The stream SHALL send first bytes immediately on open, before application events, and bounded-interval idle keepalives. After error, the client SHALL own bounded-backoff reconnect of one stream with every retained topic cursor. Recovery MUST NOT discard drafts, timeline position, received content, or previewed document, and SHALL obey the lifecycle rules below.

#### Scenario: Lifecycle signals recover a suspended or disconnected page
- **WHEN** a suspended page resumes, a hidden page becomes visible, or connectivity is restored
- **THEN** it SHALL reconcile authoritative state and re-establish one stream, with overlapping signals converging to one current connection

#### Scenario: Hiding a page never makes stream release permanent
- **WHEN** a page is hidden
- **THEN** it MAY drop its connection and cancel pending reconnect but MUST retain every subscription/cursor and the ability to reconnect, resuming each topic from where it stopped on wake-up
- **AND** release SHALL be reversible; only a document that actually stops running ends the cycle

#### Scenario: Any lifecycle event preserves the possibility of a later wake-up
- **WHEN** a page lifecycle event occurs, including one other than hiding or waking
- **THEN** no such event SHALL be read as a promise that the document will never run again

#### Scenario: An idle stream is open immediately
- **WHEN** a client opens the stream for a workspace where nothing is happening
- **THEN** the connection reports open within a bounded period well under the keepalive interval

#### Scenario: One reconnect resumes every topic
- **WHEN** the stream drops while a conversation is selected and files are changing
- **THEN** a single replacement connection resumes the document and conversation topics from their retained cursors
- **AND** the conversation timeline, its draft, and its reading position are preserved

#### Scenario: A released stream resumes after the page returns
- **WHEN** a page releases its stream because it was hidden, and is later shown again
- **THEN** one replacement connection resumes every topic the page still subscribes from its retained cursor
- **AND** no subscription is lost because of how the browser announced the hide

### Requirement: Stream diagnostics keep a fixed vocabulary
Stream lifecycle counters and hub diagnostics SHALL record client stream opens, reconnects, and endings by outcome, and upstream subscription opens, releases, and failures by topic class, using fixed class names only. A diagnostic MUST NOT contain a workspace identifier, conversation identifier, cursor value, event payload, cookie, authorization value, or brokered child token.

#### Scenario: Diagnostics name classes, not identities
- **WHEN** the hub records an upstream subscription failure for one conversation of one workspace
- **THEN** the record names the topic class and outcome only

### Requirement: Document patches retain snapshot recovery semantics

The document topic SHALL support full snapshots, ordered incremental file batches, and independent repository updates. Synchronized subscribers SHALL receive affected data, not full inventories per edit. The Hub SHALL retain a coherent current snapshot for each existing workspace and document-context subscription, with cursor, resync, and Follow semantics below.

#### Scenario: A subscriber joins, falls behind, or has an incompatible predecessor
- **WHEN** a joining or behind subscriber needs document state
- **THEN** it SHALL receive the current snapshot at its corresponding cursor before subsequent updates

#### Scenario: Any document patch has an unusable predecessor
- **WHEN** a document patch predecessor is invalid, missing, or incompatible, including for a previously synchronized subscriber
- **THEN** it SHALL cause document-topic resync without disrupting other topics

#### Scenario: Every materialized snapshot preserves discovery and revision meaning
- **WHEN** the Hub materializes or delivers a document snapshot
- **THEN** file revisions and discovery state SHALL survive materialization so reconnects can invalidate stale previews
- **AND** delivery SHALL NOT reinterpret initial discovery or repository completion as a new Follow event

#### Scenario: A subscriber already holds the current cursor
- **WHEN** a document subscriber is already at the current cursor
- **THEN** it SHALL NOT receive a duplicate edit

#### Scenario: A live subscriber receives a single-file update
- **WHEN** a file changes while the subscriber holds the current document snapshot
- **THEN** the existing stream delivers the bounded file batch in order
- **AND** no extra browser connection or full inventory message is required

#### Scenario: A second client joins after several batches
- **WHEN** the Hub has applied file additions, updates, and removals since its child snapshot
- **THEN** a new client receives a snapshot containing all those changes and the corresponding cursor
- **AND** later batches apply exactly once on top of that snapshot

#### Scenario: A returning client missed its active file's update
- **WHEN** a behind client resumes after the Hub received an update to its selected file
- **THEN** the current snapshot retains that file's newer revision
- **AND** the client refreshes its selected preview independently of the latest Follow candidate

#### Scenario: A patch predecessor is missing
- **WHEN** a patch cannot be applied to the Hub's or client's current document state
- **THEN** the affected document subscription obtains a fresh snapshot
- **AND** conversation, inventory, activity, and terminal connections continue independently

#### Scenario: Two clients have different contexts
- **WHEN** clients subscribe with different file scopes or comparison targets
- **THEN** snapshots and patches remain confined to their respective contexts
- **AND** neither client's selection nor scope is changed by the other's subscription

### Requirement: Burst delivery distinguishes reading clients from stalled clients
The hub SHALL deliver finite ordered conversation bursts to actively draining streams without disconnecting solely because upstream delivered one chunk, for shared live delivery and catch-up alike. Outbound queues SHALL remain bounded and genuinely stalled clients SHALL be ended rather than accumulate unbounded data. Yield resumption SHALL respect ownership as below.

#### Scenario: Upstream ownership ends during a delivery yield
- **WHEN** a released or superseded upstream resumes from a delivery yield
- **THEN** it MUST NOT publish any additional frames

#### Scenario: A large normalization burst reaches a reading client
- **WHEN** a reading client watches a conversation and the upstream delivers thousands of small ordered events in one chunk exceeding the outbound backlog limit in aggregate
- **THEN** that client receives every event once in cursor order and its live stream remains open

#### Scenario: Catch-up receives a large replay chunk
- **WHEN** a reading client catches up from an older cursor and the child delivers a large replay in one chunk
- **THEN** the replay reaches that client in order before merging into live delivery without dropping the client stream

#### Scenario: A stalled client remains bounded
- **WHEN** a client stops pulling and conversation events exceed its queue limit
- **THEN** the hub ends that stream and releases its subscriptions

#### Scenario: Ownership ends during a delivery yield
- **WHEN** a stream or subscription is released while a child batch is being delivered
- **THEN** no remaining frame in that batch is delivered through the released owner

### Requirement: Bulk conversation recovery does not simulate an upstream outage
An actively consuming conversation subscriber SHALL receive a bulk recovered change as ordered complete delivery or explicit topic-scoped resynchronization, without overflow-induced unavailability caused solely by the publication burst. Delivery and replay queues SHALL remain byte-bounded. Other topics and the page's one live connection MUST remain independent.

#### Scenario: Clustered ordinary worker results reach a healthy reader
- **WHEN** an actively draining conversation stream receives a recovery containing 318 worker results of about 4 KiB each, with ordinary-sized events and no transport failure
- **THEN** the subscriber receives the ordered changes or an explicit conversation resync followed by a complete fresh snapshot
- **AND** the burst alone does not produce conversation unavailability or a transport-error retry cycle
- **AND** the stream's other topics continue to deliver

#### Scenario: A smaller recovery fits bounded incremental delivery
- **WHEN** the equivalent worker-result recovery fits the incremental publication budget
- **THEN** its changes arrive in order with consistent cursors
- **AND** publication does not require unnecessary resynchronization

#### Scenario: A large batch requires explicit snapshot recovery
- **WHEN** recovered changes cannot be delivered within the bounded incremental budget
- **THEN** the stream explicitly invalidates that conversation after the complete recovery commit
- **AND** no published prefix is presented as the complete batch
- **AND** an older cursor cannot silently skip the withheld changes

#### Scenario: A consumer genuinely stops reading
- **WHEN** a subscriber stops consuming while ordered events continue beyond its existing byte backlog limit
- **THEN** it is terminated within that bound rather than retaining an unbounded queue
- **AND** other subscribers remain usable

#### Scenario: Cancellation or replacement happens around recovery
- **WHEN** a conversation subscription is cancelled or replaced while recovery is prepared
- **THEN** obsolete delivery stops and its resources are released
- **AND** the current subscription receives only events belonging to its own ordered cursor history

#### Scenario: The child actually fails
- **WHEN** the child exits or its transport fails independently of a valid bulk publication
- **THEN** existing topic-scoped unavailability and bounded retry behavior still apply
- **AND** the page's live connection and unrelated topics are not ended
