## MODIFIED Requirements

### Requirement: Public APIs have one canonical machine-readable contract
UatuCode SHALL maintain an OpenAPI 3.1 contract for every supported HTTP operation intended for external clients. That public surface is the Hub API: the operations the hub serves itself, including the brokered live stream and its subscription control. Most are at the hub's own origin. An operation the hub serves itself under a workspace prefix (`/s/<id>/`), such as the per-user personal state it stores for each workspace, is part of the Hub API too and SHALL be published as a Hub operation, versioned by the Hub revision. The routes the hub proxies to the session child under a workspace prefix — the child's API, including the SSE routes and the activity endpoint the hub subscribes to as its internal hub-to-child protocol — are internal and MUST NOT be published as public operations; they MUST be classified by an explicit, machine-checkable exclusion. Payload schemas the hub forwards from a workspace on the live stream (document state, conversation events) SHALL remain published as part of that stream's protocol definition and versioned by the workspace revision. The contract SHALL define operation identifiers, authentication, path and query parameters, request bodies, successful responses, documented error responses, and reusable schemas. Supported SSE surfaces SHALL additionally have machine-readable protocol definitions covering event names and payload schemas, topic and signal vocabularies, cursor and reconnection rules, and lifecycle behavior that OpenAPI does not fully express. Internal debug, test-only, HTML, and static-asset routes MAY be excluded, but exclusions MUST be explicit and machine-checkable.

#### Scenario: Agent discovers an HTTP operation
- **WHEN** an agent reads the published OpenAPI contract
- **THEN** it can determine the operation's method, path, authentication, input, success schema, and documented failure schemas without reading server source code

#### Scenario: Native client discovers a streaming protocol
- **WHEN** a native client implements a published SSE surface, such as the Hub's live stream or a clone job's events
- **THEN** the published protocol definition identifies the events it can receive, their payload schemas, and the lifecycle and reconnection rules it must handle
- **AND** for the live stream it also identifies the envelope, topics, signals, cursor rules, and the subscription-control operation used to change topics

#### Scenario: The workspace API is internal
- **WHEN** a supported-route coverage check compares the session child's route inventory with the contract
- **THEN** every child route is classified as an explicit internal exclusion rather than a public operation

#### Scenario: Hub-served state under a workspace prefix is public
- **WHEN** a supported-route coverage check compares the hub's own dispatch under a workspace prefix with the contract
- **THEN** each operation the hub answers itself there, such as reading or patching personal state, is a public Hub operation
- **AND** a breaking change to it requires a Hub revision, not a workspace revision

#### Scenario: Internal routes are omitted deliberately
- **WHEN** a supported-route coverage check compares the application route inventory with the contract
- **THEN** every omitted route is classified as an explicit non-public exclusion rather than disappearing silently
