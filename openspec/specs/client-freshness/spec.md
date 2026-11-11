# client-freshness Specification

## Purpose
Ensure web clients load current, compatible assets through immutable content-hashed bundles, non-cached HTML entry points, and build-identity verification with bounded reload recovery.
## Requirements
### Requirement: Bundle assets are content-hashed and immutable
The server SHALL serve every SPA bundle asset (bundler-emitted JavaScript, CSS, and font files) under a URL containing a content hash, with `Cache-Control: public, max-age=31536000, immutable`. The HTML shell SHALL reference bundle assets only through such hashed URLs, so that a new build's shell can never resolve to a previous build's cached asset. Fixed-name auxiliary assets (icons, the web-app manifest) MAY keep moderate cache lifetimes since their content is not build-coupled.

#### Scenario: Bundle asset carries hash and immutable header
- **WHEN** the shell HTML references a bundled script or stylesheet and a client requests it
- **THEN** the URL path contains a content hash
- **AND** the response carries `Cache-Control: public, max-age=31536000, immutable`

#### Scenario: A new build changes asset URLs
- **WHEN** the bundle's content changes between two builds
- **THEN** the shell HTML of the new build references at least one different hashed asset URL
- **AND** no unhashed bundle-asset URL appears in the shell HTML

### Requirement: HTML entry points are never cached
Every HTML entry point — the SPA shell served at the root or under any base path, and the hub's login and dashboard pages — SHALL be served with `Cache-Control: no-cache` or stricter, so navigations always revalidate against the server. The server-side shell cache SHALL be keyed by the running build's identity, so a process can never serve a shell assembled from a previous build. Responses proxied through a hub SHALL preserve these cache headers.

#### Scenario: Shell HTML revalidates
- **WHEN** a client requests the SPA shell directly or through a hub base path
- **THEN** the response carries `Cache-Control: no-cache` (or stricter)

#### Scenario: Hub pages revalidate
- **WHEN** a client requests the hub login or dashboard page
- **THEN** the response carries `Cache-Control: no-cache` (or stricter)

#### Scenario: Shell cache cannot outlive a build
- **WHEN** the server process serves a shell after the underlying bundle identity changes
- **THEN** the served shell is assembled from the current build, not a cached copy of a previous one

### Requirement: Clients verify the server's build identity
The workspace server SHALL report its build identity, including version and commit, and a bundled-web contract revision to authenticated clients via the state payload. The bundled web client SHALL compare identities and recover from mismatches without reload loops; native clients SHALL use public API revisions for compatibility.

#### Scenario: Boot and reconnect compare embedded and reported identities
- **WHEN** the bundled web client boots or reconnects its live stream
- **THEN** it SHALL compare the server identity with its own identity embedded at bundle time

#### Scenario: A permanently closed stream recovers without a browser retry
- **WHEN** the web client's event stream becomes permanently closed, including when EventSource automatic retry fails mid-restart
- **THEN** the web client SHALL re-establish it itself so a server restart is always eventually observed and the identity comparison runs

#### Scenario: Identity mismatch has bounded reload recovery
- **WHEN** the web client observes a server identity that differs from its own
- **THEN** it SHALL reload itself at most once per observed server identity
- **AND** if the mismatch persists after that reload, it SHALL display a persistent, visible stale-client notice instead of reloading again

#### Scenario: Bundled-web and native compatibility have separate contracts
- **WHEN** a client determines compatibility with the server
- **THEN** the bundled-web contract revision SHALL govern compatibility with web assets shipped from the same product build
- **AND** independently released native clients SHALL use the separately published Hub revision and workspace revision that versions the payloads the live stream forwards
- **AND** native clients MUST NOT treat a product build mismatch alone as an API incompatibility

#### Scenario: Server restart with a new build reloads the web client once
- **WHEN** the server restarts with a new build while a web client is open and the client's SSE connection re-establishes
- **THEN** the client detects the identity mismatch and reloads once
- **AND** the reloaded client matches the server and shows no notice

#### Scenario: Persistent mismatch is surfaced, not looped
- **WHEN** a reloaded web client still observes a build identity different from its own
- **THEN** the client shows a persistent stale-client notice
- **AND** does not trigger further automatic reloads for that server identity

#### Scenario: Contract break is explicit
- **WHEN** the bundled web client's embedded contract revision differs from the workspace server's bundled-web contract revision
- **THEN** the web client surfaces the mismatch visibly rather than silently continuing

#### Scenario: Native compatibility uses public API revisions
- **WHEN** a native client's product build identity differs from the server but its pinned public API revision is compatible
- **THEN** the client does not classify the build difference alone as an API incompatibility
- **AND** it determines compatibility from the published Hub or workspace API revision instead
