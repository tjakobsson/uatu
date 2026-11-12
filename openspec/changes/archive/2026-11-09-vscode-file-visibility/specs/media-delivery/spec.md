## MODIFIED Requirements

### Requirement: Media bytes have an independent authenticated HTTP path
The system SHALL expose GET and HEAD media delivery under the workspace base path, identified by watched-root identity, root-relative path, and the requested file revision within its session epoch. Delivery SHALL enforce workspace authentication, indexed membership, current exposure policy, and realpath containment. Media bytes MUST NOT enter document JSON, personal state, or pushed-update events. Hiding Gitignored files SHALL NOT itself deny an otherwise permitted authenticated media request.

The media route SHALL remain an internal child-proxied protocol, documented and verified with HTTP contract tests. Its GET and HEAD methods SHALL have explicit machine-checkable non-public exclusions. Child media operations MUST NOT be published in the public OpenAPI surface or expand the public Hub API. Existing publication/revision rules SHALL continue to govern public personal-state and forwarded live-payload changes.

#### Scenario: Media route coverage preserves the internal boundary
- **WHEN** route coverage classifies GET/HEAD media delivery
- **THEN** both methods are covered by explicit internal exclusions and no public OpenAPI media operation is introduced

#### Scenario: The approved media transport adaptation preserves the application listener contract
- **WHEN** the child or Hub writes a media response through the shared narrow node:http boundary on Bun 1.4.4
- **THEN** the same actual product route, browser URL/origin, base path, authentication, and child-token brokering remain authoritative
- **AND** existing normal HTTP, early-flushed SSE, terminal/WebSocket upgrades, TLS, client-IP/rate-limit context, readiness, and graceful/forced shutdown retain their behavior without an additional browser-facing port
- **AND** child and internal listeners stay loopback-isolated and untrusted forwarding headers cannot forge client context
- **AND** source, E2E, and compiled delivery exercise that same product boundary with bounded writes and cancellation

#### Scenario: An ignored audio file is requested
- **WHEN** an authenticated client requests an indexed, permitted ignored audio file
- **THEN** its bytes are delivered independently of document rendering and live events
- **AND** selecting a different visibility setting in another client does not change the request's authorization

#### Scenario: Two roots have the same relative path
- **WHEN** two watched roots contain `renders/test.wav`
- **THEN** the requested root identity selects exactly one file
- **AND** delivery does not fall back to the other root

#### Scenario: A file is not permitted
- **WHEN** a request targets an excluded, out-of-root, symlink-escaping, or unindexed file
- **THEN** the system refuses delivery without streaming its contents

#### Scenario: Authentication has expired
- **WHEN** a new media or range request arrives without valid workspace access
- **THEN** the request is refused through the normal Hub authentication boundary
- **AND** no child credential is exposed to the browser

#### Scenario: A render captured from a live write is delivered
- **WHEN** an authenticated client requests `build/renders/take-5.wav`, which was indexed from a live write inside an unlisted ignored folder
- **THEN** its bytes are delivered
- **AND** the file stays indexed for the rest of the session even if later writes fill the live-write window
