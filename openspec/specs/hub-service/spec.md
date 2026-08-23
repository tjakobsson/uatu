# hub-service Specification

## Purpose

Define the uatu hub daemon: a long-running service that keeps a persistent workspace registry (absolute paths, stable session ids), starts and stops `uatu serve` sessions through a pluggable session backend, and reverse-proxies all session traffic (HTTP, SSE, WebSocket) under `/s/<id>/` prefixes behind hub-terminated TLS — so one authenticated origin fronts many loopback-bound sessions — plus a self-hosting runbook covering real certificate and startup paths.

## Requirements

### Requirement: Hub reports its public API compatibility identity
The Hub SHALL expose an authenticated machine-readable compatibility identity containing its public Hub API revision and the public workspace API revision expected behind its proxied workspace routes. These revisions SHALL identify wire-contract compatibility independently from the product version and source-build identity, and SHALL correspond to published contract metadata. Clients MUST NOT need to infer API compatibility from a display-formatted version string.

#### Scenario: Native client probes Hub compatibility
- **WHEN** an authenticated native client requests Hub state
- **THEN** the response identifies the Hub API revision and proxied workspace API revision as machine-readable values
- **AND** the values can be matched to published contract revisions

#### Scenario: Product release does not imply a contract break
- **WHEN** the product version changes without an incompatible Hub or workspace wire-contract change
- **THEN** the corresponding public API revision remains unchanged

### Requirement: Hub manages clone operations as authenticated jobs
The hub SHALL execute each repository clone as an in-memory job owned by the authenticated user who created it. Creation SHALL return a non-blocking job identifier; the owner SHALL be able to receive a bounded replayable stream of job output and state, submit terminal responses, and cancel the job. Another user MUST NOT be able to observe or control the job. Input and cancellation SHALL be POST operations protected like other state-changing hub endpoints. Completed jobs and their bounded output SHALL expire automatically and MUST NOT survive a hub restart.

#### Scenario: Clone creation does not hold one request open
- **WHEN** an authenticated user starts a clone
- **THEN** the hub promptly returns a job identifier while cloning continues independently

#### Scenario: Owner reconnects to clone output
- **WHEN** the owner's output stream disconnects and reconnects while the job is retained
- **THEN** the hub replays the bounded retained events and continues streaming new events without restarting the clone

#### Scenario: Another user cannot access a clone job
- **WHEN** a different authenticated user requests the job's output or attempts to send input or cancel it
- **THEN** the hub reveals no job data and does not alter the job

#### Scenario: Mutating clone operation is cross-origin
- **WHEN** a cookie-authenticated cross-origin request attempts to create, answer, or cancel a clone job
- **THEN** the hub rejects it without starting or altering a clone

### Requirement: Clone prompts are isolated to the job terminal
The hub SHALL run a clone with a dedicated pseudo-terminal for its standard streams so terminal prompts are captured by the job and never use the hub daemon's controlling terminal. For the clone invocation, the hub SHALL prevent ambient Git and SSH askpass programs and ambient Git credential helpers from supplying or displaying requested credentials. It SHALL construct explicit Git and credential configuration that selects the compatible Hub credential chosen for the job; it MUST NOT inherit an external SSH agent or automatically fall back to another stored credential. With no selected credential, or when Git or SSH requires additional interaction, prompts SHALL remain on the job PTY. A response submitted to the job SHALL be written only to its terminal and MUST NOT be persisted, logged, included in job events, returned by an API, or promoted into the credential catalog automatically. This command-level selection MUST NOT be described as isolation when the clone runs under the local backend's shared UID.

#### Scenario: Git cannot prompt through daemon terminal or askpass
- **WHEN** a clone needs a credential that is unavailable from its selected Hub credential context
- **THEN** Git or SSH writes its prompt to the job's pseudo-terminal rather than the daemon's terminal or an ambient askpass or credential helper

#### Scenario: Submitted secret is not retained
- **WHEN** the owner submits a passphrase, password, or token to the clone job
- **THEN** the hub writes it to the pseudo-terminal and discards the request value without logging it or adding it to retained events or stored credentials

#### Scenario: External agent remains available
- **WHEN** the daemon has an external SSH agent while a clone job uses Hub credential management
- **THEN** the clone does not inherit that external agent
- **AND** the external agent remains running and unchanged

#### Scenario: Unselected managed credential is unavailable
- **WHEN** multiple credentials exist and a clone job selects one of them
- **THEN** the clone command is configured to select that credential
- **AND** the Hub does not fall back to another stored or ambient credential

### Requirement: Clone jobs are bounded and cleaned up
The hub SHALL enforce an inactivity timeout and a hard lifetime for active clone jobs. Cancellation, timeout, hub shutdown, or clone failure SHALL terminate the clone's whole process group with bounded graceful-to-forced escalation so Git, SSH, and their descendants cannot remain orphaned. The hub SHALL reserve a clone target while its job is active so concurrent jobs cannot target the same checkout. It SHALL register a workspace only after a successful clone, SHALL release all reservations and terminal resources on every terminal outcome, and SHALL terminate all active clone jobs during graceful hub shutdown.

#### Scenario: Credential prompt is abandoned
- **WHEN** a clone waits without output or input beyond the inactivity limit
- **THEN** the job becomes timed out, its process group is terminated, and no workspace is registered

#### Scenario: Clone exceeds its hard lifetime
- **WHEN** a clone continues producing activity beyond the maximum job lifetime
- **THEN** the hub terminates it and reports a timeout rather than allowing it to run indefinitely

#### Scenario: Cancellation reaps SSH descendants
- **WHEN** an active `git clone` has spawned SSH and the owner cancels the job
- **THEN** both Git and SSH are terminated within the bounded shutdown period

#### Scenario: Hub shuts down during clone
- **WHEN** the hub begins graceful shutdown with active clone jobs
- **THEN** it terminates and awaits those jobs before exiting

#### Scenario: Concurrent jobs choose the same target
- **WHEN** one active clone has reserved a target and another clone requests that target
- **THEN** the second request is rejected without spawning Git

#### Scenario: Session start fails after clone
- **WHEN** cloning and registration succeed but the workspace session fails to start
- **THEN** the hub removes the registration, reports the start failure, and leaves the successfully cloned checkout on disk

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

### Requirement: The binary provides a hub daemon subcommand
The `uatu` binary SHALL provide a `hub` subcommand that starts a long-running daemon from a configuration file (listen port, TLS certificate and key paths, users, state directory override), suitable for supervision by systemd or launchd. The hub SHALL persist its workspace registry and secrets under an XDG-resolved state directory, creating secret-bearing files with owner-only permissions. On SIGTERM or SIGINT the hub SHALL stop every running session and exit cleanly. The configuration SHALL NOT define a workspaces root: workspaces are registered by absolute path and the hub SHALL reject a configuration containing the removed `workspacesDir` key with an error naming it.

#### Scenario: Hub starts from a config file
- **WHEN** `uatu hub --config <path>` starts with a valid configuration
- **THEN** the daemon listens on the configured port and serves the dashboard
- **AND** its registry and session store live in the state directory with owner-only permissions

#### Scenario: Graceful shutdown stops children
- **WHEN** the hub receives SIGTERM while sessions are running
- **THEN** every child server process is terminated before the hub exits

#### Scenario: A configuration with the removed workspacesDir key fails startup
- **WHEN** `uatu hub` starts with a configuration file containing `workspacesDir`
- **THEN** startup fails with an error naming the removed key

### Requirement: The hub exits when its standard input closes
The `hub` subcommand SHALL accept `--exit-on-stdin-close`: when set, the hub SHALL hold its standard input open and, on EOF, perform the same graceful shutdown as SIGTERM (stop every running session, then exit). This is the orphan backstop for supervising processes that die without signaling, matching the contract `uatu serve` already provides.

#### Scenario: Supervisor death cannot orphan the hub
- **WHEN** a hub started with `--exit-on-stdin-close` sees EOF on its standard input while sessions are running
- **THEN** every child session process is terminated and the hub exits

### Requirement: Workspaces are registered with stable identifiers and a backend field
The hub SHALL maintain a persistent workspace registry where each entry records a stable workspace id, the workspace source (an absolute folder path anywhere on the filesystem), and a session backend identifier. Registration SHALL validate that the path is absolute and refers to an existing directory. The id SHALL be a slug derived from the workspace folder name, suffixed on collision, and SHALL never change once assigned, so session URLs (`/s/<id>/…`) survive hub and session restarts. In this change the only valid backend identifier SHALL be `local`; the field SHALL exist in the registry schema so additional backends are additive.

Registry persistence SHALL be serialized and atomic — concurrent mutations may neither interleave writes nor let an older snapshot finish last, and a crash mid-write MUST NOT corrupt the file. The hub MUST NOT prune registry entries at startup based on their location; an entry whose folder no longer exists SHALL remain registered and surface as failing to start, never as silently forgotten.

#### Scenario: Workspace id is stable across restarts
- **WHEN** a workspace for `~/src/uatu` is created, the hub restarts, and the session is resumed
- **THEN** the session is reachable at the same `/s/<id>/` prefix as before the restart

#### Scenario: Slug collision is suffixed
- **WHEN** two workspaces with the same folder name are registered
- **THEN** the second receives a distinct suffixed id and the first keeps its id

#### Scenario: Arbitrary absolute paths are registrable
- **WHEN** workspaces at `~/src/uatu` and `~/Documents/notes` are registered
- **THEN** both appear in the registry with stable ids and both sessions are servable

#### Scenario: A relative or missing path is rejected
- **WHEN** a registration request names a relative path or a path that is not an existing directory
- **THEN** the hub rejects it and the registry is unchanged

### Requirement: Sessions are started and stopped through a session backend interface
The hub SHALL manage session processes exclusively through a backend interface whose contract is: given a workspace descriptor, base path, and resolved credential assignment context, start a session and return a loopback HTTP endpoint plus the child's session token; and stop a previously started session. Hub components (proxy, dashboard, auth) MUST NOT depend on how the endpoint or credential context is produced. The shipped `local` backend SHALL spawn `uatu serve <folder> --no-open --exit-on-stdin-close --base-path /s/<id>/` with explicit Git, signing, SSH-client, and provider-tool selection derived from the workspace's assignments, parse the tokened URL from the child's first stdout line, hold the child's stdin open for its lifetime, and stop the session via SIGTERM. It MUST NOT forward ambient agent sockets, and normal tool configuration MUST NOT select unassigned stored credentials. Because local sessions share the daemon UID and may share Hub-managed runtime resources, these selections are advisory and MUST NOT be represented as OS-enforced isolation.

#### Scenario: Local backend spawns the session-child contract
- **WHEN** the hub starts a session for a registered workspace with credential assignments
- **THEN** a `uatu serve` child starts with `--no-open --exit-on-stdin-close`, the workspace's base path, and explicit integrations for its assignments
- **AND** the hub records the loopback endpoint parsed from the child's stdout

#### Scenario: Local backend does not inherit ambient agents
- **WHEN** the Hub daemon has an unrelated ambient agent and starts a workspace with no credential assignments
- **THEN** the child receives no Hub or ambient credential integration from session startup

#### Scenario: Hub death cannot orphan children
- **WHEN** the hub process dies without running termination handlers
- **THEN** each child server exits on its own because its standard input reached EOF

### Requirement: All session traffic is reverse-proxied under the workspace prefix
The hub SHALL proxy every request under `/s/<id>/` to that workspace's loopback endpoint, covering plain HTTP, Server-Sent Events, and WebSocket upgrades. SSE responses SHALL be streamed without buffering. WebSocket proxying SHALL forward messages and close events in both directions, preserving application close codes (including the terminal's 4001, 4409, and 4410). Requests for an unknown or stopped workspace SHALL receive a non-cached error response that links back to the dashboard. Children SHALL bind loopback only and MUST NOT be directly reachable from the network.

#### Scenario: A session round-trips through the hub
- **WHEN** an authenticated browser requests `/s/uatu/api/state`
- **THEN** the hub forwards the request to that session's loopback endpoint and streams the response back

#### Scenario: Terminal WebSocket transits the hub
- **WHEN** an authenticated browser upgrades `/s/uatu/api/terminal?sessionId=<uuid>` and later the PTY is killed via the session inventory
- **THEN** bytes flow both directions through the hub during the session
- **AND** the client observes the same close code it would observe connecting directly

#### Scenario: Stopped workspace prefix explains itself
- **WHEN** a browser requests a `/s/<id>/` URL whose session is not running
- **THEN** the hub responds with an error page linking to the dashboard rather than a bare connection failure

#### Scenario: Remote transfers are compressed and bundle assets cached
- **WHEN** a browser that accepts gzip loads a session's bundled script chunk through the hub
- **THEN** the response is gzip-compressed and marked immutable with long-lived caching
- **AND** a revalidation request with the asset's entity tag answers 304 without a body
- **AND** incremental feeds (the SSE event stream, the NDJSON search feed) are never buffered for compression

### Requirement: The hub forwards loopback-shaped requests so children keep their localhost model
When proxying to a child, the hub SHALL rewrite the forwarded `Host` header (and `Origin` header, when present) to the child's loopback endpoint, after the hub has itself validated the browser's origin against the hub's host. Children's existing loopback origin gates and token checks SHALL hold without modification.

#### Scenario: Child accepts a proxied terminal upgrade
- **WHEN** a browser at the hub's HTTPS origin performs a terminal WebSocket upgrade through the hub
- **THEN** the child receives loopback-shaped `Host` and `Origin` headers and its origin gate accepts the upgrade

### Requirement: The hub terminates TLS from user-supplied certificates
The hub SHALL serve HTTPS using a certificate and private key referenced by its configuration, and SHALL refuse to listen on a non-loopback address without TLS configured. Plain HTTP SHALL be permitted only on loopback (for operators fronting the hub with their own proxy).

#### Scenario: Remote listening requires TLS
- **WHEN** the hub is configured to listen on a non-loopback address with no certificate configured
- **THEN** startup fails with an error explaining that TLS (or a loopback bind behind a proxy) is required

#### Scenario: Hub serves HTTPS with the provided certificate
- **WHEN** the hub is configured with valid PEM certificate and key paths
- **THEN** clients connect over HTTPS and secure-context features (service worker, clipboard) function on remote devices

### Requirement: The self-hosting runbook documents working certificate and startup paths
The self-hosting runbook SHALL provide complete, copy-pasteable walkthroughs for obtaining a certificate and starting the hub, covering at minimum: mkcert for LAN homelabs (including installing the root CA on iOS), and tailscale in both supported shapes — native TLS via `tailscale cert` (enabling MagicDNS and HTTPS in the tailnet, generating the PEM files, pointing the hub config at them, and renewing on a schedule since the certificates expire) and fronted via `tailscale serve` proxying HTTPS to a loopback plain-HTTP hub. Each walkthrough SHALL end with a working service definition (systemd unit or launchd plist) that starts the hub in that shape.

#### Scenario: Tailscale user reaches a working HTTPS hub with native certs
- **WHEN** an operator follows the runbook's `tailscale cert` walkthrough
- **THEN** they end with the hub serving HTTPS on their tailnet hostname from the generated PEM files
- **AND** the runbook includes a scheduled renewal step for the expiring certificate

#### Scenario: Tailscale user fronts the hub with tailscale serve
- **WHEN** an operator follows the runbook's `tailscale serve` walkthrough
- **THEN** they end with the hub listening plain-HTTP on loopback and `tailscale serve` terminating HTTPS in front of it

### Requirement: Hub-owned credential processes follow Hub lifecycle
The Hub SHALL start managed credential processes only in dedicated owner-only runtime locations, monitor their readiness, and stop them during graceful shutdown after active clone jobs and workspace sessions no longer need them. Startup or shutdown failure of one optional credential runtime SHALL be reported without signaling ambient processes or corrupting unrelated credentials, and SHALL prevent only capabilities that depend on that runtime.

#### Scenario: Hub shuts down with managed agents
- **WHEN** the Hub begins graceful shutdown with Hub-owned SSH and OpenPGP agents running
- **THEN** active clone jobs and workspace sessions stop before the Hub terminates its owned agents
- **AND** unrelated system agents remain running
