## MODIFIED Requirements

### Requirement: Events are enveloped by workspace and topic with independent cursors
Every `live` event on the stream SHALL be enveloped with the workspace it belongs to, its topic, and a topic-scoped cursor; the only other frames are the `hello` event that opens the stream and names its id, and transport keepalives. Topics SHALL be a fixed vocabulary: `document` (workspace state snapshots and change signals), `inventory` (conversation inventory invalidation), `conversation` (one conversation's ordered events, keyed by conversation id), `activity` (the cross-workspace summary), and `worktrees` (bounded worktree-inventory invalidation scoped to an accessible source workspace). Cursors SHALL be independent per topic: replaying one topic from a retained cursor MUST NOT depend on, reorder, or duplicate another topic's events. A client reconnecting SHALL present the last cursor it applied for each cursor-bearing subscription it resumes (`document`, `inventory`, `conversation`), and the hub SHALL replay each from its cursor in order before live events, or signal a topic-scoped resync when that cursor is not replayable — never resync the whole stream because one topic fell behind. The `activity` topic takes no cursor: on every stream open the hub sends a fresh summary for each workspace the user may access, so a reconnect receives that snapshot rather than a replay. The `worktrees` topic SHALL likewise require no replay cursor and SHALL send fresh invalidation on subscription or reconnect so the client fetches authoritative inventory. It SHALL invalidate immediately after a committed Uatu worktree operation and after reconciliation changes inventory, without adding paths or content to the `activity` topic or opening another long-lived connection. Worktree invalidations MUST reveal no inaccessible workspace, path, credential or conversation content. Transport keepalives SHALL be comment frames that carry no envelope and MUST NOT advance any cursor.

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

#### Scenario: CLI creation appears without polling delay
- **WHEN** a Uatu CLI worktree operation commits while an authorized page subscribes to its source workspace's worktree topic
- **THEN** the existing stream immediately invalidates inventory and the page refreshes it without changing active workspace

#### Scenario: Reconnection recovers missed inventory changes
- **WHEN** a subscribed page reconnects after missing a worktree update
- **THEN** fresh worktree invalidation triggers authoritative inventory refresh independently of conversation/document replay
