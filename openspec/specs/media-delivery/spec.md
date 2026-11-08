# media-delivery Specification

## Purpose
Deliver permitted workspace audio and video as independently cancellable HTTP responses that support seeking without transporting or buffering complete media files in application state.

## Requirements

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
- **WHEN** a request targets an excluded, secret-like, out-of-root, symlink-escaping, or unindexed file
- **THEN** the system refuses delivery without streaming its contents

#### Scenario: Authentication has expired
- **WHEN** a new media or range request arrives without valid workspace access
- **THEN** the request is refused through the normal Hub authentication boundary
- **AND** no child credential is exposed to the browser

### Requirement: Media delivery defines range and HEAD semantics
A successful full GET SHALL return 200, the media MIME type, the representation byte length, and Accept-Ranges: bytes. A satisfiable single explicit, open-ended, or suffix range SHALL return 206 with exact Content-Range and Content-Length for the returned bytes. An unsatisfiable range SHALL return 416 with Content-Range: bytes */size and no media body. Malformed or multiple ranges SHALL be ignored and answered with the normal full representation. HEAD SHALL return the full representation's metadata without a body and SHALL ignore Range. The Hub SHALL preserve these semantics without compression or byte transformation.

#### Scenario: The player seeks into a clip
- **WHEN** the player requests `bytes=1024-2047` from a sufficiently large file
- **THEN** it receives exactly 1024 bytes with 206 and the matching range/length headers
- **AND** the full clip is not read into application memory

#### Scenario: The player requests the end of a file
- **WHEN** the player sends a valid suffix range
- **THEN** the response contains the corresponding final bytes with correct total size

#### Scenario: A range starts past the end
- **WHEN** a range's first position is beyond the representation length
- **THEN** the response is 416 with the actual total size and no media body

#### Scenario: A client requests metadata only
- **WHEN** HEAD is requested, with or without Range
- **THEN** the response describes the full representation and has no body

#### Scenario: A client sends multiple ranges
- **WHEN** Range requests multiple disjoint sections or is malformed
- **THEN** the server returns a normal full 200 representation rather than partial or malformed multipart data

### Requirement: Media transfer has bounded buffering and cancellation
Media delivery SHALL begin without reading or buffering the whole file at the workspace child, Hub, or browser application layer. A slow consumer SHALL apply backpressure. Replacing or closing the active clip, abandoning a request, or leaving the workspace SHALL cancel obsolete transfers through the Hub to the child within a bounded period. Transfer buffering SHALL remain bounded independently of file length. Media traffic MUST NOT require Git completion or block independent live-update/control requests behind application buffering.

#### Scenario: A large video is playing
- **WHEN** a client reads only an initial range of a large video
- **THEN** application buffering is independent of total file size
- **AND** chat/file updates and an ordinary control request can still make progress

#### Scenario: A clip is closed during a stalled transfer
- **WHEN** the user closes the player while its response is still transferring
- **THEN** the browser abandons the response and cancellation releases the corresponding Hub/child delivery

### Requirement: Media requests are bound to detected file revisions
Each new request SHALL validate the selected epoch/revision and current opened-file metadata before delivering bytes. A known stale revision SHALL return 409 with no-store and no media body. A detected write or replacement SHALL invalidate pending delivery for the older revision. The system MUST NOT silently serve a newer revision under an older revision URL or claim immutable historical playback for files being written in place.

#### Scenario: A seek follows a detected overwrite
- **WHEN** a file is rewritten and the old player requests another range of the prior revision
- **THEN** the old request receives a stale-revision refusal rather than bytes from the new file

#### Scenario: An old response arrives after another clip was chosen
- **WHEN** delivery for clip A settles after the user chose clip B
- **THEN** it cannot replace B's source, metadata, or playback state

#### Scenario: The session child restarts
- **WHEN** a request retains an epoch/revision from before the child restart
- **THEN** it is not treated as the current representation merely because the path or revision counter matches
