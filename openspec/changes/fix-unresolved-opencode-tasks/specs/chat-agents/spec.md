## ADDED Requirements

### Requirement: Worker recovery retains consumed child-history authority through publication

When parent worker recovery consumes a child's transcript as execution evidence, that evidence MUST remain current until publication. A native child-history mutation processed before publication that removes, replaces or reverts consumed evidence SHALL invalidate the dependent recovery result. Such a result MUST NOT publish a terminal worker or authorize dismissal from the superseded evidence. Unrelated conversation mutations SHALL NOT revoke independent recovery authority.

#### Scenario: Child terminal outcome is reverted during parent recovery
- **WHEN** parent recovery has consumed a child idle outcome and a native child revert removes it before the parent result is published
- **THEN** recovery rejects or rereads the superseded evidence rather than publishing the removed terminal outcome
- **AND** a subsequent fresh read reflects the child's current history

#### Scenario: Child evidence changes while another conversation is read
- **WHEN** a child transcript changes during a recovery that does not depend on that child
- **THEN** the unrelated recovery retains its own source authority
