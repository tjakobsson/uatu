## ADDED Requirements

### Requirement: Hub durably stores personal workspace state
The Hub SHALL persist personal workspace-state records in its state directory separately from the workspace registry and project files. Records SHALL be keyed by authenticated user and stable workspace id, SHALL use serialized atomic writes, and SHALL survive Hub and child-session restarts. Forgetting a workspace SHALL remove personal state for that workspace for every user.

#### Scenario: Workspace state survives restart
- **WHEN** personal state is saved and the Hub restarts
- **THEN** the state remains associated with the same user and stable workspace id

#### Scenario: Forget removes associated state
- **WHEN** a stopped workspace is forgotten
- **THEN** its registry entry and every associated personal-state record are removed atomically from the user's perspective

### Requirement: Workspace personal-state routes terminate at the Hub
The Hub SHALL handle the personal-state API under `/s/<workspace-id>/` before generic session proxying. It MUST derive user and workspace identity from the authenticated request and matched stable prefix, MUST NOT trust client-supplied identity, and MUST NOT forward these requests or child credentials to the watch child. Other workspace traffic SHALL continue through the existing proxy.

#### Scenario: Personal-state request is not proxied
- **WHEN** an authenticated client requests the personal-state endpoint for a registered workspace
- **THEN** the Hub serves it from durable Hub state
- **AND** the child receives no request

#### Scenario: Session traffic still proxies normally
- **WHEN** the same client requests document state, SSE, or terminal transport
- **THEN** the Hub forwards that traffic according to the existing proxy contract
