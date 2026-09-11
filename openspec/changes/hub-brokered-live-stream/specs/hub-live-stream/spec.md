## Purpose

The hub-brokered live stream is the one long-lived connection a hub-served session page holds for everything that is pushed to it: document state, conversation inventory, conversation events, subagent transcripts, and a bounded activity summary of the user's other workspaces. The hub subscribes to each workspace child once per watched topic and fans events out, so the browser's per-host connection budget and the hub's upstream connection count are both bounded by what is watched rather than by how many tabs are open.

## ADDED Requirements

### Requirement: A hub-served page holds exactly one live connection
A session page served through the hub SHALL receive every pushed update — document state, conversation inventory, conversation events, subagent transcripts, and cross-workspace activity — over one authenticated Server-Sent Events connection to the hub origin. Selecting a conversation, opening a subagent transcript, opening or collapsing the chat panel, and switching the previewed document MUST NOT open an additional long-lived HTTP connection. WebSocket terminal sessions are outside this guarantee. A page hidden from view SHALL release its live connection while hidden, retaining every subscription and its cursor, and SHALL resume every topic from those cursors when it is shown again; a page opened in the background SHALL NOT hold a live connection before it is first shown, so the connections a browser holds to the hub are bounded by its visible session pages, not by its open tabs. The stream SHALL be authenticated by the hub session exactly as other hub routes are, and a stream MUST carry only workspaces the authenticated user may access.

#### Scenario: A page with everything open holds one stream
- **WHEN** a user has the chat panel open, a conversation selected, a subagent transcript open, and a document previewed in one session tab
- **THEN** the browser holds one long-lived HTTP connection to the hub for that tab's live updates

#### Scenario: Background tabs do not exhaust the browser
- **WHEN** a user has six or more session tabs open on the same hub origin in one browser, each with a conversation selected, and one of them is visible
- **THEN** the hidden tabs hold no live connection
- **AND** an ordinary request from the visible tab (a document load, a personal-state update) is answered without waiting for a live connection to close

#### Scenario: A background tab resumes where it was left
- **WHEN** a hidden session tab with a conversation selected is shown again
- **THEN** it holds one live connection again, resumed from its retained cursors
- **AND** its conversation timeline, draft, and previewed document are as the user left them

#### Scenario: A tab opened in the background waits to connect
- **WHEN** a user opens a session in a background tab
- **THEN** the tab holds no live connection until it is first shown

#### Scenario: Terminals do not count
- **WHEN** a session tab has several terminal panes attached
- **THEN** the tab still holds exactly one live HTTP connection; terminal WebSockets are separate

### Requirement: Events are enveloped by workspace and topic with independent cursors
Every event on the stream SHALL be enveloped with the workspace it belongs to, its topic, and a topic-scoped cursor. Topics SHALL be a fixed vocabulary: `document` (workspace state snapshots and change signals), `inventory` (conversation inventory invalidation), `conversation` (one conversation's ordered events, keyed by conversation id), and `activity` (the cross-workspace summary). Cursors SHALL be independent per topic: replaying one topic from a retained cursor MUST NOT depend on, reorder, or duplicate another topic's events. A client reconnecting SHALL present the last cursor it applied for each topic it resumes, and the hub SHALL replay each topic from its cursor in order before live events, or signal a topic-scoped resync when that cursor is not replayable — never resync the whole stream because one topic fell behind. Transport keepalives SHALL be comment frames that carry no envelope and MUST NOT advance any cursor.

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

### Requirement: Subscriptions change without reconnecting
A client SHALL be able to add and remove topic subscriptions on an open stream — subscribing to a conversation when it is selected, to a subagent transcript when it is opened, unsubscribing when they are closed — without closing or reopening the connection. A newly added subscription SHALL begin from a snapshot cursor the client supplies or from the current position, and events for a topic MUST stop arriving promptly after it is unsubscribed. Subscription control requests SHALL be authenticated as the stream is and MUST be bound to the stream they modify so one client cannot alter another's subscriptions.

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
The hub SHALL hold at most one upstream subscription per workspace child per topic (per conversation for the conversation topic) regardless of how many client streams are subscribed to it, and SHALL release an upstream subscription within a bounded period after the last subscribed client stream unsubscribes or disconnects. An upstream subscription's failure or the child's exit SHALL be reported to every subscribed client as a topic-scoped resync or unavailability signal, and MUST NOT end the client stream. The hub's outbound connection count for live delivery MUST be bounded by watched topics, never by client count.

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
The stream SHALL deliver an `activity` topic describing, for every workspace the authenticated user may access, whether its session is running and — when running — whether any agent conversation is working and whether any interaction (a permission request, a question) awaits the user. The summary SHALL update when those facts change and MUST be bounded to those facts: it MUST NOT carry conversation content, titles, file paths, or per-conversation detail. A workspace whose child is unreachable SHALL be reported as not running rather than withheld.

#### Scenario: Another workspace's agent finishes
- **WHEN** an agent conversation in a workspace the user is not viewing transitions from working to idle
- **THEN** the user's open session tabs receive an activity update for that workspace reflecting the change

#### Scenario: An interaction awaits the user elsewhere
- **WHEN** an agent in another running workspace asks a question or requests permission
- **THEN** the activity summary for that workspace reports an interaction awaiting the user until it is answered

#### Scenario: The summary carries no content
- **WHEN** an activity update is delivered
- **THEN** it contains the workspace identity and running/working/awaiting facts only

### Requirement: The stream opens at once and recovers on one channel
The stream SHALL send its first bytes immediately on open so the browser's connection reports open before any application event exists, and SHALL emit transport keepalives at a bounded interval while idle. After an error the client SHALL own a bounded-backoff reconnect of the one stream, presenting every retained topic cursor, and lifecycle wake-ups (a suspended page resuming, a hidden page becoming visible, restored network connectivity) SHALL reconcile authoritative state and re-establish the one stream — overlapping signals converging to one current connection. Recovery MUST NOT discard drafts, timeline position, content already received, or the previewed document.

#### Scenario: An idle stream is open immediately
- **WHEN** a client opens the stream for a workspace where nothing is happening
- **THEN** the connection reports open within a bounded period well under the keepalive interval

#### Scenario: One reconnect resumes every topic
- **WHEN** the stream drops while a conversation is selected and files are changing
- **THEN** a single replacement connection resumes the document and conversation topics from their retained cursors
- **AND** the conversation timeline, its draft, and its reading position are preserved

### Requirement: Stream diagnostics keep a fixed vocabulary
Stream lifecycle counters and hub diagnostics SHALL record client stream opens, reconnects, and endings by outcome, and upstream subscription opens, releases, and failures by topic class, using fixed class names only. A diagnostic MUST NOT contain a workspace identifier, conversation identifier, cursor value, event payload, cookie, authorization value, or brokered child token.

#### Scenario: Diagnostics name classes, not identities
- **WHEN** the hub records an upstream subscription failure for one conversation of one workspace
- **THEN** the record names the topic class and outcome only
