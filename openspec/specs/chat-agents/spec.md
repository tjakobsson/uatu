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
