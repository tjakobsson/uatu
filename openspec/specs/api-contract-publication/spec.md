# api-contract-publication Specification

## Purpose

Define how UatuCode publishes an authoritative, versioned API contract that humans, tools, and AI agents can consume without cloning the product repository, and how changes remain synchronized with the running services.

## Requirements

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

### Requirement: Human and agent documentation are generated from reviewed sources
UatuCode SHALL provide human-readable API documentation and concise guides for authentication, Hub and workspace boundaries, common workflows, streaming behavior, compatibility, and errors. It SHALL also provide an agent-oriented guide that identifies the authoritative contract, explains how to determine compatibility and migrations, and links directly to raw machine-readable artifacts. Generated reference pages MUST derive endpoint and schema details from the canonical contract and MUST NOT establish a second independently edited wire contract.

#### Scenario: Human browses the API reference
- **WHEN** a developer opens the generated API documentation
- **THEN** they can browse the same operations and schemas represented by the canonical machine-readable contract

#### Scenario: Agent loads compact context
- **WHEN** an agent is directed to the agent guide
- **THEN** it receives the minimum orientation needed to locate authoritative artifacts, compare revisions, and identify required client changes without scraping a JavaScript-rendered page

### Requirement: GitHub Pages publishes the product site and raw API artifacts
The project SHALL publish a static UatuCode product and documentation site at the repository's standard GitHub Pages URL under `/uatu/`. The site SHALL work with that base path and SHALL expose static, directly fetchable raw artifacts at documented stable paths, including `llms.txt`, the agent guide, OpenAPI contract, streaming protocol contract, contract metadata, and API changelog. Raw contract artifacts SHALL be served directly under `/uatu/api/` with no channel path segment. Essential agent-facing content MUST be available without executing client-side JavaScript or authenticating.

#### Scenario: User opens the repository Pages site
- **WHEN** a user visits `https://tjakobsson.github.io/uatu/`
- **THEN** the product homepage and documentation navigation load with links and assets resolved under the `/uatu/` base path

#### Scenario: Agent fetches a raw artifact
- **WHEN** an agent fetches a documented OpenAPI, metadata, guide, or changelog URL directly
- **THEN** it receives the artifact as static text or structured data without a repository clone, authentication, or browser execution

#### Scenario: Agent fetches the OpenAPI contract by its documented path
- **WHEN** an agent fetches `https://tjakobsson.github.io/uatu/api/openapi.yaml`
- **THEN** it receives the OpenAPI 3.1 contract without a channel segment in the path

#### Scenario: Agent discovers documentation from the site root
- **WHEN** an agent fetches the site's `llms.txt`
- **THEN** it finds direct links to the current contract metadata, agent guide, API contracts, and changelog
- **AND** every link it lists resolves to a published artifact

### Requirement: The published contract has a single identity derived from main
The published API contract SHALL have exactly one identity, built from the current `main` branch, with no release-derived or historical channels. Contract metadata SHALL identify the API revision pair, stability, the source commit it was built from, and the publication time. The site MUST NOT retain published state between deployments: each deployment is the complete build output of one commit, so no publication depends on what a previous publication left behind.

#### Scenario: Main changes
- **WHEN** a contract change merges to the main branch and the site is published
- **THEN** the published contract metadata identifies that source commit
- **AND** the published artifacts are the ones built from that commit

#### Scenario: A product release is published
- **WHEN** a `v*` release is tagged and published
- **THEN** the site's published contract is unchanged by the release itself
- **AND** no release-derived channel or snapshot directory is created

#### Scenario: Publishing twice from one commit
- **WHEN** the publication runs twice for the same source commit
- **THEN** both runs deploy equivalent artifacts
- **AND** neither run depends on state carried over from an earlier publication

### Requirement: Contract changes are validated before publication
Continuous integration SHALL validate contract syntax and references, compare supported route inventory with documented operations, validate representative running-server requests and responses against the contract, and report backward-incompatible contract differences against the appropriate baseline. A breaking change MUST increment the affected public API revision and include consumer-facing migration information in the API changelog. The publication workflow MUST itself validate the contract it builds and MUST verify the built site before deploying it, and MUST NOT deploy when either check fails.

#### Scenario: Handler response drifts from its schema
- **WHEN** a contract test observes a documented operation returning a status or body that violates its contract
- **THEN** continuous integration fails before the change can be published

#### Scenario: New supported route is undocumented
- **WHEN** a change adds an externally supported route without a corresponding contract operation
- **THEN** the route coverage check fails unless the route is explicitly classified as non-public

#### Scenario: Breaking change lacks migration metadata
- **WHEN** compatibility comparison detects a backward-incompatible change without the required revision increment and changelog migration entry
- **THEN** continuous integration fails

#### Scenario: Pages reflects validated sources
- **WHEN** the Pages workflow deploys a successful build
- **THEN** its contract metadata identifies the same source commit that passed contract validation

#### Scenario: Publication validates what it deploys
- **WHEN** the publication workflow runs for a commit whose contract fails validation or whose built site fails its link and content checks
- **THEN** the workflow fails without deploying
- **AND** the previously deployed site remains live
