## ADDED Requirements

### Requirement: Inventory changes ride the brokered stream
When a session is served through the hub, the merged conversation inventory's invalidation signal SHALL be delivered as the `inventory` topic of the hub's brokered live stream, and the chat surface MUST NOT open a separate connection for it. The signal SHALL keep its meaning — the client re-reads the authoritative inventory — and one agent's outage MUST NOT withhold the signal for another agent's changes.

#### Scenario: A new conversation appears without a dedicated connection
- **WHEN** a conversation is created in the workspace from another device
- **THEN** the chooser on a hub-served page updates from an `inventory` topic event
- **AND** the page holds no connection dedicated to inventory
