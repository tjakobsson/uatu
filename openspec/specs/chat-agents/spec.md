# chat-agents Specification

## Purpose

Define the multi-agent chat model: which coding agents a workspace offers,
how each agent's availability is reported and retried, how every
conversation is bound to the agent that owns it, and how one chat surface
presents conversations from different agents without privileging either.

## Requirements

### Requirement: A workspace offers a fixed set of chat agents
The workspace SHALL offer a server-determined set of chat agents and SHALL
identify each by a stable id and a human-readable name. Each agent SHALL
declare its own capabilities, and consumers SHALL take an agent's name and
controls from its declaration rather than from fixed copy. Agents' runtimes
SHALL be independent: one agent being unavailable, failing to start, or
crashing MUST NOT prevent conversations with another agent, and MUST NOT
affect non-chat capabilities of the workspace.

#### Scenario: Agents are listed with identity and capabilities
- **WHEN** a client asks a workspace for its chat status
- **THEN** the response identifies every offered agent by id and name
- **AND** states each agent's declared capabilities and availability independently

#### Scenario: One agent's outage does not block another
- **WHEN** one agent is not installed or fails to start
- **THEN** conversations with every other offered agent remain fully usable
- **AND** the unavailable agent reports an actionable unavailable state

### Requirement: Every conversation belongs to exactly one agent
Every conversation SHALL be owned by exactly one agent, fixed at creation
for the conversation's lifetime. Conversation summaries, snapshots, and
lifecycle announcements SHALL carry the owning agent's id, and every
conversation mutation SHALL be routed to the owning agent. Conversation
identifiers from different agents MUST NOT collide, and a request that
addresses a conversation through the wrong agent SHALL be rejected rather
than served by another agent.

#### Scenario: A conversation keeps its agent for life
- **WHEN** a conversation created with one agent is later opened, prompted, or renamed
- **THEN** every operation reaches the agent that owns it
- **AND** the conversation's reported agent identity never changes

#### Scenario: Summaries identify their agent
- **WHEN** a client lists conversations or receives a conversation lifecycle announcement
- **THEN** each entry identifies its owning agent
- **AND** a client can present the agent without loading the conversation

### Requirement: Users choose an agent when starting a conversation
When more than one agent is offered, starting a conversation SHALL let the
user choose among the offered agents before the conversation exists, and
the choice SHALL be presented with each agent's availability so an
unavailable agent is explained rather than hidden. The workspace SHALL
apply a stable default (the user's most recently used agent, then the
server's default) so a user who never chooses gets a working conversation.
Opening an existing conversation SHALL NOT require or offer an agent
choice.

#### Scenario: Creation offers the available agents
- **WHEN** a user starts a new conversation in a workspace offering two agents
- **THEN** the user can choose which agent the conversation belongs to
- **AND** the conversation is created under the chosen agent

#### Scenario: A returning user keeps their preference
- **WHEN** a user who last conversed with a given agent starts another conversation without making a choice
- **THEN** the new conversation belongs to that same agent

#### Scenario: An unavailable agent is explained at creation
- **WHEN** a user starts a conversation while one offered agent is unavailable
- **THEN** the unavailable agent is shown with its unavailable state rather than omitted
- **AND** choosing it does not create a conversation

### Requirement: Per-agent availability is independently reported and retryable
Chat availability SHALL be reported per agent, with each agent's state,
version, and failure diagnostics attributed to that agent alone. A failed
agent startup SHALL be retryable without restarting the workspace and
without disturbing another agent's running conversations.

#### Scenario: Retry touches only the failed agent
- **WHEN** a user retries an agent whose startup failed while another agent has an active turn
- **THEN** the failed agent's runtime is restarted
- **AND** the other agent's active turn continues uninterrupted

### Requirement: Conversation inventory spans all offered agents
The workspace's conversation inventory SHALL include every agent's
top-level conversations for the workspace directory, merged into one list
in which each entry carries its owning agent. An agent whose runtime is
unavailable SHALL contribute the conversations it can enumerate or none,
and its outage MUST NOT hide or delay another agent's entries.

#### Scenario: The chooser presents both agents' conversations
- **WHEN** a workspace holds conversations owned by two different agents
- **THEN** the conversation chooser lists both agents' conversations
- **AND** each entry is attributable to its agent without opening it

#### Scenario: A failing agent does not empty the chooser
- **WHEN** one agent cannot enumerate its conversations
- **THEN** the other agent's conversations remain listed

### Requirement: One chat surface serves every agent
The chat surface — timeline, composer, queue, configuration picker,
interaction cards, and announcements — SHALL be shared across agents, with
per-agent differences expressed only through declared capabilities and
agent-specific timeline content. An agent-specific control or timeline
presentation SHALL appear only for conversations whose owning agent
declares the capability behind it, and its absence for another agent
SHALL be a normal state rather than an error.

#### Scenario: Capability differences change controls, not the surface
- **WHEN** a user switches between a conversation whose agent declares reversible history and one whose agent does not
- **THEN** the same chat surface presents both
- **AND** the undo controls appear only in the conversation whose agent declares them

### Requirement: Inventory changes ride the brokered stream
When a session is served through the hub, the merged conversation inventory's invalidation signal SHALL be delivered as the `inventory` topic of the hub's brokered live stream, and the chat surface MUST NOT open a separate connection for it. The signal SHALL keep its meaning — the client re-reads the authoritative inventory — and one agent's outage MUST NOT withhold the signal for another agent's changes.

#### Scenario: A new conversation appears without a dedicated connection
- **WHEN** a conversation is created in the workspace from another device
- **THEN** the chooser on a hub-served page updates from an `inventory` topic event
- **AND** the page holds no connection dedicated to inventory

### Requirement: Chat navigation remains responsive across agents

Claude Code and OpenCode conversations SHALL use the same responsiveness and loading-feedback behavior. Returning to an already loaded Chat surface SHALL display retained content without waiting for a conversation-list refresh, optional catalogs, or a new transcript request. A required resynchronization SHALL preserve that content with an updating indication until current content is available. Hidden Chat activity MUST NOT prevent interaction with Files, Preview, or Terminal. Returning to Chat SHALL preserve drafts, pending attachments, expanded activity, and the prior reading anchor, or follow the latest output if previously pinned.

#### Scenario: Return while the network is slow
- **WHEN** an already loaded conversation is hidden behind another touch tab and the user returns while inventory reconciliation is delayed
- **THEN** the retained conversation is displayed without waiting for that request
- **AND** the user can interact with it or navigate away

#### Scenario: Output arrives while Chat is hidden
- **WHEN** a selected conversation produces output or requests input while another surface is visible
- **THEN** the visible surface remains interactive and chat attention indicators remain current
- **AND** returning to Chat presents the accumulated state without losing the draft or reading position

#### Scenario: Agent catalogs are delayed
- **WHEN** the user opens a conversation whose optional model, mode, or command catalog is delayed or unavailable
- **THEN** transcript loading and navigation proceed independently
- **AND** dependent controls communicate their own availability without applying another agent's catalog

### Requirement: Slow Chat reads expose their progress and recovery

Opening a conversation, loading older history, and retrying a failed read SHALL acknowledge the action immediately. An operation still pending after 200 milliseconds SHALL expose an accessible loading indication naming the operation. Once shown, a progress indication SHALL remain visible for at least 300 milliseconds unless its surface is dismissed. Feedback MUST NOT shift the reading position, erase retained content during refresh, or clear unrelated agent or connection errors. Reduced-motion users SHALL receive the same state information without continuous animation. Completion SHALL mean that the requested content is available for interaction, not merely that bytes arrived.

Obsolete reads SHALL stop controlling feedback when the user navigates elsewhere. Reads SHALL have finite documented deadlines, with actionable timeout or failure feedback and a read retry. Retrying a read MUST NOT create a conversation, resend a prompt, or repeat another mutation.

#### Scenario: Fast read avoids a progress flash
- **WHEN** a read completes before 200 milliseconds
- **THEN** the action is acknowledged without flashing a progress bar

#### Scenario: Slow read identifies the wait
- **WHEN** a read remains pending past 200 milliseconds
- **THEN** the surface identifies the pending operation and remains navigable

#### Scenario: Older history loads slowly
- **WHEN** an older-history request is delayed
- **THEN** the current timeline remains visible, its position stays stable, and the older-history control communicates loading

#### Scenario: Superseded request completes
- **WHEN** conversation A is loading, the user selects B, and A later completes or fails
- **THEN** A cannot replace B's content or settle B's loading indication

#### Scenario: Read times out
- **WHEN** a selected conversation read exceeds its deadline
- **THEN** loading ends with a timeout explanation and a retry action
- **AND** the draft and retained content are preserved

### Requirement: Long-chat improvements are verified without losing interaction behavior

Responsiveness SHALL be validated with equivalent short and long workloads for both agents, measuring warm surface switching, cold conversation opening, older-history loading, streaming, and resume separately. Validation SHALL distinguish server/read duration from browser presentation duration and record the browser, hardware, workload, and throttling settings. Under the documented controlled profile, warm touch-tab return to retained content SHALL meet a p95 target of 200 milliseconds. Delayed data requests MUST NOT determine that warm-return duration.

Optimized presentation SHALL preserve find over loaded history, copy actions, file links, accessible reading order, answerable requests, and stable scrolling. Completed content MUST NOT be silently dropped to meet the responsiveness target.

#### Scenario: Compare both agents under controlled load
- **WHEN** the same recorded workload and device profile are run against Claude Code and OpenCode
- **THEN** the validation report includes separate before/after timings and the warm-return result for each agent
- **AND** an improvement in one agent does not substitute for validating the other

#### Scenario: Find reaches older loaded content
- **WHEN** the user searches for text in an older loaded message whose presentation was deferred
- **THEN** find can locate and reveal that result in the correct conversation order
- **AND** the result's copy actions and file links remain usable
