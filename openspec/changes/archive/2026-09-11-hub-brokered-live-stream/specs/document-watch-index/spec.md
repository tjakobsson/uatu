## ADDED Requirements

### Requirement: Hub-served pages receive document state over the brokered stream
When a session is served through the hub, the browser SHALL receive workspace state snapshots and change signals as the `document` topic of the hub's brokered live stream rather than by opening the workspace's own event route. Every guarantee stated for the live update channel — automatic preview refresh, reconciliation of a missed active-document change from a fresh snapshot, bounded refresh under sustained churn, keepalives with no presentation effect, and one current channel after overlapping lifecycle signals — SHALL hold unchanged for the brokered topic. The workspace's own event route SHALL remain the internal source the hub subscribes to.

#### Scenario: A file change reaches a hub-served page over the brokered stream
- **WHEN** a watched file changes while a user views the workspace through the hub
- **THEN** the sidebar and, when Follow or the selected document calls for it, the preview update from a `document` topic event
- **AND** the page opened no connection to the workspace's own event route

#### Scenario: A missed change is reconciled after the one stream reconnects
- **WHEN** the selected document changes while the brokered stream is interrupted
- **AND** the stream reconnects and its `document` topic delivers a fresh snapshot
- **THEN** the preview refreshes to the current document content
