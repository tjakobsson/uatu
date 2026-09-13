## ADDED Requirements

### Requirement: Workspace refreshes publish coherent ordered state

The live document index SHALL publish coherent results whose refresh ordering cannot move clients back to an older scan after a newer scan has been published. File events received during an active refresh SHALL be retained for subsequent reconciliation. Sustained edits SHALL continue producing progress, and after edits stop the published index SHALL converge on the allowed filesystem contents. A failed refresh MUST NOT replace the last successful index with partial results or prevent later refreshes. These guarantees SHALL hold for HTTP state reads and concurrent live subscribers without changing their independent scopes.

#### Scenario: Edits arrive during a slow scan
- **WHEN** a refresh is still scanning or collecting repository state and more file events arrive
- **THEN** the later events cause subsequent reconciliation
- **AND** completion order cannot publish an older scan over a newer one

#### Scenario: Sustained changes eventually settle
- **WHEN** an agent repeatedly creates, replaces, and edits files and then stops
- **THEN** clients receive progress during the activity
- **AND** the final published index contains the final allowed files and metadata

#### Scenario: Scan failure does not corrupt the index
- **WHEN** a refresh fails and a later refresh succeeds
- **THEN** the last complete snapshot remains authoritative during the failure
- **AND** the successful refresh is published to the applicable clients
