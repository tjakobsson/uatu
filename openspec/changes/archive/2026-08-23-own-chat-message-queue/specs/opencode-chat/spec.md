# opencode-chat delta: own the chat message queue

## REMOVED Requirements

### Requirement: Users can prompt, steer, and cancel the active conversation
**Reason**: Steering a running turn is dropped. A steered message is consumed by the running turn and can never be withdrawn, which is incompatible with the requirement that busy submissions be removable; the pinned OpenCode API offers no way to retract an admitted input.
**Migration**: Replaced by "Users can prompt, queue, and cancel the active conversation" — busy submissions are held in a workspace-owned queue, presented at the composer, removable until delivered.

## ADDED Requirements

### Requirement: Users can prompt, queue, and cancel the active conversation
The Chat composer SHALL submit non-empty text to the selected conversation and clearly distinguish ready, sending, running, interrupted, and failed states. A prompt submitted while the conversation is running SHALL be held in a workspace-owned queue rather than delivered to the agent mid-turn. Held messages SHALL be presented adjacent to the composer, in submission order, visibly marked as queued, and SHALL NOT appear as part of the running turn's timeline. While the agent continues to stream output, held messages SHALL remain adjacent to the composer rather than drifting into the transcript. The queue SHALL be bounded per conversation; a submission that would exceed the bound SHALL be refused without altering the held messages, with the draft preserved.

When the running turn ends on its own, the workspace SHALL deliver held messages to the agent one at a time in submission order; a delivered message SHALL leave the queue presentation and begin its own turn at the end of the timeline. The user SHALL be able to remove any message that is still held; a removed message is never delivered. Removal of a message that has already been delivered SHALL be refused without altering the conversation.

The user SHALL be able to cancel an active turn without deleting its completed history. Cancellation SHALL NOT deliver held messages: they remain queued, removable, and visible, and the queue stays dormant until the user next submits a prompt, which joins the end of the queue and resumes delivery from its head. Transport failure SHALL preserve the draft until acceptance is known.

The surface SHALL name the agent it is talking to, taking that name from what the agent reports rather than from fixed copy. Text presented to the user SHALL NOT assume a particular agent, so that installing a different agent changes the name shown and nothing else.

The way of working a prompt runs under SHALL be presented as a **mode** — the agent's own named ways of working, such as building or planning. It SHALL NOT be called an agent, because that word names the program Chat talks to.

A control the surface offers the user to start an operation — a picker such as the mode or model chooser — SHALL be presented only when the agent declares the capability behind it. Where that capability is undeclared, the control SHALL be absent rather than shown inert, shown empty, or shown with an error. Reactive interaction controls — those that appear only in response to an agent-raised request, governed by "Users can resolve agent interaction requests in context" — are not covered here: an agent that lacks a capability raises no request of that kind, so the control has nothing to appear for. Absence of a capability SHALL NOT degrade any capability the agent does declare.

#### Scenario: Empty prompt is not submitted
- **WHEN** the composer contains only whitespace
- **THEN** the send action is unavailable and no mutation is sent

#### Scenario: Follow-up queues while the agent works
- **WHEN** the user submits a prompt while the selected conversation is running
- **THEN** the message is held by the workspace rather than delivered to the agent
- **AND** it is presented adjacent to the composer, marked as queued

#### Scenario: Queued messages stay with the composer while output streams
- **WHEN** the agent continues streaming output after messages were queued
- **THEN** the held messages remain adjacent to the composer
- **AND** no held message appears between items of the running turn

#### Scenario: A queued message is delivered when the turn ends
- **WHEN** the running turn completes on its own while messages are held
- **THEN** the workspace delivers the oldest held message to the agent
- **AND** it leaves the queue presentation and starts its own turn at the end of the timeline

#### Scenario: A queued message can be removed
- **WHEN** the user removes a message that is still held
- **THEN** it disappears from the queue on every client
- **AND** it is never delivered to the agent

#### Scenario: A full queue refuses further submissions
- **WHEN** a conversation's held queue is at its bound and the user submits another prompt while the agent works
- **THEN** the submission is refused and the draft is preserved
- **AND** the messages already held are unaffected

#### Scenario: Removing an already-delivered message is refused
- **WHEN** a removal arrives for a message the workspace has already delivered to the agent
- **THEN** the removal is refused without altering the conversation
- **AND** the client learns the message is no longer held

#### Scenario: Cancellation preserves completed content
- **WHEN** the user cancels a running turn
- **THEN** OpenCode is asked to abort that turn
- **AND** content and tool activity already received remain in the timeline with an interrupted outcome

#### Scenario: Cancellation leaves the queue dormant
- **WHEN** the user cancels a running turn while messages are held
- **THEN** the held messages remain queued, visible, and removable
- **AND** none of them is delivered as a consequence of the cancellation

#### Scenario: A new submission resumes a dormant queue
- **WHEN** the user submits a prompt while the conversation is idle and messages are held from before a cancellation
- **THEN** the new message joins the end of the queue
- **AND** delivery resumes from the head of the queue in submission order

#### Scenario: The surface names its agent
- **WHEN** a conversation is open and the agent has reported its identity
- **THEN** the surface names that agent
- **AND** no user-visible text names a different agent

#### Scenario: Ways of working are presented as modes
- **WHEN** the agent offers more than one way of working, such as building and planning
- **THEN** the user selects between them as modes
- **AND** they are not labelled agents

#### Scenario: An undeclared proactive control leaves nothing behind
- **WHEN** the agent does not declare the capability behind a control the surface offers the user to start an operation, such as a mode or model picker
- **THEN** that control is absent from the surface
- **AND** the controls for declared capabilities are unaffected

### Requirement: Timeline order follows the conversation's message order
The Chat timeline SHALL present items in the conversation's own order — parent messages in their provider-assigned order, and within a message, parts in the order the provider delivers them — regardless of the order in which updates arrived. An update belonging to an earlier message MUST NOT render after items of a later message. A client that applied a conversation's events live SHALL present the same cross-message order as a client that loaded the same conversation from a fresh snapshot. Within one message, live events carry no provider position, so parts the provider itself delivered out of order remain in delivery order until the next snapshot load.

#### Scenario: A late update for an earlier message keeps its place
- **WHEN** an update arrives for a message that precedes items already shown
- **THEN** the item renders in its parent message's position
- **AND** it does not appear at the end of the timeline

#### Scenario: Live and reloaded timelines agree
- **WHEN** one client watched a conversation stream live and another loads it fresh
- **THEN** both present the same messages and their items in the same cross-message order

## MODIFIED Requirements

### Requirement: The workspace API exposes normalized chat operations
The workspace API SHALL provide authenticated operations to list, create, and read conversations; start a prompt turn; remove a queued message; cancel the active turn; answer a pending permission; and answer or reject a structured question. Mutation requests SHALL be origin-protected under cookie authentication, SHALL validate conversation ownership against the workspace directory, and SHALL use client-generated request identifiers to make network retries idempotent. Provider-specific payloads and credentials MUST NOT be exposed as the public contract when a normalized UatuCode representation exists.

A prompt accepted while the conversation is running SHALL be reported as queued, identifying the held message so a client can later remove it. Conversation reads SHALL include the currently held messages in submission order, so a client joining or reloading mid-run presents the same queue as one that watched it build.

The API SHALL report which agent a workspace's Chat is talking to, and which capabilities that agent declares. A capability is declared only when the agent actually supports it; the absence of a declaration SHALL be a normal, expected state rather than an error or an empty result. Consumers SHALL be able to decide what to present from the declaration alone, without probing an operation to discover whether it works.

The API SHALL name a way of working a **mode**, and SHALL name the program Chat talks to an **agent**. These two SHALL NOT share a name in the route table, because they are not the same thing and a reader cannot tell them apart from the route alone.

#### Scenario: Retried prompt does not run twice
- **WHEN** a client retries a prompt mutation with the same request identifier after losing the response
- **THEN** the server returns the original accepted result or current outcome
- **AND** OpenCode receives the prompt at most once

#### Scenario: Retried removal is applied once
- **WHEN** a client retries a queued-message removal with the same request identifier after losing the response
- **THEN** the server reports the original outcome
- **AND** at most one held message is removed

#### Scenario: A reload shows the queue as it stands
- **WHEN** a client loads a conversation snapshot while messages are held
- **THEN** the response identifies the held messages in submission order
- **AND** the client can present and remove them without having observed their submission

#### Scenario: Cross-origin mutation is rejected
- **WHEN** a cookie-authenticated cross-origin request attempts to prompt, remove a queued message, cancel, or answer an agent request
- **THEN** the workspace rejects it without changing the conversation

#### Scenario: Base-path deployment uses relocated chat routes
- **WHEN** Chat is served under a workspace base path such as `/s/project-a/`
- **THEN** every chat request and stream URL resolves through that base path
- **AND** the hub proxies it without exposing the loopback OpenCode service

#### Scenario: The API reports its agent and that agent's capabilities
- **WHEN** a client asks a workspace for its chat status
- **THEN** the response identifies the agent Chat is talking to
- **AND** states which capabilities that agent declares

#### Scenario: An undeclared capability is not an error
- **WHEN** an agent does not declare a capability
- **THEN** the status response omits it rather than reporting a failure
- **AND** the client can tell the difference between "not supported" and "supported but empty"

#### Scenario: Modes are listed under a route named for modes
- **WHEN** a client lists the ways of working a prompt can run under
- **THEN** the route names them modes
- **AND** no route names them agents

### Requirement: Conversation updates are structured and reconnectable
The server SHALL normalize OpenCode activity into ordered conversation events covering user and assistant content, reasoning, tool lifecycle, permission requests and resolutions, structured questions and resolutions, context compaction, reverted work, turn status, cancellation, completion, warnings, and errors. Normalization SHALL recognize each of these regardless of which of OpenCode's event-naming generations announced it, and when one logical occurrence is announced more than once the timeline SHALL contain a single entry for it.

Changes to a conversation's held-message queue — a message held, a message removed, a message delivered to the agent — SHALL be announced on the same ordered event stream, so every connected client presents the same queue at the same point in the conversation.

An event the server does not recognize, or whose payload it cannot parse, SHALL be skipped without ending or restarting the event stream, and SHALL be counted by type so an operator can discover what a running workspace is discarding. Counting MUST NOT record event payloads.

A history snapshot SHALL identify a stream cursor; reconnecting from a retained cursor SHALL replay every later event in order before delivering live events. If the cursor is no longer replayable or belongs to an earlier server generation, the server SHALL explicitly require a fresh snapshot. Applying a snapshot followed by its event stream MUST NOT duplicate message content or tool entries.

#### Scenario: Stream reconnect replays missed output
- **WHEN** the event connection drops during an assistant response and reconnects with a retained cursor
- **THEN** every event after that cursor is replayed once in order before live output continues

#### Scenario: Queue changes reach every connected client
- **WHEN** a message is held, removed, or delivered while more than one client watches the conversation
- **THEN** each client receives the change on the ordered event stream
- **AND** all clients present the same held messages in the same order

#### Scenario: Stale cursor requests resynchronization
- **WHEN** a client reconnects with a cursor outside retained history or from an earlier workspace-server generation
- **THEN** the stream reports that a new snapshot is required rather than silently omitting events

#### Scenario: Cumulative and incremental provider updates do not duplicate text
- **WHEN** OpenCode reports overlapping cumulative part state and text deltas for one assistant part
- **THEN** the normalized timeline contains each text segment exactly once

#### Scenario: An interaction announced under either naming generation is recognized
- **WHEN** OpenCode announces a permission request or a structured question using either its current or its legacy event name
- **THEN** the request appears in the conversation that raised it and can be answered

#### Scenario: One occurrence announced twice yields one entry
- **WHEN** a single permission request or question reaches the server under both naming generations
- **THEN** the conversation shows one entry for it
- **AND** answering it sends exactly one response to OpenCode

#### Scenario: An unrecognized event does not end the stream
- **WHEN** OpenCode emits an event type the server does not handle
- **THEN** the event is skipped, the stream continues delivering later events, and the occurrence is counted by type

#### Scenario: An unparseable event costs one event, not the stream
- **WHEN** an event of a recognized type carries a payload the server cannot parse
- **THEN** only that event is dropped and counted
- **AND** subsequent events for that conversation are still delivered

#### Scenario: Discarded-event counts are observable
- **WHEN** an operator inspects the workspace's diagnostic counters after events were discarded
- **THEN** the counts are reported per event type
- **AND** no event payload is included

#### Scenario: A compacted conversation says so
- **WHEN** OpenCode compacts a conversation's context
- **THEN** the timeline records that compaction occurred rather than appearing to lose content without explanation

#### Scenario: Reverted work stops being presented as current
- **WHEN** OpenCode reports that work in a conversation was reverted
- **THEN** the timeline reflects the revert rather than continuing to present the reverted work as though it still applies
