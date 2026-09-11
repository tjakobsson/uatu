## ADDED Requirements

### Requirement: Conversation subscriptions ride the brokered stream
When a session is served through the hub, a selected conversation's ordered events — and an open subagent transcript's — SHALL be delivered as `conversation` topics of the hub's brokered live stream, subscribed and unsubscribed on the open connection as the selection changes. The cursor and resync semantics of conversation updates SHALL hold per topic: a retained cursor replays later events once in order, and a non-replayable cursor requires a fresh snapshot for that conversation only. Selecting a conversation MUST NOT open an additional HTTP connection, and the reconnect-status ownership rules for the chat surface SHALL apply to the brokered stream: a successful open clears only the chat surface's connection-interruption status.

#### Scenario: Switching conversations reuses the connection
- **WHEN** a user selects a different conversation on a hub-served page
- **THEN** the previous conversation's topic is unsubscribed and the new one subscribed from its snapshot cursor
- **AND** no HTTP connection is opened or closed

#### Scenario: A subagent drill-down is one more topic
- **WHEN** a user opens a subagent transcript from the parent conversation
- **THEN** the transcript's events arrive as a second conversation topic on the same stream
- **AND** closing it unsubscribes that topic and leaves the parent's subscription intact
