## ADDED Requirements

### Requirement: Document patches retain snapshot recovery semantics

The existing document topic SHALL support a full snapshot followed by ordered incremental file batches and independent repository updates. Synchronized subscribers SHALL receive updates containing affected data rather than the full file inventory for each edit. The Hub SHALL retain a coherent current snapshot for each existing workspace and document-context subscription. A joining or behind subscriber SHALL receive that snapshot at its corresponding cursor before subsequent updates; a subscriber already at the current cursor SHALL not receive a duplicate edit. Invalid, missing, or incompatible patch predecessors SHALL cause document-topic resynchronization without disrupting other topics. File revisions and discovery state SHALL survive Hub snapshot materialization so reconnects can invalidate stale previews. Snapshot delivery SHALL NOT reinterpret initial discovery or repository completion as a new Follow event.

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
